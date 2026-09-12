// Keyword / phrase inclusion. Plain strings are case-insensitive substrings; "/.../flags" strings are regexes.

/** One keyword as a regex source: a plain string matches literally, "/…/flags" as written. Always case-insensitive. */
function pattern(kw) {
  const m = /^\/(.+)\/([a-z]*)$/.exec(String(kw));
  const source = m ? m[1] : String(kw).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return { source, flags: (m ? m[2] : '').replace(/[gi]/g, '') + 'i' };
}

function toMatcher(kw) {
  const { source, flags } = pattern(kw);
  const re = new RegExp(source, flags);
  return (text) => re.test(text);
}

/** The same keyword as a global regex, for finding every place it matches rather than whether it does. */
function keywordRegex(kw) {
  const { source, flags } = pattern(kw);
  return new RegExp(source, flags + 'g');
}

/**
 * A comma-separated list of keywords, where a "/regex/" may contain commas of its own: `/a{1,2}/,plain` is two
 * terms, not three. Splitting is suspended between a term's opening slash and the slash that closes it, so a
 * quantifier or an alternation survives being typed into a flag or a text box.
 */
export function splitTerms(v) {
  if (v == null || v === true) return [];
  const src = String(v);
  const out = [];
  let cur = '';
  let inRegex = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inRegex) {
      cur += c;
      if (c === '\\' && i + 1 < src.length) cur += src[++i]; // an escaped slash does not close the pattern
      else if (c === '/') inRegex = false;
      continue;
    }
    if (c === ',') { out.push(cur); cur = ''; continue; }
    cur += c;
    if (c === '/' && cur.trim() === '/') inRegex = true; // a term that opens with a slash is a pattern
  }
  out.push(cur);
  return out.map((t) => t.trim()).filter(Boolean);
}

/** True if `kw` compiles: what `--highlight` checks before a typo reaches the renderer. */
export function isValidKeyword(kw) {
  try { keywordRegex(kw); return true; } catch { return false; }
}

/**
 * Add `extra` onto `terms` without duplicates. Case does not count — "Bias" and "bias" are one word — and the
 * original list keeps its order, so a word found while searching appends rather than reshuffling what was marked.
 */
/** A keyword as it reads to a person: /regex/ loses its slashes, a plain word is already itself. */
export const stripPattern = (kw) => String(kw).replace(/^\/(.*)\/[a-z]*$/, '$1');

/** A keyword list with the blanks dropped and anything that will not compile left out. */
export function cleanTerms(value) {
  const list = Array.isArray(value) ? value.map((s) => String(s).trim()) : splitTerms(value);
  return list.filter(Boolean).filter(isValidKeyword);
}

/** Identity of a batch, so the same words found in two places are one entry. Order and case do not count. */
export function batchKey(terms) {
  return cleanTerms(terms).map((t) => t.toLowerCase()).sort().join(' ');
}

export function mergeTerms(terms = [], extra = []) {
  const out = [...terms].map((t) => String(t || '').trim()).filter(Boolean).filter(isValidKeyword);
  const seen = new Set(out.map((t) => t.toLowerCase()));
  for (const raw of extra) {
    const t = String(raw || '').trim();
    if (!t || !isValidKeyword(t) || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out;
}

/**
 * Every place `keywords` match `text`, as non-overlapping [start, end) spans in reading order.
 * Matches that overlap or touch — a word inside a phrase, two keywords sharing a word — merge into one span,
 * so a marked run of text is marked once and each span names the keywords that put it there.
 * A keyword that is not a valid regex matches nothing rather than throwing: this runs over saved results.
 */
export function findKeywordSpans(text, keywords = []) {
  const src = String(text || '');
  if (!src || !keywords.length) return [];
  const found = [];
  for (const kw of keywords) {
    let re;
    try { re = keywordRegex(kw); } catch { continue; }
    for (const m of src.matchAll(re)) if (m[0]) found.push({ start: m.index, end: m.index + m[0].length, kw });
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const spans = [];
  for (const f of found) {
    const last = spans[spans.length - 1];
    if (last && f.start <= last.end) {
      if (f.end > last.end) last.end = f.end;
      if (!last.keywords.includes(f.kw)) last.keywords.push(f.kw);
    } else spans.push({ start: f.start, end: f.end, keywords: [f.kw] });
  }
  return spans;
}

/** How many times each keyword matches, and how many texts it matched in: the count behind a highlight. */
export function countKeywords(texts, keywords = []) {
  return keywords.map((kw) => {
    let hits = 0;
    let replies = 0;
    for (const t of texts) {
      const n = findKeywordSpans(t, [kw]).length;
      hits += n;
      if (n) replies += 1;
    }
    return { keyword: kw, hits, replies };
  });
}

export function detectKeywords(text, keywords = [], mode = 'any') {
  const hits = keywords.filter((kw) => toMatcher(kw)(text || ''));
  const matched = keywords.length ? (mode === 'all' ? hits.length === keywords.length : hits.length > 0) : false;
  return { matched, hits };
}
