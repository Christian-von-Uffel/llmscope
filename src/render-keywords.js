// Keyword card: which model replied with which marked word, for which wording, in how many of its responses.
//
// The card is a list of claims, each one a sentence a reader can carry away — “Mistral Medium 3.5 replied with
// “misinformation” in all 3 responses where the prompt said “childhood vaccination”” — drawn as one line:
//
//     [logo] Mistral Medium 3.5   childhood vaccination  →  [“misinformation”] 100%   [“myth”] 100%
//                                                                              ●●●             ●●●
//
// The model with its logo, the wording in the colour the prompt's slot wears, an arrow, then each word in a red
// chip with its rate in the largest type on the line and one dot per run under it, filled for the runs the word
// was in. A word counts for a wording only when it was in at least two of that wording's runs and at least half
// of them: a single stray reply is not a claim, and it is not drawn. Wordings with the same outcome share a
// line. Every model that ran is listed, ranked by its strongest claim, and one with no claim says “no matches”
// beside its name, so the card says who is clean as well as who is not. Under the list a key shows the three
// things a line is made of, drawn as they appear, each with what it means in the run's own numbers.
//
// It replaced a grid of word × wording and word × family blocks. That grid could say which model used a word
// at all, and which wording a word landed on across every model, but never which model used a word for one
// wording and not another — and that is the question a wording eval asks. Starting from the sentences the card
// should support, rather than from the table behind it, is what made the relationship the thing drawn.
import { COLORS, brandLine, runsLine } from './analyze.js';
import { esc, textWidth, wrap, fit, clamp, fillLastLine, fitTitleBlock, promptBlock, TITLE, GROW_MAX } from './render.js';
import { prettyName, monthStamp, quoted } from './render-share.js';
import { keywordGrid } from './keyword-grid.js';
import { logoFor } from './logos.js';
import { pinTextWidths, SANS, MONO } from './text.js';

const pct = (x) => `${Math.round(x * 100)}%`;

/** A word counts for a wording when it was in at least this many of that wording's runs… */
export const MIN_REPLIES = 2;
/** …and in at least this share of them. */
export const MIN_RATE = 0.5;
/** Past this many runs per wording, the dots under a rate give way to a count. */
export const MAX_DOTS = 12;
/** Whether a word's showing for one wording is a claim rather than a stray reply. */
export const counts = (w) => w.replies >= MIN_REPLIES && w.rate >= MIN_RATE - 1e-9;
/**
 * The verb a claim is stated with. The run measures a word appearing in a response, and "replied with" says
 * exactly that: it claims nothing about why the model chose the word. It stood at "used" for a while — the
 * sentences this card was rebuilt from said so — and "found in" before that; one phrase to change if it moves again.
 */
export const VERB = 'replied with';
/** DejaVu Sans Bold's cap height, as a share of the size: what centres a number on a line. */
const CAP_H = 0.73;
/** A line of the list may be this tall at most and this short at least; everything on it is sized from its height. */
export const LINE_MIN = 58;
export const LINE_MAX = 96;

/** A list of names as a sentence reads them: "a", "a and b", "a, b and c". */
export const spell = (xs, conj = 'and') => (xs.length <= 1 ? xs[0] ?? '' : xs.length === 2 ? `${xs[0]} ${conj} ${xs[1]}` : `${xs.slice(0, -1).join(', ')} ${conj} ${xs[xs.length - 1]}`);

/**
 * The claims a run supports, model by model: for each wording, the words that counted, with how many of that
 * wording's runs each was in. Wordings with the same counted words at the same counts share a line. Models are
 * ranked by their strongest claim; ties by how many lines they have, then by whether anything matched at all,
 * then by the order the analysis ranks them in — so a rerun draws the same card.
 *
 * @param {object} run a saved run
 * @param {string[]} terms the words to count — the run's own keywords, or whatever it was told to mark
 * @param {object[]} [opts.results] a filtered subset; defaults to the whole run
 * @param {object} [opts.names] model display names, from the catalogue
 * @returns {{models: object[], withClaims: object[], variants: string[], single: boolean, n: number, words: string[]}}
 *   `n` is how many runs a wording had per model, the number the dots and the key count against
 */
export function keywordClaims(run, terms, { results = run.results, names = {} } = {}) {
  const grid = keywordGrid(run, terms, { results });
  const single = grid.variants.length < 2;
  const cell = (model, variant, row) => row.cells.find((c) => c.model === model && c.variant === variant) ?? { replies: 0, n: 0 };
  const asked = (model, variant) => results.filter((r) => r.model === model && r.variantLabel === variant).length;
  const models = grid.models.map((model) => {
    const byWording = grid.variants.map((variant) => {
      const words = grid.rows
        .map((row) => ({ word: row.label, ...cell(model, variant, row) }))
        .map((w) => ({ word: w.word, replies: w.replies, n: w.n, rate: w.n ? w.replies / w.n : 0 }))
        .filter((w) => w.replies > 0)
        .sort((x, y) => y.rate - x.rate || x.word.localeCompare(y.word));
      const notable = words.filter(counts);
      return { variant, words, notable, key: notable.map((w) => `${w.word}:${w.replies}/${w.n}`).join('|'), top: notable[0]?.rate ?? 0, n: asked(model, variant) };
    });
    const lines = [];
    for (const w of byWording) {
      if (!w.notable.length) continue;
      const same = lines.find((l) => l.key === w.key);
      if (same) same.variants.push(w.variant);
      else lines.push({ variants: [w.variant], words: w.notable, key: w.key, top: w.top, n: w.n });
    }
    lines.sort((x, y) => y.top - x.top || y.words.length - x.words.length);
    return { model, name: prettyName(model, names), lines, anyHit: byWording.some((w) => w.words.length), top: lines[0]?.top ?? 0, n: Math.max(0, ...byWording.map((w) => w.n)) };
  });
  models.sort((x, y) => y.top - x.top || y.lines.length - x.lines.length || Number(y.anyHit) - Number(x.anyHit) || grid.models.indexOf(x.model) - grid.models.indexOf(y.model));
  return { models, withClaims: models.filter((m) => m.lines.length), variants: grid.variants, single, n: Math.max(0, ...models.map((m) => m.n)), words: grid.rows.map((r) => r.label) };
}

/**
 * One line of the list as the sentence it stands for — “Grok 4.6 replied with “myth” in 2 of the 3 responses
 * where the prompt said “childhood vaccination”” — the model, the word, how many of the responses it was in, and
 * the wording that was in the prompt. Counts rather than a rate, because the dots under the rate on the line are
 * counts and a reader wants to see the same number twice. Words on one line at different counts are claimed at
 * the lower one. What the model did not reply with is left to the list, where a wording with no line is a
 * wording with no claim.
 */
export function claimSentence(m, l, { single = false } = {}) {
  const words = l.words.map((w) => quoted(w.word));
  const n = Math.max(...l.words.map((w) => w.n));
  const least = Math.min(...l.words.map((w) => w.replies));
  const most = Math.max(...l.words.map((w) => w.replies));
  const countStr = least === n ? `all ${n} responses` : `${least === most ? '' : 'at least '}${least} of the ${n} responses`;
  const whereStr = single ? '' : ` where the prompt said ${l.variants.length <= 2 ? spell(l.variants.map(quoted), 'or') : `one of ${l.variants.length} wordings`}`;
  return `${m.name} ${VERB} ${spell(words)} in ${countStr}${whereStr}`;
}

/** The finding as a sentence: the strongest claim on the card, or the plain statement that there is none. */
export function keywordFinding(claims) {
  const top = claims.withClaims[0];
  if (!top) return { headline: `No model ${VERB} any of these words in ${MIN_REPLIES} or more of its responses` };
  return { headline: claimSentence(top, top.lines[0], { single: claims.single }) };
}

/**
 * @param {object} run the saved run, for the replies themselves
 * @param {object} a its analysis, for the prompt heading and the run metadata
 * @param {string[]} terms the words to count — the run's own keywords, or whatever it was told to mark
 * @param {'prompt'|'finding'} [opts.title] prompt (the default): every prompt the run sent is the heading and
 *   no finding is stated — the reader sees what was asked and reads the list for what came back.
 *   finding: the strongest claim is the headline, as a sentence, and the first prompt is quoted small under it.
 */
export function renderKeywordCard(run, a, terms, { width = 1600, height = 1600, names = {}, url = null, date = null, results = run.results, title = 'prompt' } = {}) {
  const W = width; const H = height; const pad = 64; const maxW = W - pad * 2;
  const claims = keywordClaims(run, terms, { results, names });
  const { single, variants, n } = claims;
  const shareUrl = url || `${a.spec.share_base || ''}${a.id}`;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`, `<rect width="${W}" height="${H}" fill="${COLORS.bg}"/>`];
  const num = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(1));
  const text = (x, y, str, { size = 24, weight = 400, fill = COLORS.text, font = SANS, anchor = 'start', opacity = 1, extra = '' } = {}) =>
    parts.push(`<text x="${num(x)}" y="${num(y)}" text-anchor="${anchor}" font-family="${font}" font-size="${num(size)}" font-weight="${weight}" fill="${fill}"${opacity < 1 ? ` opacity="${opacity}"` : ''} ${extra}>${esc(str)}</text>`);
  const rect = (x, y, w, h, fill, { rx = 6, opacity = 1 } = {}) =>
    parts.push(`<rect x="${num(x)}" y="${num(y)}" width="${num(Math.max(0, w))}" height="${num(Math.max(0, h))}" rx="${num(rx)}" fill="${fill}"${opacity < 1 ? ` opacity="${opacity}"` : ''}/>`);
  const circle = (cx, cy, r, fill, stroke = null) =>
    parts.push(`<circle cx="${num(cx)}" cy="${num(cy)}" r="${num(r)}" fill="${fill}"${stroke ? ` stroke="${stroke}" stroke-width="2"` : ''}/>`);

  // ---- heading: the brand line and stamp, then the prompt or the claim, with nothing between ----
  let y = pad + 22;
  const stamp = `${monthStamp(date)}${a.mock ? ' · MOCK DATA' : ''}`;
  const brand = brandLine(a);
  const stampW = textWidth(stamp, 26, false, true) + 2 * stamp.length;
  text(pad, y, brand, { size: fit(brand, 26, maxW - stampW - 40, true, 15, true, 2), weight: 700, fill: COLORS.muted, font: MONO, extra: 'letter-spacing="2"' });
  text(W - pad, y, stamp, { size: 26, fill: a.mock ? COLORS.accent : COLORS.muted, font: MONO, anchor: 'end', extra: 'letter-spacing="2"' });

  const footerH = 150; // the key row, then the run line and the share link
  const listBottom = H - footerH;
  const GROUP_GAP = 22;

  // ---- what the list holds, cut to what fits ----
  // The least a heading can take decides how many rows there is room for at the shortest line. Past that, the
  // models with no claim fold into one closing line first — they are the least of the card — and only then are
  // the lowest-ranked claims dropped and counted off. A card would rather say it left claims out than draw them
  // too small to read.
  const HEAD_MIN_H = title === 'prompt'
    ? 14 + 24 + TITLE.floorSize * TITLE.lineHeight + 60
    : 20 + 2 * 24 * TITLE.lineHeight + 18 + 2 * 25 * 1.25 + 54;
  const budget = listBottom - (y + HEAD_MIN_H);
  let listed = claims.models;
  let folded = [];
  let hiddenClaims = 0;
  const needs = (ms, extraRows) => ms.reduce((s, m) => s + Math.max(1, m.lines.length), 0) * LINE_MIN + (ms.length + extraRows - 1) * GROUP_GAP + extraRows * LINE_MIN;
  if (needs(listed, 0) > budget && listed.some((m) => !m.lines.length)) {
    folded = listed.filter((m) => !m.lines.length);
    listed = listed.filter((m) => m.lines.length);
  }
  while (listed.length > 1 && needs(listed, (folded.length ? 1 : 0) + (hiddenClaims ? 1 : 0)) > budget) {
    const last = listed[listed.length - 1];
    hiddenClaims += last.lines.length;
    listed = listed.slice(0, -1);
  }
  const closing = (folded.length ? 1 : 0) + (hiddenClaims ? 1 : 0);
  const rowsTotal = listed.reduce((s, m) => s + Math.max(1, m.lines.length), 0) + closing;
  const groups = listed.length + closing;
  const listMinH = rowsTotal * LINE_MIN + (groups - 1) * GROUP_GAP;

  if (title === 'prompt') {
    // What was asked, and nothing about what came back. Every line pools the run's prompts, so all of them are
    // quoted at one size: a card that showed the first alone would invite the reader to pin the numbers on it.
    y += 14;
    const availableH = Math.max(TITLE.floorSize * TITLE.lineHeight, Math.min(H * 0.3, listBottom - (y + 24) - 60 - listMinH));
    const block = promptBlock(a.title.prompts, { x: pad, y: y + 24, maxWidth: maxW, maxHeight: availableH, preferredHeight: Math.min(H * 0.22, availableH), slots: a.title.slots, maxSize: TITLE.maxSize * GROW_MAX });
    parts.push(...block.svg);
    y = block.bottom + 60;
  } else {
    // The strongest claim, as the sentence it is, on two lines at the largest size pretext fits them at — never a
    // third — with the measure pulled in so the second line is not a stub. The rest of the claims are the list.
    const { headline } = keywordFinding(claims);
    const fitted = fitTitleBlock(headline, maxW, { maxHeight: 2 * TITLE.maxSize * TITLE.lineHeight + 1, maxSize: TITLE.maxSize, minSize: 24, maxLines: 2 });
    const head = fillLastLine(headline, fitted.size, maxW, fitted.lines);
    y += 20;
    for (const l of head) { y += fitted.size * TITLE.lineHeight; text(pad, y, l, { size: fitted.size, weight: 700 }); }
    // The claim took the top, so the prompts are quoted small under it and any that do not fit are counted off.
    const promptQuote = `“${a.title.prompt}”`;
    const ps = 25;
    y += 18;
    for (const l of wrap(promptQuote, ps, maxW, 2, false)) { y += ps * 1.25; text(pad, y, l, { size: ps, fill: COLORS.muted }); }
    if (a.title.more) { y += ps * 1.25; text(pad, y, a.title.more, { size: ps, fill: COLORS.muted }); }
    y += 54;
  }

  // ---- the list: as large as the height the heading left allows ----
  const listTop = y;
  const room = listBottom - listTop - (groups - 1) * GROUP_GAP;
  const LINE_H = rowsTotal ? clamp(LINE_MIN, room / rowsTotal, LINE_MAX) : LINE_MAX;
  /** Everything on a line is sized from its height, so a short list is set large and a long one small. */
  const s = clamp(0.85, LINE_H / 66, 1.35);
  const listH = rowsTotal * LINE_H + (groups - 1) * GROUP_GAP;
  y = listTop + Math.min(Math.max(0, listBottom - listTop - listH) / 2, 60);

  // The name and wording columns take what their longest entries need and no more: the outcomes are the reading,
  // so the width goes to them. The wording is set a step above the model name and the chip text — it is the half
  // of the claim the eval turns on — and every name is set at one size, so the column reads as one list.
  const logoS = 36 * s;
  const NAME_SIZE = 24 * s;
  const nameNeed = Math.max(0, ...listed.map((m) => textWidth(m.name, NAME_SIZE, true)));
  const nameW = clamp(180 * s, 22 * s + logoS + 12 * s + nameNeed + 22 * s + 18 * s, 300 * s);
  const nameSize = Math.min(NAME_SIZE, ...listed.map((m) => fit(m.name, NAME_SIZE, nameW - 18 * s - 22 * s - logoS - 12 * s - 12, true, 14)));
  const WORDING_SIZE = 23 * s;
  const wordingNeed = Math.max(0, ...listed.flatMap((m) => m.lines.flatMap((l) => l.variants.map((v) => textWidth(v, WORDING_SIZE, true)))));
  const wordingW = single ? 0 : clamp(200 * s, wordingNeed + 16 * s, 320 * s);
  const arrowW = single ? 0 : 48 * s;
  const outX = pad + nameW + wordingW + arrowW;
  const outW = pad + maxW - outX;

  const CHIP_TEXT = 26;
  /** The rate is the reading, so it is the largest type on the line. */
  const RATE_SIZE = 42;

  /**
   * The rate as a stat: the percentage in large type, and under it one dot per run, filled for the runs the word
   * was in. The dots are measured against the number they sit under — spread at their natural spacing when the
   * number is wide enough, packed closer when there are more runs than that, and given up for a count when even
   * packed they would not read.
   */
  const rateBlock = (w, scale) => {
    const size = RATE_SIZE * scale;
    const str = pct(w.rate);
    const pw = textWidth(str, size, true);
    const useDots = w.n <= MAX_DOTS;
    let r = 5.5 * scale; let spacing = 15 * scale;
    const avail = Math.max(pw, 60 * scale);
    if (useDots && w.n > 1 && (w.n - 1) * spacing + 2 * r > avail) {
      spacing = (avail - 2 * r) / (w.n - 1);
      if (spacing < 2 * r + 2) r = Math.max(2.5, spacing / 2 - 1);
    }
    const caption = useDots ? null : `${w.replies} of ${w.n} runs`;
    const capSize = 15 * scale;
    const dotsW = useDots ? (w.n > 1 ? (w.n - 1) * spacing + 2 * r : 2 * r) : textWidth(caption, capSize, false);
    const under = useDots ? 2 * r : capSize * CAP_H;
    const gap = 12 * scale; // clear air between the number's baseline and the dots, so they read as a row of their own
    return { size, str, pw, r, spacing, dotsW, caption, capSize, under, gap, width: Math.max(pw, dotsW), stackH: size * CAP_H + gap + under };
  };
  /** The chip is as tall as the number and dots beside it, so the two read as one unit. */
  const chipHeight = (scale) => rateBlock({ rate: 1, n: 3, replies: 3 }, scale).stackH + 4 * scale;
  /** Width one outcome takes at a scale, so a line can be fitted before it is drawn. */
  const outcomeW = (w, scale) => textWidth(quoted(w.word), CHIP_TEXT * scale, true) + 24 * scale + 16 * scale + rateBlock(w, scale).width + 36 * scale;
  /** One outcome — a word in a chip, then its rate over its runs — from x; returns the x it ended at. */
  const outcome = (x, mid, w, scale) => {
    const size = CHIP_TEXT * scale;
    const label = quoted(w.word);
    const chipW = textWidth(label, size, true) + 24 * scale;
    const chipH = chipHeight(scale);
    rect(x, mid - chipH / 2, chipW, chipH, COLORS.red, { rx: 8 * scale });
    text(x + 12 * scale, mid + size * CAP_H / 2, label, { size, weight: 700, fill: '#fff' });
    const rb = rateBlock(w, scale);
    const rx = x + chipW + 16 * scale;
    const top = mid - rb.stackH / 2;
    const baseline = top + rb.size * CAP_H;
    text(rx, baseline, rb.str, { size: rb.size, weight: 700 });
    const cxMid = rx + rb.pw / 2;
    if (rb.caption) text(cxMid, baseline + rb.gap + rb.capSize * CAP_H, rb.caption, { size: rb.capSize, fill: COLORS.muted, anchor: 'middle' });
    else {
      const cy = baseline + rb.gap + rb.r;
      let cx = cxMid - rb.dotsW / 2 + rb.r;
      for (let i = 0; i < w.n; i++) {
        if (i < w.replies) circle(cx, cy, rb.r, COLORS.text);
        else circle(cx, cy, Math.max(1.5, rb.r - 1), 'none', COLORS.muted);
        cx += rb.spacing;
      }
    }
    return rx + rb.width + 36 * scale;
  };

  // One scale for every outcome on the card — the largest at which the busiest line still fits — so a line with
  // two words is set in the same type as a line with one.
  const lineWidth = (ws, sc) => ws.reduce((sum, w) => sum + outcomeW(w, sc), 0);
  let outScale = s;
  for (const m of listed) for (const l of m.lines) {
    let sc = s;
    while (lineWidth(l.words, sc) > outW && sc > 0.6) sc -= 0.05;
    outScale = Math.min(outScale, sc);
  }

  /** The wordings a line is about: on one line when they fit at a readable size, on two when the line is tall enough, counted past that. */
  const wordingLines = (vs, width, size) => {
    const joined = vs.join(' · ');
    const floor = Math.round(size * 0.72);
    const one = fit(joined, size, width, true, floor);
    if (vs.length === 1 || textWidth(joined, one, true) <= width) return { lines: [joined], size: one };
    if (LINE_H >= 68) {
      for (let sz = size; sz >= floor; sz -= 1) {
        const ls = wrap(joined, sz, width, Infinity, true);
        if (ls.length <= 2 && ls.every((l) => textWidth(l, sz, true) <= width)) return { lines: ls, size: sz };
      }
    }
    const short = `${vs.length} wordings`;
    return { lines: [short], size: fit(short, size, width, true, 14) };
  };

  const block = (rows) => { const top = y; rect(pad, top, nameW - 18 * s, rows * LINE_H, COLORS.panel); return top; };
  const nameLine = (top, m) => {
    const mid0 = top + LINE_H / 2;
    const logo = logoFor(m.model);
    if (logo) parts.push(`<image x="${num(pad + 22 * s)}" y="${num(mid0 - logoS / 2)}" width="${num(logoS)}" height="${num(logoS)}" href="${logo}" opacity="0.9"/>`);
    text(pad + 22 * s + logoS + 12 * s, mid0 + nameSize / 3, m.name, { size: nameSize, weight: 700 });
    return mid0;
  };
  listed.forEach((m) => {
    const rows = Math.max(1, m.lines.length);
    const top = block(rows);
    const mid0 = nameLine(top, m);
    if (!m.lines.length) text(pad + nameW, mid0 + 8 * s, 'no matches', { size: 23 * s, fill: COLORS.muted });
    m.lines.forEach((l, li) => {
      const mid = top + li * LINE_H + LINE_H / 2;
      if (!single) {
        const wx = pad + nameW;
        const wording = wordingLines(l.variants, wordingW - 16 * s, WORDING_SIZE);
        if (wording.lines.length === 1) text(wx, mid + wording.size / 3, wording.lines[0], { size: wording.size, weight: 700, fill: COLORS.accent });
        else {
          const y1 = mid - wording.size * 0.2;
          text(wx, y1, wording.lines[0], { size: wording.size, weight: 700, fill: COLORS.accent });
          text(wx, y1 + wording.size * 1.15, wording.lines[1], { size: wording.size, weight: 700, fill: COLORS.accent });
        }
        text(wx + wordingW + arrowW / 2, mid + 9 * s, '→', { size: 28 * s, fill: COLORS.muted, anchor: 'middle' });
      }
      let x = outX;
      for (const w of l.words) x = outcome(x, mid, w, outScale);
    });
    y = top + rows * LINE_H + GROUP_GAP;
  });
  // The models folded away and the claims dropped, each counted off in a line of its own.
  if (folded.length) {
    const line = `${folded.length} more model${folded.length === 1 ? '' : 's'} with no matches: ${folded.map((m) => m.name).join(' · ')}`;
    text(pad, y + LINE_H / 2 + 8 * s, line, { size: fit(line, 23 * s, maxW, false, 14), fill: COLORS.muted });
    y += LINE_H + GROUP_GAP;
  }
  if (hiddenClaims) {
    const line = `${hiddenClaims} more claim${hiddenClaims === 1 ? '' : 's'} with lower rates`;
    text(pad, y + LINE_H / 2 + 8 * s, line, { size: 23 * s, fill: COLORS.muted });
    y += LINE_H + GROUP_GAP;
  }

  // ---- key: the things on a line, drawn as they appear, each with what it means ----
  // Drawn rather than described: a reader matches the sample chip to the chips above it without having to learn
  // that "red" means the chip. The threshold is stated in this run's own numbers, not as a formula.
  {
    const need = Math.max(MIN_REPLIES, Math.ceil(n * MIN_RATE));
    const ky = H - 104;
    const shown = Math.min(n, MAX_DOTS);
    const filled = Math.min(MIN_REPLIES, n);
    const rateSample = n ? pct(filled / n) : pct(0);
    const items = [
      {
        label: `a marked word the model ${VERB} for that wording`,
        width: (ks) => textWidth('“word”', ks * 0.85, true) + 20,
        draw: (x, mid, ks) => { const sz = ks * 0.85; const w = textWidth('“word”', sz, true) + 20; rect(x, mid - ks * 0.75, w, ks * 1.5, COLORS.red, { rx: 6 }); text(x + 10, mid + sz * CAP_H / 2, '“word”', { size: sz, weight: 700, fill: '#fff' }); },
      },
      {
        label: `the responses it appeared in, out of ${n}`,
        width: (ks) => shown * 14 + 4 + textWidth(rateSample, ks, true),
        draw: (x, mid, ks) => { let cx = x + 5; for (let i = 0; i < shown; i++) { if (i < filled) circle(cx, mid, 5, COLORS.text); else circle(cx, mid, 4, 'none', COLORS.muted); cx += 14; } text(cx + 4, mid + ks * CAP_H / 2, rateSample, { size: ks, weight: 700 }); },
      },
    ];
    if (listed.some((m) => !m.lines.length) || folded.length) {
      items.push({
        label: `no word in ${need} or more of ${n} responses`,
        width: (ks) => textWidth('no matches', ks, false),
        draw: (x, mid, ks) => text(x, mid + ks * CAP_H / 2, 'no matches', { size: ks, fill: COLORS.muted }),
      });
    }
    const gap = 14; const between = 48;
    const rowWidth = (ks) => items.reduce((sum, it) => sum + it.width(ks) + gap + textWidth(it.label, ks, false), 0) + between * (items.length - 1);
    let ks = 20;
    while (rowWidth(ks) > maxW && ks > 13) ks -= 1;
    let x = pad;
    for (const it of items) {
      it.draw(x, ky, ks);
      x += it.width(ks) + gap;
      // the label in a lighter tone than the muted sample beside it, so "no matches" and its meaning stay two things
      text(x, ky + ks * CAP_H / 2, it.label, { size: ks, fill: COLORS.text, opacity: 0.72 });
      x += textWidth(it.label, ks, false) + between;
    }
  }

  // ---- footer: where the run came from, and the share link ----
  const fy = H - 46;
  const meta = [runsLine(a), `id ${a.id}`].join(' · ');
  const urlSize = 26;
  text(W - pad, fy, shareUrl, { size: urlSize, font: MONO, anchor: 'end' });
  text(pad, fy, meta, { size: fit(meta, 20, maxW - textWidth(shareUrl, urlSize, false, true) - 40, false, 10, true), fill: COLORS.muted, font: MONO });
  parts.push('</svg>');
  return pinTextWidths(parts.join('\n'));
}
