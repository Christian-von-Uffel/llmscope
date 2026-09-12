// Run an eval: expand jobs, shuffle deterministically, call the provider with bounded concurrency, apply checks.
import { normalizeSpec, validateSpec, buildJobs, specId, canonicalSpec } from './spec.js';
import { seededShuffle } from './rng.js';
import { runChecks } from './checks/index.js';
import { detectRefusal } from './checks/refusal.js';
import { detectKeywords } from './checks/keywords.js';

const VERSION = 'llmscope/0.1';

export async function planRun(input) {
  const spec = normalizeSpec(input);
  const problems = validateSpec(spec);
  const id = await specId(spec);
  const jobs = buildJobs(spec);
  const seed = spec.seed !== null ? String(spec.seed) : canonicalSpec(spec);
  const order = seededShuffle(jobs.map((_, i) => i), seed);
  return { spec, id, problems, jobs, order };
}

/**
 * @param {object} input spec
 * @param {object} opts
 * @param {{name:string, complete:Function}} opts.provider
 * @param {number} [opts.concurrency]
 * @param {(event:{type:string, done:number, total:number, result?:object}) => void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 * @param {Function} [opts.judge]
 */
export async function runEval(input, { provider, concurrency = 4, onProgress = () => {}, signal, judge = null } = {}) {
  if (!provider) throw new Error('runEval needs a provider');
  const { spec, id, problems, jobs, order } = await planRun(input);
  if (problems.length) throw new Error('Invalid spec: ' + problems.join(' '));
  const total = jobs.length;
  const results = new Array(total);
  let done = 0;
  let cursor = 0;
  const started_at = new Date().toISOString();
  const t0 = Date.now();

  async function worker() {
    while (cursor < order.length) {
      if (signal?.aborted) return;
      const position = cursor++;
      const jobIndex = order[position];
      const job = jobs[jobIndex];
      let response;
      try {
        response = await provider.complete({
          model: job.model, system: spec.system, prompt: job.prompt, run: job.run,
          temperature: spec.temperature, max_tokens: spec.max_tokens, thinking_budget: spec.thinking_budget, reasoning: spec.reasoning,
          seed: spec.seed !== null ? Number(spec.seed) + job.run : null, signal,
        });
      } catch (err) {
        if (err?.name === 'AbortError') return;
        response = { text: '', tokens: 0, finish_reason: 'error', error: String(err.message || err), blocked: false, latency_ms: 0 };
      }
      if (!response.error && !(response.text || '').trim() && response.finish_reason === 'length') {
        response.error = `cut off: used the whole output cap (${response.max_tokens_sent ?? spec.max_tokens} tokens) before answering; thinking models spend it reasoning first — raise the thinking budget`;
      }
      const checks = await runChecks(response, spec, { judge, job });
      const result = {
        ...job,
        position,
        text: response.text || '',
        tokens: response.tokens ?? 0,
        prompt_tokens: response.prompt_tokens ?? 0,
        total_tokens: (response.prompt_tokens ?? 0) + (response.tokens ?? 0), // billed: prompt + completion (thinking included)
        reasoning_tokens: response.reasoning_tokens ?? null,
        cost: typeof response.cost === 'number' ? response.cost : null, // USD, as billed by OpenRouter
        max_tokens_sent: response.max_tokens_sent ?? spec.max_tokens,
        reasoning_sent: response.reasoning_sent ?? null,
        finish_reason: response.finish_reason ?? null,
        provider_name: response.provider_name ?? null,
        latency_ms: response.latency_ms ?? 0,
        error: response.error ?? null,
        ...checks,
      };
      results[jobIndex] = result;
      done += 1;
      onProgress({ type: 'result', done, total, result });
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, total)) }, worker);
  await Promise.all(workers);

  const done_results = results.filter(Boolean);
  const priced = done_results.filter((r) => typeof r.cost === 'number');
  return {
    version: VERSION,
    id,
    spec,
    provider: provider.name,
    started_at,
    finished_at: new Date().toISOString(),
    duration_s: (Date.now() - t0) / 1000, // wall clock seconds for the whole run, including waiting on concurrent requests
    aborted: Boolean(signal?.aborted),
    // What the run cost, summed from OpenRouter's per-reply usage.cost (USD). unpriced = replies with no cost reported (errors, mock).
    cost: { usd: priced.reduce((s, r) => s + r.cost, 0), priced: priced.length, unpriced: done_results.length - priced.length },
    results: done_results,
  };
}

/**
 * Re-apply the deterministic verdicts (refusal rules, keyword matching, cut-off detection) to a saved run, so
 * detector fixes reach old results. Sentiment is left as stored (it may have used a plugin). Returns the number of
 * responses whose verdict changed.
 */
export function rescoreRun(run) {
  const spec = normalizeSpec(run.spec);
  if (run.spec?.reasoning === undefined) spec.reasoning = 'default'; // saved before these settings existed: nothing was sent…
  if (run.spec?.thinking_budget === undefined) spec.thinking_budget = 0; // …and no allowance was added
  let changed = 0;
  for (const r of run.results) {
    const before = `${r.refused}|${r.matched}|${Boolean(r.error)}`;
    if (r.prompt_tokens == null) r.prompt_tokens = 0;
    r.total_tokens = r.prompt_tokens + (r.tokens || 0);
    if (!r.error && !(r.text || '').trim() && r.finish_reason === 'length') {
      r.error = `cut off: used the whole output cap (${r.max_tokens_sent ?? spec.max_tokens} tokens) before answering; thinking models spend it reasoning first — raise the thinking budget`;
    }
    if (!r.judge || typeof r.judge.refused !== 'boolean') {
      const v = detectRefusal({ text: r.text, error: r.error, blocked: false, finish_reason: r.finish_reason, api_refusal: null });
      r.refused = v.refused; r.refusal_reason = v.reason; r.refusal_evidence = v.evidence; r.heuristic_refused = v.refused;
    }
    const k = detectKeywords(r.text, spec.keywords, spec.keyword_mode);
    r.matched = k.matched; r.keyword_hits = k.hits;
    if (before !== `${r.refused}|${r.matched}|${Boolean(r.error)}`) changed += 1;
  }
  run.spec = spec;
  return changed;
}
