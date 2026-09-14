// Everything the browser remembers between visits, in one place.
//
// Two kinds of memory live here and they are deliberately not the same kind. Preferences — the API key, the
// keyword batches you have typed, the model sets you have run — belong to this browser and stay in
// localStorage forever; the key in particular is a secret the page is trusted with and must never be sent
// anywhere but openrouter.ai, so it has no remote half by design. Runs are the other kind: they are the work,
// they are worth keeping, and they are what the site's API holds — a Cloudflare Worker over D1, in worker/ —
// under the same id the card prints, so the address on a card opens for somebody who was not there. The run
// functions are async for that reason, and every caller awaits them; the API is asked only from this file.

import { displayTemplate } from '../src/spec.js';

const KEY = 'llmscope:openrouter_key';
const BATCHES = 'llmscope:keyword_history';
const MODELS = 'llmscope:model_history';
const RUN_INDEX = 'llmscope:runs';
const RUN_PREFIX = 'llmscope:run:';
const PREF = 'llmscope:pref:';
const LIMIT = 20; // batches and model sets kept, newest first
const RUN_LIMIT = 30; // saved runs kept before the oldest is dropped

const read = (k, fallback) => { try { const v = localStorage.getItem(k); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };
const drop = (k) => { try { localStorage.removeItem(k); } catch {} };

// ---------- the API key ----------
// Stored raw rather than JSON so a key written by an earlier version still reads back.
export const readKey = () => { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } };
export const writeKey = (key) => { try { localStorage.setItem(KEY, key); } catch {} };
export const clearKey = () => drop(KEY);

// ---------- small preferences ----------
export const getPref = (name, fallback = null) => { try { return localStorage.getItem(PREF + name) ?? fallback; } catch { return fallback; } };
export const setPref = (name, value) => { try { localStorage.setItem(PREF + name, value); } catch {} };

// ---------- lists you have typed before ----------
/** Newest first, deduped however each entry was ordered. `key` decides what counts as the same entry. */
function remember(storeKey, list, entry, key) {
  if (!entry.length) return list;
  const k = key(entry);
  const next = [entry, ...list.filter((e) => key(e) !== k)].slice(0, LIMIT);
  write(storeKey, next);
  return next;
}

export const keywordBatches = () => (read(BATCHES, []) || []).filter((t) => Array.isArray(t) && t.length);
export const rememberBatch = (terms, key) => remember(BATCHES, keywordBatches(), terms, key);

export const modelSets = () => (read(MODELS, []) || []).filter((m) => Array.isArray(m) && m.length);
export const rememberModelSet = (ids, key) => remember(MODELS, modelSets(), ids, key);

// ---------- runs ----------
// A run lives in two places. This browser keeps its own copy, as it always has, so reopening is instant and works
// with no server at all (`llmscope serve`); the site's API keeps the durable one under the same id. saveRun
// writes both; everything else reads this browser first and asks the API only for what this browser does not hold.
//
// The index is a separate small record so listing what you have run does not mean parsing every run. Each entry
// is what the picker needs to show a line and nothing more.

const API = '/api'; // same origin: the Worker serves the site, the dev server proxies to it, a static host rewrites to it
const OWNER = 'llmscope:owner';

/**
 * This browser's own token, minted once. The API keeps its hash beside every run this browser saves, and only the
 * same token may replace or remove the run later. It is not a secret shared with anyone; clearing site data loses
 * it, and the runs stay published but can no longer be changed from here.
 */
function ownerToken() {
  try {
    let token = localStorage.getItem(OWNER);
    if (!token) {
      const bytes = new Uint8Array(24);
      crypto.getRandomValues(bytes);
      token = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
      localStorage.setItem(OWNER, token);
    }
    return token;
  } catch { return null; }
}

/**
 * One call to the API. Null when there is no API on this origin — `llmscope serve --registry none`, a static
 * host without the rewrite, a local server whose registry cannot be reached, or no network — which every caller
 * treats as "this browser is on its own", never as an error. An answer that is not JSON is the same thing: a
 * static server handing out the page for a path it does not know.
 */
async function api(path, init) {
  try {
    const res = await fetch(API + path, init);
    if (res.status === 204) return { status: 204, body: null };
    if (!/\bapplication\/json\b/.test(res.headers.get('content-type') || '')) return null;
    return { status: res.status, body: await res.json() };
  } catch { return null; }
}

/** The prompt as the card titles it, so the reopen list and the heading never disagree about what was asked. */
export function runPromptLine(run) {
  const prompts = [].concat(run?.spec?.prompts || []);
  return displayTemplate(prompts[0] || '', run?.spec?.variables || {});
}

/** The line the reopen picker shows. The prompt is kept in full: a cut line reads as a different question. */
export function runPickerLabel(e) {
  const prompt = String(e?.prompt || '').replace(/\s+/g, ' ').trim();
  return [e?.id, e?.primary, e?.replies != null ? `${e.replies} replies` : null, prompt || null].filter(Boolean).join(' · ');
}

/** @returns {Promise<Array<{id, eval, at, prompt, primary, models, replies, provider}>>} this browser's runs, newest first */
export async function listRuns() {
  return (read(RUN_INDEX, []) || []).filter((e) => e && e.id);
}

/**
 * The whole run: this browser's copy, or the site's when this browser never had it or has since evicted it. Null
 * when neither holds it.
 */
export async function loadRun(id) {
  const own = read(RUN_PREFIX + id, null);
  if (own) return own;
  const got = await api(`/runs/${id}`);
  return got?.status === 200 && Array.isArray(got.body?.results) ? got.body : null;
}

/**
 * The newest run this browser has of one eval. A run's id is its own; the eval's id is the content-addressed one
 * the spec plans to, and every run of it is a generation under that. Runs saved before runs had ids of their own
 * were keyed by the eval's id, so for those the two are the same and the lookup still lands.
 */
export async function latestRunFor(evalId) {
  const entry = (await listRuns()).find((e) => (e.eval || e.id) === evalId);
  return entry ? loadRun(entry.id) : null;
}

/**
 * What the site has published under an eval's id: its spec, and the runs saved of it newest first, each as an
 * index entry like listRuns gives. Null when the site has no API, or knows no such eval.
 * @returns {Promise<{id, spec, prompt, runs: Array<{id, eval, at, prompt, primary, models, replies, provider}>}|null>}
 */
export async function publishedEval(id) {
  const got = await api(`/evals/${id}`);
  return got?.status === 200 && got.body?.spec ? got.body : null;
}

/**
 * Save a run here and on the site.
 * @returns {Promise<{local: boolean, remote: 'saved'|'skipped'|'refused'|'offline'}>} whether the run made it to
 *   this browser's storage, and what the site said: saved under its id; skipped because it is a mock run, which
 *   is a demo; refused because the id is already somebody else's; or offline because this origin has no API.
 */
export async function saveRun(run) {
  if (!run?.id) return { local: false, remote: 'skipped' };
  const local = saveHere(run);
  const remote = await publishRun(run);
  return { local, remote };
}

/**
 * Save a run in this browser and index it. Quota is the normal failure here, not the exception — a hundred replies
 * with their full text is a large record — so a failed write evicts the oldest run and tries again rather than
 * throwing at a caller who is in the middle of finishing a run.
 */
function saveHere(run) {
  const entry = {
    id: run.id,
    eval: run.spec_id || null,
    at: run.finished_at || new Date().toISOString(),
    prompt: runPromptLine(run),
    primary: run.spec?.primary || 'refusal',
    models: run.spec?.models?.length || 0,
    replies: run.results?.length || 0,
    provider: run.provider || '',
  };
  let index = [entry, ...(read(RUN_INDEX, []) || []).filter((e) => e && e.id && e.id !== run.id)].slice(0, RUN_LIMIT);
  for (const stale of (read(RUN_INDEX, []) || []).filter((e) => !index.some((k) => k.id === e.id))) drop(RUN_PREFIX + stale.id);
  while (index.length) {
    if (write(RUN_PREFIX + run.id, run)) { write(RUN_INDEX, index); return true; }
    const oldest = index.pop();
    if (!oldest || oldest.id === run.id) break;
    drop(RUN_PREFIX + oldest.id);
  }
  write(RUN_INDEX, index);
  return false;
}

/** Send a run to the site under its id, with this browser's token. Mock runs stay home: they are demos. */
async function publishRun(run) {
  if (run.provider === 'mock') return 'skipped';
  const token = ownerToken();
  if (!token) return 'offline';
  const got = await api(`/runs/${run.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(run),
  });
  if (!got || got.status === 404) return 'offline';
  return got.status === 200 || got.status === 201 ? 'saved' : 'refused';
}

/**
 * Forget a run here and take it down from the site.
 * @returns {Promise<boolean>} whether the site no longer holds it — false when it is somebody else's, or when
 *   this origin has no API to ask
 */
export async function deleteRun(id) {
  drop(RUN_PREFIX + id);
  write(RUN_INDEX, (read(RUN_INDEX, []) || []).filter((e) => e && e.id !== id));
  const token = ownerToken();
  const got = token ? await api(`/runs/${id}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } }) : null;
  return Boolean(got && (got.status === 204 || got.status === 404));
}
