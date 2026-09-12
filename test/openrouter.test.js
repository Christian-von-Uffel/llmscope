import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenRouterProvider, estimateTokens, reasoningPlan, maskKey } from '../src/providers/openrouter.js';

test('a masked key shows its ends and never its middle; a key too short to mask shows nothing', () => {
  assert.equal(maskKey('sk-or-v1-abcdefghijklmnop'), 'sk-or-v1-a…mnop');
  assert.equal(maskKey('sk-or-short'), '••••');
  assert.equal(maskKey(''), '');
  assert.equal(maskKey(null), '');
});

const reply = (body) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body });
const chat = (usage = { prompt_tokens: 5, completion_tokens: 1 }) => ({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }], usage });

// Catalogue entries shaped like fetchModels() output; only id and reasoning matter here.
const catalogue = [
  { id: 'x-ai/grok-4.6', reasoning: { mandatory: true, default_enabled: true, supported_efforts: ['xhigh', 'high', 'medium', 'low'], default_effort: 'high' } },
  { id: 'anthropic/claude-fable-5.1', reasoning: { mandatory: true, default_enabled: false, supported_efforts: ['max', 'xhigh', 'high', 'medium', 'low'], default_effort: 'high' } },
  { id: 'qwen/qwen3.8-max-0902', reasoning: { mandatory: true, default_enabled: true, supported_efforts: ['xhigh', 'high', 'medium', 'low', 'minimal'], default_effort: 'xhigh' } },
  { id: 'mistralai/mistral-medium-3-5', reasoning: { mandatory: false, default_enabled: false, supported_efforts: ['high', 'none'], default_effort: 'high' } },
  { id: 'meta-llama/llama-4-maverick', reasoning: null },
];

/** Provider with a recording fetch; returns { p, sent } where sent() is the last chat request body. */
function make(body = chat(), opts = {}) {
  let last;
  const fetchImpl = async (url, init) => {
    if (/\/models$/.test(url)) return reply({ data: [] });
    last = JSON.parse(init.body);
    return reply(body);
  };
  return { p: createOpenRouterProvider({ apiKey: 'k', fetchImpl, models: catalogue, ...opts }), sent: () => last };
}

test('sends max_tokens as the output cap and reads prompt and reply tokens from usage', async () => {
  const { p, sent } = make(chat({ prompt_tokens: 57, completion_tokens: 2 }));
  const r = await p.complete({ model: 'meta-llama/llama-4-maverick', system: 'sys', prompt: 'hello', max_tokens: 400 });
  assert.equal(sent().max_tokens, 400);
  assert.equal(r.prompt_tokens, 57);
  assert.equal(r.tokens, 2);
  assert.equal(r.max_tokens_sent, 400);
});

test('estimates prompt tokens from system + prompt when the API returns no usage', async () => {
  const { p } = make({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] });
  const r = await p.complete({ model: 'meta-llama/llama-4-maverick', system: 'sys', prompt: 'hello' });
  assert.equal(r.prompt_tokens, estimateTokens('syshello'));
  assert.equal(r.tokens, estimateTokens('hi'));
});

test('default effort sends nothing; the thinking budget goes on top of the cap only for models that think by default', async () => {
  const { p, sent } = make();
  const cap = { max_tokens: 400, thinking_budget: 8000, prompt: 'hi' };
  await p.complete({ model: 'qwen/qwen3.8-max-0902', ...cap });
  assert.equal(sent().max_tokens, 8400, 'thinks by default: room to think and answer');
  assert.equal(sent().reasoning, undefined);
  await p.complete({ model: 'meta-llama/llama-4-maverick', ...cap });
  assert.equal(sent().max_tokens, 400, 'cannot think: plain reply cap');
  await p.complete({ model: 'anthropic/claude-fable-5.1', ...cap });
  assert.equal(sent().max_tokens, 400, 'thinking off unless asked: plain reply cap');
  await p.complete({ model: 'mistralai/mistral-medium-3-5', ...cap });
  assert.equal(sent().max_tokens, 400);
  await p.complete({ model: 'x-ai/grok-4.6', ...cap });
  assert.equal(sent().max_tokens, 400, 'xAI bills thinking on top of max_tokens, so no allowance');
  assert.equal(sent().reasoning, undefined);
});

test('an explicit effort is sent, mapped to the nearest level the model offers, and switches the allowance on', async () => {
  const { p, sent } = make();
  const cap = { max_tokens: 400, thinking_budget: 8000, prompt: 'hi' };
  await p.complete({ model: 'x-ai/grok-4.6', ...cap, reasoning: 'low' });
  assert.deepEqual(sent().reasoning, { effort: 'low' });
  await p.complete({ model: 'x-ai/grok-4.6', ...cap, reasoning: 'none' });
  assert.deepEqual(sent().reasoning, { effort: 'low' }, 'cannot switch off: as low as it allows');
  await p.complete({ model: 'anthropic/claude-fable-5.1', ...cap, reasoning: 'none' });
  assert.equal(sent().reasoning, undefined, 'already off: asking would switch it on');
  assert.equal(sent().max_tokens, 400);
  await p.complete({ model: 'anthropic/claude-fable-5.1', ...cap, reasoning: 'low' });
  assert.deepEqual(sent().reasoning, { effort: 'low' });
  assert.equal(sent().max_tokens, 8400, 'now it thinks, so it gets the budget');
  await p.complete({ model: 'mistralai/mistral-medium-3-5', ...cap, reasoning: 'medium' });
  assert.deepEqual(sent().reasoning, { effort: 'high' }, 'nearest offered level');
  await p.complete({ model: 'meta-llama/llama-4-maverick', ...cap, reasoning: 'high' });
  assert.equal(sent().reasoning, undefined, 'cannot think at all');
  assert.equal(sent().max_tokens, 400);
});

test('without a catalogue, unknown models get room to think by default and Claude is left alone below medium', () => {
  assert.deepEqual(reasoningPlan('acme/new-model', undefined, 'default'), { effort: null, thinks: true });
  assert.deepEqual(reasoningPlan('anthropic/claude-x', undefined, 'default'), { effort: null, thinks: false });
  assert.deepEqual(reasoningPlan('anthropic/claude-x', undefined, 'low'), { effort: null, thinks: false });
  assert.deepEqual(reasoningPlan('anthropic/claude-x', undefined, 'high'), { effort: 'high', thinks: true });
  assert.deepEqual(reasoningPlan('acme/new-model', undefined, 'none'), { effort: 'none', thinks: false });
});

test('reads reasoning tokens and cost from usage when the provider reports them', async () => {
  const { p } = make(chat({ prompt_tokens: 5, completion_tokens: 2474, completion_tokens_details: { reasoning_tokens: 2074 }, cost: 0.0153 }));
  const r = await p.complete({ model: 'x-ai/grok-4.6', prompt: 'hello', max_tokens: 400 });
  assert.equal(r.tokens, 2474);
  assert.equal(r.reasoning_tokens, 2074);
  assert.equal(r.cost, 0.0153);
  const plain = make();
  const none = await plain.p.complete({ model: 'x-ai/grok-4.6', prompt: 'hello' });
  assert.equal(none.reasoning_tokens, null);
  assert.equal(none.cost, null);
});
