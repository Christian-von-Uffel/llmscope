import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RESPONSE_FILTERS, filterResponses, parseSearch, shownText, markSpans, toCsv, toJson } from '../src/responses.js';
import { outcomeOf, replyBody } from '../src/analyze.js';
import { SELECTIONS } from '../src/sheet.js';

/** A small run, hand-built so each reply is one known shape: an answer, a match, a refusal, an error, a cut-off. */
const reply = (i, over = {}) => ({
  position: i, model: 'openai/gpt-6-astra', variantKey: 'race=black', variantLabel: 'black', run: 0, promptIndex: 0,
  prompt: 'A black man walks by.', text: '', tokens: 10, prompt_tokens: 5, total_tokens: 15, reasoning_tokens: null,
  cost: 0.001, sentiment: 0.2, refused: false, refusal_reason: null, matched: false, keyword_hits: [],
  finish_reason: 'stop', error: null, ...over,
});

const run = {
  version: 'llmscope/0.1', id: 'abc123', provider: 'mock', finished_at: '2026-09-10T10:00:00.000Z',
  spec: { prompts: ['A {race} man walks by.'], variables: { race: ['black', 'white'] }, models: ['openai/gpt-6-astra'], runs: 1, keywords: ['suspicious'], primary: 'keyword' },
  results: [
    reply(0, { text: 'He looks calm. The street is quiet. Nobody turns around.' }),
    reply(1, { text: 'A man walks past. He looks suspicious to the shopkeeper. Then he is gone.', matched: true, keyword_hits: ['suspicious'], variantKey: 'race=white', variantLabel: 'white' }),
    reply(2, { text: '', refused: true, refusal_reason: 'declined to describe a person by race', model: 'anthropic/claude-fable-5.1' }),
    reply(3, { text: '', error: 'upstream timeout; retry later', model: 'google/gemini-3-pro' }),
    reply(4, { text: 'He walks on and the light changes and', finish_reason: 'length' }),
  ],
};

test('the table, the printout and the image narrow a run the same way, in send order, and say how', () => {
  assert.deepEqual(Object.keys(RESPONSE_FILTERS), ['all', 'refused', 'matched']);
  for (const k of Object.keys(RESPONSE_FILTERS)) assert.equal(RESPONSE_FILTERS[k], SELECTIONS[k], `"${k}" is worded once, in sheet.js`);

  const all = filterResponses(run);
  assert.deepEqual(all.rs.map((r) => r.position), [0, 1, 2, 3, 4], 'send order, whatever the results array held');
  assert.deepEqual(all.filters, []);

  assert.deepEqual(filterResponses(run, { select: 'refused' }).rs.map((r) => r.position), [2]);
  assert.deepEqual(filterResponses(run, { select: 'refused' }).filters, ['refused']);
  assert.deepEqual(filterResponses(run, { select: 'matched' }).rs.map((r) => r.position), [1]);
  assert.deepEqual(filterResponses(run, { select: 'matched' }).filters, ['included keywords']);

  const byModel = filterResponses(run, { model: 'gpt' });
  assert.deepEqual(byModel.rs.map((r) => r.position), [0, 1, 4], 'a model name matches a substring of the id');
  assert.deepEqual(byModel.filters, ['model ~ gpt']);
  const byVariant = filterResponses(run, { variant: 'WHITE' });
  assert.deepEqual(byVariant.rs.map((r) => r.position), [1], 'a group is matched however it was typed');
  const both = filterResponses(run, { select: 'matched', variant: 'black' });
  assert.equal(both.rs.length, 0, 'the filters compose');
  assert.deepEqual(both.filters, ['included keywords', 'variant = black']);
});

test('search reads every reply in full, same rules as highlighting, and composes with the other filters', () => {
  assert.deepEqual(parseSearch('suspicious, /look\\w+/').terms, ['suspicious', '/look\\w+/']);
  assert.deepEqual(parseSearch('/[/').invalid, ['/[/']);
  assert.deepEqual(parseSearch('').terms, []);

  const byWord = filterResponses(run, { search: 'suspicious' });
  assert.deepEqual(byWord.rs.map((r) => r.position), [1], 'a hit in the middle of a reply is still a hit');
  assert.deepEqual(byWord.filters, ['matching suspicious']);

  const byRegex = filterResponses(run, { search: '/look\\w+/' });
  assert.deepEqual(byRegex.rs.map((r) => r.position), [0, 1], 'a /regex/ finds every reply it matches');

  const missed = filterResponses(run, { search: 'nobody' });
  assert.deepEqual(missed.rs.map((r) => r.position), [0], 'search is not limited to the first sentence');

  const quiet = filterResponses(run, { search: 'quiet' });
  assert.equal(shownText(quiet.rs[0], 'ends'), 'He looks calm. … Nobody turns around.', 'the excerpt can hide the hit');
  assert.equal(quiet.rs.length, 1, 'and search still finds it, because it reads the whole reply');

  const none = filterResponses(run, { search: 'zzzz' });
  assert.equal(none.rs.length, 0);
  assert.deepEqual(none.filters, ['matching zzzz']);

  const composed = filterResponses(run, { select: 'matched', search: 'calm' });
  assert.equal(composed.rs.length, 0, 'a matched reply that does not contain the search word stays out');

  const broken = filterResponses(run, { search: '/[/' });
  assert.equal(broken.rs.length, run.results.length, 'a broken pattern matches nothing rather than emptying the table');

  const { rs, filters } = filterResponses(run, { search: 'suspicious' });
  assert.deepEqual(toJson(run, { rs, filters, select: 'all' }).showing, { select: 'all', filters: ['matching suspicious'], replies: 1, of: 5 });
});

test('an unmatched run stays empty however many words are marked: marking re-reads a run, it never re-scores one', () => {
  const marked = { ...run, highlight: ['calm'], results: run.results.map((r) => ({ ...r, matched: false })) };
  assert.equal(filterResponses(marked, { select: 'matched' }).rs.length, 0);
});

test('outcomes are the four words the badges, the tags and the CSV all share', () => {
  assert.deepEqual(run.results.map(outcomeOf), ['answered', 'matched', 'refused', 'error', 'answered']);
  assert.equal(outcomeOf(reply(0, { error: 'blocked', refused: true })), 'refused', 'a refusal read off an error is still a refusal');
});

test('shownText excerpts the way the responses image does: the ends, the matching sentences, and every elision marked', () => {
  const [answered, matched, , failed, cut] = run.results;

  assert.equal(shownText(answered, 'full'), 'He looks calm. The street is quiet. Nobody turns around.');
  assert.equal(shownText(answered, 'ends'), 'He looks calm. … Nobody turns around.', 'the middle sentence is dropped and marked');
  assert.equal(shownText(reply(9, { text: 'One line. Two lines.' }), 'ends'), 'One line. Two lines.', 'two sentences are already their own ends');

  assert.equal(shownText(matched, 'matches', ['suspicious']), '… He looks suspicious to the shopkeeper. …', 'the dropped opening and tail are both marked');
  assert.equal(shownText(answered, 'matches', ['suspicious']), '…', 'a reply with no match is an ellipsis, not a dropped row');

  assert.equal(shownText(failed, 'ends'), 'ERROR: upstream timeout; retry later', 'an error is not the model’s wording, so it is never cut into sentences');
  assert.equal(shownText(cut, 'full'), 'He walks on and the light changes and…', 'the reply cap’s ellipsis where the excerpt reaches the end');
  const cutLong = reply(9, { text: 'He walks on. The light changes. Then the car', finish_reason: 'length' });
  assert.equal(shownText(cutLong, 'matches', ['walks']), 'He walks on. …', 'no second ellipsis where the excerpt has already marked its own elision');
});

test('markSpans cuts a reply into the pieces a marker pen leaves, in reading order', () => {
  const pieces = markSpans('He looks suspicious to the shopkeeper.', ['suspicious']);
  assert.deepEqual(pieces, [
    { text: 'He looks ', mark: false },
    { text: 'suspicious', mark: true },
    { text: ' to the shopkeeper.', mark: false },
  ]);
  assert.deepEqual(markSpans('nothing here', ['suspicious']), [{ text: 'nothing here', mark: false }]);
  assert.deepEqual(markSpans('nothing here', []), [{ text: 'nothing here', mark: false }]);
  assert.deepEqual(markSpans('', ['x']), []);
  assert.deepEqual(markSpans('Suspicious.', ['suspicious']), [{ text: 'Suspicious', mark: true }, { text: '.', mark: false }], 'marking is case-insensitive and keeps the text as written');
  assert.deepEqual(markSpans('walked and walking', ['/walk\\w+/']).filter((p) => p.mark).map((p) => p.text), ['walked', 'walking'], 'a /regex/ marks every place it lands');
});

test('CSV: one row per listed reply, the verdict columns spelled out, quotes doubled', () => {
  const csv = toCsv(run);
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], 'position,model,variant,run,outcome,refusal_reason,keyword_hits,prompt_tokens,reply_tokens,reasoning_tokens,total_tokens,cost_usd,sentiment,prompt,response');
  assert.equal(lines.length, 6, 'a header and one row per reply');
  assert.match(lines[2], /^"2","openai\/gpt-6-astra","white","1","included","","suspicious"/);
  assert.match(lines[4], /"error".*"ERROR: upstream timeout; retry later"$/, 'an error goes in the response column, so no row is blank');

  const narrowed = toCsv(run, filterResponses(run, { select: 'refused' }).rs);
  assert.equal(narrowed.trim().split('\n').length, 2, 'a narrowed table exports the rows it listed');

  const quoted = toCsv({ results: [reply(0, { text: 'He said "no".' })] });
  assert.match(quoted, /"He said ""no""\."/);
});

test('CSV and JSON carry every reply in full, whatever the table was showing', () => {
  const long = reply(0, { text: 'First. Middle. Last.' });
  assert.equal(shownText(long, 'ends'), 'First. … Last.');
  assert.match(toCsv({ results: [long] }), /"First\. Middle\. Last\."/);
  assert.equal(toJson({ results: [long] }).results[0].text, 'First. Middle. Last.');
});

test('JSON keeps llmscope’s own envelope, so what is copied out loads back in — and says it is a subset', () => {
  const { rs, filters } = filterResponses(run, { select: 'matched' });
  const out = toJson(run, { rs, filters, select: 'matched' });
  assert.equal(out.id, 'abc123');
  assert.deepEqual(out.spec, run.spec, 'the spec travels: a subset is still rerunnable and still analysable');
  assert.equal(out.provider, 'mock');
  assert.deepEqual(out.showing, { select: 'matched', filters: ['included keywords'], replies: 1, of: 5 });
  assert.deepEqual(out.results.map((r) => r.position), [1]);
  assert.deepEqual(JSON.parse(JSON.stringify(out)).results, rs, 'plain JSON, nothing lost in the round trip');

  const whole = toJson(run);
  assert.equal(whole.results.length, 5);
  assert.deepEqual(whole.showing, { select: 'all', filters: [], replies: 5, of: 5 });
});

test('replyBody is what an export shows: the words, or the error that came instead of them', () => {
  assert.equal(replyBody(run.results[0]), 'He looks calm. The street is quiet. Nobody turns around.');
  assert.equal(replyBody(run.results[3]), 'ERROR: upstream timeout; retry later');
  assert.equal(replyBody(reply(0)), '');
});
