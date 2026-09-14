// Responses sheet: every reply on ONE square image, measured with pretext so the text is sized exactly.
// Columns are a fixed quarter of the image (1024px at 4K) so a zoomed reader never scrolls across the page; the
// text size then clamps, up or down, to the largest size at which everything fits, the columns are balanced and
// the leading is opened just enough for the text to reach the bottom of the page. The prompt takes the fewest lines
// that keep it at 8-12 words a line and is sized, measured by pretext, to fill them; the legend's model names and
// outcome row grow to fill the width beside the URL, and the URL is one column wide.
// Replies come in a batch per group by default — the comparison the eval was written to make — each batch headed
// by the group's name in amber, and each model introduced where it comes up by its provider's mark and its name
// in that model's own colour, because a batch holds every model at once. `--sort model` batches by model instead, one
// model straight through, where the legend is the only place the name is needed. Either way the legend at the
// bottom is the colour key, and every reply starts with a badge as tall as the text line — a green tick, a red
// cross, an amber warning triangle or a grey dash — so the outcome reads without colour as well as with it; a
// reply the max reply length cut off shows everything it managed to say and ends in an ellipsis. Nothing is
// paginated or trimmed.
// Keyword matches are marked where they happen: every run of text a keyword matched sits on an amber block,
// so a reader sees the word itself, not just that the reply counted. A keyword eval marks its own keywords;
// `--highlight` marks any terms you name, which is how a refusal eval gets to point at a word a model used.
import { prepareRichInline, walkRichInlineLineRanges, materializeRichInlineLineRange } from '@chenglou/pretext/rich-inline';
import { COLORS, analyze, brandLine, keywordPhrase, outcomeOf } from './analyze.js';
import { findKeywordSpans, stripPattern } from './checks/keywords.js';
import { sentences, sentenceBatches, refusalBatches, SENTENCE_SORTS } from './sentences.js';
import { refusalSpans } from './checks/refusal.js';
import { esc, wrap, fitTitleBlock, readableLines, shortModel, GROW_MAX, titleLine } from './render.js';
import { logoBody, providerOf } from './logos.js';
import { modelColors, contrast } from './palette.js';
import { font, measureWidth, pinTextWidths, textReady, SANS, MONO, FONT_METRICS } from './text.js';


// The outcome badge before each reply, and each legend swatch, spans the text line's box: ascent to descent at the
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

// A keyword match is marked like a marker pen: the matched run sits on an amber block with dark text on it, the
// same amber that means "keyword" everywhere else on the sheet. Marking is presentation only — it never moves a
// verdict, so `--highlight` can be pointed at any word after the fact without changing what the run measured.
// Each model's run of replies in a group batch is introduced: the provider's mark, then the model, both in that
// model's colour, so a reader can tell whose answers they are reading without counting back to the legend. The
// mark is defined once in <defs> and drawn with <use>, which keeps a page from carrying a copy of the same
// artwork per reply, and lets each one take the colour of the model it belongs to.
const LOGO_VIEWBOX = 24; // every mark in logos.js is drawn on a 24×24 grid
function logoDefs(models) {
  const bodies = new Map();
  for (const model of models) {
    const provider = providerOf(model);
    const body = logoBody(model);
    if (body && !bodies.has(provider)) bodies.set(provider, body);
  }
  return bodies.size ? `<defs>${[...bodies].map(([provider, body]) => `<g id="logo-${esc(provider)}" fill-rule="evenodd">${body}</g>`).join('')}</defs>` : '';
}

/** The provider's mark on the text line's box, in the model's colour — or that colour as a plain square, unmarked. */
function logoMark(x, baseline, size, model, color) {
  if (!logoBody(model)) return iconRect(x, baseline, size, color);
  const id = `logo-${esc(providerOf(model))}`;
  const scale = iconSide(size) / LOGO_VIEWBOX;
  const top = baseline - size * FONT_METRICS.ascent;
  return `<use href="#${id}" xlink:href="#${id}" fill="${color}" transform="translate(${x.toFixed(1)} ${top.toFixed(1)}) scale(${scale.toFixed(4)})"/>`;
}

/**
 * How a match is drawn — candidates for the page's visual hierarchy, which should run prompt, then wording, then
 * model, then the match: findable while reading, not the first thing the eye lands on.
 *
 * `block` is the marker pen the responses sheet has always used: amber behind dark text. It is the loudest thing
 * on the page, which makes it a poor fourth rank.
 * `model` blocks the run in the model's own colour with black or white on it, whichever the contrast favours, so
 * the mark reinforces whose sentence it is instead of competing with the wording above it.
 * `tint` is that block turned down to a wash, the text left as it was: the shape is still findable, the page is
 * not a field of blocks.
 * `rule` underlines the run in the model's colour and leaves the text alone — the quietest mark that is still a
 * mark.
 * `invert` drops the block and makes the amber the ink.
 * `wash` keeps the amber but turns it down to a wash of the page and leaves the text in the colour it was
 * already set in, so a match is found by reading the line rather than by spotting a badge from across the page.
 * The block is also drawn tighter than `block` draws it: highlighter, not label.
 * `underline` is the amber as a rule under the run and nothing behind it. A wash sits at under 2:1 against the
 * page, which is a weak thing to hang the only cue on; a rule in full amber is a luminance edge, so it survives
 * grayscale, a bad projector and every kind of colour blindness while taking none of the reader's attention.
 * `wash-rule` is both: the wash to find while reading, the rule to find without reading.
 */
export const MARK_STYLES = {
  block: 'on an amber block',
  wash: 'on a wash of amber',
  underline: 'underlined in amber',
  'wash-rule': 'on a wash of amber, underlined in it',
  model: "on a block of the model's colour",
  tint: "on a wash of the model's colour",
  rule: "underlined in the model's colour",
  invert: 'in amber, on the page',
};

/** Black or white on `hex`, whichever the eye separates further. The model palette is light, so this is usually black. */
const inkOn = (hex) => (contrast(hex, '#000000') >= contrast(hex, '#ffffff') ? '#000000' : '#ffffff');

/**
 * The page's type scale, as multiples of the body size the fit engine lands on.
 *
 * Reading order here is meant to run prompt, then the wording, then the model, then the sentences with their
 * matches in them — and weight and colour cannot carry four ranks. Bold is already the model's, amber is already
 * the match's, and neither says which comes first. Size does, it says it at a glance, and it survives being read
 * in grayscale or at thumbnail size. Everything is measured before it is drawn, so a scale costs nothing but the
 * room it takes: the body simply lands smaller when the headings take more.
 */
/**
 * The page's type scale, as multiples of the body size the fit engine lands on: the wording over the model name
 * over the sentences.
 *
 * Four ranks cannot be carried by weight and colour. Bold is already the model's and amber is already the
 * match's, and neither says which comes first, so size says it — at a glance, and still at thumbnail size or in
 * grayscale. The scale costs the page its independence from the prompt: the body is capped against the prompt's
 * own size so a wording can never come up level with the question, and the prompt is grown to buy the room back.
 * Set both to 1 to flatten the page again, which is how the responses sheet sets its own.
 */
const HEADING_SCALE = 1.45;
const NAME_SCALE = 1.12;
/** When a scale is asked for, what bounds it: the body's share of the prompt, and the heading's. */
const BODY_OF_PROMPT = 0.42;
const HEADING_OF_PROMPT = 0.62;
/** And the name stays under the heading, however the two are arrived at. */
const NAME_OF_HEADING = 0.85;
const TINT_OPACITY = 0.3;
/** `hex` mixed `amount` of the way into `onto`, as a solid colour. A wash drawn as one fill rather than as a layer. */
function mix(hex, onto, amount) {
  const ch = (h, i) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  return '#' + [0, 1, 2].map((i) => Math.round(ch(onto, i) + (ch(hex, i) - ch(onto, i)) * amount).toString(16).padStart(2, '0')).join('');
}

export const MARK_BG = COLORS.accent;
export const MARK_TEXT = COLORS.bg;
const MARK_PAD = 0.1; // ems of amber either side of the run, so it reads as a highlight rather than a tight box
/** The wash: the same amber, mixed most of the way into the page, with the run set tight so it reads as ink. */
const WASH_AMOUNT = 0.26;
const WASH_PAD = 0.04;
export const MARK_WASH = mix(MARK_BG, COLORS.bg, WASH_AMOUNT);
function markRect(x, baseline, size, width, color = MARK_BG, opacity = 1, padEm = MARK_PAD) {
  const pad = size * padEm;
  const height = iconSide(size);
  // A tight block is a highlighter stroke and a loose one is a label, so the corner follows the padding.
  const rx = height * (padEm >= MARK_PAD ? 0.15 : 0.08);
  return `<rect x="${(x - pad).toFixed(1)}" y="${(baseline - size * FONT_METRICS.ascent).toFixed(1)}" width="${(width + pad * 2).toFixed(1)}" height="${height.toFixed(1)}" rx="${rx.toFixed(1)}" fill="${color}"${opacity < 1 ? ` opacity="${opacity}"` : ''}/>`;
}

/** The quiet form of the same mark: a rule under the run, a little below the baseline, at the run's own width. */
const UNDERLINE = 0.09; // of the text size
function underlineRect(x, baseline, size, width, color) {
  const thick = Math.max(1, size * UNDERLINE);
  return `<rect x="${x.toFixed(1)}" y="${(baseline + size * 0.16).toFixed(1)}" width="${width.toFixed(1)}" height="${thick.toFixed(1)}" rx="${(thick / 2).toFixed(1)}" fill="${color}"/>`;
}

/**
 * The badge before every reply. Colour alone cannot carry an outcome: the two that matter most, answered and
 * refused, are the pair red-green colour blindness collapses — about one man in twelve sees them as the same
 * olive. So each badge also carries the mark everyone already knows from every phone and road sign: a tick, a
 * cross, a warning triangle with its exclamation, a dash for nothing-came-back. The mark is drawn, not typed,
 * because the PNG fonts have no emoji (see collapseEmoji) — and drawn, it stays sharp at any size. The box and
 * the advance are the plain swatch's, so nothing about the layout moves.
 */
// Two of the badge colours are the card's, and two are the card's colours lifted: a badge is a small graphical
// object, which WCAG asks to stand 3:1 clear of what is behind it, and the card's grey (1.8:1 for everyone) and
// red (2.2:1 for a protanope, to whom deep red reads dark) did not. The card keeps its own, where the same hues
// are large fills behind text rather than a mark the size of a letter.
// Refusal first, as on the card: the legend opens with the outcome the image is read for.
export const BADGES = {
  refused: { color: '#d6483f', label: 'refused' },
  answered: { color: COLORS.green, label: 'answered' },
  matched: { color: COLORS.amber, label: 'included keywords' },
  error: { color: '#6b7280', label: 'error or cut off' },
};
const MARK_STROKE = 0.15; // of the badge's side

function badgeMark(x, y, side, kind) {
  const at = (v, base) => (base + side * v).toFixed(1);
  const stroke = (side * MARK_STROKE).toFixed(1);
  const ink = kind === 'matched' ? COLORS.bg : '#ffffff'; // a warning sign is dark on amber, and reads better for it
  const line = (d) => `<path d="${d}" fill="none" stroke="${ink}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/>`;
  if (kind === 'answered') return line(`M${at(0.24, x)} ${at(0.53, y)}L${at(0.42, x)} ${at(0.72, y)}L${at(0.77, x)} ${at(0.30, y)}`);
  if (kind === 'refused') return line(`M${at(0.30, x)} ${at(0.30, y)}L${at(0.70, x)} ${at(0.70, y)}M${at(0.70, x)} ${at(0.30, y)}L${at(0.30, x)} ${at(0.70, y)}`);
  if (kind === 'error') return line(`M${at(0.27, x)} ${at(0.50, y)}L${at(0.73, x)} ${at(0.50, y)}`);
  // the exclamation sits in the wide lower half of the triangle
  return line(`M${at(0.5, x)} ${at(0.40, y)}L${at(0.5, x)} ${at(0.64, y)}`)
    + `<circle cx="${at(0.5, x)}" cy="${at(0.79, y)}" r="${(side * MARK_STROKE * 0.6).toFixed(1)}" fill="${ink}"/>`;
}

/** One outcome badge: a rounded square, or the warning triangle for a reply that included the keywords. */
function badge(x, baseline, size, kind) {
  const side = iconSide(size);
  const y = baseline - size * FONT_METRICS.ascent;
  const { color } = BADGES[kind] || BADGES.error;
  const shape = kind === 'matched'
    ? `<path d="M${(x + side / 2).toFixed(1)} ${y.toFixed(1)}L${(x + side).toFixed(1)} ${(y + side).toFixed(1)}L${x.toFixed(1)} ${(y + side).toFixed(1)}Z" fill="${color}"/>`
    : iconRect(x, baseline, size, color);
  return shape + badgeMark(x, y, side, kind);
}

export const SELECTIONS = {
  all: 'every reply',
  'per-cell': 'one reply per model × wording (the first run)',
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

/**
 * A sentence with its markdown taken off: the hashes of a heading, the asterisks of a bold run, the bullet or
 * number that opens a list item. The models answer in markdown and this page is not a markdown renderer, so the
 * marks arrive as literal text — "### 1. **Origin of the Myth**" — and read as noise around the words the page
 * is about. Only the marks go; the words, their order and their spacing are the reply's own.
 */
export function stripMarkup(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/^#{1,6}\s+/, '')
    .replace(/^(?:[-*+•]|\d+[.)])\s+/, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cmpRank(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/**
 * How the replies are batched. The eval compares groups, so by default the page does too: one batch per group,
 * every model's answer to that wording together, which is the comparison a reader came to make. Sorting by model
 * instead reads one model straight through, which is the way to see how a single model behaves across wordings.
 */
export const SORTS = {
  group: 'in a batch per group, every model together',
  model: 'in a batch per model, every group together',
};

/** Pick and order responses in card order (by group, or by model; models by effect size, then run). */
export function selectResponses(run, select = 'all', sort = 'group') {
  const analysis = analyze(run);
  const modelOrder = analysis.rows.map((r) => r.model);
  const variantOrder = analysis.variants.map((v) => v.key);
  const rank = sort === 'model'
    ? (r) => [modelOrder.indexOf(r.model), variantOrder.indexOf(r.variantKey), r.promptIndex, r.run]
    : (r) => [variantOrder.indexOf(r.variantKey), modelOrder.indexOf(r.model), r.promptIndex, r.run];
  let responses = [...run.results].sort((x, y) => cmpRank(rank(x), rank(y)));
  if (select === 'per-cell') {
    const seen = new Set();
    responses = responses.filter((r) => { const k = `${r.model}|${r.variantKey}`; if (seen.has(k)) return false; seen.add(k); return true; });
  } else if (select === 'refused') responses = responses.filter((r) => r.refused);
  else if (select === 'matched') responses = responses.filter((r) => r.matched);
  return { analysis, responses };
}

const shortError = (e) => { const t = String(e).split(/;|—/)[0].trim(); return t.length <= 110 ? t : t.slice(0, 110).replace(/\s+\S*$/, '') + '…'; };

// ---------- links ----------
// The sheet is one very large image, and the thing a reader wants next is nearly always "show me that model".
// SVG can do that on its own: a <view> names a rectangle of the page, and a link to it moves the viewport there.
// So the legend's model names become jumps into that model's replies, the background is a jump back out to the
// whole page, and the URL opens the eval. This is browser behaviour only — an SVG placed in an <img>, and every
// PNG made from this file, ignores links and views entirely, which is why nothing drawn here depends on them.
const VIEW_ALL = 'sheet';

/** A link around already-drawn SVG. `title` is the hover text; an outside link opens in its own tab. */
function link(href, body, title = null, external = false) {
  const target = external ? ' target="_blank" rel="noopener"' : '';
  return `<a href="${esc(href)}" xlink:href="${esc(href)}"${target}>${title ? `<title>${esc(title)}</title>` : ''}${body}</a>`;
}

/**
 * The eval's URL as something clickable, or null when there is nothing to click: a run whose share base is empty
 * shows its bare id, and an id is not an address. A base with no scheme (the default `llmscope.dev/`) is https.
 */
export function linkUrl(url) {
  const s = String(url || '').trim();
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[\w-]+(\.[\w-]+)+(\/|$)/.test(s)) return `https://${s}`;
  return null;
}

/**
 * Every id the sheet's links use, resolved together so a group and a model can never claim the same one, and
 * readable enough to hand out: `sheet.svg#white` is the white batch, `sheet.svg#gpt-4o` is where that model
 * first speaks. Derived from the analysis alone, so the layout and the drawing always agree on them.
 */
const idCache = new WeakMap();
function sheetIds(a) {
  if (idCache.has(a)) return idCache.get(a);
  const used = new Set([VIEW_ALL]);
  // An id must start with a letter, and a group that names nothing (a run with one wording) has no name to slug:
  // both fall back to the word for what the id points at, so every view has a readable id whatever it is called.
  const take = (name, kind) => {
    let base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!base) base = kind;
    else if (!/^[a-z]/.test(base)) base = `${kind}-${base}`;
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    return id;
  };
  const ids = {
    models: new Map(a.rows.map((r) => [r.model, take(shortModel(r.model), 'model')])),
    groups: new Map(a.variants.map((v) => [v.key, take(v.label, 'group')])),
  };
  idCache.set(a, ids);
  return ids;
}
const groupId = (variantKey, a) => sheetIds(a).groups.get(variantKey);

/**
 * A screenful of the page at the point something starts: one column wide, four to three, and never reaching past
 * the columns, so the header and the legend stay out of the jump. One rule for a model and for a group, because
 * both are answering the same question — take me to where this begins, at a size I can read.
 */
function viewBoxAt({ col, y }, g, size) {
  const margin = g.gap / 2;
  const x = Math.max(0, g.pad + col * (g.colW + g.gap) - margin);
  const w = Math.min(size - x, g.colW + margin * 2);
  const h = Math.min(g.colH + margin * 2, w * 0.75);
  const top = Math.max(0, Math.min(g.colTop + y - margin, g.colTop + g.colH + margin - h));
  return `${x.toFixed(1)} ${top.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}`;
}

/** Fixed column width: a quarter of the image (1024px at 4K), so one column fits a zoomed phone screen. */
export function columnsFor(size, columnWidth = 1024) {
  return Math.max(1, Math.round(size / columnWidth));
}

// A column only earns its place once it has room for a readable line. Twelve words is the floor: below it the
// text reads as a ransom note, one or two words a line, however much page is left over. So the column count
// follows the text size rather than the image width — big text on a short run gets one wide column, small text
// on a long run gets many.
export const WORDS_PER_COLUMN = 12;
const WORD_SAMPLE = 'the model said it would not answer that question about this ';
/** Width of WORDS_PER_COLUMN average words at font size 1, measured against the real font rather than guessed. */
function columnUnit() {
  const words = WORD_SAMPLE.trim().split(/\s+/).length;
  return (measureWidth(WORD_SAMPLE, font(100)) / 100 / words) * WORDS_PER_COLUMN;
}

/**
 * The gutter between columns: an em and a half of the body text, opened toward 1.2% of the page so that columns
 * still read apart when the whole sheet is on screen at once — but never wider than three ems. Past that it stops
 * being a gutter and becomes a margin: on a page of 8px text the page-relative floor alone came to five ems and
 * ate a sixth of every column it was there to separate.
 */
export function columnGap(size, f) {
  return Math.min(Math.max(f * 1.5, size * 0.012), f * 3);
}

/** How many columns fit at this text size, counting the gaps between them. Never fewer than one. */
export function columnsForFont(size, f) {
  const pad = Math.round(size * 0.03);
  const usable = size - pad * 2;
  const want = columnUnit() * f;
  const gap = columnGap(size, f);
  let n = Math.max(1, Math.floor(usable / want));
  while (n > 1 && (usable - gap * (n - 1)) / n < want) n -= 1;
  return n;
}

/** The largest text size at which one column still holds WORDS_PER_COLUMN words: the sheet's natural size cap. */
export function maxFontFor(size) {
  return (size - Math.round(size * 0.03) * 2) / columnUnit();
}

/** Rough text capacity of one image at a given text size (for documentation; the layout itself measures). */
export function estimateCapacity({ size = 4096, font: f = 28, columns = null } = {}) {
  const pad = Math.round(size * 0.03);
  const cols = columns || columnsForFont(size, f);
  const gap = columnGap(size, f);
  const colW = (size - pad * 2 - gap * (cols - 1)) / cols;
  const colH = size - pad * 2 - size * 0.1 - size * 0.08;
  const charsPerLine = Math.floor(colW / (0.5 * f));
  const linesPerCol = Math.floor(colH / (f * 1.32));
  const chars = Math.round(charsPerLine * linesPerCol * cols * 0.92);
  return { size, font: f, columns: cols, charsPerLine, linesPerCol, chars, tokens: Math.round(chars / 4), words: Math.round(chars / 5.5) };
}

// ---------- header and legend (sized by the image, not by the body text) ----------
/** The leading the prompt is set with, and so the height of one of its lines. */
const TITLE_LEADING = 1.12;

/** The brand line's size on a sheet: the share of the image the cards give theirs (26px on 1600), so the three images read as one set. */
export const BRAND_SCALE = 1 / 60;

function header(a, size, { extraLines = 0, gapLines = 0 } = {}) {
  const pad = Math.round(size * 0.03);
  // Sized to the image like the cards' brand line, not to the body text: at 1/150 it was a footnote on a 4096px page.
  const headFont = size * BRAND_SCALE;
  const quoted = a.title.prompt ? `“${a.title.prompt}”` : '';
  const width = size - pad * 2;
  const maxHeight = size * 0.16;
  // The prompt's measure decides how many lines it takes (8-12 words each); pretext then sizes it to fill them.
  // `extraLines` lets it take a narrower measure than that and so be set larger — which the sentences page asks
  // for when its own text would otherwise come up level with the question.
  const block = fitTitleBlock(quoted, width, { maxHeight, maxSize: (size / 45) * GROW_MAX, minSize: size / 150, maxLines: readableLines(quoted) + extraLines });
  // Enough to clear the descenders of a title that may be much larger than headFont, and never less than
  // `gapLines` lines of the prompt's own leading: the question and the page under it are two things, and a page
  // that starts a line after the prompt ends reads as its continuation.
  const titleGap = Math.max(headFont * 1.8 + block.size * 0.15, block.size * TITLE_LEADING * gapLines);
  const height = Math.round(headFont + block.lines.length * block.size * TITLE_LEADING + titleGap);
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

const OUTCOMES = Object.entries(BADGES).map(([kind, b]) => [b.label, kind]);
// No "■ = outcome" clause: the outcome row to the note's left shows each badge beside its own name.
// The note earns its width or it goes. "Text color = model" and "group names amber" restated what the legend
// already shows in color right beside them, and crowded out the two things a reader cannot deduce: what the
// amber marks are, and whether these are whole replies. Only those are left.
const CUT_NOTE = '… = cut off at the reply limit';
/**
 * The note under the outcome row: what the amber blocks are when there are any, and — when the sheet is showing
 * excerpts rather than whole replies — what was kept, so a reader is never left to assume they have it all.
 */
export const MARK_WORD = 'highlighted';
export function sheetNoteParts(terms = [], mode = 'full') {
  const parts = [];
  if (terms.length) parts.push(`${MARK_WORD} = ${keywordPhrase({ keywords: terms, keyword_mode: 'any' })}`);
  // Last is never dropped: a reader must always be told whether these are whole replies.
  parts.push(mode === 'full' ? CUT_NOTE : `showing ${EXCERPTS[mode]} · … = the rest${mode === 'matches' ? ` · ${NO_MATCHES} = a model none of whose replies matched` : ''}`);
  return parts;
}
export function sheetNote(terms = [], mode = 'full') {
  return sheetNoteParts(terms, mode).join(' · ');
}

/** The longest prefix of `text` that fits `maxWidth` at size `v`, ending in an ellipsis when it had to cut. */
function clipToWidth(text, v, maxWidth) {
  if (measureWidth(text, font(v)) <= maxWidth) return text;
  let cut = text.length;
  while (cut > 1 && measureWidth(text.slice(0, cut) + '…', font(v)) > maxWidth) cut -= 1;
  return text.slice(0, cut) + '…';
}

/**
 * Legend, anchored to the bottom edge. Left: the model names in their colors, then the outcome row, each measured
 * and grown to the largest size that still fits beside the URL (the names in as many rows as the base size needs).
 * Right: the URL at one column's width, with the run's summary line above it.
 *
 * `outcomes: false` drops the outcome row and gives the note its width. A page where every reply drawn on it had
 * the same outcome has nothing to key: four badges and their names would take the width to say one thing, and the
 * sentences page is exactly that page — everything on it matched a keyword, or it would not be there.
 */
function legend(a, size, colors, shareUrl, noteParts = [CUT_NOTE], { outcomes = true } = {}) {
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
      rows[rows.length - 1].push({ x, model, label, color: colors[model], w });
      x += w + s * 1.6;
    }
    return { rows, fits };
  };
  const base = wrapModels(lf);
  const s = largest(lf, size / 50, (v) => { const r = wrapModels(v); return r.fits && r.rows.length <= base.rows.length; });
  const rows = wrapModels(s).rows;
  // The outcome row is swatch + label per outcome, then the note. Swatches and labels grow to the largest size
  // the whole row fits beside the URL at; a note that still does not fit there — it says more on a run that
  // highlights or excerpts — takes the largest size that does, never bigger than the labels, so the row keeps
  // every word instead of running under the URL.
  const swatchWidth = (v) => (outcomes ? OUTCOMES.reduce((w, [label]) => w + iconAdvance(v) + measureWidth(label, font(v)) + v * 1.6, 0) : 0);
  const floor = lf * 0.6; // below this the note is not worth the width it costs the outcome labels
  // The outcome labels and the note share the width beside the URL, so the note is measured against what the
  // labels leave: shrink it, then drop its leading parts — the last, which says whether these are whole
  // replies, always stays — and clip whatever is left. Nothing is ever drawn under the URL.
  let parts = [...(Array.isArray(noteParts) ? noteParts : [noteParts])];
  const o = largest(lf, size / 50, (v) => swatchWidth(v) + measureWidth(parts.join(' · '), font(v)) <= maxW);
  const room = maxW - swatchWidth(o);
  while (parts.length > 1 && measureWidth(parts.join(' · '), font(floor)) > room) parts = parts.slice(1);
  const noteSize = Math.max(floor, Math.min(o, largest(floor, o, (v) => measureWidth(parts.join(' · '), font(v)) <= room)));
  const note = clipToWidth(parts.join(' · '), noteSize, room);
  const modelRowH = s * 1.5;
  const outcomeRowH = o * 1.5;
  const bottom = size - pad - lf * 0.6; // swatch bottom of the outcome row; the URL shares the row's baseline
  const urlBaseline = bottom - o * FONT_METRICS.descent;
  const brandBaseline = urlBaseline - urlSize * 0.95 - brandSize * 0.6;
  const leftTop = bottom - outcomeRowH - (rows.length - 1) * modelRowH - iconSide(s);
  const rightTop = brandBaseline - brandSize * 0.8;
  const height = size - pad - Math.min(leftTop, rightTop) + lf * 0.6;
  return { lf, s, o, noteSize, rows, modelRowH, outcomeRowH, bottom, urlSize, urlBaseline, brandSize, brandBaseline, height, note, outcomes };
}

function geometry(size, f, headerH, legendH, columns = columnsFor(size)) {
  const pad = Math.round(size * 0.03);
  const gap = columnGap(size, f);
  const colW = (size - pad * 2 - gap * (columns - 1)) / columns;
  const colTop = pad + headerH;
  const colH = size - pad - legendH - colTop;
  return { pad, columns, gap, colW, colTop, colH, lineH: f * 1.32, paraGap: f * 0.9 };
}

// ---------- how much of each reply the sheet shows ----------
/** How much of each reply is shown. Presentation only: an excerpt never changes a verdict, only what you read. */
// Splitting and batching live in sentences.js, with the page made of nothing else; the excerpt modes use the splitter.
export { sentences, SENTENCE_SORTS };

export const EXCERPTS = {
  full: 'every word of every reply',
  ends: 'the first and last sentence of each reply',
  matches: 'only the sentences that contain a match',
};

/**
 * The responses images people ask for by name. *Which replies* and *how much of each* are two questions, but
 * nobody arrives with two answers — they arrive wanting a particular image, so each preset answers both at once
 * and carries the flags that make the same image from a script. The list is the menu's, so a new image offered
 * in the terminal is a new row here rather than a new question to answer.
 */
const SHEET_PRESETS = [
  { key: 'full', select: 'all', excerpt: 'full', label: 'Every reply, in full', note: 'the image every run already writes', flags: '' },
  { key: 'ends', select: 'all', excerpt: 'ends', label: 'Just the first and last sentence of each reply', note: 'how each reply opens and where it lands, across every model · every run writes this one too', flags: '--excerpt ends' },
  { key: 'matched', select: 'matched', excerpt: 'full', label: 'Only the replies that included the keywords', note: 'every word of each, with the matches marked', flags: '--matched' },
  { key: 'matches', select: 'all', excerpt: 'matches', label: 'Only the sentences a marked word turned up in', note: 'the word in the sentence the model built around it', flags: '--excerpt matches' },
  { key: 'refused', select: 'refused', excerpt: 'full', label: 'Only refusals', note: 'what declining looks like, model by model', flags: '--refused' },
];

/**
 * The presets for one run, each carrying why it cannot be drawn — an empty page is not an answer, so a preset
 * that would select nothing says which run it is rather than drawing a header over nothing.
 * @returns {Array<{key: string, select: string, excerpt: string, label: string, note: string, flags: string, unavailable: string|null}>}
 */
export function sheetPresets(run) {
  const results = run?.results || [];
  const empty = { matched: 'nothing in this run included them', refused: 'nothing in this run was refused' };
  return SHEET_PRESETS.map((p) => ({
    ...p,
    unavailable: p.select in empty && !results.some((r) => r[p.select]) ? empty[p.select] : null,
  }));
}

/**
 * Cut a reply down to `mode`. Every elision is marked with an ellipsis, wherever it falls, so an excerpt can
 * never be misread as the whole reply. `matches` uses the same terms the sheet highlights, so the sentences it
 * keeps are the ones with amber in them; a reply with no match is shown as a bare ellipsis rather than dropped,
 * because "this model said nothing matching" is part of the picture.
 * @returns {{text: string, tail: boolean}} tail: whether the excerpt still reaches the reply's last sentence
 */
export function excerpt(text, mode = 'full', terms = []) {
  const src = String(text || '');
  const parts = mode === 'full' || !src.trim() ? [] : sentences(src);
  if (!parts.length) return { text: src, tail: true };
  if (mode === 'ends') {
    return parts.length <= 2 ? { text: parts.join(' '), tail: true } : { text: `${parts[0]} … ${parts[parts.length - 1]}`, tail: true };
  }
  if (mode === 'matches') {
    const kept = [];
    parts.forEach((sentence, i) => { if (findKeywordSpans(sentence, terms).length) kept.push([sentence, i]); });
    if (!kept.length) return { text: '…', tail: false };
    let out = kept[0][1] > 0 ? '… ' : '';
    kept.forEach(([sentence, i], k) => {
      if (k && i > kept[k - 1][1] + 1) out += '… '; // a gap between kept sentences is an elision too
      out += sentence + ' ';
    });
    const more = kept[kept.length - 1][1] < parts.length - 1;
    return { text: out.trim() + (more ? ' …' : ''), tail: !more };
  }
  return { text: src, tail: true };
}

// ---------- the reply stream: one rich-inline paragraph per model ----------
/** What a reply says on the sheet: its text under the excerpt mode, an ellipsis when the reply limit cut it off, or its error. */
function replyText(r, color, mode = 'full', terms = []) {
  const cut = r.finish_reason === 'length';
  if (r.error && !r.refused && !cut) return { text: `ERROR: ${shortError(r.error)}`, fill: COLORS.muted };
  const { text: kept, tail } = excerpt(collapseEmoji(r.text || ''), mode, terms);
  const text = kept.replace(/\s+/g, ' ').trim();
  // Only when the excerpt still runs to the end does the reply limit's ellipsis mean anything.
  if (cut && tail) return { text: text + '…', fill: color };
  return { text: text || '(empty reply)', fill: color };
}

/**
 * Where a reply is cut into items: after its first word (which carries the outcome square and the width reserved
 * for it) and at every keyword-match boundary (so a match is its own item and can be marked). Cuts inside a word
 * are not break opportunities — only whitespace between items is — so marking a match never moves a line break.
 * The first-word cut skips any space a match runs through, keeping a matched phrase in one piece.
 */
function replyCuts(text, spans) {
  let sp = text.indexOf(' ');
  while (sp !== -1 && spans.some((s) => sp > s.start && sp < s.end)) sp = text.indexOf(' ', sp + 1);
  const cuts = new Set([0, text.length]);
  if (sp !== -1) cuts.add(sp);
  for (const s of spans) { cuts.add(s.start); cuts.add(s.end); }
  return [...cuts].sort((a, b) => a - b);
}

/**
 * A paragraph under construction: the text items, and the parallel arrays saying what each one is drawn as —
 * its colour, the badge or provider mark in front of it, whether it sits on a highlight, and the width held for
 * a mark that is drawn rather than typed. Both pages on this engine build their paragraphs through it, so a
 * fragment means the same thing to the drawing code wherever it came from.
 */
function itemBag(f) {
  const items = []; const fills = []; const icons = []; const logos = []; const marks = []; const bolds = []; const models = []; const links = []; const reserves = [];
  const sizes = []; const opacities = []; const rules = [];
  const push = (text, fill, { bold = false, icon = null, logo = null, mark = null, model = null, link = null, extraWidth = 0, size = f, markOpacity = 1, rule = null } = {}) => {
    items.push({ text, font: font(size, { bold }), extraWidth });
    fills.push(fill); icons.push(icon); logos.push(logo); marks.push(mark); bolds.push(bold); models.push(model); links.push(link); reserves.push(extraWidth);
    sizes.push(size); opacities.push(markOpacity); rules.push(rule);
  };
  return {
    push,
    paragraph: (key, extra = {}) => ({
      key,
      model: null,
      group: null,
      // How far the first line reaches above where an ordinary line of this page would: the flow reserves it.
      headroom: Math.max(0, (Math.max(f, ...sizes.slice(0, 1)) - f) * FONT_METRICS.ascent),
      ...extra,
      prepared: prepareRichInline(items),
      fills, icons, logos, marks, bolds, models, links, reserves, sizes, opacities, rules,
    }),
  };
}

/**
 * One run of text pushed as items cut at its keyword matches, so every match is its own item and can be marked.
 * With an `icon`, the first item also carries that badge in the space reserved for it.
 */
/** What a marked run is drawn with, under one style: the block behind it, how solid it is, a rule, and its ink. */
/** How a match is drawn in `style`: `color` is the model's, `base` the marker's own — amber for a keyword, red for a refusal. */
function markOf(style, color, fill, base = MARK_BG) {
  const wash = base === MARK_BG ? MARK_WASH : mix(base, COLORS.bg, WASH_AMOUNT);
  if (style === 'wash') return { mark: wash, markOpacity: 1, rule: null, ink: fill, bold: false };
  if (style === 'underline') return { mark: null, markOpacity: 1, rule: base, ink: fill, bold: false };
  if (style === 'wash-rule') return { mark: wash, markOpacity: 1, rule: base, ink: fill, bold: false };
  if (style === 'model') return { mark: color, markOpacity: 1, rule: null, ink: inkOn(color), bold: false };
  if (style === 'tint') return { mark: mix(color, COLORS.bg, TINT_OPACITY), markOpacity: 1, rule: null, ink: fill, bold: false };
  if (style === 'rule') return { mark: null, markOpacity: 1, rule: color, ink: fill, bold: false };
  if (style === 'invert') return { mark: null, markOpacity: 1, rule: null, ink: base, bold: true };
  return { mark: base, markOpacity: 1, rule: null, ink: base === MARK_BG ? MARK_TEXT : inkOn(base), bold: false };
}

function pushMarked(bag, text, spans, fill, f, { model = null, icon = null, nbspWidth = 0, style = 'block', color = fill, markColor = MARK_BG } = {}) {
  const m = markOf(style, color, fill, markColor);
  const cuts = replyCuts(text, spans);
  for (let j = 0; j < cuts.length - 1; j++) {
    const [from, to] = [cuts[j], cuts[j + 1]];
    if (from === to) continue;
    const marked = spans.some((sp) => from >= sp.start && from < sp.end);
    const opts = marked
      ? { mark: m.mark, markOpacity: m.markOpacity, rule: m.rule, bold: m.bold, model }
      : { model };
    if (from === 0 && icon) bag.push(NBSP + text.slice(from, to), marked ? m.ink : fill, { ...opts, icon, extraWidth: iconAdvance(f) - nbspWidth });
    else bag.push(text.slice(from, to), marked ? m.ink : fill, opts);
  }
}

/**
 * The replies, one paragraph each, under a heading per batch.
 *
 * Every reply opens with whose it is — the provider's mark and the model's name, in the model's colour — then its
 * outcome square and its text, so the page is read as a list of models down the column rather than as one block
 * the names have to be found inside. That is how the sentences page sets its rows, and a reader who has met one
 * of these images should not have to learn the other. A group batch is headed by the group's name, in the amber
 * every image here heads a group with and linked to its own view, with the replies set in under it; with no
 * groups to name there is no heading and the replies start at the column's edge. Batched by model the model
 * heads the batch and each reply opens with the group it answered instead.
 */
function paragraphs(responses, analysis, colors, f, terms = [], mode = 'full', sort = 'group') {
  const labelled = analysis.variants.length > 1 || analysis.variants[0]?.label !== '—';
  const byGroup = sort !== 'model';
  const batches = new Map();
  for (const r of responses) {
    const key = byGroup ? r.variantKey : r.model;
    if (!batches.has(key)) batches.set(key, []);
    batches.get(key).push(r);
  }
  const out = [];
  const nbspWidth = measureWidth(NBSP, font(f));
  // The heading is set a step above the page, as the sentences page sets its own, so reading order runs prompt,
  // batch, model, reply: at one size the heading and the names are the same weight and nothing ranks them.
  const hs = Math.round(f * HEADING_SCALE * 10) / 10;
  const indent = f * 1.1;
  for (const [key, rs] of batches) {
    const headed = byGroup ? labelled : true;
    if (headed) {
      const head = itemBag(f);
      if (byGroup) head.push(rs[0].variantLabel, COLORS.accent, { bold: true, size: hs, link: `#${groupId(key, analysis)}` });
      else head.push(NBSP + shortModel(key), colors[key], { bold: true, size: hs, logo: key, model: key, extraWidth: iconAdvance(hs) - measureWidth(NBSP, font(hs)) });
      // The heading keeps the first lines of the first reply with it, so it never ends a column on its own.
      out.push(head.paragraph(key, { model: byGroup ? null : key, group: byGroup ? key : null, keep: 2 }));
    }
    // Under "only matching sentences" the page lists the replies that have one. A reply with none would stand
    // as a bare ellipsis, and a page of ellipses says nothing a reader can use; so those replies are left out,
    // and the models with no match in the batch are named once each at its foot, muted — the page still says
    // who did not, and the text that did match gets the room.
    const only = mode === 'matches';
    const listed = only ? rs.filter((r) => (r.error && !r.refused) || findKeywordSpans(collapseEmoji(r.text || ''), terms).length) : rs;
    listed.forEach((r, i) => {
      const color = colors[r.model];
      const bag = itemBag(f);
      // A no-break space holds the mark's width, so the mark, the name and the first word wrap as one.
      if (byGroup) bag.push(NBSP + shortModel(r.model) + ' ', color, { bold: true, logo: r.model, model: r.model, extraWidth: iconAdvance(f) - nbspWidth });
      else if (labelled) bag.push(r.variantLabel + ' ', COLORS.accent, { bold: true });
      const { text, fill } = replyText(r, color, mode, terms);
      // the reply's first item carries its square, in the space reserved by extraWidth
      pushMarked(bag, text, findKeywordSpans(text, terms), fill, f, { model: r.model, icon: outcomeOf(r), nbspWidth });
      // Replies under one heading are one list, so the gap between them is a share of the page's paragraph gap;
      // the first sits closest to the heading it belongs to.
      out.push(bag.paragraph(`${key}:${i}`, { model: byGroup ? null : key, group: byGroup ? key : null, indent: headed ? indent : 0, gapScale: headed ? (i ? 0.4 : 0.25) : 0.6 }));
    });
    if (only) {
      // One row per model with no matching reply here: under a wording, each such model by name; under a model,
      // the one line that says so. Muted, so the rows that matched keep the eye.
      const quiet = byGroup
        ? [...new Set(rs.map((r) => r.model))].filter((m) => !listed.some((r) => r.model === m))
        : (listed.length ? [] : [key]);
      quiet.forEach((m, j) => {
        const bag = itemBag(f);
        if (byGroup) bag.push(NBSP + shortModel(m) + ' ', COLORS.muted, { bold: true, logo: m, model: m, extraWidth: iconAdvance(f) - nbspWidth });
        bag.push(NO_MATCHES, COLORS.muted);
        out.push(bag.paragraph(`${key}:none:${j}`, { model: byGroup ? null : key, group: byGroup ? key : null, indent: headed ? indent : 0, gapScale: headed ? (listed.length || j ? 0.4 : 0.25) : 0.6 }));
      });
    }
  }
  return out;
}

/** What a model with no matching reply is listed as, under "only matching sentences". */
export const NO_MATCHES = 'no matches';

/** Every line of a set of paragraphs at one column width, in reading order: the measured (expensive) step. */
function lineRanges(paras, colW) {
  const lines = [];
  paras.forEach((para, pi) => {
    let first = true;
    // An indented paragraph is set in a narrower measure, not shifted off the end of its column.
    walkRichInlineLineRanges(para.prepared, colW - (para.indent || 0), (range) => { lines.push({ pi, para, range, first }); first = false; });
  });
  return lines;
}

/** The reply stream's lines at text size f. */
function linesAt(responses, analysis, colors, f, colW, terms = [], mode = 'full', sort = 'group') {
  return lineRanges(paragraphs(responses, analysis, colors, f, terms, mode, sort), colW);
}

/** Flow lines into columns top to bottom, starting a new column once a line would pass `limit`; fits=false past the last column. */
function flow(lines, g, limit = g.colH) {
  const placed = [];
  let col = 0;
  let y = 0;
  for (const line of lines) {
    // A heading alone at the foot of a column heads nothing: it asks to keep the first lines of what it
    // introduces, and takes the next column with them rather than being read as the end of the column above.
    const keep = line.first ? line.para.keep || 0 : 0;
    // A heading set larger than the page reaches further above its baseline than an ordinary line does. That
    // extra ascent is reserved here — including when the paragraph starts a fresh column, where there is no
    // paragraph gap to hide in and the heading would otherwise ride up into the prompt.
    const head = line.first ? line.para.headroom || 0 : 0;
    // A paragraph that continues the one above it — a model's sentences under the wording that heads them — asks
    // for less of the gap than a new batch does, so the gap is the paragraph's own share of the page's.
    const gap = (line.first && line.pi > 0 && y > 0 ? g.paraGap * (line.para.gapScale ?? 1) : 0) + head;
    // At the top of a fresh column there is nowhere further to push a heading, so it is kept only where it could
    // actually be stranded: partway down a column that has already taken text.
    if (y + gap + g.lineH + (y > 0 ? g.lineH * keep : 0) > limit) {
      col += 1;
      y = head;
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
 * Lay a page out at the largest text size everything still fits at, then balance the columns and open the
 * leading until the tallest one reaches the bottom. `linesFor(f, colW)` measures the body at one size; the
 * search around it is the same whether those lines are replies or sentences.
 */
function fitPage(linesFor, { size, headerH, legendH, columns = null, minFont = 6, maxFont = null }) {
  // The size cap is where one column still holds ~12 words; below it the column count follows the size.
  const hi = Math.max(minFont, Math.floor(maxFont || maxFontFor(size)));
  const attempt = (f) => { const g = geometry(size, f, headerH, legendH, columns || columnsForFont(size, f)); const lines = linesFor(f, g.colW); return { f, g, lines, ...flow(lines, g) }; };
  let best = attempt(minFont); // overflow even at the floor: draw what fits
  if (!best.fits) return best;
  // Fit is monotonic in text size, so binary-search the largest size that fits: whole pixels first, then tenths.
  for (let lo = minFont + 1, top = hi; lo <= top;) {
    const mid = Math.floor((lo + top) / 2);
    const r = attempt(mid);
    if (r.fits) { best = r; lo = mid + 1; } else top = mid - 1;
  }
  if (best.f < hi) {
    // Only worth tenths of a pixel when the page, not the size cap, is what limits the text.
    const whole = best.f;
    for (let lo = 1, top = 9; lo <= top;) {
      const mid = Math.floor((lo + top) / 2);
      const r = attempt(Math.round(whole * 10 + mid) / 10);
      if (r.fits) { best = r; lo = mid + 1; } else top = mid - 1;
    }
  }
  // Balanced columns, leading opened toward the bottom — including when the text stopped at the size cap, which
  // is where a short selection or an excerpt lands. Without this the lines pile into column one and the rest of
  // the page is blank.
  const { placed, g } = stretch(balance(best.lines, best.g).placed, best.g);
  return { ...best, placed, g };
}

/**
 * @param {object} opts
 * @param {string} [opts.excerpt] how much of each reply to show: full | ends | matches (see EXCERPTS)
 * @param {string} [opts.sort] how the replies are batched: group | model (see SORTS)
 * @param {string[]|null} [opts.highlight] terms to mark in the replies. Left out, the sheet marks whatever the
 *   run remembers being asked to mark (`run.highlight`, set by --highlight), and failing that the eval's own
 *   keywords; an empty array marks nothing. Marking is presentation only: no verdict, rate or card changes.
 * @returns {{svg:string, font:number, columns:number, replies:number, exact:boolean, fill:number, highlight:string[]}}
 */
export function renderResponseSheet(run, { size = 4096, maxFont = null, minFont = 6, columns = null, select = 'all', url = null, highlight = null, excerpt: mode = 'full', sort: order = 'group' } = {}) {
  const sort = SORTS[order] ? order : 'group';
  const { analysis: a, responses } = selectResponses(run, select, sort);
  const colors = modelColors(a.rows.map((r) => r.model));
  const shareUrl = url || `${a.spec.share_base || ''}${a.id}`;
  const terms = (highlight ?? run.highlight ?? a.spec.keywords) || [];
  const head = header(a, size);
  const excerptMode = EXCERPTS[mode] ? mode : 'full';
  const leg = legend(a, size, colors, shareUrl, sheetNoteParts(terms, excerptMode));
  const best = fitPage((f, colW) => linesAt(responses, a, colors, f, colW, terms, excerptMode, sort), { size, headerH: head.headerH, legendH: leg.height, columns, minFont, maxFont });
  // The ends image is its own image, and its brand line says so: a reader who meets it alone should not take it
  // for the sheet with the replies cut short by accident.
  const kind = excerptMode === 'ends' ? 'first and last sentences' : 'responses';
  const svg = pinTextWidths(renderSvg(best, { a, size, select, responses: responses.length, run, shareUrl, colors, head, leg, sort, kind }));
  return { svg, font: best.f, columns: best.g.columns, replies: responses.length, exact: textReady(), fill: columnFill(best.placed, best.g), highlight: terms, excerpt: excerptMode, sort };
}

/** Compatibility wrapper: always one page. */
export function renderResponseSheets(run, opts = {}) {
  return [renderResponseSheet(run, opts).svg];
}

// ---------- the sentences page: the same engine, batched by the variable instead of by the reply ----------
/**
 * What a batch says under its heading.
 *
 * The counting number is the marked words themselves — one per highlighted run of text — because that is what
 * the eval measured and what a reader is being asked to compare between the groups. The sentences are how those
 * matches are shown, not what is counted: a count cannot say whether "suspicious" described the street or the
 * man, and the sentence around it can. So the heading is matches and nothing else; how many sentences carried
 * them is a fact about the display, and counting it in the heading only competes with the number that matters.
 *
 * What the matches are counted *across* is said in the terms of the thing the batch is of: a wording counts the
 * models, because "which models put these words into this group's answers" is the question the page was opened
 * with; a model counts the wordings, because a model using a word for every group is not the same finding as one
 * using it for a single group; a word counts the replies it came out of.
 *
 * With nothing in it, a batch says so in a sentence rather than as a zero. A group where none of the marked
 * words turned up is half of the comparison the page exists to make, and "0 matches from 0 models" makes a
 * reader work out what that means. So it is written out: the words that were looked for, and the plain fact that
 * no model used any of them here.
 */
export function sentenceCount(batch, by = 'group', terms = []) {
  const n = batch.matches ?? 0;
  if (!n) {
    const words = terms.length ? keywordPhrase({ keywords: terms, keyword_mode: 'any' }) : 'the marked words';
    return by === 'model' ? `used ${words} in none of its responses` : `no model used ${words} in any of their responses to this prompt`;
  }
  const head = `${n} keyword match${n === 1 ? '' : 'es'}`;
  if (by === 'group') return `${head} from ${batch.models.length} model${batch.models.length === 1 ? '' : 's'}`;
  if (by === 'model') return `${head} in ${batch.groups.length} wording${batch.groups.length === 1 ? '' : 's'}`;
  return `${head} in ${batch.replies} repl${batch.replies === 1 ? 'y' : 'ies'}`;
}

/**
 * The note along the bottom of the sentences page, which is the whole legend apart from the model names: the
 * outcome badges are gone with the row that keyed them, so what is left to explain is the amber, the per-run
 * count, the elisions, and how the page is batched.
 *
 * The last part is never dropped when the width runs short, so it is the one a reader cannot do without: what is
 * counted, and that the text under it is sentences rather than whole replies.
 */
export function sentenceNoteParts(terms = [], by = 'group') {
  const parts = [];
  if (terms.length) parts.push(`${MARK_WORD} = ${by === 'keyword' ? 'the word each batch is of' : keywordPhrase({ keywords: terms, keyword_mode: 'any' })}`);
  parts.push(`×n = that ${by === 'model' ? 'wording' : 'model'}'s keyword matches`);
  parts.push('… = a gap in the reply');
  parts.push(`every keyword match in the sentence it turned up in · ${SENTENCE_SORTS[by] || SENTENCE_SORTS.group}`);
  return parts;
}
export const sentenceNote = (terms = [], by = 'group') => sentenceNoteParts(terms, by).join(' · ');

/**
 * Consecutive lines that share whatever this batching names. A wording batch names the model, so a run is one
 * model's sentences; a model batch names the wording; a word batch names both, so either one changing starts a
 * new run. Each run is introduced once and carries its own match count, which is what makes the page answer
 * "which model, and how much of it" without a reader counting amber blocks.
 */
function sentenceRuns(lines, by) {
  const runs = [];
  for (const line of lines) {
    const last = runs[runs.length - 1];
    const head = last?.lines[0].response;
    const sameGroup = head && head.variantKey === line.response.variantKey;
    const sameModel = head && head.model === line.response.model;
    const same = by === 'group' ? sameModel : by === 'model' ? sameGroup : sameGroup && sameModel;
    if (same) last.lines.push(line);
    else runs.push({ lines: [line] });
  }
  return runs;
}

/** True when `line` picks up exactly where `prev` left off: the next sentence of the same reply, nothing skipped. */
const runsOn = (prev, line) => Boolean(prev) && prev.response === line.response && line.index === prev.index + 1;

/**
 * One paragraph per batch: what the batch is of, how many matches it drew, then the sentences those matches sit
 * in.
 *
 * A wording batch opens with the group's name in amber — the eval's own variable, which is what the page is for —
 * and names each model where it comes up, in the card's order, with that model's own match count beside it. So
 * the group says how much of this wording there is and the models say whose it is, which is the whole finding.
 * A model batch turns that around: the model heads it, and the wording is named with its count underneath.
 *
 * Two sentences run together only when they ran together in the reply they came from. Anywhere else something
 * was skipped — the rest of a reply, or a whole other reply — so an ellipsis joins them, the way an excerpt marks
 * an elision. Nothing else separates them: every sentence here matched a keyword, which is the only reason it is
 * on the page, so the outcome badge the responses sheet puts before each reply would say the same thing every
 * time and is left off along with the legend row that keyed it.
 *
 * Marking follows the batching. Under a wording or a model, every marked word in a sentence is highlighted,
 * because the batch is not about any one of them and a reader needs to see which word landed. Under a word, only
 * that word is marked: the page is then read one word at a time, and a second colour of evidence in the same
 * line is a question the reader did not ask.
 */
function sentenceParagraphs(batches, analysis, colors, f, terms, by = 'group', style = 'block', heading = HEADING_SCALE, name = NAME_SCALE, promptSize = Infinity, { layout = 'flow', voice = 'model', clean = false, spansOf = null, countOf = null, perRun = null, markColor = MARK_BG } = {}) {
  const labelled = analysis.variants.length > 1 || analysis.variants[0]?.label !== '—';
  // What is marked and what is counted are the keyword page's unless the caller brings its own: the refusals
  // page marks the refusing phrase and counts refused replies, on the same page otherwise.
  const findSpans = spansOf || ((text, batch) => findKeywordSpans(text, by === 'keyword' ? [batch.key] : terms));
  const count = countOf || ((batch) => sentenceCount(batch, by, terms));
  const runTally = perRun || ((items) => items.reduce((n, it) => n + it.spans.length, 0));
  const nbspWidth = measureWidth(NBSP, font(f));
  const rows = layout === 'rows' || layout === 'stack';
  const indent = rows ? f * 1.1 : 0;
  const metaSize = Math.round(f * 0.82 * 10) / 10;
  const out = [];
  for (const batch of batches) {
    const bag = itemBag(f);
    const headColor = by === 'model' ? colors[batch.key] || COLORS.text : COLORS.accent;
    // The heading is set larger than the page it heads. Reading order on this page should run prompt, wording,
    // model, then the sentences: at one size the wording and the model names are the same weight and the eye has
    // nothing to descend through, so the batch a page is made of is given a rank of its own.
    const hs = Math.max(f, Math.round(Math.min(f * heading, promptSize * HEADING_OF_PROMPT) * 10) / 10);
    if (by === 'keyword') {
      // The word as a person reads it — a /regex/ loses its slashes — marked the way its matches below are, so
      // the batch and its evidence always look like the same thing.
      const m = markOf(style, headColor, headColor);
      bag.push(stripPattern(batch.key), m.ink === MARK_TEXT ? MARK_TEXT : headColor, { bold: true, size: hs, mark: m.mark, markOpacity: m.markOpacity, rule: m.rule });
    } else if (by === 'model') {
      bag.push(NBSP + shortModel(batch.key), headColor, { bold: true, size: hs, logo: batch.key, model: batch.key, extraWidth: iconAdvance(f) - nbspWidth });
    } else {
      // The group's own name, in the amber every image in this project heads a group with, and a link to its
      // view so a click at page size zooms to where the group starts.
      bag.push(batch.label, headColor, { bold: true, size: hs, link: `#${groupId(batch.key, analysis)}` });
    }
    const anchors = { group: by === 'group' ? batch.key : null, model: by === 'model' ? batch.key : null };
    // Flowed, the count runs on from the name and the whole batch is one paragraph. In rows the name owns a line
    // of its own — which is what makes it a heading rather than a bold first word — and the count sits under it,
    // smaller and muted, because how much there is of something is not its name.
    if (rows) {
      // The heading keeps its count line and the first lines of the first model with it.
      out.push(bag.paragraph(batch.key, { ...anchors, keep: 4 }));
      const meta = itemBag(f);
      meta.push(count(batch), COLORS.muted, { size: metaSize });
      out.push(meta.paragraph(`${batch.key}:count`, { gapScale: 0.12 }));
    } else bag.push(' ' + count(batch), COLORS.muted);
    let lastGroup = null;
    sentenceRuns(batch.lines, by).forEach((run, ri) => {
      const first = run.lines[0].response;
      const color = colors[first.model] || COLORS.text;
      // Whose sentences these are is already said by the name and the mark in front of them. Setting the
      // sentences themselves in that colour says it a second time, over a paragraph, and a page with no neutral
      // left on it has nothing to rank the model against. Neutral keeps the colour for the name.
      const ink = voice === 'neutral' ? COLORS.text : color;
      // Measured once per run: fitPage walks this at every candidate text size, so the spans are not re-found.
      const items = run.lines.map((line) => {
        const text = clean ? stripMarkup(line.text) : line.text.replace(/\s+/g, ' ').trim();
        return { line, text, spans: findSpans(text, batch) };
      });
      const ns = Math.max(f, Math.round(Math.min(f * name, hs * NAME_OF_HEADING) * 10) / 10);
      // Rows give each model a paragraph of its own, set in under the wording, so a batch is read as a list of
      // models rather than as one block a reader has to find the names inside.
      const nameBag = rows ? itemBag(f) : bag;
      if (!rows) nameBag.push(' ', color); // the break opportunity that lets a mark wrap with the word it belongs to
      if (by !== 'group' && labelled && first.variantKey !== lastGroup) {
        nameBag.push(first.variantLabel, COLORS.accent, { bold: true, size: ns });
        lastGroup = first.variantKey;
        if (by === 'keyword' || rows) nameBag.push(' ', color);
      }
      if (by !== 'model') nameBag.push(NBSP + shortModel(first.model), color, { bold: true, size: ns, logo: first.model, model: first.model, extraWidth: iconAdvance(ns) - measureWidth(NBSP, font(ns)) });
      // Every run says how many of the batch's matches are its own, so "which model" is read rather than counted.
      nameBag.push(` ×${runTally(items)}`, COLORS.muted, rows ? { size: metaSize } : {});
      // Stacked, the name is its own line and the sentences start under it; otherwise they run on from it.
      const textBag = layout === 'stack' ? itemBag(f) : nameBag;
      const runGap = ri ? 0.4 : 0.25;
      if (layout === 'stack') out.push(nameBag.paragraph(`${batch.key}:name${ri}`, { indent, gapScale: runGap }));
      let prev = null;
      for (const { line, text, spans } of items) {
        const gap = prev && !runsOn(prev, line);
        textBag.push(gap ? ' … ' : ' ', gap ? COLORS.muted : ink);
        pushMarked(textBag, text, spans, ink, f, { model: first.model, style, color, markColor });
        prev = line;
      }
      if (rows) out.push(textBag.paragraph(`${batch.key}:run${ri}`, { indent, gapScale: layout === 'stack' ? 0.08 : runGap }));
    });
    if (!rows) out.push(bag.paragraph(batch.key, anchors));
  }
  return out;
}

/**
 * How a batch is set out.
 *
 * `rows` is the page: the wording heads it on a line of its own, its count sits under the name rather than after
 * it, and every model is a row of its own, set in under the heading. Reading order then runs prompt, wording,
 * model, sentence — down the page and in that order — instead of being four things a reader has to pick out of
 * one paragraph.
 * `stack` goes one further and gives the model's name its own line too, with its sentences under it. Clearest
 * hierarchy, and the most vertical space: the body lands a size smaller for it.
 * `flow` is the page as it was, one paragraph per batch with the models named where they come up. It fits the
 * most text on the square, and it is the right one for a run whose batches are a sentence or two each.
 */
export const SENTENCE_LAYOUTS = {
  rows: 'a row per model, under a heading per batch',
  stack: 'a row per model with its name on a line of its own',
  flow: 'one paragraph per batch, models named where they come up',
};

/**
 * What colour the sentences themselves are set in. Whose sentence it is is said by the name in front of it and
 * by the provider's mark, so `neutral` says it once and leaves the page a neutral to rank everything else
 * against; `model` says it again over the whole paragraph, which is how the responses sheet reads a reply.
 */
export const SENTENCE_VOICES = {
  neutral: "sentences in one neutral, each model named in its own colour",
  model: "sentences in the model's own colour",
};

/** What the sentences page draws unless it is told otherwise. The CLI's defaults are these, not a second copy. */
export const SENTENCE_DEFAULTS = { mark: 'wash-rule', layout: 'rows', voice: 'neutral', clean: true };

/**
 * Every sentence a marked word turned up in, on one square image, batched by the variable the eval swapped.
 *
 * The responses sheet answers "what did this model say". This answers the question a keyword run actually ends
 * on: the rates say a word lands on one group more than another, and a rate cannot tell you whether "suspicious"
 * described the street or the man. So the page is the sentences themselves, in full, one group of the variable at
 * a time, with the models named inside each group in the card's own order — which puts the model producing most
 * of that wording first, and lets a reader follow one model from group to group and see whether it changes its
 * language when only the variable changed. That comparison is the evidence behind calling a model biased, and it
 * is the thing a rate alone cannot be.
 *
 * `sort: 'model'` reads one model straight through instead, every wording it was given together; `sort: 'keyword'`
 * batches by the marked word, for when the word rather than the model is what is under examination.
 *
 * Nothing is trimmed or paginated, and nothing here scores: the sentences are selected by the same matcher the
 * run scored with, so the page is the text behind the numbers, but reading it moves no rate and no verdict.
 *
 * @param {object} opts
 * @param {string} [opts.sort] how the sentences are batched: group | model | keyword (see SENTENCE_SORTS)
 * @param {string} [opts.mark] how a match is drawn (see MARK_STYLES)
 * @param {string} [opts.layout] how a batch is set out: rows | stack | flow (see SENTENCE_LAYOUTS)
 * @param {string} [opts.voice] what the sentences are set in: neutral | model (see SENTENCE_VOICES)
 * @param {boolean} [opts.clean] take the models' markdown marks off the sentences
 * @param {string[]|null} [opts.highlight] the words to gather sentences for. Left out, the page uses whatever the
 *   run remembers being asked to mark (`run.highlight`), and failing that the eval's own keywords.
 * @param {string} [opts.select] which replies to read sentences out of (see SELECTIONS)
 * @returns {{svg:string, font:number, columns:number, matches:number, sentences:number, words:number, sort:string, batches:Array<{key:string, label:string, matches:number, sentences:number, replies:number, models:string[], groups:string[], terms:string[], split:Array<{label:string, matches:number, sentences:number, replies:number}>}>, missing:string[], replies:number, exact:boolean, fill:number, highlight:string[]}}
 */
export function renderSentenceSheet(run, { size = 4096, maxFont = null, minFont = 6, columns = null, select = 'all', url = null, highlight = null, sort: order = 'group', mark: markOption = SENTENCE_DEFAULTS.mark, heading = HEADING_SCALE, name = NAME_SCALE, layout: layoutOption = SENTENCE_DEFAULTS.layout, voice: voiceOption = SENTENCE_DEFAULTS.voice, clean = SENTENCE_DEFAULTS.clean } = {}) {
  const by = SENTENCE_SORTS[order] ? order : 'group';
  const markStyle = MARK_STYLES[markOption] ? markOption : SENTENCE_DEFAULTS.mark;
  const layout = SENTENCE_LAYOUTS[layoutOption] ? layoutOption : SENTENCE_DEFAULTS.layout;
  const voice = SENTENCE_VOICES[voiceOption] ? voiceOption : SENTENCE_DEFAULTS.voice;
  const { analysis: a, responses } = selectResponses(run, select, by === 'model' ? 'model' : 'group');
  const colors = modelColors(a.rows.map((r) => r.model));
  const shareUrl = url || `${a.spec.share_base || ''}${a.id}`;
  const terms = (highlight ?? run.highlight ?? a.spec.keywords) || [];
  const found = sentenceBatches(responses, terms, { by, text: (r) => collapseEmoji(r.text || '') });
  const leg = legend(a, size, colors, shareUrl, sentenceNoteParts(terms, by), { outcomes: false });
  const fitWith = (h, cap) => fitPage(
    (f, colW) => lineRanges(sentenceParagraphs(found.batches, a, colors, f, terms, by, markStyle, heading, name, h.block.size, { layout, voice, clean }), colW),
    { size, headerH: h.headerH, legendH: leg.height, columns, minFont, maxFont: cap },
  );
  // Rows hold the prompt a full line of its own clear of the page below it. Flowed, the body starts under the
  // question the way it always has.
  const gapLines = layout === 'flow' ? 0 : 1;
  // At one size the page is laid out like any other: the body takes whatever size fills the square.
  let head = header(a, size, { gapLines });
  let cap = maxFont || null;
  if (heading > 1 || name > 1) {
    // A scale has to leave room under the prompt, or the wording comes up level with the question. Capping the
    // body alone would empty the page, so the prompt is grown instead: it is asked for the size that leaves the
    // body exactly its share, and takes a narrower measure — more lines — to reach it.
    const want = fitWith(head, cap).f / BODY_OF_PROMPT;
    for (let extra = 1; extra <= 4 && head.block.size < want; extra++) {
      const grown = header(a, size, { extraLines: extra, gapLines });
      if (grown.block.size <= head.block.size) break; // the prompt has stopped growing; it is as big as it gets
      head = grown;
    }
    cap = Math.min(cap || Infinity, head.block.size * BODY_OF_PROMPT);
  }
  const best = fitWith(head, cap);
  const words = terms.length - found.missing.length;
  // The right-hand summary counts what is on the page against what was looked for: a word that turned up in no
  // sentence has no batch to say so in, so "5 of 6 marked words" is the only place a reader meets it. Which word
  // it was is named in the terminal, where there is room for the list.
  const metaParts = [
    `${found.matches} keyword match${found.matches === 1 ? '' : 'es'} in ${found.sentences} sentence${found.sentences === 1 ? '' : 's'} from ${found.replies} of ${responses.length} repl${responses.length === 1 ? 'y' : 'ies'}`,
    `${found.missing.length ? `${words} of ${terms.length}` : words} marked word${terms.length === 1 ? '' : 's'}`,
  ];
  const svg = pinTextWidths(renderSvg(best, { a, size, select, responses: responses.length, run, shareUrl, colors, head, leg, sort: by === 'model' ? 'model' : 'group', kind: 'sentences', metaParts, logos: true, markStyle }));
  // The batches as counts rather than as the lines themselves: what a caller wants from this is the tally under
  // the image, and handing back the replies would hand back the whole run a second time. Each batch also carries
  // its split down the other axis — a wording broken out by model, a model by wording — because "which model is
  // doing this, for this group" is the reason to draw the page, and it is a number rather than a picture.
  const splitBy = by === 'group' ? (l) => shortModel(l.response.model) : (l) => l.response.variantLabel;
  const batches = found.batches.map((b) => {
    const parts = new Map();
    for (const line of b.lines) {
      const label = splitBy(line);
      if (!parts.has(label)) parts.set(label, { label, matches: 0, sentences: 0, replies: new Set() });
      const part = parts.get(label);
      // A keyword batch is of one word, so only that word's matches on the line belong to it.
      part.matches += by === 'keyword' ? findKeywordSpans(line.text, [b.key]).length : line.hits;
      part.sentences += 1;
      part.replies.add(line.response);
    }
    const order = [...parts.keys()];
    return {
      key: b.key, label: b.label, matches: b.matches, sentences: b.lines.length, replies: b.replies, models: b.models, groups: b.groups, terms: b.terms,
      split: [...parts.values()]
        .map((part) => ({ ...part, replies: part.replies.size }))
        .sort((x, y) => y.matches - x.matches || y.sentences - x.sentences || order.indexOf(x.label) - order.indexOf(y.label)),
    };
  });
  return { svg, font: best.f, columns: best.g.columns, matches: found.matches, sentences: found.sentences, words, sort: by, mark: markStyle, layout, voice, clean, batches, missing: found.missing, replies: found.replies, exact: textReady(), fill: columnFill(best.placed, best.g), highlight: terms };
}

// ---------- the refusals page ----------
/** The colour a refusal is marked in: the same red the badge before a refused reply carries. */
export const REFUSAL_MARK = BADGES.refused.color;

/** The count under a batch heading on the refusals page: how many replies declined, and from how many models. */
export function refusalCount(batch, by = 'group') {
  if (!batch.refused) return by === 'model' ? 'refused none of its replies' : 'no model refused this wording';
  const head = `${batch.refused} of ${batch.replies} repl${batch.replies === 1 ? 'y' : 'ies'} refused`;
  const n = batch.refusers?.length ?? 0;
  return by === 'model' || !n ? head : `${head} · ${n} model${n === 1 ? '' : 's'}`;
}

/** The note along the bottom of the refusals page: what the mark is, what ×n counts, and how the page is batched. */
export function refusalNoteParts(by = 'group') {
  return [
    `${MARK_WORD} = the phrase that made it a refusal`,
    `×n = that ${by === 'model' ? 'wording' : 'model'}'s refusals`,
    '… = another reply',
    `every refused reply, cut to the sentence it declined in · ${SENTENCE_SORTS[by === 'model' ? 'model' : 'group']}`,
  ];
}
export const refusalNote = (by = 'group') => refusalNoteParts(by).join(' · ');

/**
 * Every refused reply, cut to the sentence it declined in, on one square image batched by the variable the eval
 * swapped — the sentences page, drawn for refusals.
 *
 * The card says three of five refused. This is what that looked like: under each wording, every model that
 * declined it and the sentence it declined in, with the phrase the rules matched marked in red, so a reader sees
 * how a refusal happens — "I can't help with", "I won't generate" — and whether the same wording drew the same
 * phrase from everyone or a different one from each. A wording nobody declined keeps its heading and says so:
 * that is the other half of the comparison. A refusal with no sentence behind it (nothing came back, the
 * provider's filter stopped it) is listed with the reason in words, because the card counted it.
 *
 * Nothing here scores: the refusals are the run's own verdicts, and the phrase is found again in the evidence
 * each verdict already carries.
 *
 * @param {object} opts the sentences page's, minus the words: sort (group | model), mark, layout, voice, clean,
 *   select, size, maxFont, columns, url
 * @returns {{svg:string, font:number, columns:number, refused:number, replies:number, sort:string, batches:Array<{key:string, label:string, refused:number, replies:number, models:string[]}>, exact:boolean, fill:number}}
 */
export function renderRefusalSheet(run, { size = 4096, maxFont = null, minFont = 6, columns = null, select = 'all', url = null, sort: order = 'group', mark: markOption = SENTENCE_DEFAULTS.mark, heading = HEADING_SCALE, name = NAME_SCALE, layout: layoutOption = SENTENCE_DEFAULTS.layout, voice: voiceOption = SENTENCE_DEFAULTS.voice, clean = SENTENCE_DEFAULTS.clean } = {}) {
  const by = order === 'model' ? 'model' : 'group';
  const markStyle = MARK_STYLES[markOption] ? markOption : SENTENCE_DEFAULTS.mark;
  const layout = SENTENCE_LAYOUTS[layoutOption] ? layoutOption : SENTENCE_DEFAULTS.layout;
  const voice = SENTENCE_VOICES[voiceOption] ? voiceOption : SENTENCE_DEFAULTS.voice;
  const { analysis: a, responses } = selectResponses(run, select, by);
  const colors = modelColors(a.rows.map((r) => r.model));
  const shareUrl = url || `${a.spec.share_base || ''}${a.id}`;
  const found = refusalBatches(responses, { by });
  // A refusal with no sentence is listed by its reason; one the provider explained carries the reason and the explanation.
  const batches = found.batches.map((b) => ({
    ...b,
    lines: b.lines.map((l) => ({ ...l, text: collapseEmoji(l.pattern ? l.text : `(${l.reason})${l.text ? ` ${l.text}` : ''}`) })),
  }));
  const leg = legend(a, size, colors, shareUrl, refusalNoteParts(by), { outcomes: false });
  const paragraphOpts = { layout, voice, clean, spansOf: (text) => refusalSpans(text), countOf: (b) => refusalCount(b, by), perRun: (items) => items.length, markColor: REFUSAL_MARK };
  const fitWith = (h, cap) => fitPage(
    (f, colW) => lineRanges(sentenceParagraphs(batches, a, colors, f, [], by, markStyle, heading, name, h.block.size, paragraphOpts), colW),
    { size, headerH: h.headerH, legendH: leg.height, columns, minFont, maxFont: cap },
  );
  const gapLines = layout === 'flow' ? 0 : 1;
  let head = header(a, size, { gapLines });
  let cap = maxFont || null;
  if (heading > 1 || name > 1) {
    const want = fitWith(head, cap).f / BODY_OF_PROMPT;
    for (let extra = 1; extra <= 4 && head.block.size < want; extra++) {
      const grown = header(a, size, { extraLines: extra, gapLines });
      if (grown.block.size <= head.block.size) break;
      head = grown;
    }
    cap = Math.min(cap || Infinity, head.block.size * BODY_OF_PROMPT);
  }
  const best = fitWith(head, cap);
  const refusers = new Set(found.lines.map((l) => l.response.model)).size;
  const metaParts = [
    `${found.refused} refusal${found.refused === 1 ? '' : 's'} in ${responses.length} repl${responses.length === 1 ? 'y' : 'ies'}`,
    `${refusers} of ${a.rows.length} model${a.rows.length === 1 ? '' : 's'} refused`,
  ];
  const svg = pinTextWidths(renderSvg(best, { a, size, select, responses: responses.length, run, shareUrl, colors, head, leg, sort: by, kind: 'refusals', metaParts, logos: true, markStyle, markColor: REFUSAL_MARK }));
  return {
    svg, font: best.f, columns: best.g.columns, refused: found.refused, replies: found.replies, sort: by, mark: markStyle, layout, voice, clean,
    batches: found.batches.map((b) => ({ key: b.key, label: b.label, refused: b.refused, replies: b.replies, models: b.refusers })),
    exact: textReady(), fill: columnFill(best.placed, best.g),
  };
}

function renderSvg({ f, g, placed }, { a, size, select, responses, run, shareUrl, colors, head, leg, sort = 'group', kind = 'responses', metaParts = null, logos = sort !== 'model', markStyle = 'block', markColor = MARK_BG }) {
  const p = [];
  p.push(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`);
  const ids = sheetIds(a);
  if (logos) p.push(logoDefs(a.rows.map((r) => r.model)));
  // The background is the way back out, so a click on any empty part of a zoomed page returns to the whole sheet.
  p.push(`<view id="${VIEW_ALL}" viewBox="0 0 ${size} ${size}"/>`);
  p.push(link(`#${VIEW_ALL}`, `<rect width="${size}" height="${size}" fill="${COLORS.bg}"/>`, 'the whole sheet'));
  const { headFont, block } = head;
  let y = g.pad + headFont;
  // The line the share card and the keyword card carry, set the way they set it, plus the word that says which of
  // the three images this is. All three come out of one run, and a reader who meets any of them alone should be
  // told the same thing about what it measures. The finding that used to sit here belongs on the card; this page
  // is the replies themselves, and it says so.
  // Tracked the way the cards track theirs — 2px at 26px — scaled with the size rather than fixed at 2px.
  p.push(`<text x="${g.pad}" y="${y.toFixed(1)}" font-family="${MONO}" font-size="${headFont.toFixed(1)}" font-weight="700" letter-spacing="${(headFont * 2 / 26).toFixed(1)}" fill="${COLORS.muted}">${esc(`${brandLine(a)} · ${kind}`)}</text>`);
  const state = { inSlot: false };
  for (const line of block.lines) {
    y += block.size * TITLE_LEADING;
    p.push(titleLine(line, g.pad, y, block.size, state));
  }

  // body: each placed line, fragment by fragment at measured x positions. Every block on a line is drawn before
  // any of its text, so a highlight's amber can never land on top of a glyph.
  const modelAt = new Map();
  const groupAt = new Map();
  const markPad = markStyle === 'wash' ? WASH_PAD : MARK_PAD;
  for (const { col, y: ly, para, range } of placed) {
    if (para.group && !groupAt.has(para.group)) groupAt.set(para.group, { col, y: ly });
    const line = materializeRichInlineLineRange(para.prepared, range);
    // A paragraph may be set in from its column — the sentences page indents a model's run under the wording
    // that heads it — and it was measured at that narrower width, so the drawing starts where the measure did.
    let x = g.pad + col * (g.colW + g.gap) + (para.indent || 0);
    const baseline = g.colTop + ly + f;
    const blocks = [];
    const texts = [];
    for (const frag of line.fragments) {
      x += frag.gapBefore;
      let text = frag.text;
      let tx = x;
      let width = frag.occupiedWidth;
      const model = para.models[frag.itemIndex];
      if (model && !modelAt.has(model)) modelAt.set(model, { col, y: ly });
      const icon = para.icons[frag.itemIndex];
      const logo = para.logos[frag.itemIndex];
      const fs = para.sizes?.[frag.itemIndex] || f; // an item may be set larger than the page, to outrank it
      // the first fragment of a reply, or of the name in front of it: its mark in the reserved space, then the word
      const opens = frag.start.segmentIndex === 0 && frag.start.graphemeIndex === 0 && text.startsWith(NBSP);
      const reserve = para.reserves[frag.itemIndex] || 0;
      let advance = frag.occupiedWidth;
      if (opens && (logo || icon)) {
        blocks.push(logo ? logoMark(x, baseline, fs, logo, para.fills[frag.itemIndex]) : badge(x, baseline, fs, icon));
        text = text.slice(NBSP.length);
        // The mark is drawn at the item's own size, so the space held for it is the one that size needs.
        tx = x + iconAdvance(fs);
        width -= iconAdvance(fs); // the mark's reserved width is not part of the word
      } else if (reserve) {
        // A name or a first word that had to wrap: the space held for the mark is charged to every piece the item
        // breaks into, and the mark is drawn on the first. Without this the rest is shoved along by a mark that
        // is not there — the gap that used to open between a wrapped model name and the badge after it.
        width -= reserve;
        advance -= reserve;
      }
      if (text.trim()) {
        const mark = para.marks[frag.itemIndex];
        if (mark) blocks.push(markRect(tx, baseline, fs, width, mark, para.opacities?.[frag.itemIndex] ?? 1, markPad));
        const rule = para.rules?.[frag.itemIndex];
        if (rule) blocks.push(underlineRect(tx, baseline, fs, width, rule));
        const bold = para.bolds[frag.itemIndex];
        const drawn = `<text x="${tx.toFixed(1)}" y="${baseline.toFixed(1)}" font-family="${SANS}" font-size="${fs}"${bold ? ' font-weight="700"' : ''} fill="${para.fills[frag.itemIndex]}" xml:space="preserve">${esc(text)}</text>`;
        const href = para.links[frag.itemIndex];
        texts.push(href ? link(href, drawn, 'jump to this batch') : drawn);
      }
      x += advance;
    }
    p.push(...blocks, ...texts);
  }
  // A view is a named rectangle, not a drawing, so it can be declared anywhere: they are gathered as the page is
  // laid down and written out here, once every position is known.
  for (const [model, at] of modelAt) p.push(`<view id="${ids.models.get(model)}" viewBox="${viewBoxAt(at, g, size)}"/>`);
  for (const [group, at] of groupAt) p.push(`<view id="${ids.groups.get(group)}" viewBox="${viewBoxAt(at, g, size)}"/>`);

  // legend: model rows over the outcome row on the left, the run summary over the URL on the right
  const { s, o, noteSize, rows, modelRowH, outcomeRowH, bottom, urlSize, urlBaseline, brandSize, brandBaseline } = leg;
  let ly = bottom - outcomeRowH - (rows.length - 1) * modelRowH; // swatch bottom of each model row
  for (const row of rows) {
    const rowBaseline = ly - s * FONT_METRICS.descent;
    for (const item of row) {
      const name = iconRect(g.pad + item.x, rowBaseline, s, item.color)
        + `<text x="${(g.pad + item.x + iconAdvance(s)).toFixed(1)}" y="${rowBaseline.toFixed(1)}" font-family="${SANS}" font-size="${s}" font-weight="700" fill="${item.color}">${esc(item.label)}</text>`;
      // A model the selection left out of the page has nowhere to jump to, so its name is drawn plain.
      p.push(modelAt.has(item.model) ? link(`#${ids.models.get(item.model)}`, name, `${item.label}: jump to its replies`) : name);
    }
    ly += modelRowH;
  }
  let lx = g.pad;
  const textY = urlBaseline.toFixed(1);
  if (leg.outcomes !== false) {
    for (const [label, kind] of OUTCOMES) {
      p.push(badge(lx, urlBaseline, o, kind));
      lx += iconAdvance(o);
      p.push(`<text x="${lx.toFixed(1)}" y="${textY}" font-family="${SANS}" font-size="${o}" fill="${COLORS.text}">${esc(label)}</text>`);
      lx += measureWidth(label, font(o)) + o * 1.6;
    }
  }
  // The note carries the word "highlighted" on a mark of its own, so the legend shows the cue rather than only
  // naming a color: a reader who cannot see amber still meets the same block here that they meet in the text.
  const cue = leg.note.indexOf(MARK_WORD);
  if (cue === -1) p.push(`<text x="${lx.toFixed(1)}" y="${textY}" font-family="${SANS}" font-size="${noteSize}" fill="${COLORS.muted}">${esc(leg.note)}</text>`);
  else {
    const before = leg.note.slice(0, cue);
    const after = leg.note.slice(cue + MARK_WORD.length);
    const wordX = lx + measureWidth(before, font(noteSize));
    p.push(`<text x="${lx.toFixed(1)}" y="${textY}" font-family="${SANS}" font-size="${noteSize}" fill="${COLORS.muted}" xml:space="preserve">${esc(before)}</text>`);
    // The cue is drawn the way the body draws a match — block, wash, rule or ink — or it keys something the page
    // does not do. A style that marks in each model's own colour has no single colour to show, so the cue stands
    // in with the amber the rest of the project means "keyword" with.
    const m = markOf(markStyle, markColor, COLORS.muted, markColor);
    const cueFont = font(noteSize, { bold: m.bold });
    const cueW = measureWidth(MARK_WORD, cueFont);
    if (m.mark) p.push(markRect(wordX, urlBaseline, noteSize, cueW, m.mark, m.markOpacity, markPad));
    if (m.rule) p.push(underlineRect(wordX, urlBaseline, noteSize, cueW, m.rule));
    p.push(`<text x="${wordX.toFixed(1)}" y="${textY}" font-family="${SANS}" font-size="${noteSize}"${m.bold ? ' font-weight="700"' : ''} fill="${m.ink}" xml:space="preserve">${esc(MARK_WORD)}</text>`);
    p.push(`<text x="${(wordX + measureWidth(MARK_WORD, cueFont)).toFixed(1)}" y="${textY}" font-family="${SANS}" font-size="${noteSize}" fill="${COLORS.muted}" xml:space="preserve">${esc(after)}</text>`);
  }
  const urlText = `<text x="${size - g.pad}" y="${urlBaseline.toFixed(1)}" text-anchor="end" font-family="${MONO}" font-size="${urlSize}" fill="${COLORS.text}">${esc(shareUrl)}</text>`;
  const href = linkUrl(shareUrl);
  p.push(href ? link(href, urlText, 'open this eval', true) : urlText);
  const shape = `${a.rows.length} model${a.rows.length > 1 ? 's' : ''} × ${a.variants.length} wording${a.variants.length > 1 ? 's' : ''} × ${a.spec.runs} run${a.spec.runs > 1 ? 's' : ''}`;
  const meta = [...(metaParts || [`${responses} repl${responses === 1 ? 'y' : 'ies'}`, SELECTIONS[select] || select]), shape,
    run.provider === 'mock' ? 'MOCK PROVIDER · NOT REAL MODEL OUTPUT' : null].filter(Boolean).join(' · ');
  // shrunk if needed so it stays inside its column and never reaches the model names on the left
  const metaSize = Math.min(brandSize, (quarterWidth(size) / measureWidth(meta, font(100))) * 100);
  p.push(`<text x="${size - g.pad}" y="${brandBaseline.toFixed(1)}" text-anchor="end" font-family="${SANS}" font-size="${metaSize.toFixed(1)}" fill="${run.provider === 'mock' ? COLORS.accent : COLORS.muted}">${esc(meta)}</text>`);
  p.push('</svg>');
  return p.join('\n');
}
