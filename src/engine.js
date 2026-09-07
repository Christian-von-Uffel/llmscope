// Run an eval: expand jobs, shuffle deterministically, call the provider with bounded concurrency, apply checks.
import { normalizeSpec, validateSpec, buildJobs, specId, canonicalSpec } from './spec.js';
import { seededShuffle } from './rng.js';
import { runChecks } from './checks/index.js';

export const VERSION = 'llmscope/0.1';

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
          temperature: spec.temperature, max_tokens: spec.max_tokens,
          seed: spec.seed !== null ? Number(spec.seed) + job.run : null, signal,
        });
      } catch (err) {
        if (err?.name === 'AbortError') return;
        response = { text: '', tokens: 0, finish_reason: 'error', error: String(err.message || err), blocked: false, latency_ms: 0 };
      }
      const checks = await runChecks(response, spec, { judge, job });
      const result = {
        ...job,
        position,
        text: response.text || '',
        tokens: response.tokens ?? 0,
        prompt_tokens: response.prompt_tokens ?? 0,
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

  return {
    version: VERSION,
    id,
    spec,
    provider: provider.name,
    started_at,
    finished_at: new Date().toISOString(),
    aborted: Boolean(signal?.aborted),
    results: results.filter(Boolean),
  };
}
