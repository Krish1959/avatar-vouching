// Version :111126  22:10
// File    :lib/llm.js
/**
 * Direct REST calls (no vendor SDKs) to:
 *   ChatGPT  — OpenAI Responses API, background mode + polling (long reasoning runs survive)
 *   Gemini   — Gemini API streamGenerateContent (SSE), JSON response mode   ← streamed from 111126
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
 *              aborted    — stopped by the user (ABORT button). Never retried.          ← 111126
 *   ask() also retries the WHOLE call once for server / network / rate_limit errors that happen mid-stream.
 *
 * ABORT (111126): ask(label, prompt, {signal}). When the signal fires:
 *   ChatGPT — the background response is cancelled at OpenAI (POST /v1/responses/{id}/cancel).
 *   Gemini  — the stream is closed; generation stops.
 *   Claude  — the stream is closed; generation stops.
 *   Tokens generated up to the stop are still billed. ask() resolves {ok:false, aborted:true, usage?}
 *   with whatever usage the provider reported; Claude output is estimated from the text received.
 */
const { fetch, Agent } = require('undici');

// headersTimeout/bodyTimeout 0 = no time limit (long reasoning runs are allowed to finish).
const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0, connectTimeout: 30e3 });
const env = (k, d) => String(process.env[k] || '').trim() || d;
const MOCK = () => process.env.AI_MOCK === 'true';
/** Optional number from ENV; null when unset = no cap. */
const optNum = (k) => { const v = Number(env(k)); return Number.isFinite(v) && v > 0 ? v : null; };

function fail(message, kind) {
  const e = new Error(message);
  e.kind = kind;
  return e;
}
const abortedError = (label = 'Model') => fail(`${label}: stopped by user`, 'aborted');

/** Sleep that ends early (throws 'aborted') when the signal fires. */
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(abortedError());
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(abortedError()); }, { once: true });
});

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

const RETRYABLE = ['rate_limit', 'server', 'network'];

/**
 * fetch with retries. opts.signal stops it ('aborted'); opts.quick (health-check pings) skips the billing re-check.
 */
async function http(url, opts, label, tries = 4) {
  const { quick, ...fopts } = opts;
  const signal = fopts.signal;
  let billingRechecked = false;
  for (let i = 1; ; i++) {
    let res;
    try {
      res = await fetch(url, { ...fopts, dispatcher });
    } catch (e) {
      if (signal?.aborted) throw quick ? fail(`${label}: timed out`, 'network') : abortedError(label);
      if (i < tries) { await sleep(5000 * i, signal); continue; }
      throw fail(`${label}: network error — ${e.message}`, 'network');
    }
    if (res.ok) return res;
    const body = await res.text().catch(() => '');
    const kind = classify(res.status, body);
    // Some providers word short rate limits like quota errors; one short re-check avoids a false alarm.
    if (kind === 'billing' && res.status === 429 && !billingRechecked && i < tries && !quick) {
      billingRechecked = true;
      await sleep(20e3, signal);
      continue;
    }
    if (RETRYABLE.includes(kind) && i < tries) { await sleep(Math.min(60e3, 8000 * i * i), signal); continue; }
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

/** Reads an SSE body, calling handle(dataJsonText) per event. Normalises \r\n. */
async function readSse(body, handle) {
  const decoder = new TextDecoder();
  let buf = '';
  const flush = (evt) => {
    const data = evt.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
    if (data && data !== '[DONE]') handle(data);
  };
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) { flush(buf.slice(0, i)); buf = buf.slice(i + 2); }
  }
  if (buf.trim()) flush(buf);
}

/* ------------------------------------------------------------------ OpenAI */

async function openaiCall({ system, user, attachments = [] }, c, signal) {
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
  let r = await (await http('https://api.openai.com/v1/responses', { method: 'POST', headers, body: JSON.stringify(body), signal }, 'OpenAI')).json();
  const deadline = c.timeoutMin ? Date.now() + c.timeoutMin * 60e3 : Infinity;
  try {
    while (['queued', 'in_progress'].includes(r.status)) {
      if (Date.now() > deadline) throw fail(`OpenAI: still ${r.status} after ${c.timeoutMin} min`, 'server');
      await sleep(10e3, signal);
      r = await (await http(`https://api.openai.com/v1/responses/${r.id}`, { headers, signal }, 'OpenAI poll')).json();
    }
  } catch (e) {
    // ABORT: cancel the background job at OpenAI so it stops generating (and billing).
    if (e.kind === 'aborted' && r?.id) {
      const stop = abortedError('OpenAI');
      try {
        const cj = await (await http(`https://api.openai.com/v1/responses/${r.id}/cancel`, { method: 'POST', headers, quick: true }, 'OpenAI cancel', 2)).json();
        stop.usage = cj.usage || null;
      } catch (ce) {
        console.error(`[llm] OpenAI cancel of ${r.id} failed:`, ce.message);
        stop.cancelFailed = true;
      }
      stop.responseId = r.id;
      throw stop;
    }
    throw e;
  }
  if (r.status === 'cancelled') { const stop = abortedError('OpenAI'); stop.usage = r.usage || null; throw stop; }
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

/** Streamed (SSE) so an abort really stops generation. */
async function geminiCall({ system, user, attachments = [] }, c, signal) {
  const parts = [{ text: user }];
  for (const a of attachments) parts.push({ inlineData: { mimeType: a.mimeType, data: a.base64 } });
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts }],
    generationConfig: { responseMimeType: 'application/json', ...(c.maxTokens ? { maxOutputTokens: c.maxTokens } : {}) },
  };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(c.model)}:streamGenerateContent?alt=sse`;
  const res = await http(url, {
    method: 'POST',
    headers: { 'x-goog-api-key': c.key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  }, 'Gemini');

  let text = '';
  let usage = null;
  let finish = null;
  let blocked = null;
  const handle = (data) => {
    let d;
    try { d = JSON.parse(data); } catch { return; }
    if (d.error) throw fail(`Gemini stream error: ${d.error.status || ''} ${d.error.message || ''}`, d.error.code >= 500 ? 'server' : BILLING_RE.test(d.error.message) ? 'billing' : 'request');
    if (d.promptFeedback?.blockReason) blocked = d.promptFeedback;
    const cand = d.candidates?.[0];
    if (cand) {
      for (const p of cand.content?.parts || []) if (p.text && !p.thought) text += p.text;
      if (cand.finishReason) finish = cand.finishReason;
    }
    if (d.usageMetadata) usage = d.usageMetadata;
  };
  try {
    await readSse(res.body, handle);
  } catch (e) {
    if (signal?.aborted) { const stop = abortedError('Gemini'); stop.usage = usage; stop.usageEstimated = true; throw stop; }
    if (e.kind) throw e;
    throw fail(`Gemini: stream dropped — ${e.message}`, 'network');
  }
  if (!text) throw fail(blocked ? `Gemini: no candidates — ${JSON.stringify(blocked).slice(0, 400)}` : `Gemini: empty output (finishReason ${finish})`, 'output');
  return { text, usage, finish };
}

/* ------------------------------------------------------------------ Claude */

async function claudeCall({ system, user, attachments = [] }, c, signal) {
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
    signal,
  }, 'Claude');

  let text = '';
  let usage = {};
  let finish = null;
  const handle = (data) => {
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
    await readSse(res.body, handle);
  } catch (e) {
    if (signal?.aborted) {
      // Input is known from message_start; output is estimated from the text received (≈4 chars/token).
      // Thinking tokens are not visible in the stream, so the real output may be higher.
      const stop = abortedError('Claude');
      stop.usage = { ...usage, output_tokens: Math.max(Number(usage.output_tokens) || 0, Math.ceil(text.length / 4)) };
      stop.usageEstimated = true;
      throw stop;
    }
    if (e.kind) throw e;
    throw fail(`Claude: stream dropped — ${e.message}`, 'network');
  }
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
      coverage: { mode: 'full', ledger_lines_total: 1, lines_tested: 1, untested_line_ids: [], reconciliation: 'mock' },
      final_findings: [{ id: 'FF1', verdict: 'Confirmed', found_by: ['ChatGPT', 'Gemini'], source_ids: ['A:F1', 'B:F1'], category: 'Duplicate entry', severity: 'Medium', file: 'mock', location: '1-L0001', date: '', account: '', counterparty: '', description: 'Mock', amount: '100.00', issue: 'Mock duplicate', evidence: 'Mock', recommendation: 'Mock', supporting_document_required: 'Invoice', rationale: 'Mock' }],
      rejected_findings: [],
      client_format_output: { columns: ['Line ID', 'Amount', 'Result'], rows: [['1-L0001', '100.00', 'Exception']] },
      financial_statements: { status: 'NOT_REQUESTED' },
      overall_conclusion: { risk_rating: 'Medium', opinion: 'Mock opinion.', key_concerns: ['Mock'] },
      items_for_human_review: ['Mock item'], questions_for_client: ['Mock question'], limitations: ['Mock run — no real model was called'],
    });
  }
  return JSON.stringify({
    engagement_understanding: `MOCK ${label} review (prompt ${prompt.user.length} chars).`,
    data_overview: { files_reviewed: [], period_covered: 'n/a', currency: 'SGD', total_transactions: 'n/a' },
    materiality: { amount: 'SGD 1,000', basis: 'mock' },
    methodology: ['mock'],
    coverage: { mode: 'full', ledger_lines_total: 1, lines_tested: 1, untested_line_ids: [], reconciliation: 'mock' },
    findings: [{ id: 'F1', category: 'Duplicate entry', severity: 'Medium', file: 'mock', location: '1-L0001', date: '', account: '', counterparty: '', description: 'Mock', amount: '100.00', issue: 'Mock duplicate', evidence: 'Mock', recommendation: 'Mock', supporting_document_required: 'Invoice' }],
    client_format_output: { columns: ['Line ID', 'Amount', 'Result'], rows: [['1-L0001', '100.00', 'Exception']] },
    financial_statements: { status: 'NOT_REQUESTED' },
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

/**
 * Always resolves: {label, model, ok, skipped, aborted, text, parsed, usage, finish, ms, error, errorKind, attempts}
 * @param opts.signal AbortSignal — the ABORT button. Never retried once it fires.
 */
async function ask(label, prompt, opts = {}) {
  const { signal } = opts;
  const p = PROVIDERS[label];
  const c = cfg()[p.key];
  const t0 = Date.now();
  const base = { label, model: c.model, startedAt: new Date().toISOString() };
  const stopped = (attempts, e) => ({
    ...base, ok: false, aborted: true, error: 'Stopped by user', errorKind: 'aborted',
    usage: e?.usage || undefined, usageEstimated: !!e?.usageEstimated, cancelFailed: !!e?.cancelFailed,
    ms: Date.now() - t0, attempts,
  });
  if (signal?.aborted) return stopped(0);
  if (MOCK()) {
    // AI_MOCK_DELAY_SEC lets the progress page (and ABORT) be demoed without real API calls.
    const delay = Number(process.env.AI_MOCK_DELAY_SEC || 0) * ({ ChatGPT: 1, Gemini: 0.35, Claude: 0.6 }[label] || 1) * 1000;
    if (delay > 0) { try { await sleep(delay, signal); } catch { return { ...stopped(1), mock: true }; } }
    if (mockFails(label)) return { ...base, ok: false, mock: true, error: `${label}: HTTP 429 (mock) insufficient_quota — credit exhausted`, errorKind: 'billing', ms: Date.now() - t0, attempts: 1 };
    const text = mockText(label, prompt);
    return { ...base, ok: true, mock: true, text, parsed: parseJson(text), ms: Date.now() - t0, attempts: 1 };
  }
  if (!c.key) return { ...base, ok: false, skipped: true, error: `${p.envKey} not set`, errorKind: 'auth', ms: 0, attempts: 0 };
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await p.fn(prompt, c, signal);
      const parsed = parseJson(r.text);
      return { ...base, ok: true, ...r, parsed, parseError: parsed ? null : 'response was not valid JSON', ms: Date.now() - t0, attempts: attempt };
    } catch (e) {
      lastErr = e;
      if (e.kind === 'aborted' || signal?.aborted) return stopped(attempt, e);
      if (attempt === 1 && RETRYABLE.includes(e.kind)) {
        try { await sleep(30e3, signal); } catch { return stopped(attempt, e); }
        continue;
      }
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
    aborted: 'Stopped by user',
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
        quick: true,
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
        quick: true,
        headers: { 'x-goog-api-key': c.key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Hi' }] }], generationConfig: { maxOutputTokens: 256 } }),
      }, 'Gemini ping', 2)).json();
      if (!j.candidates?.length) throw new Error(`Gemini ping: no candidates — ${JSON.stringify(j.promptFeedback || j).slice(0, 300)}`);
      reply = (j.candidates[0].content?.parts || []).filter((x) => x.text && !x.thought).map((x) => x.text).join('');
    } else {
      const j = await (await http('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal,
        quick: true,
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
      await http(url, { headers, quick: true }, label, 1);
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
