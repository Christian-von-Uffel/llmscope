// Every sentence a marked word turned up in, gathered under the wording that produced it.
//
// The responses sheet reads down a reply: one model, start to finish, with its matches marked where they fall.
// This reads across the run — one group of the variable at a time, then every sentence any model built a marked
// word into while answering it. That is the question a keyword run leaves you holding: the counts say a word
// lands on one group more than another, and a rate cannot tell you whether "suspicious" described the street or
// the man. Set the groups beside each other and the difference is either in the sentences or it is not there.
//
// Batching by wording is the default because the variable is what the eval swapped and the models are what the
// reader is judging: under each group the models are named in the card's own order, so the model doing the most
// of it is read first and the same model can be followed across every group. `model` batches turn that around —
// one model straight through, every wording it was given — which is the single-model bias read. `keyword`
// batches by the word instead, for when the word rather than the group is the thing under examination.
//
// Nothing here scores anything. A sentence is selected by the same matcher the run scored with, so the page
// shows exactly the text behind the numbers, but which sentences are read changes no rate and no verdict.
import { findKeywordSpans } from './checks/keywords.js';

/**
 * A reply split into sentences. Every line is a break — a bulleted or numbered reply has no full stops to go on —
 * and within a line a sentence ends at .!?… followed by whitespace and something that starts a new one, so
 * "e.g. this" stays whole.
 */
export function sentences(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    for (const part of trimmed.split(/(?<=[.!?…]["'”’)\]]*)\s+(?=["'“‘(\[]?[A-Z0-9])/)) {
      const sentence = part.trim();
      if (sentence) out.push(sentence);
    }
  }
  return out;
}

/**
 * How the sentences are gathered. The eval swapped a variable, so by default the page does too: one group at a
 * time, every model that built a marked word into that wording together, which is the comparison the eval was
 * written to make and the one that shows which models treat the groups differently.
 */
export const SENTENCE_SORTS = {
  group: 'in a batch per wording, every model together',
  model: 'in a batch per model, every wording together',
  keyword: 'in a batch per marked word, every model and wording together',
};

/**
 * Every sentence a marked word turned up in, in reading order.
 *
 * A line carries the reply it came out of, so the page can attribute it; where in that reply it sat, so the page
 * can tell a sentence that follows on from one that skips a gap; and the words that put it there, so a batch can
 * say which of them it was. Ordering is the caller's: pass the responses in the order they should be read and the
 * lines come back in it.
 *
 * @param {object[]} responses replies in reading order (card order, from selectResponses)
 * @param {string[]} terms the marked words, as typed: plain words, phrases, or /regex/
 * @param {object} [opts]
 * @param {(r: object) => string} [opts.text] what to read each reply as — the page passes emoji-collapsed text
 * @returns {Array<{response: object, index: number, text: string, hits: number, terms: string[]}>}
 */
export function markedSentences(responses = [], terms = [], { text = (r) => r.text || '' } = {}) {
  const lines = [];
  if (!terms.length) return lines;
  for (const response of responses) {
    const src = String(text(response) || '');
    if (!src.trim()) continue;
    // The index is where the sentence sat in its reply. Two gathered sentences run on only when they ran on in
    // the reply they came from; anywhere else the page has skipped something and says so with an ellipsis.
    sentences(src).forEach((sentence, index) => {
      const spans = findKeywordSpans(sentence, terms);
      if (!spans.length) return;
      lines.push({ response, index, text: sentence, hits: spans.length, terms: [...new Set(spans.flatMap((s) => s.keywords))] });
    });
  }
  return lines;
}

/** What each batching mode keys a line on, and what it shows as the heading. */
const KEYED = {
  group: { key: (line) => line.response.variantKey, label: (line) => line.response.variantLabel },
  model: { key: (line) => line.response.model, label: (line) => line.response.model },
};

/**
 * The sentences gathered into batches: one per wording, per model, or per marked word.
 *
 * What a batch is counted in is `matches` — the marked words themselves, one per highlighted run of text, which
 * is what the eval was measuring and what a reader is being asked to compare. The sentences are how those
 * matches are shown, not what is being counted: a sentence is the context that says whether "suspicious"
 * described the street or the man. So both are carried, and the counting number is the matches.
 *
 * Batched by wording or by model a sentence belongs to exactly one batch, so `sentences` is the number of
 * distinct sentences on the page. Batched by keyword it is filed under every word that put it there — under
 * "suspicious" a reader wants every sentence with "suspicious" in it, not only the ones mentioning no other
 * marked word — so the count is placements on the page and can exceed the sentences behind it.
 *
 * Wording and model batches keep the order the responses arrived in, which is the card's: groups in the order
 * the card compares them, and inside each group the models ranked as the card ranks them, so the model doing
 * most of it is read first and this page, the card and the sheet all order the run the same way. Keyword
 * batches have no such order to inherit and run from the word with the most sentences to the word with the
 * fewest, ties keeping the order the terms were given in.
 *
 * Every group and every model that was asked keeps its batch even when it produced no sentence, because that is
 * the half of the comparison which says the difference is real; the page states it in words. A *term* that
 * turned up nowhere has no such comparison to hold up, so it is left off and named in `missing` instead.
 *
 * @param {object} [opts]
 * @param {string} [opts.by] group | model | keyword (see SENTENCE_SORTS)
 * @returns {{batches: Array<{key: string, label: string, lines: object[], matches: number, replies: number, models: string[], groups: string[], terms: string[]}>, missing: string[], matches: number, sentences: number, replies: number, lines: object[]}}
 */
export function sentenceBatches(responses = [], terms = [], { by = 'group', text } = {}) {
  const lines = markedSentences(responses, terms, text ? { text } : {});
  const mode = SENTENCE_SORTS[by] ? by : 'group';
  const batches = new Map();
  const open = (key, label) => {
    if (!batches.has(key)) batches.set(key, { key, label, lines: [], matches: 0, replies: new Set(), models: new Set(), groups: new Set(), terms: new Set() });
    return batches.get(key);
  };
  // A keyword batch counts only the matches of its own word; a wording or model batch counts every match on the
  // line, because every one of them is drawn there.
  const fileIn = (batch, line, matches) => {
    batch.lines.push(line);
    batch.matches += matches;
    batch.replies.add(line.response);
    batch.models.add(line.response.model);
    batch.groups.add(line.response.variantLabel);
    for (const t of line.terms) batch.terms.add(t);
  };
  if (mode === 'keyword') {
    for (const term of terms) open(term, term); // declared order, so a tie between two words is stable
    for (const line of lines) {
      for (const term of line.terms) {
        const batch = batches.get(term);
        if (batch) fileIn(batch, line, findKeywordSpans(line.text, [term]).length);
      }
    }
  } else {
    // Every group and every model that was asked gets a batch, whether or not it produced a sentence. A group
    // where none of the marked words turned up is the other half of the comparison — the half that says the
    // difference is real — so it is stated rather than left off and inferred from the gap.
    const { key, label } = KEYED[mode];
    for (const r of responses) open(key({ response: r }), label({ response: r }));
    for (const line of lines) fileIn(batches.get(key(line)), line, line.hits);
  }
  const order = new Map([...batches.keys()].map((k, i) => [k, i]));
  const drawn = mode === 'keyword' ? [...batches.values()].filter((b) => b.lines.length) : [...batches.values()];
  if (mode === 'keyword') drawn.sort((x, y) => y.lines.length - x.lines.length || y.replies.size - x.replies.size || order.get(x.key) - order.get(y.key));
  const found = new Set(lines.flatMap((l) => l.terms));
  return {
    batches: drawn.map((b) => ({ ...b, replies: b.replies.size, models: [...b.models], groups: [...b.groups], terms: mode === 'keyword' ? [b.key] : [...b.terms] })),
    missing: terms.filter((t) => !found.has(t)),
    matches: drawn.reduce((n, b) => n + b.matches, 0),
    sentences: drawn.reduce((n, b) => n + b.lines.length, 0),
    replies: new Set(lines.map((l) => l.response)).size,
    lines,
  };
}
