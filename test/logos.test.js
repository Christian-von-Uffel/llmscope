import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOGOS, logoFor } from '../src/logos.js';
import { FRONTIER_DEFAULTS } from '../src/models.js';
import { runEval } from '../src/engine.js';
import { analyze } from '../src/analyze.js';
import { renderShareCard, findingFor } from '../src/render-share.js';
import { renderCard } from '../src/render.js';
import { createMockProvider } from '../src/providers/mock.js';

test('every frontier default provider has a mark; unknown providers get none', () => {
  for (const id of FRONTIER_DEFAULTS) assert.ok(logoFor(id)?.startsWith('data:image/svg+xml;base64,'), id);
  assert.equal(logoFor('nobody/model'), null);
  for (const svg of Object.values(LOGOS)) assert.ok(svg.startsWith('<svg') && !svg.includes('currentColor') && svg.includes('#ffffff'));
});

test('both cards draw one mark per row and the share card names no model in its headline', async () => {
  const models = ['openai/gpt-6-astra', 'google/gemini-3.8-flash', 'nobody/mystery-1'];
  const run = await runEval({ prompts: ['A {race} man walks by. How does she feel?'], variables: { race: ['black', 'white'] }, models, runs: 3 }, { provider: createMockProvider() });
  const a = analyze(run);
  const share = renderShareCard(a);
  const detail = renderCard(a);
  assert.equal((share.match(/<image /g) || []).length, 2, 'two marks, one lettered fallback');
  assert.equal((detail.match(/<image /g) || []).length, 2);
  assert.ok(share.includes('<circle'), 'fallback circle for the unknown provider');
  const { headline } = findingFor(a);
  assert.match(headline, /^\d of 3 models|^No model/);
  for (const id of models) assert.ok(!headline.includes(id.split('/')[1]), 'headline does not name a model');
});
