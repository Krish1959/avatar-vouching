// Version :071126 00:25
// File    :lib/registry.js
/**
 * Company data registry — everything collected from the web form, kept as JSON on Drive.
 *
 *   Vouching/_data/companies.json                  ← master registry (all firms, customers, submissions)
 *   Vouching/<ACC>/<CUST>/company_profile.json     ← per-customer slice, handy when browsing Drive
 *   Vouching/<ACC>/<CUST>/<batch>/submission_info.json  (written by server.js)
 *
 * Single Render instance → an in-process lock serialises read-modify-write.
 * 071126: stores driveLinks[] (several shared links); findInFlight() finds jobs cut off by a restart.
 */
const g = require('./google');

const ROOT = process.env.ROOT_FOLDER_NAME || 'Vouching';
const FILE = 'companies.json';
const SCHEMA = 'avag.vouching.registry/v1';

let chain = Promise.resolve();
function withLock(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

const fresh = () => ({ schema: SCHEMA, updatedAt: null, accountingCompanies: {} });
const addUnique = (arr, v) => { if (v && !arr.includes(v)) arr.push(v); };

async function dataFolder() {
  return g.ensurePath([ROOT, '_data']);
}

async function load() {
  const folder = await dataFolder();
  const id = await g.findFile(FILE, folder);
  if (!id) return { folder, reg: fresh() };
  try {
    const reg = JSON.parse(await g.readText(id));
    if (!reg.accountingCompanies) reg.accountingCompanies = {};
    return { folder, reg };
  } catch (e) {
    // Never overwrite a registry we failed to parse — keep a backup first.
    const text = await g.readText(id).catch(() => '');
    if (text) await g.uploadText(`companies.corrupt-${Date.now()}.json`, text, folder).catch(() => {});
    return { folder, reg: fresh() };
  }
}

async function save(folder, reg) {
  reg.updatedAt = new Date().toISOString();
  await g.upsertText(FILE, JSON.stringify(reg, null, 2), folder);
}

function ensureEntries(reg, s) {
  const now = new Date().toISOString();
  const acc = (reg.accountingCompanies[s.accKey] ||= { key: s.accKey, names: [], firstSeen: now, customers: {} });
  addUnique(acc.names, s.accountingCompany);
  const cust = (acc.customers[s.custKey] ||= { key: s.custKey, names: [], contacts: [], firstSeen: now, submissions: [] });
  addUnique(cust.names, s.customerCompany);
  addUnique(cust.contacts, s.email);
  cust.lastSeen = now;
  acc.lastSeen = now;
  return { acc, cust };
}

async function writeProfile(customerFolderId, acc, cust) {
  if (!customerFolderId) return;
  const profile = {
    schema: 'avag.vouching.company-profile/v1',
    updatedAt: new Date().toISOString(),
    accountingCompany: { key: acc.key, names: acc.names },
    customerCompany: cust,
  };
  await g.upsertText('company_profile.json', JSON.stringify(profile, null, 2), customerFolderId);
}

/** Called by the intake route once files are stored. */
function recordSubmission(rec) {
  return withLock(async () => {
    const { folder, reg } = await load();
    const { acc, cust } = ensureEntries(reg, rec);
    cust.submissions = cust.submissions.filter((x) => x.reference !== rec.reference);
    cust.submissions.push({
      reference: rec.reference,
      submittedAt: rec.submittedAt,
      email: rec.email,
      drivePath: rec.drivePath,
      batchFolderId: rec.batchFolderId,
      batchFolderLink: rec.batchFolderLink,
      customerFolderId: rec.customerFolderId,
      ledgerCount: rec.ledgerFiles?.length || 0,
      sampleCount: rec.outputFormatSamples?.length || 0,
      driveLinks: rec.driveLinks || (rec.driveLink ? [rec.driveLink] : []),
      hasNotes: !!rec.notes,
      status: 'received',
    });
    await save(folder, reg);
    await writeProfile(rec.customerFolderId, acc, cust);
  });
}

/** Patch a submission's status / review results. */
function updateSubmission(accKey, custKey, reference, patch) {
  return withLock(async () => {
    const { folder, reg } = await load();
    const acc = reg.accountingCompanies[accKey];
    const cust = acc?.customers?.[custKey];
    const sub = cust?.submissions?.find((x) => x.reference === reference);
    if (!sub) return null;
    Object.assign(sub, patch, { updatedAt: new Date().toISOString() });
    await save(folder, reg);
    await writeProfile(sub.customerFolderId, acc, cust);
    return sub;
  });
}

/** Look up a submission by reference (for admin re-runs). */
async function findSubmission(reference) {
  const { reg } = await load();
  for (const acc of Object.values(reg.accountingCompanies)) {
    for (const cust of Object.values(acc.customers || {})) {
      const sub = (cust.submissions || []).find((x) => x.reference === reference);
      if (sub) return { accKey: acc.key, custKey: cust.key, ...sub };
    }
  }
  return null;
}

/**
 * Submissions still marked "received" or "processing" that started within `maxAgeHours`.
 * After a restart nothing is running, so these were cut off (e.g. the instance ran out of memory).
 */
async function findInFlight(maxAgeHours = 24) {
  const { reg } = await load();
  const since = Date.now() - maxAgeHours * 3600e3;
  const out = [];
  for (const acc of Object.values(reg.accountingCompanies)) {
    for (const cust of Object.values(acc.customers || {})) {
      for (const sub of cust.submissions || []) {
        const t = Date.parse(sub.processingStartedAt || sub.submittedAt || 0);
        if (['received', 'processing'].includes(sub.status) && t >= since) out.push({ accKey: acc.key, custKey: cust.key, ...sub });
      }
    }
  }
  return out;
}

module.exports = { recordSubmission, updateSubmission, findSubmission, findInFlight };
