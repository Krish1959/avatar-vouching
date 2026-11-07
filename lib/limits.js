// Version :071126 00:25
// File    :lib/limits.js
/**
 * One place for every intake / processing limit. The web page reads these via GET /api/config,
 * so the numbers shown to clients always match what the server enforces.
 * All are ENV-overridable on Render without a code change.
 *
 * Shared-link limits (per submission, all links together):
 *   MAX_LINKS=5          links
 *   MAX_LINK_DEPTH=3     sub-folder levels below each linked folder
 *   MAX_LINK_FILES=300   files read from links
 *   MAX_LINK_TOTAL_MB=200  total size read from links
 *
 * Compute guard:
 *   COMPUTE_RAM_MB=512   RAM of the Render instance (512 = Free/Starter, 2048 = Standard, 4096 = Pro).
 *                        A file whose estimated working memory would not fit is listed as
 *                        "Not examined — exceeds current compute capacity" instead of crashing the service.
 */
const num = (k, d) => {
  const v = Number(String(process.env[k] || '').trim());
  return Number.isFinite(v) && v > 0 ? v : d;
};

const LIMITS = {
  maxLinks: num('MAX_LINKS', 5),
  maxLinkDepth: num('MAX_LINK_DEPTH', 3),
  maxLinkFiles: num('MAX_LINK_FILES', 300),
  maxLinkTotalMb: num('MAX_LINK_TOTAL_MB', 200),
  maxUploadFileMb: num('MAX_FILE_MB', 100),
  maxAiFileMb: num('MAX_AI_FILE_MB', 60),
  computeRamMb: num('COMPUTE_RAM_MB', 512),
};

const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'admin@avag.ai';
const COMPUTE_NOTE = `Contact AVAG: ${SUPPORT_EMAIL} to allocate more resources for Compute.`;

/** Plain-language list of what the AI can read. Shown on the page and in emails. */
const SUPPORTED_TYPES_TEXT = 'PDF, images (PNG, JPG, WEBP, GIF), Excel (XLSX, XLS, XLSM, ODS), CSV/TSV, Word (DOCX), text (TXT, JSON, XML, HTML), Google Docs, Sheets and Slides';

module.exports = { LIMITS, SUPPORT_EMAIL, COMPUTE_NOTE, SUPPORTED_TYPES_TEXT };
