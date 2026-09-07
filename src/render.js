// Shareable card: dark grid, models as rows, identity variants as columns, cell fill = share of runs per outcome.
// Adapted from the treemap card: kicker line, quoted prompt, solid colored tiles, legend, URL bottom-right.
import { COLORS } from './analyze.js';

const SANS = "'DejaVu Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif";
const MONO = "'DejaVu Sans Mono', Menlo, Consolas, monospace";

export function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Rough glyph widths (em) good enough for wrapping sans-serif bold.
function textWidth(text, size, bold = false, mono = false) {
  if (mono) return text.length * 0.6 * size;
  let w = 0;
  for (const ch of text) {
    if (/[ .,:;'|!il]/.test(ch)) w += 0.3;
    else if (/[mwMW@]/.test(ch)) w += 0.85;
    else if (/[A-Z]/.test(ch)) w += 0.7;
    else if (/[0-9]/.test(ch)) w += 0.6;
    else w += 0.56;
  }
  return w * size * (bold ? 1.06 : 1);
}

function wrap(text, size, maxWidth, maxLines, bold = true) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? cur + ' ' + w : w;
    if (textWidth(test, size, bold) <= maxWidth) { cur = test; continue; }
    if (cur) { lines.push(cur); cur = ''; }
    if (textWidth(w, size, bold) <= maxWidth) { cur = w; continue; }
    // a single token wider than the line (URL, hash): hard-break it
    let chunk = '';
    for (const ch of w) {
      if (chunk && textWidth(chunk + ch, size, bold) > maxWidth) { lines.push(chunk); chunk = ''; }
      chunk += ch;
    }
    cur = chunk;
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    let last = kept[maxLines - 1];
    while (textWidth(last + '…', size, bold) > maxWidth && last.length > 1) last = last.slice(0, -1).trimEnd();
    kept[maxLines - 1] = last + '…';
    return kept;
  }
  return lines;
}

function shortModel(id) {
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
export const TITLE = { maxSize: 58, minSize: 26, floorSize: 16, lineHeight: 1.12, preferredShare: 0.34, minRowH: 64 };

/** Largest size in [minSize, maxSize] whose wrapped lines fit in maxHeight. overflow=true if even minSize does not. */
export function fitTitleBlock(text, maxWidth, { maxHeight, maxSize = TITLE.maxSize, minSize = TITLE.minSize, lineHeight = TITLE.lineHeight }) {
  const lo = Math.min(minSize, maxSize);
  for (let size = maxSize; size >= lo; size -= 1) {
    const lines = wrap(text, size, maxWidth, Infinity);
    const height = lines.length * size * lineHeight;
    if (height <= maxHeight) return { size, lines, height, overflow: false, truncated: false };
  }
  const lines = wrap(text, lo, maxWidth, Infinity);
  return { size: lo, lines, height: lines.length * lo * lineHeight, overflow: true, truncated: false };
}

function fit(text, size, maxWidth, bold = true, minSize = 14, mono = false) {
  let s = size;
  while (textWidth(text, s, bold, mono) > maxWidth && s > minSize) s -= 1;
  return s;
}

function signed(x) {
  const v = Math.abs(x) < 0.005 ? 0 : x;
  return (v >= 0 ? '+' : '') + v.toFixed(2);
}

// Highlight {a | b} slots in the title. The slot may wrap across lines, so the "inside a slot" state carries over.
function titleLine(line, x, y, size, state) {
  const spans = [];
  let i = 0;
  while (i < line.length) {
    if (state.inSlot) {
      const close = line.indexOf('}', i);
      const end = close === -1 ? line.length : close + 1;
      spans.push(`<tspan fill="${COLORS.accent}">${esc(line.slice(i, end))}</tspan>`);
      if (close !== -1) state.inSlot = false;
      i = end;
    } else {
      const open = line.indexOf('{', i);
      const end = open === -1 ? line.length : open;
      if (end > i) spans.push(esc(line.slice(i, end)));
      if (open !== -1) state.inSlot = true;
      i = end;
    }
  }
  return `<text x="${x}" y="${y}" font-family="${SANS}" font-size="${size}" font-weight="700" fill="${COLORS.text}">${spans.join('')}</text>`;
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

  // Prompt title (quoted), clamped so the whole prompt fits. See TITLE / fitTitleBlock above.
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
  let block = fitTitleBlock(quoted, titleWidth, { maxHeight: preferredH, maxSize: TITLE.maxSize, minSize: TITLE.minSize });
  if (block.overflow) block = fitTitleBlock(quoted, titleWidth, { maxHeight: availableH, maxSize: TITLE.minSize, minSize: TITLE.floorSize });
  if (block.overflow) {
    const maxLines = Math.max(1, Math.floor(availableH / (TITLE.floorSize * TITLE.lineHeight)));
    block = { size: TITLE.floorSize, lines: wrap(quoted, TITLE.floorSize, titleWidth, maxLines), overflow: true, truncated: true };
  }
  y = titleTop;
  const slotState = { inSlot: false };
  for (const line of block.lines) {
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
    const nameSize = fit(name, Math.min(42, rowH * 0.42), labelW - 48, true, 14);
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
    'bar = avg tokens',
    `n=${a.summary.runs_per_cell} per cell`,
    `temp ${a.spec.temperature}`,
    a.variants.length > 1 ? `Δ≥${a.spec.primary === 'sentiment' ? a.threshold : Math.round(a.threshold * 100) + ' pts'} flagged` : null,
  ].filter(Boolean).join(' · ');
  parts.push(`<text x="${pad}" y="${fy + 38}" font-family="${MONO}" font-size="18" fill="${COLORS.muted}">${esc(meta)}</text>`);
  if (a.mock) parts.push(`<text x="${W - pad}" y="${fy - 40}" text-anchor="end" font-family="${MONO}" font-size="18" fill="${COLORS.accent}">MOCK PROVIDER · NOT REAL MODEL OUTPUT</text>`);
  parts.push(`<text x="${W - pad}" y="${fy}" text-anchor="end" font-family="${MONO}" font-size="${urlSize}" fill="${COLORS.text}">${esc(shareUrl)}</text>`);
  parts.push(`<text x="${W - pad}" y="${fy + 38}" text-anchor="end" font-family="${SANS}" font-size="20" fill="${COLORS.muted}">${esc(brand)} · rerun to confirm</text>`);
  parts.push('</svg>');
  return parts.join('\n');
}
