// Version :071126 00:25
// File    :lib/extract.js
/**
 * Turns the input files into LLM-ready input — entirely in memory.
 *  - Spreadsheets / CSV (xlsx, xls, xlsm, ods, csv, tsv, Google Sheets) -> CSV text, every row prefixed "#<row>|"
 *    so the models can cite exact rows.
 *  - DOCX -> text,  TXT/JSON/XML/HTML -> text,  PDF -> text layer.
 *  - Scanned PDFs (no text layer) and images -> sent to the models natively, inline (within MAX_AI_ATTACH_MB).
 * A shared character budget (MAX_AI_TEXT_CHARS) is split fairly across files; truncation is recorded.
 *
 * 071126:
 *  - Files are processed ONE AT A TIME; each downloaded buffer is dropped as soon as its text is taken,
 *    so peak memory ≈ the largest single file, not the whole set. Nothing is written to disk.
 *  - Compute guard: before a file is downloaded, its working memory is estimated. If it would not fit in
 *    COMPUTE_RAM_MB, the file is listed as "Not examined — exceeds current compute capacity" and
 *    totals.computeLimited is set, so the client email can say how to get more compute.
 *  - Every file that is not examined is recorded in `skipped` with a plain reason and its source.
 */
const path = require('path');
const g = require('./google');
const { LIMITS } = require('./limits');

const MAX_TEXT = Number(process.env.MAX_AI_TEXT_CHARS || 400000);
const MAX_ATTACH = Number(process.env.MAX_AI_ATTACH_MB || 12) * 1024 * 1024;
const MAX_FILE = LIMITS.maxAiFileMb * 1024 * 1024;
const RAM_BYTES = LIMITS.computeRamMb * 1024 * 1024;
const RAM_USABLE = 0.85; // leave headroom for Node, the HTTP server and the outgoing request bodies
const SAMPLE_CAP = 30000; // output-format samples only need their layout

const SHEET_EXT = ['.xlsx', '.xlsm', '.xls', '.xlsb', '.ods', '.csv', '.tsv'];
const TEXT_EXT = ['.txt', '.json', '.xml', '.md', '.log', '.html', '.htm'];
const IMG_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const GOOGLE_NATIVE = ['application/vnd.google-apps.document', 'application/vnd.google-apps.spreadsheet', 'application/vnd.google-apps.presentation'];

/** Can the pipeline read this file at all? Used to decide what is "Not examined" before downloading. */
function isSupported(name, mime = '') {
  const ext = path.extname(String(name)).toLowerCase();
  const m = String(mime);
  if (GOOGLE_NATIVE.includes(m)) return true;
  if (m.startsWith('application/vnd.google-apps.')) return false; // forms, drawings, maps, sites…
  if (SHEET_EXT.includes(ext) || TEXT_EXT.includes(ext) || IMG_MIME[ext] || ext === '.pdf' || ext === '.docx') return true;
  return /^(application\/pdf|text\/|image\/(png|jpe?g|webp|gif)$)/.test(m) || /spreadsheet|excel/.test(m);
}

/** Rough working-memory multiplier while a file is parsed (spreadsheets expand the most). */
function memFactor(name, mime = '') {
  const ext = path.extname(String(name)).toLowerCase();
  if (SHEET_EXT.includes(ext) || /spreadsheet|excel/.test(mime)) return 10;
  if (ext === '.pdf' || mime === 'application/pdf') return 4;
  if (ext === '.docx') return 6;
  return 3; // images / text: buffer + base64 copy
}

const fitsInMemory = (bytes, name, mime) => process.memoryUsage().rss + bytes * memFactor(name, mime) <= RAM_BYTES * RAM_USABLE;

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
  return { kind: 'unsupported', text: '', note: `unsupported file type (${ext || mime})` };
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

const sourceOf = (f) => f.source || 'upload';

/**
 * @param files [{id,name,mimeType,size,path,role,source?,resourceKey?}]
 * @param preSkipped [{name,reason,source}] — files already ruled out (e.g. by the link inventory)
 * @returns {documents, attachments, skipped, totals}
 */
async function extractAll(files, preSkipped = []) {
  const documents = [];
  const attachments = [];
  const skipped = [...preSkipped];
  let attachBytes = 0;
  let computeLimited = false;
  const skip = (f, reason) => skipped.push({ name: f.path, reason, source: sourceOf(f) });

  for (const f of files) {
    if (f.size > MAX_FILE) { skip(f, `larger than ${LIMITS.maxAiFileMb} MB per file`); continue; }
    if (!isSupported(f.name, f.mimeType)) { skip(f, `unsupported file type (${path.extname(f.name) || f.mimeType})`); continue; }
    if (f.size && !fitsInMemory(f.size, f.name, f.mimeType)) {
      computeLimited = true;
      skip(f, 'exceeds current compute capacity');
      continue;
    }
    let dl;
    try {
      dl = await g.downloadFile(f);
    } catch (e) {
      skip(f, `could not be read: ${e.message}`);
      continue;
    }
    // Google-native files have no size until exported — check again now.
    if (!f.size && !fitsInMemory(dl.buffer.length, dl.name, dl.mimeType)) {
      computeLimited = true;
      skip(f, 'exceeds current compute capacity');
      dl = null;
      continue;
    }
    try {
      const r = await toText(dl.buffer, dl.name, dl.mimeType || '');
      if (r.attach) {
        if (attachBytes + dl.buffer.length <= MAX_ATTACH) {
          attachments.push({ name: dl.name, path: f.path, role: f.role, source: sourceOf(f), mimeType: r.attachMime, base64: dl.buffer.toString('base64'), bytes: dl.buffer.length });
          attachBytes += dl.buffer.length;
        } else {
          skip(f, `scanned/image file over the ${MAX_ATTACH / 1048576} MB native-file budget`);
        }
      }
      if (r.text && r.text.trim()) {
        documents.push({ name: dl.name, path: f.path, role: f.role, source: sourceOf(f), kind: r.kind, text: r.text, chars: r.text.length, note: r.note || '' });
      } else if (!r.attach) {
        skip(f, r.note || 'no readable text');
      }
    } catch (e) {
      const oom = /allocation failed|out of memory|ENOMEM|Invalid string length|Array buffer/i.test(e.message);
      if (oom) computeLimited = true;
      skip(f, oom ? 'exceeds current compute capacity' : `could not be read: ${e.message}`);
    }
    dl = null; // release the buffer before the next file
  }

  applyBudget(documents);
  return {
    documents,
    attachments,
    skipped,
    totals: {
      files: files.length + preSkipped.length,
      textDocuments: documents.length,
      nativeAttachments: attachments.length,
      skipped: skipped.length,
      textChars: documents.reduce((n, d) => n + d.text.length, 0),
      anyTruncated: documents.some((d) => d.truncated),
      budgetChars: MAX_TEXT,
      computeLimited,
      computeRamMb: LIMITS.computeRamMb,
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

module.exports = { extractAll, manifest, isSupported };
