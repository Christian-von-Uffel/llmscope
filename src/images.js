// The images a run is drawn as: one list, read wherever an image is written, offered or named.
//
// The CLI writes a run's images from it and names their files by it; the browser builds its tabs from it, draws
// them through it and names its downloads by it; the landing page's samples are drawn through it, and a test
// holds them to it. Adding an image is adding a row here — the word cloud was, and reached both front ends,
// the landing page and the tests without any of them naming it. Until this list existed each of those places kept its
// own copy of it, and the copies drifted: the browser had no ends image and no sentences page, and named every
// download after the eval rather than the run.
import { analyze } from './analyze.js';
import { renderShareCard } from './render-share.js';
import { renderKeywordCard } from './render-keywords.js';
import { renderWordCloud } from './render-wordcloud.js';
import { renderResponseSheet, renderSentenceSheet, renderRefusalSheet, SELECTIONS, EXCERPTS } from './sheet.js';

/** The words a run marks: what it was told to highlight, else the eval's own keywords. An empty edit marks nothing. */
export const markedWords = (run) => run?.highlight ?? run?.spec?.keywords ?? [];

/**
 * The browser's tabs over a run: one per thing a run is read for, in the order the landing page shows them. The
 * first three are the measures — every reply is scored for refusals, keywords and sentiment whatever the eval
 * asked for, so Refusals and Keywords are always there to read, and Sentiment joins them when it was what the
 * eval measured. An image belongs to a tab (its `tab` below); the page adds the readings that are not images —
 * the yes/no grid and the sentences themselves — beside it.
 *
 *   key      what the images name in `tab`
 *   label    the tab's text
 *   measure  the spec.primary this tab is the tab of, for the results card and the grid; null for the others
 *   when     always: every run has the tab · measured: only a run that measured it
 *   hint     what it is, in a sentence: the tab's tooltip
 */
export const TABS = [
  { key: 'refusal', label: 'Refusals', measure: 'refusal', when: 'always', hint: 'which replies declined, in the words they declined with' },
  { key: 'keyword', label: 'Keywords', measure: 'keyword', when: 'always', hint: 'which replies used the marked words, and in which sentences' },
  { key: 'sentiment', label: 'Sentiment', measure: 'sentiment', when: 'measured', hint: 'the tone of the replies per model and wording' },
  { key: 'wordcloud', label: 'Word cloud', measure: null, when: 'always', hint: 'the words the replies were scored on, one cloud per wording' },
  { key: 'responses', label: 'Responses', measure: null, when: 'always', hint: 'every reply on one sheet' },
];

/** The tabs a run has: every tab that is always there, and the measure the run was scored on. */
export const tabsFor = (run) => TABS.filter((t) => t.when === 'always' || t.measure === run?.spec?.primary);

/** The tab of the measure a run was scored on: the results card lives there. */
export const measureTab = (run) => TABS.find((t) => t.measure === (run?.spec?.primary || 'refusal')) || TABS[0];

/** Which tab an image sits under for this run: the results card follows the run's measure, the rest are fixed. */
export const tabOf = (image, run) => (image.tab === 'measure' ? measureTab(run).key : image.tab);

/**
 * One row per image, in the order a run writes them and the browser offers them.
 *
 *   kind    the name everything refers to it by
 *   suffix  what follows the run's id in its filename — out/<id><suffix>.svg, and the browser's downloads
 *   size    the square it is drawn on, in pixels: 1600 for a card, 4096 for a sheet of replies
 *   when    always: every run writes it · marked: a run that marks words writes it · asked: only on request
 *   tab     the browser tab it sits under, by key in TABS — or 'measure' for the results card, which sits under
 *           the tab of whatever the run measured
 *   view    the button that shows it within its tab — Table for a grid of numbers, Matches for the keyword
 *           card, Sentences for a page of them — or null when the tab shows it on its own; the ends of every
 *           reply are the Responses tab's *ends* excerpt there, and a file of their own on disk
 *   titled  whether the prompt/finding heading toggle applies
 *   hint    what it is, in a sentence: the button's tooltip, and a menu's description
 *   draw    the image from a run and the resolved options (see drawImage): {svg, ...whatever the renderer reports},
 *           or {svg: '', empty: why} when there is nothing to draw
 */
export const IMAGES = [
  {
    kind: 'card', suffix: '', size: 1600, when: 'always', tab: 'measure', view: 'Table', titled: true,
    hint: 'the results card: every model by every wording, one number per cell, the prompt or the finding at the head',
    draw: (run, o) => ({ svg: renderShareCard(o.a, { width: o.size, height: o.size, names: o.names, url: o.url, date: o.date, title: o.title }) }),
  },
  {
    kind: 'refusals', suffix: '.refusals', size: 4096, when: 'always', tab: 'refusal', view: 'Sentences', titled: false,
    hint: 'every refused reply cut to the sentence it declined in, under the wording that drew it, with the refusing phrase marked',
    draw: (run, o) => {
      const page = renderRefusalSheet(run, { date: o.date, size: o.size, maxFont: o.maxFont, columns: o.columns, select: o.select, url: o.url, sort: o.sort, mark: o.mark, layout: o.layout, voice: o.voice, clean: o.clean });
      // A page of wordings nobody declined is not an answer: say so instead.
      return page.refused ? page : { ...page, svg: '', empty: `nothing in this run was refused${o.select === 'all' ? '' : ` among ${SELECTIONS[o.select]}`}` };
    },
  },
  {
    kind: 'wordcloud', suffix: '.wordcloud', size: 1600, when: 'always', tab: 'wordcloud', view: null, titled: true,
    hint: 'one cloud per wording: the words replies were scored on, sized by how many replies used them, green or red by which way they scored',
    draw: (run, o) => renderWordCloud(run, o.a, { width: o.size, height: o.size, url: o.url, date: o.date, title: o.title, lexicon: o.lexicon, results: o.results ?? run.results }),
  },
  {
    kind: 'keywords', suffix: '.keywords', size: 1600, when: 'marked', tab: 'keyword', view: 'Matches', titled: true,
    hint: 'which model replied with which marked word for which wording, and in how many of its responses — needs words to mark',
    draw: (run, o) => (o.highlight.length
      ? { svg: renderKeywordCard(run, o.a, o.highlight, { width: o.size, height: o.size, names: o.names, url: o.url, date: o.date, title: o.title, results: o.results ?? run.results }) }
      : { svg: '', empty: 'this run marks no words' }),
  },
  {
    kind: 'sentences', suffix: '.sentences', size: 4096, when: 'asked', tab: 'keyword', view: 'Sentences', titled: false,
    hint: 'every sentence a marked word turned up in, under the wording that produced it — needs words to mark',
    draw: (run, o) => {
      if (!o.highlight.length) return { svg: '', empty: 'this run marks no words' };
      const page = renderSentenceSheet(run, { date: o.date, size: o.size, maxFont: o.maxFont, columns: o.columns, select: o.select, url: o.url, highlight: o.highlight, sort: o.sort, mark: o.mark, layout: o.layout, voice: o.voice, clean: o.clean });
      // A page of headings over nothing is not an answer: say which words came up short instead.
      return page.matches ? page : { ...page, svg: '', empty: `nothing in this run matches ${o.highlight.join(', ')}${o.select === 'all' ? '' : ` among ${SELECTIONS[o.select]}`}` };
    },
  },
  {
    kind: 'responses', suffix: '.responses', size: 4096, when: 'always', tab: 'responses', view: null, titled: false,
    hint: "every reply of the run on one sheet, in its model's colour, with the marked words highlighted",
    draw: (run, o) => renderResponseSheet(run, { date: o.date, size: o.size, maxFont: o.maxFont, columns: o.columns, select: o.select, url: o.url, highlight: o.highlight, excerpt: o.excerpt, sort: o.sort }),
  },
  {
    kind: 'ends', suffix: '.ends', size: 4096, when: 'always', tab: 'responses', view: null, titled: false,
    hint: 'the first and last sentence of every reply: how each model opens and where it lands, side by side',
    draw: (run, o) => renderResponseSheet(run, { date: o.date, size: o.size, maxFont: o.maxFont, columns: o.columns, select: o.select, url: o.url, highlight: o.highlight, excerpt: 'ends', sort: o.sort }),
  },
];

/** The row for a kind, or an error naming the kinds there are. */
export function imageOf(kind) {
  const image = IMAGES.find((i) => i.kind === kind);
  if (!image) throw new Error(`no such image: ${kind} (one of ${IMAGES.map((i) => i.kind).join(', ')})`);
  return image;
}

/** What follows the run's id in this image's filename. */
export const imageSuffix = (kind) => imageOf(kind).suffix;

/**
 * Which image a responses sheet drawn with these options is. The ends of every reply are an image of their own,
 * written by every run beside the full sheet; every other selection or excerpt is the responses image.
 */
export function sheetKind({ select = 'all', excerpt = 'full' } = {}) {
  return excerpt === 'ends' && select === 'all' ? 'ends' : 'responses';
}

/**
 * Where one image of a run sits in the browser: the tab it is under, and for a responses sheet the excerpt that
 * draws it. What an address naming an image — `/<id>?image=refusals` — opens on. Null when there is no such
 * image, or when this run has no tab for it: the keyword card of a run that measured sentiment still has one,
 * but the sentiment card of a refusal run does not.
 * @returns {{tab: string, excerpt: string|null}|null}
 */
export function imagePlace(kind, run, excerpt = null) {
  const image = IMAGES.find((i) => i.kind === kind);
  if (!image) return null;
  const tab = tabOf(image, run);
  if (!tabsFor(run).some((t) => t.key === tab)) return null;
  if (image.tab !== 'responses') return { tab, excerpt: null };
  // The ends of every reply are their own image; the responses sheet is any other excerpt, the whole text unless
  // the address names one.
  if (kind === 'ends') return { tab, excerpt: 'ends' };
  return { tab, excerpt: EXCERPTS[excerpt] && sheetKind({ excerpt }) === 'responses' ? excerpt : 'full' };
}

/** The images this run writes now, in order: every run's, plus the one about marked words once there are words. */
export function imagesFor(run) {
  const marked = markedWords(run).length > 0;
  return IMAGES.filter((i) => i.when === 'always' || (i.when === 'marked' && marked));
}

/**
 * Draw one image of a run. Every option has the default the CLI and the browser both draw with, so a caller that
 * passes nothing gets the image a run writes; the CLI's flags pass through as options.
 *
 * @param {string} kind one of IMAGES
 * @param {object} run a saved run
 * @param {object} [opts]
 * @param {object} [opts.a] the run's analysis, when the caller has it already
 * @param {object} [opts.names] model display names, from the catalogue
 * @param {string|null} [opts.url] the share link to print, else the run's own
 * @param {string|null} [opts.date] what the month stamp reads; the run's finish by default
 * @param {'prompt'|'finding'} [opts.title] the heading of a titled image
 * @param {string[]} [opts.highlight] the words to mark; what the run marks by default
 * @param {number} [opts.size] the square to draw on; the image's own by default
 * @param {string} [opts.select] which replies a sheet reads (see SELECTIONS)
 * @param {string} [opts.excerpt] how much of each reply the responses sheet shows (see EXCERPTS)
 * @param {string} [opts.sort] how a sheet is batched (see SORTS and SENTENCE_SORTS)
 * @param {object[]} [opts.results] the replies the keyword card and the word cloud count, when narrowed
 * @param {string|null} [opts.lexicon] the word list the word cloud counts against: 'afinn' or 'builtin'; the run's own by default (see words.js)
 * @returns {{kind: string, svg: string, empty?: string}} plus whatever the renderer reports about the page
 */
export function drawImage(kind, run, { a = null, names = {}, url = null, date = run?.finished_at ?? null, title = 'prompt', highlight = null, size = null, select = 'all', excerpt = 'full', sort = 'group', results = null, lexicon = null, maxFont = null, columns = null, mark, layout, voice, clean } = {}) {
  const image = imageOf(kind);
  const o = { a: a || analyze(run), names, url, date, title, highlight: highlight ?? markedWords(run), size: size || image.size, select, excerpt, sort, results, lexicon, maxFont, columns, mark, layout, voice, clean };
  return { kind, ...image.draw(run, o) };
}
