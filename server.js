// Version :031126 01:10
// File    :server.js
/**
 * Avatar Vouching Agentic AI — intake service
 *
 * Flow:
 *   1. POST /api/request-code   {accountingCompany, customerCompany, email}  -> emails 6-digit code
 *   2. POST /api/verify-code    {requestId, code}                            -> returns signed upload token
 *   3. POST /api/upload         multipart: token, ledger[], sample[], driveLink, notes
 *        -> Drive: Vouching/<ACC_KEY>/<CUST_KEY>/<YYYY-MM-DD_HHMM_REF>/{Ledger_Files,Output_Format_Sample,Linked_Files}
 *        -> company data recorded in Vouching/_data/companies.json (+ company_profile.json per customer)
 *        -> avatarVouching(context): ChatGPT + Gemini -> Claude final decision -> Google Docs -> email link
 *
 * Live progress:
 *   GET  /progress?ref=AV-XXXXXX   3-pendulum page (public/progress.html); no ref = latest job
 *   GET  /api/progress/:ref        JSON timings for that page (no client data)
 *
 * Admin:
 *   GET  /healthz/google   Google auth self-check
 *   GET  /healthz/ai       AI keys + model IDs self-check
 *   POST /admin/rerun      {reference}  header x-admin-token: <ADMIN_TOKEN>   re-runs the AI review
 */
const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const rateLimit = require('express-rate-limit');
const g = require('./lib/google');
const llm = require('./lib/llm');
const registry = require('./lib/registry');
const { emailShell } = require('./lib/report');
const vouching = require('./lib/avatar-vouching');

const VERSION = '031126 01:10';
const PORT = process.env.PORT || 3000;
const ROOT_FOLDER = process.env.ROOT_FOLDER_NAME || 'Vouching';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'agentic.avai@gmail.com';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || (g.DEV ? 'dev-admin' : '');
const SECRET = process.env.SESSION_SECRET || (g.DEV ? 'dev-secret' : null);
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 100);
const CODE_TTL_MS = 10 * 60 * 1000;
const TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || (g.DEV ? `http://localhost:${PORT}` : 'https://avatar-vouching.onrender.com')).replace(/\/+$/, '');
const progressUrl = (ref) => `${PUBLIC_URL}/progress?ref=${encodeURIComponent(ref)}`;

if (!SECRET) {
  console.error('SESSION_SECRET is not set. Refusing to start.');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1); // Render sits behind a proxy
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ---------------------------------------------------------------- helpers */

/** "SPN Management Consultants" -> "SPN";  "The Abc Pte Ltd" -> "ABC" */
function folderKey(name) {
  const words = String(name)
    .normalize('NFKD')
    .replace(/[^\w\s&-]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w && !/^the$/i.test(w));
  const key = (words[0] || '').replace(/[^A-Za-z0-9&-]/g, '').toUpperCase().slice(0, 40);
  return key || 'UNKNOWN';
}

const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e)) && String(e).length <= 254;
const clean = (s, max = 120) => String(s || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, max);
/** Notes keep their line breaks — they become structured prompt instructions. */
const cleanNotes = (s, max = 2000) => String(s || '')
  .replace(/\r\n?/g, '\n').replace(/[\t\v\f]/g, ' ').replace(/[^\S\n]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n')
  .trim().slice(0, max);
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
};

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verify(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const expect = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  const p = JSON.parse(Buffer.from(body, 'base64url').toString());
  return p.exp > Date.now() ? p : null;
}

/* ------------------------------------------------- step 1: request a code */

const pending = new Map(); // requestId -> {codeHash, data, expires, attempts}
const lastSent = new Map(); // email -> timestamp (resend cooldown)
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
}, 60 * 1000).unref();

const codeLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 8, standardHeaders: true, legacyHeaders: false });

app.post('/api/request-code', codeLimiter, async (req, res) => {
  const accountingCompany = clean(req.body.accountingCompany);
  const customerCompany = clean(req.body.customerCompany);
  const email = clean(req.body.email, 254).toLowerCase();

  if (!accountingCompany || !customerCompany) return res.status(400).json({ error: 'Both company names are required.' });
  if (!isEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });

  const last = lastSent.get(email) || 0;
  if (Date.now() - last < 60 * 1000) return res.status(429).json({ error: 'Please wait a minute before requesting another code.' });

  const code = String(crypto.randomInt(100000, 1000000));
  const requestId = crypto.randomBytes(16).toString('hex');
  const data = {
    accountingCompany,
    customerCompany,
    email,
    accKey: folderKey(accountingCompany),
    custKey: folderKey(customerCompany),
  };

  try {
    await g.sendMail({
      to: email,
      subject: `Your AVAG.AI confirmation code: ${code}`,
      text: `Your confirmation code is ${code}\n\nAccounting company: ${accountingCompany}\nCustomer company: ${customerCompany}\n\nThe code expires in 10 minutes. If you did not request it, ignore this email.`,
      html: emailShell(
        'Your confirmation code',
        `<p style="font-size:32px;letter-spacing:8px;font-weight:bold;color:#3d2314;margin:10px 0">${code}</p>
         <p>Accounting company: <b>${escHtml(accountingCompany)}</b><br>Customer company: <b>${escHtml(customerCompany)}</b></p>
         <p style="color:#6b4a35;font-size:12px">The code expires in 10 minutes. If you did not request it, ignore this email.</p>`
      ),
    });
  } catch (e) {
    console.error('sendMail failed:', e.message);
    return res.status(502).json({ error: 'Could not send the confirmation email. Please try again shortly.' });
  }

  pending.set(requestId, { codeHash: hash(code + requestId), data, expires: Date.now() + CODE_TTL_MS, attempts: 0 });
  lastSent.set(email, Date.now());
  res.json({ requestId, accKey: data.accKey, custKey: data.custKey, maskedEmail: email.replace(/^(.{2}).*(@.*)$/, '$1***$2') });
});

/* -------------------------------------------------- step 2: verify a code */

app.post('/api/verify-code', rateLimit({ windowMs: 15 * 60 * 1000, max: 30 }), (req, res) => {
  const { requestId } = req.body;
  const code = clean(req.body.code, 6);
  const entry = pending.get(requestId);
  if (!entry || entry.expires < Date.now()) return res.status(400).json({ error: 'Code expired. Please request a new one.' });

  entry.attempts++;
  if (hash(code + requestId) !== entry.codeHash) {
    if (entry.attempts >= 5) {
      pending.delete(requestId);
      return res.status(400).json({ error: 'Too many wrong attempts. Please request a new code.' });
    }
    return res.status(400).json({ error: `Incorrect code. ${5 - entry.attempts} attempt(s) left.` });
  }
  pending.delete(requestId);
  res.json({ token: sign({ ...entry.data, exp: Date.now() + TOKEN_TTL_MS }), ...entry.data });
});

/* ------------------------------------------------------ step 3: upload set */

const upload = multer({
  dest: path.join(os.tmpdir(), 'avag-uploads'),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 60 },
});
const fields = upload.fields([{ name: 'ledger', maxCount: 50 }, { name: 'sample', maxCount: 10 }]);

app.post('/api/upload', (req, res) => {
  fields(req, res, async (err) => {
    const all = [...(req.files?.ledger || []), ...(req.files?.sample || [])];
    const cleanup = () => all.forEach((f) => fs.unlink(f.path, () => {}));

    if (err) {
      cleanup();
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `Each file must be under ${MAX_FILE_MB} MB.` : err.message;
      return res.status(400).json({ error: msg });
    }

    const session = verify(req.body.token);
    if (!session) {
      cleanup();
      return res.status(401).json({ error: 'Session expired. Please verify your email again.' });
    }

    const ledger = req.files?.ledger || [];
    const sample = req.files?.sample || [];
    const driveLink = clean(req.body.driveLink, 500);
    const notes = cleanNotes(req.body.notes);

    if (!ledger.length && !driveLink) {
      cleanup();
      return res.status(400).json({ error: 'Please add at least one ledger file or a shared folder link.' });
    }
    if (driveLink && !/^https:\/\//i.test(driveLink)) {
      cleanup();
      return res.status(400).json({ error: 'The shared link must start with https://' });
    }

    const reference = 'AV-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    const stamp = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Singapore' }).slice(0, 16).replace(' ', '_').replace(':', '');
    const batchName = `${stamp}_${reference}`;

    try {
      const customerFolder = await g.ensurePath([ROOT_FOLDER, session.accKey, session.custKey]);
      const batchFolder = await g.createFolder(batchName, customerFolder);

      const stored = { ledger: [], sample: [] };
      if (ledger.length) {
        const dir = await g.createFolder('Ledger_Files', batchFolder);
        for (const f of ledger) stored.ledger.push(await g.uploadFile(f.path, f.originalname, f.mimetype, dir));
      }
      if (sample.length) {
        const dir = await g.createFolder('Output_Format_Sample', batchFolder);
        for (const f of sample) stored.sample.push(await g.uploadFile(f.path, f.originalname, f.mimetype, dir));
      }

      let linkResult = null;
      if (driveLink) {
        if (g.parseDriveId(driveLink)) {
          const dir = await g.createFolder('Linked_Files', batchFolder);
          try {
            linkResult = await g.copyFromDriveLink(driveLink, dir);
          } catch (e) {
            linkResult = { copied: [], failed: [`Could not open link: ${e.message}`], skipped: 0 };
          }
        } else {
          linkResult = { copied: [], failed: ['Non-Google link — saved for manual download.'], skipped: 0 };
        }
      }

      const record = {
        schema: 'avag.vouching.submission/v1',
        reference,
        submittedAt: new Date().toISOString(),
        accountingCompany: session.accountingCompany,
        customerCompany: session.customerCompany,
        accKey: session.accKey,
        custKey: session.custKey,
        email: session.email,
        drivePath: `${ROOT_FOLDER}/${session.accKey}/${session.custKey}/${batchName}`,
        ledgerFiles: ledger.map((f) => ({ name: f.originalname, bytes: f.size })),
        outputFormatSamples: sample.map((f) => ({ name: f.originalname, bytes: f.size })),
        driveLink: driveLink || null,
        linkCopy: linkResult,
        notes,
        client: { ip: req.ip, userAgent: clean(req.get('user-agent'), 300) },
      };
      await g.uploadText('submission_info.json', JSON.stringify(record, null, 2), batchFolder);
      cleanup();

      const link = g.folderLink(batchFolder);
      const context = { ...record, batchFolderId: batchFolder, batchFolderLink: link, customerFolderId: customerFolder, storedFiles: stored };
      const live = progressUrl(reference);

      res.json({
        ok: true,
        reference,
        drivePath: record.drivePath,
        ledgerCount: ledger.length,
        sampleCount: sample.length,
        linkCopied: linkResult ? linkResult.copied.length : 0,
        linkFailed: linkResult ? linkResult.failed.length : 0,
        progressUrl: live,
      });

      // Registry + notifications + AI review run after the response so the user isn't kept waiting.
      // Registry write is queued first (FIFO lock), so the AI stage always finds the submission entry.
      registry.recordSubmission(context).catch((e) => console.error('registry write failed:', e.message));

      const list = (arr) => arr.map((f) => `<li>${escHtml(f.name)}</li>`).join('') || '<li>—</li>';
      g.sendMail({
        to: session.email,
        subject: `Files received — ${reference}`,
        text: `We received your files.\nReference: ${reference}\nLedger files: ${ledger.length}\nOutput samples: ${sample.length}${driveLink ? `\nShared link: ${driveLink}` : ''}\n\nOur AI review has started. Watch it live: ${live}\nYou will receive a second email with the link to the results.`,
        html: emailShell(`Files received — ${reference}`,
          `<p>Thank you. Your vouching data set has been received.</p>
           <p><b>Ledger files</b></p><ul>${list(record.ledgerFiles)}</ul>
           <p><b>Output format samples</b></p><ul>${list(record.outputFormatSamples)}</ul>
           ${driveLink ? `<p><b>Shared link:</b> ${escHtml(driveLink)}</p>` : ''}
           <p>Our AI review has started. You will receive a second email with the link to the results.</p>
           <p><a href="${escHtml(live)}" style="background:#3d2314;color:#FFD700;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:bold">Watch progress live</a></p>
           <p>Quote reference <b>${reference}</b> in any correspondence.</p>`),
      }).catch((e) => console.error('client confirmation failed:', e.message));

      g.sendMail({
        to: ADMIN_EMAIL,
        subject: `[Vouching] ${session.accKey}/${session.custKey} — ${reference}`,
        text: `${JSON.stringify(record, null, 2)}\n\nFolder: ${link}\nLive progress: ${live}`,
        html: emailShell(`New submission ${reference}`,
          `<p>${escHtml(session.accountingCompany)} → ${escHtml(session.customerCompany)}<br>${escHtml(session.email)}</p>
           <p><a href="${link}">Open Drive folder</a> · <a href="${escHtml(live)}">Live progress</a></p><pre style="font-size:11px;white-space:pre-wrap">${escHtml(JSON.stringify(record, null, 2))}</pre>`),
      }).catch((e) => console.error('admin notification failed:', e.message));

      Promise.resolve(vouching.avatarVouching(context)).catch((e) => console.error('avatarVouching failed:', e.message));
    } catch (e) {
      cleanup();
      console.error('upload failed:', e);
      res.status(500).json({ error: 'Storage failed. Please try again or contact us.' });
    }
  });
});

/* -------------------------------------------------------- live progress */

app.get('/progress', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'progress.html')));

const progressLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false });
const sendProgress = (ref, res) => {
  const p = vouching.getProgress(ref);
  res.set('Cache-Control', 'no-store');
  if (!p) return res.status(404).json({ error: ref ? `No live progress for ${ref} (it may have finished before a restart).` : 'No job has run since the last restart.' });
  res.json(p);
};
app.get('/api/progress', progressLimiter, (_req, res) => sendProgress(null, res));
app.get('/api/progress/:ref', progressLimiter, (req, res) => sendProgress(clean(req.params.ref, 20).toUpperCase(), res));

/* ------------------------------------------------------------------ admin */

app.post('/admin/rerun', rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }), async (req, res) => {
  if (!ADMIN_TOKEN || !safeEqual(req.get('x-admin-token'), ADMIN_TOKEN)) return res.status(401).json({ error: 'unauthorised' });
  const reference = clean(req.body.reference, 20).toUpperCase();
  try {
    const sub = await registry.findSubmission(reference);
    if (!sub?.batchFolderId) return res.status(404).json({ error: `No submission ${reference} in registry.` });
    const infoId = await g.findFile('submission_info.json', sub.batchFolderId);
    if (!infoId) return res.status(404).json({ error: 'submission_info.json not found in batch folder.' });
    const record = JSON.parse(await g.readText(infoId));
    const ctx = {
      ...record,
      accKey: record.accKey || sub.accKey,
      custKey: record.custKey || sub.custKey,
      batchFolderId: sub.batchFolderId,
      batchFolderLink: sub.batchFolderLink || g.folderLink(sub.batchFolderId),
      customerFolderId: sub.customerFolderId,
      rerun: true,
    };
    res.json({ ...(await vouching.avatarVouching(ctx)), progressUrl: progressUrl(reference) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

if (!g.DEV) require('./lib/connect').mount(app);

app.get('/healthz', (_req, res) => res.json({ ok: true, version: VERSION, dev: g.DEV, vouching: vouching.status() }));
app.get('/healthz/google', rateLimit({ windowMs: 60 * 1000, max: 10 }), async (_req, res) => res.json(await g.diagnose()));
app.get('/healthz/ai', rateLimit({ windowMs: 60 * 1000, max: 5 }), async (_req, res) => res.json(await llm.healthcheck()));

if (require.main === module) {
  app.listen(PORT, () => console.log(`AVAG.AI vouching intake v${VERSION} on :${PORT}${g.DEV ? ' (DEV_MODE)' : ''}`));
}
module.exports = { app, folderKey };
