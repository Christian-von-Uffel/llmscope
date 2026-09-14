import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { inputWithRecall, isRecall } from '../src/input-recall.js';
import {
  loadKeywordSets, saveKeywordSet, resolveKeywordTerms, keywordBatches,
  loadKeywordHistory, rememberKeywordBatch, HISTORY_LIMIT,
} from '../src/keyword-sets.js';
import { batchKey, cleanTerms, isValidKeyword } from '../src/checks/keywords.js';
import { modelKey } from '../src/models.js';
import { promptBank, promptKey, loadPromptHistory, rememberPrompt, byRecency, modelBank, loadModelHistory, rememberModels } from '../src/recall.js';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'llmscope-kw-'));
const UP = String.fromCharCode(27) + '[A';
const DOWN = String.fromCharCode(27) + '[B';
const CTRL_R = String.fromCharCode(18);
const ENTER = '\r';
const BACKSPACE = String.fromCharCode(127);

/** Drive the prompt through a fake terminal, one keystroke at a time, waiting for each render in between. */
async function drive(config, keys) {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  const output = new PassThrough();
  output.isTTY = true;
  output.resume();
  const answer = inputWithRecall(config, { input, output });
  for (const k of keys) {
    // Long enough for an async validate to settle: keys arriving mid-validation are ignored by design.
    await new Promise((r) => setTimeout(r, 10));
    input.write(k);
  }
  return answer;
}

test('up-arrow walks earlier batches, newest first', async () => {
  const history = ['masculine, bold, handsome', 'suspicious, lurking'];
  assert.equal(await drive({ message: 'kw:', history }, [UP, ENTER]), 'masculine, bold, handsome');
  assert.equal(await drive({ message: 'kw:', history }, [UP, UP, ENTER]), 'suspicious, lurking');
});

test('down-arrow off the end of history gives the prefilled text back, not an empty line', async () => {
  const answer = await drive(
    { message: 'kw:', default: 'propaganda', prefill: 'editable', history: ['suspicious, lurking'] },
    [UP, DOWN, ENTER],
  );
  assert.equal(answer, 'propaganda');
});

test('with no history, up-arrow does nothing and the prefilled text survives', async () => {
  assert.equal(await drive({ message: 'kw:', default: 'hedges', prefill: 'editable', history: [] }, [UP, ENTER]), 'hedges');
});

test('ctrl-r asks for the picker and carries what was already typed; without recall it is just a keystroke', async () => {
  const asked = await drive({ message: 'kw:', recall: true, history: ['a, b'] }, [UP, CTRL_R]);
  assert.ok(isRecall(asked), 'ctrl-r resolves to a Recall');
  assert.equal(asked.typed, 'a, b');
  const plain = await drive({ message: 'kw:', recall: false }, ['xy', ENTER]);
  assert.equal(plain, 'xy');
});

test('validation keeps the text so a half-typed pattern is finished rather than retyped', async () => {
  const answer = await drive(
    { message: 'kw:', validate: (v) => (isValidKeyword(v) ? true : 'not a valid pattern') },
    ['/[/', ENTER, BACKSPACE, 'a]/', ENTER],
  );
  assert.equal(answer, '/[a]/');
});

test('named sets: a file is a bare list or {description, keywords}, and @name expands where words are typed', async () => {
  const root = path.join(tmp, 'proj');
  await fs.mkdir(path.join(root, 'keywords'), { recursive: true });
  await fs.writeFile(path.join(root, 'keywords', 'hedges.json'), JSON.stringify(['perhaps', 'it seems', 'arguably']));
  await saveKeywordSet('threat', ['suspicious', 'lurking', '/loiter\\w*/'], { root, description: 'threat framing' });
  const sets = await loadKeywordSets({ root });
  assert.deepEqual(sets.map((s) => s.name), ['hedges', 'threat']);
  assert.equal(sets[1].description, 'threat framing');
  // a set stands in for its words mid-list, and repeats collapse
  const { terms, missing } = resolveKeywordTerms('@hedges, propaganda, @threat, perhaps', sets);
  assert.deepEqual(terms, ['perhaps', 'it seems', 'arguably', 'propaganda', 'suspicious', 'lurking', '/loiter\\w*/']);
  assert.deepEqual(missing, []);
  // a name matching nothing is reported, never passed through as the literal word "@nope"
  assert.deepEqual(resolveKeywordTerms('@nope, real', sets).missing, ['@nope']);
  assert.deepEqual(resolveKeywordTerms('@nope, real', sets).terms, ['real']);
  await assert.rejects(saveKeywordSet('../escape', ['x'], { root }), /not a set name/);
  await assert.rejects(saveKeywordSet('empty', [], { root }), /at least one/);
});

test('a set keeps commas inside a regex together, the way the matcher reads them', async () => {
  const root = path.join(tmp, 'regex');
  await saveKeywordSet('counts', '/a{1,2}/, plain', { root });
  assert.deepEqual((await loadKeywordSets({ root }))[0].terms, ['/a{1,2}/', 'plain']);
});

test('history: most recent first, stamped, deduped whatever the order, capped', async () => {
  process.env.LLMSCOPE_CONFIG_DIR = path.join(tmp, 'cfg');
  assert.deepEqual(await loadKeywordHistory(), []);
  await rememberKeywordBatch(['suspicious', 'lurking'], { at: '2026-09-01T00:00:00.000Z' });
  await rememberKeywordBatch(['propaganda'], { at: '2026-09-02T00:00:00.000Z' });
  // the same batch, reordered: it moves back to the front with a new time rather than appearing twice
  await rememberKeywordBatch(['lurking', 'suspicious'], { at: '2026-09-03T00:00:00.000Z' });
  assert.deepEqual(await loadKeywordHistory(), [
    { terms: ['lurking', 'suspicious'], at: '2026-09-03T00:00:00.000Z' },
    { terms: ['propaganda'], at: '2026-09-02T00:00:00.000Z' },
  ]);
  for (let i = 0; i < HISTORY_LIMIT + 5; i++) await rememberKeywordBatch([`w${i}`]);
  const hist = await loadKeywordHistory();
  assert.equal(hist.length, HISTORY_LIMIT);
  assert.deepEqual(hist[0].terms, [`w${HISTORY_LIMIT + 4}`]);
  delete process.env.LLMSCOPE_CONFIG_DIR;
});

test('a batch saved before batches were stamped still sorts above the files on disk', async () => {
  const dir = path.join(tmp, 'legacy');
  process.env.LLMSCOPE_CONFIG_DIR = dir;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ keyword_history: [['older', 'style']] }));
  const [entry] = await loadKeywordHistory();
  assert.deepEqual(entry.terms, ['older', 'style']);
  // no stamp of its own, so it takes the config file's mtime: the last moment it can have been written
  assert.equal(entry.at, (await fs.stat(path.join(dir, 'config.json'))).mtime.toISOString());
  delete process.env.LLMSCOPE_CONFIG_DIR;
});

test('batchKey ignores order and case; cleanTerms drops what will not compile', () => {
  assert.equal(batchKey(['B', 'a']), batchKey(['a', 'b']));
  assert.deepEqual(cleanTerms('good, /[/, , also good'), ['good', 'also good']);
});

test('one list from every store, most recently used first whatever the store', async () => {
  const root = path.join(tmp, 'all');
  await fs.mkdir(path.join(root, 'evals'), { recursive: true });
  await fs.mkdir(path.join(root, 'out'), { recursive: true });
  await fs.mkdir(path.join(root, 'keywords'), { recursive: true });
  const iso = (d) => new Date(d).toISOString();
  const write = async (file, body, when) => {
    await fs.writeFile(file, JSON.stringify(body));
    await fs.utimes(file, new Date(when), new Date(when));
  };
  // Eval files are named by content hash, so alphabetical order is arbitrary: two.json is the newer one.
  await write(path.join(root, 'evals', 'one.json'), { keywords: ['calm', 'measured'] }, '2026-09-05T00:00:00Z');
  await write(path.join(root, 'evals', 'two.json'), { keywords: ['suspicious', 'lurking'] }, '2026-09-09T00:00:00Z');
  await write(path.join(root, 'keywords', 'threat.json'), { keywords: ['suspicious', 'lurking'] }, '2026-09-02T00:00:00Z');
  await fs.writeFile(path.join(root, 'out', 'aaa.results.json'), JSON.stringify({ id: 'aaa', finished_at: iso('2026-09-01'), spec: { keywords: ['old', 'words'] } }));
  await fs.writeFile(path.join(root, 'out', 'bbb.results.json'), JSON.stringify({ id: 'bbb', finished_at: iso('2026-09-08'), spec: { keywords: ['calm', 'measured'] }, highlight: ['marked', 'later'] }));

  const sets = [{ name: 'threat', file: path.join(root, 'keywords', 'threat.json'), terms: ['suspicious', 'lurking'], description: 'threat framing' }];
  const batches = await keywordBatches({
    sets,
    history: [{ terms: ['propaganda'], at: iso('2026-09-10') }],
    evalDirs: [path.join(root, 'evals')],
    runDirs: [path.join(root, 'out')],
  });
  assert.deepEqual(batches.map((b) => b.origin), [
    'recently used',              // 09-10
    path.join('evals', 'two.json'), // 09-09, ahead of the older run and of the set naming the same words
    'run bbb',                    // 09-08, and its highlight shares that time, so the two stay adjacent
    'run bbb, highlighted',
    'run aaa',                    // 09-01
  ]);
  // one.json (09-05) names the same words as run bbb (09-08): the batch takes its most recent position, once
  assert.equal(batches.filter((b) => batchKey(b.terms) === batchKey(['calm', 'measured'])).length, 1);
  // the eval file outranked the set, and the batch still reports the set it is
  assert.equal(batches[1].set, 'threat');
  assert.equal(batches[1].description, 'threat framing');
  assert.deepEqual(await keywordBatches({}), []);
});

test('a batch found in a run is still reported as the named set it matches', async () => {
  const batches = await keywordBatches({
    sets: [{ name: 'hedges', terms: ['perhaps', 'arguably'], description: '' }],
    history: [['arguably', 'perhaps']],
  });
  assert.equal(batches.length, 1);
  assert.equal(batches[0].origin, 'recently used');
  assert.equal(batches[0].set, 'hedges');
});

test('prompts recall the same way: most recently asked first, whichever store they came from', async () => {
  const root = path.join(tmp, 'prompts');
  await fs.mkdir(path.join(root, 'evals'), { recursive: true });
  await fs.mkdir(path.join(root, 'out'), { recursive: true });
  const iso = (d) => new Date(d).toISOString();
  const write = async (file, body, when) => {
    await fs.writeFile(file, JSON.stringify(body));
    await fs.utimes(file, new Date(when), new Date(when));
  };
  await write(path.join(root, 'evals', 'a.json'), { prompts: ['An older question about {race} drivers.'] }, '2026-09-02T00:00:00Z');
  // one file, two prompts: they share its time, so they keep the order the eval asks them in
  await write(path.join(root, 'evals', 'b.json'), { prompts: ['First phrasing for {race}.', 'Second phrasing for {race}.'] }, '2026-09-07T00:00:00Z');
  await fs.writeFile(path.join(root, 'out', 'zz.results.json'), JSON.stringify({
    id: 'zz', finished_at: iso('2026-09-09'), spec: { prompts: ['A {race} man walks by. Describe him.'] },
  }));

  const bank = await promptBank({
    history: [{ prompt: 'The wording I typed a moment ago, about {race}.', at: iso('2026-09-11') }],
    evalDirs: [path.join(root, 'evals')],
    runDirs: [path.join(root, 'out')],
  });
  assert.deepEqual(bank.map((e) => e.prompt), [
    'The wording I typed a moment ago, about {race}.', // 09-11
    'A {race} man walks by. Describe him.',            // 09-09
    'First phrasing for {race}.',                      // 09-07, in the order its eval asks them
    'Second phrasing for {race}.',
    'An older question about {race} drivers.',         // 09-02
  ]);
  assert.deepEqual(bank.map((e) => e.origin), ['recently used', 'run zz', path.join('evals', 'b.json'), path.join('evals', 'b.json'), path.join('evals', 'a.json')]);
  assert.deepEqual(await promptBank({}), []);
});

test('a prompt is the same prompt however it was whitespaced, and shows once', async () => {
  assert.equal(promptKey('  A {race}   man\n walks by. '), promptKey('A {race} man walks by.'));
  const bank = await promptBank({
    history: [{ prompt: 'A {race} man walks by.', at: '2026-09-05T00:00:00.000Z' }],
    evalDirs: [],
    runDirs: [],
  });
  assert.equal(bank.length, 1);
  // case is a real difference in a prompt, so it is not folded away the way keyword case is
  assert.notEqual(promptKey('Describe him.'), promptKey('describe him.'));
});

test('prompt history: newest first, deduped on wording, stamped', async () => {
  process.env.LLMSCOPE_CONFIG_DIR = path.join(tmp, 'pcfg');
  assert.deepEqual(await loadPromptHistory(), []);
  await rememberPrompt('A {race} man walks by.', { at: '2026-09-01T00:00:00.000Z' });
  await rememberPrompt('Another question.', { at: '2026-09-02T00:00:00.000Z' });
  await rememberPrompt('  A {race} man walks by.  ', { at: '2026-09-03T00:00:00.000Z' }); // same wording, retyped
  assert.deepEqual(await loadPromptHistory(), [
    { prompt: 'A {race} man walks by.', at: '2026-09-03T00:00:00.000Z' },
    { prompt: 'Another question.', at: '2026-09-02T00:00:00.000Z' },
  ]);
  assert.equal(await rememberPrompt('   '), ''); // nothing to remember
  assert.equal((await loadPromptHistory()).length, 2);
  delete process.env.LLMSCOPE_CONFIG_DIR;
});

test('byRecency: newest first, untimed last, ties in the order given, one entry per thing', () => {
  const ordered = byRecency([
    { key: 'a', when: '2026-09-01' },
    { key: 'b', when: '' },
    { key: 'c', when: '2026-09-09' },
    { key: 'a', when: '2026-09-10' }, // the same thing, used more recently: it takes this position
    { key: 'd', when: '2026-09-09' },
  ]);
  assert.deepEqual(ordered.map((x) => x.key), ['a', 'c', 'd', 'b']);
  assert.equal(ordered[0].when, '2026-09-10');
});

test('model history: newest first, deduped on the set not the order, stamped, capped', async () => {
  process.env.LLMSCOPE_CONFIG_DIR = path.join(tmp, 'mcfg');
  assert.deepEqual(await loadModelHistory(), []);
  await rememberModels(['openai/gpt-6-astra', 'x-ai/grok-4.6'], { at: '2026-09-01T00:00:00.000Z' });
  await rememberModels(['google/gemini-3.8-flash'], { at: '2026-09-02T00:00:00.000Z' });
  await rememberModels(['x-ai/grok-4.6', 'openai/gpt-6-astra'], { at: '2026-09-03T00:00:00.000Z' }); // same set, reordered
  assert.deepEqual(await loadModelHistory(), [
    { models: ['x-ai/grok-4.6', 'openai/gpt-6-astra'], at: '2026-09-03T00:00:00.000Z' },
    { models: ['google/gemini-3.8-flash'], at: '2026-09-02T00:00:00.000Z' },
  ]);
  assert.equal(modelKey(['x-ai/grok-4.6', 'openai/gpt-6-astra']), modelKey(['openai/gpt-6-astra', 'x-ai/grok-4.6']));
  for (let i = 0; i < HISTORY_LIMIT + 5; i++) await rememberModels([`acme/m${i}`]);
  const hist = await loadModelHistory();
  assert.equal(hist.length, HISTORY_LIMIT);
  assert.deepEqual(hist[0].models, [`acme/m${HISTORY_LIMIT + 4}`]);
  assert.deepEqual(await rememberModels([]), []);
  delete process.env.LLMSCOPE_CONFIG_DIR;
});

test('model sets recall the same way: most recently used first, whichever store they came from', async () => {
  const root = path.join(tmp, 'models');
  await fs.mkdir(path.join(root, 'evals'), { recursive: true });
  await fs.mkdir(path.join(root, 'out'), { recursive: true });
  const iso = (d) => new Date(d).toISOString();
  const write = async (file, body, when) => {
    await fs.writeFile(file, JSON.stringify(body));
    await fs.utimes(file, new Date(when), new Date(when));
  };
  await write(path.join(root, 'evals', 'old.json'), { models: ['openai/gpt-6-astra'] }, '2026-09-02T00:00:00Z');
  await write(path.join(root, 'evals', 'new.json'), { models: ['google/gemini-3.8-flash', 'x-ai/grok-4.6'] }, '2026-09-07T00:00:00Z');
  await fs.writeFile(path.join(root, 'out', 'zz.results.json'), JSON.stringify({
    id: 'zz', finished_at: iso('2026-09-09'), spec: { models: ['anthropic/claude-fable-5.1'] },
  }));

  const bank = await modelBank({
    history: [{ models: ['openai/gpt-6-astra', 'google/gemini-3.8-flash'], at: iso('2026-09-11') }],
    evalDirs: [path.join(root, 'evals')],
    runDirs: [path.join(root, 'out')],
    frontier: ['openai/gpt-6-astra', 'anthropic/claude-fable-5.1'],
  });
  assert.deepEqual(bank.map((e) => e.origin), [
    'recently used',                         // 09-11
    'run zz',                                // 09-09
    path.join('evals', 'new.json'),          // 09-07
    path.join('evals', 'old.json'),          // 09-02
    'default models',                        // untimed, and a different set from recently used
  ]);
  assert.equal(bank.filter((e) => e.origin === 'default models').length, 1);
  assert.deepEqual(await modelBank({}), []);
});
