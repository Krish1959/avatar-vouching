/**
 * Google Drive + Gmail helpers.
 *
 * Auth: OAuth2 user refresh token for agentic.avai@gmail.com
 *   (a service account CANNOT upload into a personal Gmail Drive — it has no storage quota).
 * Email: sent via the Gmail API over HTTPS (Render free tier blocks outbound SMTP ports).
 *
 * DEV_MODE=true  -> no Google calls: "Drive" is mirrored to ./_dev_drive, emails are printed to the console.
 */
const fs = require('fs');
const path = require('path');

const DEV = process.env.DEV_MODE === 'true';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

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
    fs.writeFileSync(path.join(parentId, name), text);
    return;
  }
  const { Readable } = require('stream');
  await drive.files.create({
    requestBody: { name, parents: [parentId] },
    media: { mimeType, body: Readable.from([text]) },
    fields: 'id',
  });
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
      unauthorized_client: 'Refresh token was issued to a DIFFERENT OAuth client than GOOGLE_CLIENT_ID/SECRET. Regenerate it in OAuth Playground with "Use your own OAuth credentials" set to this exact client.',
      invalid_client: 'GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is wrong (or the secret was deleted/rotated).',
      invalid_grant: 'Refresh token expired or was revoked. Generate a new one.',
    }[code];
    return { ok: false, error: code, hint, ...shape };
  }
}

module.exports = {
  DEV,
  diagnose,
  ensurePath,
  createFolder,
  folderLink,
  uploadFile,
  uploadText,
  copyFromDriveLink,
  parseDriveId,
  sendMail,
};
