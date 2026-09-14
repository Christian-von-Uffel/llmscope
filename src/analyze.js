// Turn raw results into the grid the card renders: models x variants, per-cell counts, per-model disparity.
import { variantCombos, comboKey, comboLabel, displayTemplate } from './spec.js';
import { oklchToHex } from './palette.js';

/** Tokens a response actually consumed: prompt (system + user) plus reply. `max_tokens` caps only the reply. */
export function totalTokens(r) {
  return r.total_tokens ?? (r.prompt_tokens || 0) + (r.tokens || 0);
}

/** What one reply says, error included: the text every check, count and image is run against. */
export const replyBody = (r) => (r.error ? `ERROR: ${r.error}` : r.text || '');

/**
 * The outcome one reply landed on, in the four words everything downstream is built from: the sheet's badge, the
 * CLI's verdict, the CSV column and the page's tag. The precedence is the whole content of the function — an
 * error that is also a refusal counts as the refusal — so it lives here rather than in each thing that shows it.
 */
export function outcomeOf(r) {
  if (r.error && !r.refused) return 'error';
  if (r.refused) return 'refused';
  if (r.matched) return 'matched';
  return 'answered';
}

/**
 * How many runs each number on a card pools, said in the things the reader can see. "Per cell" named a unit only
 * the person who drew the grid knows; the reader sees a row per model and a column per group, so the line counts
 * in those. Written once, because all three images have to agree about what their numbers are.
 */
export const runsLine = (a) => {
  const runs = a.spec.runs;
  const prompts = a.spec.prompts.length;
  const r = `${runs} run${runs > 1 ? 's' : ''}`;
  // Each column is the same prompt worded another way, so "per prompt per model" names exactly what one cell
  // pools. With several prompts a cell pools all of them, and the multiplication is shown rather than hidden
  // behind a single number the reader would have to work back to.
  return prompts > 1 ? `${prompts} prompts × ${r} per model` : `${r} per prompt per model`;
};

/** The line that counts off prompts a card had no room to quote, wherever it appears. */
export const morePrompts = (n, slots) => `+ ${n} more prompt${n > 1 ? 's' : ''} sharing ${slots}`;

/** Wall clock the run took, in seconds. Older runs saved no duration: fall back to the timestamps. */
function runDuration(run) {
  if (typeof run.duration_s === 'number') return run.duration_s;
  if (typeof run.duration_ms === 'number') return run.duration_ms / 1000; // runs saved while the field was in ms
  const a = Date.parse(run.started_at || ''), b = Date.parse(run.finished_at || '');
  return Number.isFinite(a) && Number.isFinite(b) ? (b - a) / 1000 : null;
}

export const COLORS = {
  green: '#178a3a',
  red: '#c11f1f',
  maroon: '#6e1414',
  amber: '#d97a12',
  gray: '#3b4048',
  bg: '#0f1113',
  panel: '#171a1e',
  text: '#f3f4f6',
  muted: '#9aa0a6',
  accent: '#ffd166',
  // The green and red for words set in colour on a dark panel, which is what the word cloud does. They are not
  // the fills above: those carry white labels and, read as text on the panel, sit at 3.9:1 and 2.9:1 — and to a
  // deuteranope they are one colour. These are chosen in OKLCH. Both clear 4.5:1 on the panel in every kind of
  // colour vision (the red just, at 4.6:1 under protanopia: an AA red on this panel can be no darker), and the
  // green sits a lightness step above the red, so where red and green stop being two hues — deuteranopia, a
  // black-and-white print — they are still two weights of word. test/a11y.test.js holds the numbers.
  greenInk: oklchToHex(0.82, 0.16, 155),
  redInk: oklchToHex(0.70, 0.19, 25),
};

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

export function defaultThreshold(primary) {
  return primary === 'sentiment' ? 0.3 : 0.25;
}

function sentimentColor(comparative) {
  // diverging: negative -> red, positive -> green, faded near zero
  const mag = Math.min(1, Math.abs(comparative) / 0.6);
  const alpha = 0.35 + 0.65 * mag;
  return comparative < 0 ? `rgba(193,31,31,${alpha.toFixed(2)})` : `rgba(23,138,58,${alpha.toFixed(2)})`;
}

const stripRegex = (k) => k.replace(/^\/(.*)\/[a-z]*$/, '$1');

/** Human phrase for the keyword set: “x” · “a” or “b” · “a”, “b” and “c” · any of 6 keywords */
export function keywordPhrase(spec) {
  const kws = spec.keywords || [];
  const q = (k) => `“${stripRegex(k)}”`;
  if (!kws.length) return 'keyword';
  if (kws.length === 1) return q(kws[0]);
  const all = spec.keyword_mode === 'all';
  if (kws.length <= 3) {
    const phrase = kws.slice(0, -1).map(q).join(', ') + (all ? ' and ' : ' or ') + q(kws[kws.length - 1]);
    if (phrase.length <= 48) return phrase;
  }
  return `${all ? 'all' : 'any'} of ${kws.length} keywords`;
}

/**
 * A keyword eval that has not named its words yet. Running one is how you find out what to look for: collect the
 * replies, read them, then mark the words that turned up. Until that happens the grid is honest but empty, so
 * every line that would otherwise state a finding says there is no finding to state.
 */
export const noKeywordsYet = (spec) => spec.primary === 'keyword' && !(spec.keywords || []).length;

export const METRIC_LABEL = { refusal: 'REFUSAL RATE', keyword: 'KEYWORD INCLUSION', sentiment: 'SENTIMENT' };
/**
 * What the grid counted, for the card whose heading is the prompt. The heading asks the question; this says what
 * was looked for in the answers, so the reader meets the measure before the first number rather than after it.
 */
export function countedLine(spec) {
  if (noKeywordsYet(spec)) return 'responses collected · no keywords set yet';
  if (spec.primary === 'keyword') return `responses including ${keywordPhrase(spec)}`;
  if (spec.primary === 'sentiment') return 'sentiment of each response';
  return 'responses that refused the prompt';
}

/** What the card is, in the brand line: a reader who sees only the image should know what was measured. */
const CARD_KIND = { refusal: 'refusal rate', keyword: 'keyword matching', sentiment: 'sentiment' };
/** The top-left line every shareable image carries. One definition, so a run's images never disagree about what they are. */
export const brandLine = (a) => `llmscope · ${CARD_KIND[a.spec.primary] || a.spec.primary}`;

/**
 * A gray cell is a reply that never arrived in usable form, and the two ways that happens are worth separating in
 * the reader's mind: the request failed at the provider, or the answer ran into the reply cap this eval set. Bare
 * "error" invites the reader to blame the tool for both. The responses sheet has said this since it was written,
 * and the card now says it the same way.
 */
const ERROR_LABEL = 'error or cut off';

// Card wording is deliberately not customizable: every llmscope image reads the same way.
export function legendFor(spec) {
  const kw = keywordPhrase(spec);
  if (spec.primary === 'keyword') {
    // The match reads first. Red is what the card is about, and a legend that opens with the absence of the
    // finding makes the reader hold a negative in their head before they are told what the positive is.
    return [
      { key: 'matched', label: noKeywordsYet(spec) ? 'matched a keyword' : `matched ${kw}`, color: COLORS.red },
      { key: 'clean', label: noKeywordsYet(spec) ? 'nothing to match yet' : 'no keywords matched', color: COLORS.green },
      { key: 'refused', label: 'refused', color: COLORS.maroon },
      { key: 'error', label: ERROR_LABEL, color: COLORS.gray },
    ];
  }
  if (spec.primary === 'sentiment') {
    return [
      { key: 'positive', label: 'positive sentiment', color: COLORS.green },
      { key: 'negative', label: 'negative sentiment', color: COLORS.red },
      { key: 'refused', label: 'refused', color: COLORS.maroon },
      { key: 'error', label: ERROR_LABEL, color: COLORS.gray },
    ];
  }
  // Refusal reads first, for the same reason the keyword legend opens with the match: red is what the card is
  // about, and a legend that opens with the absence of the finding makes the reader hold a negative in their head
  // before they are told what the positive is. The cells still fill answered-then-refused, which is a quantity
  // growing from nothing, not a ranking.
  return [
    { key: 'refused', label: 'refused', color: COLORS.red },
    { key: 'answered', label: 'answered', color: COLORS.green },
    { key: 'error', label: ERROR_LABEL, color: COLORS.gray },
  ];
}

export function analyze(run) {
  const { spec, results } = run;
  const combos = variantCombos(spec.variables);
  let variants = combos.map((combo, i) => ({ index: i, key: comboKey(combo), label: comboLabel(combo), combo }));
  const threshold = spec.disparity_threshold ?? defaultThreshold(spec.primary);
  const legend = legendFor(spec);
  const legendColor = Object.fromEntries(legend.map((l) => [l.key, l.color]));

  const rows = spec.models.map((model) => {
    const cells = variants.map((variant) => {
      const rs = results.filter((r) => r.model === model && r.variantKey === variant.key);
      const n = rs.length;
      const errors = rs.filter((r) => r.error && !r.refused).length;
      const refused = rs.filter((r) => r.refused).length;
      const answeredRs = rs.filter((r) => !r.refused && !r.error);
      const matched = answeredRs.filter((r) => r.matched).length;
      const clean = answeredRs.length - matched;
      const tokens = rs.map((r) => r.tokens || 0);
      const promptTokens = rs.map((r) => r.prompt_tokens || 0);
      const sentiments = answeredRs.map((r) => r.sentiment ?? 0);
      const sentiment_mean = mean(sentiments);
      const hitCounts = {};
      for (const r of answeredRs) for (const h of r.keyword_hits || []) hitCounts[h] = (hitCounts[h] || 0) + 1;
      const top_hits = Object.entries(hitCounts)
        .map(([kw, count]) => ({ kw: stripRegex(kw), count }))
        .sort((x, y) => y.count - x.count || x.kw.localeCompare(y.kw));
      let primary_value;
      let segments;
      let big;
      if (spec.primary === 'keyword') {
        primary_value = n ? matched / n : 0;
        segments = [
          { key: 'clean', count: clean, color: legendColor.clean },
          { key: 'matched', count: matched, color: legendColor.matched },
          { key: 'refused', count: refused, color: legendColor.refused },
          { key: 'error', count: errors, color: legendColor.error },
        ];
        big = n === 1 ? (errors ? 'error' : refused ? 'refused' : matched ? 'included' : 'not included') : `${matched}/${n} included`;
      } else if (spec.primary === 'sentiment') {
        primary_value = sentiment_mean;
        segments = [
          { key: 'answered', count: answeredRs.length, color: sentimentColor(sentiment_mean) },
          { key: 'refused', count: refused, color: legendColor.refused },
          { key: 'error', count: errors, color: legendColor.error },
        ];
        const s = (sentiment_mean >= 0 ? '+' : '') + sentiment_mean.toFixed(2);
        big = n === 1 ? (errors ? 'error' : refused ? 'refused' : `sentiment ${s}`) : `sentiment ${s}`;
      } else {
        primary_value = n ? refused / n : 0;
        segments = [
          { key: 'answered', count: answeredRs.length, color: legendColor.answered },
          { key: 'refused', count: refused, color: legendColor.refused },
          { key: 'error', count: errors, color: legendColor.error },
        ];
        big = n === 1 ? (errors ? 'error' : refused ? 'REFUSED' : 'answered') : `${refused}/${n} refused`;
      }
      return {
        model, variant: variant.key, variantLabel: variant.label, n, refused, matched, clean, errors,
        answered: answeredRs.length, tokens_mean: mean(tokens), tokens_total: tokens.reduce((a, b) => a + b, 0),
        prompt_tokens_total: promptTokens.reduce((a, b) => a + b, 0), total_tokens: rs.reduce((s, r) => s + totalTokens(r), 0),
        sentiment_mean, primary_value, segments: segments.filter((s) => s.count > 0), big, top_hits,
      };
    });
    const values = cells.filter((c) => c.n).map((c) => c.primary_value);
    const disparity = values.length > 1 ? Math.max(...values) - Math.min(...values) : 0;
    const flagged = variants.length > 1 && disparity >= threshold - 1e-9;
    const refusedAny = cells.some((c) => c.refused > 0);
    const matchedAny = cells.some((c) => c.matched > 0);
    return { model, cells, disparity, flagged, refusedAny, matchedAny, tokens_mean: mean(cells.map((c) => c.tokens_mean)) };
  });

  const maxTokens = Math.max(1, ...rows.flatMap((r) => r.cells.map((c) => c.tokens_mean)));
  const modelsTotal = rows.length;
  const flaggedCount = rows.filter((r) => r.flagged).length;
  // Rows are ordered by effect size: biggest gap between groups first; single-column cards by the metric itself.
  const primaryMean = (row) => { const v = row.cells.filter((c) => c.n).map((c) => c.primary_value); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; };
  const sign = spec.primary === 'sentiment' ? 1 : -1; // negative sentiment ranks first; higher rates rank first

  // What each column came to, pooling every model: the outcome over the replies that produced it. Counted once
  // and used twice — to order the columns, and to order the values inside the prompt heading — so the two can
  // never disagree about which wording the outcome landed on hardest.
  const totals = variants.map((v, i) => {
    const cs = rows.map((r) => r.cells[i]).filter((c) => c.n);
    return {
      n: cs.reduce((s, c) => s + c.n, 0),
      hit: spec.primary === 'sentiment'
        ? cs.reduce((s, c) => s + c.sentiment_mean * c.n, 0)
        : cs.reduce((s, c) => s + (spec.primary === 'keyword' ? c.matched : c.refused), 0),
    };
  });
  // Pooled over any set of columns: replies are the weight, so a wording that ran more often counts for more.
  const rateOf = (ts) => { const n = ts.reduce((s, t) => s + t.n, 0); return n ? ts.reduce((s, t) => s + t.hit, 0) / n : 0; };

  // Columns are ordered the way rows are: the wording the outcome landed on hardest reads first, so the largest
  // cell of the largest row sits in the corner the eye starts from and reading left to right is reading a
  // ranking. Ties keep the order the eval declared, so the same run always draws the same card.
  const order = variants.map((v, i) => i).sort((x, y) => sign * (rateOf([totals[x]]) - rateOf([totals[y]])) || x - y);
  if (order.some((i, k) => i !== k)) {
    variants = order.map((i, k) => ({ ...variants[i], index: k }));
    for (const row of rows) row.cells = order.map((i) => row.cells[i]);
  }

  // And the slot in the heading reads in that same order. A reader who meets “{heavy metals | vaccination}” in the
  // question and then finds those columns the other way round under it has to do the matching by hand; ordering
  // both by one measure means the first value named in the prompt heads the first column of the grid. Each value
  // is scored across every column it appears in, so this still holds when two slots multiply out into the columns.
  // Only the heading is reordered — `spec.variables` is untouched, so the eval's id and its columns are unchanged.
  const displayVars = {};
  for (const [name, values] of Object.entries(spec.variables || {})) {
    const scoreOf = (val) => rateOf(variants.map((v, i) => (v.combo[name] === val ? totals[order[i]] : null)).filter(Boolean));
    displayVars[name] = [...values].sort((x, y) => sign * (scoreOf(x) - scoreOf(y)) || values.indexOf(x) - values.indexOf(y));
  }
  rows.sort((a, b) => (variants.length > 1 && b.disparity !== a.disparity ? b.disparity - a.disparity : 0)
    || sign * (primaryMean(a) - primaryMean(b))
    || a.model.localeCompare(b.model));

  let headline;
  const tested = `OF ${modelsTotal} MODELS TESTED`;
  if (noKeywordsYet(spec)) {
    // No words were scored, so no wording can have been flagged: say what the run did do, which is answer.
    headline = `${modelsTotal} MODELS ANSWERED · NO KEYWORDS SET YET`;
  } else if (variants.length > 1) {
    headline = `${flaggedCount} ${tested} DIFFER BY WORDING`;
  } else if (spec.primary === 'keyword') {
    headline = `${rows.filter((r) => r.matchedAny).length} ${tested} INCLUDED ${keywordPhrase(spec).toUpperCase()}`;
  } else if (spec.primary === 'sentiment') {
    headline = `${rows.filter((r) => r.cells[0]?.sentiment_mean < 0).length} ${tested} NEGATIVE`;
  } else {
    headline = `${rows.filter((r) => r.refusedAny).length} ${tested} REFUSED`;
  }
  const totalRefused = results.filter((r) => r.refused).length;
  const tokenTotals = {
    reply: results.reduce((s, r) => s + (r.tokens || 0), 0),
    prompt: results.reduce((s, r) => s + (r.prompt_tokens || 0), 0),
    total: results.reduce((s, r) => s + totalTokens(r), 0),
    over_cap: results.filter((r) => (r.tokens || 0) > (r.max_tokens_sent ?? spec.max_tokens)).length, // billed beyond the cap that was sent: thinking charged on top (xAI)
  };
  // Every prompt as it reads on a card, slots spelled out. A card that quotes all of them uses the list; one that
  // has room for a heading only quotes the first and counts the rest off with `more`.
  const promptTitles = spec.prompts.map((p) => displayTemplate(p, displayVars));
  const slots = Object.keys(spec.variables).map((v) => `{${v}}`).join(', ') || 'the same models';
  return {
    id: run.id,
    provider: run.provider,
    mock: run.provider === 'mock',
    spec,
    variants,
    rows,
    threshold,
    legend,
    maxTokens,
    summary: {
      models_total: modelsTotal,
      models_flagged: flaggedCount,
      headline,
      total_runs: results.length,
      total_refused: totalRefused,
      runs_per_cell: spec.runs * spec.prompts.length,
      tokens: tokenTotals,
      cost: run.cost ?? null,
      duration_s: runDuration(run),
    },
    title: {
      kicker: [METRIC_LABEL[spec.primary] || spec.primary.toUpperCase(), headline, run.provider === 'mock' ? 'MOCK DATA' : null].filter(Boolean).join(' · '),
      prompt: promptTitles[0] ?? '',
      prompts: promptTitles,
      slots,
      more: spec.prompts.length > 1 ? morePrompts(spec.prompts.length - 1, slots) : null,
    },
  };
}
