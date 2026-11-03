// Version :031126 13:30
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
 */
const XLSX = require('xlsx');

const BROWN = '#3d2314';
const GOLD = '#FFD700';
const SEV_COLOR = { High: '#a3271b', Medium: '#b8860b', Low: '#2f6b2f' };
const SEV_ORDER = { High: 0, Medium: 1, Low: 2 };

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

/* ================================================================ SHEET */

/** The tab names, in order. Kept short (Sheets allows 31 chars). */
const TABS = {
  summary: 'Summary',
  final: 'Final Findings',
  working: 'Working Paper',
  comparison: 'Reviewer Comparison',
  chatgpt: 'ChatGPT Findings',
  gemini: 'Gemini Findings',
  rejected: 'Rejected Findings',
  todo: 'Questions & Review',
};

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

/**
 * @returns Buffer (.xlsx) — Drive converts it to a native Google Sheet on upload.
 */
function buildWorkbook(ctx, { chatgpt, gemini, claude, meta, timings }) {
  const j = claude?.ok ? claude.parsed : null;
  const wb = XLSX.utils.book_new();
  const counts = j ? sevCounts(j.final_findings) : null;

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
    ['Overall risk', txt(j?.overall_conclusion?.risk_rating) || 'Not available'],
    ['Final findings', j ? `${arr(j.final_findings).length} (High ${counts.High}, Medium ${counts.Medium}, Low ${counts.Low})` : 'Not available'],
    ['Materiality', j ? `${txt(j.materiality?.amount)} — ${txt(j.materiality?.basis)}` : ''],
    ['Decision summary', txt(j?.decision_summary)],
    ['Opinion', txt(j?.overall_conclusion?.opinion)],
    ['', ''],
    ['Reviewer A', `ChatGPT ${chatgpt?.model || ''} — ${chatgpt?.parsed ? `${arr(chatgpt.parsed.findings).length} findings` : chatgpt?.error || 'no structured output'}`],
    ['Reviewer B', `Gemini ${gemini?.model || ''} — ${gemini?.parsed ? `${arr(gemini.parsed.findings).length} findings` : gemini?.error || 'no structured output'}`],
    ['Final decision', `Claude ${claude?.model || ''}`],
    ['Run time (from start of AI review)', timings ? `ChatGPT ${timings.chatgptSec ?? '—'} s · Gemini ${timings.geminiSec ?? '—'} s · Claude ${timings.claudeSec ?? '—'} s` : ''],
    ['Prompt version', meta?.promptVersion || ''],
    ['', ''],
    ['Tabs in this workbook', Object.values(TABS).join(' · ')],
    ['Note', 'AI-generated working paper. It must be reviewed and signed off by a qualified auditor before reliance.'],
  ];
  addTab(wb, TABS.summary, s, [34, 120]);

  // 2. Final Findings (+ columns for the auditor)
  addTab(wb, TABS.final, j ? [
    ['ID', 'Verdict', 'Found by', 'Source IDs', ...FINDING_COLS, 'Rationale', 'Client response', 'Status', 'Cleared by', 'Date cleared'],
    ...bySeverity(j.final_findings).map((f) => [txt(f.id), txt(f.verdict), txt(f.found_by), txt(f.source_ids), ...findingCells(f), txt(f.rationale), '', 'Open', '', '']),
  ] : unavailable(claude, 'Final decision'),
  [7, 14, 18, 12, 9, 22, 28, 30, 14, 16, 22, 30, 22, 50, 60, 45, 35, 40, 30, 10, 14, 12]);

  // 3. Working Paper (client format)
  const cfo = j?.client_format_output;
  const wpCols = arr(cfo?.columns).map(txt);
  addTab(wb, TABS.working, j && wpCols.length
    ? [wpCols, ...arr(cfo.rows).map((r) => arr(r).map(txt))]
    : unavailable(claude, 'Working paper'),
  wpCols.map((c) => (/remark|description/i.test(c) ? 50 : /amount/i.test(c) ? 22 : 16)));

  // 4. Reviewer Comparison
  if (j) {
    const c = j.comparison || {};
    addTab(wb, TABS.comparison, [
      ['Section', 'Topic', 'ChatGPT (Reviewer A)', 'Gemini (Reviewer B)', 'Resolution / detail'],
      ['Summary', 'What each reviewer found', txt(c.chatgpt_found), txt(c.gemini_found), ''],
      ['Quality', 'Assessment of each review', txt(c.chatgpt_quality), txt(c.gemini_quality), ''],
      ...arr(c.agreement_points).map((p) => ['Agreement', txt(p), '✓', '✓', '']),
      ...arr(c.disagreements).map((d) => ['Disagreement', txt(d.topic), txt(d.chatgpt), txt(d.gemini), txt(d.resolution)]),
    ], [14, 40, 50, 50, 60]);
  } else {
    addTab(wb, TABS.comparison, unavailable(claude, 'Comparison'), [100]);
  }

  // 5-6. Raw reviewer findings (audit trail)
  addTab(wb, TABS.chatgpt, reviewerTab(chatgpt), [6, 9, 22, 28, 30, 14, 16, 22, 30, 22, 50, 60, 45, 35]);
  addTab(wb, TABS.gemini, reviewerTab(gemini), [6, 9, 22, 28, 30, 14, 16, 22, 30, 22, 50, 60, 45, 35]);

  // 7. Rejected
  addTab(wb, TABS.rejected, j ? [
    ['Source ID', 'Reviewer', 'Finding', 'Reason rejected'],
    ...arr(j.rejected_findings).map((x) => [txt(x.source_id), txt(x.reviewer), txt(x.summary), txt(x.reason)]),
    ...(arr(j.rejected_findings).length ? [] : [['—', '—', 'No reviewer findings were rejected.', '']]),
  ] : unavailable(claude, 'Rejected findings'), [12, 12, 60, 60]);

  // 8. Questions & human review — checklists
  addTab(wb, TABS.todo, j ? [
    ['Type', '#', 'Item', 'Owner', 'Done', 'Notes'],
    ...arr(j.questions_for_client).map((q, i) => ['Question for client', i + 1, txt(q), 'Client', '', '']),
    ...arr(j.items_for_human_review).map((q, i) => ['Human review', i + 1, txt(q), 'Auditor', '', '']),
    ...arr(j.limitations).map((q, i) => ['Limitation', i + 1, txt(q), '', '', '']),
  ] : unavailable(claude, 'Questions'), [20, 5, 90, 10, 8, 30]);

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/* ============================================== ADMIN-ONLY COST SHEET */

/** Usage & cost for one run. Stored in <batch>/_internal — NOT shared with the client. */
function buildCostWorkbook(ctx, { cost, timings, status, links }) {
  const wb = XLSX.utils.book_new();
  addTab(wb, 'Usage & Cost', [
    ['Model role', 'Model', 'Input tokens', 'Output tokens (incl. reasoning)', 'of which reasoning', 'USD / 1M input', 'USD / 1M output', 'Est. cost (USD)', 'Note'],
    ...cost.rows.map((r) => [r.label, r.model, r.input, r.output, r.reasoning, r.rateIn ?? '', r.rateOut ?? '', r.usd ?? '', r.note]),
    ['TOTAL', '', cost.totalInput, cost.totalOutput, '', '', '', cost.totalUsd, cost.complete ? 'Estimate from list prices; provider dashboards are the final authority' : 'Incomplete — a model has no rate set'],
    [],
    ['ADMIN ONLY — do not share with the client.'],
  ], [12, 24, 14, 26, 18, 14, 14, 15, 60]);
  addTab(wb, 'Run', [
    ['Item', 'Detail'],
    ['Reference', ctx.reference],
    ['Accounting firm', ctx.accountingCompany],
    ['Customer company', ctx.customerCompany],
    ['Requested by', ctx.email],
    ['Submitted', sgt(ctx.submittedAt)],
    ['Status', status || ''],
    ['AI review started', timings?.startedAt ? sgt(timings.startedAt) : ''],
    ['ChatGPT time (s)', timings?.chatgptSec ?? ''],
    ['Gemini time (s)', timings?.geminiSec ?? ''],
    ['Claude time (s)', timings?.claudeSec ?? ''],
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
    ['Drive folder', ctx.batchFolderLink ? `<a href="${esc(ctx.batchFolderLink)}">${esc(ctx.drivePath)}</a>` : val(ctx.drivePath)],
  ]);
}

function sheetBox(link) {
  if (!link) return '';
  const tabs = Object.values(TABS).map(esc).join(' · ');
  return `<table border="0" cellspacing="0" cellpadding="10" style="width:100%"><tr><td style="background:#f7edd8;border-left:6px solid ${BROWN}">
  <b>All tables are in the workpaper spreadsheet:</b> <a href="${esc(link)}">Open the Vouching Workpaper (Google Sheet)</a><br>
  <span style="font-size:9pt">Tabs: ${tabs}</span></td></tr></table>`;
}

function reviewerLine(r, claudeText) {
  if (!r?.ok) return `<p><b>Did not complete:</b> ${esc(r?.error || 'no response')}</p>`;
  if (!r.parsed) return `<p>Response was not valid JSON (finish: ${esc(r.finish || 'n/a')}). Raw output is kept by AVAG.AI for review.</p>`;
  const c = sevCounts(r.parsed.findings);
  return `${claudeText ? P(claudeText) : ''}<p><b>Risk rating:</b> ${sev(r.parsed.overall_assessment?.risk_rating)} · <b>Findings:</b> ${arr(r.parsed.findings).length} (High ${c.High}, Medium ${c.Medium}, Low ${c.Low}) · <b>Sample:</b> ${arr(r.parsed.sample_selected).length} items</p>`;
}

function footer(lines) {
  return `<hr><p style="font-size:8pt;color:#6b4a35">${lines.map(esc).join('<br>')}<br>
  AI-generated working paper. It must be reviewed and signed off by a qualified auditor before reliance.</p>`;
}

/** Short narrative Google Doc. Tables live in the Sheet. */
function finalDoc(ctx, { chatgpt, gemini, claude, sheetLink, meta }) {
  const head = banner(`Final Vouching Decision — ${ctx.reference}`, `Decision by Claude · ${claude?.model || ''}`);
  const j = claude?.ok ? claude.parsed : null;

  if (!j) {
    const why = !claude?.ok ? esc(claude?.error || 'no response') : `the response was not valid JSON (finish: ${esc(claude.finish || 'n/a')})`;
    return `<html><body>${head}${engagement(ctx)}
    <p style="color:#a3271b"><b>PROVISIONAL — the final decision could not be produced: ${why}. Our team has been alerted.</b></p>
    ${sheetBox(sheetLink)}
    ${H(2, `Reviewer A — ChatGPT (${chatgpt?.model || ''})`)}${reviewerLine(chatgpt)}
    ${H(2, `Reviewer B — Gemini (${gemini?.model || ''})`)}${reviewerLine(gemini)}
    ${footer([`Prompt: ${meta?.promptVersion || ''} · Generated ${new Date().toISOString()}`])}</body></html>`;
  }

  const c = sevCounts(j.final_findings);
  const top = bySeverity(j.final_findings).filter((f) => f.severity === 'High').slice(0, 8);
  const topRows = top.map((f) => [val(f.id), sev(f.severity), val(f.category), val(f.description || f.issue), val(f.amount)]);
  const files = meta?.manifest ? [
    ...arr(meta.manifest.documents).map((d) => [val(d.path), val(d.role), `text (${d.sentChars} chars${d.truncated ? ', truncated' : ''})`, val(d.note)]),
    ...arr(meta.manifest.attachments).map((a) => [val(a.path), val(a.role), 'native file', '']),
    ...arr(meta.manifest.skipped).map((s) => [val(s.name), '—', 'not analysed', val(s.reason)]),
  ] : [];

  return `<html><body>${head}${engagement(ctx)}
  ${H(2, 'Final decision')}
  ${kv([
    ['Overall risk', sev(j.overall_conclusion?.risk_rating)],
    ['Final findings', `${arr(j.final_findings).length} (High ${c.High}, Medium ${c.Medium}, Low ${c.Low})`],
    ['Materiality', `${val(j.materiality?.amount)} — ${val(j.materiality?.basis)}`],
  ])}
  ${P(j.decision_summary)}
  ${sheetBox(sheetLink)}
  ${H(2, 'Opinion')}${P(j.overall_conclusion?.opinion)}
  ${H(3, 'Key concerns')}${UL(j.overall_conclusion?.key_concerns)}
  ${H(2, `High-severity findings${c.High > top.length ? ` (top ${top.length} of ${c.High})` : ''}`)}
  ${table(['ID', 'Severity', 'Category', 'Finding', 'Amount'], topRows)}
  <p style="font-size:9pt">Full details, evidence, recommendations and the working paper are in the <i>Final Findings</i> and <i>Working Paper</i> tabs of the spreadsheet.</p>
  ${H(2, 'How the two reviews compared')}
  ${H(3, `Reviewer A — ChatGPT (${chatgpt?.model || ''})`)}${reviewerLine(chatgpt, j.comparison?.chatgpt_found)}
  ${H(3, `Reviewer B — Gemini (${gemini?.model || ''})`)}${reviewerLine(gemini, j.comparison?.gemini_found)}
  <p style="font-size:9pt">Agreements, disagreements and how each was resolved: <i>Reviewer Comparison</i> tab.</p>
  ${H(2, 'Limitations')}${UL(j.limitations)}
  ${files.length ? `${H(3, 'Files analysed')}${table(['File', 'Role', 'Sent as', 'Note'], files)}` : ''}
  ${footer([
    `Reviewers: ChatGPT ${chatgpt?.model || ''}, Gemini ${gemini?.model || ''} · Final decision: Claude ${claude.model}`,
    `Prompt: ${meta?.promptVersion || ''} · Generated ${new Date().toISOString()}`,
  ])}
  </body></html>`;
}

module.exports = { esc, emailShell, sevCounts, buildWorkbook, buildCostWorkbook, finalDoc, TABS };
