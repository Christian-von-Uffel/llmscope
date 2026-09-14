// The site's API: runs and the evals they are generations of, kept in Cloudflare D1 under the same six-character
// ids the CLI files them under in evals/ and out/. This is what makes the address printed on every card answer
// for somebody who was not there when the run happened: llmscope.dev/<id> reads the run back from here.
//
// Nothing is rendered on this side. The page and the CLI draw every image from the run's JSON, as they always
// have, so the database keeps the run and the images are made wherever they are looked at.
//
// The handler is written against the shape of a D1 binding — prepare().bind().first()/all(), and batch() for
// one transaction — and nothing else about Workers, so test/api.test.js runs it on node:sqlite with no account.
//
// Ownership without accounts: whoever saves a run sends a bearer token they minted themselves (the page keeps one
// per browser, the CLI one per machine). The row keeps the token's hash, and only the same token may replace or
// remove the run. Reading is open: a run is published by being saved, which is the point of saving it.
import { normalizeSpec, specId, displayTemplate } from '../src/spec.js';
import { isValidId } from '../src/id.js';

export const MAX_BODY_BYTES = 8 * 1024 * 1024; // a run's JSON on the way in; a hundred replies is a few hundred KB
export const MAX_REPLIES = 5000;
const ROWS_PER_INSERT = 8; // twelve bound values a row, under D1's hundred per statement
const RUNS_PER_EVAL = 20; // how many of an eval's runs a lookup lists, newest first

const OPEN = { 'access-control-allow-origin': '*' }; // reads are public; writes are same-origin only, so no CORS is offered for them
const CACHED = { ...OPEN, 'cache-control': 'public, max-age=60' };

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const problem = (status, error) => json({ error }, status);

/** Route one request under /api. `env.DB` is the D1 binding (or anything shaped like one). */
export async function handleApi(request, env) {
  const url = new URL(request.url);
  const [root, kind, id, extra] = url.pathname.split('/').filter(Boolean);
  const method = request.method.toUpperCase();
  if (root !== 'api') return problem(404, 'not the API');
  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...OPEN, 'access-control-allow-methods': 'GET, HEAD', 'access-control-max-age': '86400' } });
  if (!kind || kind === 'health') {
    return method === 'GET' || method === 'HEAD' ? json({ ok: true, database: Boolean(env.DB) }, 200, OPEN) : problem(405, 'GET only');
  }
  if (!env.DB) return problem(503, 'no database is bound to this Worker');
  if (!id || extra) return problem(404, 'no such route');
  if (!isValidId(id)) return problem(400, `${id} is not an llmscope id: six characters, like D5a3G9`);
  if (kind === 'runs') {
    if (method === 'GET' || method === 'HEAD') return getRun(env.DB, id);
    if (method === 'PUT') return putRun(env.DB, id, request);
    if (method === 'DELETE') return deleteRun(env.DB, id, request);
    return problem(405, 'GET, PUT or DELETE');
  }
  if (kind === 'evals') return method === 'GET' || method === 'HEAD' ? getEval(env.DB, id) : problem(405, 'GET only');
  return problem(404, 'no such route');
}

// ---------- reading ----------

/** The run as it was saved: its record, with every reply back in its place. */
async function getRun(db, id) {
  const row = await db.prepare('SELECT meta FROM runs WHERE id = ?').bind(id).first();
  if (!row) return problem(404, `no run ${id} has been saved here`);
  const { results } = await db.prepare('SELECT body FROM replies WHERE run_id = ? ORDER BY idx').bind(id).all();
  const run = JSON.parse(row.meta);
  run.results = results.map((r) => JSON.parse(r.body));
  return json(run, 200, CACHED);
}

const ENTRY_COLUMNS = 'id, eval_id, provider, measure, prompt, models, replies, cost_usd, finished_at';
/** One run as the pickers list it: the same fields web/store.js keeps in its own index, so either source draws the same line. */
const entryOf = (r) => ({ id: r.id, eval: r.eval_id, at: r.finished_at, prompt: r.prompt, primary: r.measure, models: r.models, replies: r.replies, provider: r.provider, cost: r.cost_usd });

/** An eval's recipe and the runs saved of it, newest first, so an eval's id on a card opens its newest card. */
async function getEval(db, id) {
  const row = await db.prepare('SELECT spec, prompt FROM evals WHERE id = ?').bind(id).first();
  if (!row) return problem(404, `no eval ${id} has been saved here`);
  const { results } = await db.prepare(`SELECT ${ENTRY_COLUMNS} FROM runs WHERE eval_id = ? ORDER BY finished_at DESC LIMIT ?`).bind(id, RUNS_PER_EVAL).all();
  return json({ id, spec: JSON.parse(row.spec), prompt: row.prompt, runs: results.map(entryOf) }, 200, CACHED);
}

// ---------- writing ----------

async function sha256Hex(text) {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The bearer token the client saves with, hashed: a row keeps the hash and never the token. Null when none was sent. */
async function ownerOf(request) {
  const m = (request.headers.get('authorization') || '').match(/^Bearer\s+([A-Za-z0-9_-]{16,128})$/i);
  return m ? sha256Hex(m[1]) : null;
}

/** What is wrong with a body sent as a run, in words, or null when it is one. */
function describeBadRun(run, id) {
  if (!run || typeof run !== 'object' || Array.isArray(run)) return 'the body is not a run';
  if (run.id !== id) return `the run says it is ${run.id ?? 'nothing'}, but was sent to ${id}`;
  if (!run.spec || typeof run.spec !== 'object') return 'the run carries no spec';
  if (!Array.isArray(run.results)) return 'the run carries no results';
  if (run.results.length > MAX_REPLIES) return `a run is capped at ${MAX_REPLIES} replies`;
  if (run.results.some((r) => !r || typeof r !== 'object' || typeof r.model !== 'string')) return 'every reply names its model';
  if (typeof run.provider !== 'string' || !run.provider) return 'the run names no provider';
  return null;
}

const flag = (v) => (v === true ? 1 : v === false ? 0 : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The replies as rows, several to a statement: a run of a few hundred replies is a few dozen statements in one batch. */
function replyInserts(db, runId, results) {
  const stmts = [];
  for (let at = 0; at < results.length; at += ROWS_PER_INSERT) {
    const chunk = results.slice(at, at + ROWS_PER_INSERT);
    const values = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
    const params = chunk.flatMap((r, i) => [
      runId, at + i, r.model, String(r.variantKey ?? ''), Number(r.run) || 0,
      flag(r.refused), flag(r.matched), num(r.sentiment_score), r.error ? String(r.error) : null,
      num(r.total_tokens ?? r.tokens), num(r.cost), JSON.stringify(r),
    ]);
    stmts.push(db.prepare(`INSERT INTO replies (run_id, idx, model, variant, repeat, refused, matched, sentiment, error, tokens, cost_usd, body) VALUES ${values}`).bind(...params));
  }
  return stmts;
}

/**
 * Save a run under its id, and its eval under the eval's. Saving again replaces the run whole — the page does that
 * when words are marked after the fact — but only with the token that saved it first. The eval's row is written
 * once and then left alone: it is content-addressed, so a second copy could only be the same.
 */
async function putRun(db, id, request) {
  const owner = await ownerOf(request);
  if (!owner) return problem(401, 'saving a run takes its owner token: Authorization: Bearer <token>');
  const tooBig = problem(413, `a run is capped at ${MAX_BODY_BYTES / 1024 / 1024} MB of JSON`);
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) return tooBig;
  let run;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return tooBig;
    run = JSON.parse(text);
  } catch { return problem(400, 'the body is not JSON'); }
  const wrong = describeBadRun(run, id);
  if (wrong) return problem(400, wrong);
  if (run.provider === 'mock') return problem(400, 'mock runs are demos and are not published');
  let spec;
  try { spec = normalizeSpec(run.spec); } catch (err) { return problem(400, `the spec does not normalize: ${err.message}`); }
  // Runs saved before runs recorded their eval carry no spec_id; the spec hashes to it either way.
  const evalId = isValidId(run.spec_id) ? run.spec_id : await specId(spec);
  const held = await db.prepare('SELECT owner FROM runs WHERE id = ?').bind(id).first();
  if (held && held.owner !== owner) return problem(403, `run ${id} was saved by someone else; only the token that saved it can replace it`);

  const { results, ...meta } = run;
  meta.spec_id = evalId;
  const now = new Date().toISOString();
  const prompt = displayTemplate(spec.prompts[0] || '', spec.variables);
  const priced = results.filter((r) => typeof r.cost === 'number');
  const cost = typeof run.cost?.usd === 'number' ? run.cost.usd : priced.length ? priced.reduce((s, r) => s + r.cost, 0) : null;
  await db.batch([
    db.prepare('INSERT INTO evals (id, spec, prompt, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO NOTHING')
      .bind(evalId, JSON.stringify(spec), prompt, now),
    db.prepare(`INSERT INTO runs (id, eval_id, owner, provider, measure, prompt, models, replies, cost_usd, finished_at, created_at, updated_at, meta)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET eval_id = excluded.eval_id, provider = excluded.provider, measure = excluded.measure,
        prompt = excluded.prompt, models = excluded.models, replies = excluded.replies, cost_usd = excluded.cost_usd,
        finished_at = excluded.finished_at, updated_at = excluded.updated_at, meta = excluded.meta
      WHERE runs.owner = excluded.owner`)
      .bind(id, evalId, owner, run.provider, spec.primary, prompt, spec.models.length, results.length, cost,
        String(run.finished_at || run.started_at || now), now, now, JSON.stringify(meta)),
    db.prepare('DELETE FROM replies WHERE run_id = ?').bind(id),
    ...replyInserts(db, id, results),
  ]);
  return json({ id, eval: evalId, replies: results.length }, held ? 200 : 201);
}

/** Take a run down. Its eval stays: that is a recipe, and other runs may be generations of it. */
async function deleteRun(db, id, request) {
  const owner = await ownerOf(request);
  if (!owner) return problem(401, 'removing a run takes its owner token: Authorization: Bearer <token>');
  const held = await db.prepare('SELECT owner FROM runs WHERE id = ?').bind(id).first();
  if (!held) return problem(404, `no run ${id} has been saved here`);
  if (held.owner !== owner) return problem(403, `run ${id} was saved by someone else; only the token that saved it can remove it`);
  await db.batch([
    db.prepare('DELETE FROM replies WHERE run_id = ?').bind(id),
    db.prepare('DELETE FROM runs WHERE id = ?').bind(id),
  ]);
  return new Response(null, { status: 204 });
}
