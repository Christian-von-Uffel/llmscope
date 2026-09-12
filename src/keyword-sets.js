// Node-only: every place a batch of keywords can come from, so a list typed once can be used again.
// Two stores already held keyword lists and neither knew about the other: the eval files in evals/, and the
// saved runs in out/ (both the eval's own keywords and any highlight edited onto the run after reading it).
// keywords/*.json is the third, for vocabulary that outlives one eval — hedges, agency frames, moral foundations.
import fs from 'node:fs/promises';
import path from 'node:path';
import { splitTerms, cleanTerms, batchKey } from './checks/keywords.js';
import { loadHistory, remember, byRecency, jsonFilesIn, readJson, mtime, shortPath, HISTORY_LIMIT } from './recall.js';

export { HISTORY_LIMIT };
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function keywordsDir(root = process.cwd()) {
  return process.env.LLMSCOPE_KEYWORDS_DIR || path.join(root, 'keywords');
}

/** Terms as typed or as saved: a string splits on commas (a regex keeps its own), a list is taken as written. */
// ---------- named sets ----------

/**
 * The named batches in keywords/. A file is either a bare list of terms or {description, keywords}, and the
 * filename is the name: keywords/hedges.json is @hedges anywhere a keyword list can be typed.
 */
export async function loadKeywordSets({ root = process.cwd() } = {}) {
  const dir = keywordsDir(root);
  let names = [];
  try { names = (await fs.readdir(dir)).filter((f) => f.endsWith('.json')).sort(); } catch { return []; }
  const sets = [];
  for (const f of names) {
    try {
      const raw = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'));
      const body = Array.isArray(raw) ? { keywords: raw } : (raw || {});
      const terms = cleanTerms(body.keywords ?? body.terms);
      if (terms.length) sets.push({ name: f.replace(/\.json$/, ''), file: path.join(dir, f), terms, description: String(body.description || '') });
    } catch {} // a set that will not parse is skipped rather than fatal: the other stores still work
  }
  return sets;
}

export async function saveKeywordSet(name, terms, { root = process.cwd(), description = '' } = {}) {
  if (!NAME_RE.test(String(name || ''))) throw new Error(`"${name}" is not a set name: letters, digits, - and _, starting with a letter or digit`);
  const list = cleanTerms(terms);
  if (!list.length) throw new Error('a set needs at least one valid keyword');
  const dir = keywordsDir(root);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  await fs.writeFile(file, JSON.stringify({ description, keywords: list }, null, 2) + '\n');
  return { name, file, terms: list, description };
}

/**
 * A typed list in which `@name` stands for a named set: `@hedges,maybe` is that set plus one more word.
 * A name matching nothing comes back in `missing` rather than reaching the matcher as literal text, because a
 * run scored on the word "@hedges" looks like it worked and measures nothing.
 */
export function resolveKeywordTerms(raw, sets = []) {
  const byName = new Map(sets.map((s) => [s.name.toLowerCase(), s.terms]));
  const terms = [];
  const missing = [];
  for (const t of splitTerms(raw)) {
    if (!t.startsWith('@')) { terms.push(t); continue; }
    const found = byName.get(t.slice(1).toLowerCase());
    if (found) terms.push(...found);
    else missing.push(t);
  }
  return { terms: [...new Set(terms)], missing };
}

// ---------- recently used ----------

/** Recently used batches as {terms, at}, newest first. The stamp is what orders them against files on disk. */
export async function loadKeywordHistory() {
  return (await loadHistory('keyword_history'))
    .map((e) => ({ terms: cleanTerms(e.value), at: e.at }))
    .filter((e) => e.terms.length);
}

/** Push a batch to the front of the recent list, deduped, so up-arrow walks distinct batches and not repeats. */
export async function rememberKeywordBatch(terms, { at } = {}) {
  const list = cleanTerms(terms);
  if (!list.length) return list;
  await remember('keyword_history', list, { key: batchKey, at });
  return list;
}

// ---------- everything, in one list ----------

/**
 * Every batch this project has to offer, ordered by `byRecency`: history carries the moment it was typed, a run
 * its finish time, an eval or a set its file's mtime. A batch that is also a named set carries that name however
 * it was found — picking the words of @hedges out of a run should still say that is what they are.
 */
export async function keywordBatches({ sets = [], history = [], evalDirs = [], runDirs = [] } = {}) {
  const named = new Map(sets.map((s) => [batchKey(s.terms), s]));
  const found = [];
  const add = (terms, entry) => {
    const list = cleanTerms(terms);
    if (list.length) found.push({ terms: list, key: batchKey(list), when: '', ...entry });
  };
  // A caller may pass history as bare term lists; those simply have no time of their own.
  for (const e of history) {
    const entry = Array.isArray(e) ? { terms: e, at: '' } : (e || {});
    add(entry.terms, { source: 'recent', origin: 'recently used', when: entry.at || '' });
  }
  for (const s of sets) add(s.terms, { source: 'set', origin: `@${s.name}`, description: s.description, when: await mtime(s.file) });
  for (const dir of evalDirs) {
    for (const { file, at } of await jsonFilesIn(dir)) {
      try { add((await readJson(file)).keywords, { source: 'eval', origin: shortPath(file), when: at }); } catch {}
    }
  }
  for (const dir of runDirs) {
    for (const { file } of await jsonFilesIn(dir, '.results.json')) {
      try {
        const run = await readJson(file);
        const when = run.finished_at || run.started_at || '';
        add(run.spec?.keywords, { source: 'run', origin: `run ${run.id}`, when });
        add(run.highlight, { source: 'run', origin: `run ${run.id}, highlighted`, when });
      } catch {}
    }
  }
  return byRecency(found).map((f) => {
    const set = named.get(f.key);
    return { ...f, set: set?.name || null, description: set?.description || f.description || '' };
  });
}
