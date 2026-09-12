// Everything the browser remembers between visits, in one place.
//
// Two kinds of memory live here and they are deliberately not the same kind. Preferences — the API key, the
// keyword batches you have typed, the model sets you have run — belong to this browser and stay in
// localStorage forever; the key in particular is a secret the page is trusted with and must never be sent
// anywhere but openrouter.ai, so it has no remote half by design. Runs are the other kind: they are the work,
// they are worth keeping across machines, and they are what Supabase will hold. So the run functions are async
// even though localStorage answers instantly, and every caller already awaits them. Swapping the backend is
// then a change to four function bodies rather than a change to the app.

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
// The index is a separate small record so listing what you have run does not mean parsing every run. Each entry
// is what the picker needs to show a line and nothing more.

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

/** @returns {Promise<Array<{id, at, prompt, primary, models, replies, provider}>>} newest first */
export async function listRuns() {
  return (read(RUN_INDEX, []) || []).filter((e) => e && e.id);
}

/** The whole run, or null when it was never saved or has since been evicted. */
export async function loadRun(id) {
  return read(RUN_PREFIX + id, null);
}

/**
 * Save a run and index it. Quota is the normal failure here, not the exception — a hundred replies with their
 * full text is a large record — so a failed write evicts the oldest run and tries again rather than throwing at
 * a caller who is in the middle of finishing a run.
 * @returns {Promise<boolean>} whether the run itself made it to disk
 */
export async function saveRun(run) {
  if (!run?.id) return false;
  const entry = {
    id: run.id,
    at: run.finished_at || new Date().toISOString(),
    prompt: runPromptLine(run),
    primary: run.spec?.primary || 'refusal',
    models: run.spec?.models?.length || 0,
    replies: run.results?.length || 0,
    provider: run.provider || '',
  };
  let index = [entry, ...(await listRuns()).filter((e) => e.id !== run.id)].slice(0, RUN_LIMIT);
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
