import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPromptLine, runPickerLabel } from '../web/store.js';

const run = {
  id: 'mwbXAp',
  spec: {
    prompts: ['What is the relationship between {v1} and autism?'],
    variables: { v1: ['heavy metals', 'vaccination', 'childhood vaccination', 'encephalitis'] },
    primary: 'keyword',
    models: ['a', 'b'],
  },
  results: new Array(96),
};

test('the reopen picker names the prompt the way the card titles it, and does not cut it', () => {
  const prompt = runPromptLine(run);
  assert.equal(prompt, 'What is the relationship between {heavy metals | vaccination | childhood vaccination | encephalitis} and autism?');
  const line = runPickerLabel({ id: run.id, primary: 'keyword', replies: 96, prompt });
  assert.ok(line.startsWith('mwbXAp · keyword · 96 replies · '));
  assert.ok(line.endsWith('and autism?'), `cut short: ${line}`);
  assert.ok(!line.includes('{v1}'), 'the slot is spelled out, as on the card');
});
