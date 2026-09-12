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

// Each sample answers a different question, so they come from different runs rather than four views of one: a
// refusal card that splits by identity, a keyword grid with enough marked words to fill it, a sheet of replies
// where the marks actually land, and the ends of every reply in a run with enough models for where each one
// opens and lands to be the point. Every one is drawn through the catalogue, at the defaults a run is drawn
// with, except where a sample says otherwise: no display names, so the samples need no catalogue fetch.
export const SAMPLES = [
  // No title given, so the sample is the card a run draws by default: the prompt at the head, no finding stated.
  { file: 'card.svg', run: 'D5a3G9', kind: 'card', opts: {} },
  { file: 'keywords.svg', run: 'dbo50g', kind: 'keywords', opts: { title: 'prompt' } },
  // Only the replies that matched, cut to the sentences that matched: the marks, where they land.
  { file: 'responses.svg', run: 'dbo50g', kind: 'responses', opts: { size: 1400, select: 'matched', excerpt: 'matches' } },
  // The image every run writes beside the full sheet, as `llmscope sheet <id> --excerpt ends` re-makes it.
  { file: 'ends.svg', run: '66k5km', kind: 'ends', opts: { size: 1400 } },
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
