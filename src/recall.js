// Node-only: the things the CLI can offer back to you, and the one rule that orders them.
//
// Keywords, prompts and model sets are all retyped far more often than they are invented, and they already
// exist in the same places: what you typed lately, the eval files in evals/, the bundled examples, and the
// finished runs in out/. This module holds what those have in common — reading them, stamping each with when
// it was last used, and putting the most recent first — so they cannot drift into two orderings.
import { cleanModels, modelKey } from './models.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, updateConfig, configPath } from './config.js';

export const HISTORY_LIMIT = 20;

/** When a file was last written, as an ISO string, so every source of an entry compares on one scale. */
export async function mtime(file) {
  try { return (await fs.stat(file)).mtime.toISOString(); } catch { return ''; }
}

/** A path a person can read: relative to here when it is under here, else just the folder it sits in. */
export function shortPath(file) {
  const rel = path.relative(process.cwd(), file);
  return rel.startsWith('..') ? path.join(path.basename(path.dirname(file)), path.basename(file)) : rel;
}

export async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

/** The JSON files in a directory, each with the moment it was last written. */
export async function jsonFilesIn(dir, suffix = '.json') {
  let names = [];
  try { names = (await fs.readdir(dir)).filter((f) => f.endsWith(suffix)).sort(); } catch { return []; }
  const files = [];
  for (const f of names) {
    const file = path.join(dir, f);
    files.push({ file, at: await mtime(file) });
  }
  return files;
}

/**
 * A config-backed list of things used lately, newest first, each stamped with when it was used. The stamp is
 * what lets a typed entry be ordered against the files on disk rather than merely ahead of them. An entry
 * written before entries were stamped takes the config file's own mtime, the last moment it can have been saved.
 */
export async function loadHistory(field) {
  const cfg = await loadConfig();
  const raw = Array.isArray(cfg[field]) ? cfg[field] : [];
  let fallback = null;
  const out = [];
  for (const e of raw) {
    const wrapped = Boolean(e) && typeof e === 'object' && !Array.isArray(e);
    const value = wrapped ? (e.value ?? e.terms) : e; // `terms` is the shape the keyword list first used
    if (value == null || value === '' || (Array.isArray(value) && !value.length)) continue;
    let at = wrapped ? String(e.at || '') : '';
    if (!at) {
      if (fallback === null) fallback = await mtime(configPath());
      at = fallback;
    }
    out.push({ value, at });
  }
  return out;
}

/** Push a thing to the front of its list, deduped, so walking back through it never repeats. */
export async function remember(field, value, { key = (v) => JSON.stringify(v), limit = HISTORY_LIMIT, at = new Date().toISOString() } = {}) {
  const k = key(value);
  const rest = (await loadHistory(field)).filter((e) => key(e.value) !== k);
  await updateConfig({ [field]: [{ value, at }, ...rest].slice(0, limit) });
  return value;
}

/**
 * Newest first, then one entry per distinct thing. Sorting before duplicates collapse is the whole point: a
 * thing found in several places takes the position of its most recent use and not of its oldest. Entries with
 * no time of their own sort last rather than jumping the queue, and ties keep the order they were added in.
 */
export function byRecency(found) {
  const sorted = [...found].sort((a, b) => String(b.when).localeCompare(String(a.when)));
  const out = [];
  const seen = new Set();
  for (const f of sorted) {
    if (seen.has(f.key)) continue;
    seen.add(f.key);
    out.push(f);
  }
  return out;
}

// ---------- prompts ----------

/** Identity of a prompt: the wording, with the whitespace it was typed with reduced to one shape. */
export const promptKey = (p) => String(p ?? '').replace(/\s+/g, ' ').trim();

export async function loadPromptHistory() {
  return (await loadHistory('prompt_history')).map((e) => ({ prompt: String(e.value), at: e.at })).filter((e) => e.prompt.trim());
}

export async function rememberPrompt(prompt, { at } = {}) {
  const text = String(prompt ?? '').trim();
  if (!text) return text;
  await remember('prompt_history', text, { key: promptKey, at });
  return text;
}

/**
 * Every prompt this project has asked, most recently first: the ones typed lately, then whatever the evals and
 * the finished runs hold. Testing a subtle change means running the last wording with two words moved, so the
 * previous wording has to be one keystroke away rather than something to find and paste.
 */
export async function promptBank({ history = [], evalDirs = [], runDirs = [] } = {}) {
  const found = [];
  const add = (text, entry) => {
    const prompt = String(text ?? '').trim();
    if (prompt) found.push({ prompt, key: promptKey(prompt), when: '', ...entry });
  };
  for (const e of history) {
    const entry = typeof e === 'string' ? { prompt: e, at: '' } : (e || {});
    add(entry.prompt ?? entry.value, { source: 'recent', origin: 'recently used', when: entry.at || '' });
  }
  for (const dir of evalDirs) {
    for (const { file, at } of await jsonFilesIn(dir)) {
      // Prompts within one file share its time, so ties keep them in the order the eval asks them.
      try { for (const p of [].concat(readPrompts(await readJson(file)))) add(p, { source: 'eval', origin: shortPath(file), when: at }); } catch {}
    }
  }
  for (const dir of runDirs) {
    for (const { file } of await jsonFilesIn(dir, '.results.json')) {
      try {
        const run = await readJson(file);
        const when = run.finished_at || run.started_at || '';
        for (const p of [].concat(readPrompts(run.spec))) add(p, { source: 'run', origin: `run ${run.id}`, when });
      } catch {}
    }
  }
  return byRecency(found);
}

function readPrompts(spec) {
  const p = spec?.prompts;
  return Array.isArray(p) ? p : (typeof p === 'string' ? [p] : []);
}

// ---------- model sets ----------

/** Recently used model sets as {models, at}, newest first. */
export async function loadModelHistory() {
  return (await loadHistory('model_history'))
    .map((e) => ({ models: cleanModels(e.value), at: e.at }))
    .filter((e) => e.models.length);
}

/** Push a set to the front of the recent list, deduped, so up-arrow walks distinct sets and not repeats. */
export async function rememberModels(ids, { at } = {}) {
  const list = cleanModels(ids);
  if (!list.length) return list;
  await remember('model_history', list, { key: modelKey, at });
  return list;
}

/**
 * Every model set this project has used, most recently first: what was picked lately, then whatever the evals
 * and the finished runs hold, then the live frontier defaults (untimed, so they sit last unless they were
 * also used). A set that appears in several places takes the position of its most recent use and shows up once.
 */
export async function modelBank({ history = [], evalDirs = [], runDirs = [], frontier = [] } = {}) {
  const found = [];
  const add = (ids, entry) => {
    const models = cleanModels(ids);
    if (models.length) found.push({ models, key: modelKey(models), when: '', ...entry });
  };
  for (const e of history) {
    const entry = Array.isArray(e) ? { models: e, at: '' } : (e || {});
    add(entry.models ?? entry.value, { source: 'recent', origin: 'recently used', when: entry.at || '' });
  }
  for (const dir of evalDirs) {
    for (const { file, at } of await jsonFilesIn(dir)) {
      try { add((await readJson(file)).models, { source: 'eval', origin: shortPath(file), when: at }); } catch {}
    }
  }
  for (const dir of runDirs) {
    for (const { file } of await jsonFilesIn(dir, '.results.json')) {
      try {
        const run = await readJson(file);
        add(run.spec?.models, { source: 'run', origin: `run ${run.id}`, when: run.finished_at || run.started_at || '' });
      } catch {}
    }
  }
  if (frontier.length) add(frontier, { source: 'frontier', origin: 'frontier defaults', when: '' });
  return byRecency(found);
}
