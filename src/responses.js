// The replies a view is about, and the formats they leave the tool in.
//
// Three surfaces read a run's replies — the terminal printout, the browser's response table and the responses
// image — and each one asks the same two questions: *which* replies, and *how much* of each. Both answers live
// here, once, so `refused` narrows a run the same way wherever it is asked for and the table shows the same
// sentences the sheet draws. A search box is a third way to pick replies — it reads every word of every reply,
// not the excerpt — and still leaves the verdict alone. `--highlight` never reaches this file: narrowing and
// excerpting are presentation, and a verdict stays the one the run produced.
//
// Reading a run inside llmscope is only ever the first half of the work, so the same selection leaves as data:
// JSON for a script (jq, pandas, a notebook) and CSV for a spreadsheet. Both carry every reply in full — an
// excerpt is a reading aid, and a truncated reply in an export would quietly poison whatever is counted from it.
import { totalTokens, outcomeOf } from './analyze.js';
import { excerpt, SELECTIONS } from './sheet.js';
import { findKeywordSpans, splitTerms, isValidKeyword } from './checks/keywords.js';

/**
 * A search box as keyword terms: the same comma /regex/ rules the highlight box uses, so a pattern that marks
 * a reply also finds it. Invalid pieces come back separately rather than throwing — this runs as the reader types.
 */
export function parseSearch(query) {
  const raw = splitTerms(query);
  return { terms: raw.filter(isValidKeyword), invalid: raw.filter((t) => !isValidKeyword(t)) };
}

/** Which replies a view shows. The same three words the responses image uses, so the vocabulary is one. */
export const RESPONSE_FILTERS = {
  all: SELECTIONS.all,
  refused: SELECTIONS.refused,
  matched: SELECTIONS.matched,
};

/**
 * The replies a printout, a table or an exported file is about, in the order they were sent, with the filters
 * spelled out. `matched` means the verdict the run recorded, the one the outcome badge shows — marking words
 * after the fact re-reads a run, it never re-scores one, so a run that matched nothing stays empty here however
 * many words you mark. `search` is the other way to narrow: it reads every reply in full (never the excerpt)
 * for the words or /regex/ you type, which is how a 96-reply run is scanned for a bias word without reading it.
 * @returns {{rs: object[], filters: string[]}}
 */
export function filterResponses(run, { select = 'all', model = null, variant = null, search = '' } = {}) {
  let rs = [...(run.results || [])].sort((x, y) => x.position - y.position);
  const filters = [];
  if (select === 'refused') { rs = rs.filter((r) => r.refused); filters.push('refused'); }
  else if (select === 'matched') { rs = rs.filter((r) => r.matched); filters.push('included keywords'); }
  if (model) { rs = rs.filter((r) => r.model.includes(model)); filters.push(`model ~ ${model}`); }
  if (variant) { rs = rs.filter((r) => r.variantLabel.toLowerCase() === String(variant).toLowerCase()); filters.push(`variant = ${variant}`); }
  const { terms } = parseSearch(search);
  if (terms.length) {
    rs = rs.filter((r) => findKeywordSpans(replyBody(r), terms).length);
    filters.push(terms.length === 1 ? `matching ${terms[0]}` : `matching ${terms.join(', ')}`);
  }
  return { rs, filters };
}

/** What a reply amounts to in an export: what the model said, or the error that came back in place of it. */
export const replyBody = (r) => (r.error ? `ERROR: ${r.error}` : r.text || '');

/**
 * What a view shows for one reply under `mode`: the same rule the responses image draws by, so the table and the
 * sheet quote the same sentences. An error is not the model's wording, so it is never cut into sentences. The
 * reply cap's ellipsis is added only where the excerpt still runs to the end — there "there was more" is true of
 * the reply rather than of the excerpt, which marks its own elisions already.
 */
export function shownText(r, mode = 'full', terms = []) {
  const cut = r.finish_reason === 'length';
  if (r.error && !r.refused && !cut) return `ERROR: ${r.error}`;
  const { text, tail } = excerpt(r.text || '', mode, terms);
  return cut && tail ? `${text}…` : text;
}

/**
 * A reply cut into the pieces a marker pen would leave: `{ text, mark }` in reading order, the marked pieces
 * being the runs `terms` matched. Data, not markup — the table wraps them in `<mark>`, the sheet draws them on
 * an amber block, and neither has to find the spans itself.
 */
export function markSpans(text, terms = []) {
  const src = String(text ?? '');
  const spans = findKeywordSpans(src, terms);
  if (!spans.length) return src ? [{ text: src, mark: false }] : [];
  const pieces = [];
  let last = 0;
  for (const s of spans) {
    if (s.start > last) pieces.push({ text: src.slice(last, s.start), mark: false });
    pieces.push({ text: src.slice(s.start, s.end), mark: true });
    last = s.end;
  }
  if (last < src.length) pieces.push({ text: src.slice(last), mark: false });
  return pieces;
}

const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const CSV_HEAD = ['position', 'model', 'variant', 'run', 'outcome', 'refusal_reason', 'keyword_hits', 'prompt_tokens', 'reply_tokens', 'reasoning_tokens', 'total_tokens', 'cost_usd', 'sentiment', 'prompt', 'response'];

/**
 * The replies as a spreadsheet: one row per reply, every verdict and every count in its own column, the reply
 * itself in the last one. `rs` narrows it to the replies a view was showing; without it, the whole run.
 */
export function toCsv(run, rs = null) {
  const rows = (rs || filterResponses(run).rs).map((r) => {
    const outcome = outcomeOf(r);
    return [
      r.position + 1, r.model, r.variantLabel, r.run + 1,
      outcome === 'matched' ? 'included' : outcome, // the column has always read "included"; the badge reads "matched"
      r.refusal_reason || '', (r.keyword_hits || []).join('; '), r.prompt_tokens || 0, r.tokens, r.reasoning_tokens ?? '', totalTokens(r), r.cost ?? '', r.sentiment, r.prompt,
      replyBody(r),
    ].map(csvCell).join(',');
  });
  return [CSV_HEAD.join(','), ...rows].join('\n') + '\n';
}

/**
 * The replies as JSON, in the shape llmscope saves and reads: the run's own envelope with `results` narrowed to
 * the replies shown, so what leaves the tool can come back into it. `showing` records how it was narrowed, since
 * a subset that does not say it is one is a run that quietly lost replies.
 * @returns {object} ready for JSON.stringify — the caller decides the indentation
 */
export function toJson(run, { rs = null, filters = [], select = 'all' } = {}) {
  const results = rs || filterResponses(run).rs;
  const head = { ...run };
  delete head.results; // re-added below, so `showing` reads before the replies rather than after a few thousand lines
  return { ...head, showing: { select, filters, replies: results.length, of: (run.results || []).length }, results };
}
