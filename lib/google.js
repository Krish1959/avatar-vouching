// Version :071126 00:25
// File    :lib/google.js
/**
 * Google Drive + Gmail helpers.
 *
 * Auth: OAuth2 user refresh token for agentic.avai@gmail.com
 *   (a service account CANNOT upload into a personal Gmail Drive — it has no storage quota).
 * Email: sent via the Gmail API over HTTPS (Render free tier blocks outbound SMTP ports).
 * Google Sheets are created by uploading .xlsx and letting Drive convert it (needs only the Drive
 * scope we already have — no Sheets API, no new consent).
 *
 * SHARED LINKS (071126): client links are NEVER copied to our Drive. inventoryLinks() reads only
 * metadata (names, sizes, folders); the pipeline later downloads each file straight into memory,
 * sends it to the models and drops it. See lib/avatar-vouching.js.
 *
 * DEV_MODE=true  -> no Google calls: "Drive" is mirrored to ./_dev_drive, emails are printed to the console,
 *                   Google Docs are written as .html files, Google Sheets as .xlsx files.
 *                   Shared links may be given as  dev:/absolute/local/folder  for testing.
 */
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const DEV = process.env.DEV_MODE === 'true';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const DOC_MIME = 'application/vnd.google-apps.document';
const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const SLIDES_MIME = 'application/vnd.google-apps.presentation';
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

let drive = null;
let gmail = null;
let auth = null;

// Strip any whitespace/newlines accidentally pasted into Render env values.
const env = (k) => String(process.env[k] || '').replace(/\s+/g, '');
const CLIENT_ID = env('GOOGLE_CLIENT_ID');
const CLIENT_SECRET = env('GOOGLE_CLIENT_SECRET');
const REFRESH_TOKEN = env('GOOGLE_REFRESH_TOKEN');

if (!DEV) {
  const { google } = require('googleapis');
  auth = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
  auth.setCredentials({ refresh_token: REFRESH_TOKEN });
  drive = google.drive({ version: 'v3', auth });
  gmail = google.gmail({ version: 'v1', auth });
}

const DEV_ROOT = path.join(__dirname, '..', '_dev_drive');

const EXT_MIME = {
  '.pdf': 'application/pdf', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values', '.txt': 'text/plain',
  '.json': 'application/json', '.xml': 'application/xml', '.html': 'text/html', '.htm': 'text/html',
  '.xlsx': XLSX_MIME,
  '.xls': 'application/vnd.ms-excel',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
};
const guessMime = (name) => EXT_MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';

/** Header needed for older "anyone with the link" files that carry a resource key. */
const rkOpts = (id, rk) => (rk ? { headers: { 'X-Goog-Drive-Resource-Keys': `${id}/${rk}` } } : {});

/* ---------------------------------------------------------------- folders */

const q = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const folderLocks = new Map(); // prevents duplicate folders from concurrent submissions

async function findOrCreateFolder(name, parentId) {
  const key = `${parentId || 'root'}/${name}`;
  if (folderLocks.has(key)) return folderLocks.get(key);
  const p = (async () => {
    if (DEV) {
      const dir = path.join(parentId || DEV_ROOT, name);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    }
    const parent = parentId || 'root';
    const res = await drive.files.list({
      q: `name='${q(name)}' and mimeType='${FOLDER_MIME}' and trashed=false and '${parent}' in parents`,
      fields: 'files(id)',
      pageSize: 1,
    });
    if (res.data.files.length) return res.data.files[0].id;
    const created = await drive.files.create({
      requestBody: { name, mimeType: FOLDER_MIME, parents: [parent] },
      fields: 'id',
    });
    return created.data.id;
  })();
  folderLocks.set(key, p);
  try {
    return await p;
  } catch (e) {
    folderLocks.delete(key);
    throw e;
  }
}

/** Creates (or reuses) a folder path like ['Vouching','SPN','ABC'] and returns the last folder id. */
async function ensurePath(parts, rootParentId) {
  let parent = rootParentId || null;
  for (const part of parts) parent = await findOrCreateFolder(part, parent);
  return parent;
}

async function createFolder(name, parentId) {
  if (DEV) {
    const dir = path.join(parentId, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  const r = await drive.files.create({
    requestBody: { name, mimeType: FOLDER_MIME, parents: [parentId] },
    fields: 'id',
  });
  return r.data.id;
}

function folderLink(id) {
  return DEV ? `file://${id}` : `https://drive.google.com/drive/folders/${id}`;
}

/** Direct children of a folder: [{id,name,mimeType,size,resourceKey}] — works on our Drive and on shared links. */
async function listChildren(folderId, resourceKey) {
  if (DEV) {
    if (!fs.existsSync(folderId)) return [];
    return fs.readdirSync(folderId, { withFileTypes: true }).map((d) => {
      const id = path.join(folderId, d.name);
      return {
        id,
        name: d.name,
        mimeType: d.isDirectory() ? FOLDER_MIME : guessMime(d.name),
        size: d.isDirectory() ? 0 : fs.statSync(id).size,
      };
    });
  }
  const out = [];
  let pageToken;
  do {
    const r = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'nextPageToken, files(id,name,mimeType,size,resourceKey)',
      pageSize: 200,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    }, rkOpts(folderId, resourceKey));
    out.push(...r.data.files);
    pageToken = r.data.nextPageToken;
  } while (pageToken);
  return out;
}

/** All files (not folders) under a folder, recursively, each with a relative `path` like "Ledger_Files/GL.xlsx". */
async function listTree(folderId, prefix = '') {
  const out = [];
  for (const f of await listChildren(folderId)) {
    const p = prefix ? `${prefix}/${f.name}` : f.name;
    if (f.mimeType === FOLDER_MIME) out.push(...(await listTree(f.id, p)));
    else out.push({ ...f, size: Number(f.size || 0), path: p });
  }
  return out;
}

/* ------------------------------------------------------------------ files */

async function uploadFile(localPath, name, mimeType, parentId) {
  if (DEV) {
    const dest = path.join(parentId, name);
    fs.copyFileSync(localPath, dest);
    return { id: dest, name };
  }
  const r = await drive.files.create({
    requestBody: { name, parents: [parentId] },
    media: { mimeType: mimeType || 'application/octet-stream', body: fs.createReadStream(localPath) },
    fields: 'id,name,size',
  });
  return r.data;
}

async function uploadText(name, text, parentId, mimeType = 'application/json') {
  if (DEV) {
    const dest = path.join(parentId, name);
    fs.writeFileSync(dest, text);
    return dest;
  }
  const r = await drive.files.create({
    requestBody: { name, parents: [parentId] },
    media: { mimeType, body: Readable.from([text]) },
    fields: 'id',
  });
  return r.data.id;
}

/** Returns the id of a (non-folder) file with this exact name in parentId, or null. */
async function findFile(name, parentId) {
  if (DEV) {
    const p = path.join(parentId, name);
    return fs.existsSync(p) && fs.statSync(p).isFile() ? p : null;
  }
  const r = await drive.files.list({
    q: `name='${q(name)}' and mimeType!='${FOLDER_MIME}' and trashed=false and '${parentId}' in parents`,
    fields: 'files(id)',
    pageSize: 1,
  });
  return r.data.files.length ? r.data.files[0].id : null;
}

async function readText(fileId) {
  if (DEV) return fs.readFileSync(fileId, 'utf8');
  const r = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
  return Buffer.from(r.data).toString('utf8');
}

/** Create or overwrite a text/JSON file by name inside parentId. Returns its id. */
async function upsertText(name, text, parentId, mimeType = 'application/json') {
  const id = await findFile(name, parentId);
  if (!id) return uploadText(name, text, parentId, mimeType);
  if (DEV) {
    fs.writeFileSync(id, text);
    return id;
  }
  await drive.files.update({ fileId: id, media: { mimeType, body: Readable.from([text]) }, fields: 'id' });
  return id;
}

/**
 * Downloads any Drive file into memory as a Buffer (nothing is written to disk or to our Drive).
 * Google-native files are exported: Docs/Slides -> text, Sheets -> .xlsx (all tabs).
 * Works for files on our Drive and for files reached through a client's shared link.
 */
async function downloadFile(file) {
  if (DEV) return { buffer: fs.readFileSync(file.id), mimeType: file.mimeType, name: file.name };
  const opts = { responseType: 'arraybuffer', ...rkOpts(file.id, file.resourceKey) };
  const exportAs = {
    [DOC_MIME]: ['text/plain', '.txt'],
    [SLIDES_MIME]: ['text/plain', '.txt'],
    [SHEET_MIME]: [XLSX_MIME, '.xlsx'],
  }[file.mimeType];
  if (exportAs) {
    const r = await drive.files.export({ fileId: file.id, mimeType: exportAs[0] }, opts);
    return { buffer: Buffer.from(r.data), mimeType: exportAs[0], name: file.name + exportAs[1] };
  }
  if (String(file.mimeType).startsWith('application/vnd.google-apps.')) {
    throw new Error(`Unsupported Google file type ${file.mimeType}`);
  }
  const r = await drive.files.get({ fileId: file.id, alt: 'media', supportsAllDrives: true }, opts);
  return { buffer: Buffer.from(r.data), mimeType: file.mimeType, name: file.name };
}

/** Creates a native Google Doc from HTML (Drive converts it). Returns {id, link}. */
async function createGoogleDoc(name, html, parentId) {
  if (DEV) {
    const dest = path.join(parentId, `${name}.html`);
    fs.writeFileSync(dest, html);
    return { id: dest, link: `file://${dest}` };
  }
  const r = await drive.files.create({
    requestBody: { name, mimeType: DOC_MIME, parents: [parentId] },
    media: { mimeType: 'text/html', body: Readable.from([html]) },
    fields: 'id',
  });
  return { id: r.data.id, link: `https://docs.google.com/document/d/${r.data.id}/edit` };
}

const sheetLink = (id) => `https://docs.google.com/spreadsheets/d/${id}/edit`;

/** Creates a native Google Sheet from an .xlsx buffer (Drive converts it; each tab is kept). Returns {id, link}. */
async function createGoogleSheet(name, xlsxBuffer, parentId) {
  if (DEV) {
    const dest = path.join(parentId, `${name}.xlsx`);
    fs.writeFileSync(dest, xlsxBuffer);
    return { id: dest, link: `file://${dest}` };
  }
  const r = await drive.files.create({
    requestBody: { name, mimeType: SHEET_MIME, parents: [parentId] },
    media: { mimeType: XLSX_MIME, body: Readable.from([xlsxBuffer]) },
    fields: 'id',
  });
  return { id: r.data.id, link: sheetLink(r.data.id) };
}

/**
 * Create the Google Sheet `name` in parentId, or replace its whole content if it already exists
 * (same file id, so its link never changes). Used for the master cost ledger.
 */
async function upsertGoogleSheet(name, xlsxBuffer, parentId) {
  if (DEV) return createGoogleSheet(name, xlsxBuffer, parentId);
  const r = await drive.files.list({
    q: `name='${q(name)}' and mimeType='${SHEET_MIME}' and trashed=false and '${parentId}' in parents`,
    fields: 'files(id)',
    pageSize: 1,
  });
  const id = r.data.files[0]?.id;
  if (!id) return createGoogleSheet(name, xlsxBuffer, parentId);
  await drive.files.update({ fileId: id, media: { mimeType: XLSX_MIME, body: Readable.from([xlsxBuffer]) }, fields: 'id' });
  return { id, link: sheetLink(id) };
}

/**
 * Gives `email` view access to a file/folder.
 * Tries silently first; non-Google addresses need Google's invitation email, so it retries with notify.
 */
async function shareWithUser(fileId, email, role = 'reader') {
  if (DEV) return { ok: true, dev: true };
  const base = { fileId, requestBody: { type: 'user', role, emailAddress: email }, fields: 'id' };
  try {
    await drive.permissions.create({ ...base, sendNotificationEmail: false });
    return { ok: true, notified: false };
  } catch (e1) {
    try {
      await drive.permissions.create({
        ...base,
        sendNotificationEmail: true,
        emailMessage: 'AVAG.AI — your vouching review documents are shared with you.',
      });
      return { ok: true, notified: true };
    } catch (e2) {
      return { ok: false, error: e2.message || e1.message };
    }
  }
}

/**
 * ALPHA TEST ONLY — "Anyone with the link" access to a file/folder (no Google account needed).
 * Everything inside a shared folder inherits it. allowFileDiscovery:false = not searchable, link only.
 * Safe to call repeatedly. Remove with unshareAnyone() after the alpha.
 */
async function shareWithAnyone(fileId, role = 'reader') {
  if (DEV) return { ok: true, dev: true };
  try {
    await drive.permissions.create({
      fileId,
      requestBody: { type: 'anyone', role, allowFileDiscovery: false },
      fields: 'id',
    });
    return { ok: true, role };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Removes "Anyone with the link" access from a file/folder (used to close alpha links). */
async function unshareAnyone(fileId) {
  if (DEV) return { ok: true, dev: true };
  try {
    await drive.permissions.delete({ fileId, permissionId: 'anyoneWithLink' });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* --------------------------------------------- shared Drive links (read-only) */

function parseDriveId(url) {
  const pats = [/\/folders\/([\w-]{10,})/, /\/file\/d\/([\w-]{10,})/, /\/d\/([\w-]{10,})/, /[?&]id=([\w-]{10,})/];
  for (const p of pats) {
    const m = String(url).match(p);
    if (m) return m[1];
  }
  return null;
}

function parseResourceKey(url) {
  const m = String(url).match(/[?&]resourcekey=([\w-]+)/i);
  return m ? m[1] : null;
}

/** DEV only: "dev:/abs/folder" stands in for a Drive link. */
const devPath = (url) => (DEV && /^dev:/.test(String(url)) ? String(url).slice(4) : null);

/** True if the link is something inventoryLinks() can open. */
const isUsableLink = (url) => !!(parseDriveId(url) || devPath(url));

function accessError(e) {
  const status = e?.code || e?.response?.status;
  if (status === 404 || status === 403) {
    return 'No access. Share it with agentic.avai@gmail.com (Viewer) or set "Anyone with the link", then try again.';
  }
  return `Could not open the link: ${String(e?.message || e).slice(0, 200)}`;
}

const LIST_CAP = 5000; // stop listing a runaway folder; anything after is reported as not examined

/**
 * Walks every shared link and decides, file by file, what will be examined.
 * Reads METADATA ONLY — no file content is downloaded or copied here.
 *
 * @param urls  string[]
 * @param opts  {maxFiles, maxBytes, maxDepth, maxFileBytes, isSupported(name, mime)}
 * @returns {
 *   links:  [{n, url, ok, error, name, kind:'folder'|'file', files, folders, bytes, notExamined}],
 *   files:  [{id, name, mimeType, size, resourceKey, path, role:'LINKED_SUPPORTING', source:'link', link:n, folder}],
 *   notExamined: [{name, reason, source:'link'}],
 *   totals: {links, okLinks, files, folders, bytes, notExamined, duplicates}
 * }
 */
async function inventoryLinks(urls, opts) {
  const { maxFiles, maxBytes, maxDepth, maxFileBytes, isSupported } = opts;
  const res = { links: [], files: [], notExamined: [], totals: { links: urls.length, okLinks: 0, files: 0, folders: 0, bytes: 0, notExamined: 0, duplicates: 0 } };
  const seen = new Set();
  let listed = 0;
  const mb = (b) => Math.round(b / 1048576);

  const skip = (entry, name, reason) => {
    res.notExamined.push({ name, reason, source: 'link' });
    entry.notExamined++;
  };

  const consider = (entry, f, relPath, folder) => {
    const size = Number(f.size || 0);
    const name = `Link${entry.n}/${relPath}`;
    if (seen.has(f.id)) { res.totals.duplicates++; return; } // already included via another link
    seen.add(f.id);
    if (f.mimeType === SHORTCUT_MIME) return skip(entry, name, 'Drive shortcut — share the original file instead');
    if (!isSupported(f.name, f.mimeType)) return skip(entry, name, `unsupported file type (${path.extname(f.name) || f.mimeType})`);
    if (res.files.length >= maxFiles) return skip(entry, name, `over the ${maxFiles}-file limit for shared links`);
    if (maxFileBytes && size > maxFileBytes) return skip(entry, name, `larger than ${mb(maxFileBytes)} MB per file`);
    if (res.totals.bytes + size > maxBytes) return skip(entry, name, `over the ${mb(maxBytes)} MB total limit for shared links`);
    res.files.push({ id: f.id, name: f.name, mimeType: f.mimeType, size, resourceKey: f.resourceKey || null, path: name, role: 'LINKED_SUPPORTING', source: 'link', link: entry.n, folder });
    res.totals.bytes += size;
    entry.files++;
    entry.bytes += size;
  };

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const entry = { n: i + 1, url, ok: false, error: null, name: null, kind: null, files: 0, folders: 0, bytes: 0, notExamined: 0 };
    res.links.push(entry);

    // 1. Root metadata
    let root;
    const local = devPath(url);
    if (local) {
      if (!fs.existsSync(local)) { entry.error = 'Local test path not found.'; continue; }
      const isDir = fs.statSync(local).isDirectory();
      root = { id: local, name: path.basename(local), mimeType: isDir ? FOLDER_MIME : guessMime(local), size: isDir ? 0 : fs.statSync(local).size };
    } else {
      const id = parseDriveId(url);
      if (!id) { entry.error = 'Not a Google Drive link. Only Google Drive links can be read.'; continue; }
      if (DEV) { entry.error = 'DEV_MODE: use dev:/local/folder instead of a real Drive link.'; continue; }
      try {
        const r = await drive.files.get({ fileId: id, fields: 'id,name,mimeType,size,resourceKey', supportsAllDrives: true }, rkOpts(id, parseResourceKey(url)));
        root = { ...r.data, resourceKey: r.data.resourceKey || parseResourceKey(url) };
      } catch (e) {
        entry.error = accessError(e);
        continue;
      }
    }
    entry.ok = true;
    entry.name = root.name;
    res.totals.okLinks++;

    // 2. Single file link
    if (root.mimeType !== FOLDER_MIME) {
      entry.kind = 'file';
      consider(entry, root, root.name, '');
      continue;
    }

    // 3. Folder link — breadth-first, depth 0 = files directly inside the linked folder
    entry.kind = 'folder';
    const queue = [{ id: root.id, rk: root.resourceKey, rel: root.name, depth: 0 }];
    while (queue.length) {
      const dir = queue.shift();
      let kids;
      try {
        kids = await listChildren(dir.id, dir.rk);
      } catch (e) {
        skip(entry, `Link${entry.n}/${dir.rel}/`, `folder could not be listed: ${accessError(e)}`);
        continue;
      }
      // folders first, then files, alphabetical — stable order for the auditor
      kids.sort((a, b) => (a.mimeType === FOLDER_MIME) - (b.mimeType === FOLDER_MIME) || a.name.localeCompare(b.name));
      for (const k of kids) {
        if (++listed > LIST_CAP) break;
        const rel = `${dir.rel}/${k.name}`;
        if (k.mimeType === FOLDER_MIME) {
          if (dir.depth + 1 > maxDepth) skip(entry, `Link${entry.n}/${rel}/`, `sub-folder deeper than ${maxDepth} levels — move its files up`);
          else { entry.folders++; res.totals.folders++; queue.push({ id: k.id, rk: k.resourceKey, rel, depth: dir.depth + 1 }); }
        } else {
          consider(entry, k, rel, dir.rel);
        }
      }
      if (listed > LIST_CAP) {
        skip(entry, `Link${entry.n}/…`, `listing stopped after ${LIST_CAP.toLocaleString()} items — split into smaller folders`);
        break;
      }
    }
  }

  res.totals.files = res.files.length;
  res.totals.notExamined = res.notExamined.length;
  return res;
}

/* ------------------------------------------------------------------ email */

async function sendMail({ to, subject, html, text }) {
  if (DEV) {
    console.log(`\n===== [DEV EMAIL] to: ${to}\nSubject: ${subject}\n${text}\n=====\n`);
    return;
  }
  const from = process.env.MAIL_FROM || 'Avatar Agentic AI <agentic.avai@gmail.com>';
  const boundary = 'avag_' + Date.now().toString(36);
  const encSubject = `=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`;
  const raw = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encSubject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    text,
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    '',
    html,
    `--${boundary}--`,
  ].join('\r\n');
  await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: Buffer.from(raw).toString('base64url') },
  });
}

/** Self-check: tries to get an access token and reports what's wrong, never the secrets. */
async function diagnose() {
  const shape = {
    clientId: {
      startsWith: CLIENT_ID.slice(0, 13) + '…',
      looksValid: /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(CLIENT_ID),
    },
    clientSecret: { startsWithGOCSPX: CLIENT_SECRET.startsWith('GOCSPX-'), length: CLIENT_SECRET.length },
    refreshToken: { startsWith1slash: REFRESH_TOKEN.startsWith('1//'), length: REFRESH_TOKEN.length },
  };
  if (DEV) return { dev: true, ...shape };
  try {
    const { token } = await auth.getAccessToken();
    const info = await auth.getTokenInfo(token);
    return {
      ok: true,
      ...shape,
      tokenIssuedToMatchesClientId: info.aud === CLIENT_ID,
      scopes: info.scopes,
      hasDrive: info.scopes.includes('https://www.googleapis.com/auth/drive'),
      hasGmailSend: info.scopes.includes('https://www.googleapis.com/auth/gmail.send'),
    };
  } catch (e) {
    const code = e.response?.data?.error || e.message;
    const hint = {
      unauthorized_client: 'Refresh token was issued to a DIFFERENT OAuth client than GOOGLE_CLIENT_ID/SECRET. Regenerate it via /admin/connect.',
      invalid_client: 'GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is wrong (or the secret was deleted/rotated).',
      invalid_grant: 'Refresh token expired or was revoked. Generate a new one via /admin/connect.',
    }[code];
    return { ok: false, error: code, hint, ...shape };
  }
}

module.exports = {
  DEV,
  FOLDER_MIME,
  diagnose,
  ensurePath,
  createFolder,
  folderLink,
  listChildren,
  listTree,
  uploadFile,
  uploadText,
  findFile,
  readText,
  upsertText,
  downloadFile,
  createGoogleDoc,
  createGoogleSheet,
  upsertGoogleSheet,
  shareWithUser,
  shareWithAnyone,
  unshareAnyone,
  parseDriveId,
  isUsableLink,
  inventoryLinks,
  sendMail,
};
