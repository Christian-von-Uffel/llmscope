// The cube behind both the counts table and the keyword card: for every marked term, how many replies used it in
// every (model, group) cell. Pool the models and you have the table's columns; pool the terms and you have which
// group the words land on hardest. Keeping both is what the card draws, and computing it once is what keeps the
// table and the card from ever disagreeing.
import { analyze, defaultThreshold } from './analyze.js';
import { findKeywordSpans, stripPattern } from './checks/keywords.js';

/** What a term is matched against: an error is not the model's wording, but it is what came back. */
export const replyText = (r) => (r.error ? `ERROR: ${r.error}` : r.text || '');

const rate = (replies, n) => (n ? replies / n : 0);
const spread = (values) => (values.length > 1 ? Math.max(...values) - Math.min(...values) : null);

/**
 * Replies that used each term, across every model × group cell.
 *
 * Both axes are ordered by size rather than by declaration, so the biggest number on the card is the one in the
 * corner you read first. Groups run from the one that matched most to the one that matched least, counting any
 * of the terms — so `variants[0]` is the group the words land on hardest, and the last is the one they miss.
 * Rows are the terms, ordered by the gap they open between groups: a word every group uses equally is a fact
 * about the topic, not about the groups. Models keep the order `analyze` gave them, so a model sits in the same
 * column of every row and of every card built from the same run.
 *
 * @param {object} run a saved run
 * @param {string[]} terms the words to count — the run's own keywords, or whatever it was told to mark
 * @param {object[]} [results] a filtered subset; defaults to the whole run
 */
export function keywordGrid(run, terms, { results = run.results, familyOf = (m) => m } = {}) {
  const a = analyze(run);
  const present = new Set(results.map((r) => r.model));
  const models = a.rows.map((r) => r.model).filter((m) => present.has(m));
  const shownVariants = new Set(results.map((r) => r.variantLabel));
  const declared = a.variants.map((v) => v.label).filter((v) => shownVariants.has(v));
  const texts = new Map(); // model|variant -> the replies in that cell
  for (const r of results) {
    const key = `${r.model}|${r.variantLabel}`;
    if (!texts.has(key)) texts.set(key, []);
    texts.get(key).push(replyText(r));
  }
  const at = (model, variant) => texts.get(`${model}|${variant}`) || [];
  const anyOf = (list) => list.filter((t) => findKeywordSpans(t, terms).length).length;

  // Column order: the group the words matched in most often comes first, so the corner of the card carries the
  // largest cell of the largest row. Ties keep the order the eval declared, so a rerun draws the same card.
  const totals = new Map(declared.map((variant) => {
    const list = models.flatMap((m) => at(m, variant));
    return [variant, { variant, n: list.length, replies: anyOf(list), rate: rate(anyOf(list), list.length) }];
  }));
  const variants = [...declared].sort((x, y) => totals.get(y).rate - totals.get(x).rate || declared.indexOf(x) - declared.indexOf(y));
  const leading = variants[0] ?? null;
  const trailing = variants.length > 1 ? variants[variants.length - 1] : null;

  // Families, ordered by hit rate: the family whose replies used these words most often comes first, so reading
  // the block left to right is reading the ranking. A family is one column however many of its models ran.
  const families = new Map(models.map((m) => [m, familyOf(m)]));
  const familyModels = new Map();
  for (const m of models) {
    const f = families.get(m);
    if (!familyModels.has(f)) familyModels.set(f, []);
    familyModels.get(f).push(m);
  }
  const familyStats = [...familyModels].map(([family, kin]) => {
    const list = kin.flatMap((m) => variants.flatMap((v) => at(m, v)));
    const replies = anyOf(list);
    const per = (variant) => {
      const own = kin.flatMap((m) => at(m, variant));
      return rate(anyOf(own), own.length);
    };
    const lead = leading ? per(leading) : 0;
    const trail = trailing ? per(trailing) : 0;
    return { family, models: kin, n: list.length, replies, rate: rate(replies, list.length), lead, trail, gap: trailing ? lead - trail : null };
  });
  familyStats.sort((x, y) => y.rate - x.rate || y.replies - x.replies || x.family.localeCompare(y.family));
  const familyOrder = familyStats.map((f) => f.family);

  // `match` counts one list of replies; a term counts itself, and the pooled row counts any of them.
  const buildRow = (label, match) => {
    const cells = models.flatMap((model) => variants.map((variant) => {
      const list = at(model, variant);
      const replies = match(list);
      return { model, variant, n: list.length, replies, rate: rate(replies, list.length) };
    }));
    const cell = (model, variant) => cells.find((c) => c.model === model && c.variant === variant);
    const byVariant = variants.map((variant) => {
      const own = cells.filter((c) => c.variant === variant);
      const n = own.reduce((s, c) => s + c.n, 0);
      const replies = own.reduce((s, c) => s + c.replies, 0);
      return { variant, n, replies, rate: rate(replies, n) };
    });
    const rated = byVariant.filter((v) => v.n);
    const delta = spread(rated.map((v) => v.rate));
    const hi = delta ? Math.max(...rated.map((v) => v.rate)) : null;
    // Two groups can tie for the top, and naming one of them would be a coin toss dressed up as a finding.
    const tops = delta ? rated.filter((v) => v.rate >= hi - 1e-9).map((v) => v.variant) : [];
    const low = delta ? rated.reduce((worst, v) => (v.rate < worst.rate ? v : worst)).variant : null;
    // Per family: how much of this word came from it. This is the hit rate — the replies from that family that
    // used the word, over all its replies, every group pooled — which is the plain answer to "who is saying it".
    const byFamily = familyOrder.map((family) => {
      const own = cells.filter((c) => families.get(c.model) === family && c.n);
      const n = own.reduce((s, c) => s + c.n, 0);
      const replies = own.reduce((s, c) => s + c.replies, 0);
      const perVariant = variants.map((v) => {
        const inV = own.filter((c) => c.variant === v);
        return rate(inV.reduce((s, c) => s + c.replies, 0), inV.reduce((s, c) => s + c.n, 0));
      });
      const lead = leading ? perVariant[variants.indexOf(leading)] : 0;
      const trail = trailing ? perVariant[variants.indexOf(trailing)] : 0;
      return { family, n, replies, rate: rate(replies, n), lead, trail, gap: trailing ? lead - trail : null };
    });
    const best = Math.max(0, ...byFamily.map((f) => f.rate));
    // The families this word came from most, so the card can point at the cell rather than leave it to the eye.
    // A tie points at all of them: singling one out would be a coin toss dressed up as an answer.
    const sources = best > 0 ? byFamily.filter((f) => f.rate >= best - 1e-9).map((f) => f.family) : [];
    return { label, cells, byVariant, byFamily, sources, delta, top: tops[0] ?? null, tops, low, replies: cells.reduce((s, c) => s + c.replies, 0) };
  };

  const rows = terms.map((kw) => buildRow(stripPattern(kw), (list) => list.filter((t) => findKeywordSpans(t, [kw]).length).length));
  rows.sort((x, y) => (y.delta ?? -1) - (x.delta ?? -1) || y.replies - x.replies || x.label.localeCompare(y.label));
  // With more than one term, how often a reply used any of them: the rate a keyword eval scores on.
  const any = terms.length > 1 ? buildRow('any of them', anyOf) : null;
  const threshold = run.spec.disparity_threshold ?? defaultThreshold('keyword');
  return {
    models, variants, leading, trailing, rows, any, threshold,
    families: familyStats,
    totals: variants.map((v) => totals.get(v)),
    separating: rows.filter((r) => r.delta != null && r.delta >= threshold - 1e-9),
  };
}
