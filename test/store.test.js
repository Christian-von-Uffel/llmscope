import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPromptLine, runPickerLabel, saveRun, loadRun, listRuns, deleteRun, publishedEval } from '../web/store.js';

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

// ---------- the site's half ----------
// The store is DOM-free, so the two things it reaches for are stood in for here: a Map wearing localStorage's
// interface, and a fetch that plays the API.
class MemoryStorage {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}
const realFetch = globalThis.fetch;
const real = { ...run, provider: 'openrouter', spec_id: 'abcdef', results: [{ model: 'a', text: 'one' }, { model: 'b', text: 'two' }] };
const answer = (status, body) => new Response(body == null ? null : JSON.stringify(body), { status, headers: body == null ? {} : { 'content-type': 'application/json; charset=utf-8' } });

test('saveRun keeps a copy here and sends the run to the site under this browser\'s token; loadRun falls back to the site', async () => {
  globalThis.localStorage = new MemoryStorage();
  const calls = [];
  const remote = new Map();
  globalThis.fetch = async (url, init = {}) => {
    const id = url.split('/').pop();
    calls.push({ url, method: init.method || 'GET', auth: init.headers?.authorization });
    if (init.method === 'PUT') { remote.set(id, JSON.parse(init.body)); return answer(201, { id }); }
    if (init.method === 'DELETE') { remote.delete(id); return answer(204, null); }
    if (url.startsWith('/api/runs/')) return remote.has(id) ? answer(200, remote.get(id)) : answer(404, { error: 'no' });
    if (url.startsWith('/api/evals/')) return answer(200, { id, spec: real.spec, runs: [{ id: real.id, eval: id }] });
    return answer(404, { error: 'no' });
  };
  try {
    assert.deepEqual(await saveRun(real), { local: true, remote: 'saved' });
    assert.deepEqual(calls[0], { url: '/api/runs/mwbXAp', method: 'PUT', auth: calls[0].auth });
    assert.match(calls[0].auth, /^Bearer [0-9a-f]{48}$/, 'a token minted here, not a key');
    assert.equal((await listRuns())[0].id, 'mwbXAp');
    assert.deepEqual(await loadRun('mwbXAp'), real, 'read back from this browser, no request made');
    assert.equal(calls.length, 1);

    assert.deepEqual(await saveRun({ ...real, id: 'mock01', provider: 'mock' }), { local: true, remote: 'skipped' }, 'a mock run is a demo and stays home');
    assert.equal(calls.filter((c) => c.method === 'PUT').length, 1);

    localStorage.removeItem('llmscope:run:mwbXAp'); // evicted for quota, say
    assert.deepEqual(await loadRun('mwbXAp'), real, 'then the site has it');
    assert.equal(await loadRun('zzzzzz'), null);
    assert.equal(new Set(calls.map((c) => c.auth).filter(Boolean)).size, 1, 'one token per browser, kept between saves');

    const published = await publishedEval('abcdef');
    assert.equal(published.runs[0].id, 'mwbXAp');

    assert.equal(await deleteRun('mwbXAp'), true);
    assert.equal(remote.has('mwbXAp'), false);
    assert.ok(!(await listRuns()).some((e) => e.id === 'mwbXAp'), 'gone from the picker too');
  } finally {
    delete globalThis.localStorage;
    globalThis.fetch = realFetch;
  }
});

test('an origin with no API — a page for every path, a JSON 404 from `llmscope serve`, or no network — leaves the run in this browser', async () => {
  globalThis.localStorage = new MemoryStorage();
  try {
    globalThis.fetch = async () => new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } });
    assert.deepEqual(await saveRun(real), { local: true, remote: 'offline' });
    assert.equal(await loadRun('nope00'), null);
    assert.equal(await publishedEval('nope00'), null);
    globalThis.fetch = async () => answer(404, { error: 'this local server has no API' });
    assert.deepEqual(await saveRun(real), { local: true, remote: 'offline' });
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
    assert.deepEqual(await saveRun(real), { local: true, remote: 'offline' });
    assert.deepEqual(await loadRun('mwbXAp'), real, 'the copy here is untouched by any of that');
    globalThis.fetch = async () => answer(403, { error: 'someone else\'s' });
    assert.deepEqual(await saveRun(real), { local: true, remote: 'refused' });
  } finally {
    delete globalThis.localStorage;
    globalThis.fetch = realFetch;
  }
});
