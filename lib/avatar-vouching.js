// Version :021126 14:50
// File    :lib/avatar-vouching.js
/**
 * avatarVouching(context) — the AI review stage. Runs once per submission, after files are stored on Drive.
 *
 *  1. Collect every stored file (Ledger_Files, Output_Format_Sample, Linked_Files) and extract LLM-ready text.
 *  2. Refine the client's Notes into structured instructions and build the engineered prompt.
 *  3. Send the prompt to ChatGPT and Gemini in parallel.
 *  4. Send the full problem + both solutions to Claude for the final decision.
 *  5. Record everything on Drive:
 *       <batch>/AI_Review/
 *         01_ChatGPT_Findings_<ref>        (Google Doc)
 *         02_Gemini_Findings_<ref>         (Google Doc)
 *         03_Claude_Final_Decision_<ref>   (Google Doc)
 *         json/ prompt.json, input_manifest.json, chatgpt_response.json, gemini_response.json,
 *               claude_decision.json, pipeline_result.json
 *  6. Share AI_Review with the requester and email them the link. Update the company registry.
 *
 * Jobs run one at a time (RAM on Render free tier). During a job the service pings itself so Render
 * doesn't spin it down mid-run.
 */
const g = require('./google');
const llm = require('./llm');
const registry = require('./registry');
const { extractAll, manifest } = require('./extract');
const { refineNotes, buildReviewerPrompt, buildJudgePrompt, PROMPT_VERSION } = require('./prompt-builder');
const { emailShell, reviewerDoc, finalDoc, esc, sevCounts } = require('./report');

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'agentic.avai@gmail.com';
const SHARE_WITH_REQUESTER = process.env.SHARE_RESULTS_WITH_REQUESTER !== 'false';

/* ------------------------------------------------------------------ queue */

const queue = [];
let current = null;

function status() {
  return { running: current, queued: queue.map((c) => c.reference) };
}

async function avatarVouching(context) {
  queue.push(context);
  console.log(`[avatar-vouching] queued ${context.reference} → ${context.drivePath} (queue ${queue.length})`);
  if (!current) drain();
  return { status: 'queued', reference: context.reference };
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

/* --------------------------------------------------------------- helpers */

const ROLE_BY_FOLDER = { Ledger_Files: 'LEDGER', Output_Format_Sample: 'OUTPUT_FORMAT_SAMPLE', Linked_Files: 'LINKED_SUPPORTING' };
const ROLE_ORDER = { OUTPUT_FORMAT_SAMPLE: 0, LEDGER: 1, LINKED_SUPPORTING: 2, OTHER: 3 };

async function collectInputFiles(batchFolderId) {
  const tree = await g.listTree(batchFolderId);
  return tree
    .filter((f) => !/^AI_Review/.test(f.path) && f.path !== 'submission_info.json')
    .map((f) => ({ ...f, role: ROLE_BY_FOLDER[f.path.split('/')[0]] || 'OTHER' }))
    .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role]);
}

/** Response JSON without the bulky raw text duplicated when parsed fine. */
function storable(r) {
  return { ...r, text: r.parsed ? undefined : r.text };
}

const sgStamp = () => new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Singapore' }).slice(0, 16).replace(' ', '_').replace(':', '');

/* ---------------------------------------------------------------- pipeline */

async function runPipeline(ctx) {
  const stop = keepAlive();
  const t0 = Date.now();
  const ref = ctx.reference;
  const log = (m) => console.log(`[avatar-vouching] ${ref} ${m}`);
  const setStatus = (patch) => registry.updateSubmission(ctx.accKey, ctx.custKey, ref, patch)
    .catch((e) => console.error('registry update failed:', e.message));

  try {
    await setStatus({ status: 'processing', processingStartedAt: new Date().toISOString() });

    // Folders
    const reviewFolder = await g.createFolder(ctx.rerun ? `AI_Review_rerun_${sgStamp()}` : 'AI_Review', ctx.batchFolderId);
    const jsonFolder = await g.createFolder('json', reviewFolder);
    const save = (name, obj) => g.uploadText(name, JSON.stringify(obj, null, 2), jsonFolder);

    // 1. Inputs
    const files = await collectInputFiles(ctx.batchFolderId);
    log(`extracting ${files.length} file(s)`);
    const ex = await extractAll(files);
    const man = manifest(ex);
    await save('input_manifest.json', man);
    if (!ex.documents.length && !ex.attachments.length) throw new Error('No readable files in the submission.');

    // 2. Prompt
    const refined = refineNotes(ctx.notes);
    const reviewerPrompt = buildReviewerPrompt({ ctx, refined, ex });
    await save('prompt.json', {
      promptVersion: PROMPT_VERSION,
      refinedNotes: refined,
      reviewer: { system: reviewerPrompt.system, user: reviewerPrompt.user },
      attachments: man.attachments,
    });

    // 3. ChatGPT + Gemini in parallel
    log('sending to ChatGPT + Gemini');
    const [chatgpt, gemini] = await Promise.all([
      llm.ask('ChatGPT', { ...reviewerPrompt, attachments: ex.attachments }),
      llm.ask('Gemini', { ...reviewerPrompt, attachments: ex.attachments }),
    ]);
    log(`ChatGPT ${chatgpt.ok ? 'ok' : 'FAILED'} (${Math.round(chatgpt.ms / 1000)} s), Gemini ${gemini.ok ? 'ok' : 'FAILED'} (${Math.round(gemini.ms / 1000)} s)`);
    await save('chatgpt_response.json', storable(chatgpt));
    await save('gemini_response.json', storable(gemini));

    // 4. Claude final decision (problem + both solutions)
    log('sending problem + solutions to Claude');
    const judgePrompt = buildJudgePrompt({ ctx, refined, ex, chatgpt, gemini });
    const claude = await llm.ask('Claude', { ...judgePrompt, attachments: ex.attachments });
    log(`Claude ${claude.ok ? 'ok' : 'FAILED'} (${Math.round(claude.ms / 1000)} s)`);
    await save('claude_decision.json', { ...storable(claude), judgePrompt: { system: judgePrompt.system, userChars: judgePrompt.user.length } });

    // 5. Google Docs set
    const meta = { promptVersion: PROMPT_VERSION, manifest: man };
    const d1 = await g.createGoogleDoc(`01_ChatGPT_Findings_${ref}`, reviewerDoc(ctx, chatgpt, meta), reviewFolder);
    const d2 = await g.createGoogleDoc(`02_Gemini_Findings_${ref}`, reviewerDoc(ctx, gemini, meta), reviewFolder);
    const d3 = await g.createGoogleDoc(
      `03_Claude_Final_Decision_${ref}`,
      finalDoc(ctx, { chatgpt, gemini, claude, links: { chatgpt: d1.link, gemini: d2.link }, meta }),
      reviewFolder
    );
    const reviewLink = g.folderLink(reviewFolder);

    // 6. Share + results
    const final = claude.ok && claude.parsed ? claude.parsed : null;
    const complete = !!final;
    const share = complete && SHARE_WITH_REQUESTER ? await g.shareWithUser(reviewFolder, ctx.email) : { ok: false, skipped: true };
    const counts = final ? sevCounts(final.final_findings) : null;
    const result = {
      reference: ref,
      status: complete ? 'completed' : 'needs_attention',
      completedAt: new Date().toISOString(),
      durationSec: Math.round((Date.now() - t0) / 1000),
      promptVersion: PROMPT_VERSION,
      models: { chatgpt: chatgpt.model, gemini: gemini.model, claude: claude.model },
      outcome: {
        chatgpt: { ok: chatgpt.ok, error: chatgpt.error || null, parsed: !!chatgpt.parsed, findings: chatgpt.parsed?.findings?.length ?? null },
        gemini: { ok: gemini.ok, error: gemini.error || null, parsed: !!gemini.parsed, findings: gemini.parsed?.findings?.length ?? null },
        claude: { ok: claude.ok, error: claude.error || null, parsed: !!claude.parsed, findings: final?.final_findings?.length ?? null },
      },
      riskRating: final?.overall_conclusion?.risk_rating || null,
      severityCounts: counts,
      docs: { chatgpt: d1.link, gemini: d2.link, final: d3.link, folder: reviewLink },
      sharedWithRequester: share,
    };
    await save('pipeline_result.json', result);
    await setStatus({
      status: result.status,
      review: { completedAt: result.completedAt, finalDocLink: d3.link, folderLink: reviewLink, riskRating: result.riskRating, findings: result.outcome.claude.findings, models: result.models },
    });

    // 7. Emails
    if (complete) {
      const access = share.ok
        ? '<p>The review folder has been shared with this email address — sign in with it to open the documents.</p>'
        : '<p>If the links ask for access, reply to this email and we will share them with you.</p>';
      await g.sendMail({
        to: ctx.email,
        subject: `Vouching review ready — ${ref} (${ctx.customerCompany})`,
        text: `Your vouching review is complete.\nReference: ${ref}\nOverall risk: ${result.riskRating}\nFinal findings: ${result.outcome.claude.findings}\n\nFinal decision: ${d3.link}\nAll review documents: ${reviewLink}`,
        html: emailShell(`Vouching review ready — ${esc(ref)}`, `
          <p>${esc(ctx.accountingCompany)} → <b>${esc(ctx.customerCompany)}</b></p>
          <p><b>Overall risk:</b> ${esc(result.riskRating || '—')}<br>
          <b>Final findings:</b> ${result.outcome.claude.findings} (High ${counts.High}, Medium ${counts.Medium}, Low ${counts.Low})</p>
          <p><a href="${esc(d3.link)}" style="background:#3d2314;color:#FFD700;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:bold">Open final decision</a></p>
          <p>Supporting reviews: <a href="${esc(d1.link)}">ChatGPT findings</a> · <a href="${esc(d2.link)}">Gemini findings</a> · <a href="${esc(reviewLink)}">All documents</a></p>
          ${access}
          <p style="color:#6b4a35;font-size:12px">AI-generated working paper — to be reviewed by a qualified auditor before reliance.</p>`),
      });
    }
    await g.sendMail({
      to: ADMIN_EMAIL,
      subject: `[Vouching] ${complete ? 'DONE' : 'NEEDS ATTENTION'} ${ctx.accKey}/${ctx.custKey} — ${ref}`,
      text: `${JSON.stringify(result, null, 2)}`,
      html: emailShell(`${complete ? 'Review complete' : 'Review needs attention'} — ${esc(ref)}`, `
        <p>${esc(ctx.accountingCompany)} → ${esc(ctx.customerCompany)} · ${esc(ctx.email)}</p>
        <p><a href="${esc(d3.link)}">Final decision</a> · <a href="${esc(reviewLink)}">AI_Review folder</a></p>
        ${complete ? '' : '<p style="color:#a3271b"><b>Client was NOT emailed.</b> Fix the issue and re-run via POST /admin/rerun.</p>'}
        <pre style="font-size:11px;white-space:pre-wrap">${esc(JSON.stringify(result, null, 2))}</pre>`),
    });
    log(`${result.status} in ${result.durationSec} s`);
    return result;
  } catch (e) {
    console.error(`[avatar-vouching] ${ref} failed:`, e);
    await setStatus({ status: 'failed', error: e.message });
    await g.sendMail({
      to: ADMIN_EMAIL,
      subject: `[Vouching] FAILED ${ctx.accKey}/${ctx.custKey} — ${ref}`,
      text: `${e.stack || e.message}\n\nFolder: ${ctx.batchFolderLink}`,
      html: emailShell(`Review failed — ${esc(ref)}`, `<p>${esc(e.message)}</p><p><a href="${esc(ctx.batchFolderLink)}">Batch folder</a></p><p>Re-run via POST /admin/rerun once fixed.</p>`),
    }).catch(() => {});
    return { status: 'failed', error: e.message };
  } finally {
    stop();
  }
}

module.exports = { avatarVouching, runPipeline, status };
