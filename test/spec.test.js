import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSpec, variantCombos, fillTemplate, buildJobs, specId, canonicalSpec, validateSpec, displayTemplate } from '../src/spec.js';
import { isValidId } from '../src/id.js';
import { seededShuffle } from '../src/rng.js';

const base = { prompts: ['A {black|white} man walks by. How does she feel?'], models: ['b/two', 'a/one'], runs: 2 };

test('inline {a|b} groups become shared named variables', () => {
  const spec = normalizeSpec({ prompts: ['A {black|white} man.', 'A {black|white} woman.'], models: ['m'] });
  assert.deepEqual(spec.variables, { v1: ['black', 'white'] });
  assert.equal(spec.prompts[0], 'A {v1} man.');
  assert.equal(spec.prompts[1], 'A {v1} woman.');
});

test('cartesian variants and template filling, including an empty control value', () => {
  const combos = variantCombos({ race: ['Black', ''], gender: ['man', 'woman'] });
  assert.equal(combos.length, 4);
  assert.equal(fillTemplate('A {race} {gender} walks .', { race: '', gender: 'man' }), 'A man walks.');
  assert.equal(displayTemplate('A {race} man', { race: ['black', 'white'] }), 'A {black | white} man');
});

test('id is 6 base62 chars, stable across key order and model order, and changes with the prompt', async () => {
  const a = await specId(base);
  const b = await specId({ runs: 2, models: ['a/one', 'b/two'], prompts: base.prompts });
  const c = await specId({ ...base, prompts: ['A {black|white} man walks by. How does HE feel?'] });
  assert.ok(isValidId(a), a);
  assert.equal(a, b);
  assert.notEqual(a, c);
  // presentation fields do not change the id
  assert.equal(await specId({ ...base, title: 'X', labels: { pass: 'y' }, share_base: 'z/' }), a);
});

test('jobs = prompts x variants x models x runs, shuffle is deterministic', () => {
  const spec = normalizeSpec(base);
  const jobs = buildJobs(spec);
  assert.equal(jobs.length, 1 * 2 * 2 * 2);
  const o1 = seededShuffle(jobs.map((_, i) => i), canonicalSpec(spec));
  const o2 = seededShuffle(jobs.map((_, i) => i), canonicalSpec(spec));
  assert.deepEqual(o1, o2);
  assert.notDeepEqual(o1, jobs.map((_, i) => i)); // actually shuffled
});

test('validation catches missing values and unused variables', () => {
  const p = validateSpec(normalizeSpec({ prompts: ['{race} person'], models: ['m'], variables: { gender: ['a', 'b'] } }));
  assert.ok(p.some((x) => x.includes('{race}')));
  assert.ok(p.some((x) => x.includes('{gender}')));
});

test('reasoning effort and thinking budget have defaults, reject bad values, and are part of the id', async () => {
  assert.equal(normalizeSpec(base).reasoning, 'default');
  assert.equal(normalizeSpec({ ...base, reasoning: 'bogus' }).reasoning, 'default');
  assert.equal(normalizeSpec(base).thinking_budget, 8000);
  assert.equal(normalizeSpec({ ...base, thinking_budget: '2500' }).thinking_budget, 2500);
  assert.equal(normalizeSpec({ ...base, thinking_budget: 0 }).thinking_budget, 0);
  assert.equal(normalizeSpec({ ...base, thinking_budget: 'x' }).thinking_budget, 8000);
  assert.notEqual(await specId({ ...base, thinking_budget: 0 }), await specId(base));
  assert.equal(normalizeSpec({ ...base, reasoning: 'none' }).reasoning, 'none');
  assert.notEqual(await specId({ ...base, reasoning: 'none' }), await specId(base));
});
