// Version :071126 00:25
// File    :lib/pricing.js
/**
 * Token usage -> USD cost, per model call.
 *
 * Rates are LIST prices in USD per 1 million tokens (standard tier, prompts under 200k tokens).
 * Reasoning / thinking tokens are billed as output by all three providers and are included below.
 * Override any rate without a code change via ENV, e.g.  PRICE_GPT_5_4="2.5,15"  (input,output).
 *   ENV name = PRICE_ + model id upper-cased with every non-alphanumeric char turned into "_".
 *
 * Costs here are estimates for billing; the provider dashboards are the final authority.
 * The tiny "Hi" health-check calls are not included (well under USD 0.01 per run).
 * 071126: a reviewer answer REUSED by a resume run is shown at USD 0 (it was billed in the earlier run).
 */

const DEFAULT_RATES = {
  'gpt-5.4': { in: 2.5, out: 15 },
  'gemini-3.1-pro-preview': { in: 2, out: 12 },
  'claude-opus-5-5': { in: 4, out: 20 },
};

const envKey = (model) => `PRICE_${String(model).toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;

/** {in, out, source} — USD per 1M tokens, or null if unknown. */
function rateFor(model) {
  const raw = String(process.env[envKey(model)] || '').trim();
  if (raw) {
    const [i, o] = raw.split(',').map(Number);
    if (Number.isFinite(i) && Number.isFinite(o)) return { in: i, out: o, source: envKey(model) };
  }
  const d = DEFAULT_RATES[model];
  return d ? { ...d, source: 'list price' } : null;
}

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * Normalises each provider's usage block to
 * {input, output, reasoning, cachedInput}; output INCLUDES reasoning (that is how it is billed).
 */
function normalise(label, usage) {
  const u = usage || {};
  if (label === 'ChatGPT') {
    return {
      input: n(u.input_tokens),
      output: n(u.output_tokens),
      reasoning: n(u.output_tokens_details?.reasoning_tokens),
      cachedInput: n(u.input_tokens_details?.cached_tokens),
    };
  }
  if (label === 'Gemini') {
    const thoughts = n(u.thoughtsTokenCount);
    return {
      input: n(u.promptTokenCount),
      output: n(u.candidatesTokenCount) + thoughts,
      reasoning: thoughts,
      cachedInput: n(u.cachedContentTokenCount),
    };
  }
  // Claude
  return {
    input: n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens),
    output: n(u.output_tokens),
    reasoning: n(u.output_tokens_details?.thinking_tokens),
    cachedInput: n(u.cache_read_input_tokens),
  };
}

const round = (x, dp = 4) => Math.round(x * 10 ** dp) / 10 ** dp;

/** One model call -> {label, model, ran, input, output, reasoning, rateIn, rateOut, usd, note} */
function costOf(r) {
  const label = r?.label || '?';
  const model = r?.model || '?';
  if (r?.reused) {
    return { label, model, ran: false, input: 0, output: 0, reasoning: 0, rateIn: null, rateOut: null, usd: 0,
      note: `reused from earlier run ${r.reusedFrom || ''} — billed there`.trim() };
  }
  if (!r || r.skipped || r.mock || !r.usage) {
    return { label, model, ran: !!(r && !r.skipped), input: 0, output: 0, reasoning: 0, rateIn: null, rateOut: null, usd: 0,
      note: r?.mock ? 'mock run — no charge' : r?.skipped ? 'not called' : 'no usage reported (call failed before billing, or provider did not report)' };
  }
  const t = normalise(label, r.usage);
  const rate = rateFor(model);
  const usd = rate ? (t.input * rate.in + t.output * rate.out) / 1e6 : null;
  return {
    label, model, ran: true, ...t,
    rateIn: rate?.in ?? null, rateOut: rate?.out ?? null,
    usd: usd == null ? null : round(usd),
    note: rate ? `${rate.source}${t.cachedInput ? '; cached input billed at full rate here (estimate is slightly high)' : ''}` : `no rate set — add ${envKey(model)}="in,out"`,
  };
}

/** All calls of one run -> {rows:[costOf...], totalUsd, totalInput, totalOutput} */
function summarise(results) {
  const rows = results.map(costOf);
  const known = rows.filter((r) => r.usd != null);
  return {
    rows,
    totalUsd: round(known.reduce((s, r) => s + r.usd, 0)),
    totalInput: rows.reduce((s, r) => s + r.input, 0),
    totalOutput: rows.reduce((s, r) => s + r.output, 0),
    complete: known.length === rows.length,
  };
}

module.exports = { rateFor, normalise, costOf, summarise, DEFAULT_RATES };
