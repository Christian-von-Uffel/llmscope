// Share card: one finding in words, one number per cell, nothing that dies at thumbnail size.
import { COLORS, keywordPhrase, METRIC_LABEL } from './analyze.js';
import { esc, textWidth, wrap, fit, shortModel, clamp, titleLine, fitTitleBlock, readableLines, TITLE, GROW_MAX } from './render.js';
import { logoFor } from './logos.js';

const SANS = "'DejaVu Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif";
const MONO = "'DejaVu Sans Mono', Menlo, Consolas, monospace";
const q = (s) => `“${s === '' ? 'none' : s}”`;

export function prettyName(id, names = {}) {
  if (names[id]) return names[id].replace(/^[^:]+:\s*/, '');
  return shortModel(id).split('-').map((w) => (/^(gpt|glm|grok|qwen|llama|deepseek)$/i.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))).join(' ');
}

/** The finding as a sentence. Conservative: a direction is only claimed when every flagged row points the same way. */
export function findingFor(a) {
  const { spec, rows, variants } = a;
  const n = rows.length;
  const p = spec.primary;
  const kwPhrase = spec.keywords.length <= 3 ? `used ${keywordPhrase(spec)}` : `used at least one of ${spec.keywords.length} keywords`;
  if (variants.length > 1) {
    const flagged = rows.filter((r) => r.flagged);
    const k = flagged.length;
    const verb = p === 'refusal' ? 'refuse' : p === 'keyword' ? kwPhrase.replace(/^used/, 'use') : 'reply negatively';
    if (!k) return { headline: `No model ${p === 'refusal' ? 'refuses' : p === 'keyword' ? verb.replace(/^use/, 'uses') : 'replies negatively'} at different rates by group`, direction: null };
    const worst = (row) => row.cells.filter((c) => c.n).reduce((best, c) => (p === 'sentiment' ? c.primary_value < best.primary_value : c.primary_value > best.primary_value) ? c : best);
    const tops = flagged.map((r) => worst(r).variantLabel);
    const same = tops.every((t) => t === tops[0]);
    if (same) {
      const g = tops[0];
      if (variants.length === 2) {
        const other = variants.find((v) => v.label !== g).label;
        return { headline: `${k} of ${n} models ${verb} more often for ${q(g)} than for ${q(other)}`, direction: g };
      }
      return { headline: `${k} of ${n} models ${verb} most often for ${q(g)}`, direction: g };
    }
    return { headline: `${k} of ${n} models ${verb} at different rates by group`, direction: null };
  }
  if (p === 'keyword') return { headline: `${rows.filter((r) => r.matchedAny).length} of ${n} models ${kwPhrase} in their reply`, direction: null };
  if (p === 'sentiment') return { headline: `${rows.filter((r) => r.cells[0]?.sentiment_mean < 0).length} of ${n} models replied negatively`, direction: null };
  return { headline: `${rows.filter((r) => r.refusedAny).length} of ${n} models refused this prompt`, direction: null };
}

function cellWords(cell, primary) {
  if (cell.n === 0) return '—';
  if (primary === 'sentiment') return (cell.sentiment_mean >= 0 ? '+' : '') + cell.sentiment_mean.toFixed(2);
  const count = primary === 'keyword' ? cell.matched : cell.refused;
  if (cell.n === 1) return cell.errors ? 'error' : cell.refused ? 'refused' : primary === 'keyword' ? (cell.matched ? 'included' : 'not included') : 'answered';
  return `${count}/${cell.n}`;
}

function monthStamp(iso) {
  const d = iso ? new Date(iso) : new Date();
  return d.toLocaleString('en-US', { month: 'short', year: 'numeric' }).toUpperCase();
}

/** Neutral line for prompt-title cards: what was run, not what was found. */
export function setupLine(a) {
  const s = a.spec;
  const groups = a.variants.length;
  return [
    METRIC_LABEL[s.primary] || s.primary.toUpperCase(),
    `${a.rows.length} MODELS`,
    groups > 1 ? `${groups} GROUPS` : null,
    s.prompts.length > 1 ? `${s.prompts.length} PROMPTS` : null,
    a.summary.runs_per_cell > 1 ? `${a.summary.runs_per_cell} RUNS EACH` : null,
  ].filter(Boolean).join(' · ');
}

/**
 * @param {object} opts
 * @param {'finding'|'prompt'} [opts.title] finding: generated sentence as headline, prompt quoted below.
 *   prompt: the prompt is the headline and no finding is stated, so viewers draw their own conclusion.
 */
export function renderShareCard(a, { width = 1600, height = 1600, names = {}, url = null, date = null, title = 'finding' } = {}) {
  const W = width; const H = height; const pad = 64;
  const shareUrl = url || `${a.spec.share_base || ''}${a.id}`;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`, `<rect width="${W}" height="${H}" fill="${COLORS.bg}"/>`];
  const text = (x, y, str, { size = 24, weight = 400, fill = COLORS.text, font = SANS, anchor = 'start', extra = '' } = {}) =>
    parts.push(`<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="${font}" font-size="${size}" font-weight="${weight}" fill="${fill}" ${extra}>${esc(str)}</text>`);

  // top strip: brand + date
  let y = pad + 22;
  text(pad, y, 'llmscope', { size: 26, weight: 700, fill: COLORS.muted, font: MONO, extra: 'letter-spacing="2"' });
  text(W - pad, y, `${monthStamp(date)}${a.mock ? ' · MOCK DATA' : ''}`, { size: 26, fill: a.mock ? COLORS.accent : COLORS.muted, font: MONO, anchor: 'end', extra: 'letter-spacing="2"' });

  const maxW = W - pad * 2;
  const quoted = `“${a.title.prompt}”`;
  // Grid geometry first: the results are the point of the card, so the title may only use the height the rows do not
  // need. Rows never go below TITLE.minRowH, however long the prompt is.
  const footerH = 120;
  const gap = 10;
  const rowsN = Math.max(1, a.rows.length);
  const colsN = Math.max(1, a.variants.length);
  const headerH = colsN > 1 || a.variants[0]?.label !== '—' ? 80 : 0;
  const gridBottom = H - footerH;
  if (title === 'prompt') {
    // neutral setup line, then the prompt itself as the headline (slots highlighted); no finding stated
    y += 46;
    text(pad, y, setupLine(a), { size: fit(setupLine(a), 26, maxW, false, 16, true), fill: COLORS.muted, font: MONO, extra: 'letter-spacing="3"' });
    // The prompt's measure decides how many lines it takes (8-12 words each); pretext then sizes it to fill them.
    // A prompt too long for its share of the card borrows the height the grid can spare, and no more.
    const gridMinH = headerH + rowsN * TITLE.minRowH + gap * (rowsN - 1);
    const availableH = Math.max(TITLE.floorSize * TITLE.lineHeight, Math.min(H * 0.42, gridBottom - (y + 24) - (a.title.more ? 34 : 0) - 44 - gridMinH));
    const measure = readableLines(quoted);
    let block = fitTitleBlock(quoted, maxW, { maxHeight: Math.min(H * 0.30, availableH), maxSize: 64 * GROW_MAX, minSize: TITLE.minSize, maxLines: measure });
    if (block.overflow) block = fitTitleBlock(quoted, maxW, { maxHeight: availableH, maxSize: TITLE.minSize, minSize: TITLE.floorSize, maxLines: measure });
    if (block.overflow) block = { size: TITLE.floorSize, lines: wrap(quoted, TITLE.floorSize, maxW, Math.max(1, Math.floor(availableH / (TITLE.floorSize * TITLE.lineHeight)))), overflow: true, truncated: true };
    const state = { inSlot: false };
    y += 24;
    for (const line of block.lines) { y += block.size * TITLE.lineHeight; parts.push(titleLine(line, pad, y, block.size, state)); }
    if (a.title.more) { y += 34; text(pad, y, a.title.more, { size: 24, fill: COLORS.muted }); }
    y += 44;
  } else {
    // headline: the finding
    const finding = findingFor(a);
    let hs = 76; let lines;
    for (;;) { lines = wrap(finding.headline, hs, maxW, Infinity); if (lines.length <= 3 || hs <= 44) break; hs -= 2; }
    y += 50;
    for (const line of lines) { y += hs * 1.08; text(pad, y, line, { size: hs, weight: 700 }); }
    // prompt, quoted, small
    const ps = 30;
    const plines = wrap(quoted, ps, maxW, 3, false);
    y += 26;
    for (const line of plines) { y += ps * 1.25; text(pad, y, line, { size: ps, fill: COLORS.muted }); }
    if (a.title.more) { y += 34; text(pad, y, a.title.more, { size: 24, fill: COLORS.muted }); }
    y += 44;
  }

  // grid: one number per cell
  const gridTop = y;
  const labelW = Math.round(W * 0.34);
  const rowH = (gridBottom - gridTop - headerH - gap * (rowsN - 1)) / rowsN;
  const cellW = (W - pad * 2 - labelW - gap * colsN) / colsN;
  const gridX = pad + labelW + gap;
  if (headerH) a.variants.forEach((v, i) => {
    const x = gridX + i * (cellW + gap) + cellW / 2;
    const size = fit(v.label, 44, cellW - 24, true, 18);
    text(x, gridTop + headerH / 2 + size / 3, v.label, { size, weight: 700, fill: COLORS.accent, anchor: 'middle' });
  });
  a.rows.forEach((row, ri) => {
    const ry = gridTop + headerH + ri * (rowH + gap);
    parts.push(`<rect x="${pad}" y="${ry}" width="${labelW}" height="${rowH}" rx="6" fill="${COLORS.panel}"/>`);
    if (row.flagged) parts.push(`<rect x="${pad}" y="${ry}" width="10" height="${rowH}" rx="3" fill="${COLORS.accent}"/>`);
    const name = prettyName(row.model, names);
    const logo = logoFor(row.model);
    const ls0 = clamp(28, rowH * 0.44, 52);
    const lx0 = pad + 30;
    if (logo) parts.push(`<image x="${lx0}" y="${(ry + rowH / 2 - ls0 / 2).toFixed(1)}" width="${ls0}" height="${ls0}" href="${logo}" opacity="0.92"/>`);
    else {
      parts.push(`<circle cx="${lx0 + ls0 / 2}" cy="${ry + rowH / 2}" r="${ls0 / 2}" fill="${COLORS.gray}"/>`);
      text(lx0 + ls0 / 2, ry + rowH / 2 + ls0 * 0.2, name[0].toUpperCase(), { size: ls0 * 0.6, weight: 700, anchor: 'middle' });
    }
    const nx = lx0 + ls0 + 20;
    const ns = fit(name, clamp(20, rowH * 0.36, 40), labelW - (nx - pad) - 20, true, 16);
    text(nx, ry + rowH / 2 + ns / 3, name, { size: ns, weight: 700 });
    row.cells.forEach((cell, ci) => {
      const cx = gridX + ci * (cellW + gap);
      parts.push(`<rect x="${cx}" y="${ry}" width="${cellW}" height="${rowH}" rx="6" fill="${COLORS.gray}" opacity="0.45"/>`);
      let sx = cx;
      for (const seg of cell.segments) {
        const w = (seg.count / cell.n) * cellW;
        parts.push(`<rect x="${sx.toFixed(1)}" y="${ry}" width="${w.toFixed(1)}" height="${rowH}" fill="${seg.color}"/>`);
        sx += w;
      }
      const label = cellWords(cell, a.spec.primary);
      const ls = fit(label, clamp(24, rowH * 0.5, 64), cellW - 32, true, 16);
      text(cx + cellW / 2, ry + rowH / 2 + ls / 3, label, { size: ls, weight: 700, fill: '#fff', anchor: 'middle' });
    });
  });

  // footer
  const fy = H - 52;
  let lx = pad;
  const legend = a.legend.filter((l) => l.key !== 'error' || a.rows.some((r) => r.cells.some((c) => c.errors)));
  const legendMax = W - pad * 2 - textWidth(shareUrl, 30, false, true) - 48;
  let ls2 = 26;
  const legendWidth = (sz) => legend.reduce((w, item) => w + sz + 12 + textWidth(item.label, sz) + 36, 0);
  while (legendWidth(ls2) > legendMax && ls2 > 16) ls2 -= 1;
  for (const item of legend) {
    parts.push(`<rect x="${lx}" y="${fy - ls2 + 4}" width="${ls2}" height="${ls2}" rx="5" fill="${item.color}"/>`);
    lx += ls2 + 12;
    text(lx, fy, item.label, { size: ls2 });
    lx += textWidth(item.label, ls2) + 36;
  }
  const meta = [`${a.summary.runs_per_cell} run${a.summary.runs_per_cell > 1 ? 's' : ''} per cell`, `temperature ${a.spec.temperature}`, 'each value sent as its own request', `id ${a.id}`].join(' · ');
  text(pad, fy + 38, meta, { size: 20, fill: COLORS.muted, font: MONO });
  text(W - pad, fy, shareUrl, { size: 30, font: MONO, anchor: 'end' });
  text(W - pad, fy + 38, 'rerun it yourself', { size: 20, fill: COLORS.muted, anchor: 'end' });
  parts.push('</svg>');
  return parts.join('\n');
}
