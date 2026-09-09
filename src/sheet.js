// Responses sheet: every reply on ONE square image, measured with pretext so the text is sized exactly.
// Columns are a fixed quarter of the image (1024px at 4K) so a zoomed reader never scrolls across the page; the
// text size then clamps, up or down, to the largest size at which everything fits, the columns are balanced and
// the leading is opened just enough for the text to reach the bottom of the page. The prompt takes the fewest lines
// that keep it at 8-12 words a line and is sized, measured by pretext, to fill them; the legend's model names and
// outcome row grow to fill the width beside the URL, and the URL is one column wide.
// Model names live in the legend at the bottom (each model has its own text color), group names are amber
// inline, and every reply starts with a rounded square in its outcome color as tall as the text line; a reply
// the max reply length cut off shows everything it managed to say and ends in an ellipsis. Nothing is
// paginated or trimmed.
import { prepareRichInline, walkRichInlineLineRanges, materializeRichInlineLineRange } from '@chenglou/pretext/rich-inline';
import { COLORS, analyze } from './analyze.js';
import { esc, wrap, fitTitleBlock, readableLines, GROW_MAX } from './render.js';
import { modelColors } from './palette.js';
import { font, measureWidth, textReady, FONT_SANS, FONT_MONO, FONT_METRICS } from './text.js';

const SANS = `'${FONT_SANS}', 'Helvetica Neue', Helvetica, Arial, sans-serif`;
const MONO = `'${FONT_MONO}', Menlo, Consolas, monospace`;

// The outcome square before each reply, and each legend swatch, spans the text line's box: ascent to descent at the
// text size, so it is exactly as tall as the line it starts. In the reply stream it is a placeholder (a no-break
// space plus reserved width) glued to the reply's first word, so the square and the word always wrap together.
const ICON_GAP = 0.3; // between the square and its text, in ems
const NBSP = '\u00A0';
export const iconSide = (size) => size * (FONT_METRICS.ascent + FONT_METRICS.descent);
export const iconAdvance = (size) => iconSide(size) + size * ICON_GAP;
function iconRect(x, baseline, size, color) {
  const side = iconSide(size);
  return `<rect x="${x.toFixed(1)}" y="${(baseline - size * FONT_METRICS.ascent).toFixed(1)}" width="${side.toFixed(1)}" height="${side.toFixed(1)}" rx="${(side * 0.15).toFixed(1)}" fill="${color}"/>`;
}

export const SELECTIONS = {
  all: 'every reply',
  'per-cell': 'one reply per model × group (the first run)',
  refused: 'only refusals',
  matched: 'only replies that included the keywords',
};

// PNG fonts have no emoji (they render as boxes), so runs of emoji become a marker.
const EMOJI_RUN = /(?:\p{Extended_Pictographic}|\uFE0F|\u200D|[\u{1F3FB}-\u{1F3FF}]|[\u{1F1E6}-\u{1F1FF}])+/gu;
export function collapseEmoji(text) {
  return text.replace(EMOJI_RUN, (m) => {
    const chars = [...m];
    const pictographs = chars.filter((c) => /\p{Extended_Pictographic}/u.test(c) && !/[\u{1F3FB}-\u{1F3FF}]/u.test(c)).length;
    const flags = Math.ceil(chars.filter((c) => /[\u{1F1E6}-\u{1F1FF}]/u.test(c)).length / 2);
    const n = pictographs + flags;
    return n ? ` [${n} emoji] ` : '';
  }).replace(/ {2,}/g, ' ');
}

function cmpRank(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** Pick and order responses in card order (models by effect size, then group, then run). */
export function selectResponses(run, select = 'all') {
  const analysis = analyze(run);
  const modelOrder = analysis.rows.map((r) => r.model);
  const variantOrder = analysis.variants.map((v) => v.key);
  const rank = (r) => [modelOrder.indexOf(r.model), variantOrder.indexOf(r.variantKey), r.promptIndex, r.run];
  let responses = [...run.results].sort((x, y) => cmpRank(rank(x), rank(y)));
  if (select === 'per-cell') {
    const seen = new Set();
    responses = responses.filter((r) => { const k = `${r.model}|${r.variantKey}`; if (seen.has(k)) return false; seen.add(k); return true; });
  } else if (select === 'refused') responses = responses.filter((r) => r.refused);
  else if (select === 'matched') responses = responses.filter((r) => r.matched);
  return { analysis, responses };
}

function outcomeColor(r) {
  if (r.error && !r.refused) return COLORS.gray;
  if (r.refused) return COLORS.red;
  if (r.matched) return COLORS.amber;
  return COLORS.green;
}

const shortModel = (id) => id.split('/').pop().split(':')[0];
const shortError = (e) => { const t = String(e).split(/;|—/)[0].trim(); return t.length <= 110 ? t : t.slice(0, 110).replace(/\s+\S*$/, '') + '…'; };

/** Fixed column width: a quarter of the image (1024px at 4K), so one column fits a zoomed phone screen. */
export function columnsFor(size, columnWidth = 1024) {
  return Math.max(1, Math.round(size / columnWidth));
}

/** Rough text capacity of one image at a given text size (for documentation; the layout itself measures). */
export function estimateCapacity({ size = 4096, font: f = 28, columns = null } = {}) {
  const pad = Math.round(size * 0.03);
  const cols = columns || columnsFor(size);
  const gap = Math.max(f * 1.5, size * 0.012);
  const colW = (size - pad * 2 - gap * (cols - 1)) / cols;
  const colH = size - pad * 2 - size * 0.1 - size * 0.08;
  const charsPerLine = Math.floor(colW / (0.5 * f));
  const linesPerCol = Math.floor(colH / (f * 1.32));
  const chars = Math.round(charsPerLine * linesPerCol * cols * 0.92);
  return { size, font: f, columns: cols, charsPerLine, linesPerCol, chars, tokens: Math.round(chars / 4), words: Math.round(chars / 5.5) };
}

// ---------- header and legend (sized by the image, not by the body text) ----------
function header(a, size) {
  const pad = Math.round(size * 0.03);
  const headFont = size / 150;
  const quoted = a.title.prompt ? `“${a.title.prompt}”` : '';
  const width = size - pad * 2;
  const maxHeight = size * 0.16;
  // The prompt's measure decides how many lines it takes (8-12 words each); pretext then sizes it to fill them.
  const block = fitTitleBlock(quoted, width, { maxHeight, maxSize: (size / 45) * GROW_MAX, minSize: size / 150, maxLines: readableLines(quoted) });
  const titleGap = headFont * 1.8 + block.size * 0.15; // clears the descenders of a title that may be much larger than headFont
  const height = Math.round(headFont + block.lines.length * block.size * 1.12 + titleGap);
  return { headFont, block, titleGap, headerH: height };
}

/** Width of one column when the image has four (the 4K layout): the URL in the legend is exactly this wide. */
export function quarterWidth(size) {
  const pad = Math.round(size * 0.03);
  return (size - pad * 2 - size * 0.012 * 3) / 4;
}

/** Largest value in [lo, hi] (to half a pixel) for which ok() holds, ok being monotone; lo if it never does. */
function largest(lo, hi, ok) {
  let best = lo;
  while (hi - lo > 0.25) {
    const mid = (lo + hi) / 2;
    if (ok(mid)) { best = mid; lo = mid; } else hi = mid;
  }
  return Math.floor(best * 2) / 2;
}

const OUTCOMES = [['answered', COLORS.green], ['refused', COLORS.red], ['included keywords', COLORS.amber], ['error or cut off', COLORS.gray]];
const NOTE = '■ = outcome · text color = model · group names amber · … = cut off at the reply limit';

/**
 * Legend, anchored to the bottom edge. Left: the model names in their colors, then the outcome row, each measured
 * and grown to the largest size that still fits beside the URL (the names in as many rows as the base size needs).
 * Right: the URL at one column's width, with the run's summary line above it.
 */
function legend(a, size, colors, shareUrl) {
  const pad = Math.round(size * 0.03);
  const lf = size / 150;
  const quarter = quarterWidth(size);
  const urlSize = Math.min(size / 40, Math.floor((quarter / measureWidth(shareUrl, font(100, { mono: true }))) * 100 * 2) / 2);
  const brandSize = lf * 0.8;
  const maxW = size - pad * 2 - quarter - lf * 3;
  const models = a.rows.map((r) => r.model);
  const wrapModels = (s) => {
    const rows = [[]];
    let x = 0;
    let fits = true;
    for (const model of models) {
      const label = shortModel(model);
      const w = iconAdvance(s) + measureWidth(label, font(s, { bold: true }));
      if (x + w > maxW && rows[rows.length - 1].length) { rows.push([]); x = 0; }
      if (x + w > maxW) fits = false;
      rows[rows.length - 1].push({ x, label, color: colors[model], w });
      x += w + s * 1.6;
    }
    return { rows, fits };
  };
  const base = wrapModels(lf);
  const s = largest(lf, size / 50, (v) => { const r = wrapModels(v); return r.fits && r.rows.length <= base.rows.length; });
  const rows = wrapModels(s).rows;
  // The outcome row is swatch + label per outcome, then the note, all at one size.
  const outcomeWidth = (o) => OUTCOMES.reduce((w, [label]) => w + iconAdvance(o) + measureWidth(label, font(o)) + o * 1.6, 0) + measureWidth(NOTE, font(o));
  const o = largest(lf, size / 50, (v) => outcomeWidth(v) <= maxW);
  const modelRowH = s * 1.5;
  const outcomeRowH = o * 1.5;
  const bottom = size - pad - lf * 0.6; // swatch bottom of the outcome row; the URL shares the row's baseline
  const urlBaseline = bottom - o * FONT_METRICS.descent;
  const brandBaseline = urlBaseline - urlSize * 0.95 - brandSize * 0.6;
  const leftTop = bottom - outcomeRowH - (rows.length - 1) * modelRowH - iconSide(s);
  const rightTop = brandBaseline - brandSize * 0.8;
  const height = size - pad - Math.min(leftTop, rightTop) + lf * 0.6;
  return { lf, s, o, rows, modelRowH, outcomeRowH, bottom, urlSize, urlBaseline, brandSize, brandBaseline, height };
}

function geometry(size, f, headerH, legendH, columns = columnsFor(size)) {
  const pad = Math.round(size * 0.03);
  const gap = Math.max(f * 1.5, size * 0.012);
  const colW = (size - pad * 2 - gap * (columns - 1)) / columns;
  const colTop = pad + headerH;
  const colH = size - pad - legendH - colTop;
  return { pad, columns, gap, colW, colTop, colH, lineH: f * 1.32, paraGap: f * 0.9 };
}

// ---------- the reply stream: one rich-inline paragraph per model ----------
/** What a reply says on the sheet: all of its text, with an ellipsis when the max reply length cut it off, or its error. */
function replyText(r, color) {
  const cut = r.finish_reason === 'length';
  if (r.error && !r.refused && !cut) return { text: `ERROR: ${shortError(r.error)}`, fill: COLORS.muted };
  const text = collapseEmoji((r.text || '').replace(/\s+/g, ' ').trim());
  if (cut) return { text: text + '…', fill: color };
  return { text: text || '(empty reply)', fill: color };
}

function paragraphs(responses, analysis, colors, f) {
  const labelled = analysis.variants.length > 1 || analysis.variants[0]?.label !== '—';
  const byModel = new Map();
  for (const r of responses) { if (!byModel.has(r.model)) byModel.set(r.model, []); byModel.get(r.model).push(r); }
  const out = [];
  const nbspWidth = measureWidth(NBSP, font(f));
  for (const [model, rs] of byModel) {
    const items = [];
    const fills = [];
    const icons = [];
    const push = (text, fill, { bold = false, icon = null, extraWidth = 0 } = {}) => { items.push({ text, font: font(f, { bold }), extraWidth }); fills.push(fill); icons.push(icon); };
    let lastCell = null;
    for (const r of rs) {
      const cell = r.variantKey;
      if (cell !== lastCell) {
        if (lastCell !== null) push('   ', colors[model]);
        if (labelled) push(r.variantLabel + ' ', COLORS.accent, { bold: true });
        lastCell = cell;
      } else push(' ', colors[model]); // a space before the square: the break opportunity that lets it wrap with its word
      const { text, fill } = replyText(r, colors[model]);
      const sp = text.indexOf(' ');
      const head = sp === -1 ? text : text.slice(0, sp);
      push(NBSP + head, fill, { icon: outcomeColor(r), extraWidth: iconAdvance(f) - nbspWidth });
      if (sp !== -1) push(text.slice(sp), fill);
    }
    out.push({ model, prepared: prepareRichInline(items), fills, icons });
  }
  return out;
}

/** Every line of every paragraph at text size f, in reading order: the measured (expensive) step. */
function linesAt(responses, analysis, colors, f, colW) {
  const lines = [];
  paragraphs(responses, analysis, colors, f).forEach((para, pi) => {
    let first = true;
    walkRichInlineLineRanges(para.prepared, colW, (range) => { lines.push({ pi, para, range, first }); first = false; });
  });
  return lines;
}

/** Flow lines into columns top to bottom, starting a new column once a line would pass `limit`; fits=false past the last column. */
function flow(lines, g, limit = g.colH) {
  const placed = [];
  let col = 0;
  let y = 0;
  for (const line of lines) {
    const gap = line.first && line.pi > 0 && y > 0 ? g.paraGap : 0;
    if (y + gap + g.lineH > limit) {
      col += 1;
      y = 0;
      if (col >= g.columns) return { fits: false, placed };
    } else y += gap;
    placed.push({ col, y, para: line.para, range: line.range });
    y += g.lineH;
  }
  return { fits: true, placed, colsUsed: col + 1, height: y };
}

/** Break the columns at the lowest height that still fits, so each carries about the same amount of text. */
function balance(lines, g) {
  let best = flow(lines, g);
  for (let lo = g.lineH, hi = g.colH; hi - lo > 0.5;) {
    const mid = (lo + hi) / 2;
    const r = flow(lines, g, mid);
    if (r.fits) { best = r; hi = mid; } else lo = mid;
  }
  return best;
}

/** Open the leading (line height and paragraph gap together, by at most `cap`) so the tallest column reaches the bottom of the page. */
function stretch(placed, g, cap = 1.15) {
  const bottoms = new Map();
  for (const p of placed) bottoms.set(p.col, p.y + g.lineH); // placed is in reading order, so the last line of each column wins
  const k = Math.min(cap, g.colH / Math.max(...bottoms.values()));
  if (!(k > 1)) return { placed, g };
  return { placed: placed.map((p) => ({ ...p, y: p.y * k })), g: { ...g, lineH: g.lineH * k, paraGap: g.paraGap * k } };
}

/** Share of the column height the shortest used column reaches (1 = every column runs to the bottom). */
function columnFill(placed, g) {
  const bottoms = new Map();
  for (const p of placed) bottoms.set(p.col, p.y + g.lineH);
  return bottoms.size ? Math.min(...bottoms.values()) / g.colH : 0;
}

/**
 * @returns {{svg:string, font:number, columns:number, replies:number, exact:boolean, fill:number}}
 */
export function renderResponseSheet(run, { size = 4096, maxFont = null, minFont = 6, columns = null, select = 'all', url = null } = {}) {
  const { analysis: a, responses } = selectResponses(run, select);
  const colors = modelColors(a.rows.map((r) => r.model));
  const shareUrl = url || `${a.spec.share_base || ''}${a.id}`;
  const head = header(a, size);
  const leg = legend(a, size, colors, shareUrl);
  const cols = columns || columnsFor(size);
  const colW = (size - Math.round(size * 0.03) * 2) / cols;
  const hi = Math.max(minFont, Math.floor(maxFont || colW / 11)); // never fewer than ~22 characters per line
  const attempt = (f) => { const g = geometry(size, f, head.headerH, leg.height, cols); const lines = linesAt(responses, a, colors, f, g.colW); return { f, g, lines, ...flow(lines, g) }; };
  let best = attempt(minFont); // overflow even at the floor: draw what fits
  if (best.fits) {
    // Fit is monotonic in text size, so binary-search the largest size that fits: whole pixels first, then tenths.
    for (let lo = minFont + 1, top = hi; lo <= top;) {
      const mid = Math.floor((lo + top) / 2);
      const r = attempt(mid);
      if (r.fits) { best = r; lo = mid + 1; } else top = mid - 1;
    }
    if (best.f < hi) {
      const whole = best.f;
      for (let lo = 1, top = 9; lo <= top;) {
        const mid = Math.floor((lo + top) / 2);
        const r = attempt(Math.round(whole * 10 + mid) / 10);
        if (r.fits) { best = r; lo = mid + 1; } else top = mid - 1;
      }
      // The page, not the size cap, limits the text, so the text fills the page: balanced columns, leading opened to the bottom.
      const { placed, g } = stretch(balance(best.lines, best.g).placed, best.g);
      best = { ...best, placed, g };
    }
  }
  const svg = renderSvg(best, { a, size, select, responses: responses.length, run, shareUrl, colors, head, leg });
  return { svg, font: best.f, columns: best.g.columns, replies: responses.length, exact: textReady(), fill: columnFill(best.placed, best.g) };
}

/** Compatibility wrapper: always one page. */
export function renderResponseSheets(run, opts = {}) {
  return [renderResponseSheet(run, opts).svg];
}

function titleLine(line, state) {
  const spans = [];
  let i = 0;
  while (i < line.length) {
    if (state.inSlot) { const c = line.indexOf('}', i); const e = c === -1 ? line.length : c + 1; spans.push(`<tspan fill="${COLORS.accent}">${esc(line.slice(i, e))}</tspan>`); if (c !== -1) state.inSlot = false; i = e; }
    else { const o = line.indexOf('{', i); const e = o === -1 ? line.length : o; if (e > i) spans.push(esc(line.slice(i, e))); if (o !== -1) state.inSlot = true; i = e; }
  }
  return spans.join('');
}

function renderSvg({ f, g, placed }, { a, size, select, responses, run, shareUrl, colors, head, leg }) {
  const p = [];
  p.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`);
  p.push(`<rect width="${size}" height="${size}" fill="${COLORS.bg}"/>`);
  const { headFont, block } = head;
  let y = g.pad + headFont;
  p.push(`<text x="${g.pad}" y="${y}" font-family="${MONO}" font-size="${headFont}" letter-spacing="3" fill="${COLORS.muted}">${esc(`${a.title.kicker} · RESPONSES`)}</text>`);
  const state = { inSlot: false };
  for (const line of block.lines) {
    y += block.size * 1.12;
    p.push(`<text x="${g.pad}" y="${y}" font-family="${SANS}" font-size="${block.size}" font-weight="700" fill="${COLORS.text}">${titleLine(line, state)}</text>`);
  }

  // body: each placed line, fragment by fragment at measured x positions
  for (const { col, y: ly, para, range } of placed) {
    const line = materializeRichInlineLineRange(para.prepared, range);
    let x = g.pad + col * (g.colW + g.gap);
    const baseline = g.colTop + ly + f;
    for (const frag of line.fragments) {
      x += frag.gapBefore;
      let text = frag.text;
      let tx = x;
      const icon = para.icons[frag.itemIndex];
      if (icon && frag.start.segmentIndex === 0 && frag.start.graphemeIndex === 0 && text.startsWith(NBSP)) {
        // the reply's first fragment: its outcome square in the reserved space, then its first word
        p.push(iconRect(x, baseline, f, icon));
        text = text.slice(NBSP.length);
        tx = x + iconAdvance(f);
      }
      if (text.trim()) {
        const fill = para.fills[frag.itemIndex];
        const isBold = fill === COLORS.accent; // group labels are the only bold body items
        p.push(`<text x="${tx.toFixed(1)}" y="${baseline.toFixed(1)}" font-family="${SANS}" font-size="${f}"${isBold ? ' font-weight="700"' : ''} fill="${fill}" xml:space="preserve">${esc(text)}</text>`);
      }
      x += frag.occupiedWidth;
    }
  }

  // legend: model rows over the outcome row on the left, the run summary over the URL on the right
  const { s, o, rows, modelRowH, outcomeRowH, bottom, urlSize, urlBaseline, brandSize, brandBaseline } = leg;
  let ly = bottom - outcomeRowH - (rows.length - 1) * modelRowH; // swatch bottom of each model row
  for (const row of rows) {
    const rowBaseline = ly - s * FONT_METRICS.descent;
    for (const item of row) {
      p.push(iconRect(g.pad + item.x, rowBaseline, s, item.color));
      p.push(`<text x="${(g.pad + item.x + iconAdvance(s)).toFixed(1)}" y="${rowBaseline.toFixed(1)}" font-family="${SANS}" font-size="${s}" font-weight="700" fill="${item.color}">${esc(item.label)}</text>`);
    }
    ly += modelRowH;
  }
  let lx = g.pad;
  const textY = urlBaseline.toFixed(1);
  for (const [label, color] of OUTCOMES) {
    p.push(iconRect(lx, urlBaseline, o, color));
    lx += iconAdvance(o);
    p.push(`<text x="${lx.toFixed(1)}" y="${textY}" font-family="${SANS}" font-size="${o}" fill="${COLORS.text}">${esc(label)}</text>`);
    lx += measureWidth(label, font(o)) + o * 1.6;
  }
  p.push(`<text x="${lx.toFixed(1)}" y="${textY}" font-family="${SANS}" font-size="${o}" fill="${COLORS.muted}">${esc(NOTE)}</text>`);
  p.push(`<text x="${size - g.pad}" y="${urlBaseline.toFixed(1)}" text-anchor="end" font-family="${MONO}" font-size="${urlSize}" fill="${COLORS.text}">${esc(shareUrl)}</text>`);
  const shape = `${a.rows.length} model${a.rows.length > 1 ? 's' : ''} × ${a.variants.length} group${a.variants.length > 1 ? 's' : ''} × ${a.spec.runs} run${a.spec.runs > 1 ? 's' : ''}`;
  const meta = [`${responses} repl${responses === 1 ? 'y' : 'ies'}`, SELECTIONS[select] || select, shape,
    run.provider === 'mock' ? 'MOCK PROVIDER · NOT REAL MODEL OUTPUT' : null].filter(Boolean).join(' · ');
  // shrunk if needed so it stays inside its column and never reaches the model names on the left
  const metaSize = Math.min(brandSize, (quarterWidth(size) / measureWidth(meta, font(100))) * 100);
  p.push(`<text x="${size - g.pad}" y="${brandBaseline.toFixed(1)}" text-anchor="end" font-family="${SANS}" font-size="${metaSize.toFixed(1)}" fill="${run.provider === 'mock' ? COLORS.accent : COLORS.muted}">${esc(meta)}</text>`);
  p.push('</svg>');
  return p.join('\n');
}
