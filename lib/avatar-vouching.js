// Version :071126 00:25
// File    :lib/avatar-vouching.js
/**
 * avatarVouching(context) — the AI review stage. Runs once per submission.
 *
 *  1. Collect the inputs:
 *       - uploaded files stored on Drive (Ledger_Files, Output_Format_Sample)
 *       - shared links: walked LIVE (sub-folders included, up to MAX_LINK_DEPTH), each file downloaded
 *         straight into memory, text taken, buffer dropped. Linked files are NEVER copied to our Drive or disk.
 *     Anything that cannot be examined (unsupported, over a limit, no access, compute capacity) is listed
 *     as "Not examined" — in the Doc, the Sheet (own tab) and the client email.
 *  2. Refine the client's Notes into structured instructions and build the engineered prompt.
 *  2b. Health check: send "Hi" to ChatGPT, Gemini and Claude. If ANY fails, stop here:
 *        - alert email to ALERT_EMAIL (agentic.avai@gmail.com)
 *        - "system unavailable" email to the requester with the support contact
 *  3. Send the prompt to ChatGPT and Gemini in parallel.
 *  4. Send the full problem + both solutions to Claude for the final decision.
 *  5. Record everything on Drive:
 *       <batch>/AI_Review/                     ← CLIENT-SHARED (view) when the review completes
 *         01_Final_Decision_<ref>              (Google Doc — narrative + link to the Sheet)
 *         02_Vouching_Workpaper_<ref>          (Google Sheet — every table, one tab each, incl. Not Examined)
 *       <batch>/_internal/                     ← ADMIN ONLY, never shared
 *         Usage_Cost_<ref>                     (Google Sheet — tokens + USD per model)
 *         json/ prompt.json, input_manifest.json, health_check.json, chatgpt_response.json,
 *               gemini_response.json, claude_decision.json, pipeline_result.json
 *       Vouching/_data/Vouching_Cost_Ledger    (Google Sheet — one row per run, ADMIN ONLY)
 *  6. Share AI_Review with the requester and email them the Doc + Sheet links. Update the company registry.
 *     Cost / usage appears only in _internal, the ledger and the admin email — never in client outputs.
 *
 * MID-RUN MODEL FAILURE (071126)
 *  - Each call is retried for temporary errors (rate limit, provider error, dropped connection).
 *  - Credit / quota / key errors are NOT retried; an alert email goes out the moment it happens.
 *  - ChatGPT or Gemini fails  → the run continues; Claude decides with the remaining reviewer plus its own
 *    independent pass. Outputs say "Cross-check: 2 of 3 models".
 *  - Claude fails             → reviewer answers are already saved in _internal/json. The client is told the
 *    review is delayed; the admin email says how to resume. After topping up:
 *        POST /admin/rerun  {"reference":"AV-XXXXXX","resume":true}
 *    re-runs ONLY Claude, reusing the saved ChatGPT + Gemini answers (no second charge for them).
 *
 * COMPUTE (071126)
 *  - A file too big for the instance RAM (COMPUTE_RAM_MB) is skipped with "exceeds current compute capacity";
 *    the client email then says: "Contact AVAG: admin@avag.ai to allocate more resources for Compute."
 *  - If the instance is restarted mid-run (e.g. out of memory), recoverInterrupted() on the next start
 *    emails the client the same note and alerts the admin. Jobs that were only queued are re-queued.
 *
 * Live progress: every model's start/finish time is kept in memory and served by GET /api/progress/:ref
 * for the 3-pendulum page (public/progress.html).
 *
 * Jobs run one at a time (RAM). During a job the service pings itself so Render doesn't spin it down mid-run.
 */
const g = require('./google');
const llm = require('./llm');
const registry = require('./registry');
const { extractAll, manifest, isSupported } = require('./extract');
const { refineNotes, buildReviewerPrompt, buildJudgePrompt, PROMPT_VERSION } = require('./prompt-builder');
const { emailShell, buildWorkbook, buildCostWorkbook, finalDoc, esc, sevCounts, notExaminedHtml, notExaminedText, crossCheckText } = require('./report');
const { LIMITS, COMPUTE_NOTE, SUPPORT_EMAIL } = require('./limits');
const pricing = require('./pricing');
const ledger = require('./ledger');

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'agentic.avai@gmail.com';
const ALERT_EMAIL = process.env.ALERT_EMAIL || 'agentic.avai@gmail.com';
const SUPPORT_CONTACT = process.env.SUPPORT_CONTACT || 'Krish +6597890305';
const SHARE_WITH_REQUESTER = process.env.SHARE_RESULTS_WITH_REQUESTER !== 'false';
// ALPHA TEST MODE (temporary, ON by default): result folders open to "anyone with the link".
// Set ALPHA_PUBLIC_LINKS=false on Render to return to verified-email-only sharing.
const ALPHA_PUBLIC = process.env.ALPHA_PUBLIC_LINKS !== 'false';
const ALPHA_ROLE = process.env.ALPHA_PUBLIC_ROLE === 'writer' ? 'writer' : 'reader';

/* ------------------------------------------------------------------ queue */

const queue = [];
let current = null;

function status() {
  return { running: current, queued: queue.map((c) => c.reference) };
}

/* --------------------------------------------------------------- progress */

// In-memory only (lost on restart). Holds the last 50 jobs.
const MODELS = ['ChatGPT', 'Gemini', 'Claude'];
const progress = new Map();
let latestRef = null;

function track(ref, patch) {
  const p = progress.get(ref) || { reference: ref, models: {} };
  Object.assign(p, patch, { updatedAt: Date.now() });
  progress.delete(ref);
  progress.set(ref, p);
  while (progress.size > 50) progress.delete(progress.keys().next().value);
  return p;
}

function markModel(ref, label, patch) {
  const p = progress.get(ref);
  if (!p) return;
  p.models[label] = { ...(p.models[label] || {}), ...patch };
  p.updatedAt = Date.now();
}

/**
 * Public view for the progress page — timings and status only, no client data.
 * phase: queued | preparing | health_check | running | finishing | completed | needs_attention | unavailable | failed
 */
function getProgress(ref) {
  const p = progress.get(ref || latestRef);
  if (!p) return null;
  const ids = llm.cfg();
  const modelId = { ChatGPT: ids.openai.model, Gemini: ids.gemini.model, Claude: ids.claude.model };
  return {
    reference: p.reference,
    phase: p.phase,
    queuedAt: p.queuedAt || null,
    startedAt: p.startedAt || null,
    finishedAt: p.finishedAt || null,
    queuePosition: queue.findIndex((c) => c.reference === p.reference) + 1 || null,
    crossCheck: p.crossCheck || null,
    models: MODELS.map((label) => ({
      label,
      model: p.models[label]?.model || modelId[label],
      endedAt: p.models[label]?.endedAt || null,
      ok: p.models[label]?.ok ?? null,
      reused: !!p.models[label]?.reused,
      note: p.models[label]?.note || null,
    })),
    serverNow: Date.now(),
  };
}

async function avatarVouching(context) {
  track(context.reference, { phase: 'queued', queuedAt: Date.now(), startedAt: null, finishedAt: null, models: {} });
  latestRef = context.reference;
  queue.push(context);
  console.log(`[avatar-vouching] queued ${context.reference}${context.resume ? ' (resume)' : ''} → ${context.drivePath} (queue ${queue.length})`);
  if (!current) drain();
  return { status: 'queued', reference: context.reference, resume: !!context.resume };
}

async function drain() {
  while (queue.length) {
    const ctx = queue.shift();
    current = ctx.reference;
    try {
      await runPipeline(ctx);
    } catch (e) {
      console.error(`[avatar-vouching] ${ctx.reference} crashed:`, e);
    }
    current = null;
  }
}

function keepAlive() {
  const base = process.env.RENDER_EXTERNAL_URL;
  if (!base || g.DEV) return () => {};
  const t = setInterval(() => fetch(`${base}/healthz`).catch(() => {}), 4 * 60e3);
  return () => clearInterval(t);
}

/* ----------------------------------------------------------------- inputs */

const ROLE_BY_FOLDER = { Ledger_Files: 'LEDGER', Output_Format_Sample: 'OUTPUT_FORMAT_SAMPLE', Linked_Files: 'LINKED_SUPPORTING' };
const ROLE_ORDER = { OUTPUT_FORMAT_SAMPLE: 0, LEDGER: 1, LINKED_SUPPORTING: 2, OTHER: 3 };

/** Options for g.inventoryLinks() — shared with server.js so the pre-check and the run agree. */
function linkInventoryOptions() {
  return {
    maxFiles: LIMITS.maxLinkFiles,
    maxBytes: LIMITS.maxLinkTotalMb * 1048576,
    maxDepth: LIMITS.maxLinkDepth,
    maxFileBytes: LIMITS.maxAiFileMb * 1048576,
    isSupported,
  };
}

/** Links to read live. Older submissions (before 071126) had their link copied into Linked_Files — not re-read. */
function linksOf(ctx) {
  if (Array.isArray(ctx.driveLinks)) return ctx.driveLinks.filter(Boolean);
  if (ctx.driveLink && !ctx.linkCopy) return [ctx.driveLink];
  return [];
}

/** Uploaded files (on our Drive) + linked files (read live). Returns {files, preSkipped, inventory}. */
async function collectInputs(ctx) {
  const tree = await g.listTree(ctx.batchFolderId);
  const stored = tree
    .filter((f) => !/^(AI_Review|_internal)/.test(f.path) && f.path !== 'submission_info.json')
    .map((f) => {
      const role = ROLE_BY_FOLDER[f.path.split('/')[0]] || 'OTHER';
      return { ...f, role, source: role === 'LINKED_SUPPORTING' ? 'link' : 'upload' };
    });

  const links = linksOf(ctx);
  const inventory = links.length ? await g.inventoryLinks(links, linkInventoryOptions()) : null;
  const linkErrors = inventory
    ? inventory.links.filter((l) => !l.ok).map((l) => ({ name: `Link${l.n} (${l.url})`, reason: l.error, source: 'link' }))
    : [];

  const files = [...stored, ...(inventory?.files || [])].sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role]);
  return { files, preSkipped: [...linkErrors, ...(inventory?.notExamined || [])], inventory };
}

/** Link summary safe to store: counts and errors only, no file contents. */
const inventorySummary = (inv) => inv && {
  totals: inv.totals,
  links: inv.links.map(({ n, url, ok, error, name, kind, files, folders, bytes, notExamined }) => ({ n, url, ok, error, name, kind, files, folders, bytes, notExamined })),
};

/* ------------------------------------------------------------- resume */

/**
 * Latest saved ChatGPT + Gemini answers for this batch (newest _internal* folder that has them).
 * Returns {from, chatgpt, gemini} or null.
 */
async function loadReviewerAnswers(batchFolderId) {
  const kids = await g.listChildren(batchFolderId);
  const internals = kids
    .filter((k) => k.mimeType === g.FOLDER_MIME && /^_internal/.test(k.name))
    .sort((a, b) => b.name.localeCompare(a.name)); // _internal_rerun_<newest> first, plain _internal last
  for (const f of internals) {
    const json = (await g.listChildren(f.id)).find((k) => k.name === 'json' && k.mimeType === g.FOLDER_MIME);
    if (!json) continue;
    const read = async (name) => {
      const id = await g.findFile(name, json.id);
      if (!id) return null;
      try { return JSON.parse(await g.readText(id)); } catch { return null; }
    };
    const chatgpt = await read('chatgpt_response.json');
    const gemini = await read('gemini_response.json');
    if (chatgpt || gemini) return { from: f.name, chatgpt, gemini };
  }
  return null;
}

/** Rebuilds a pipeline context from the registry + submission_info.json (admin rerun / recovery). */
async function loadContext(reference) {
  const sub = await registry.findSubmission(reference);
  if (!sub?.batchFolderId) { const e = new Error(`No submission ${reference} in registry.`); e.status = 404; throw e; }
  const infoId = await g.findFile('submission_info.json', sub.batchFolderId);
  if (!infoId) { const e = new Error('submission_info.json not found in batch folder.'); e.status = 404; throw e; }
  const record = JSON.parse(await g.readText(infoId));
  return {
    ...record,
    accKey: record.accKey || sub.accKey,
    custKey: record.custKey || sub.custKey,
    batchFolderId: sub.batchFolderId,
    batchFolderLink: sub.batchFolderLink || g.folderLink(sub.batchFolderId),
    customerFolderId: sub.customerFolderId,
  };
}

/* --------------------------------------------------------------- helpers */

/** Response JSON without the bulky raw text duplicated when parsed fine. */
function storable(r) {
  return { ...r, text: r.parsed ? undefined : r.text };
}

const sgStamp = () => new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Singapore' }).slice(0, 16).replace(' ', '_').replace(':', '');
const good = (r) => !!(r?.ok && r.parsed);
const isComputeError = (e) => !!(e?.compute || /allocation failed|out of memory|ENOMEM|heap limit|Invalid string length|Array buffer/i.test(String(e?.message || e)));

const computeHtml = `<div style="background:#fbeee9;border:1px solid #e3b5a8;border-radius:6px;padding:10px 14px;margin:12px 0;font-size:13px">
  <b>Compute capacity reached.</b> Contact AVAG: <a href="mailto:${esc(SUPPORT_EMAIL)}">${esc(SUPPORT_EMAIL)}</a> to allocate more resources for Compute.</div>`;

/**
 * Health check failed: alert Krish, tell the requester the system is unavailable.
 * Each email is sent independently so one failure doesn't block the other.
 */
async function notifyUnavailable(ctx, health) {
  const ref = ctx.reference;
  const rows = health.results.map((r) =>
    `<tr><td>${esc(r.label)}</td><td>${esc(r.model)}</td><td style="color:${r.ok ? '#1b7a3a' : '#a3271b'}"><b>${r.ok ? 'OK' : esc(llm.kindText(r.errorKind))}</b></td><td>${Math.round((r.ms || 0) / 100) / 10} s</td><td>${esc(r.error || '')}</td></tr>`).join('');
  const plain = health.results.map((r) => `${r.label} (${r.model}): ${r.ok ? 'OK' : `FAILED [${llm.kindText(r.errorKind)}] — ${r.error}`}`).join('\n');

  await g.sendMail({
    to: ALERT_EMAIL,
    subject: `[Vouching] HEALTH CHECK FAILED (${health.failed.join(', ')}) — ${ref}`,
    text: `Health check failed before the AI run. Nothing was sent to the models.\n\nReference: ${ref}\n${ctx.accountingCompany} → ${ctx.customerCompany} · ${ctx.email}\n\n${plain}\n\nBatch folder: ${ctx.batchFolderLink}\nClient was told the system is unavailable. Fix the issue, then re-run via POST /admin/rerun${ctx.resume ? ' {"resume":true}' : ''}.`,
    html: emailShell(`Health check failed — ${esc(ref)}`, `
      <p>${esc(ctx.accountingCompany)} → ${esc(ctx.customerCompany)} · ${esc(ctx.email)}</p>
      <table border="1" cellpadding="6" style="border-collapse:collapse;font-size:13px">
        <tr><th>Model</th><th>ID</th><th>Status</th><th>Time</th><th>Error</th></tr>${rows}</table>
      <p><a href="${esc(ctx.batchFolderLink)}">Batch folder</a></p>
      <p style="color:#a3271b"><b>Client was told the system is unavailable.</b> Nothing was sent to the models. Fix the issue, then re-run via POST /admin/rerun${ctx.resume ? ' with "resume":true' : ''}.</p>`),
  }).catch((e) => console.error(`[avatar-vouching] ${ref} alert email failed:`, e.message));

  await g.sendMail({
    to: ctx.email,
    subject: `Vouching — system unavailable now (${ref})`,
    text: `Thank you for your submission.\nReference: ${ref}\n\nThe vouching system is unavailable now, so your review could not start. Your submission is recorded safely.\n\nIf it is urgent, please contact ${SUPPORT_CONTACT} for follow-up.\n\nAvatar Agentic AI (AVAG.AI)`,
    html: emailShell(`System unavailable now — ${esc(ref)}`, `
      <p>Thank you for your submission (<b>${esc(ref)}</b>).</p>
      <p>The vouching system is unavailable now, so your review could not start. Your submission is recorded safely.</p>
      <p>If it is urgent, please contact <b>${esc(SUPPORT_CONTACT)}</b> for follow-up.</p>`),
  }).catch((e) => console.error(`[avatar-vouching] ${ref} unavailable email to requester failed:`, e.message));
}

/** Immediate alert when a model fails mid-run for a reason a human must fix (credit, quota, key). */
function alertModelFailure(ctx, r) {
  const kind = llm.kindText(r.errorKind);
  const next = r.label === 'Claude'
    ? `Claude is the final decision-maker. Top up / fix, then resume: POST /admin/rerun {"reference":"${ctx.reference}","resume":true} — this re-runs Claude only and reuses the saved ChatGPT + Gemini answers.`
    : `The run CONTINUES with the other models (cross-check 2 of 3). Top up / fix before the next run.`;
  return g.sendMail({
    to: ALERT_EMAIL,
    subject: `[Vouching] ${r.label} FAILED mid-run — ${kind} — ${ctx.reference}`,
    text: `${r.label} (${r.model}) failed during ${ctx.reference}.\nReason: ${kind}\nError: ${r.error}\n\n${next}\n\nBatch folder: ${ctx.batchFolderLink}`,
    html: emailShell(`${esc(r.label)} failed mid-run — ${esc(ctx.reference)}`, `
      <p><b>${esc(r.label)}</b> (${esc(r.model)}) — <b style="color:#a3271b">${esc(kind)}</b></p>
      <pre style="font-size:11px;white-space:pre-wrap">${esc(r.error)}</pre>
      <p>${esc(next)}</p>
      <p><a href="${esc(ctx.batchFolderLink)}">Batch folder</a></p>`),
  }).catch((e) => console.error(`[avatar-vouching] ${ctx.reference} model alert failed:`, e.message));
}

/* ---------------------------------------------------------------- pipeline */

async function runPipeline(ctx) {
  const stop = keepAlive();
  const t0 = Date.now();
  const ref = ctx.reference;
  const log = (m) => console.log(`[avatar-vouching] ${ref} ${m}`);
  const setStatus = (patch) => registry.updateSubmission(ctx.accKey, ctx.custKey, ref, patch)
    .catch((e) => console.error('registry update failed:', e.message));

  track(ref, { phase: 'preparing' });
  let heartbeat = null;
  let computeLimited = false;

  try {
    await setStatus({ status: 'processing', processingStartedAt: new Date().toISOString() });

    // Folders. AI_Review is shared with the client; _internal (json + cost) is admin-only.
    const suffix = ctx.rerun ? `_${ctx.resume ? 'resume' : 'rerun'}_${sgStamp()}` : '';
    // Resume: read the earlier reviewer answers BEFORE creating this run's own _internal folder.
    let prior = null;
    if (ctx.resume) {
      prior = await loadReviewerAnswers(ctx.batchFolderId);
      if (!prior) throw new Error('Nothing to resume — no saved ChatGPT/Gemini answers found. Run a full rerun (without "resume").');
      log(`resume: reusing reviewer answers from ${prior.from}`);
    }
    const reviewFolder = await g.createFolder(`AI_Review${suffix}`, ctx.batchFolderId);
    if (ALPHA_PUBLIC) {
      // Also covers re-runs of older submissions whose parent folders were created before alpha mode.
      const r = await g.shareWithAnyone(reviewFolder, ALPHA_ROLE);
      if (!r.ok) console.error(`[avatar-vouching] ${ref} alpha public share failed:`, r.error);
    }
    const internalFolder = await g.createFolder(`_internal${suffix}`, ctx.batchFolderId);
    const jsonFolder = await g.createFolder('json', internalFolder);
    const save = (name, obj) => g.uploadText(name, JSON.stringify(obj, null, 2), jsonFolder);

    // 1. Inputs — uploaded files from our Drive; linked files read live into memory (never stored)
    const { files, preSkipped, inventory } = await collectInputs(ctx);
    log(`extracting ${files.length} file(s)${inventory ? ` (${inventory.totals.files} from ${inventory.totals.okLinks}/${inventory.totals.links} link(s))` : ''}; ${preSkipped.length} not examined up front`);
    const ex = await extractAll(files, preSkipped);
    computeLimited = ex.totals.computeLimited;
    const man = manifest(ex);
    await save('input_manifest.json', { ...man, linkInventory: inventorySummary(inventory) });
    if (!ex.documents.length && !ex.attachments.length) {
      const e = new Error(computeLimited ? 'No file could be examined within the current compute capacity.' : 'No readable files in the submission.');
      e.compute = computeLimited;
      e.clientSafe = true;
      throw e;
    }

    // 2. Prompt
    const refined = refineNotes(ctx.notes);
    const reviewerPrompt = buildReviewerPrompt({ ctx, refined, ex });
    await save('prompt.json', {
      promptVersion: PROMPT_VERSION,
      refinedNotes: refined,
      reviewer: { system: reviewerPrompt.system, user: reviewerPrompt.user },
      attachments: man.attachments,
    });

    // 2b. Health check — "Hi" before the big blast (resume: Claude only)
    track(ref, { phase: 'health_check' });
    const pingLabels = ctx.resume ? ['Claude'] : MODELS;
    log(`health check: "Hi" to ${pingLabels.join(', ')}`);
    const health = await llm.preflight(pingLabels);
    await save('health_check.json', health);
    log(`health check ${health.ok ? 'OK' : `FAILED: ${health.failed.join(', ')}`}`);
    if (!health.ok) {
      track(ref, { phase: 'unavailable', finishedAt: Date.now() });
      await setStatus({ status: 'unavailable', healthCheck: { checkedAt: health.checkedAt, failed: health.failed } });
      await notifyUnavailable(ctx, health);
      return { reference: ref, status: 'unavailable', healthCheck: health };
    }

    // 3. ChatGPT + Gemini in parallel (or reused on resume). One shared start time for all three timers.
    const startedAt = Date.now();
    track(ref, { phase: 'running', startedAt });
    const since = () => { const s = Math.round((Date.now() - startedAt) / 1000); return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`; };
    // Each model is logged the moment it finishes, and the progress page timer for it stops.
    const timed = (label, promise) => promise.then((r) => {
      const ok = good(r);
      const note = !r.ok ? `${llm.kindText(r.errorKind)} — ${r.error}` : !r.parsed ? `not valid JSON (finish: ${r.finish || 'n/a'})` : r.finish || null;
      markModel(ref, label, { endedAt: Date.now(), ok, model: r.model, note: note ? String(note).slice(0, 200) : null });
      log(`${label} ${ok ? 'ok' : r.ok ? 'INCOMPLETE' : `FAILED [${r.errorKind}]`} at ${since()}${note && !ok ? ` — ${String(note).slice(0, 160)}` : ''}`);
      if (!r.ok && ['billing', 'auth'].includes(r.errorKind)) alertModelFailure(ctx, r);
      return r;
    });
    // Heartbeat so the Render log is never silent for long.
    heartbeat = setInterval(() => {
      const p = progress.get(ref);
      const waiting = MODELS.filter((m) => !p?.models[m]?.endedAt);
      if (waiting.length) log(`still working at ${since()}: ${waiting.join(', ')}`);
    }, 5 * 60e3);

    let chatgpt;
    let gemini;
    if (ctx.resume) {
      const reuse = (label, r) => {
        const out = r
          ? { ...r, label, reused: true, reusedFrom: prior.from }
          : { label, model: '', ok: false, error: `no saved answer in ${prior.from}`, errorKind: 'output', reused: true, reusedFrom: prior.from };
        markModel(ref, label, { endedAt: startedAt, ok: good(out), model: out.model, reused: true, note: `reused from ${prior.from}` });
        return out;
      };
      chatgpt = reuse('ChatGPT', prior.chatgpt);
      gemini = reuse('Gemini', prior.gemini);
    } else {
      log('sending to ChatGPT + Gemini');
      [chatgpt, gemini] = await Promise.all([
        timed('ChatGPT', llm.ask('ChatGPT', { ...reviewerPrompt, attachments: ex.attachments })),
        timed('Gemini', llm.ask('Gemini', { ...reviewerPrompt, attachments: ex.attachments })),
      ]);
    }
    await save('chatgpt_response.json', storable(chatgpt));
    await save('gemini_response.json', storable(gemini));

    // 4. Claude final decision (problem + both solutions)
    log('sending problem + solutions to Claude');
    const judgePrompt = buildJudgePrompt({ ctx, refined, ex, chatgpt, gemini });
    const claude = await timed('Claude', llm.ask('Claude', { ...judgePrompt, attachments: ex.attachments }));
    clearInterval(heartbeat);
    await save('claude_decision.json', { ...storable(claude), judgePrompt: { system: judgePrompt.system, userChars: judgePrompt.user.length } });

    const crossCheck = {
      used: [chatgpt, gemini, claude].filter(good).length,
      of: 3,
      missing: [chatgpt, gemini].filter((r) => !good(r)).map((r) => r.label),
    };
    track(ref, { phase: 'finishing', crossCheck });

    // 5. Outputs. Client: short Doc + workpaper Sheet (AI_Review). Admin: cost Sheet (_internal) + ledger.
    const meta = { promptVersion: PROMPT_VERSION, manifest: man, crossCheck };
    const timings = (() => {
      const p = progress.get(ref);
      const sec = (m) => (p?.models[m]?.endedAt ? Math.round((p.models[m].endedAt - startedAt) / 100) / 10 : null);
      return { startedAt: new Date(startedAt).toISOString(), chatgptSec: sec('ChatGPT'), geminiSec: sec('Gemini'), claudeSec: sec('Claude') };
    })();
    const cost = pricing.summarise([chatgpt, gemini, claude]);
    const sheet = await g.createGoogleSheet(`02_Vouching_Workpaper_${ref}`, buildWorkbook(ctx, { chatgpt, gemini, claude, meta, timings }), reviewFolder);
    const doc = await g.createGoogleDoc(`01_Final_Decision_${ref}`, finalDoc(ctx, { chatgpt, gemini, claude, sheetLink: sheet.link, meta }), reviewFolder);
    const reviewLink = g.folderLink(reviewFolder);

    // 6. Share + results
    const final = good(claude) ? claude.parsed : null;
    const complete = !!final;
    const status = complete ? 'completed' : 'needs_attention';
    const costSheet = await g.createGoogleSheet(`Usage_Cost_${ref}${suffix}`, buildCostWorkbook(ctx, { cost, timings, status, links: { sheet: sheet.link, doc: doc.link } }), internalFolder)
      .catch((e) => { console.error(`[avatar-vouching] ${ref} cost sheet failed:`, e.message); return { link: null }; });
    const led = await ledger.appendRun(ctx, { cost, status, durationSec: Math.round((Date.now() - t0) / 1000), links: { costSheet: costSheet.link, sheet: sheet.link, doc: doc.link } })
      .catch((e) => { console.error(`[avatar-vouching] ${ref} ledger update failed:`, e.message); return { link: null }; });
    const share = complete && SHARE_WITH_REQUESTER ? await g.shareWithUser(reviewFolder, ctx.email) : { ok: false, skipped: true };
    const counts = final ? sevCounts(final.final_findings) : null;
    const result = {
      reference: ref,
      status,
      resume: !!ctx.resume,
      completedAt: new Date().toISOString(),
      durationSec: Math.round((Date.now() - t0) / 1000),
      promptVersion: PROMPT_VERSION,
      models: { chatgpt: chatgpt.model, gemini: gemini.model, claude: claude.model },
      timings,
      crossCheck,
      outcome: {
        chatgpt: { ok: chatgpt.ok, error: chatgpt.error || null, errorKind: chatgpt.errorKind || null, parsed: !!chatgpt.parsed, reused: !!chatgpt.reused, findings: chatgpt.parsed?.findings?.length ?? null },
        gemini: { ok: gemini.ok, error: gemini.error || null, errorKind: gemini.errorKind || null, parsed: !!gemini.parsed, reused: !!gemini.reused, findings: gemini.parsed?.findings?.length ?? null },
        claude: { ok: claude.ok, error: claude.error || null, errorKind: claude.errorKind || null, parsed: !!claude.parsed, findings: final?.final_findings?.length ?? null },
      },
      inputs: { files: ex.totals.files, examined: ex.documents.length + ex.attachments.length, notExamined: ex.skipped.length, computeLimited },
      riskRating: final?.overall_conclusion?.risk_rating || null,
      severityCounts: counts,
      docs: { final: doc.link, workpaper: sheet.link, folder: reviewLink },
      admin: { costUsd: cost.totalUsd, costSheet: costSheet.link, ledger: led.link, internalFolder: g.folderLink(internalFolder) },
      sharedWithRequester: share,
    };
    await save('pipeline_result.json', result); // lives in _internal/json — admin only
    await setStatus({
      status: result.status,
      review: { completedAt: result.completedAt, finalDocLink: doc.link, workpaperLink: sheet.link, folderLink: reviewLink, riskRating: result.riskRating, findings: result.outcome.claude.findings, models: result.models, crossCheck, notExamined: ex.skipped.length },
    });

    // 7. Emails. Client email never mentions cost.
    const ccText = crossCheckText(crossCheck);
    const degraded = crossCheck.missing.length > 0;
    const computeText = computeLimited ? `\n\nCompute capacity reached: some files could not be examined. ${COMPUTE_NOTE}` : '';
    if (complete) {
      // Access note: results are shared (view + download, no editing) with the verified email ONLY.
      const access = ALPHA_PUBLIC
        ? `<div style="background:#fff8e1;border:1px solid #e6c200;border-radius:6px;padding:10px 14px;margin:12px 0;font-size:13px">
            <b>Alpha test:</b> these links open without a Google account or sign-in. Please do not forward them.</div>`
        : share.ok
        ? `<div style="background:#fff8e1;border:1px solid #e6c200;border-radius:6px;padding:10px 14px;margin:12px 0;font-size:13px">
            <b>Access:</b> these documents are shared with <b>${esc(ctx.email)}</b> only (view &amp; download, no online editing).
            Sign in to Google with this exact email. If it is not yet a Google account, link a free one to it at
            <a href="https://accounts.google.com/signup">accounts.google.com/signup</a> (choose "Use my current email address instead").
            Forwarded links will not open for any other address.</div>`
        : '<p>If the links ask for access, reply to this email and we will share them with you.</p>';
      const accessText = ALPHA_PUBLIC
        ? 'Alpha test: these links open without a Google account or sign-in. Please do not forward them.'
        : share.ok
        ? `Access: shared with ${ctx.email} only (view & download, no online editing). Sign in to Google with this exact email. Not a Google account yet? Link a free one to it at https://accounts.google.com/signup ("Use my current email address instead"). Forwarded links will not open for any other address.`
        : 'If the links ask for access, reply to this email and we will share them with you.';
      const btn = (href, label) => `<a href="${esc(href)}" style="display:inline-block;background:#3d2314;color:#FFD700;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:bold;margin:0 8px 8px 0">${label}</a>`;
      await g.sendMail({
        to: ctx.email,
        subject: `Vouching review ready — ${ref} (${ctx.customerCompany})`,
        text: `Your vouching review is complete.\nReference: ${ref}\nOverall risk: ${result.riskRating}\nFinal findings: ${result.outcome.claude.findings}\n${ccText}${degraded ? ' — Claude made its own independent pass in place of the missing reviewer.' : ''}\n\nFinal decision (Doc): ${doc.link}\nWorkpaper with all tables (Sheet): ${sheet.link}\nReview folder: ${reviewLink}\n${notExaminedText(ex.skipped)}${computeText}\n\n${accessText}\n\nAI-generated working paper — to be reviewed by a qualified auditor before reliance.`,
        html: emailShell(`Vouching review ready — ${esc(ref)}`, `
          <p>${esc(ctx.accountingCompany)} → <b>${esc(ctx.customerCompany)}</b></p>
          <p><b>Overall risk:</b> ${esc(result.riskRating || '—')}<br>
          <b>Final findings:</b> ${result.outcome.claude.findings} (High ${counts.High}, Medium ${counts.Medium}, Low ${counts.Low})<br>
          <b>${esc(ccText)}</b>${degraded ? ' — Claude made its own independent pass in place of the missing reviewer.' : ''}</p>
          <p>${btn(doc.link, 'Open final decision')}${btn(sheet.link, 'Open workpaper (Sheet)')}</p>
          <p style="font-size:13px">The workpaper holds every table — findings, working paper, reviewer comparison, client questions and files not examined — ready to filter, update and export to Excel.</p>
          <p style="font-size:13px"><a href="${esc(reviewLink)}">Review folder</a></p>
          ${notExaminedHtml(ex.skipped)}
          ${computeLimited ? computeHtml : ''}
          ${access}
          <p style="color:#6b4a35;font-size:12px">AI-generated working paper — to be reviewed by a qualified auditor before reliance.</p>`),
      });
    } else {
      // Claude (final decision) did not complete — tell the client it is delayed, not failed.
      await g.sendMail({
        to: ctx.email,
        subject: `Vouching review delayed — ${ref}`,
        text: `Your vouching review (${ref}) is taking longer than expected. The final decision step could not finish on this attempt.\nOur team has been alerted and will complete it; you will receive the results by email.${computeText}\n\nIf it is urgent, please contact ${SUPPORT_CONTACT}.\n\nAvatar Agentic AI (AVAG.AI)`,
        html: emailShell(`Vouching review delayed — ${esc(ref)}`, `
          <p>Your vouching review (<b>${esc(ref)}</b>) is taking longer than expected. The final decision step could not finish on this attempt.</p>
          <p>Our team has been alerted and will complete it. You will receive the results by email.</p>
          ${computeLimited ? computeHtml : ''}
          <p>If it is urgent, please contact <b>${esc(SUPPORT_CONTACT)}</b>.</p>`),
      }).catch((e) => console.error(`[avatar-vouching] ${ref} delayed email failed:`, e.message));
    }
    const costRows = cost.rows.map((r) => `<tr><td>${esc(r.label)}</td><td>${esc(r.model)}</td><td align="right">${r.input.toLocaleString()}</td><td align="right">${r.output.toLocaleString()}</td><td align="right">${r.usd == null ? '—' : r.usd.toFixed(2)}</td></tr>`).join('');
    const resumeHint = `POST /admin/rerun {"reference":"${ref}","resume":true}  — re-runs Claude only, reuses the saved ChatGPT + Gemini answers.`;
    await g.sendMail({
      to: ADMIN_EMAIL,
      subject: `[Vouching] ${complete ? (degraded ? 'DONE (2 of 3)' : 'DONE') : 'NEEDS ATTENTION'} ${ctx.accKey}/${ctx.custKey} — ${ref} — USD ${cost.totalUsd.toFixed(2)}`,
      text: `${complete ? '' : `Claude did not complete: ${claude.error || 'invalid JSON'}\nClient was told the review is delayed.\nResume after fixing: ${resumeHint}\n\n`}${notExaminedText(ex.skipped, 100)}\n${JSON.stringify(result, null, 2)}`,
      html: emailShell(`${complete ? 'Review complete' : 'Review needs attention'} — ${esc(ref)}`, `
        <p>${esc(ctx.accountingCompany)} → ${esc(ctx.customerCompany)} · ${esc(ctx.email)}</p>
        <p><a href="${esc(doc.link)}">Final decision</a> · <a href="${esc(sheet.link)}">Workpaper</a> · <a href="${esc(reviewLink)}">AI_Review folder</a></p>
        <p><b>${esc(ccText)}</b>${ctx.resume ? ' · resume run' : ''}</p>
        ${complete ? '' : `<p style="color:#a3271b"><b>Claude did not complete</b> (${esc(llm.kindText(claude.errorKind))}). Client was told the review is DELAYED.<br>
          Fix the cause, then resume:<br><code>${esc(resumeHint)}</code></p>`}
        ${computeLimited ? `<p style="color:#a3271b"><b>Compute capacity reached</b> — files were skipped (COMPUTE_RAM_MB=${LIMITS.computeRamMb}). Consider a larger Render instance.</p>` : ''}
        ${notExaminedHtml(ex.skipped, 50)}
        <p><b>Estimated LLM cost (admin only)</b></p>
        <table border="1" cellpadding="5" style="border-collapse:collapse;font-size:12px">
          <tr><th>Model</th><th>ID</th><th>In</th><th>Out</th><th>USD</th></tr>${costRows}
          <tr><td colspan="4"><b>Total</b></td><td align="right"><b>${cost.totalUsd.toFixed(2)}</b></td></tr></table>
        <p style="font-size:12px">${costSheet.link ? `<a href="${esc(costSheet.link)}">Usage_Cost sheet</a>` : 'Cost sheet not created'} · ${led.link ? `<a href="${esc(led.link)}">Cost ledger</a>` : 'Ledger not updated'}</p>
        <pre style="font-size:11px;white-space:pre-wrap">${esc(JSON.stringify(result, null, 2))}</pre>`),
    });
    track(ref, { phase: result.status, finishedAt: Date.now() });
    log(`${result.status} in ${result.durationSec} s (${ccText}; not examined ${ex.skipped.length})`);
    return result;
  } catch (e) {
    console.error(`[avatar-vouching] ${ref} failed:`, e);
    const compute = isComputeError(e) || computeLimited;
    track(ref, { phase: 'failed', finishedAt: Date.now() });
    await setStatus({ status: 'failed', error: e.message, compute });
    await g.sendMail({
      to: ADMIN_EMAIL,
      subject: `[Vouching] FAILED${compute ? ' (COMPUTE)' : ''} ${ctx.accKey}/${ctx.custKey} — ${ref}`,
      text: `${e.stack || e.message}\n\nFolder: ${ctx.batchFolderLink}${compute ? `\n\nCompute-related (COMPUTE_RAM_MB=${LIMITS.computeRamMb}). Client was emailed the compute note.` : ''}`,
      html: emailShell(`Review failed — ${esc(ref)}`, `<p>${esc(e.message)}</p>${compute ? `<p style="color:#a3271b"><b>Compute-related</b> (COMPUTE_RAM_MB=${LIMITS.computeRamMb}). Client was emailed the compute note.</p>` : ''}<p><a href="${esc(ctx.batchFolderLink)}">Batch folder</a></p><p>Re-run via POST /admin/rerun once fixed.</p>`),
    }).catch(() => {});
    if (compute || e.clientSafe) {
      await g.sendMail({
        to: ctx.email,
        subject: `Vouching review could not be completed — ${ref}`,
        text: `Your vouching review (${ref}) could not be completed: ${e.clientSafe ? e.message : 'the data set needs more processing capacity than is currently allocated.'}\n\n${compute ? COMPUTE_NOTE : `Please contact ${SUPPORT_CONTACT}.`}\n\nAvatar Agentic AI (AVAG.AI)`,
        html: emailShell(`Review could not be completed — ${esc(ref)}`, `
          <p>Your vouching review (<b>${esc(ref)}</b>) could not be completed: ${esc(e.clientSafe ? e.message : 'the data set needs more processing capacity than is currently allocated.')}</p>
          ${compute ? computeHtml : `<p>Please contact <b>${esc(SUPPORT_CONTACT)}</b>.</p>`}`),
      }).catch(() => {});
    }
    return { status: 'failed', error: e.message, compute };
  } finally {
    clearInterval(heartbeat);
    stop();
  }
}

/* --------------------------------------------------- restart recovery */

/**
 * Called once at start-up. After a restart nothing is running, so a submission still marked
 *   "received"   → was queued but never started  → re-queued automatically;
 *   "processing" → was cut off mid-run (most often: the instance ran out of memory)
 *                  → marked "interrupted", client gets the compute note, admin is alerted.
 * RECOVER_INTERRUPTED=false turns this off.
 */
async function recoverInterrupted() {
  if (process.env.RECOVER_INTERRUPTED === 'false') return;
  let subs;
  try {
    subs = await registry.findInFlight(24);
  } catch (e) {
    console.error('[avatar-vouching] recovery scan failed:', e.message);
    return;
  }
  for (const s of subs) {
    try {
      if (s.status === 'received') {
        const ctx = await loadContext(s.reference);
        console.log(`[avatar-vouching] recovery: re-queueing ${s.reference} (was queued before restart)`);
        avatarVouching(ctx);
        continue;
      }
      console.log(`[avatar-vouching] recovery: ${s.reference} was interrupted mid-run`);
      await registry.updateSubmission(s.accKey, s.custKey, s.reference, { status: 'interrupted', interruptedDetectedAt: new Date().toISOString() });
      await g.sendMail({
        to: s.email,
        subject: `Vouching review interrupted — ${s.reference}`,
        text: `Your vouching review (${s.reference}) was interrupted before it could finish. This usually means the data set needs more processing capacity than is currently allocated.\n\n${COMPUTE_NOTE}\n\nAvatar Agentic AI (AVAG.AI)`,
        html: emailShell(`Review interrupted — ${esc(s.reference)}`, `
          <p>Your vouching review (<b>${esc(s.reference)}</b>) was interrupted before it could finish.
          This usually means the data set needs more processing capacity than is currently allocated.</p>${computeHtml}`),
      }).catch((e) => console.error('recovery client email failed:', e.message));
      await g.sendMail({
        to: ADMIN_EMAIL,
        subject: `[Vouching] INTERRUPTED (restart mid-run) ${s.accKey}/${s.custKey} — ${s.reference}`,
        text: `${s.reference} was "processing" when the service restarted (likely out of memory; COMPUTE_RAM_MB=${LIMITS.computeRamMb}).\nClient was emailed the compute note.\nFolder: ${s.batchFolderLink}\nRe-run: POST /admin/rerun {"reference":"${s.reference}"} (add "resume":true if ChatGPT + Gemini had already finished).`,
        html: emailShell(`Interrupted — ${esc(s.reference)}`, `<p>${esc(s.reference)} was <b>processing</b> when the service restarted (likely out of memory; COMPUTE_RAM_MB=${LIMITS.computeRamMb}).</p>
          <p>Client was emailed the compute note.</p><p><a href="${esc(s.batchFolderLink)}">Batch folder</a></p>
          <p>Re-run: <code>POST /admin/rerun {"reference":"${esc(s.reference)}"}</code> — add <code>"resume":true</code> if ChatGPT + Gemini had already finished.</p>`),
      }).catch(() => {});
    } catch (e) {
      console.error(`[avatar-vouching] recovery of ${s.reference} failed:`, e.message);
    }
  }
}

module.exports = { avatarVouching, runPipeline, status, getProgress, loadContext, recoverInterrupted, linkInventoryOptions };
