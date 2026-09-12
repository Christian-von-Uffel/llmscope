import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSpec, variantCombos, fillTemplate, buildJobs, specId, canonicalSpec, validateSpec, displayTemplate, usedVariables, strayBraces, isSlotToken } from '../src/spec.js';
import { isValidId } from '../src/id.js';
import { seededShuffle } from '../src/rng.js';

const base = { prompts: ['A {black|white} man walks by. How does she feel?'], models: ['b/two', 'a/one'], runs: 2 };

test('inline {a|b} groups become shared named variables', () => {
  const spec = normalizeSpec({ prompts: ['A {black|white} man.', 'A {black|white} woman.'], models: ['m'] });
  assert.deepEqual(spec.variables, { v1: ['black', 'white'] });
  assert.equal(spec.prompts[0], 'A {v1} man.');
  assert.equal(spec.prompts[1], 'A {v1} woman.');
});

test('lifting is idempotent: a spec already carrying its lifted slots keeps them', () => {
  const once = normalizeSpec({ prompts: ['A {black|white} man.'], models: ['m'] });
  const twice = normalizeSpec({ ...once, models: ['m'] });
  assert.deepEqual(twice.variables, { v1: ['black', 'white'] });
  assert.equal(twice.prompts[0], 'A {v1} man.');
  assert.deepEqual(validateSpec(twice), []);
});

test('a new inline group never lands on the name of a slot already in use', () => {
  // v1 was dropped by an earlier edit, so the free counter would otherwise hand v2 out twice
  const spec = normalizeSpec({ prompts: ['A {v2} man meets a {tall|short} woman.'], variables: { v2: ['black', 'white'] }, models: ['m'] });
  assert.deepEqual(spec.variables.v2, ['black', 'white']);
  assert.equal(Object.keys(spec.variables).length, 2);
  assert.deepEqual(validateSpec(spec), []);
});

test('a slot is named in whatever words the prompt writer thinks in', () => {
  const prompts = ['In {2020}, how serious was {environmental concern} in { race } neighbourhoods?'];
  const variables = { 2020: ['2020', '1995'], 'environmental concern': ['smog', 'lead'], race: ['Black', 'white'] };
  const spec = normalizeSpec({ prompts, variables, models: ['m'] });
  assert.deepEqual([...usedVariables(spec.prompts)], ['2020', 'environmental concern', 'race']);
  assert.deepEqual(validateSpec(spec), []);
  assert.equal(
    fillTemplate(spec.prompts[0], { 2020: '1995', 'environmental concern': 'smog', race: 'Black' }),
    'In 1995, how serious was smog in Black neighbourhoods?',
  );
});

test('doubled braces send a literal brace, and empty braces are the only stray kind left', () => {
  const spec = normalizeSpec({ prompts: ['Rate {race} risk. Reply as {{"risk": n}}.'], variables: { race: ['Black'] }, models: ['m'] });
  assert.deepEqual([...usedVariables(spec.prompts)], ['race']);
  assert.equal(buildJobs(spec)[0].prompt, 'Rate Black risk. Reply as {"risk": n}.');
  assert.deepEqual(strayBraces(['A {race} man in {2020} said {}']), ['{}']);
  assert.equal(isSlotToken('{the "safe" framing}'), true);
  assert.equal(isSlotToken('{}'), false);
});

test('cartesian variants and template filling, including an empty control value', () => {
  const combos = variantCombos({ race: ['Black', ''], gender: ['man', 'woman'] });
  assert.equal(combos.length, 4);
  assert.equal(fillTemplate('A {race} {gender} walks .', { race: '', gender: 'man' }), 'A man walks.');
  assert.equal(displayTemplate('A {race} man', { race: ['black', 'white'] }), 'A {black | white} man');
  assert.equal(
    displayTemplate('What is the relationship between {v1} and autism?', { v1: ['heavy metals', 'vaccination', 'childhood vaccination', 'encephalitis'] }),
    'What is the relationship between {heavy metals | vaccination | childhood vaccination | encephalitis} and autism?',
  );
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
