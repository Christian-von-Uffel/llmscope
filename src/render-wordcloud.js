// Word cloud: one cloud per wording — the words a reply was scored on, sized by how many of that wording's
// replies used them, green or red by which way they scored — the inks in COLORS, not the fills the cards paint
// outcomes with, because text on the dark panel needs a lighter pair, and one that stays a pair without its hue.
//
//     “A large {Black | white | Muslim} family just moved in next door. Write two sentences…”
//     words a reply was scored on, sized by how many replies used them · words from the prompt left out
//
//     ┌ Black ───────────────┐ ┌ white ───────────────┐ ┌ Muslim ──────────────┐
//     │   curious  welcome   │ │      friendly        │ │   welcome  unsure    │
//     │ bias  block friendly │ │  hope  easy  gift    │ │  curious  uncertain  │
//     └──────────────────────┘ └──────────────────────┘ └──────────────────────┘
//
// It is the card for the question the refusal grid stopped answering. Models now answer almost everything, and
// the difference between two wordings is in how they answer: which wording gets "unsure" and "uncertain", which
// gets "friendly" five times out of five, which is the only one that draws "bias". A number per cell cannot show
// that; the words can. The panels sit in the order the card's columns read in, so the two images of one run
// are read the same way, and every word is placed by measuring it, never by chance, so the same run always
// draws the same card. Each cloud is fitted by shrinking its type until every word has a place, and a cloud
// that still overflows at the smallest readable size draws the words the most replies used and counts the rest.
import { COLORS, runsLine } from './analyze.js';
import { esc, textWidth, wrap, fit, fillLastLine, promptBlock, TITLE, GROW_MAX, monthStamp } from './render.js';
import { quoted } from './render-share.js';
import { spell } from './render-keywords.js';
import { cloudWords } from './words.js';
import { pinTextWidths, measureWidth, font, SANS, MONO } from './text.js';

/** A word is set no smaller than this at full scale, and the word the most replies used no larger than this. */
export const WORD_MIN = 16;
export const WORD_MAX = 64;
/**
 * A word used by this share of a wording's replies is drawn at full size. Sizes are absolute, not relative to
 * the panel's own top word: a word every reply used is the same size in every panel, and a panel whose most-used
 * word was in one reply of thirty draws it small — a cloud that scaled each panel to its own top word would set
 * that one stray word as large as the word every reply agreed on next door.
 */
export const RATE_FULL = 0.5;
/** What the picture is, said once under the heading. */
export const WORDS_LINE = 'words a reply was scored on, sized by how many replies used them · words from the prompt left out';

/**
 * The top-left line. Not the measure's brand line the other cards carry: a word cloud is the same image whatever
 * the run measured, so it names itself rather than saying "refusal rate".
 */
export const BRAND = 'llmscope · word cloud';

/**
 * The finding as a sentence: the wording whose replies leaned hardest on negative words, and the three they
 * used most. Ties keep the card's order. Conservative in the same way the results card is: it names words the
 * replies used, and claims nothing about why.
 */
export function wordsFinding(cw) {
  const scored = cw.clouds.filter((c) => c.words.length);
  if (!scored.length) return { headline: `No reply used a word ${cw.title} scores`, direction: null };
  const share = (c, sign) => c.words.filter((w) => w.sign === sign).reduce((s, w) => s + w.replies, 0) / c.words.reduce((s, w) => s + w.replies, 0);
  const top = scored.reduce((best, c) => (share(c, -1) > share(best, -1) ? c : best), scored[0]);
  const single = cw.clouds.length < 2;
  const most = (c, sign) => spell(c.words.filter((w) => w.sign === sign).slice(0, 3).map((w) => quoted(w.word)));
  if (share(top, -1) > 0) {
    return single
      ? { headline: `Replies used negative words: ${most(top, -1)}`, direction: null }
      : { headline: `Replies for ${quoted(top.label)} used negative words most often: ${most(top, -1)}`, direction: top.label };
  }
  return { headline: `No reply used a negative word; the most used were ${most(scored[0], 1)}`, direction: null };
}

/**
 * Where each word goes: an Archimedean spiral out from the panel's centre, the first place on it where the
 * word's box touches nothing already placed and stays inside the panel. Words come in the order the counts
 * rank them, so the word the most replies used sits in the middle and the rest wind out around it. Sizes run
 * from `min` to `max` in proportion to each word's share of replies, full at RATE_FULL.
 *
 * @returns {object[]} the words that found a place, each with its box, size, and where its baseline starts
 */
export function placeWords(words, W, H, { min, max }) {
  const placed = [];
  const top = Math.max(words[0]?.rate || 0, RATE_FULL);
  const PITCH = 8; // between one turn of the spiral and the next, in px
  const STRIDE = 6; // between one place tried and the next along it
  const reach = Math.hypot(W, H) / 2; // out to the corners, not just the sides
  const stretch = W / H; // a wide panel is searched wide
  const clear = (b) => placed.every((p) => b.x + b.w < p.x || p.x + p.w < b.x || b.y + b.h < p.y || p.y + p.h < b.y);
  for (const word of words) {
    const size = Math.round(min + (max - min) * (word.rate / top));
    const w = measureWidth(word.word, font(size, { bold: true })) + size * 0.25;
    const h = size * 1.05;
    if (w > W || h > H) continue;
    for (let th = 0, r = 0; r <= reach; th += STRIDE / Math.max(r, STRIDE), r = (PITCH * th) / (2 * Math.PI)) {
      const cx = W / 2 + r * Math.cos(th) * stretch;
      const cy = H / 2 + r * Math.sin(th);
      const box = { x: cx - w / 2, y: cy - h / 2, w, h };
      if (box.x < 0 || box.y < 0 || box.x + w > W || box.y + h > H || !clear(box)) continue;
      placed.push({ ...word, ...box, size, cx, baseline: cy + size * 0.36 });
      break;
    }
  }
  return placed;
}

/** The cloud at the largest scale at which every word finds a place; failing that, the scale that placed the most. */
export function layoutCloud(words, W, H, maxSize) {
  let best = [];
  for (let scale = 1; scale >= 0.6 - 1e-9; scale -= 0.05) {
    const placed = placeWords(words, W, H, { min: WORD_MIN * scale, max: maxSize * scale });
    if (placed.length === words.length) return placed;
    if (placed.length > best.length) best = placed;
  }
  return best;
}

/**
 * @param {object} run the saved run, for the replies themselves
 * @param {object} a its analysis, for the prompt heading, the column order and the run metadata
 * @param {'prompt'|'finding'} [opts.title] prompt (the default): every prompt the run sent is the heading.
 *   finding: the sentence from wordsFinding is the headline and the first prompt is quoted small under it.
 * @param {string|null} [opts.lexicon] which list to count against; see words.js for the default
 * @param {object[]} [opts.results] a filtered subset of the replies; the whole run by default
 */
export function renderWordCloud(run, a, { width = 1600, height = 1600, url = null, date = null, title = 'prompt', lexicon = null, results = run.results } = {}) {
  const W = width; const H = height; const pad = 64; const maxW = W - pad * 2;
  const cw = cloudWords(run, { a, lexicon, results });
  const shareUrl = url || `${a.spec.share_base || ''}${a.id}`;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`, `<rect width="${W}" height="${H}" fill="${COLORS.bg}"/>`];
  const num = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(1));
  const text = (x, y, str, { size = 24, weight = 400, fill = COLORS.text, family = SANS, anchor = 'start', extra = '' } = {}) =>
    parts.push(`<text x="${num(x)}" y="${num(y)}" text-anchor="${anchor}" font-family="${family}" font-size="${num(size)}" font-weight="${weight}" fill="${fill}" ${extra}>${esc(str)}</text>`);
  const rect = (x, y, w, h, fill, rx = 6) => parts.push(`<rect x="${num(x)}" y="${num(y)}" width="${num(Math.max(0, w))}" height="${num(Math.max(0, h))}" rx="${rx}" fill="${fill}"/>`);

  // Top strip, as on the results card: what the image is, and when the run was.
  let y = pad + 22;
  const stamp = `${monthStamp(date)}${a.mock ? ' · MOCK DATA' : ''}`;
  const brand = BRAND;
  const stampW = textWidth(stamp, 26, false, true) + 2 * stamp.length;
  text(pad, y, brand, { size: fit(brand, 26, maxW - stampW - 40, true, 15, true, 2), weight: 700, fill: COLORS.muted, family: MONO, extra: 'letter-spacing="2"' });
  text(W - pad, y, stamp, { size: 26, fill: a.mock ? COLORS.accent : COLORS.muted, family: MONO, anchor: 'end', extra: 'letter-spacing="2"' });

  // Panel geometry first, as the results card puts its grid first: the heading may use only the height the
  // clouds do not need, and a cloud never goes below MIN_PANEL however long the prompt is.
  const clouds = cw.clouds;
  const n = Math.max(1, clouds.length);
  const cols = n <= 3 ? n : Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const gap = 16; const footerH = 120; const MIN_PANEL = 200;
  const gridBottom = H - footerH;
  const subSize = fit(WORDS_LINE, 34, maxW, false, 18);
  const subH = subSize * 1.3 + 20;
  if (title === 'prompt') {
    y += 40;
    const panelsMinH = rows * MIN_PANEL + gap * (rows - 1);
    const availableH = Math.max(TITLE.floorSize * TITLE.lineHeight, Math.min(H * 0.3, gridBottom - y - 44 - subH - panelsMinH));
    const block = promptBlock(a.title.prompts, { x: pad, y, maxWidth: maxW, maxHeight: availableH, preferredHeight: Math.min(H * 0.22, availableH), slots: a.title.slots, maxSize: 64 * GROW_MAX });
    parts.push(...block.svg);
    y = block.bottom;
  } else {
    const finding = wordsFinding(cw);
    let hs = 76; let lines;
    for (;;) { lines = wrap(finding.headline, hs, maxW, Infinity); if (lines.length <= 3 || hs <= 44) break; hs -= 2; }
    lines = fillLastLine(finding.headline, hs, maxW, lines);
    y += 50;
    for (const line of lines) { y += hs * 1.08; text(pad, y, line, { size: hs, weight: 700 }); }
    const ps = 30;
    const plines = wrap(`“${a.title.prompt}”`, ps, maxW, 3, false);
    y += 26;
    for (const line of plines) { y += ps * 1.25; text(pad, y, line, { size: ps, fill: COLORS.muted }); }
    if (a.title.more) { y += 34; text(pad, y, a.title.more, { size: 24, fill: COLORS.muted }); }
  }
  // What the picture is, in grey under the heading, for the same reason the results card sets its counted
  // line in grey: the tone break is what separates it from the heading above it.
  y += 20 + subSize;
  text(pad, y, WORDS_LINE, { size: subSize, fill: COLORS.muted });
  y += 44;

  // The panels: one per wording, in the card's column order, each headed by its wording and its reply count.
  const gridTop = y;
  const pw = (maxW - gap * (cols - 1)) / cols;
  const ph = (gridBottom - gridTop - gap * (rows - 1)) / rows;
  let drawn = 0; let dropped = 0; let mixed = false;
  clouds.forEach((c, i) => {
    const px = pad + (i % cols) * (pw + gap);
    const py = gridTop + Math.floor(i / cols) * (ph + gap);
    rect(px, py, pw, ph, COLORS.panel, 8);
    // The count is sized first and the wording takes the rest, so a long wording shrinks rather than running
    // under its count. The count is written after the cloud is laid out, so it counts what is drawn.
    const countFor = (shown) => `${c.n} repl${c.n === 1 ? 'y' : 'ies'} · ${shown < c.total ? `${shown} of ${c.total}` : c.total} word${c.total === 1 ? '' : 's'}`;
    const countSize = fit(countFor(c.words.length), 20, pw * 0.5, false, 12, true);
    const ls = fit(c.label, 40, pw - 40 - textWidth(countFor(c.words.length), countSize, false, true) - 20, true, 18);
    text(px + 20, py + 20 + ls, c.label, { size: ls, weight: 700, fill: COLORS.accent });
    const innerTop = py + 32 + ls; const innerH = ph - (32 + ls) - 16; const innerW = pw - 32;
    if (!c.words.length) {
      text(px + pw / 2, innerTop + innerH / 2 + 8, c.n ? `no scored words in ${c.n} repl${c.n === 1 ? 'y' : 'ies'}` : 'no answered replies', { size: 24, fill: COLORS.muted, anchor: 'middle' });
      text(px + pw - 20, py + 20 + ls, countFor(0), { size: countSize, fill: COLORS.muted, family: MONO, anchor: 'end' });
      return;
    }
    const placed = layoutCloud(c.words, innerW, innerH, Math.min(WORD_MAX, innerW / 6, innerH / 3.5));
    for (const p of placed) {
      if (p.sign === 0) mixed = true;
      text(px + 16 + p.cx, innerTop + p.baseline, p.word, { size: p.size, weight: 700, fill: p.sign > 0 ? COLORS.greenInk : p.sign < 0 ? COLORS.redInk : COLORS.muted, anchor: 'middle' });
    }
    drawn += placed.length;
    dropped += c.words.length - placed.length;
    text(px + pw - 20, py + 20 + ls, countFor(placed.length), { size: countSize, fill: COLORS.muted, family: MONO, anchor: 'end' });
  });

  // Footer: what the two colours mean for this list, then the method and the link, as on the results card.
  const legendY = H - 82; const metaY = H - 32;
  const legend = [[COLORS.greenInk, cw.legend.positive], [COLORS.redInk, cw.legend.negative], ...(mixed ? [[COLORS.muted, 'scored both ways']] : [])];
  const ls2 = 26; let lx = pad;
  for (const [color, label] of legend) {
    rect(lx, legendY - ls2 + 4, ls2, ls2, color, 5);
    lx += ls2 + 12;
    text(lx, legendY, label, { size: ls2 });
    lx += textWidth(label, ls2) + 36;
  }
  const meta = [runsLine(a), `temperature ${a.spec.temperature}`, cw.title].join(' · ');
  text(W - pad, metaY, shareUrl, { size: 30, family: MONO, anchor: 'end' });
  text(pad, metaY, meta, { size: fit(meta, 22, maxW - textWidth(shareUrl, 30, false, true) - 40, false, 12, true), fill: COLORS.muted, family: MONO });
  parts.push('</svg>');
  return { svg: pinTextWidths(parts.join('\n')), lexicon: cw.lexicon, drawn, dropped };
}
