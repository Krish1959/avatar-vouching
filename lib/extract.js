// Version :021126 14:50
// File    :lib/extract.js
/**
 * Turns the stored files into LLM-ready input.
 *  - Spreadsheets / CSV (xlsx, xls, xlsm, ods, csv, tsv, Google Sheets) -> CSV text, every row prefixed "#<row>|"
 *    so the models can cite exact rows.
 *  - DOCX -> text,  TXT/JSON/XML/HTML -> text,  PDF -> text layer.
 *  - Scanned PDFs (no text layer) and images -> sent to the models natively (within MAX_AI_ATTACH_MB).
 * A shared character budget (MAX_AI_TEXT_CHARS) is split fairly across files; truncation is recorded.
 */
const path = require('path');
const g = require('./google');

const MAX_TEXT = Number(process.env.MAX_AI_TEXT_CHARS || 400000);
const MAX_ATTACH = Number(process.env.MAX_AI_ATTACH_MB || 12) * 1024 * 1024;
const MAX_FILE = Number(process.env.MAX_AI_FILE_MB || 60) * 1024 * 1024;
const SAMPLE_CAP = 30000; // output-format samples only need their layout

const SHEET_EXT = ['.xlsx', '.xlsm', '.xls', '.xlsb', '.ods', '.csv', '.tsv'];
const TEXT_EXT = ['.txt', '.json', '.xml', '.md', '.log', '.html', '.htm'];
const IMG_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function sheetToText(buf, ext) {
  const XLSX = require('xlsx');
  const isDelimited = ext === '.csv' || ext === '.tsv';
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: !isDelimited, raw: isDelimited, dense: true });
  const parts = [];
  let rowsTotal = 0;
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws || !ws['!ref']) continue;
    const start = XLSX.utils.decode_range(ws['!ref']).s.r;
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '', blankrows: true });
    const lines = [];
    rows.forEach((r, i) => {
      const cells = r.map((c) => String(c ?? '').trim());
      while (cells.length && !cells[cells.length - 1]) cells.pop();
      if (!cells.length) return;
      lines.push(`#${start + i + 1}|${cells.map(csvCell).join(',')}`);
    });
    rowsTotal += lines.length;
    parts.push(`--- Sheet: ${name} (${lines.length} non-empty rows; "#n|" = spreadsheet row n) ---\n${lines.join('\n')}`);
  }
  return { kind: isDelimited ? 'csv' : 'spreadsheet', text: parts.join('\n\n'), note: `${wb.SheetNames.length} sheet(s), ${rowsTotal} rows` };
}

async function pdfToText(buf) {
  const pdfParse = require('pdf-parse/lib/pdf-parse.js');
  const r = await pdfParse(buf);
  const pages = r.numpages || 1;
  const t = String(r.text || '').replace(/\n{3,}/g, '\n\n').trim();
  const scanned = t.length < 40 * pages;
  return {
    kind: 'pdf',
    text: t ? `[PDF, ${pages} page(s)]\n${t}` : '',
    attach: scanned,
    attachMime: 'application/pdf',
    note: scanned ? `${pages} page(s), little/no text layer — sent as native PDF` : `${pages} page(s)`,
  };
}

async function toText(buf, name, mime) {
  const ext = path.extname(name).toLowerCase();
  if (SHEET_EXT.includes(ext) || /spreadsheet|excel|text\/csv/.test(mime)) return sheetToText(buf, ext || '.xlsx');
  if (ext === '.pdf' || mime === 'application/pdf') return pdfToText(buf);
  if (ext === '.docx') {
    const mammoth = require('mammoth');
    const r = await mammoth.extractRawText({ buffer: buf });
    return { kind: 'docx', text: r.value.trim() };
  }
  if (IMG_MIME[ext] || /^image\/(png|jpe?g|webp|gif)$/.test(mime)) {
    return { kind: 'image', text: '', attach: true, attachMime: IMG_MIME[ext] || mime, note: 'sent as native image' };
  }
  if (TEXT_EXT.includes(ext) || String(mime).startsWith('text/')) {
    let t = buf.toString('utf8');
    if (/html?$/.test(ext) || mime === 'text/html') t = t.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ');
    return { kind: 'text', text: t.replace(/[ \t]+/g, ' ').trim() };
  }
  return { kind: 'unsupported', text: '', note: `unsupported type (${ext || mime})` };
}

/** Water-fill: each doc gets min(its length, fair share of what's left). */
function applyBudget(docs) {
  for (const d of docs) if (d.role === 'OUTPUT_FORMAT_SAMPLE' && d.text.length > SAMPLE_CAP) {
    d.text = d.text.slice(0, SAMPLE_CAP); d.truncated = true;
  }
  let remaining = MAX_TEXT;
  const order = [...docs].sort((a, b) => a.text.length - b.text.length);
  order.forEach((d, i) => {
    const share = Math.floor(remaining / (order.length - i));
    if (d.text.length > share) {
      d.text = d.text.slice(0, share) + `\n[... TRUNCATED: ${d.chars - share} of ${d.chars} characters not shown ...]`;
      d.truncated = true;
    }
    remaining -= Math.min(d.text.length, share);
  });
}

/**
 * @param files [{id,name,mimeType,size,path,role}]
 * @returns {documents, attachments, skipped, totals}
 */
async function extractAll(files) {
  const documents = [];
  const attachments = [];
  const skipped = [];
  let attachBytes = 0;

  for (const f of files) {
    if (f.size > MAX_FILE) { skipped.push({ name: f.path, reason: `larger than ${MAX_FILE / 1048576} MB` }); continue; }
    let dl;
    try {
      dl = await g.downloadFile(f);
    } catch (e) {
      skipped.push({ name: f.path, reason: `download failed: ${e.message}` });
      continue;
    }
    try {
      const r = await toText(dl.buffer, dl.name, dl.mimeType || '');
      if (r.attach) {
        if (attachBytes + dl.buffer.length <= MAX_ATTACH) {
          attachments.push({ name: dl.name, path: f.path, role: f.role, mimeType: r.attachMime, base64: dl.buffer.toString('base64'), bytes: dl.buffer.length });
          attachBytes += dl.buffer.length;
        } else {
          skipped.push({ name: f.path, reason: `native attachment budget (${MAX_ATTACH / 1048576} MB) exceeded` });
        }
      }
      if (r.text && r.text.trim()) {
        documents.push({ name: dl.name, path: f.path, role: f.role, kind: r.kind, text: r.text, chars: r.text.length, note: r.note || '' });
      } else if (!r.attach) {
        skipped.push({ name: f.path, reason: r.note || 'no readable text' });
      }
    } catch (e) {
      skipped.push({ name: f.path, reason: `could not read: ${e.message}` });
    }
  }

  applyBudget(documents);
  return {
    documents,
    attachments,
    skipped,
    totals: {
      files: files.length,
      textDocuments: documents.length,
      nativeAttachments: attachments.length,
      skipped: skipped.length,
      textChars: documents.reduce((n, d) => n + d.text.length, 0),
      anyTruncated: documents.some((d) => d.truncated),
      budgetChars: MAX_TEXT,
    },
  };
}

/** Manifest without file contents — safe to store as JSON. */
function manifest(ex) {
  return {
    totals: ex.totals,
    documents: ex.documents.map(({ text, ...d }) => ({ ...d, sentChars: text.length })),
    attachments: ex.attachments.map(({ base64, ...a }) => a),
    skipped: ex.skipped,
  };
}

module.exports = { extractAll, manifest };
