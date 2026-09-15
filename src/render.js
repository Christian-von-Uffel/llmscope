// What every card and sheet draws its heading with: text measuring, wrapping and fitting, the prompt block with
// its slots picked out, and the month stamp. The cards themselves live in render-share.js and render-keywords.js.
import { COLORS, morePrompts } from './analyze.js';
import { measureWidth, wrapText, pinTextWidths, font as fontStr, SANS } from './text.js';


/** The month a run finished, as the cards stamp it: “SEP 2026”. Today's when the run does not say. */
export function monthStamp(iso) {
  const d = iso ? new Date(iso) : new Date();
  return d.toLocaleString('en-US', { month: 'short', year: 'numeric' }).toUpperCase();
}

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
 * Most lines the text may take and still carry MEASURE.minWords a line. A title set larger than its measure asks
 * for buys the size with lines, and past this many it is no longer a measure but a column of stubs — so however
 * much room a page has to give the prompt, it takes no more lines than this. Never fewer than readableLines.
 */
export function mostLines(text) {
  const words = String(text ?? '').trim().split(/\s+/).filter(Boolean).length;
  return Math.max(readableLines(text), Math.floor(words / MEASURE.minWords));
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

