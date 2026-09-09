// OpenRouter model catalogue: live list, "latest frontier model per provider" defaults, cost estimates.
// Works in Node and browsers (the list endpoint is public and allows CORS).

export const MODELS_URL = 'https://openrouter.ai/api/v1/models';

export const MAIN_PROVIDERS = [
  { prefix: 'openai', name: 'OpenAI' },
  { prefix: 'anthropic', name: 'Anthropic' },
  { prefix: 'google', name: 'Google' },
  { prefix: 'x-ai', name: 'xAI' },
  { prefix: 'meta-llama', name: 'Meta' },
  { prefix: 'mistralai', name: 'Mistral' },
  { prefix: 'deepseek', name: 'DeepSeek' },
  { prefix: 'qwen', name: 'Qwen' },
  { prefix: 'moonshotai', name: 'Moonshot' },
  { prefix: 'z-ai', name: 'Z.ai' },
];

// Curated flagship per provider. Verified against the live list on 2026-09-06; pickFrontier() re-validates at
// runtime and falls back to the newest chat model of that provider when an ID disappears.
export const FRONTIER_DEFAULTS = [
  'openai/gpt-6-astra',
  'anthropic/claude-fable-5.1',
  'google/gemini-3.8-flash',
  'x-ai/grok-4.6',
  'meta-llama/llama-4-maverick',
  'mistralai/mistral-medium-3-5',
  'deepseek/deepseek-v4-pro-0813',
  'qwen/qwen3.8-max-0902',
];

// Nothing we can send a text prompt to at all: wrong modality, or not a chat route. Tested against the part after "provider/".
const NOT_RUNNABLE = /guard|safety|embed|moderation|rerank|-image|audio|tts|transcribe|realtime|lyria|imagen|veo|whisper/i;
// Runnable, but below the flagship tier: small and cheap variants, previews, task-specific models.
const NOT_FLAGSHIP = /vision-exp|search|codex|-code\b|-build|multi-agent|-lite\b|-nano\b|-mini\b|-micro\b|preview|\bexp\b|customtools|chat-latest/i;

export function normalizeModel(raw) {
  const [provider] = raw.id.split('/');
  const out = raw.architecture?.output_modalities || ['text'];
  return {
    id: raw.id,
    name: raw.name || raw.id,
    provider,
    created: Number(raw.created) || 0,
    context_length: raw.context_length || raw.top_provider?.context_length || 0,
    pricing: { prompt: Number(raw.pricing?.prompt) || 0, completion: Number(raw.pricing?.completion) || 0 },
    output_text: out.includes('text') && out.length === 1,
    // OpenRouter's reasoning entry: whether the model thinks out of the box and which efforts it accepts. null = cannot think.
    reasoning: raw.reasoning
      ? { mandatory: Boolean(raw.reasoning.mandatory), default_enabled: Boolean(raw.reasoning.default_enabled), supported_efforts: raw.reasoning.supported_efforts || [], default_effort: raw.reasoning.default_effort || null }
      : null,
    thinks_by_default: Boolean(raw.reasoning?.default_enabled),
  };
}

/** xAI bills thinking on top of max_tokens (a 400-token cap has been billed at 2,474 tokens); everyone else counts it inside. */
export function billsThinkingSeparately(model) {
  return /^x-ai\//.test(model);
}

/**
 * Every model an eval can actually be sent to, at any tier: the pool family and provider selectors draw from.
 * Excludes ":" variant routes and "~" floating aliases (~openai/gpt-latest), which only duplicate a concrete
 * model in the same run. An alias typed as an exact ID is still honoured.
 */
export function isRunnableModel(m) {
  const slug = m.id.split('/')[1] || m.id;
  return m.output_text && !m.id.includes(':') && !m.id.startsWith('~') && !NOT_RUNNABLE.test(slug);
}

/** The flagship tier of isRunnableModel: what the defaults and the per-provider lists are drawn from. */
export function isChatModel(m) {
  const slug = m.id.split('/')[1] || m.id;
  return isRunnableModel(m) && !NOT_FLAGSHIP.test(slug);
}

/**
 * The family a model belongs to: its name with the version stripped.
 * x-ai/grok-4.6 -> grok · google/gemini-3.8-flash -> gemini · qwen/qwen3.8-max-0902 -> qwen
 */
export function modelFamily(id) {
  const slug = String(id).split('/')[1] || String(id);
  const first = slug.toLowerCase().split('-')[0];
  const stem = first.replace(/[\d.].*$/, '');
  return stem.length >= 2 ? stem : first; // keep short names that are all version, like o1
}

// Provider by prefix or display name: "xai" and "x-ai" both mean x-ai, "meta" means meta-llama.
const PROVIDER_ALIAS = new Map();
for (const p of MAIN_PROVIDERS) {
  PROVIDER_ALIAS.set(p.prefix, p.prefix);
  PROVIDER_ALIAS.set(p.name.toLowerCase().replace(/[^a-z0-9]/g, ''), p.prefix);
}

function globToRe(pattern) {
  const body = pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${body}$`, 'i');
}

/** Does a model's slug belong to family `term`? grok matches grok-4.6 and grok-3-mini; qwen matches qwen3.8-max. */
function inFamily(id, term) {
  const slug = (String(id).split('/')[1] || String(id)).toLowerCase();
  if (!slug.startsWith(term)) return false;
  const next = slug[term.length];
  return next === undefined || next === '-' || next === '.' || /\d/.test(next);
}

/**
 * Turn what a user typed into concrete OpenRouter IDs, against the live catalogue.
 *
 *   openai/gpt-6-astra   an exact ID — kept as typed, even when the catalogue is unavailable
 *   google/*             every model of one provider
 *   x-ai/grok-4*         a glob over IDs
 *   google · xai         a provider, by prefix or display name
 *   gemini · grok-4      a family, matched on the name before the version
 *
 * Family, provider and glob selectors expand over every runnable model — mini, lite and preview tiers
 * included, since "the rest of the family" is the whole point of asking for one. Prefix `family:` or
 * `provider:` to force a reading when a word could be either.
 *
 * @returns {{ids: string[], expansions: Array<{selector: string, kind: string, ids: string[]}>, unmatched: string[]}}
 */
export function resolveModels(selectors, models = []) {
  const pool = (models || []).filter(isRunnableModel).sort((a, b) => b.created - a.created || a.id.localeCompare(b.id));
  const known = new Set(pool.map((m) => m.id));
  const ids = [];
  const expansions = [];
  const unmatched = [];
  const add = (id) => { if (!ids.includes(id)) ids.push(id); };

  for (const raw of selectors || []) {
    const sel = String(raw).trim();
    if (!sel) continue;
    const forced = /^family:/i.test(sel) ? 'family' : /^provider:/i.test(sel) ? 'provider' : null;
    const term = sel.replace(/^(family|provider):/i, '').toLowerCase();
    let kind;
    let matched;
    if (term.includes('*')) {
      kind = 'glob';
      const re = globToRe(term);
      // A glob with a provider in it matches the whole ID (x-ai/grok-4*); one without matches the name (grok-4*).
      matched = pool.filter((m) => re.test(term.includes('/') ? m.id : m.id.split('/')[1] || m.id));
    } else if (!forced && term.includes('/')) {
      kind = 'id';
      matched = pool.filter((m) => m.id.toLowerCase() === term);
      if (!matched.length) { add(sel); expansions.push({ selector: sel, kind, ids: [sel] }); continue; } // unlisted or brand new: trust the user
    } else {
      const prefix = forced === 'family' ? null : PROVIDER_ALIAS.get(term) || (pool.some((m) => m.provider === term) ? term : null);
      kind = prefix ? 'provider' : 'family';
      matched = prefix ? pool.filter((m) => m.provider === prefix) : pool.filter((m) => inFamily(m.id, term));
    }
    if (!matched.length) { unmatched.push(sel); continue; }
    matched.forEach((m) => add(m.id));
    expansions.push({ selector: sel, kind, ids: matched.map((m) => m.id) });
  }
  return { ids, expansions, unmatched, catalogue: known.size };
}

/** Drop from `ids` everything the selectors resolve to. Used by --drop-models. */
export function subtractModels(ids, selectors, models = []) {
  if (!selectors?.length) return { ids: [...ids], removed: [], unmatched: [] };
  const { ids: hit, unmatched } = resolveModels(selectors, models);
  const drop = new Set(hit);
  return { ids: ids.filter((id) => !drop.has(id)), removed: ids.filter((id) => drop.has(id)), unmatched };
}

export async function fetchModels({ fetchImpl = globalThis.fetch, signal, url = MODELS_URL } = {}) {
  const res = await fetchImpl(url, { signal });
  if (!res.ok) throw new Error(`model list HTTP ${res.status}`);
  const json = await res.json();
  return (json.data || []).map(normalizeModel);
}

/** Newest chat models for each provider prefix: [{ prefix, name, models: [...] }] */
export function newestPerProvider(models, providers = MAIN_PROVIDERS.map((p) => p.prefix), n = 3) {
  return providers.map((prefix) => ({
    prefix,
    name: MAIN_PROVIDERS.find((p) => p.prefix === prefix)?.name || prefix,
    models: models
      .filter((m) => m.provider === prefix && isChatModel(m))
      .sort((a, b) => b.created - a.created || a.id.length - b.id.length)
      .slice(0, n),
  }));
}

/** Frontier default IDs: curated where still listed, otherwise the newest chat model of that provider. */
export function pickFrontier(models, providers = MAIN_PROVIDERS.slice(0, 8).map((p) => p.prefix)) {
  if (!models?.length) return FRONTIER_DEFAULTS.filter((id) => providers.some((p) => id.startsWith(p + '/')));
  const ids = new Set(models.map((m) => m.id));
  const picked = [];
  for (const prefix of providers) {
    const curated = FRONTIER_DEFAULTS.find((id) => id.startsWith(prefix + '/'));
    if (curated && ids.has(curated)) { picked.push(curated); continue; }
    const newest = newestPerProvider(models, [prefix], 1)[0].models[0];
    if (newest) picked.push(newest.id);
  }
  return picked;
}

// What a reply usually costs in tokens: a short answer, plus a stretch of thinking for models that think by default.
export const TYPICAL = { reply: 200, thinking: 1200 };

/**
 * Spend for a plan. "typical" assumes TYPICAL-sized replies; "high" assumes every reply uses its whole budget
 * (max_tokens, plus the thinking budget for models that think by default); "low" assumes ~60-token replies.
 * @param {{jobs: Array, spec: object}} plan from planRun()
 */
export function estimateCost(plan, models) {
  const byId = new Map((models || []).map((m) => [m.id, m]));
  let low = 0;
  let typical = 0;
  let high = 0;
  const perModel = {};
  const unknown = new Set();
  for (const job of plan.jobs) {
    const m = byId.get(job.model);
    if (!m) { unknown.add(job.model); continue; }
    const promptTokens = Math.ceil(((plan.spec.system || '').length + job.prompt.length) / 4) + 8;
    const input = promptTokens * m.pricing.prompt;
    const budget = m.thinks_by_default ? plan.spec.thinking_budget || 0 : 0;
    const hi = input + (plan.spec.max_tokens + budget) * m.pricing.completion;
    const typ = input + (Math.min(TYPICAL.reply, plan.spec.max_tokens) + (m.thinks_by_default ? TYPICAL.thinking : 0)) * m.pricing.completion;
    const lo = input + Math.min(60, plan.spec.max_tokens) * m.pricing.completion;
    low += lo;
    typical += typ;
    high += hi;
    perModel[job.model] = (perModel[job.model] || 0) + hi;
  }
  return { requests: plan.jobs.length, low, typical, high, perModel, unknown: [...unknown] };
}

export function formatUsd(x) {
  if (!(x > 0)) return '$0.00';
  return x < 0.01 ? '<$0.01' : `$${x.toFixed(2)}`;
}

export function priceLabel(m) {
  if (!m?.pricing) return '';
  return `$${(m.pricing.prompt * 1e6).toFixed(2)} in / $${(m.pricing.completion * 1e6).toFixed(2)} out per M tokens`;
}
