// OpenRouter chat-completions provider. Bring your own key; works in Node and browsers (OpenRouter allows CORS).

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

export function createOpenRouterProvider({
  apiKey,
  baseUrl = OPENROUTER_URL,
  referer = 'https://llmscope.dev',
  title = 'llmscope',
  fetchImpl = globalThis.fetch,
  maxRetries = 3,
} = {}) {
  if (!apiKey) throw new Error('OpenRouter API key is required (OPENROUTER_API_KEY).');
  return {
    name: 'openrouter',
    async complete({ model, system, prompt, temperature = 0, max_tokens = 400, seed = null, signal } = {}) {
      const messages = [];
      if (system) messages.push({ role: 'system', content: system });
      messages.push({ role: 'user', content: prompt });
      const body = { model, messages, temperature, max_tokens };
      if (seed !== null && seed !== undefined) body.seed = seed;
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
            text: '', tokens: 0, prompt_tokens: 0, finish_reason: 'error',
            error: `${code}: ${message}`,
            blocked: /moderat|content|policy|safety|flagged/i.test(message),
            latency_ms: Date.now() - t0, raw: json,
          };
        }
        const choice = json?.choices?.[0] || {};
        const text = contentToText(choice.message?.content);
        const apiRefusal = choice.message?.refusal || null;
        return {
          text,
          tokens: json?.usage?.completion_tokens ?? estimateTokens(text),
          prompt_tokens: json?.usage?.prompt_tokens ?? 0,
          finish_reason: choice.finish_reason || choice.native_finish_reason || null,
          native_finish_reason: choice.native_finish_reason || null,
          api_refusal: apiRefusal,
          provider_name: json?.provider || null,
          error: null,
          blocked: false,
          latency_ms: Date.now() - t0,
        };
      }
      return { text: '', tokens: 0, prompt_tokens: 0, finish_reason: 'error', error: lastErr || 'unknown error', blocked: false, latency_ms: Date.now() - t0 };
    },
  };
}
