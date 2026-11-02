// Version :021126 23:05
// File    :lib/llm.js
/**
 * Direct REST calls (no vendor SDKs) to:
 *   ChatGPT  — OpenAI Responses API, background mode + polling (long reasoning runs survive)
 *   Gemini   — Gemini API generateContent, JSON response mode
 *   Claude   — Anthropic Messages API, streamed (no idle-connection timeouts)
 *
 * Models are env-configurable — model IDs change often; check /healthz/ai after changing them.
 * AI_MOCK=true returns canned JSON so the whole pipeline can be tested without API keys.
 *
 * preflight() sends a tiny "Hi" to all 3 models before the big run (health check).
 */
const { fetch, Agent } = require('undici');

const dispatcher = new Agent({ headersTimeout: 20 * 60e3, bodyTimeout: 20 * 60e3, connectTimeout: 30e3 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = (k, d) => String(process.env[k] || '').trim() || d;
const MOCK = () => process.env.AI_MOCK === 'true';

function cfg() {
  return {
    openai: {
      key: env('OPENAI_API_KEY'),
      model: env('OPENAI_MODEL', 'gpt-5.4'),
      effort: env('OPENAI_REASONING_EFFORT', 'high'),
      maxTokens: Number(env('OPENAI_MAX_OUTPUT_TOKENS', '32000')),
      timeoutMin: Number(env('OPENAI_TIMEOUT_MIN', '40')),
    },
    gemini: {
      key: env('GEMINI_API_KEY'),
      model: env('GEMINI_MODEL', 'gemini-3.1-pro-preview'),
      maxTokens: Number(env('GEMINI_MAX_OUTPUT_TOKENS', '32768')),
    },
    claude: {
      key: env('ANTHROPIC_API_KEY'),
      model: env('CLAUDE_MODEL', 'claude-opus-5-5'),
      maxTokens: Number(env('CLAUDE_MAX_TOKENS', '32000')),
    },
  };
}

async function http(url, opts, label, tries = 3) {
  for (let i = 1; ; i++) {
    let res;
    try {
      res = await fetch(url, { ...opts, dispatcher });
    } catch (e) {
      if (i < tries && !opts.signal?.aborted) { await sleep(5000 * i); continue; }
      throw new Error(`${label}: network error — ${e.message}`);
    }
    if (res.ok) return res;
    const body = await res.text().catch(() => '');
    if ((res.status === 429 || res.status >= 500) && i < tries) { await sleep(Math.min(60e3, 8000 * i * i)); continue; }
    throw new Error(`${label}: HTTP ${res.status} ${body.slice(0, 600)}`);
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
    max_output_tokens: c.maxTokens,
    text: { format: { type: 'json_object' } },
    background: true,
    store: true, // required for background mode
  };
  let r = await (await http('https://api.openai.com/v1/responses', { method: 'POST', headers, body: JSON.stringify(body) }, 'OpenAI')).json();
  const deadline = Date.now() + c.timeoutMin * 60e3;
  while (['queued', 'in_progress'].includes(r.status)) {
    if (Date.now() > deadline) throw new Error(`OpenAI: still ${r.status} after ${c.timeoutMin} min`);
    await sleep(10e3);
    r = await (await http(`https://api.openai.com/v1/responses/${r.id}`, { headers }, 'OpenAI poll')).json();
  }
  if (r.status !== 'completed' && r.status !== 'incomplete') {
    throw new Error(`OpenAI: status ${r.status} — ${JSON.stringify(r.error || r.incomplete_details || {}).slice(0, 400)}`);
  }
  const text = (r.output || [])
    .filter((o) => o.type === 'message')
    .flatMap((o) => o.content || [])
    .filter((x) => x.type === 'output_text')
    .map((x) => x.text)
    .join('');
  if (!text) throw new Error(`OpenAI: empty output (${r.status} ${JSON.stringify(r.incomplete_details || {})})`);
  return { text, usage: r.usage, finish: r.status === 'incomplete' ? `incomplete: ${r.incomplete_details?.reason}` : 'completed', responseId: r.id };
}

/* ------------------------------------------------------------------ Gemini */

async function geminiCall({ system, user, attachments = [] }, c) {
  const parts = [{ text: user }];
  for (const a of attachments) parts.push({ inlineData: { mimeType: a.mimeType, data: a.base64 } });
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts }],
    generationConfig: { responseMimeType: 'application/json', maxOutputTokens: c.maxTokens },
  };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(c.model)}:generateContent`;
  const j = await (await http(url, {
    method: 'POST',
    headers: { 'x-goog-api-key': c.key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, 'Gemini')).json();
  const cand = j.candidates?.[0];
  if (!cand) throw new Error(`Gemini: no candidates — ${JSON.stringify(j.promptFeedback || j).slice(0, 400)}`);
  const text = (cand.content?.parts || []).filter((p) => p.text && !p.thought).map((p) => p.text).join('');
  if (!text) throw new Error(`Gemini: empty output (finishReason ${cand.finishReason})`);
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
    else if (d.type === 'error') throw new Error(`Claude stream error: ${d.error?.type} ${d.error?.message}`);
  };
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 2); }
  }
  if (buf.trim()) handle(buf);
  if (!text) throw new Error(`Claude: empty output (stop_reason ${finish})`);
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

/* ---------------------------------------------------------------- wrapper */

const PROVIDERS = {
  ChatGPT: { key: 'openai', fn: openaiCall, envKey: 'OPENAI_API_KEY' },
  Gemini: { key: 'gemini', fn: geminiCall, envKey: 'GEMINI_API_KEY' },
  Claude: { key: 'claude', fn: claudeCall, envKey: 'ANTHROPIC_API_KEY' },
};

/** Always resolves: {label, model, ok, skipped, text, parsed, usage, finish, ms, error} */
async function ask(label, prompt) {
  const p = PROVIDERS[label];
  const c = cfg()[p.key];
  const t0 = Date.now();
  const base = { label, model: c.model, startedAt: new Date().toISOString() };
  if (MOCK()) {
    const text = mockText(label, prompt);
    return { ...base, ok: true, mock: true, text, parsed: parseJson(text), ms: Date.now() - t0 };
  }
  if (!c.key) return { ...base, ok: false, skipped: true, error: `${p.envKey} not set`, ms: 0 };
  try {
    const r = await p.fn(prompt, c);
    const parsed = parseJson(r.text);
    return { ...base, ok: true, ...r, parsed, parseError: parsed ? null : 'response was not valid JSON', ms: Date.now() - t0 };
  } catch (e) {
    return { ...base, ok: false, error: e.message, ms: Date.now() - t0 };
  }
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
  if (!c.key) return { ...base, ok: false, error: `${p.envKey} not set`, ms: 0 };

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
    return { ...base, ok: false, error: msg.slice(0, 600), ms: Date.now() - t0 };
  }
}

/** "Hi" to all 3 models in parallel. Always resolves: {ok, failed:[labels], results:[...]} */
async function preflight() {
  const results = await Promise.all(Object.keys(PROVIDERS).map(ping));
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
      return { label, model: k.model, configured: true, modelFound: false, error: e.message.slice(0, 300) };
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

module.exports = { ask, ping, preflight, healthcheck, parseJson, cfg };
