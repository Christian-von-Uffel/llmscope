// Shareable card: dark grid, models as rows, identity variants as columns, cell fill = share of runs per outcome.
// Adapted from the treemap card: kicker line, quoted prompt, solid colored tiles, legend, URL bottom-right.
import { COLORS, morePrompts, runsLine } from './analyze.js';
import { measureWidth, wrapText, pinTextWidths, font as fontStr, FONT_SANS, FONT_MONO } from './text.js';
import { logoFor } from './logos.js';

const SANS = `'${FONT_SANS}', 'Helvetica Neue', Helvetica, Arial, sans-serif`;
const MONO = `'${FONT_MONO}', Menlo, Consolas, monospace`;

export function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Width of text at a size: exact once fonts are loaded (see text.js), estimated before that. */
export function textWidth(text, size, bold = false, mono = false) {
  return measureWidth(text, fontStr(size, { bold, mono }));
}

export function wrap(text, size, maxWidth, maxLines, bold = true) {
  const lines = wrapText(text, fontStr(size, { bold }), maxWidth);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    let last = kept[maxLines - 1];
    while (textWidth(last + '...', size, bold) > maxWidth && last.length > 1) last = last.slice(0, -1).trimEnd();
    kept[maxLines - 1] = last + '\u2026';
    return kept;
  }
  return lines;
}

export function shortModel(id) {
  // "meta-llama/llama-4-maverick:free" -> "llama-4-maverick"
  return id.split('/').pop().split(':')[0];
}

export function clamp(min, value, max) {
  return Math.max(min, Math.min(max, value));
}

// Title sizing, the SVG equivalent of CSS clamp(min, preferred, max):
// the prompt is always shown in full. Font size shrinks from maxSize to minSize inside the preferred
// title area; if that is not enough the title borrows height from the grid (rows never go below minRowH)
// and shrinks to floorSize; only past that does the last line get an ellipsis.
export const TITLE = { maxSize: 58, minSize: 26, floorSize: 16, lineHeight: 1.12, preferredShare: 0.34, minRowH: 64, blockGap: 0.5 };
// A title reads best at 8-12 words a line (the classic 45-75 character measure), so it takes the fewest lines that
// keep it at or under the top of that band and then gets the largest size that still wraps to exactly those lines.
// Long prompts get more lines, not a longer measure. GROW_MAX is how far past the design size that may push a
// title whose measure leaves room, so a two-word prompt does not swallow the card.
export const MEASURE = { minWords: 8, maxWords: 12 };
export const GROW_MAX = 2;

/** Fewest lines that keep the text at or under MEASURE.maxWords a line. */
export function readableLines(text) {
  const words = String(text ?? '').trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / MEASURE.maxWords));
}

/**
 * Largest size in [minSize, maxSize] at which every paragraph wraps to no more than its own maxLines and the
 * whole block — the paragraphs plus a blockGap between them — fits maxHeight. Every paragraph is set at the
 * same size, so a card quoting several prompts never makes one of them look like the one that mattered.
 * At that size the widest line reaches the right edge: one step larger and a word spills onto another line.
 * overflow=true if even minSize does not fit the height; a text too long for maxLines at minSize simply takes
 * the lines it needs. Wrapping is pretext's (see text.js), so the line breaks are measured, not estimated.
 *
 * @param {string[]} texts the paragraphs, in the order they are drawn
 * @param {number|number[]} [maxLines] a cap for every paragraph, or one cap each
 */
function fitTitleBlocks(texts, maxWidth, { maxHeight, maxSize = TITLE.maxSize, minSize = TITLE.minSize, lineHeight = TITLE.lineHeight, gap = TITLE.blockGap, maxLines = Infinity }) {
  const caps = Array.isArray(maxLines) ? maxLines : texts.map(() => maxLines);
  const at = (size) => {
    const blocks = texts.map((t) => wrap(t, size, maxWidth, Infinity));
    const rows = blocks.reduce((n, b) => n + b.length, 0);
    return { size, blocks, height: rows * size * lineHeight + gap * size * (texts.length - 1), overflow: false, truncated: false };
  };
  const floor = at(Math.min(minSize, maxSize));
  if (floor.height > maxHeight) return { ...floor, overflow: true };
  // Both the height and the line count only grow with size, so binary-search the largest whole size that satisfies both.
  let best = floor;
  for (let lo = Math.ceil(floor.size) + 1, hi = Math.floor(maxSize); lo <= hi;) {
    const mid = Math.floor((lo + hi) / 2);
    const r = at(mid);
    if (r.height <= maxHeight && r.blocks.every((b, i) => b.length <= caps[i])) { best = r; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

/** One paragraph, the common case. `lines` is that paragraph's wrapped lines. */
export function fitTitleBlock(text, maxWidth, opts = {}) {
  const r = fitTitleBlocks([text], maxWidth, opts);
  return { ...r, lines: r.blocks[0] };
}

/**
 * The prompt heading both cards share: every prompt a run sent, quoted, all at one size, slots picked out in
 * amber. One size for all of them is the point — a card that set the first prompt larger would be claiming that
 * prompt is the one the numbers came from, and every cell pools them.
 *
 * Each prompt's measure sets how many lines it may take (8-12 words each) and pretext then sizes the whole block
 * to fill them. A block too long for `preferredHeight` at heading sizes drops into the reading band and may take
 * up to `maxHeight`; if even that is not enough, the prompts that still read are quoted and the rest are counted
 * off. The card would rather admit it left one out than shrink them all past reading size. One prompt on its own
 * never gets dropped: it takes the lines that fit and ends in an ellipsis, as a lone prompt always has.
 *
 * @returns {{svg: string[], size: number, bottom: number, shown: number, dropped: number, truncated: boolean}}
 *   `bottom` is the y the caller carries on from — the block's last baseline, count-off line included.
 */
export function promptBlock(prompts, {
  x, y, maxWidth, maxHeight, preferredHeight = maxHeight, slots = 'the same models',
  maxSize = TITLE.maxSize * GROW_MAX, minSize = TITLE.minSize, floorSize = TITLE.floorSize,
  lineHeight = TITLE.lineHeight, gap = TITLE.blockGap, moreGap = 34, moreSize = 24,
} = {}) {
  const all = prompts.map((p) => `“${p}”`);
  let kept = all.length ? all : [''];
  let block;
  for (;;) {
    // The count-off line only costs height once there is something to count off, so it is charged inside the loop.
    const room = Math.max(floorSize * lineHeight, maxHeight - (all.length - kept.length ? moreGap : 0));
    const measure = kept.map(readableLines);
    const opts = { minSize, lineHeight, gap, maxLines: measure };
    block = fitTitleBlocks(kept, maxWidth, { ...opts, maxHeight: Math.min(preferredHeight, room), maxSize });
    if (block.overflow) block = fitTitleBlocks(kept, maxWidth, { ...opts, maxHeight: room, maxSize: minSize, minSize: floorSize });
    if (!block.overflow) break;
    if (kept.length > 1) { kept = kept.slice(0, -1); continue; }
    const rows = Math.max(1, Math.floor(room / (floorSize * lineHeight)));
    block = { size: floorSize, blocks: [wrap(kept[0], floorSize, maxWidth, rows)], overflow: true, truncated: true };
    break;
  }
  const svg = [];
  let cursor = y;
  block.blocks.forEach((lines, i) => {
    if (i) cursor += block.size * gap;
    const state = { inSlot: false }; // a slot never runs from one prompt into the next
    const set = block.truncated ? lines : fillLastLine(kept[i], block.size, maxWidth, lines);
    for (const line of set) { cursor += block.size * lineHeight; svg.push(titleLine(line, x, cursor, block.size, state)); }
  });
  const dropped = all.length - kept.length;
  if (dropped) {
    cursor += moreGap;
    svg.push(`<text x="${x}" y="${cursor.toFixed(1)}" font-family="${SANS}" font-size="${moreSize}" fill="${COLORS.muted}">${esc(morePrompts(dropped, slots))}</text>`);
  }
  return { svg, size: block.size, bottom: cursor, shown: kept.length, dropped, truncated: Boolean(block.truncated) };
}

/**
 * The largest whole size at which `text` fits `maxWidth`. `tracking` is the letter-spacing the text will be drawn
 * with: SVG adds it after every glyph and the font metrics know nothing about it, so a tracked line measured
 * without it fits on paper and runs off the card.
 */
/**
 * The same lines, re-wrapped so the last one is not a stub. A paragraph that runs a word or two past its final
 * full line leaves an orphan — "of evil.”" alone under two full-width lines — which reads as a mistake rather
 * than as a measure. Pulling the measure in a little spreads those words back over the lines it already uses, at
 * the same size and the same line count, and the widest measure that does it is the one taken: the block stays as
 * close to the full width as it can while its last line carries `share` of the longest one.
 */
export function fillLastLine(text, size, maxWidth, lines, { share = 0.5, bold = true, floor = 0.6 } = {}) {
  if (lines.length < 2) return lines;
  const short = (ls) => {
    const w = ls.map((l) => textWidth(l, size, bold));
    return w[w.length - 1] < share * Math.max(...w);
  };
  if (!short(lines)) return lines;
  for (let w = maxWidth - maxWidth * 0.02; w >= maxWidth * floor; w -= maxWidth * 0.02) {
    const cand = wrap(text, size, w, Infinity, bold);
    if (cand.length <= lines.length && !short(cand)) return cand;
  }
  return lines;
}

export function fit(text, size, maxWidth, bold = true, minSize = 14, mono = false, tracking = 0) {
  const width = (s) => textWidth(text, s, bold, mono) + tracking * text.length;
  let s = size;
  while (width(s) > maxWidth && s > minSize) s -= 1;
  return s;
}

/** A sentiment delta as it is read: always signed, and never the \u201c-0.00\u201d that rounding alone produces. */
export function signed(x) {
  const v = Math.abs(x) < 0.005 ? 0 : x;
  return (v >= 0 ? '+' : '') + v.toFixed(2);
}

/**
 * Highlight {a | b} slots in the title. The slot may wrap across lines, so the "inside a slot" state carries over.
 *
 * Each colour is its own absolutely positioned <text> run, not a <tspan> inside one parent. A parent textLength
 * (see pinTextWidths) is applied by SVG viewers to the first piece only, which stretches "What is the
 * relationship" across the line and draws the amber slot on top of it. Separate runs pin to their own width.
 * xml:space="preserve" keeps the spaces at a slot boundary — SVG otherwise strips a leading or trailing space
 * and the words close up.
 */
export function titleLine(line, x, y, size, state) {
  const parts = [];
  let i = 0;
  let cx = x;
  const attrX = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
  while (i < line.length) {
    let piece;
    let fill = COLORS.text;
    if (state.inSlot) {
      const close = line.indexOf('}', i);
      const end = close === -1 ? line.length : close + 1;
      piece = line.slice(i, end);
      fill = COLORS.accent;
      if (close !== -1) state.inSlot = false;
      i = end;
    } else {
      const open = line.indexOf('{', i);
      const end = open === -1 ? line.length : open;
      piece = line.slice(i, end);
      if (open !== -1) state.inSlot = true;
      i = end;
    }
    if (!piece) continue;
    parts.push(`<text x="${attrX(cx)}" y="${y}" font-family="${SANS}" font-size="${size}" font-weight="700" fill="${fill}" xml:space="preserve">${esc(piece)}</text>`);
    cx += textWidth(piece, size, true);
  }
  return parts.join('');
}

/**
 * @param {ReturnType<import('./analyze.js').analyze>} a
 * @param {{width?:number, height?:number, url?:string, brand?:string}} opts
 */
export function renderCard(a, { width = 1600, height = 1600, url = null, brand = 'llmscope' } = {}) {
  const pad = 56;
  const W = width;
  const H = height;
  const shareUrl = url || `${a.spec.share_base || ''}${a.id}`;
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
  parts.push(`<rect width="${W}" height="${H}" fill="${COLORS.bg}"/>`);

  // Kicker
  let y = pad + 26;
  const kickerSize = fit(a.title.kicker, 26, W - pad * 2, false, 16);
  parts.push(`<text x="${pad}" y="${y}" font-family="${MONO}" font-size="${kickerSize}" letter-spacing="3" fill="${COLORS.muted}">${esc(a.title.kicker)}</text>`);

  // Prompt title (quoted), clamped so the whole prompt fits. See TITLE / MEASURE / fitTitleBlock above.
  const quoted = a.title.prompt ? `“${a.title.prompt}”` : '';
  const footerH = 120;
  const gap = 8;
  const rowsN = Math.max(1, a.rows.length);
  const colsN = Math.max(1, a.variants.length);
  const headerH = a.variants.length > 1 || a.variants[0]?.label !== '—' ? 88 : 0;
  const moreH = a.title.more ? 40 : 0;
  const titleTop = y + 40;
  const gridMinH = headerH + rowsN * TITLE.minRowH + gap * (rowsN - 1);
  const availableH = Math.max(TITLE.floorSize * TITLE.lineHeight, H - footerH - titleTop - moreH - 40 - gridMinH);
  const preferredH = clamp(TITLE.maxSize * TITLE.lineHeight, H * TITLE.preferredShare, availableH);
  const titleWidth = W - pad * 2 - 8;
  const measure = readableLines(quoted);
  let block = fitTitleBlock(quoted, titleWidth, { maxHeight: preferredH, maxSize: TITLE.maxSize * GROW_MAX, minSize: TITLE.minSize, maxLines: measure });
  if (block.overflow) block = fitTitleBlock(quoted, titleWidth, { maxHeight: availableH, maxSize: TITLE.minSize, minSize: TITLE.floorSize, maxLines: measure });
  if (block.overflow) {
    const maxLines = Math.max(1, Math.floor(availableH / (TITLE.floorSize * TITLE.lineHeight)));
    block = { size: TITLE.floorSize, lines: wrap(quoted, TITLE.floorSize, titleWidth, maxLines), overflow: true, truncated: true };
  }
  y = titleTop;
  const slotState = { inSlot: false };
  const titleLines = block.truncated ? block.lines : fillLastLine(quoted, block.size, titleWidth, block.lines);
  for (const line of titleLines) {
    y += block.size * TITLE.lineHeight;
    parts.push(titleLine(line, pad, y, block.size, slotState));
  }
  if (a.title.more) {
    y += moreH;
    parts.push(`<text x="${pad}" y="${y}" font-family="${SANS}" font-size="26" fill="${COLORS.muted}">${esc(a.title.more)}</text>`);
  }
  y += 40;

  // Grid geometry
  const gridTop = y;
  const gridBottom = H - footerH;
  const labelW = Math.min(440, Math.round(W * 0.3));
  const rowH = (gridBottom - gridTop - headerH - gap * (rowsN - 1)) / rowsN;
  const cellW = (W - pad * 2 - labelW - gap * colsN) / colsN;
  const gridX = pad + labelW + gap;

  // Column headers (variant labels)
  if (headerH) {
    a.variants.forEach((v, i) => {
      const x = gridX + i * (cellW + gap) + cellW / 2;
      const size = fit(v.label, 40, cellW - 24, true, 16);
      parts.push(`<text x="${x}" y="${gridTop + headerH / 2 + size / 3}" text-anchor="middle" font-family="${SANS}" font-size="${size}" font-weight="700" fill="${COLORS.accent}">${esc(v.label)}</text>`);
    });
  }

  // Rows
  a.rows.forEach((row, ri) => {
    const ry = gridTop + headerH + ri * (rowH + gap);
    // label tile
    parts.push(`<rect x="${pad}" y="${ry}" width="${labelW}" height="${rowH}" fill="${COLORS.panel}"/>`);
    if (row.flagged) parts.push(`<rect x="${pad}" y="${ry}" width="10" height="${rowH}" fill="${COLORS.accent}"/>`);
    const name = shortModel(row.model);
    const logo = logoFor(row.model);
    const logoSize = Math.max(24, Math.min(44, rowH * 0.4));
    if (logo) parts.push(`<image x="${pad + 26}" y="${(ry + rowH / 2 - logoSize / 2).toFixed(1)}" width="${logoSize}" height="${logoSize}" href="${logo}" opacity="0.9"/>`);
    const nameSize = fit(name, Math.min(42, rowH * 0.42), labelW - 48 - (logo ? logoSize + 16 : 0), true, 14);
    const nameY = ry + rowH / 2 + (row.flagged && a.variants.length > 1 ? -4 : nameSize / 3);
    parts.push(`<text x="${pad + labelW - 20}" y="${nameY}" text-anchor="end" font-family="${SANS}" font-size="${nameSize}" font-weight="700" fill="${COLORS.text}">${esc(name)}</text>`);
    if (row.flagged && a.variants.length > 1) {
      const sub = a.spec.primary === 'sentiment' ? `Δ ${row.disparity.toFixed(2)}` : `Δ ${Math.round(row.disparity * 100)} pts`;
      parts.push(`<text x="${pad + labelW - 20}" y="${nameY + 30}" text-anchor="end" font-family="${MONO}" font-size="22" fill="${COLORS.accent}">${esc(sub)}</text>`);
    }
    // cells
    row.cells.forEach((cell, ci) => {
      const cx = gridX + ci * (cellW + gap);
      parts.push(`<rect x="${cx}" y="${ry}" width="${cellW}" height="${rowH}" fill="${COLORS.gray}" opacity="0.45"/>`);
      if (cell.n) {
        let sx = cx;
        for (const seg of cell.segments) {
          const w = (seg.count / cell.n) * cellW;
          parts.push(`<rect x="${sx.toFixed(1)}" y="${ry}" width="${w.toFixed(1)}" height="${rowH}" fill="${seg.color}"/>`);
          sx += w;
        }
      }
      // token bar (avg completion tokens relative to grid max)
      const barW = Math.max(0, (cell.tokens_mean / a.maxTokens) * (cellW - 32));
      const barY = ry + rowH - 18;
      parts.push(`<rect x="${cx + 16}" y="${barY}" width="${cellW - 32}" height="6" fill="#000" opacity="0.25"/>`);
      parts.push(`<rect x="${cx + 16}" y="${barY}" width="${barW.toFixed(1)}" height="6" fill="#fff" opacity="0.6"/>`);
      // text
      const bigSize = fit(cell.big, Math.min(40, rowH * 0.36), cellW - 40, true, 14);
      const tokTxt = `${Math.round(cell.tokens_mean)} tok`;
      const sentTxt = cell.answered ? `sent ${signed(cell.sentiment_mean)}` : '';
      const smallMax = cellW - 32;
      let smallSize = Math.max(12, Math.min(22, rowH * 0.18));
      let smallLines;
      if (a.spec.primary === 'keyword') {
        // keyword cards: show WHICH words fired, as many as fit on one line
        smallLines = [tokTxt];
        if (cell.top_hits?.length) {
          let hits = '';
          for (const h of cell.top_hits) {
            const next = hits ? `${hits} · ${h.kw} ×${h.count}` : `${h.kw} ×${h.count}`;
            if (textWidth(next, smallSize, false, true) > smallMax) break;
            hits = next;
          }
          if (!hits) { hits = `${cell.top_hits[0].kw} ×${cell.top_hits[0].count}`; smallSize = fit(hits, smallSize, smallMax, false, 11, true); }
          smallLines.push(hits);
        }
      } else {
        smallLines = [[tokTxt, sentTxt].filter(Boolean).join(' · ')];
        if (textWidth(smallLines[0], smallSize, false, true) > smallMax) {
          smallLines = [tokTxt, sentTxt].filter(Boolean);
          smallSize = Math.min(smallSize, ...smallLines.map((l) => fit(l, smallSize, smallMax, false, 11, true)));
        }
      }
      // centre the text block in the space above the token bar so compressed rows never collide with it
      const textAreaBottom = barY - 8;
      const showSmall = rowH > 70;
      const blockH = bigSize + (showSmall ? smallLines.length * smallSize * 1.3 + 6 : 0);
      const blockTop = ry + Math.max(4, (textAreaBottom - ry - blockH) / 2);
      parts.push(`<text x="${cx + cellW / 2}" y="${(blockTop + bigSize * 0.82).toFixed(1)}" text-anchor="middle" font-family="${SANS}" font-size="${bigSize}" font-weight="700" fill="#fff">${esc(cell.big)}</text>`);
      if (showSmall) smallLines.forEach((line, li) => {
        const sy = blockTop + bigSize + 6 + (li + 1) * smallSize * 1.3 - smallSize * 0.3;
        if (sy <= textAreaBottom) parts.push(`<text x="${cx + cellW / 2}" y="${sy.toFixed(1)}" text-anchor="middle" font-family="${MONO}" font-size="${smallSize}" fill="#fff" opacity="0.85">${esc(line)}</text>`);
      });
    });
  });

  // Footer: legend left, url right
  const fy = H - 50;
  // legend shrinks (26 -> 16px) so long keyword labels never run into the URL on the right
  const urlSize = 30;
  const legendMax = W - pad * 2 - textWidth(shareUrl, urlSize, false, true) - 48;
  const legendWidth = (sz) => a.legend.reduce((w, item) => w + sz + 12 + textWidth(item.label, sz) + 40, 0) - 40;
  let legendSize = 26;
  while (legendWidth(legendSize) > legendMax && legendSize > 16) legendSize -= 1;
  let lx = pad;
  for (const item of a.legend) {
    parts.push(`<rect x="${lx}" y="${fy - legendSize + 4}" width="${legendSize}" height="${legendSize}" rx="5" fill="${item.color}"/>`);
    lx += legendSize + 12;
    parts.push(`<text x="${lx}" y="${fy}" font-family="${SANS}" font-size="${legendSize}" fill="${COLORS.text}">${esc(item.label)}</text>`);
    lx += textWidth(item.label, legendSize) + 40;
  }
  const meta = [
    'tile = share of runs',
    'bar = avg reply tokens',
    runsLine(a),
    `temp ${a.spec.temperature}`,
    a.variants.length > 1 ? `Δ≥${a.spec.primary === 'sentiment' ? a.threshold : Math.round(a.threshold * 100) + ' pts'} flagged` : null,
  ].filter(Boolean).join(' · ');
  parts.push(`<text x="${pad}" y="${fy + 38}" font-family="${MONO}" font-size="18" fill="${COLORS.muted}">${esc(meta)}</text>`);
  if (a.mock) parts.push(`<text x="${W - pad}" y="${fy - 40}" text-anchor="end" font-family="${MONO}" font-size="18" fill="${COLORS.accent}">MOCK PROVIDER · NOT REAL MODEL OUTPUT</text>`);
  parts.push(`<text x="${W - pad}" y="${fy}" text-anchor="end" font-family="${MONO}" font-size="${urlSize}" fill="${COLORS.text}">${esc(shareUrl)}</text>`);
  parts.push(`<text x="${W - pad}" y="${fy + 38}" text-anchor="end" font-family="${SANS}" font-size="20" fill="${COLORS.muted}">${esc(brand)} · rerun to confirm</text>`);
  parts.push('</svg>');
  return pinTextWidths(parts.join('\n'));
}
