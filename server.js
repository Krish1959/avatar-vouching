// Version :111126  22:10
// File    :server.js
/**
 * Avatar Vouching Agentic AI — intake service
 *
 * Flow:
 *   1. POST /api/request-code   {accountingCompany, customerCompany, email}  -> emails 6-digit code
 *   2. POST /api/verify-code    {requestId, code}                            -> returns signed upload token
 *   (2b) POST /api/check-links  {token, links[]}  -> per-link pre-check: files found / not examined / no access
 *   3. POST /api/upload         multipart: token, ledger[], sample[], driveLinks[] (up to MAX_LINKS), notes, coverage
 *        coverage = 'full' (DEFAULT — check 100% of the data set) | 'regulation' (SSA 530 sample)   — 111126
 *        -> Drive: Vouching/<ACC_KEY>/<CUST_KEY>/<YYYY-MM-DD_HHMM_REF>/{Ledger_Files,Output_Format_Sample}
 *        -> shared links are checked (metadata only) and recorded — their files are NEVER copied to our Drive;
 *           the AI stage reads them live into memory and discards them after the run.
 *        -> company data recorded in Vouching/_data/companies.json (+ company_profile.json per customer)
 *        -> avatarVouching(context): ChatGPT + Gemini -> Claude final decision -> Doc + Sheet -> email links
 *        Financial statements (Trial Balance / Balance Sheet) are requested in the Notes, e.g. "Create a Balance Sheet".
 *
 *   GET /api/config  limits + supported file types + review-scope options, so the page shows what the server enforces
 *
 * Live progress:
 *   GET  /progress?ref=AV-XXXXXX   3-pendulum page (public/progress.html); no ref = latest job
 *   GET  /api/progress/:ref        JSON timings for that page (no client data)
 *   POST /api/abort {reference, key}  ABORT button (111126). key = private abort key, only in the requester's
 *                                     progress link (upload response + confirmation email). Stops every model.
 *
 * Admin:
 *   GET  /healthz/google   Google auth self-check
 *   GET  /healthz/ai       AI keys + model IDs self-check
 *   POST /admin/rerun      {reference, resume?, coverage?}  header x-admin-token: <ADMIN_TOKEN>
 *                          resume:true = re-run Claude only, reusing the saved ChatGPT + Gemini answers
 *                          coverage    = optional override of the stored review scope ('full' | 'regulation')
 *   POST /admin/abort      {reference}  header x-admin-token — stop a queued or running review
 *
 * On start: recoverInterrupted() re-queues jobs that were waiting, and flags jobs cut off mid-run.
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
const { COVERAGE, normCoverage, statementsRequest } = require('./lib/prompt-builder');
const { LIMITS, SUPPORTED_TYPES_TEXT, SUPPORT_EMAIL } = require('./lib/limits');

const VERSION = '111126 22:10';
const PORT = process.env.PORT || 3000;
const ROOT_FOLDER = process.env.ROOT_FOLDER_NAME || 'Vouching';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'agentic.avai@gmail.com';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || (g.DEV ? 'dev-admin' : '');
const SECRET = process.env.SESSION_SECRET || (g.DEV ? 'dev-secret' : null);
const MAX_FILE_MB = LIMITS.maxUploadFileMb;
const CODE_TTL_MS = 10 * 60 * 1000;
const TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || (g.DEV ? `http://localhost:${PORT}` : 'https://avatar-vouching.onrender.com')).replace(/\/+$/, '');
/** Private abort key for one reference — derived from SESSION_SECRET, so nothing needs storing. */
const abortKey = (ref) => require('crypto').createHmac('sha256', SECRET || 'unset').update(`abort:${String(ref).toUpperCase()}`).digest('base64url').slice(0, 24);
/** Public progress link (watch only), or the requester's link with the ABORT key. */
const progressUrl = (ref, withKey = false) => `${PUBLIC_URL}/progress?ref=${encodeURIComponent(ref)}${withKey ? `&key=${abortKey(ref)}` : ''}`;

/**
 * ALPHA TEST MODE (temporary). ON by default.
 *   ALPHA_PUBLIC_LINKS=false  -> back to private (verified-email-only) sharing, no code change needed.
 *   ALPHA_PUBLIC_ROLE=writer  -> "anyone with the link" can EDIT (default: reader = view + download).
 * When ON, the accounting-company folder and the customer folder under Vouching/ are set to
 * "Anyone with the link"; everything inside them inherits it. Links are not searchable.
 */
const ALPHA_PUBLIC = process.env.ALPHA_PUBLIC_LINKS !== 'false';
const ALPHA_ROLE = process.env.ALPHA_PUBLIC_ROLE === 'writer' ? 'writer' : 'reader';

/** Results are shared via Google Drive to the verified email only — clients must know this up front. */
const PRIVATE_NOTE_TEXT = 'IMPORTANT: Results are shared via Google Drive with this email address only. It must be linked to a Google account. Google Workspace emails already work. Microsoft 365 or other office email: link a free Google account to it at https://accounts.google.com/signup ("Use my current email address instead"). Forwarded links will not open for any other address.';
const PRIVATE_NOTE_HTML = `<div style="background:#fff8e1;border:1px solid #e6c200;border-radius:6px;padding:10px 14px;margin:12px 0;font-size:13px">
  <b>Important — Google account needed to open results.</b><br>
  Results are shared via Google Drive with <b>this email address only</b>. Google Workspace emails already work.
  Microsoft 365 or other office email? Link a free Google account to it at
  <a href="https://accounts.google.com/signup">accounts.google.com/signup</a> (choose "Use my current email address instead").
  Forwarded links will not open for any other address.</div>`;
const ALPHA_NOTE_TEXT = 'ALPHA TEST: result links open for anyone who has them, no Google account or sign-in needed. Please do not forward the links.';
const ALPHA_NOTE_HTML = `<div style="background:#fff8e1;border:1px solid #e6c200;border-radius:6px;padding:10px 14px;margin:12px 0;font-size:13px">
  <b>Alpha test.</b> Result links open for anyone who has them — no Google account or sign-in needed.
  Please do not forward the links.</div>`;
const GOOGLE_NOTE_TEXT = ALPHA_PUBLIC ? ALPHA_NOTE_TEXT : PRIVATE_NOTE_TEXT;
const GOOGLE_NOTE_HTML = ALPHA_PUBLIC ? ALPHA_NOTE_HTML : PRIVATE_NOTE_HTML;

/** Data-privacy assurance for shared links — the same words appear on the page and in the emails. */
const LINK_PRIVACY_TEXT = 'Linked folders — read-only, in transit only. Your files are read directly from your link into memory, sent over encrypted connections to our AI providers (OpenAI, Google, Anthropic) for analysis, then discarded. We never copy them to our storage. Under our paid API terms, providers do not use your data to train their models. Only your results report is saved. You may revoke your link once the run completes.';

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
const mbText = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

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

/**
 * Normalises the shared links from the form: accepts driveLinks (repeated field / array) and the old
 * single driveLink. Returns {links, error}.
 */
function readLinks(body) {
  const raw = [body.driveLinks, body['driveLinks[]'], body.driveLink].flat().filter((x) => x != null);
  const links = [...new Set(raw.map((s) => clean(s, 500)).filter(Boolean))];
  if (links.length > LIMITS.maxLinks) return { links, error: `Up to ${LIMITS.maxLinks} shared links per submission.` };
  for (const [i, l] of links.entries()) {
    if (g.DEV && /^dev:/.test(l)) continue;
    if (!/^https:\/\//i.test(l)) return { links, error: `Link ${i + 1} must start with https://` };
    if (!g.isUsableLink(l)) return { links, error: `Link ${i + 1} is not a Google Drive link. Only Google Drive links can be read — for other storage, contact ${SUPPORT_EMAIL}.` };
  }
  return { links, error: null };
}

/** Metadata-only check of all links. Safe summary for the client (counts + reasons, no contents). */
async function checkLinks(links) {
  const inv = await g.inventoryLinks(links, vouching.linkInventoryOptions());
  return {
    ok: inv.links.every((l) => l.ok),
    totals: inv.totals,
    links: inv.links.map((l) => ({ n: l.n, ok: l.ok, error: l.error, name: l.name, kind: l.kind, files: l.files, folders: l.folders, bytes: l.bytes, size: mbText(l.bytes), notExamined: l.notExamined })),
    notExamined: inv.notExamined,
  };
}

/* ------------------------------------------------------------- config */

app.get('/api/config', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    version: VERSION,
    limits: LIMITS,
    supportedTypes: SUPPORTED_TYPES_TEXT,
    supportEmail: SUPPORT_EMAIL,
    linkPrivacy: LINK_PRIVACY_TEXT,
    coverage: { default: 'full', options: COVERAGE },
  });
});

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
      text: `Your confirmation code is ${code}\n\nAccounting company: ${accountingCompany}\nCustomer company: ${customerCompany}\n\n${GOOGLE_NOTE_TEXT}\n\nThe code expires in 10 minutes. If you did not request it, ignore this email.`,
      html: emailShell(
        'Your confirmation code',
        `<p style="font-size:32px;letter-spacing:8px;font-weight:bold;color:#3d2314;margin:10px 0">${code}</p>
         <p>Accounting company: <b>${escHtml(accountingCompany)}</b><br>Customer company: <b>${escHtml(customerCompany)}</b></p>
         ${GOOGLE_NOTE_HTML}
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

/* ------------------------------------------- step 2b: pre-check shared links */

app.post('/api/check-links', rateLimit({ windowMs: 10 * 60 * 1000, max: 30 }), async (req, res) => {
  if (!verify(req.body.token)) return res.status(401).json({ error: 'Session expired. Please verify your email again.' });
  const { links, error } = readLinks({ driveLinks: Array.isArray(req.body.links) ? req.body.links : [req.body.links] });
  if (error) return res.status(400).json({ error });
  if (!links.length) return res.status(400).json({ error: 'Paste a link first.' });
  try {
    res.json(await checkLinks(links));
  } catch (e) {
    console.error('check-links failed:', e.message);
    res.status(502).json({ error: 'Could not check the link right now. Please try again.' });
  }
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
    const notes = cleanNotes(req.body.notes);
    const coverage = normCoverage(req.body.coverage); // anything but 'regulation' → 100%
    const statements = statementsRequest(notes);
    const { links, error: linkError } = readLinks(req.body);

    if (linkError) {
      cleanup();
      return res.status(400).json({ error: linkError });
    }
    if (!ledger.length && !links.length) {
      cleanup();
      return res.status(400).json({ error: 'Please add at least one ledger file or a shared folder link.' });
    }

    // Pre-check links (metadata only) BEFORE anything is stored, so access problems are fixed now.
    let linkCheck = null;
    if (links.length) {
      try {
        linkCheck = await checkLinks(links);
      } catch (e) {
        cleanup();
        console.error('link pre-check failed:', e.message);
        return res.status(502).json({ error: 'Could not check your shared link(s) right now. Please try again.' });
      }
      const bad = linkCheck.links.filter((l) => !l.ok);
      if (bad.length) {
        cleanup();
        return res.status(400).json({ error: bad.map((l) => `Link ${l.n}: ${l.error}`).join(' '), linkCheck });
      }
    }

    const reference = 'AV-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    const stamp = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Singapore' }).slice(0, 16).replace(' ', '_').replace(':', '');
    const batchName = `${stamp}_${reference}`;

    try {
      const customerFolder = await g.ensurePath([ROOT_FOLDER, session.accKey, session.custKey]);
      if (ALPHA_PUBLIC) {
        // ALPHA: open the accounting-company folder (e.g. ABC) and customer folder (e.g. XYZ) to anyone with the link.
        const accFolder = await g.ensurePath([ROOT_FOLDER, session.accKey]);
        for (const id of [accFolder, customerFolder]) {
          const r = await g.shareWithAnyone(id, ALPHA_ROLE);
          if (!r.ok) console.error('alpha public share failed:', r.error);
        }
      }
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
      // Shared links: NOT copied. Only the links and the metadata pre-check are recorded.

      const record = {
        schema: 'avag.vouching.submission/v3',
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
        driveLinks: links,
        linkHandling: links.length ? 'read-in-memory-only (never copied)' : null,
        linkCheck: linkCheck && { checkedAt: new Date().toISOString(), totals: linkCheck.totals, links: linkCheck.links },
        notes,
        coverage,
        statementsRequested: statements.label,
        client: { ip: req.ip, userAgent: clean(req.get('user-agent'), 300) },
      };
      await g.uploadText('submission_info.json', JSON.stringify(record, null, 2), batchFolder);
      cleanup();

      const link = g.folderLink(batchFolder);
      const context = { ...record, batchFolderId: batchFolder, batchFolderLink: link, customerFolderId: customerFolder, storedFiles: stored };
      const live = progressUrl(reference, true); // requester's link — carries the ABORT key
      const lt = linkCheck?.totals;

      res.json({
        ok: true,
        reference,
        drivePath: record.drivePath,
        ledgerCount: ledger.length,
        sampleCount: sample.length,
        linkCount: links.length,
        linkFiles: lt ? lt.files : 0,
        linkFolders: lt ? lt.folders : 0,
        linkNotExamined: lt ? lt.notExamined : 0,
        coverage,
        coverageLabel: COVERAGE[coverage].label,
        statementsRequested: statements.label,
        progressUrl: live,
      });

      // Registry + notifications + AI review run after the response so the user isn't kept waiting.
      // Registry write is queued first (FIFO lock), so the AI stage always finds the submission entry.
      registry.recordSubmission(context).catch((e) => console.error('registry write failed:', e.message));

      const scopeLine = `Review scope: ${COVERAGE[coverage].label}`;
      const fsLine = `Financial statements: ${statements.requested ? `${statements.label} (requested in Notes)` : 'not requested'}`;
      const list = (arr) => arr.map((f) => `<li>${escHtml(f.name)}</li>`).join('') || '<li>—</li>';
      const linkLines = linkCheck ? linkCheck.links.map((l) => `Link ${l.n}: ${l.name} — ${l.files} file(s)${l.folders ? ` in ${l.folders} sub-folder(s)` : ''}, ${l.size}${l.notExamined ? `, ${l.notExamined} not examined` : ''}`) : [];
      const linkBlockHtml = linkCheck ? `
           <p><b>Shared links</b> (read in memory only — never copied to our storage)</p>
           <ul>${linkLines.map((x) => `<li>${escHtml(x)}</li>`).join('')}</ul>
           ${lt.notExamined ? `<p style="font-size:13px">${lt.notExamined} linked file(s) will not be examined (unsupported type or over a limit). The full list will be in your results.</p>` : ''}
           <p style="font-size:12px;color:#6b4a35">🔒 ${escHtml(LINK_PRIVACY_TEXT)}</p>` : '';
      g.sendMail({
        to: session.email,
        subject: `Files received — ${reference}`,
        text: `We received your files.\nReference: ${reference}\n${scopeLine}\n${fsLine}\nLedger files: ${ledger.length}\nOutput samples: ${sample.length}${linkLines.length ? `\nShared links:\n  ${linkLines.join('\n  ')}\n\n${LINK_PRIVACY_TEXT}` : ''}\n\nOur AI review has started. Watch it live: ${live}\nNeed to stop it (wrong file, missing data)? Open that link and press ABORT. Keep the link private.\nYou will receive a second email with the link to the results.\n\n${GOOGLE_NOTE_TEXT}`,
        html: emailShell(`Files received — ${reference}`,
          `<p>Thank you. Your vouching data set has been received.</p>
           <p><b>${escHtml(scopeLine)}</b><br>${escHtml(fsLine)}</p>
           <p><b>Ledger files</b></p><ul>${list(record.ledgerFiles)}</ul>
           <p><b>Output format samples</b></p><ul>${list(record.outputFormatSamples)}</ul>
           ${linkBlockHtml}
           <p>Our AI review has started. You will receive a second email with the link to the results.</p>
           ${GOOGLE_NOTE_HTML}
           <p><a href="${escHtml(live)}" style="background:#3d2314;color:#FFD700;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:bold">Watch progress live</a></p>
           <p style="font-size:13px">Need to stop the review (wrong file, missing data)? Open this link and press <b style="color:#c62828">ABORT</b>. Keep the link private — it can stop your review.</p>
           <p>Quote reference <b>${reference}</b> in any correspondence.</p>`),
      }).catch((e) => console.error('client confirmation failed:', e.message));

      g.sendMail({
        to: ADMIN_EMAIL,
        subject: `[Vouching] ${session.accKey}/${session.custKey} — ${reference} — ${coverage === 'full' ? '100%' : 'SSA 530'}${statements.requested ? ` + ${statements.label}` : ''}`,
        text: `${JSON.stringify(record, null, 2)}\n\nFolder: ${link}\nLive progress: ${live}`,
        html: emailShell(`New submission ${reference}`,
          `<p>${escHtml(session.accountingCompany)} → ${escHtml(session.customerCompany)}<br>${escHtml(session.email)}</p>
           <p>${escHtml(scopeLine)}<br>${escHtml(fsLine)}</p>
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

/* ------------------------------------------------------------------ abort */

app.post('/api/abort', rateLimit({ windowMs: 10 * 60 * 1000, max: 20 }), (req, res) => {
  const reference = clean(req.body.reference, 20).toUpperCase();
  if (!reference || !safeEqual(req.body.key, abortKey(reference))) {
    return res.status(403).json({ error: 'This link cannot stop the review. Use the link from your confirmation email.' });
  }
  const r = vouching.abort(reference, 'client');
  res.status(r.ok ? 200 : 409).json(r);
});

/* ------------------------------------------------------------------ admin */

app.post('/admin/abort', rateLimit({ windowMs: 15 * 60 * 1000, max: 30 }), (req, res) => {
  if (!ADMIN_TOKEN || !safeEqual(req.get('x-admin-token'), ADMIN_TOKEN)) return res.status(401).json({ error: 'unauthorised' });
  const r = vouching.abort(clean(req.body.reference, 20).toUpperCase(), 'admin');
  res.status(r.ok ? 200 : 409).json(r);
});


app.post('/admin/rerun', rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }), async (req, res) => {
  if (!ADMIN_TOKEN || !safeEqual(req.get('x-admin-token'), ADMIN_TOKEN)) return res.status(401).json({ error: 'unauthorised' });
  const reference = clean(req.body.reference, 20).toUpperCase();
  const resume = req.body.resume === true || req.body.resume === 'true';
  try {
    const loaded = await vouching.loadContext(reference);
    // Optional scope override, e.g. re-run an old sampled job at 100%.
    const coverage = req.body.coverage ? normCoverage(req.body.coverage) : loaded.coverage;
    const ctx = { ...loaded, coverage, rerun: true, resume };
    res.json({ ...(await vouching.avatarVouching(ctx)), coverage, progressUrl: progressUrl(reference, true) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

if (!g.DEV) require('./lib/connect').mount(app);

app.get('/healthz', (_req, res) => res.json({ ok: true, version: VERSION, dev: g.DEV, alphaPublicLinks: ALPHA_PUBLIC ? ALPHA_ROLE : false, limits: LIMITS, vouching: vouching.status() }));
app.get('/healthz/google', rateLimit({ windowMs: 60 * 1000, max: 10 }), async (_req, res) => res.json(await g.diagnose()));
app.get('/healthz/ai', rateLimit({ windowMs: 60 * 1000, max: 5 }), async (_req, res) => res.json(await llm.healthcheck()));

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`AVAG.AI vouching intake v${VERSION} on :${PORT}${g.DEV ? ' (DEV_MODE)' : ''} · RAM guard ${LIMITS.computeRamMb} MB`);
    // Give the instance a moment to settle, then pick up anything a restart cut off.
    setTimeout(() => vouching.recoverInterrupted().catch((e) => console.error('recovery failed:', e.message)), 15e3).unref();
  });
}
module.exports = { app, folderKey, readLinks };
