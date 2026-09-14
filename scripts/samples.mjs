// The landing page's sample images: which committed run each is drawn from, and how.
//
// Read by scripts/build-samples.mjs, which writes them, and by test/samples.test.js, which fails when a committed
// sample no longer matches what the renderers draw — the check that keeps the landing page from advertising an
// image the tool no longer makes. The runs live beside the images rather than in out/, which is not committed, so
// anyone with the repository can redraw them and the test can hold them to it.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rescoreRun } from '../src/engine.js';
import { drawImage } from '../src/images.js';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const SAMPLES_DIR = path.join(ROOT, 'assets', 'samples');
export const RUNS_DIR = path.join(SAMPLES_DIR, 'runs');

// The page shows each sample as a PNG this wide, rasterized beside the SVG with the bundled fonts. An <img>
// cannot load the page's fonts, and every line of these images is fitted to the width DejaVu measured it at, so
// whatever font a browser substituted inside an <img> was stretched to fit. Twice the width of the slot the page
// draws them in, so they stay sharp on a dense screen.
export const PNG_WIDTH = 1200;
export const pngName = (file) => file.replace(/\.svg$/, '.png');

// Each sample answers a different question, so they come from different runs rather than views of one: a
// refusal card that splits by identity, the words card of that same run — the answer that the refusal grid
// no longer gives when nothing is refused — a sheet of replies where the marks actually land, the ends of
// one reply per model and wording in a run with enough of both for the sheet to read across as well as down,
// and the keyword card of a run where two models reached for a word on one wording and not the others. Every
// one is drawn through the catalogue, at the defaults a run is drawn with, except where a sample says
// otherwise: no display names, so the samples need no catalogue fetch.
export const SAMPLES = [
  // No title given, so the sample is the card a run draws by default: the prompt at the head, no finding stated.
  { file: 'card.svg', run: 'D5a3G9', kind: 'card', opts: {} },
  // The words card of the same run, so the page shows the two images one run leaves side by side. That run was
  // scored with the built-in list before AFINN-165 became the default, so the sample names the default list
  // rather than following the run, as `llmscope render D5a3G9 --lexicon afinn` would.
  { file: 'words.svg', run: 'D5a3G9', kind: 'words', opts: { lexicon: 'afinn' } },
  // Only the replies that matched, cut to the sentences that matched: the marks, where they land.
  { file: 'responses.svg', run: 'dbo50g', kind: 'responses', opts: { size: 1400, select: 'matched', excerpt: 'matches' } },
  // The ends of every reply, narrowed to each model's first reply to each wording: the run repeated every prompt
  // three times, and three of everything on a page this size is clutter where one reads. It is the sheet
  // `llmscope sheet GK1zvv --per-cell --excerpt ends` draws; every run writes the unnarrowed one beside its
  // full sheet.
  { file: 'ends.svg', run: 'GK1zvv', kind: 'responses', opts: { size: 1400, select: 'per-cell', excerpt: 'ends' } },
  // The keyword card: each model, the wording that made it reply with a marked word, the word itself, and a dot
  // per response. The run marks four words — the eval's three and "myth", added after reading the replies — and the card
  // is drawn over all four, as `llmscope keywords mwbXAp` draws it.
  { file: 'keywords.svg', run: 'mwbXAp', kind: 'keywords', opts: {} },
];

/** A sample's run, scored by the current rules, the way every command loads one. */
export async function loadSampleRun(id) {
  const run = JSON.parse(await fs.readFile(path.join(RUNS_DIR, `${id}.results.json`), 'utf8'));
  rescoreRun(run);
  return run;
}

/** One sample as SVG text. `cache` holds loaded runs across samples drawn from the same one. */
export async function drawSample(sample, cache = new Map()) {
  if (!cache.has(sample.run)) cache.set(sample.run, await loadSampleRun(sample.run));
  const { svg, empty } = drawImage(sample.kind, cache.get(sample.run), sample.opts);
  if (!svg) throw new Error(`${sample.file}: nothing to draw (${empty})`);
  return svg;
}
