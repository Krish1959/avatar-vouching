// Version :111126  18:30
// File    :lib/report.js
/**
 * Output builders for one vouching run.
 *
 *  buildWorkbook()  -> .xlsx buffer, uploaded to Drive and converted to a Google Sheet
 *                      "02_Vouching_Workpaper_<ref>". Every table lives here, one tab each.
 *  finalDoc()       -> HTML, converted to a Google Doc "01_Final_Decision_<ref>".
 *                      Narrative only (decision, opinion, key concerns, top findings) + link to the Sheet.
 *  buildCostWorkbook() -> .xlsx for the ADMIN-ONLY "Usage_Cost_<ref>" Sheet (kept in <batch>/_internal,
 *                      never in the client-shared AI_Review folder). Cost/usage never appears in client outputs.
 *  emailShell()     -> AVAG.AI brown/gold email wrapper.
 *  notExaminedHtml() / notExaminedText() -> the "Not examined" list for client and admin emails.
 *  statementsInfo() -> status + client message for the optional financial statements (also used in emails).
 *
 * 071126: every file that was NOT examined is listed in the Doc, its own Sheet tab and the client email.
 * 111126:
 *  - Review scope (100% of data set / audit regulations) and coverage achieved shown in Summary, Doc and email.
 *  - Optional financial statements (requested in Notes):
 *        PREPARED          -> "Trial Balance" and/or "Balance Sheet" tabs + Doc section
 *        INSUFFICIENT_DATA -> "Financial Statements" tab listing the data to provide + re-run instruction
 *        not requested     -> NIL (no tab, no section)
 */
const XLSX = require('xlsx');

const BROWN = '#3d2314';
const GOLD = '#FFD700';
const SEV_COLOR = { High: '#a3271b', Medium: '#b8860b', Low: '#2f6b2f' };
const SEV_ORDER = { High: 0, Medium: 1, Low: 2 };
const SCOPE_LABEL = {
  full: 'Check on 100% of the data set',
  regulation: 'Check as per audit regulations — SSA 530 Audit Sampling (with SSA 500 and SSA 330)',
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const arr = (a) => (Array.isArray(a) ? a : a ? [a] : []);
/** Any value -> plain text for a cell or a paragraph. */
const txt = (v) => {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(txt).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};
const val = (v) => (v == null || v === '' ? '—' : esc(txt(v)));
const sgt = (iso) => new Date(iso || Date.now()).toLocaleString('en-SG', { timeZone: 'Asia/Singapore' }) + ' SGT';
const SOURCE_LABEL = { upload: 'Uploaded file', link: 'Shared link' };

function emailShell(title, inner) {
  return `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;border:1px solid #e8d4a8;border-radius:10px;overflow:hidden">
  <div style="background:${BROWN};padding:18px 22px;color:${GOLD};font-size:18px;font-weight:bold">Avatar Agentic AI, Singapore<br>
  <span style="font-size:12px;letter-spacing:3px;font-weight:normal">AVATAR VOUCHING AGENTIC AI</span></div>
  <div style="padding:22px;color:#3a2010;font-size:14px;line-height:1.6"><h3 style="margin-top:0">${title}</h3>${inner}</div>
  <div style="background:#2a1810;color:#b89a3a;font-size:11px;padding:10px 22px">© ${new Date().getFullYear()} Avatar Agentic AI Pte Ltd · Singapore</div></div>`;
}

function sevCounts(findings) {
  const c = { High: 0, Medium: 0, Low: 0 };
  arr(findings).forEach((f) => { if (c[f.severity] != null) c[f.severity]++; });
  return c;
}

const bySeverity = (a) => [...arr(a)].sort((x, y) => (SEV_ORDER[x.severity] ?? 9) - (SEV_ORDER[y.severity] ?? 9));

/* ================================================ SCOPE + COVERAGE TEXT */

/** "Check on 100% of the data set" etc. */
const scopeText = (mode) => SCOPE_LABEL[mode === 'regulation' ? 'regulation' : 'full'];

/** "175 of 175 ledger lines (100%)" from the final answer + the code check. */
function coverageText(j, qc) {
  const cv = j?.coverage || {};
  const total = qc?.linesTotal ?? cv.ledger_lines_total;
  const tested = qc?.linesTested ?? cv.lines_tested;
  if (total == null || total === '') return 'Not reported';
  const pct = qc?.pct != null ? ` (${qc.pct}%)` : '';
  const value = cv.value_tested && cv.value_total ? ` · value ${txt(cv.value_tested)} of ${txt(cv.value_total)}` : '';
  return `${txt(tested ?? '?')} of ${txt(total)} ledger lines${pct}${value}`;
}

/** Problems the code found in the final answer, for the auditor. Empty string when clean. */
const qcIssuesText = (qc) => (qc && !qc.ok ? arr(qc.issues).join(' ') : '');

/* =========================================== FINANCIAL STATEMENTS */

/**
 * Status + client message for the optional statements.
 * The Notes decide whether they were requested (meta.statements); the model decides PREPARED vs INSUFFICIENT_DATA.
 * @returns {status:'NOT_REQUESTED'|'PREPARED'|'INSUFFICIENT_DATA'|'NOT_PRODUCED', label, message, missing[]}
 */
function statementsInfo(j, req) {
  if (!req?.requested) return { status: 'NOT_REQUESTED', label: 'Not requested', message: '', missing: [] };
  const fs = j?.financial_statements || {};
  const status = String(fs.status || '').toUpperCase();
  const missing = arr(fs.missing_data).filter((m) => m && (m.item || m.why_needed));
  if (status === 'PREPARED') {
    return { status, label: `${req.label} — prepared`, message: `${req.label} prepared as at ${txt(fs.as_at) || 'period end'}. See the workpaper.`, missing: [] };
  }
  if (status === 'INSUFFICIENT_DATA') {
    const what = req.balanceSheet ? 'a proper balance sheet' : 'a proper trial balance';
    const list = missing.map((m) => txt(m.item)).filter(Boolean);
    return {
      status,
      label: `${req.label} — insufficient data`,
      message: `Insufficient data to create ${what}. Provide ${list.length ? list.join('; ') : 'the data listed in the workpaper'} and re-run the Vouching process in full.`,
      missing,
    };
  }
  return { status: 'NOT_PRODUCED', label: `${req.label} — not produced`, message: `${req.label} was requested but could not be produced on this run. Our team will review it.`, missing: [] };
}

/* ======================================================= NOT EXAMINED */

/** "Cross-check: 3 of 3 models" text, or null when meta has no cross-check info. */
function crossCheckText(cc) {
  if (!cc) return null;
  return `Cross-check: ${cc.used} of ${cc.of} models${cc.missing?.length ? ` (${cc.missing.join(', ')} did not complete)` : ''}`;
}

/** HTML list for emails; long lists are cut with a pointer to the Sheet tab. */
function notExaminedHtml(list, max = 25) {
  const a = arr(list);
  if (!a.length) return '';
  const rows = a.slice(0, max).map((s) => `<li>${esc(s.name)} — <i>${esc(s.reason)}</i></li>`).join('');
  return `<div style="background:#fbeee9;border:1px solid #e3b5a8;border-radius:6px;padding:10px 14px;margin:12px 0;font-size:13px">
  <b>Not examined: ${a.length} file(s).</b> These were not reviewed by the AI and are outside the scope of the results.
  <ul style="margin:6px 0 0;padding-left:18px">${rows}</ul>
  ${a.length > max ? `<p style="margin:6px 0 0">…and ${a.length - max} more — full list in the <b>Not Examined</b> tab of the workpaper.</p>` : ''}</div>`;
}

function notExaminedText(list, max = 25) {
  const a = arr(list);
  if (!a.length) return '';
  return `\nNOT EXAMINED: ${a.length} file(s) — outside the scope of the results:\n${a.slice(0, max).map((s) => `  - ${s.name} — ${s.reason}`).join('\n')}${a.length > max ? `\n  …and ${a.length - max} more (see the Not Examined tab of the workpaper)` : ''}\n`;
}

/* ================================================================ SHEET */

/** The tab names, in order. Kept short (Sheets allows 31 chars). Statement tabs appear only when relevant. */
const TABS = {
  summary: 'Summary',
  final: 'Final Findings',
  working: 'Working Paper',
  trialBalance: 'Trial Balance',
  balanceSheet: 'Balance Sheet',
  statements: 'Financial Statements',
  comparison: 'Reviewer Comparison',
  chatgpt: 'ChatGPT Findings',
  gemini: 'Gemini Findings',
  rejected: 'Rejected Findings',
  todo: 'Questions & Review',
  notExamined: 'Not Examined',
};

/** Tabs actually present for this run (statement tabs depend on the outcome). */
function tabsFor(fsInfo, req) {
  return Object.entries(TABS).filter(([k]) => {
    if (k === 'trialBalance') return fsInfo.status === 'PREPARED' && req?.trialBalance;
    if (k === 'balanceSheet') return fsInfo.status === 'PREPARED' && req?.balanceSheet;
    if (k === 'statements') return ['INSUFFICIENT_DATA', 'NOT_PRODUCED'].includes(fsInfo.status);
    return true;
  }).map(([, v]) => v);
}

const FINDING_COLS = ['Severity', 'Category', 'File', 'Location', 'Date', 'Account', 'Counterparty', 'Description', 'Amount', 'Issue', 'Evidence', 'Recommendation', 'Document required'];
const findingCells = (f) => [f.severity, f.category, f.file, f.location, f.date, f.account, f.counterparty, f.description, f.amount, f.issue, f.evidence, f.recommendation, f.supporting_document_required].map(txt);

/** Adds a tab with sensible column widths and a frozen header row. */
function addTab(wb, name, aoa, widths) {
  const ws = XLSX.utils.aoa_to_sheet(aoa.length ? aoa : [['(empty)']]);
  const cols = (aoa[0] || []).length;
  ws['!cols'] = Array.from({ length: cols }, (_, i) => ({ wch: widths?.[i] ?? 18 }));
  ws['!autofilter'] = aoa.length > 1 && cols > 1 ? { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: aoa.length - 1, c: cols - 1 } }) } : undefined;
  if (!ws['!autofilter']) delete ws['!autofilter'];
  XLSX.utils.book_append_sheet(wb, ws, name);
}

const unavailable = (r, what) => [['Status'], [r?.ok ? `${what}: response was not valid JSON (finish: ${r.finish || 'n/a'}). Raw output is kept by AVAG.AI for review.` : `${what}: not available — ${r?.error || 'no response'}`]];

function reviewerTab(r) {
  const j = r?.ok ? r.parsed : null;
  if (!j) return unavailable(r, `${r?.label || 'Reviewer'} (${r?.model || ''})`);
  return [
    ['ID', ...FINDING_COLS],
    ...bySeverity(j.findings).map((f) => [txt(f.id), ...findingCells(f)]),
  ];
}

function notExaminedTab(skipped) {
  const a = arr(skipped);
  return [
    ['#', 'File', 'Source', 'Reason not examined', 'Auditor action'],
    ...a.map((s, i) => [i + 1, txt(s.name), SOURCE_LABEL[s.source] || txt(s.source || ''), txt(s.reason), '']),
    ...(a.length ? [] : [['—', 'All submitted files were examined.', '', '', '']]),
  ];
}

function trialBalanceTab(fs) {
  const tb = fs.trial_balance || {};
  const cols = arr(tb.columns).length ? arr(tb.columns).map(txt) : ['Account code', 'Account name', 'Debit', 'Credit'];
  return [
    cols,
    ...arr(tb.rows).map((r) => arr(r).map(txt)),
    [],
    ['', 'TOTAL', txt(tb.total_debit), txt(tb.total_credit)],
    ['', 'Balanced', tb.balanced === false ? 'NO' : 'Yes', ''],
    [],
    ['As at', txt(fs.as_at)],
    ['Basis', txt(fs.basis)],
    ...arr(fs.assumptions).map((a, i) => [i ? '' : 'Assumptions', txt(a)]),
  ];
}

function balanceSheetTab(fs) {
  const bs = fs.balance_sheet || {};
  const out = [['Section / line', 'Amount']];
  for (const s of arr(bs.sections)) {
    out.push([txt(s.heading).toUpperCase(), '']);
    arr(s.lines).forEach((l) => out.push([`   ${txt(arr(l)[0])}`, txt(arr(l)[1])]));
    out.push([`Total ${txt(s.heading).toLowerCase()}`, txt(s.total)]);
    out.push(['', '']);
  }
  out.push(['TOTAL ASSETS', txt(bs.total_assets)]);
  out.push(['TOTAL LIABILITIES', txt(bs.total_liabilities)]);
  out.push(['TOTAL EQUITY', txt(bs.total_equity)]);
  out.push(['Balanced (assets = liabilities + equity)', bs.balanced === false ? 'NO' : 'Yes']);
  out.push(['', '']);
  out.push(['As at', txt(fs.as_at)]);
  out.push(['Basis', txt(fs.basis)]);
  arr(fs.assumptions).forEach((a, i) => out.push([i ? '' : 'Assumptions', txt(a)]));
  return out;
}

function statementsGapTab(info) {
  return [
    ['#', 'Data to provide', 'Why it is needed', 'Example'],
    ...info.missing.map((m, i) => [i + 1, txt(m.item), txt(m.why_needed), txt(m.example)]),
    ...(info.missing.length ? [] : [['—', 'See message below', '', '']]),
    [],
    ['', info.message, '', ''],
  ];
}

/**
 * @returns Buffer (.xlsx) — Drive converts it to a native Google Sheet on upload.
 */
function buildWorkbook(ctx, { chatgpt, gemini, claude, meta, timings }) {
  const j = claude?.ok ? claude.parsed : null;
  const wb = XLSX.utils.book_new();
  const counts = j ? sevCounts(j.final_findings) : null;
  const skipped = arr(meta?.manifest?.skipped);
  const fsInfo = statementsInfo(j, meta?.statements);
  const qcFinal = meta?.qc?.claude;

  // 1. Summary
  const s = [
    ['Item', 'Detail'],
    ['Reference', ctx.reference],
    ['Accounting firm', ctx.accountingCompany],
    ['Customer company', ctx.customerCompany],
    ['Requested by', ctx.email],
    ['Submitted', sgt(ctx.submittedAt)],
    ['Drive folder', ctx.batchFolderLink || ctx.drivePath],
    ['', ''],
    ['Review scope', scopeText(meta?.coverage)],
    ['Coverage achieved', j ? coverageText(j, qcFinal) : 'Not available'],
    ['Coverage check', qcFinal ? (qcFinal.ok ? 'Passed' : `Attention: ${qcIssuesText(qcFinal)}`) : ''],
    ['Ledger reconciliation', txt(j?.coverage?.reconciliation)],
    ['Overall risk', txt(j?.overall_conclusion?.risk_rating) || 'Not available'],
    ['Final findings', j ? `${arr(j.final_findings).length} (High ${counts.High}, Medium ${counts.Medium}, Low ${counts.Low})` : 'Not available'],
    ['Materiality', j ? `${txt(j.materiality?.amount)} — ${txt(j.materiality?.basis)}` : ''],
    ['Financial statements', fsInfo.status === 'NOT_REQUESTED' ? 'Not requested (NIL). To request, write e.g. "Create a Balance Sheet" in the Notes.' : `${fsInfo.label}${fsInfo.message ? ` — ${fsInfo.message}` : ''}`],
    ['Decision summary', txt(j?.decision_summary)],
    ['Opinion', txt(j?.overall_conclusion?.opinion)],
    ['', ''],
    ['Reviewer A', `ChatGPT ${chatgpt?.model || ''} — ${chatgpt?.parsed ? `${arr(chatgpt.parsed.findings).length} findings · ${coverageText(chatgpt.parsed, meta?.qc?.chatgpt)}` : chatgpt?.error || 'no structured output'}`],
    ['Reviewer B', `Gemini ${gemini?.model || ''} — ${gemini?.parsed ? `${arr(gemini.parsed.findings).length} findings · ${coverageText(gemini.parsed, meta?.qc?.gemini)}` : gemini?.error || 'no structured output'}`],
    ['Final decision', `Claude ${claude?.model || ''}`],
    ['Cross-check', crossCheckText(meta?.crossCheck) || ''],
    ['Run time (from start of AI review)', timings ? `ChatGPT ${timings.chatgptSec ?? '—'} s · Gemini ${timings.geminiSec ?? '—'} s · Claude ${timings.claudeSec ?? '—'} s` : ''],
    ['Prompt version', meta?.promptVersion || ''],
    ['', ''],
    ['Files not examined', skipped.length ? `${skipped.length} — see the "${TABS.notExamined}" tab. These are outside the scope of this review.` : 'None — all submitted files were examined.'],
    ['Tabs in this workbook', tabsFor(fsInfo, meta?.statements).join(' · ')],
    ['Note', 'AI-generated working paper. It must be reviewed and signed off by a qualified auditor before reliance.'],
  ];
  addTab(wb, TABS.summary, s, [34, 120]);

  // 2. Final Findings (+ columns for the auditor)
  addTab(wb, TABS.final, j ? [
    ['ID', 'Verdict', 'Found by', 'Source IDs', ...FINDING_COLS, 'Rationale', 'Client response', 'Status', 'Cleared by', 'Date cleared'],
    ...bySeverity(j.final_findings).map((f) => [txt(f.id), txt(f.verdict), txt(f.found_by), txt(f.source_ids), ...findingCells(f), txt(f.rationale), '', 'Open', '', '']),
  ] : unavailable(claude, 'Final decision'),
  [7, 14, 18, 12, 9, 22, 28, 30, 14, 16, 22, 30, 22, 50, 60, 45, 35, 40, 30, 10, 14, 12]);

  // 3. Working Paper (client format) — one row per ledger line in 100% mode
  const cfo = j?.client_format_output;
  const wpCols = arr(cfo?.columns).map(txt);
  addTab(wb, TABS.working, j && wpCols.length
    ? [wpCols, ...arr(cfo.rows).map((r) => arr(r).map(txt))]
    : unavailable(claude, 'Working paper'),
  wpCols.map((c) => (/remark|description/i.test(c) ? 50 : /amount/i.test(c) ? 22 : /line id/i.test(c) ? 10 : 16)));

  // 4. Financial statements — only when requested (NIL otherwise)
  if (fsInfo.status === 'PREPARED') {
    if (meta?.statements?.trialBalance) addTab(wb, TABS.trialBalance, trialBalanceTab(j.financial_statements), [16, 45, 18, 18]);
    if (meta?.statements?.balanceSheet) addTab(wb, TABS.balanceSheet, balanceSheetTab(j.financial_statements), [55, 22]);
  } else if (['INSUFFICIENT_DATA', 'NOT_PRODUCED'].includes(fsInfo.status)) {
    addTab(wb, TABS.statements, statementsGapTab(fsInfo), [5, 55, 55, 60]);
  }

  // 5. Reviewer Comparison
  if (j) {
    const c = j.comparison || {};
    addTab(wb, TABS.comparison, [
      ['Section', 'Topic', 'ChatGPT (Reviewer A)', 'Gemini (Reviewer B)', 'Resolution / detail'],
      ['Summary', 'What each reviewer found', txt(c.chatgpt_found), txt(c.gemini_found), ''],
      ['Quality', 'Assessment of each review', txt(c.chatgpt_quality), txt(c.gemini_quality), ''],
      ['Coverage', 'Code check of each review', meta?.qc?.chatgpt ? (meta.qc.chatgpt.ok ? 'Passed' : qcIssuesText(meta.qc.chatgpt)) : '—', meta?.qc?.gemini ? (meta.qc.gemini.ok ? 'Passed' : qcIssuesText(meta.qc.gemini)) : '—', ''],
      ...arr(c.agreement_points).map((p) => ['Agreement', txt(p), '✓', '✓', '']),
      ...arr(c.disagreements).map((d) => ['Disagreement', txt(d.topic), txt(d.chatgpt), txt(d.gemini), txt(d.resolution)]),
    ], [14, 40, 50, 50, 60]);
  } else {
    addTab(wb, TABS.comparison, unavailable(claude, 'Comparison'), [100]);
  }

  // 6-7. Raw reviewer findings (audit trail)
  addTab(wb, TABS.chatgpt, reviewerTab(chatgpt), [6, 9, 22, 28, 30, 14, 16, 22, 30, 22, 50, 60, 45, 35]);
  addTab(wb, TABS.gemini, reviewerTab(gemini), [6, 9, 22, 28, 30, 14, 16, 22, 30, 22, 50, 60, 45, 35]);

  // 8. Rejected
  addTab(wb, TABS.rejected, j ? [
    ['Source ID', 'Reviewer', 'Finding', 'Reason rejected'],
    ...arr(j.rejected_findings).map((x) => [txt(x.source_id), txt(x.reviewer), txt(x.summary), txt(x.reason)]),
    ...(arr(j.rejected_findings).length ? [] : [['—', '—', 'No reviewer findings were rejected.', '']]),
  ] : unavailable(claude, 'Rejected findings'), [12, 12, 60, 60]);

  // 9. Questions & human review — checklists
  addTab(wb, TABS.todo, j ? [
    ['Type', '#', 'Item', 'Owner', 'Done', 'Notes'],
    ...arr(j.questions_for_client).map((q, i) => ['Question for client', i + 1, txt(q), 'Client', '', '']),
    ...arr(j.items_for_human_review).map((q, i) => ['Human review', i + 1, txt(q), 'Auditor', '', '']),
    ...(qcFinal && !qcFinal.ok ? [['Human review', '—', `Coverage check: ${qcIssuesText(qcFinal)}`, 'Auditor', '', '']] : []),
    ...arr(j.limitations).map((q, i) => ['Limitation', i + 1, txt(q), '', '', '']),
  ] : unavailable(claude, 'Questions'), [20, 5, 90, 10, 8, 30]);

  // 10. Not Examined — always present, so the auditor can see scope at a glance
  addTab(wb, TABS.notExamined, notExaminedTab(skipped), [5, 70, 16, 60, 30]);

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/* ============================================== ADMIN-ONLY COST SHEET */

/** Usage & cost for one run. Stored in <batch>/_internal — NOT shared with the client. */
function buildCostWorkbook(ctx, { cost, timings, status, links, qc }) {
  const wb = XLSX.utils.book_new();
  addTab(wb, 'Usage & Cost', [
    ['Model role', 'Model', 'Input tokens', 'Output tokens (incl. reasoning)', 'of which reasoning', 'USD / 1M input', 'USD / 1M output', 'Est. cost (USD)', 'Note'],
    ...cost.rows.map((r) => [r.label, r.model, r.input, r.output, r.reasoning, r.rateIn ?? '', r.rateOut ?? '', r.usd ?? '', r.note]),
    ['TOTAL', '', cost.totalInput, cost.totalOutput, '', '', '', cost.totalUsd, cost.complete ? 'Estimate from list prices; provider dashboards are the final authority' : 'Incomplete — a model has no rate set'],
    [],
    ['ADMIN ONLY — do not share with the client.'],
  ], [12, 24, 14, 26, 18, 14, 14, 15, 60]);
  const q = (k) => (qc?.[k] ? `${qc[k].ok ? 'PASS' : 'ATTENTION'} — ${qc[k].linesTested ?? '?'}/${qc[k].linesTotal ?? '?'} lines, ${qc[k].rows} rows${qc[k].ok ? '' : ` — ${qc[k].issues.join(' ')}`}` : '—');
  addTab(wb, 'Run', [
    ['Item', 'Detail'],
    ['Reference', ctx.reference],
    ['Accounting firm', ctx.accountingCompany],
    ['Customer company', ctx.customerCompany],
    ['Requested by', ctx.email],
    ['Submitted', sgt(ctx.submittedAt)],
    ['Review scope', scopeText(ctx.coverage)],
    ['Status', status || ''],
    ['AI review started', timings?.startedAt ? sgt(timings.startedAt) : ''],
    ['ChatGPT time (s)', timings?.chatgptSec ?? ''],
    ['Gemini time (s)', timings?.geminiSec ?? ''],
    ['Claude time (s)', timings?.claudeSec ?? ''],
    ['ChatGPT coverage check', q('chatgpt')],
    ['Gemini coverage check', q('gemini')],
    ['Claude coverage check', q('claude')],
    ['Workpaper (client)', links?.sheet || ''],
    ['Final decision (client)', links?.doc || ''],
    ['Billed to client (SGD)', ''],
    ['Invoice no.', ''],
  ], [26, 100]);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/* ================================================================== DOC */

const H = (n, t) => `<h${n} style="color:${BROWN}">${esc(t)}</h${n}>`;
const P = (t) => `<p>${esc(txt(t))}</p>`;
const UL = (items) => {
  const a = arr(items).filter((x) => x !== '' && x != null);
  return a.length ? `<ul>${a.map((x) => `<li>${val(x)}</li>`).join('')}</ul>` : '<p>—</p>';
};
const sev = (s) => `<b style="color:${SEV_COLOR[s] || '#333'}">${esc(s || '—')}</b>`;

function table(headers, rows) {
  if (!rows.length) return '<p>None.</p>';
  const th = headers.map((h) => `<th style="background:${BROWN};color:${GOLD};padding:4px;text-align:left">${esc(h)}</th>`).join('');
  const tr = rows.map((r) => `<tr>${r.map((c) => `<td style="padding:4px;vertical-align:top">${c}</td>`).join('')}</tr>`).join('');
  return `<table border="1" cellspacing="0" cellpadding="4" style="border-collapse:collapse;width:100%;font-size:9pt">${th ? `<tr>${th}</tr>` : ''}${tr}</table>`;
}
const kv = (pairs) => table(['Item', 'Detail'], pairs.map(([k, v]) => [`<b>${esc(k)}</b>`, v]));

function banner(title, subtitle) {
  return `<table border="0" cellspacing="0" cellpadding="10" style="width:100%"><tr><td style="background:${BROWN};color:${GOLD}">
  <span style="font-size:16pt;font-weight:bold">${esc(title)}</span><br>
  <span style="font-size:9pt;letter-spacing:2px">AVATAR VOUCHING AGENTIC AI · AVAG.AI · ${esc(subtitle)}</span></td></tr></table>`;
}

function engagement(ctx) {
  return kv([
    ['Reference', val(ctx.reference)],
    ['Accounting firm', val(ctx.accountingCompany)],
    ['Customer company', val(ctx.customerCompany)],
    ['Requested by', val(ctx.email)],
    ['Submitted', val(sgt(ctx.submittedAt))],
    ['Review scope', val(scopeText(ctx.coverage))],
    ['Drive folder', ctx.batchFolderLink ? `<a href="${esc(ctx.batchFolderLink)}">${esc(ctx.drivePath)}</a>` : val(ctx.drivePath)],
  ]);
}

function sheetBox(link, tabs) {
  if (!link) return '';
  return `<table border="0" cellspacing="0" cellpadding="10" style="width:100%"><tr><td style="background:#f7edd8;border-left:6px solid ${BROWN}">
  <b>All tables are in the workpaper spreadsheet:</b> <a href="${esc(link)}">Open the Vouching Workpaper (Google Sheet)</a><br>
  <span style="font-size:9pt">Tabs: ${tabs.map(esc).join(' · ')}</span></td></tr></table>`;
}

function crossCheckBox(cc) {
  const t = crossCheckText(cc);
  if (!t || !cc.missing?.length) return '';
  return `<p style="color:#a3271b"><b>${esc(t)}.</b> The final decision was made on a reduced cross-check; Claude performed its own independent pass in place of the missing reviewer.</p>`;
}

/** "Files not examined" section — shown in every Doc, success or provisional. */
function notExaminedSection(skipped) {
  const a = arr(skipped);
  if (!a.length) return `${H(3, 'Files not examined')}<p>None — all submitted files were examined.</p>`;
  const rows = a.slice(0, 60).map((s) => [val(s.name), val(SOURCE_LABEL[s.source] || s.source), val(s.reason)]);
  return `${H(2, `Files not examined (${a.length})`)}
  <p style="color:#a3271b"><b>These files were not reviewed by the AI and are outside the scope of this decision.</b></p>
  ${table(['File', 'Source', 'Reason'], rows)}
  ${a.length > 60 ? `<p style="font-size:9pt">…and ${a.length - 60} more — full list in the <i>${TABS.notExamined}</i> tab of the spreadsheet.</p>` : ''}`;
}

/** Financial statements section — NIL (empty) when not requested. */
function statementsSection(j, req) {
  const info = statementsInfo(j, req);
  if (info.status === 'NOT_REQUESTED') return '';
  if (info.status === 'PREPARED') {
    const fs = j.financial_statements || {};
    const bs = fs.balance_sheet || {};
    const tb = fs.trial_balance || {};
    const rows = [];
    if (req.trialBalance) rows.push(['Trial balance', `Debits ${val(tb.total_debit)} · Credits ${val(tb.total_credit)} · ${tb.balanced === false ? '<b style="color:#a3271b">NOT balanced</b>' : 'Balanced'}`]);
    if (req.balanceSheet) rows.push(['Balance sheet', `Assets ${val(bs.total_assets)} · Liabilities ${val(bs.total_liabilities)} · Equity ${val(bs.total_equity)} · ${bs.balanced === false ? '<b style="color:#a3271b">NOT balanced</b>' : 'Balanced'}`]);
    rows.push(['As at', val(fs.as_at)], ['Basis', val(fs.basis)]);
    return `${H(2, 'Financial statements')}${kv(rows)}${arr(fs.assumptions).length ? `${H(3, 'Assumptions')}${UL(fs.assumptions)}` : ''}
    <p style="font-size:9pt">Full statements: <i>${req.trialBalance ? TABS.trialBalance : ''}${req.trialBalance && req.balanceSheet ? '</i> and <i>' : ''}${req.balanceSheet ? TABS.balanceSheet : ''}</i> tab(s) of the spreadsheet.</p>`;
  }
  const rows = info.missing.map((m) => [val(m.item), val(m.why_needed), val(m.example)]);
  return `${H(2, 'Financial statements')}
  <p style="color:#a3271b"><b>${esc(info.message)}</b></p>
  ${rows.length ? table(['Data to provide', 'Why it is needed', 'Example'], rows) : ''}`;
}

function reviewerLine(r, claudeText, qc) {
  if (r?.reused) return `${claudeText ? P(claudeText) : ''}<p style="font-size:9pt">(Reviewer answer reused from the earlier run ${esc(r.reusedFrom || '')}.)</p>${r.parsed ? reviewerLine({ ...r, reused: false }, null, qc) : ''}`;
  if (!r?.ok) return `<p><b>Did not complete:</b> ${esc(r?.error || 'no response')}</p>`;
  if (!r.parsed) return `<p>Response was not valid JSON (finish: ${esc(r.finish || 'n/a')}). Raw output is kept by AVAG.AI for review.</p>`;
  const c = sevCounts(r.parsed.findings);
  return `${claudeText ? P(claudeText) : ''}<p><b>Risk rating:</b> ${sev(r.parsed.overall_assessment?.risk_rating)} · <b>Findings:</b> ${arr(r.parsed.findings).length} (High ${c.High}, Medium ${c.Medium}, Low ${c.Low}) · <b>Coverage:</b> ${esc(coverageText(r.parsed, qc))}</p>`;
}

function footer(lines) {
  return `<hr><p style="font-size:8pt;color:#6b4a35">${lines.map(esc).join('<br>')}<br>
  AI-generated working paper. It must be reviewed and signed off by a qualified auditor before reliance.</p>`;
}

/** Short narrative Google Doc. Tables live in the Sheet. */
function finalDoc(ctx, { chatgpt, gemini, claude, sheetLink, meta }) {
  const head = banner(`Final Vouching Decision — ${ctx.reference}`, `Decision by Claude · ${claude?.model || ''}`);
  const j = claude?.ok ? claude.parsed : null;
  const skipped = arr(meta?.manifest?.skipped);
  const fsInfo = statementsInfo(j, meta?.statements);
  const tabs = tabsFor(fsInfo, meta?.statements);
  const qcFinal = meta?.qc?.claude;

  if (!j) {
    const why = !claude?.ok ? esc(claude?.error || 'no response') : `the response was not valid JSON (finish: ${esc(claude.finish || 'n/a')})`;
    return `<html><body>${head}${engagement(ctx)}
    <p style="color:#a3271b"><b>PROVISIONAL — the final decision could not be produced: ${why}. Our team has been alerted.</b></p>
    ${sheetBox(sheetLink, tabs)}
    ${H(2, `Reviewer A — ChatGPT (${chatgpt?.model || ''})`)}${reviewerLine(chatgpt, null, meta?.qc?.chatgpt)}
    ${H(2, `Reviewer B — Gemini (${gemini?.model || ''})`)}${reviewerLine(gemini, null, meta?.qc?.gemini)}
    ${notExaminedSection(skipped)}
    ${footer([`Prompt: ${meta?.promptVersion || ''} · Generated ${new Date().toISOString()}`])}</body></html>`;
  }

  const c = sevCounts(j.final_findings);
  const top = bySeverity(j.final_findings).filter((f) => f.severity === 'High').slice(0, 8);
  const topRows = top.map((f) => [val(f.id), sev(f.severity), val(f.category), val(f.description || f.issue), val(f.amount)]);
  const files = meta?.manifest ? [
    ...arr(meta.manifest.documents).map((d) => [val(d.path), val(d.role), `text (${d.sentChars} chars${d.truncated ? ', truncated' : ''})`, val(d.note)]),
    ...arr(meta.manifest.attachments).map((a) => [val(a.path), val(a.role), 'native file', '']),
  ] : [];

  return `<html><body>${head}${engagement(ctx)}
  ${H(2, 'Final decision')}
  ${kv([
    ['Overall risk', sev(j.overall_conclusion?.risk_rating)],
    ['Final findings', `${arr(j.final_findings).length} (High ${c.High}, Medium ${c.Medium}, Low ${c.Low})`],
    ['Review scope', val(scopeText(meta?.coverage))],
    ['Coverage achieved', `${val(coverageText(j, qcFinal))}${qcFinal && !qcFinal.ok ? `<br><b style="color:#a3271b">Attention:</b> ${esc(qcIssuesText(qcFinal))}` : ''}`],
    ['Ledger reconciliation', val(j.coverage?.reconciliation)],
    ['Materiality', `${val(j.materiality?.amount)} — ${val(j.materiality?.basis)}`],
    ['Financial statements', esc(fsInfo.status === 'NOT_REQUESTED' ? 'Not requested' : fsInfo.label)],
    ['Cross-check', val(crossCheckText(meta?.crossCheck))],
    ['Files not examined', skipped.length ? `<b style="color:#a3271b">${skipped.length}</b> — see below` : 'None'],
  ])}
  ${crossCheckBox(meta?.crossCheck)}
  ${P(j.decision_summary)}
  ${sheetBox(sheetLink, tabs)}
  ${H(2, 'Opinion')}${P(j.overall_conclusion?.opinion)}
  ${H(3, 'Key concerns')}${UL(j.overall_conclusion?.key_concerns)}
  ${H(2, `High-severity findings${c.High > top.length ? ` (top ${top.length} of ${c.High})` : ''}`)}
  ${table(['ID', 'Severity', 'Category', 'Finding', 'Amount'], topRows)}
  <p style="font-size:9pt">Full details, evidence, recommendations and the line-by-line working paper are in the <i>Final Findings</i> and <i>Working Paper</i> tabs of the spreadsheet.</p>
  ${statementsSection(j, meta?.statements)}
  ${H(2, 'How the two reviews compared')}
  ${H(3, `Reviewer A — ChatGPT (${chatgpt?.model || ''})`)}${reviewerLine(chatgpt, j.comparison?.chatgpt_found, meta?.qc?.chatgpt)}
  ${H(3, `Reviewer B — Gemini (${gemini?.model || ''})`)}${reviewerLine(gemini, j.comparison?.gemini_found, meta?.qc?.gemini)}
  <p style="font-size:9pt">Agreements, disagreements and how each was resolved: <i>Reviewer Comparison</i> tab.</p>
  ${H(2, 'Limitations')}${UL(j.limitations)}
  ${notExaminedSection(skipped)}
  ${files.length ? `${H(3, 'Files analysed')}${table(['File', 'Role', 'Sent as', 'Note'], files)}` : ''}
  ${footer([
    `Reviewers: ChatGPT ${chatgpt?.model || ''}, Gemini ${gemini?.model || ''} · Final decision: Claude ${claude.model}`,
    `Prompt: ${meta?.promptVersion || ''} · Generated ${new Date().toISOString()}`,
  ])}
  </body></html>`;
}

module.exports = {
  esc, emailShell, sevCounts, buildWorkbook, buildCostWorkbook, finalDoc,
  notExaminedHtml, notExaminedText, crossCheckText, statementsInfo, scopeText, coverageText, qcIssuesText, TABS,
};
