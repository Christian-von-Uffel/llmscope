// The landing page's sample images: which committed run each is drawn from, and how.
//
// Read by scripts/build-samples.mjs, which writes them, and by test/samples.test.js, which fails when a committed
// sample no longer matches what the renderers draw — the check that keeps the landing page from advertising an
// image the tool no longer makes. The runs live beside the images rather than in out/, which is not committed, so
// anyone with the repository can redraw them and the test can hold them to it. D5a3G9, the run the first samples
// were drawn from, stays there although nothing is drawn from it now: test/api.test.js and test/cli.test.js load
// it as a saved run.
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
// refusal card where the declines fall on two of four wordings and come from two labs' models, the refusals of a
// run where every model declined one wording in words of its own, the word cloud of a run nobody refused — the
// answer the refusal grid no longer gives when nothing is refused — a sheet of replies where the marks actually
// land, the ends of every reply in a run with several wordings and enough models for the sheet to read across as
// well as down, and the keyword card of a run where two models reached for a word on one wording and not the
// others. Every one is drawn through the catalogue, at the defaults a run is drawn with, except where a sample
// says otherwise: no display names, so the samples need no catalogue fetch.
export const SAMPLES = [
  // No title given, so the card has the prompt at its head rather than the finding the run was saved with.
  { file: 'card.svg', run: 'PJPlrU', kind: 'card', opts: {} },
  // Every model declined one wording and they split over the rest: under each wording, who declined and the
  // sentence they declined in.
  { file: 'refusals.svg', run: 'qjbzF1', kind: 'refusals', opts: { size: 1400 } },
  // A run nobody refused, so what tells the wordings apart is the words the replies reached for.
  { file: 'wordcloud.svg', run: 'cYNnYB', kind: 'wordcloud', opts: {} },
  // Only the replies that matched, cut to the sentences that matched: the marks, where they land.
  { file: 'responses.svg', run: 'dbo50g', kind: 'responses', opts: { size: 1400, select: 'matched', excerpt: 'matches' } },
  // The image every run writes beside the full sheet, as `llmscope sheet <id> --excerpt ends` re-makes it.
  { file: 'ends.svg', run: 'GK1zvv', kind: 'ends', opts: { size: 1400 } },
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
