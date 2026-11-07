// Version :071126 00:25
// File    :lib/llm.js
/**
 * Direct REST calls (no vendor SDKs) to:
 *   ChatGPT  — OpenAI Responses API, background mode + polling (long reasoning runs survive)
 *   Gemini   — Gemini API generateContent, JSON response mode
 *   Claude   — Anthropic Messages API, streamed (no idle-connection timeouts)
 *
 * Models are env-configurable — model IDs change often; check /healthz/ai after changing them.
 * AI_MOCK=true returns canned JSON so the whole pipeline can be tested without API keys
 *   (AI_MOCK_DELAY_SEC=60 makes the mock models take ~60 s / 21 s / 36 s, to demo the progress page).
 *   AI_MOCK_FAIL=ChatGPT,Claude  makes those mock models fail with a billing error (to test failure handling).
 *
 * preflight() sends a tiny "Hi" to the models before the big run (health check).
 *
 * NO CAPS (031126): output length and run time are left to the models.
 *
 * MID-RUN FAILURES (071126): every error is classified so the pipeline can react correctly.
 *   errorKind  billing    — out of credit / quota / billing problem. Not retried (one short re-check only).
 *              auth       — key invalid or revoked. Not retried.
 *              rate_limit — 429 without a billing message. Retried with back-off.
 *              server     — 5xx / overloaded. Retried with back-off.
 *              network    — connection dropped. Retried with back-off.
 *              request    — any other 4xx (bad request, model not found…). Not retried.
 *              output     — model answered but with no usable text.
 *   ask() also retries the WHOLE call once for server / network / rate_limit errors that happen mid-stream.
 */
const { fetch, Agent } = require('undici');

// headersTimeout/bodyTimeout 0 = no time limit (long reasoning runs are allowed to finish).
const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0, connectTimeout: 30e3 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = (k, d) => String(process.env[k] || '').trim() || d;
const MOCK = () => process.env.AI_MOCK === 'true';
/** Optional number from ENV; null when unset = no cap. */
const optNum = (k) => { const v = Number(env(k)); return Number.isFinite(v) && v > 0 ? v : null; };

function cfg() {
  return {
    openai: {
      key: env('OPENAI_API_KEY'),
      model: env('OPENAI_MODEL', 'gpt-5.4'),
      effort: env('OPENAI_REASONING_EFFORT', 'high'),
      maxTokens: optNum('OPENAI_MAX_OUTPUT_TOKENS'), // null = no cap (model maximum)
      timeoutMin: optNum('OPENAI_TIMEOUT_MIN'), // null = no time limit
    },
    gemini: {
      key: env('GEMINI_API_KEY'),
      model: env('GEMINI_MODEL', 'gemini-3.1-pro-preview'),
      maxTokens: optNum('GEMINI_MAX_OUTPUT_TOKENS'), // null = no cap (model maximum)
    },
    claude: {
      key: env('ANTHROPIC_API_KEY'),
      model: env('CLAUDE_MODEL', 'claude-opus-5-5'),
      maxTokens: optNum('CLAUDE_MAX_TOKENS') || 128000, // API requires a value: model maximum
    },
  };
}

/* ------------------------------------------------------- error classification */

const BILLING_RE = /insufficient_quota|billing_hard_limit|billing_not_active|credit balance is too low|exceeded your current quota|payment required|check your plan and billing|billing details|account is not active|out of credits?/i;

/** HTTP status + body text -> errorKind (see header). */
function classify(status, body) {
  const b = String(body || '');
  if (status === 402 || BILLING_RE.test(b)) return 'billing';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status >= 500 || /overloaded/i.test(b)) return 'server';
  return 'request';
}

function fail(message, kind) {
  const e = new Error(message);
  e.kind = kind;
  return e;
}

const RETRYABLE = ['rate_limit', 'server', 'network'];

async function http(url, opts, label, tries = 4) {
  let billingRechecked = false;
  for (let i = 1; ; i++) {
    let res;
    try {
      res = await fetch(url, { ...opts, dispatcher });
    } catch (e) {
      if (i < tries && !opts.signal?.aborted) { await sleep(5000 * i); continue; }
      throw fail(`${label}: network error — ${e.message}`, 'network');
    }
    if (res.ok) return res;
    const body = await res.text().catch(() => '');
    const kind = classify(res.status, body);
    // Some providers word short rate limits like quota errors; one short re-check avoids a false alarm.
    if (kind === 'billing' && res.status === 429 && !billingRechecked && i < tries && !opts.signal) {
      billingRechecked = true;
      await sleep(20e3);
      continue;
    }
    if (RETRYABLE.includes(kind) && i < tries) { await sleep(Math.min(60e3, 8000 * i * i)); continue; }
    throw fail(`${label}: HTTP ${res.status} ${body.slice(0, 600)}`, kind);
  }
}

/** Tolerant JSON extraction: strips ``` fences / leading prose. */
function parseJson(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(t); } catch {}
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch {} }
  return null;
}

/* ------------------------------------------------------------------ OpenAI */

async function openaiCall({ system, user, attachments = [] }, c) {
  const content = [{ type: 'input_text', text: user }];
  for (const a of attachments) {
    if (a.mimeType === 'application/pdf') content.push({ type: 'input_file', filename: a.name, file_data: `data:application/pdf;base64,${a.base64}` });
    else content.push({ type: 'input_image', image_url: `data:${a.mimeType};base64,${a.base64}` });
  }
  const headers = { Authorization: `Bearer ${c.key}`, 'Content-Type': 'application/json' };
  const body = {
    model: c.model,
    instructions: system,
    input: [{ role: 'user', content }],
    reasoning: { effort: c.effort },
    ...(c.maxTokens ? { max_output_tokens: c.maxTokens } : {}),
    text: { format: { type: 'json_object' } },
    background: true,
    store: true, // required for background mode
  };
  let r = await (await http('https://api.openai.com/v1/responses', { method: 'POST', headers, body: JSON.stringify(body) }, 'OpenAI')).json();
  const deadline = c.timeoutMin ? Date.now() + c.timeoutMin * 60e3 : Infinity;
  while (['queued', 'in_progress'].includes(r.status)) {
    if (Date.now() > deadline) throw fail(`OpenAI: still ${r.status} after ${c.timeoutMin} min`, 'server');
    await sleep(10e3);
    r = await (await http(`https://api.openai.com/v1/responses/${r.id}`, { headers }, 'OpenAI poll')).json();
  }
  if (r.status !== 'completed' && r.status !== 'incomplete') {
    const detail = JSON.stringify(r.error || r.incomplete_details || {});
    throw fail(`OpenAI: status ${r.status} — ${detail.slice(0, 400)}`, BILLING_RE.test(detail) ? 'billing' : /server_error|overloaded/i.test(detail) ? 'server' : 'request');
  }
  const text = (r.output || [])
    .filter((o) => o.type === 'message')
    .flatMap((o) => o.content || [])
    .filter((x) => x.type === 'output_text')
    .map((x) => x.text)
    .join('');
  if (!text) throw fail(`OpenAI: empty output (${r.status} ${JSON.stringify(r.incomplete_details || {})})`, 'output');
  return { text, usage: r.usage, finish: r.status === 'incomplete' ? `incomplete: ${r.incomplete_details?.reason}` : 'completed', responseId: r.id };
}

/* ------------------------------------------------------------------ Gemini */

async function geminiCall({ system, user, attachments = [] }, c) {
  const parts = [{ text: user }];
  for (const a of attachments) parts.push({ inlineData: { mimeType: a.mimeType, data: a.base64 } });
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts }],
    generationConfig: { responseMimeType: 'application/json', ...(c.maxTokens ? { maxOutputTokens: c.maxTokens } : {}) },
  };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(c.model)}:generateContent`;
  const j = await (await http(url, {
    method: 'POST',
    headers: { 'x-goog-api-key': c.key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, 'Gemini')).json();
  const cand = j.candidates?.[0];
  if (!cand) throw fail(`Gemini: no candidates — ${JSON.stringify(j.promptFeedback || j).slice(0, 400)}`, 'output');
  const text = (cand.content?.parts || []).filter((p) => p.text && !p.thought).map((p) => p.text).join('');
  if (!text) throw fail(`Gemini: empty output (finishReason ${cand.finishReason})`, 'output');
  return { text, usage: j.usageMetadata, finish: cand.finishReason };
}

/* ------------------------------------------------------------------ Claude */

async function claudeCall({ system, user, attachments = [] }, c) {
  const content = [];
  for (const a of attachments) {
    const source = { type: 'base64', media_type: a.mimeType, data: a.base64 };
    content.push(a.mimeType === 'application/pdf' ? { type: 'document', source, title: a.name } : { type: 'image', source });
  }
  content.push({ type: 'text', text: user });
  const res = await http('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': c.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: c.model, max_tokens: c.maxTokens, system, messages: [{ role: 'user', content }], stream: true }),
  }, 'Claude');

  let text = '';
  let usage = {};
  let finish = null;
  let buf = '';
  const decoder = new TextDecoder();
  const handle = (evt) => {
    const data = evt.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
    if (!data) return;
    let d;
    try { d = JSON.parse(data); } catch { return; }
    if (d.type === 'message_start') usage = { ...d.message?.usage };
    else if (d.type === 'content_block_delta' && d.delta?.type === 'text_delta') text += d.delta.text;
    else if (d.type === 'message_delta') { finish = d.delta?.stop_reason; Object.assign(usage, d.usage); }
    else if (d.type === 'error') {
      const t = `${d.error?.type} ${d.error?.message}`;
      throw fail(`Claude stream error: ${t}`, /overloaded|api_error/i.test(t) ? 'server' : BILLING_RE.test(t) ? 'billing' : 'request');
    }
  };
  try {
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 2); }
    }
  } catch (e) {
    if (e.kind) throw e;
    throw fail(`Claude: stream dropped — ${e.message}`, 'network');
  }
  if (buf.trim()) handle(buf);
  if (!text) throw fail(`Claude: empty output (stop_reason ${finish})`, 'output');
  return { text, usage, finish };
}

/* -------------------------------------------------------------------- mock */

function mockText(label, prompt) {
  if (label === 'Claude') {
    return JSON.stringify({
      decision_summary: 'MOCK final decision — pipeline test only.',
      comparison: { chatgpt_found: 'Mock: 1 finding.', gemini_found: 'Mock: 1 finding.', agreement_points: ['Both flagged F1'], disagreements: [], chatgpt_quality: 'n/a', gemini_quality: 'n/a' },
      materiality: { amount: 'SGD 1,000', basis: 'mock' },
      final_findings: [{ id: 'FF1', verdict: 'Confirmed', found_by: ['ChatGPT', 'Gemini'], source_ids: ['A:F1', 'B:F1'], category: 'Duplicate entry', severity: 'Medium', file: 'mock', location: '#2', date: '', account: '', counterparty: '', description: 'Mock', amount: '100.00', issue: 'Mock duplicate', evidence: 'Mock', recommendation: 'Mock', supporting_document_required: 'Invoice', rationale: 'Mock' }],
      rejected_findings: [],
      client_format_output: { columns: ['Ref', 'Amount', 'Result'], rows: [['S1', '100.00', 'Exception']] },
      overall_conclusion: { risk_rating: 'Medium', opinion: 'Mock opinion.', key_concerns: ['Mock'] },
      items_for_human_review: ['Mock item'], questions_for_client: ['Mock question'], limitations: ['Mock run — no real model was called'],
    });
  }
  return JSON.stringify({
    engagement_understanding: `MOCK ${label} review (prompt ${prompt.user.length} chars).`,
    data_overview: { files_reviewed: [], period_covered: 'n/a', currency: 'SGD', total_transactions: 'n/a', total_value: 'n/a' },
    materiality: { amount: 'SGD 1,000', basis: 'mock' },
    methodology: ['mock'],
    sample_selected: [{ ref: 'S1', file: 'mock', location: '#2', date: '', account: '', description: 'Mock', amount: '100.00', reason_selected: 'random' }],
    findings: [{ id: 'F1', category: 'Duplicate entry', severity: 'Medium', file: 'mock', location: '#2', date: '', account: '', counterparty: '', description: 'Mock', amount: '100.00', issue: 'Mock duplicate', evidence: 'Mock', recommendation: 'Mock', supporting_document_required: 'Invoice' }],
    client_format_output: { columns: ['Ref', 'Amount', 'Result'], rows: [['S1', '100.00', 'Exception']] },
    overall_assessment: { risk_rating: 'Medium', summary: 'Mock.', key_concerns: ['Mock'] },
    limitations: ['Mock run'], questions_for_client: [],
  });
}

const mockFails = (label) => String(process.env.AI_MOCK_FAIL || '').split(',').map((s) => s.trim()).includes(label);

/* ---------------------------------------------------------------- wrapper */

const PROVIDERS = {
  ChatGPT: { key: 'openai', fn: openaiCall, envKey: 'OPENAI_API_KEY' },
  Gemini: { key: 'gemini', fn: geminiCall, envKey: 'GEMINI_API_KEY' },
  Claude: { key: 'claude', fn: claudeCall, envKey: 'ANTHROPIC_API_KEY' },
};

/** Always resolves: {label, model, ok, skipped, text, parsed, usage, finish, ms, error, errorKind, attempts} */
async function ask(label, prompt) {
  const p = PROVIDERS[label];
  const c = cfg()[p.key];
  const t0 = Date.now();
  const base = { label, model: c.model, startedAt: new Date().toISOString() };
  if (MOCK()) {
    // AI_MOCK_DELAY_SEC lets the progress page be demoed without real API calls.
    const delay = Number(process.env.AI_MOCK_DELAY_SEC || 0) * ({ ChatGPT: 1, Gemini: 0.35, Claude: 0.6 }[label] || 1) * 1000;
    if (delay > 0) await sleep(delay);
    if (mockFails(label)) return { ...base, ok: false, mock: true, error: `${label}: HTTP 429 (mock) insufficient_quota — credit exhausted`, errorKind: 'billing', ms: Date.now() - t0, attempts: 1 };
    const text = mockText(label, prompt);
    return { ...base, ok: true, mock: true, text, parsed: parseJson(text), ms: Date.now() - t0, attempts: 1 };
  }
  if (!c.key) return { ...base, ok: false, skipped: true, error: `${p.envKey} not set`, errorKind: 'auth', ms: 0, attempts: 0 };
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await p.fn(prompt, c);
      const parsed = parseJson(r.text);
      return { ...base, ok: true, ...r, parsed, parseError: parsed ? null : 'response was not valid JSON', ms: Date.now() - t0, attempts: attempt };
    } catch (e) {
      lastErr = e;
      if (attempt === 1 && RETRYABLE.includes(e.kind)) { await sleep(30e3); continue; }
      break;
    }
  }
  return { ...base, ok: false, error: lastErr.message, errorKind: lastErr.kind || 'request', ms: Date.now() - t0, attempts: lastErr && RETRYABLE.includes(lastErr.kind) ? 2 : 1 };
}

/** Short human text for an errorKind — shown on the progress page and in emails. */
function kindText(kind) {
  return {
    billing: 'Provider credit / quota exhausted',
    auth: 'API key rejected',
    rate_limit: 'Provider busy (rate limit)',
    server: 'Provider error',
    network: 'Connection lost',
    output: 'No usable answer',
    request: 'Request rejected',
  }[kind] || 'Failed';
}

/* ------------------------------------------------- preflight ("Hi" check) */

const PING_TIMEOUT_MS = Number(env('PING_TIMEOUT_SEC', '90')) * 1000;

/**
 * Sends "Hi" to one model with a tiny token budget. Healthy = HTTP 200 from the real
 * generate endpoint (key valid, model reachable, billing OK). Reply text is informational only.
 */
async function ping(label) {
  const p = PROVIDERS[label];
  const c = cfg()[p.key];
  const t0 = Date.now();
  const base = { label, model: c.model, checkedAt: new Date().toISOString() };
  if (MOCK()) return { ...base, ok: true, mock: true, reply: 'mock', ms: 0 };
  if (!c.key) return { ...base, ok: false, error: `${p.envKey} not set`, errorKind: 'auth', ms: 0 };

  const signal = AbortSignal.timeout(PING_TIMEOUT_MS);
  try {
    let reply = '';
    if (label === 'ChatGPT') {
      const j = await (await http('https://api.openai.com/v1/responses', {
        method: 'POST',
        signal,
        headers: { Authorization: `Bearer ${c.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: c.model, input: 'Hi', max_output_tokens: 256, store: false }),
      }, 'OpenAI ping', 2)).json();
      if (j.status === 'failed') throw new Error(`OpenAI ping: status failed — ${JSON.stringify(j.error || {}).slice(0, 300)}`);
      reply = (j.output || []).filter((o) => o.type === 'message').flatMap((o) => o.content || [])
        .filter((x) => x.type === 'output_text').map((x) => x.text).join('');
    } else if (label === 'Gemini') {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(c.model)}:generateContent`;
      const j = await (await http(url, {
        method: 'POST',
        signal,
        headers: { 'x-goog-api-key': c.key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Hi' }] }], generationConfig: { maxOutputTokens: 256 } }),
      }, 'Gemini ping', 2)).json();
      if (!j.candidates?.length) throw new Error(`Gemini ping: no candidates — ${JSON.stringify(j.promptFeedback || j).slice(0, 300)}`);
      reply = (j.candidates[0].content?.parts || []).filter((x) => x.text && !x.thought).map((x) => x.text).join('');
    } else {
      const j = await (await http('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal,
        headers: { 'x-api-key': c.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: c.model, max_tokens: 32, messages: [{ role: 'user', content: 'Hi' }] }),
      }, 'Claude ping', 2)).json();
      reply = (j.content || []).filter((x) => x.type === 'text').map((x) => x.text).join('');
    }
    return { ...base, ok: true, reply: reply.slice(0, 120), ms: Date.now() - t0 };
  } catch (e) {
    const msg = signal.aborted ? `${label} ping: no answer within ${PING_TIMEOUT_MS / 1000} s` : e.message;
    return { ...base, ok: false, error: msg.slice(0, 600), errorKind: signal.aborted ? 'network' : e.kind || 'request', ms: Date.now() - t0 };
  }
}

/** "Hi" to the given models (default all 3) in parallel. Always resolves: {ok, failed:[labels], results:[...]} */
async function preflight(labels = Object.keys(PROVIDERS)) {
  const results = await Promise.all(labels.map(ping));
  const failed = results.filter((r) => !r.ok).map((r) => r.label);
  return { ok: failed.length === 0, failed, checkedAt: new Date().toISOString(), results };
}

/** Checks keys + that each configured model ID exists. Never returns secrets. */
async function healthcheck() {
  const c = cfg();
  const check = async (label, url, headers) => {
    const k = c[PROVIDERS[label].key];
    if (!k.key) return { label, model: k.model, configured: false };
    try {
      await http(url, { headers }, label, 1);
      return { label, model: k.model, configured: true, modelFound: true };
    } catch (e) {
      return { label, model: k.model, configured: true, modelFound: false, error: e.message.slice(0, 300), errorKind: e.kind };
    }
  };
  return {
    mock: MOCK(),
    providers: await Promise.all([
      check('ChatGPT', `https://api.openai.com/v1/models/${encodeURIComponent(c.openai.model)}`, { Authorization: `Bearer ${c.openai.key}` }),
      check('Gemini', `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(c.gemini.model)}`, { 'x-goog-api-key': c.gemini.key }),
      check('Claude', `https://api.anthropic.com/v1/models/${encodeURIComponent(c.claude.model)}`, { 'x-api-key': c.claude.key, 'anthropic-version': '2023-06-01' }),
    ]),
  };
}

module.exports = { ask, ping, preflight, healthcheck, parseJson, cfg, classify, kindText };
