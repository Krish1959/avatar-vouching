// Version :041126 11:55
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
 * DEV_MODE=true  -> no Google calls: "Drive" is mirrored to ./_dev_drive, emails are printed to the console,
 *                   Google Docs are written as .html files, Google Sheets as .xlsx files.
 */
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const DEV = process.env.DEV_MODE === 'true';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const DOC_MIME = 'application/vnd.google-apps.document';
const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const SLIDES_MIME = 'application/vnd.google-apps.presentation';
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

/** Direct children of a folder: [{id,name,mimeType,size}] */
async function listChildren(folderId) {
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
      fields: 'nextPageToken, files(id,name,mimeType,size)',
      pageSize: 200,
      pageToken,
    });
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
    return fs.existsSync(p) ? p : null;
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
 * Downloads any Drive file as a Buffer. Google-native files are exported:
 * Docs/Slides -> text, Sheets -> .xlsx (all tabs).
 */
async function downloadFile(file) {
  if (DEV) return { buffer: fs.readFileSync(file.id), mimeType: file.mimeType, name: file.name };
  const exportAs = {
    [DOC_MIME]: ['text/plain', '.txt'],
    [SLIDES_MIME]: ['text/plain', '.txt'],
    [SHEET_MIME]: [XLSX_MIME, '.xlsx'],
  }[file.mimeType];
  if (exportAs) {
    const r = await drive.files.export({ fileId: file.id, mimeType: exportAs[0] }, { responseType: 'arraybuffer' });
    return { buffer: Buffer.from(r.data), mimeType: exportAs[0], name: file.name + exportAs[1] };
  }
  if (String(file.mimeType).startsWith('application/vnd.google-apps.')) {
    throw new Error(`Unsupported Google file type ${file.mimeType}`);
  }
  const r = await drive.files.get({ fileId: file.id, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' });
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

/* ---------------------------------------------- copy from a shared Drive link */

function parseDriveId(url) {
  const pats = [/\/folders\/([\w-]{10,})/, /\/file\/d\/([\w-]{10,})/, /\/d\/([\w-]{10,})/, /[?&]id=([\w-]{10,})/];
  for (const p of pats) {
    const m = String(url).match(p);
    if (m) return m[1];
  }
  return null;
}

const MAX_COPY = Number(process.env.MAX_LINK_FILES || 500);

/** Copies a shared Drive file or whole folder tree into destParentId. */
async function copyFromDriveLink(url, destParentId) {
  const result = { copied: [], failed: [], skipped: 0 };
  const id = parseDriveId(url);
  if (!id) throw new Error('Not a recognisable Google Drive link.');
  if (DEV) {
    result.copied.push(`(dev) would copy ${id}`);
    return result;
  }

  const meta = await drive.files.get({ fileId: id, fields: 'id,name,mimeType', supportsAllDrives: true });

  async function copyOne(file, dest) {
    if (result.copied.length >= MAX_COPY) { result.skipped++; return; }
    try {
      await drive.files.copy({
        fileId: file.id,
        requestBody: { name: file.name, parents: [dest] },
        supportsAllDrives: true,
        fields: 'id',
      });
      result.copied.push(file.name);
    } catch (e) {
      result.failed.push(`${file.name}: ${e.message}`);
    }
  }

  async function walk(folderId, dest) {
    let pageToken;
    do {
      const r = await drive.files.list({
        q: `'${folderId}' in parents and trashed=false`,
        fields: 'nextPageToken, files(id,name,mimeType)',
        pageSize: 200,
        pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      for (const f of r.data.files) {
        if (f.mimeType === FOLDER_MIME) {
          const sub = await createFolder(f.name, dest);
          await walk(f.id, sub);
        } else if (f.mimeType === 'application/vnd.google-apps.shortcut') {
          result.skipped++;
        } else {
          await copyOne(f, dest);
        }
      }
      pageToken = r.data.nextPageToken;
    } while (pageToken);
  }

  if (meta.data.mimeType === FOLDER_MIME) {
    const root = await createFolder(meta.data.name, destParentId);
    await walk(meta.data.id, root);
  } else {
    await copyOne(meta.data, destParentId);
  }
  return result;
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
  copyFromDriveLink,
  parseDriveId,
  sendMail,
};
