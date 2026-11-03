// Version :031126 13:30
// File    :lib/ledger.js
/**
 * Master cost ledger — ADMIN ONLY. One row per AI run (re-runs included).
 *
 *   Vouching/_data/cost_ledger.json        ← source of truth (append-only list of rows)
 *   Vouching/_data/Vouching_Cost_Ledger    ← Google Sheet rebuilt from the JSON after every run
 *                                            (same file id, so its link never changes)
 *
 * _data is never shared with clients.
 * "Billed (SGD)" and "Invoice no." are for Krish to type into the Sheet. Before each rebuild the current
 * Sheet is read back and those two columns are saved into the JSON, so typed values are never lost.
 */
const XLSX = require('xlsx');
const g = require('./google');

const ROOT = process.env.ROOT_FOLDER_NAME || 'Vouching';
const JSON_NAME = 'cost_ledger.json';
const SHEET_NAME = 'Vouching_Cost_Ledger';

let chain = Promise.resolve();
const withLock = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

const COLS = [
  ['Date (SGT)', 'date', 18], ['Reference', 'reference', 12], ['Re-run', 'rerun', 7], ['Accounting firm', 'accountingCompany', 22],
  ['Customer company', 'customerCompany', 22], ['Requested by', 'email', 26], ['Status', 'status', 16], ['Duration (s)', 'durationSec', 11],
  ['ChatGPT model', 'chatgptModel', 14], ['ChatGPT in', 'chatgptIn', 11], ['ChatGPT out', 'chatgptOut', 11], ['ChatGPT USD', 'chatgptUsd', 11],
  ['Gemini model', 'geminiModel', 22], ['Gemini in', 'geminiIn', 11], ['Gemini out', 'geminiOut', 11], ['Gemini USD', 'geminiUsd', 11],
  ['Claude model', 'claudeModel', 16], ['Claude in', 'claudeIn', 11], ['Claude out', 'claudeOut', 11], ['Claude USD', 'claudeUsd', 11],
  ['Total USD', 'totalUsd', 11], ['Billed (SGD)', 'billedSgd', 11], ['Invoice no.', 'invoiceNo', 12],
  ['Usage_Cost sheet', 'costSheet', 40], ['Workpaper', 'workpaper', 40], ['Final decision', 'finalDoc', 40],
];

/** Builds one ledger row from the run's context, cost summary and links. */
function rowFor(ctx, { cost, status, durationSec, links }) {
  const by = Object.fromEntries(cost.rows.map((r) => [r.label, r]));
  const m = (label, k) => by[label]?.[k] ?? '';
  return {
    date: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Singapore' }).slice(0, 16),
    reference: ctx.reference,
    rerun: ctx.rerun ? 'yes' : '',
    accountingCompany: ctx.accountingCompany,
    customerCompany: ctx.customerCompany,
    email: ctx.email,
    status,
    durationSec,
    chatgptModel: m('ChatGPT', 'model'), chatgptIn: m('ChatGPT', 'input'), chatgptOut: m('ChatGPT', 'output'), chatgptUsd: m('ChatGPT', 'usd'),
    geminiModel: m('Gemini', 'model'), geminiIn: m('Gemini', 'input'), geminiOut: m('Gemini', 'output'), geminiUsd: m('Gemini', 'usd'),
    claudeModel: m('Claude', 'model'), claudeIn: m('Claude', 'input'), claudeOut: m('Claude', 'output'), claudeUsd: m('Claude', 'usd'),
    totalUsd: cost.totalUsd,
    billedSgd: '',
    invoiceNo: '',
    costSheet: links?.costSheet || '',
    workpaper: links?.sheet || '',
    finalDoc: links?.doc || '',
  };
}

function buildSheet(rows) {
  const total = rows.reduce((s, r) => s + (Number(r.totalUsd) || 0), 0);
  const aoa = [
    COLS.map((c) => c[0]),
    ...rows.map((r) => COLS.map(([, k]) => r[k] ?? '')),
    [],
    ['TOTAL', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', Math.round(total * 10000) / 10000],
    ['ADMIN ONLY — estimated LLM cost from list prices. Provider dashboards are the final authority.'],
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = COLS.map((c) => ({ wch: c[2] }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Ledger');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/** Reads Billed (SGD) / Invoice no. typed into the current Sheet back into the JSON rows. */
async function keepTypedBilling(rows, folder) {
  if (!rows.length) return;
  try {
    const sheetId = await g.findFile(SHEET_NAME, folder);
    if (!sheetId) return;
    const dl = await g.downloadFile({ id: sheetId, name: SHEET_NAME, mimeType: 'application/vnd.google-apps.spreadsheet' });
    const wb = XLSX.read(dl.buffer, { type: 'buffer' });
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' });
    const head = aoa[0] || [];
    const ix = (name) => head.indexOf(name);
    const [iDate, iRef, iBill, iInv] = [ix('Date (SGT)'), ix('Reference'), ix('Billed (SGD)'), ix('Invoice no.')];
    if (iDate < 0 || iRef < 0) return;
    const typed = new Map(aoa.slice(1).map((r) => [`${r[iDate]}|${r[iRef]}`, { b: r[iBill], i: r[iInv] }]));
    for (const row of rows) {
      const t = typed.get(`${row.date}|${row.reference}`);
      if (t?.b) row.billedSgd = t.b;
      if (t?.i) row.invoiceNo = t.i;
    }
  } catch (e) {
    console.error('[ledger] could not read typed billing values:', e.message);
  }
}

/** Appends a row (JSON first, then rebuilds the Sheet). Returns {link, rows}. Never throws to the caller's flow if awaited with catch. */
function appendRun(ctx, info) {
  return withLock(async () => {
    const folder = await g.ensurePath([ROOT, '_data']);
    const id = await g.findFile(JSON_NAME, folder);
    let rows = [];
    if (id) {
      try { rows = JSON.parse(await g.readText(id)).rows || []; } catch { rows = []; }
    }
    await keepTypedBilling(rows, folder);
    rows.push(rowFor(ctx, info));
    await g.upsertText(JSON_NAME, JSON.stringify({ schema: 'avag.vouching.cost-ledger/v1', updatedAt: new Date().toISOString(), rows }, null, 2), folder);
    const sheet = await g.upsertGoogleSheet(SHEET_NAME, buildSheet(rows), folder);
    return { link: sheet.link, rows: rows.length };
  });
}

module.exports = { appendRun, rowFor, buildSheet };
