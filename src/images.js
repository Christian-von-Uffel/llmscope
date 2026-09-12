// The images a run is drawn as: one list, read wherever an image is written, offered or named.
//
// The CLI writes a run's images from it and names their files by it; the browser builds its tabs from it, draws
// them through it and names its downloads by it; the landing page's samples are drawn through it, and a test
// holds them to it. Adding an image is adding a row here. Until this list existed each of those places kept its
// own copy of it, and the copies drifted: the browser had no ends image and no sentences page, and named every
// download after the eval rather than the run.
import { analyze } from './analyze.js';
import { renderShareCard } from './render-share.js';
import { renderKeywordCard } from './render-keywords.js';
import { renderResponseSheet, renderSentenceSheet, SELECTIONS } from './sheet.js';

/** The words a run marks: what it was told to highlight, else the eval's own keywords. An empty edit marks nothing. */
export const markedWords = (run) => run?.highlight ?? run?.spec?.keywords ?? [];

/**
 * One row per image, in the order a run writes them and the browser offers them.
 *
 *   kind    the name everything refers to it by
 *   suffix  what follows the run's id in its filename — out/<id><suffix>.svg, and the browser's downloads
 *   size    the square it is drawn on, in pixels: 1600 for a card, 4096 for a sheet of replies
 *   when    always: every run writes it · marked: a run that marks words writes it · asked: only on request
 *   tab     the browser's tab label, or null for an image reached another way — the ends of every reply are the
 *           Responses tab's *ends* excerpt there, and a file of their own on disk
 *   titled  whether the prompt/finding heading toggle applies
 *   hint    what it is, in a sentence: the tab's tooltip, and a menu's description
 *   draw    the image from a run and the resolved options (see drawImage): {svg, ...whatever the renderer reports},
 *           or {svg: '', empty: why} when there is nothing to draw
 */
export const IMAGES = [
  {
    kind: 'card', suffix: '', size: 1600, when: 'always', tab: 'Card', titled: true,
    hint: 'the results card: one number per model per wording, the prompt or the finding at the head',
    draw: (run, o) => ({ svg: renderShareCard(o.a, { width: o.size, height: o.size, names: o.names, url: o.url, date: o.date, title: o.title }) }),
  },
  {
    kind: 'keywords', suffix: '.keywords', size: 1600, when: 'marked', tab: 'Keywords', titled: true,
    hint: 'which words landed on which group, beside which model family reached for them most — needs words to mark',
    draw: (run, o) => (o.highlight.length
      ? { svg: renderKeywordCard(run, o.a, o.highlight, { width: o.size, height: o.size, names: o.names, url: o.url, date: o.date, title: o.title, results: o.results ?? run.results }) }
      : { svg: '', empty: 'this run marks no words' }),
  },
  {
    kind: 'sentences', suffix: '.sentences', size: 4096, when: 'asked', tab: 'Sentences', titled: false,
    hint: 'every sentence a marked word turned up in, under the wording that produced it — needs words to mark',
    draw: (run, o) => {
      if (!o.highlight.length) return { svg: '', empty: 'this run marks no words' };
      const page = renderSentenceSheet(run, { size: o.size, maxFont: o.maxFont, columns: o.columns, select: o.select, url: o.url, highlight: o.highlight, sort: o.sort, mark: o.mark, layout: o.layout, voice: o.voice, clean: o.clean });
      // A page of headings over nothing is not an answer: say which words came up short instead.
      return page.matches ? page : { ...page, svg: '', empty: `nothing in this run matches ${o.highlight.join(', ')}${o.select === 'all' ? '' : ` among ${SELECTIONS[o.select]}`}` };
    },
  },
  {
    kind: 'responses', suffix: '.responses', size: 4096, when: 'always', tab: 'Responses', titled: false,
    hint: "every reply of the run on one sheet, in its model's colour, with the marked words highlighted",
    draw: (run, o) => renderResponseSheet(run, { size: o.size, maxFont: o.maxFont, columns: o.columns, select: o.select, url: o.url, highlight: o.highlight, excerpt: o.excerpt, sort: o.sort }),
  },
  {
    kind: 'ends', suffix: '.ends', size: 4096, when: 'always', tab: null, titled: false,
    hint: 'the first and last sentence of every reply: how each model opens and where it lands, side by side',
    draw: (run, o) => renderResponseSheet(run, { size: o.size, maxFont: o.maxFont, columns: o.columns, select: o.select, url: o.url, highlight: o.highlight, excerpt: 'ends', sort: o.sort }),
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
 * @param {object[]} [opts.results] the replies the keyword card counts, when narrowed
 * @returns {{kind: string, svg: string, empty?: string}} plus whatever the renderer reports about the page
 */
export function drawImage(kind, run, { a = null, names = {}, url = null, date = run?.finished_at ?? null, title = 'prompt', highlight = null, size = null, select = 'all', excerpt = 'full', sort = 'group', results = null, maxFont = null, columns = null, mark, layout, voice, clean } = {}) {
  const image = imageOf(kind);
  const o = { a: a || analyze(run), names, url, date, title, highlight: highlight ?? markedWords(run), size: size || image.size, select, excerpt, sort, results, maxFont, columns, mark, layout, voice, clean };
  return { kind, ...image.draw(run, o) };
}
