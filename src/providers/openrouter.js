// OpenRouter chat-completions provider. Bring your own key; works in Node and browsers (OpenRouter allows CORS).
import { fetchModels, billsThinkingSeparately } from '../models.js';

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1';

export function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('');
  return '';
}

const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const isClaude = (model) => /^anthropic\//.test(model);

/**
 * What to send for one model: the `reasoning.effort` (null = nothing) and whether the model will think, which is what
 * earns it the thinking allowance on top of max_tokens. `info` is the catalogue's reasoning entry for the model:
 * null = the model cannot think, undefined = no catalogue available. 'default' sends nothing, so the model behaves as
 * it ships (thinking on where the catalogue says default_enabled). Efforts the model does not list are mapped to the
 * nearest one it does; asking for none/minimal on a model that cannot switch thinking off goes as low as it allows,
 * and sends nothing to a model whose thinking is already off (asking would switch it on).
 */
export function reasoningPlan(model, info, requested = 'default') {
  const wantsDefault = !requested || requested === 'default';
  const wantsOff = requested === 'none' || requested === 'minimal';
  if (info === null) return { effort: null, thinks: false };
  if (info === undefined) {
    // No catalogue. Claude does not think unless asked with at least medium effort; for everyone else trust the
    // request, and give room by default rather than starve a thinker.
    if (wantsDefault) return { effort: null, thinks: !isClaude(model) };
    if (isClaude(model) && ['none', 'minimal', 'low'].includes(requested)) return { effort: null, thinks: false };
    return { effort: requested, thinks: requested !== 'none' };
  }
  const onByDefault = Boolean(info.default_enabled);
  if (wantsDefault) return { effort: null, thinks: onByDefault };
  const supported = info.supported_efforts || [];
  if (!supported.length || supported.includes(requested)) return { effort: requested, thinks: requested !== 'none' };
  if (wantsOff) {
    if (!onByDefault) return { effort: null, thinks: false };
    return { effort: EFFORT_ORDER.find((e) => supported.includes(e)), thinks: true };
  }
  const want = EFFORT_ORDER.indexOf(requested);
  const dist = (e) => Math.abs(EFFORT_ORDER.indexOf(e) - want);
  const nearest = [...supported].sort((a, b) => dist(a) - dist(b) || EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b))[0];
  return { effort: nearest, thinks: nearest !== 'none' };
}

export function createOpenRouterProvider({
  apiKey,
  baseUrl = OPENROUTER_URL,
  referer = 'https://llmscope.dev',
  title = 'llmscope',
  fetchImpl = globalThis.fetch,
  maxRetries = 3,
  models = null, // normalized catalogue from fetchModels(); fetched lazily when omitted
} = {}) {
  if (!apiKey) throw new Error('OpenRouter API key is required (OPENROUTER_API_KEY).');
  let catalogue = null;
  async function reasoningInfo(model) {
    if (!catalogue) {
      catalogue = (async () => {
        const list = models || (await fetchModels({ fetchImpl, url: `${baseUrl}/models` }).catch(() => null));
        return list ? new Map(list.map((m) => [m.id, m])) : null;
      })();
    }
    const map = await catalogue;
    if (!map) return undefined;
    const m = map.get(model);
    return m ? m.reasoning ?? null : undefined;
  }
  return {
    name: 'openrouter',
    async complete({ model, system, prompt, temperature = 0, max_tokens = 400, thinking_budget = 0, reasoning = 'default', seed = null, signal } = {}) {
      const messages = [];
      if (system) messages.push({ role: 'system', content: system });
      messages.push({ role: 'user', content: prompt });
      const plan = reasoningPlan(model, await reasoningInfo(model), reasoning);
      // max_tokens caps prompt-independent output. Thinking counts inside it on most providers, so thinkers get the
      // budget on top; xAI bills thinking separately, so its cap stays the reply cap.
      const cap = max_tokens + (plan.thinks && thinking_budget > 0 && !billsThinkingSeparately(model) ? thinking_budget : 0);
      const body = { model, messages, temperature, max_tokens: cap };
      if (plan.effort) body.reasoning = { effort: plan.effort };
      if (seed !== null && seed !== undefined) body.seed = seed;
      const sent = { max_tokens_sent: cap, reasoning_sent: plan.effort };
      const t0 = Date.now();
      let lastErr = null;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        let res;
        try {
          res = await fetchImpl(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': referer,
              'X-Title': title,
            },
            body: JSON.stringify(body),
            signal,
          });
        } catch (err) {
          if (err?.name === 'AbortError') throw err;
          lastErr = `network: ${err.message}`;
          if (attempt < maxRetries) { await sleep(500 * 2 ** attempt); continue; }
          break;
        }
        if (res.status === 429 || res.status >= 500) {
          lastErr = `HTTP ${res.status}`;
          if (attempt < maxRetries) {
            const retryAfter = Number(res.headers.get('retry-after'));
            await sleep(retryAfter ? retryAfter * 1000 : 800 * 2 ** attempt);
            continue;
          }
          break;
        }
        const json = await res.json().catch(() => null);
        const apiError = json?.error;
        if (!res.ok || apiError) {
          const message = apiError?.message || json?.message || `HTTP ${res.status}`;
          const code = apiError?.code || res.status;
          return {
            text: '', tokens: 0, prompt_tokens: 0, reasoning_tokens: null, cost: null, finish_reason: 'error',
            error: `${code}: ${message}`,
            blocked: /moderat|content|policy|safety|flagged/i.test(message),
            latency_ms: Date.now() - t0, raw: json, ...sent,
          };
        }
        const choice = json?.choices?.[0] || {};
        const text = contentToText(choice.message?.content);
        const apiRefusal = choice.message?.refusal || null;
        const usage = json?.usage || {};
        return {
          text,
          tokens: usage.completion_tokens ?? estimateTokens(text),
          prompt_tokens: usage.prompt_tokens ?? estimateTokens((system || '') + (prompt || '')),
          reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens ?? null,
          cost: typeof usage.cost === 'number' ? usage.cost : null, // USD charged to the account, reported by OpenRouter
          finish_reason: choice.finish_reason || choice.native_finish_reason || null,
          native_finish_reason: choice.native_finish_reason || null,
          api_refusal: apiRefusal,
          provider_name: json?.provider || null,
          error: null,
          blocked: false,
          latency_ms: Date.now() - t0,
          ...sent,
        };
      }
      return { text: '', tokens: 0, prompt_tokens: 0, reasoning_tokens: null, cost: null, finish_reason: 'error', error: lastErr || 'unknown error', blocked: false, latency_ms: Date.now() - t0, ...sent };
    },
  };
}

/** Validate a key and read its usage/limits: GET /auth/key. Never throws. */
export async function checkKey({ apiKey, baseUrl = OPENROUTER_URL, fetchImpl = globalThis.fetch } = {}) {
  if (!apiKey) return { ok: false, error: 'no key' };
  try {
    const res = await fetchImpl(`${baseUrl}/auth/key`, { headers: { Authorization: `Bearer ${apiKey}` } });
    const json = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: json?.error?.message || `HTTP ${res.status}` };
    const d = json?.data || {};
    return { ok: true, label: d.label || null, usage: d.usage ?? null, limit: d.limit ?? null, limit_remaining: d.limit_remaining ?? null, is_free_tier: Boolean(d.is_free_tier) };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}
