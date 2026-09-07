// Turn raw results into the grid the card renders: models x variants, per-cell counts, per-model disparity.
import { variantCombos, comboKey, comboLabel, displayTemplate } from './spec.js';

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

export function legendFor(spec) {
  const kw = keywordPhrase(spec);
  const labels = spec.labels || {};
  if (spec.primary === 'keyword') {
    return [
      { key: 'clean', label: labels.pass || `did not include ${kw}`, color: COLORS.green },
      { key: 'matched', label: labels.fail || `included ${kw}`, color: COLORS.red },
      { key: 'refused', label: 'refused', color: COLORS.maroon },
      { key: 'error', label: 'error', color: COLORS.gray },
    ];
  }
  if (spec.primary === 'sentiment') {
    return [
      { key: 'positive', label: labels.pass || 'positive sentiment', color: COLORS.green },
      { key: 'negative', label: labels.fail || 'negative sentiment', color: COLORS.red },
      { key: 'refused', label: 'refused', color: COLORS.maroon },
      { key: 'error', label: 'error', color: COLORS.gray },
    ];
  }
  return [
    { key: 'answered', label: labels.pass || 'answered', color: COLORS.green },
    { key: 'refused', label: labels.fail || 'refused', color: COLORS.red },
    { key: 'error', label: 'error', color: COLORS.gray },
  ];
}

export function analyze(run) {
  const { spec, results } = run;
  const combos = variantCombos(spec.variables);
  const variants = combos.map((combo, i) => ({ index: i, key: comboKey(combo), label: comboLabel(combo), combo }));
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
  let headline;
  if (variants.length > 1) {
    headline = `${flaggedCount} OF ${modelsTotal} MODELS DIFFER BY GROUP`;
  } else if (spec.primary === 'keyword') {
    const verb = spec.labels?.fail ? spec.labels.fail.toUpperCase() : `INCLUDED ${keywordPhrase(spec).toUpperCase()}`;
    headline = `${rows.filter((r) => r.matchedAny).length} OF ${modelsTotal} ${verb}`;
  } else if (spec.primary === 'sentiment') {
    headline = `${rows.filter((r) => r.cells[0]?.sentiment_mean < 0).length} OF ${modelsTotal} NEGATIVE`;
  } else {
    headline = `${rows.filter((r) => r.refusedAny).length} OF ${modelsTotal} REFUSED`;
  }
  const totalRefused = results.filter((r) => r.refused).length;
  const promptTitle = spec.prompts.length ? displayTemplate(spec.prompts[0], spec.variables) : '';
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
    },
    title: {
      kicker: [spec.title.toUpperCase(), headline, run.provider === 'mock' ? 'MOCK DATA' : null].filter(Boolean).join(' · '),
      prompt: promptTitle,
      more: spec.prompts.length > 1 ? `+ ${spec.prompts.length - 1} more prompt${spec.prompts.length > 2 ? 's' : ''} sharing ${Object.keys(spec.variables).map((v) => `{${v}}`).join(', ') || 'the same models'}` : null,
    },
  };
}
