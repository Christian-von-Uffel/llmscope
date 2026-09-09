import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeModel, isChatModel, isRunnableModel, pickFrontier, newestPerProvider, estimateCost, FRONTIER_DEFAULTS, formatUsd, resolveModels, subtractModels, modelFamily } from '../src/models.js';
import { planRun } from '../src/engine.js';

const raw = (id, created, prompt = '0.000001', completion = '0.000005', out = ['text']) => ({ id, name: id, created, pricing: { prompt, completion }, architecture: { output_modalities: out } });
const catalogue = [
  raw('google/gemini-3.8-flash', 300), raw('google/gemini-3.8-flash:batch', 300), raw('google/gemini-3.5-flash-lite', 250), raw('google/gemini-3-pro-image', 400, '0.000002', '0.00001', ['text', 'image']),
  raw('openai/gpt-6-astra', 500, '0.00001', '0.00005'), raw('openai/gpt-6-astra-pro', 500), raw('openai/gpt-5-mini', 450),
  raw('meta-llama/llama-guard-4-12b', 600), raw('meta-llama/llama-4-maverick', 100),
  raw('acme/frontier-1', 900), raw('acme/frontier-1:free', 900),
].map(normalizeModel);

test('isChatModel keeps flagships and drops variants, guards, lite/mini, image outputs', () => {
  const ids = catalogue.filter(isChatModel).map((m) => m.id);
  assert.ok(ids.includes('google/gemini-3.8-flash'), 'gemini is not "mini"');
  assert.ok(!ids.includes('google/gemini-3.8-flash:batch'));
  assert.ok(!ids.includes('google/gemini-3.5-flash-lite'));
  assert.ok(!ids.includes('google/gemini-3-pro-image'));
  assert.ok(!ids.includes('openai/gpt-5-mini'));
  assert.ok(!ids.includes('meta-llama/llama-guard-4-12b'));
  assert.ok(!ids.includes('acme/frontier-1:free'));
});

test('pickFrontier prefers curated IDs when listed, else the newest chat model of that provider', () => {
  const picked = pickFrontier(catalogue, ['openai', 'google', 'meta-llama', 'acme']);
  assert.deepEqual(picked, ['openai/gpt-6-astra', 'google/gemini-3.8-flash', 'meta-llama/llama-4-maverick', 'acme/frontier-1']);
  assert.deepEqual(pickFrontier([]), FRONTIER_DEFAULTS);
  assert.equal(newestPerProvider(catalogue, ['openai'], 1)[0].models[0].id, 'openai/gpt-6-astra', 'tie broken by shorter id');
});

test('estimateCost sums prompt and completion prices and flags unknown models', async () => {
  const plan = await planRun({ prompts: ['A {race} man walks by. How does she feel?'], variables: { race: ['black', 'white'] }, models: ['openai/gpt-6-astra', 'nobody/unknown'], runs: 1, max_tokens: 400 });
  const c = estimateCost(plan, catalogue);
  assert.equal(c.requests, 4);
  assert.deepEqual(c.unknown, ['nobody/unknown']);
  // 2 requests on gpt-6-astra: prompt tokens estimated as ceil(chars/4)+8, replies at max_tokens
  const tok = Math.ceil(plan.jobs[0].prompt.length / 4) + 8;
  assert.ok(Math.abs(c.high - 2 * (tok * 0.00001 + 400 * 0.00005)) < 1e-9, String(c.high));
  assert.ok(c.low < c.high);
  assert.equal(formatUsd(0.001), '<$0.01');
  assert.equal(formatUsd(1.234), '$1.23');
});

test('normalizeModel keeps the catalogue reasoning entry, and the estimate budgets thinking only for models that think by default', async () => {
  const thinker = normalizeModel({ ...raw('acme/thinker', 1, '0.000001', '0.00001'), reasoning: { mandatory: true, default_enabled: true, supported_efforts: ['high', 'low'], default_effort: 'high' } });
  const plain = normalizeModel(raw('acme/plain', 1, '0.000001', '0.00001'));
  assert.equal(thinker.thinks_by_default, true);
  assert.deepEqual(thinker.reasoning.supported_efforts, ['high', 'low']);
  assert.equal(plain.thinks_by_default, false);
  assert.equal(plain.reasoning, null);
  const plan = await planRun({ prompts: ['Hi'], models: ['acme/thinker', 'acme/plain'], runs: 1, max_tokens: 400, thinking_budget: 8000 });
  const c = estimateCost(plan, [thinker, plain]);
  const tok = Math.ceil(plan.jobs[0].prompt.length / 4) + 8;
  assert.ok(Math.abs(c.high - (2 * tok * 0.000001 + (8400 + 400) * 0.00001)) < 1e-9, String(c.high));
  assert.ok(c.low < c.typical && c.typical < c.high);
});

// A catalogue with several tiers of the same families: what "run this on the rest of them" has to reach.
const families = [
  raw('~x-ai/grok-latest', 950), raw('x-ai/grok-4.6', 900), raw('x-ai/grok-4.3:batch', 850), raw('x-ai/grok-4-fast', 800), raw('x-ai/grok-3-mini', 700),
  raw('google/gemini-3.8-flash', 600), raw('google/gemini-3.5-flash-lite', 500), raw('google/gemma-3-27b', 400),
  raw('anthropic/claude-fable-5.1', 350), raw('anthropic/claude-opus-5', 300),
  raw('qwen/qwen3.8-max-0902', 200), raw('meta-llama/llama-guard-4-12b', 150), raw('meta-llama/llama-4-maverick', 100),
].map(normalizeModel);

test('a family selector reaches every tier of it, newest first, minus variant routes and floating aliases', () => {
  const grok = resolveModels(['grok'], families);
  assert.deepEqual(grok.ids, ['x-ai/grok-4.6', 'x-ai/grok-4-fast', 'x-ai/grok-3-mini'], 'mini is in; :batch and ~latest are not');
  assert.equal(grok.expansions[0].kind, 'family');
  assert.deepEqual(resolveModels(['gemini'], families).ids, ['google/gemini-3.8-flash', 'google/gemini-3.5-flash-lite'], 'gemma is a different family');
  assert.deepEqual(resolveModels(['claude'], families).ids, ['anthropic/claude-fable-5.1', 'anthropic/claude-opus-5']);
  assert.deepEqual(resolveModels(['claude-opus'], families).ids, ['anthropic/claude-opus-5'], 'a longer stem narrows the family');
  assert.ok(isRunnableModel(families.find((m) => m.id === 'x-ai/grok-3-mini')) && !isChatModel(families.find((m) => m.id === 'x-ai/grok-3-mini')), 'mini runs, but is not a frontier default');
});

test('provider, glob and exact-ID selectors, deduped in the order given', () => {
  assert.deepEqual(resolveModels(['xai'], families).ids, ['x-ai/grok-4.6', 'x-ai/grok-4-fast', 'x-ai/grok-3-mini'], 'display name resolves to the prefix');
  assert.deepEqual(resolveModels(['google'], families).ids, ['google/gemini-3.8-flash', 'google/gemini-3.5-flash-lite', 'google/gemma-3-27b']);
  assert.deepEqual(resolveModels(['meta'], families).ids, ['meta-llama/llama-4-maverick'], 'guard models are never runnable');
  assert.deepEqual(resolveModels(['x-ai/grok-4*'], families).ids, ['x-ai/grok-4.6', 'x-ai/grok-4-fast']);
  assert.deepEqual(resolveModels(['grok-4*'], families).ids, ['x-ai/grok-4.6', 'x-ai/grok-4-fast'], 'a glob without a provider matches the name');
  assert.deepEqual(resolveModels(['grok', 'x-ai/grok-4.6'], families).ids.length, 3, 'an ID already pulled in by a family is not repeated');
  const brandNew = resolveModels(['acme/not-listed-yet'], families);
  assert.deepEqual(brandNew.ids, ['acme/not-listed-yet'], 'an exact ID is trusted even when the catalogue lacks it');
  assert.deepEqual(brandNew.unmatched, []);
  assert.deepEqual(resolveModels(['gemmini'], families).unmatched, ['gemmini'], 'a typo matches nothing rather than something');
  assert.deepEqual(resolveModels(['gemini'], []).unmatched, ['gemini'], 'without a catalogue only exact IDs resolve');
});

test('subtractModels narrows a list by the same selectors', () => {
  const { ids } = resolveModels(['grok', 'gemini'], families);
  const cut = subtractModels(ids, ['google'], families);
  assert.deepEqual(cut.ids, ['x-ai/grok-4.6', 'x-ai/grok-4-fast', 'x-ai/grok-3-mini']);
  assert.equal(cut.removed.length, 2);
  assert.deepEqual(subtractModels(ids, [], families).ids, ids);
});

test('modelFamily strips the version, however it is attached to the name', () => {
  assert.equal(modelFamily('x-ai/grok-4.6'), 'grok');
  assert.equal(modelFamily('google/gemini-3.8-flash'), 'gemini');
  assert.equal(modelFamily('qwen/qwen3.8-max-0902'), 'qwen');
  assert.equal(modelFamily('anthropic/claude-fable-5.1'), 'claude');
  assert.equal(modelFamily('openai/o1-preview'), 'o1', 'a name that is all version keeps it');
});
