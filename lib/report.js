// Version :021126 14:50
// File    :lib/report.js
/**
 * HTML builders.
 *  - Google Docs (Drive converts HTML -> native Doc): ChatGPT findings, Gemini findings, Claude final decision.
 *  - Email shell (AVAG.AI brown/gold).
 */
const BROWN = '#3d2314';
const GOLD = '#FFD700';
const SEV_COLOR = { High: '#a3271b', Medium: '#b8860b', Low: '#2f6b2f' };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const val = (v) => {
  if (v == null || v === '') return '—';
  if (Array.isArray(v)) return esc(v.join(', '));
  if (typeof v === 'object') return esc(JSON.stringify(v));
  return esc(v);
};
const arr = (a) => (Array.isArray(a) ? a : a ? [a] : []);

function emailShell(title, inner) {
  return `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;border:1px solid #e8d4a8;border-radius:10px;overflow:hidden">
  <div style="background:${BROWN};padding:18px 22px;color:${GOLD};font-size:18px;font-weight:bold">Avatar Agentic AI, Singapore<br>
  <span style="font-size:12px;letter-spacing:3px;font-weight:normal">AVATAR VOUCHING AGENTIC AI</span></div>
  <div style="padding:22px;color:#3a2010;font-size:14px;line-height:1.6"><h3 style="margin-top:0">${title}</h3>${inner}</div>
  <div style="background:#2a1810;color:#b89a3a;font-size:11px;padding:10px 22px">© ${new Date().getFullYear()} Avatar Agentic AI Pte Ltd · Singapore</div></div>`;
}

/* ------------------------------------------------------------ doc pieces */

const H = (n, t) => `<h${n} style="color:${BROWN}">${esc(t)}</h${n}>`;
const P = (t) => `<p>${esc(t)}</p>`;
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
    ['Submitted', val(new Date(ctx.submittedAt).toLocaleString('en-SG', { timeZone: 'Asia/Singapore' }) + ' SGT')],
    ['Drive folder', ctx.batchFolderLink ? `<a href="${esc(ctx.batchFolderLink)}">${esc(ctx.drivePath)}</a>` : val(ctx.drivePath)],
  ]);
}

function findingsTable(findings, withVerdict = false) {
  const head = [...(withVerdict ? ['ID', 'Verdict', 'Found by'] : ['ID']), 'Severity', 'Category', 'File / location', 'Date', 'Account / counterparty', 'Amount', 'Issue', 'Evidence', 'Recommendation', 'Document required'];
  const rows = arr(findings).map((f) => [
    ...(withVerdict ? [val(f.id), val(f.verdict), val(f.found_by)] : [val(f.id)]),
    sev(f.severity), val(f.category), `${val(f.file)}<br>${val(f.location)}`, val(f.date),
    `${val(f.account)}${f.counterparty ? `<br>${val(f.counterparty)}` : ''}`, val(f.amount), val(f.issue), val(f.evidence),
    val(f.recommendation), val(f.supporting_document_required),
  ]);
  return table(head, rows);
}

function clientFormat(cfo) {
  const cols = arr(cfo?.columns);
  const rows = arr(cfo?.rows).map((r) => arr(r).map(val));
  if (!cols.length && !rows.length) return '<p>Not provided.</p>';
  return table(cols, rows);
}

function sevCounts(findings) {
  const c = { High: 0, Medium: 0, Low: 0 };
  arr(findings).forEach((f) => { if (c[f.severity] != null) c[f.severity]++; });
  return c;
}

function rawFallback(r) {
  return `<p><i>The model's response could not be parsed as structured JSON. Raw response:</i></p>
  <pre style="white-space:pre-wrap;font-size:8pt">${esc(String(r.text || '').slice(0, 200000))}</pre>`;
}

function footer(lines) {
  return `<hr><p style="font-size:8pt;color:#6b4a35">${lines.map(esc).join('<br>')}<br>
  AI-generated working paper. It must be reviewed and signed off by a qualified auditor before reliance.</p>`;
}

/* ------------------------------------------------------- reviewer docs */

function reviewerDoc(ctx, r, meta) {
  const head = banner(`${r.label} Findings — ${ctx.reference}`, `Independent reviewer · ${r.model}`);
  if (!r.ok) {
    return `<html><body>${head}${engagement(ctx)}${H(2, 'Result')}${P(`This reviewer did not complete: ${r.error}`)}${footer([`Model: ${r.model}`])}</body></html>`;
  }
  const j = r.parsed;
  const body = !j ? rawFallback(r) : `
  ${H(2, '1. Overall assessment')}
  ${kv([['Risk rating', sev(j.overall_assessment?.risk_rating)], ['Summary', val(j.overall_assessment?.summary)], ['Materiality', `${val(j.materiality?.amount)} — ${val(j.materiality?.basis)}`]])}
  ${H(3, 'Key concerns')}${UL(j.overall_assessment?.key_concerns)}
  ${H(2, '2. Engagement understanding')}${P(j.engagement_understanding)}
  ${H(2, '3. Data overview')}
  ${kv([['Period covered', val(j.data_overview?.period_covered)], ['Currency', val(j.data_overview?.currency)], ['Transactions', val(j.data_overview?.total_transactions)], ['Total value', val(j.data_overview?.total_value)]])}
  ${table(['File', 'Type', 'Records', 'Period', 'Notes'], arr(j.data_overview?.files_reviewed).map((f) => [val(f.file), val(f.type), val(f.records), val(f.period_covered), val(f.notes)]))}
  ${H(2, '4. Methodology')}${UL(j.methodology)}
  ${H(2, `5. Findings (${arr(j.findings).length})`)}${findingsTable(j.findings)}
  ${H(2, `6. Sample selected (${arr(j.sample_selected).length})`)}
  ${table(['Ref', 'File / location', 'Date', 'Account', 'Description', 'Amount', 'Reason'], arr(j.sample_selected).map((s) => [val(s.ref), `${val(s.file)} ${val(s.location)}`, val(s.date), val(s.account), val(s.description), val(s.amount), val(s.reason_selected)]))}
  ${H(2, '7. Working paper (client format)')}${clientFormat(j.client_format_output)}
  ${H(2, '8. Limitations')}${UL(j.limitations)}
  ${H(2, '9. Questions for the client')}${UL(j.questions_for_client)}`;
  return `<html><body>${head}${engagement(ctx)}${body}${footer([`Model: ${r.model} · ${Math.round(r.ms / 1000)} s · finish: ${r.finish || '—'}`, `Prompt: ${meta.promptVersion}`])}</body></html>`;
}

/* ---------------------------------------------------------- final doc */

function reviewerSummary(r, link, claudeText) {
  if (!r.ok) return `<p><b>Did not complete:</b> ${esc(r.error)}</p>`;
  const j = r.parsed;
  if (!j) return `<p>Response was not structured JSON — see the full document. ${link ? `<a href="${esc(link)}">Open ${esc(r.label)} findings</a>` : ''}</p>`;
  const c = sevCounts(j.findings);
  const top = arr(j.findings).slice(0, 5).map((f) => `<li>${sev(f.severity)} ${val(f.id)} — ${val(f.category)}: ${val(f.issue)} (${val(f.file)} ${val(f.location)})</li>`).join('');
  return `${claudeText ? `<p>${esc(claudeText)}</p>` : ''}
  <p><b>Risk rating:</b> ${sev(j.overall_assessment?.risk_rating)} · <b>Findings:</b> ${arr(j.findings).length} (High ${c.High}, Medium ${c.Medium}, Low ${c.Low}) · <b>Sample:</b> ${arr(j.sample_selected).length} items</p>
  ${top ? `<ul>${top}</ul>` : ''}
  <p>${link ? `Full detail: <a href="${esc(link)}">${esc(r.label)} findings — ${esc(r.model)}</a>` : ''}</p>`;
}

function finalDoc(ctx, { chatgpt, gemini, claude, links, meta }) {
  const head = banner(`Final Vouching Decision — ${ctx.reference}`, `Decision by ${claude.label} · ${claude.model}`);
  const j = claude.ok ? claude.parsed : null;
  const status = !claude.ok
    ? `<p style="color:#a3271b"><b>PROVISIONAL — the final decision could not be produced (${esc(claude.error)}). Reviewer results below are not yet adjudicated.</b></p>`
    : !j ? rawFallback(claude) : '';

  const decision = j ? `
  ${H(2, 'Final decision')}
  ${kv([['Overall risk', sev(j.overall_conclusion?.risk_rating)], ['Decision', val(j.decision_summary)], ['Opinion', val(j.overall_conclusion?.opinion)], ['Materiality', `${val(j.materiality?.amount)} — ${val(j.materiality?.basis)}`], ['Final findings', `${arr(j.final_findings).length} (High ${sevCounts(j.final_findings).High}, Medium ${sevCounts(j.final_findings).Medium}, Low ${sevCounts(j.final_findings).Low})`]])}
  ${H(3, 'Key concerns')}${UL(j.overall_conclusion?.key_concerns)}` : '';

  const comparison = j ? `
  ${H(2, '3. Claude — comparison of the two reviews')}
  ${H(3, 'Where they agree')}${UL(j.comparison?.agreement_points)}
  ${H(3, 'Where they differ and the decision')}
  ${table(['Topic', 'ChatGPT', 'Gemini', 'Resolution'], arr(j.comparison?.disagreements).map((d) => [val(d.topic), val(d.chatgpt), val(d.gemini), val(d.resolution)]))}
  ${kv([['ChatGPT review quality', val(j.comparison?.chatgpt_quality)], ['Gemini review quality', val(j.comparison?.gemini_quality)]])}
  ${H(2, `4. Final findings (${arr(j.final_findings).length})`)}${findingsTable(j.final_findings, true)}
  ${H(3, 'Rationale per finding')}${UL(arr(j.final_findings).map((f) => `${f.id}: ${f.rationale || '—'}`))}
  ${H(2, `5. Rejected reviewer findings (${arr(j.rejected_findings).length})`)}
  ${table(['Source', 'Reviewer', 'Finding', 'Reason rejected'], arr(j.rejected_findings).map((x) => [val(x.source_id), val(x.reviewer), val(x.summary), val(x.reason)]))}
  ${H(2, '6. Final working paper (client format)')}${clientFormat(j.client_format_output)}
  ${H(2, '7. Items for human review')}${UL(j.items_for_human_review)}
  ${H(2, '8. Questions for the client')}${UL(j.questions_for_client)}
  ${H(2, '9. Limitations')}${UL(j.limitations)}` : '';

  return `<html><body>${head}${engagement(ctx)}${status}${decision}
  ${H(2, `1. ChatGPT found (${chatgpt.model})`)}${reviewerSummary(chatgpt, links.chatgpt, j?.comparison?.chatgpt_found)}
  ${H(2, `2. Gemini found (${gemini.model})`)}${reviewerSummary(gemini, links.gemini, j?.comparison?.gemini_found)}
  ${comparison}
  ${H(2, 'Files analysed')}
  ${table(['File', 'Role', 'Sent as', 'Note'], [
    ...meta.manifest.documents.map((d) => [val(d.path), val(d.role), `text (${d.sentChars} chars${d.truncated ? ', truncated' : ''})`, val(d.note)]),
    ...meta.manifest.attachments.map((a) => [val(a.path), val(a.role), 'native file', '']),
    ...meta.manifest.skipped.map((s) => [val(s.name), '—', 'not analysed', val(s.reason)]),
  ])}
  ${footer([`Reviewers: ChatGPT ${chatgpt.model}, Gemini ${gemini.model} · Final decision: Claude ${claude.model}`, `Prompt: ${meta.promptVersion} · Generated ${new Date().toISOString()}`])}
  </body></html>`;
}

module.exports = { esc, emailShell, reviewerDoc, finalDoc, sevCounts };
