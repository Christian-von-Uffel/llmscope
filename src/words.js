// The words a run's replies were scored on, counted per wording: what the word cloud draws.
//
// The sentiment check scores a reply against a word list and says which words counted. Pool those over every
// reply a wording produced and you have the wording's vocabulary as the list sees it — how many replies used
// each word, and which way it scored. Neutral words never appear, because the list never scored them: the
// "cloud" is what is left of a reply once everything unscored is taken out, which is the point of it. Words the
// prompt itself contains are taken out too: a model told to "write two sentences" scores "sentences" every
// time, and a model asked whether something is dangerous says "dangerous" back, and neither is its tone.
//
// A run can be counted against either list llmscope carries, whichever it was scored with, because the reply
// text is saved: the word cloud of an old run, or of a run scored by a plugged-in service, is drawn from the
// replies themselves.
import { analyze } from './analyze.js';
import { lexiconSentiment, lexiconTokens, LEXICONS, DEFAULT_LEXICON } from './checks/sentiment.js';

/** A cloud shows this many words at most, the ones the most replies used. Past it the panel is a list, not a picture. */
export const MAX_WORDS = 36;

/**
 * The list a run's clouds are counted against: the one asked for, else the one its replies were scored with
 * when that is a list llmscope carries, else AFINN-165 — a run scored by a service or a module has no word list
 * of its own to draw. A name that is not a list is an error naming the ones there are.
 */
export function lexiconFor(run, lexicon = null) {
  if (lexicon && !LEXICONS[lexicon]) throw new Error(`no such lexicon: ${lexicon} (one of ${Object.keys(LEXICONS).join(', ')})`);
  return lexicon || (LEXICONS[run?.spec?.sentiment_analyzer] ? run.spec.sentiment_analyzer : DEFAULT_LEXICON);
}

/**
 * Words the prompt put in the model's mouth: the templates with their slots taken out, every slot value, and the
 * system prompt. A slot's name is not one of them — the model never saw "{place}", only what filled it.
 */
export function echoedWords(spec = {}) {
  const sources = [...(spec.prompts || []).map((p) => String(p).replace(/\{[^{}]*\}/g, ' ')), ...Object.values(spec.variables || {}).flat(), spec.system || ''];
  return new Set(sources.flatMap(lexiconTokens));
}

/**
 * One cloud per wording, in the order the card's columns read in.
 *
 * A word's `rate` is the share of the wording's answered replies that used it — the same word in a wording that
 * ran ten times and one that ran three is comparable that way, where a count is not — and `sign` is which way
 * it scored over those replies, after negation: +1, −1, or 0 when it went both ways as often. Refused replies
 * and errors are left out, as the card's sentiment mean leaves them out. Words are ordered by rate, then by how
 * many replies used them, then alphabetically, so the same run always counts to the same cloud.
 *
 * @param {object} run a saved run
 * @param {object} [opts.a] the run's analysis, when the caller has it already
 * @param {string|null} [opts.lexicon] 'afinn' or 'builtin'; see lexiconFor for the default
 * @param {object[]} [opts.results] a filtered subset; defaults to the whole run
 * @param {number} [opts.max] words per cloud
 * @returns {{lexicon: string, name: string, title: string, legend: object, clouds: object[]}} where each cloud is
 *   {variant, label, n, total, words: [{word, replies, rate, sign}]} — `n` the replies counted, `total` how many
 *   distinct words scored before the cap
 */
export function cloudWords(run, { a = null, lexicon = null, results = run.results, max = MAX_WORDS } = {}) {
  const key = lexiconFor(run, lexicon);
  const lex = LEXICONS[key];
  const echoed = echoedWords(run.spec);
  const clouds = (a || analyze(run)).variants.map((v) => {
    const rs = results.filter((r) => r.variantKey === v.key && !r.refused && !r.error && String(r.text || '').trim());
    const tally = new Map();
    for (const r of rs) {
      const { positive, negative } = lexiconSentiment(r.text, lex);
      const seen = new Map(); // this reply's net use of each word: +1 per positive showing, −1 per negative
      for (const w of positive) if (!echoed.has(w)) seen.set(w, (seen.get(w) || 0) + 1);
      for (const w of negative) if (!echoed.has(w)) seen.set(w, (seen.get(w) || 0) - 1);
      for (const [word, net] of seen) {
        const t = tally.get(word) || { word, replies: 0, net: 0 };
        t.replies += 1;
        t.net += Math.sign(net);
        tally.set(word, t);
      }
    }
    const words = [...tally.values()]
      .map((t) => ({ word: t.word, replies: t.replies, rate: rs.length ? t.replies / rs.length : 0, sign: Math.sign(t.net) }))
      .sort((x, y) => y.rate - x.rate || y.replies - x.replies || x.word.localeCompare(y.word));
    return { variant: v.key, label: v.label, n: rs.length, total: words.length, words: words.slice(0, max) };
  });
  return { lexicon: key, name: lex.name, title: lex.title, legend: lex.legend, clouds };
}
