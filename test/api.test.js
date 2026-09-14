import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi } from '../worker/api.js';
import worker from '../worker/index.js';
import { openD1, sqliteAvailable } from './d1-sqlite.js';
import { specId, normalizeSpec, displayTemplate } from '../src/spec.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// A real run, committed for the landing page's samples: thirty replies, so the reply rows span a partial batch.
const sample = JSON.parse(await fs.readFile(path.join(ROOT, 'assets', 'samples', 'runs', 'D5a3G9.results.json'), 'utf8'));
const skip = (await sqliteAvailable()) ? false : 'node:sqlite (Node 22.13 or newer) is needed to run the API in the suite';

const MINE = 'this-browser-0123456789abcdef';
const THEIRS = 'someone-else-0123456789abcdef';
const bearer = (token) => ({ authorization: `Bearer ${token}` });
const call = (env, method, p, { body, headers = {} } = {}) =>
  handleApi(new Request(`https://llmscope.dev${p}`, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined }), env);

test('a saved run reads back whole, lists under its eval, and only the token that saved it may replace or remove it', { skip }, async () => {
  const env = { DB: await openD1() };
  let res = await call(env, 'PUT', '/api/runs/D5a3G9', { body: sample, headers: bearer(MINE) });
  const saved = await res.text();
  assert.equal(res.status, 201, saved);
  const evalId = await specId(normalizeSpec(sample.spec));
  assert.deepEqual(JSON.parse(saved), { id: 'D5a3G9', eval: evalId, replies: 30 });

  res = await call(env, 'GET', '/api/runs/D5a3G9');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*', 'reading is open');
  let back = await res.json();
  assert.deepEqual(back.results, sample.results, 'every reply, in order, unchanged');
  assert.equal(back.spec_id, evalId, 'a run saved before runs recorded their eval is filed under the eval its spec hashes to');
  const { results: _a, spec_id: _b, ...rest } = back;
  const { results: _c, ...orig } = sample;
  assert.deepEqual(rest, orig, 'and the rest of the record is as it was');

  res = await call(env, 'GET', `/api/evals/${evalId}`);
  assert.equal(res.status, 200);
  const ev = await res.json();
  assert.deepEqual(ev.spec, normalizeSpec(sample.spec));
  assert.equal(ev.prompt, displayTemplate(ev.spec.prompts[0], ev.spec.variables));
  assert.equal(ev.runs.length, 1);
  assert.deepEqual(ev.runs[0], { id: 'D5a3G9', eval: evalId, at: sample.finished_at, prompt: ev.prompt, primary: ev.spec.primary, models: ev.spec.models.length, replies: 30, provider: 'openrouter', cost: sample.cost.usd });

  // Marking words after the fact saves the run again: replaced whole, by the same token, with no reply doubled.
  res = await call(env, 'PUT', '/api/runs/D5a3G9', { body: { ...sample, highlight: ['nervous'] }, headers: bearer(MINE) });
  assert.equal(res.status, 200);
  back = await (await call(env, 'GET', '/api/runs/D5a3G9')).json();
  assert.deepEqual(back.highlight, ['nervous']);
  assert.equal(back.results.length, 30);
  assert.equal(env.DB.sqlite.prepare('SELECT count(*) AS n FROM replies').get().n, 30);

  assert.equal((await call(env, 'PUT', '/api/runs/D5a3G9', { body: sample, headers: bearer(THEIRS) })).status, 403, 'another token cannot replace it');
  assert.equal((await call(env, 'DELETE', '/api/runs/D5a3G9', { headers: bearer(THEIRS) })).status, 403, 'nor remove it');
  assert.equal((await call(env, 'PUT', '/api/runs/D5a3G9', { body: sample })).status, 401, 'and no token at all cannot save');
  assert.equal(env.DB.sqlite.prepare('SELECT owner FROM runs WHERE id = ?').get('D5a3G9').owner.length, 64, 'the row keeps a hash, never the token');

  assert.equal((await call(env, 'DELETE', '/api/runs/D5a3G9', { headers: bearer(MINE) })).status, 204);
  assert.equal((await call(env, 'GET', '/api/runs/D5a3G9')).status, 404);
  assert.equal(env.DB.sqlite.prepare('SELECT count(*) AS n FROM replies').get().n, 0, 'its replies go with it');
  const after = await (await call(env, 'GET', `/api/evals/${evalId}`)).json();
  assert.equal(after.runs.length, 0, 'the eval stays: it is a recipe, not a run');
});

test('what the API refuses: mock runs, a body under the wrong id, junk, and ids that are not ids', { skip }, async () => {
  const env = { DB: await openD1() };
  const put = (id, body, headers = bearer(MINE)) => call(env, 'PUT', `/api/runs/${id}`, { body, headers });
  const said = async (res, status, words) => { assert.equal(res.status, status); assert.match((await res.json()).error, words); };
  await said(await put('D5a3G9', { ...sample, provider: 'mock' }), 400, /mock runs/);
  await said(await put('AAAAAA', sample), 400, /says it is D5a3G9/);
  await said(await put('D5a3G9', { id: 'D5a3G9', spec: {}, provider: 'openrouter' }), 400, /no results/);
  await said(await put('D5a3G9', { ...sample, results: [{ text: 'no model' }] }), 400, /names its model/);
  await said(await call(env, 'GET', '/api/runs/not-an-id'), 400, /not an llmscope id/);
  await said(await call(env, 'GET', '/api/runs/zzzzzz'), 404, /no run zzzzzz/);
  await said(await call(env, 'GET', '/api/evals/zzzzzz'), 404, /no eval zzzzzz/);
  await said(await call(env, 'GET', '/api/nothing/zzzzzz'), 404, /no such route/);
  await said(await call(env, 'POST', '/api/runs/zzzzzz'), 405, /PUT/);
  const health = await call(env, 'GET', '/api/health');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, database: true });
  assert.equal((await handleApi(new Request('https://llmscope.dev/api/runs/D5a3G9'), {})).status, 503, 'says so when nothing is bound');
});

test('the Worker hands /api to the API and every /<id> to a page: the built one for a bundled eval, the root one for any other', { skip }, async () => {
  const served = [];
  const ASSETS = { fetch: async (req) => {
    const p = new URL(req.url).pathname;
    served.push(p);
    return ['/D5a3G9', '/e/D5a3G9', '/new', '/'].includes(p) ? new Response(`page:${p}`) : new Response('not found', { status: 404 });
  } };
  const env = { DB: await openD1(), ASSETS };
  const get = (p) => worker.fetch(new Request(`https://llmscope.dev${p}`), env);
  assert.equal(await (await get('/D5a3G9')).text(), 'page:/D5a3G9', 'the address a card prints');
  assert.equal(await (await get('/zzzzzz')).text(), 'page:/', 'an id the build does not know still opens the page that can read it');
  assert.equal(await (await get('/e/D5a3G9')).text(), 'page:/e/D5a3G9', 'the address earlier cards printed');
  assert.equal(await (await get('/e/zzzzzz')).text(), 'page:/');
  assert.equal(await (await get('/new')).text(), 'page:/new', 'the empty form is a built page');
  assert.equal((await get('/e/nope')).status, 404, 'but an address that is not an id is nothing');
  assert.equal((await get('/nope')).status, 404);
  assert.equal((await get('/api/health')).status, 200);
  assert.equal((await get('/api/runs/zzzzzz')).status, 404);
  assert.ok(!served.some((p) => p.startsWith('/api')), 'the API never reaches the asset store');
  assert.equal((await worker.fetch(new Request('https://llmscope.dev/e/zzzzzz'), { DB: env.DB })).status, 404, 'with no assets bound there is no page to hand out');
});
