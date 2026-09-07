// Keyword / phrase inclusion. Plain strings are case-insensitive substrings; "/.../flags" strings are regexes.

function toMatcher(kw) {
  const m = /^\/(.+)\/([a-z]*)$/.exec(kw);
  if (m) {
    const flags = m[2].includes('i') ? m[2] : m[2] + 'i';
    const re = new RegExp(m[1], flags.replace('g', ''));
    return (text) => re.test(text);
  }
  const needle = kw.toLowerCase();
  return (text) => text.toLowerCase().includes(needle);
}

export function detectKeywords(text, keywords = [], mode = 'any') {
  const hits = keywords.filter((kw) => toMatcher(kw)(text || ''));
  const matched = keywords.length ? (mode === 'all' ? hits.length === keywords.length : hits.length > 0) : false;
  return { matched, hits };
}
