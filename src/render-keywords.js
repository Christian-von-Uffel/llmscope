// Keyword card: which words the models used, which group they landed on, and which family said them most.
//
// It is the terminal's counts table, widened. Rows are the marked words. The left block is word × group and the
// right block is word × family, and both blocks are ordered by size, so reading left to right is reading a
// ranking rather than an alphabet: groups run from the one the words landed on hardest to the one they missed,
// and families from the one whose replies used the words most often to the one that used them least. That makes
// the leftmost family the one inserting the most of this wording, and puts the largest cell of the largest row
// in the top-left corner.
//
// Every cell carries its own number, because the point of the card is to be read rather than estimated. The bar
// under a family number and the bar behind a group number are the same measure — replies that used the word over
// replies asked — drawn against ceilings printed under the card.
import { COLORS, brandLine, runsLine } from './analyze.js';
import { esc, textWidth, wrap, fit, clamp, fillLastLine, promptBlock, TITLE, GROW_MAX } from './render.js';
import { prettyName, monthStamp, quoted } from './render-share.js';
import { keywordGrid } from './keyword-grid.js';
import { modelFamily } from './models.js';
import { logoFor } from './logos.js';
import { pinTextWidths, SANS, MONO, FONT_METRICS } from './text.js';

const pct = (x) => `${Math.round(x * 100)}%`;
/** Gaps are spelled out. "pp" saves four characters and costs the reader the sentence. */
const points = (x) => `${Math.round(x * 100)} point${Math.round(x * 100) === 1 ? '' : 's'}`;

/** Past this many words the rows are too thin to read; the rest are counted off under the grid. */
export const MAX_ROWS = 12;
/** Bars are drawn against a stated ceiling rather than always against 100%: a card where the highest rate is 29% */
/** would spend two thirds of its width on white space. The ceiling is printed under the card, so nothing is implied. */
const CEILINGS = [0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.75, 1];
export const ceilingFor = (max) => CEILINGS.find((c) => max <= c + 1e-9) ?? 1;
/** The light rule that marks where a bar ends, so its length is read off a luminance edge rather than a hue. */
export const CAP = COLORS.text;
const CAP_W = 5;
/** Letter-spacing on the line above the prompts. It is measured as well as drawn, or the line runs off the card. */
const TRACK = 3;

const ACRONYMS = /^(gpt|glm|grok|qwen|llama|deepseek|o\d+)$/i;
/** A family slug as a heading: “gpt” is GPT, “claude” is Claude. */
export function familyName(family) {
  const slug = String(family || '');
  if (!slug) return '?';
  return ACRONYMS.test(slug) ? slug.toUpperCase() : slug[0].toUpperCase() + slug.slice(1);
}

/**
 * What a keyword card counted, for the cards that state no finding: the setup, not the result. The lead names the
 * question rather than the method, because nobody opens the card wanting a count — they want to know whether a
 * word turns up more for one group than for another. It stays a question about where words appeared, never about
 * what a model chose: appearing in an output is all the run measured.
 */
export function keywordSetup(a, grid) {
  const n = grid.rows.length;
  const grouped = grid.variants.length > 1;
  return [
    grouped ? 'WHICH WORDS APPEAR FOR WHICH WORDING' : 'WHICH WORDS APPEAR, AND IN WHOSE OUTPUTS',
    // The word count survives because rows past MAX_ROWS are left off the card. The group count does not: the
    // lead already says the words are split by group, and every group is named across the top of its own column.
    `${n} ${n === 1 ? 'WORD' : 'WORDS'}`,
    `${grid.models.length} ${grid.models.length === 1 ? 'MODEL' : 'MODELS'}`,
    a.spec.prompts.length > 1 ? `${a.spec.prompts.length} PROMPTS` : null,
    a.summary.runs_per_cell > 1 ? `${a.summary.runs_per_cell} RUNS EACH` : null,
  ].filter(Boolean).join(' · ');
}

/**
 * The finding as a sentence. The headline is the model's performance — the family these words landed on hardest,
 * the one word that landed there hardest, and what the rest of the field did with that same word — because "which
 * model is doing this" is what a reader carries away. The gap between groups is what the card is arranged around,
 * so it keeps the line under the headline rather than the headline itself. Neither claim is dressed up: a gap too
 * small to flag says so, and the family line is a hit rate, not an accusation.
 */
export function keywordFinding(grid, names = {}) {
  const { rows, separating, variants, threshold, families } = grid;
  const n = rows.length;
  const words = (k) => `${k} ${k === 1 ? 'word' : 'words'}`;
  if (!rows.length) return { kicker: 'NO WORDS COUNTED', headline: 'Nothing was marked in these outputs' };

  // The family the words landed on hardest, and its own hardest word. Both numbers are cells a reader can find on
  // the card: the rate is printed in that family's column, not a figure computed only for the sentence.
  const top = families[0];
  const lead = top && top.rate > 0
    ? rows
      .map((row) => ({ row, cell: row.byFamily.find((f) => f.family === top.family) }))
      .filter((x) => x.cell && x.cell.n && x.cell.rate > 0)
      .sort((x, y) => y.cell.rate - x.cell.rate || y.cell.replies - x.cell.replies || x.row.label.localeCompare(y.row.label))[0]
    : null;
  const field = lead ? lead.row.byFamily.filter((f) => f.family !== top.family && f.n) : [];
  const mean = field.length ? field.reduce((s, f) => s + f.rate, 0) / field.length : 0;
  // "found in" rather than "used": a word appearing in an output is all the run measured. "Used" would put a
  // choice behind it that nothing here establishes, and that is the difference the card exists to not overstate.
  const headline = lead
    ? `${quoted(lead.row.label)} found in ${pct(lead.cell.rate)} of ${familyName(top.family)}’s outputs${field.length ? `, against ${pct(mean)} across the other ${field.length === 1 ? 'family' : `${field.length} families`}` : ''}`
    : 'None of these words was found in any output';

  if (variants.length < 2) {
    const used = rows.filter((r) => r.replies).length;
    // No groups to separate, so the second line is the field: what the same word did across every family.
    const overall = lead ? lead.row.byVariant.reduce((s, v) => s + v.replies, 0) / Math.max(1, lead.row.byVariant.reduce((s, v) => s + v.n, 0)) : 0;
    return {
      kicker: `KEYWORD USE · ${words(used)} OF ${n} FOUND`.toUpperCase(),
      headline,
      note: lead ? `Across all ${families.length} ${families.length === 1 ? 'family' : 'families'}, ${quoted(lead.row.label)} was found in ${pct(overall)} of outputs` : null,
    };
  }

  const widest = rows.filter((r) => r.delta).sort((x, y) => y.delta - x.delta)[0];
  if (!widest) {
    return {
      kicker: `KEYWORD DISPARITY · NO WORD OF ${n} SEPARATES THE WORDINGS BY ${points(threshold).toUpperCase()}`,
      headline,
      note: lead ? 'These words were found at the same rate for every wording' : null,
    };
  }
  const hi = widest.byVariant.find((v) => v.variant === widest.top);
  const lo = widest.byVariant.find((v) => v.variant === widest.low);
  const gap = `${quoted(widest.label)}: ${pct(hi.rate)} of outputs for ${quoted(hi.variant)} against ${pct(lo.rate)} for ${quoted(lo.variant)}`;
  return {
    kicker: separating.length
      ? `KEYWORD DISPARITY · ${words(separating.length)} OF ${n} SEPARATE THE WORDINGS`.toUpperCase()
      : `KEYWORD DISPARITY · NO WORD OF ${n} SEPARATES THE WORDINGS BY ${points(threshold).toUpperCase()}`,
    headline,
    note: `The widest gap between wordings is ${gap}`,
  };
}

/** How tall a word's row may get before the heading has to give way. Below this the bars stop being readable. */
export const MIN_ROW_H = 56;
/** A row label's leading, and a wording heading's, when either takes two lines. */
const LABEL_LEADING = 1.15;

/** `text` cut to `width` at `size`, bold, ending in an ellipsis when it had to be. */
function clipLine(text, size, width) {
  if (textWidth(text, size, true) <= width) return text;
  let kept = text;
  while (kept.length > 1 && textWidth(kept + '…', size, true) > width) kept = kept.slice(0, -1).trimEnd();
  return kept + '…';
}

/**
 * A marked word as its row's name. On one line at the row's own size, or a little under it; failing that on two
 * lines when the row is tall enough for them, at the largest size that keeps both inside the column; failing
 * that on one line at whatever size fits; and only past all of that cut with an ellipsis. Every line is measured
 * against the column, never trusted to it: the bars are drawn after the label and over anything that ran on —
 * which is how a long phrase used to come out as its first few words with a bar across the rest.
 */
export function labelLines(label, width, rowH, { captioned = false } = {}) {
  const top = clamp(19, rowH * 0.36, 34);
  const room = rowH - (captioned ? 34 : 12);
  const fits = (lines, s) => lines.every((l) => textWidth(l, s, true) <= width);
  const one = fit(label, top, width, true, Math.max(14, Math.round(top * 0.7)));
  if (fits([label], one)) return { size: one, lines: [label] };
  for (let s = top; s >= 14; s -= 1) {
    if (2 * s * LABEL_LEADING > room) break;
    const lines = wrap(label, s, width, Infinity, true);
    if (lines.length <= 2 && fits(lines, s)) return { size: s, lines };
  }
  const small = fit(label, top, width, true, 14);
  if (fits([label], small)) return { size: small, lines: [label] };
  const n = Math.max(1, Math.min(2, Math.floor(room / (14 * LABEL_LEADING))));
  return { size: 14, lines: wrap(label, 14, width, n, true).map((l) => clipLine(l, 14, width)) };
}

/** A wording heading's ceiling; the size it is kept at while the family columns can spare the width, which is the */
/** least a family name is set at; and its floor, past which a word is cut. */
const HEAD_MAX = 32;
const HEAD_WANT = 20;
const HEAD_MIN = 13;

/**
 * The narrowest measure `text` sets in at `size`, bold, on one line or two: its own width, or the wider half of
 * its best break between words. Never a break inside a word — a heading cut mid-word reads as a typo.
 */
function narrowest(text, size) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  let best = textWidth(words.join(' '), size, true);
  for (let k = 1; k < words.length; k += 1) {
    const w = Math.max(textWidth(words.slice(0, k).join(' '), size, true), textWidth(words.slice(k).join(' '), size, true));
    if (w < best) best = w;
  }
  return best;
}

/**
 * The wordings as the headings of their columns, all at one size so no wording looks like the one that mattered.
 * On one line at the heading size, or a little under it; failing that on two lines in the height the family logos
 * take above the name line, at the largest size that keeps every line inside its column and breaks no word;
 * failing that on one line at whatever size fits; and only past all of that cut with an ellipsis. Every line is
 * measured against the column, never trusted to it: a heading that was measured but never made to fit ran under
 * its neighbours, and four wordings read as one.
 *
 * @param {string[]} variants the wordings, in column order
 * @param {number} width the measure: a column less its padding
 * @param {number} room the height above the name baseline a second line may rise into
 * @returns {{size: number, lines: string[][]}} one list of lines per wording, the last of them on the name baseline
 */
export function headingLines(variants, width, room) {
  if (!variants.length) return { size: HEAD_MAX, lines: [] };
  const fits = (lines, s) => lines.every((l) => textWidth(l, s, true) <= width);
  const whole = (lines, v) => lines.join(' ') === v.trim().split(/\s+/).join(' '); // broken between words, not inside one
  const twoLines = (s) => s * LABEL_LEADING + s * FONT_METRICS.ascent <= room;
  const one = Math.min(...variants.map((v) => fit(v, HEAD_MAX, width, true, Math.round(HEAD_MAX * 0.7))));
  if (variants.every((v) => fits([v], one))) return { size: one, lines: variants.map((v) => [v]) };
  for (let s = HEAD_MAX; s >= HEAD_MIN; s -= 1) {
    if (!twoLines(s)) continue;
    const lines = variants.map((v) => (fits([v], s) ? [v] : wrap(v, s, width, Infinity, true)));
    if (lines.every((ls, i) => ls.length <= 2 && fits(ls, s) && whole(ls, variants[i]))) return { size: s, lines };
  }
  const small = Math.min(...variants.map((v) => fit(v, HEAD_MAX, width, true, HEAD_MIN)));
  if (variants.every((v) => fits([v], small))) return { size: small, lines: variants.map((v) => [v]) };
  const n = twoLines(HEAD_MIN) ? 2 : 1;
  return { size: HEAD_MIN, lines: variants.map((v) => wrap(v, HEAD_MIN, width, n, true).map((l) => clipLine(l, HEAD_MIN, width))) };
}

/**
 * @param {object} run the saved run, for the replies themselves
 * @param {object} a its analysis, for the prompt heading and the run metadata
 * @param {string[]} terms the words to count — the run's own keywords, or whatever it was told to mark
 * @param {'prompt'|'finding'} [opts.title] prompt (the default): every prompt the run sent is the heading and no
 *   finding is stated — the reader sees what was asked and reads the grid for what came back.
 *   finding: the family these words landed on hardest is the headline, with the widest group gap under it.
 */
export function renderKeywordCard(run, a, terms, { width = 1600, height = 1600, names = {}, url = null, date = null, results = run.results, title = 'prompt' } = {}) {
  const W = width; const H = height; const pad = 64;
  const grid = keywordGrid(run, terms, { results, familyOf: modelFamily });
  const shown = grid.rows.slice(0, MAX_ROWS);
  const hidden = grid.rows.length - shown.length;
  const lines = shown;
  const single = grid.variants.length < 2;
  const shareUrl = url || `${a.spec.share_base || ''}${a.id}`;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`, `<rect width="${W}" height="${H}" fill="${COLORS.bg}"/>`];
  const text = (x, y, str, { size = 24, weight = 400, fill = COLORS.text, font = SANS, anchor = 'start', opacity = 1, extra = '' } = {}) =>
    parts.push(`<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor}" font-family="${font}" font-size="${size}" font-weight="${weight}" fill="${fill}"${opacity < 1 ? ` opacity="${opacity}"` : ''} ${extra}>${esc(str)}</text>`);
  const rect = (x, y, w, h, fill, { rx = 6, opacity = 1 } = {}) =>
    parts.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(0, w).toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" rx="${rx}" fill="${fill}"${opacity < 1 ? ` opacity="${opacity}"` : ''}/>`);

  // ---- heading ----
  let y = pad + 22;
  const maxW = W - pad * 2;
  // The same brand line the share card carries, measured the same way: this image and that one come out of one
  // run, and a reader who meets either of them alone should be told what it measures.
  const stamp = `${monthStamp(date)}${a.mock ? ' · MOCK DATA' : ''}`;
  const brand = brandLine(a);
  const stampW = textWidth(stamp, 26, false, true) + 2 * stamp.length;
  text(pad, y, brand, { size: fit(brand, 26, maxW - stampW - 40, true, 15, true, 2), weight: 700, fill: COLORS.muted, font: MONO, extra: 'letter-spacing="2"' });
  text(W - pad, y, stamp, { size: 26, fill: a.mock ? COLORS.accent : COLORS.muted, font: MONO, anchor: 'end', extra: 'letter-spacing="2"' });

  const footerH = 100; // one line of metadata and the share link; the legend that used to sit above them is gone

  // ---- geometry: two blocks of columns, sharing the rows ----
  // Widths depend on the card and the words alone, so they are settled here, before the heading takes its height:
  // the family columns decide how large their logos and numbers are, and that decides how tall the header is.
  const gutter = 22;
  const G = Math.max(1, grid.variants.length);
  const F = Math.max(1, grid.families.length);
  // The words are the rows' names and are read first, so they are given their width first: what the longest
  // needs on one line at a row's reading size, out of what is left once the two blocks have their targets. A
  // card with one wording used to hand all of that spare width to its one bar, which then ran over the words.
  const want = G * 112 + F * 88;
  const labelBase = clamp(200, Math.round(maxW * 0.16), 260);
  const labelNeed = Math.max(0, ...lines.map((r) => textWidth(r.label, 28, true))) + 46;
  const spare = Math.max(0, maxW - gutter - labelBase - want);
  const labelW = Math.round(clamp(labelBase, labelNeed, labelBase + spare * 0.6));
  // The per-family cells are what the card is read for, so they take the width the words leave. A wording bar is
  // read as a length and needs only enough for its number, so it is held at one narrow target rather than fed
  // whatever is spare; the families grow with the rest, up to a column wide enough for a large logo and number.
  const room = maxW - labelW - gutter;
  const GROUP_W = 100;
  const FAM_MIN = 88;
  const FAM_MAX = 168;
  const shrink = Math.min(1, room / (G * GROUP_W + F * FAM_MIN));
  // A wording heads its column, and a column too narrow for its wording at a reading size grows to take it: out
  // of the gap between the blocks first, then out of the families, down to the least a family column may be.
  // Wider bars than the card wanted cost less than a heading nobody can read. Past what the families can spare,
  // the heading takes a second line, then a smaller size.
  const headNeed = single ? 0 : Math.ceil(Math.max(...grid.variants.map((v) => narrowest(v, HEAD_WANT))) + 10); // to the pixel, so no fit turns on rounding
  const groupW = clamp(GROUP_W * shrink, headNeed, Math.max(GROUP_W * shrink, (room - F * FAM_MIN) / G));
  const famW = Math.min(FAM_MAX, (room - groupW * G) / F);
  const varX = pad + labelW;
  // Whatever neither block takes widens the gap between them: the families stay on the right edge of the card.
  const famX = pad + maxW - famW * F;
  // Logo, family name and hit rate, all sized to the column so a card with fewer families is read from further away.
  const famLogo = Math.round(clamp(26, famW * 0.34, 52));
  const famName = clamp(20, famW * 0.19, 26);
  const famPct = clamp(25, famW * 0.28, 40);
  // The header is what those three stack to, over the rows, never less than the height the small card had.
  const headerH = Math.max(120, Math.round(38 + famPct * 1.15 + famName * 0.95 + famLogo + 12));
  const gridBottom = H - footerH;
  const rowGap = 10;
  // The grid is the card, so the heading may only use the height the words do not need.
  const gridMinH = headerH + lines.length * MIN_ROW_H + rowGap * (lines.length - 1);

  if (title === 'prompt') {
    // What was asked, and nothing about what came back. Every cell pools the run's prompts, so all of them are
    // quoted at one size: a card that showed the first alone would invite the reader to pin the numbers on it.
    y += 50;
    const setup = keywordSetup(a, grid);
    text(pad, y, setup, { size: fit(setup, 26, maxW, false, 15, true, TRACK), fill: COLORS.muted, font: MONO, extra: `letter-spacing="${TRACK}"` });
    const availableH = Math.max(TITLE.floorSize * TITLE.lineHeight, Math.min(H * 0.32, gridBottom - (y + 24) - 42 - gridMinH));
    const block = promptBlock(a.title.prompts, {
      x: pad, y: y + 24, maxWidth: maxW, maxHeight: availableH, preferredHeight: Math.min(H * 0.24, availableH),
      slots: a.title.slots, maxSize: TITLE.maxSize * GROW_MAX,
    });
    parts.push(...block.svg);
    y = block.bottom + 42;
  } else {
    const finding = keywordFinding(grid, names);
    y += 50;
    text(pad, y, finding.kicker, { size: fit(finding.kicker, 26, maxW, false, 15, true, TRACK), fill: COLORS.muted, font: MONO, extra: `letter-spacing="${TRACK}"` });
    let hs = 58;
    let head;
    for (;;) { head = wrap(finding.headline, hs, maxW, Infinity); if (head.length <= 3 || hs <= 36) break; hs -= 2; }
    // A headline that ends on one stranded word reads as a mistake; the measure gives way rather than the size.
    head = fillLastLine(finding.headline, hs, maxW, head);
    y += 24;
    for (const l of head) { y += hs * 1.1; text(pad, y, l, { size: hs, weight: 700 }); }
    if (finding.note) { y += 40; text(pad, y, finding.note, { size: fit(finding.note, 27, maxW, false, 18), fill: COLORS.accent }); }
    // The finding already took the top of the card, so the prompts are quoted small under it and any that do not
    // fit are counted off. The prompt-title card is the one that shows them all.
    const promptQuote = `“${a.title.prompt}”`;
    const ps = 25;
    y += 18;
    for (const l of wrap(promptQuote, ps, maxW, 2, false)) { y += ps * 1.25; text(pad, y, l, { size: ps, fill: COLORS.muted }); }
    if (a.title.more) { y += ps * 1.25; text(pad, y, a.title.more, { size: ps, fill: COLORS.muted }); }
    y += 42;
  }

  // ---- rows: the height the heading left ----
  const gridTop = y;
  const available = gridBottom - gridTop - headerH - rowGap * (lines.length - 1);
  const rowH = clamp(MIN_ROW_H, available / Math.max(1, lines.length), 150);
  const slack = Math.max(0, available - rowH * lines.length);
  const blockTop = gridTop + slack / 2;

  const barCeil = ceilingFor(Math.max(0, ...lines.flatMap((r) => r.byVariant.filter((v) => v.n).map((v) => v.rate))));
  const famCeil = ceilingFor(Math.max(0, ...lines.flatMap((r) => r.byFamily.filter((f) => f.n).map((f) => f.rate))));

  // ---- column headings ----
  // Stacked up from the first row: the hit rate nearest the cells it sums, the name over it, the logo on top.
  const rowsTop = blockTop + headerH;
  const pctBase = rowsTop - 38;
  const nameBase = pctBase - famPct * 1.15;
  const logoTop = nameBase - famName * 0.95 - famLogo;
  // Every heading line is measured against its own column, never the column plus its gutter, and a wording too
  // long for one line takes two, up into the height the logos have beside it. The last line keeps the family
  // names' baseline, so both kinds of heading are read along one line.
  if (!single) {
    const head = headingLines(grid.variants, groupW - 10, nameBase - blockTop);
    grid.variants.forEach((v, i) => {
      const ls = head.lines[i];
      ls.forEach((l, j) => text(varX + i * groupW + groupW / 2, nameBase - (ls.length - 1 - j) * head.size * LABEL_LEADING, l, { size: head.size, weight: 700, fill: COLORS.accent, anchor: 'middle' }));
    });
  }

  // Each family heads its own column with its logo, its name, its hit rate over every word, and its own gap.
  const famLabel = (f) => `${familyName(f.family)}${f.models.length > 1 ? ` ×${f.models.length}` : ''}`;
  const famSize = Math.min(...grid.families.map((f) => fit(famLabel(f), famName, famW - 8, true, 12)));
  grid.families.forEach((f, i) => {
    const cx = famX + i * famW + famW / 2;
    const logo = logoFor(f.models[0]);
    if (logo) parts.push(`<image x="${(cx - famLogo / 2).toFixed(1)}" y="${logoTop.toFixed(1)}" width="${famLogo}" height="${famLogo}" href="${logo}" opacity="0.9"/>`);
    text(cx, nameBase, famLabel(f), { size: famSize, weight: 700, anchor: 'middle' });
    text(cx, pctBase, pct(f.rate), { size: fit(pct(f.rate), famPct, famW - 8, true, 14), weight: 700, fill: COLORS.accent, anchor: 'middle' });
  });
  // ---- rows ----
  lines.forEach((row, ri) => {
    const ry = blockTop + headerH + ri * (rowH + rowGap);
    const mid = ry + rowH / 2;
    const flagged = row.delta != null && row.delta >= grid.threshold - 1e-9;
    rect(pad, ry, labelW - 14, rowH, COLORS.panel);
    if (flagged) rect(pad, ry, 10, rowH, COLORS.accent, { rx: 3 });
    const caption = row.delta && !single
      ? `most in ${row.tops.slice(0, 2).join(' and ')}${row.tops.length > 2 ? ` +${row.tops.length - 2}` : ''}`
      : null;
    const label = labelLines(row.label, labelW - 46, rowH, { captioned: Boolean(caption) });
    const lh = label.size * LABEL_LEADING;
    // One line sits on the row's centre, or just above its caption; a second stacks up from that baseline.
    const lastBase = caption ? mid - 4 : mid + label.size / 3 + ((label.lines.length - 1) * lh) / 2;
    label.lines.forEach((l, i) => text(pad + 22, lastBase - (label.lines.length - 1 - i) * lh, l, { size: label.size, weight: 700 }));
    if (caption) text(pad + 22, mid + 24, caption, { size: fit(caption, 18, labelW - 40, false, 12), fill: COLORS.muted });

    // left block: one bar per group, all against one ceiling, each carrying its number
    const barH = Math.min(rowH - 26, 52);
    row.byVariant.forEach((v, ci) => {
      const cx = varX + ci * groupW;
      const inner = groupW - 12;
      rect(cx, mid - barH / 2, inner, barH, COLORS.gray, { opacity: 0.45 });
      const drawn = v.n && v.rate > 0;
      const len = drawn ? Math.max(4, inner * Math.min(1, v.rate / barCeil)) : 0;
      if (drawn) {
        rect(cx, mid - barH / 2, len, barH, COLORS.red);
        // The bar's end is the reading, and red against its own track is 1.8:1 for a protanope — too close to
        // read a length off. A light cap puts the datum on a luminance edge, which every kind of color vision keeps.
        rect(cx + len - CAP_W, mid - barH / 2, CAP_W, barH, CAP, { rx: 2 });
      }
      const label = v.n ? pct(v.rate) : '—';
      const size = fit(label, clamp(19, barH * 0.5, 32), inner - 20, true, 13);
      const tw = textWidth(label, size, true);
      if (!drawn) text(cx + 12, mid + size / 3, label, { size, weight: 700, fill: COLORS.muted });
      else if (len - CAP_W - 16 >= tw) text(cx + len - CAP_W - 9, mid + size / 3, label, { size, weight: 700, fill: '#fff', anchor: 'end' });
      else if (len + 10 + tw <= inner) text(cx + len + 10, mid + size / 3, label, { size, weight: 700 });
      else {
        // A mid-length bar in a narrow column: the number fits neither inside it nor beside it at the row's size.
        // Beside at a smaller size when that fits; failing that, centred on the cell over bar and track alike,
        // with a halo of the background so the cap and the bar's edge never cut through it. Never anchored to the
        // bar's end and left to spill: that put one cell's number on top of its neighbour's.
        const beside = fit(label, size, inner - len - 10, true, 13);
        if (len + 10 + textWidth(label, beside, true) <= inner) text(cx + len + 10, mid + beside / 3, label, { size: beside, weight: 700 });
        else {
          const centred = fit(label, size, inner - 8, true, 13);
          text(cx + inner / 2, mid + centred / 3, label, { size: centred, weight: 700, fill: '#fff', anchor: 'middle', extra: `paint-order="stroke" stroke="${COLORS.bg}" stroke-width="4" stroke-linejoin="round"` });
        }
      }
    });

    // right block: the same measure per family, as a number over a rule. Nothing rings the largest cell of a row:
    // both blocks already descend from the left, so the eye finds the top of a row by reading it, not by hunting
    // for a marked cell.
    row.byFamily.forEach((f, ci) => {
      const cx = famX + ci * famW;
      const inner = famW - 10;
      const label = f.n ? pct(f.rate) : '—';
      // As large as the column allows and the row can hold: these numbers are the reading the card exists for.
      const size = fit(label, clamp(18, Math.min(famW * 0.28, rowH * 0.42), 40), inner - 8, true, 12);
      const ruleH = clamp(7, famW * 0.07, 11);
      text(cx + inner / 2, mid + size / 3 - 6, label, { size, weight: 700, fill: f.rate > 0 ? COLORS.text : COLORS.muted, anchor: 'middle' });
      const ruleY = mid + barH / 2 - ruleH - 2;
      rect(cx + 4, ruleY, inner - 8, ruleH, COLORS.gray, { rx: 3, opacity: 0.5 });
      if (f.n && f.rate > 0) rect(cx + 4, ruleY, Math.max(5, (inner - 8) * Math.min(1, f.rate / famCeil)), ruleH, COLORS.red, { rx: 3 });
    });

  });

  // ---- footer ----
  // No key. A red bar with its own percentage printed on it, under a column headed by a group name, is already
  // the sentence a legend would have spelled out — and the line it took cost the grid fifty pixels of row height.
  // What stays is what a reader cannot deduce from the drawing: the scales, and where the run came from.
  const fy = H - 46;
  const meta = [
    `wording bars to ${pct(barCeil)}`,
    `family bars to ${pct(famCeil)}`,
    // The heading number and the cells under it count different things, so the card says which is which.
    `family % is its outputs containing any ${grid.rows.length > 1 ? 'of the words' : 'word'}; cells are per word`,
    hidden ? `${hidden} more word${hidden > 1 ? 's' : ''} with smaller gaps` : null,
    runsLine(a),
    `id ${a.id}`,
  ].filter(Boolean).join(' · ');
  const urlSize = 26;
  text(W - pad, fy, shareUrl, { size: urlSize, font: MONO, anchor: 'end' });
  // The metadata gives way to the share link rather than running under it.
  text(pad, fy, meta, { size: fit(meta, 20, maxW - textWidth(shareUrl, urlSize, false, true) - 40, false, 10, true), fill: COLORS.muted, font: MONO });
  parts.push('</svg>');
  return pinTextWidths(parts.join('\n'));
}
