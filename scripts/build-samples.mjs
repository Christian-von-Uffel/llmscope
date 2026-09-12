// Regenerate the sample images the landing page shows: node scripts/build-samples.mjs
//
// They are drawn from the runs committed in assets/samples/runs/ with the shipping renderers, through the same
// catalogue the CLI writes from, so the page can never advertise an image the tool no longer draws — and
// test/samples.test.js fails the moment a renderer change leaves one behind. Committing the SVGs rather than
// rendering them in the browser keeps the landing page instant and keyless: nobody should need an OpenRouter
// account to see what the output looks like.
import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureText, fontFilePaths, FONT_SANS } from '../src/text.js';
import { SAMPLES, SAMPLES_DIR, drawSample } from './samples.mjs';

/**
 * The social card, from the results card that was just drawn. Cards are square because they are made to be
 * read, and every feed crops a square to its own ratio — so rather than let one crop the numbers off, the card
 * is drawn whole onto a 1200x630 ground in the colour it already carries.
 *
 * It is written here, next to the images it is made from, because it is committed like they are: the deploy
 * copies it and never renders it, so hosting the site needs no native renderer at all.
 */
async function socialCard(svg, file) {
  const { Resvg } = await import('@resvg/resvg-js');
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const [W, H] = [1200, 630];
  const square = new Resvg(svg, {
    font: { fontFiles: fontFilePaths(), loadSystemFonts: true, defaultFontFamily: FONT_SANS },
    fitTo: { mode: 'height', value: H },
  }).render().asPng();
  const ctx = createCanvas(W, H).getContext('2d');
  ctx.fillStyle = '#0f1113'; // the card's own background, so the ground it sits on is not a seam
  ctx.fillRect(0, 0, W, H);
  const img = await loadImage(square);
  ctx.drawImage(img, (W - img.width) / 2, 0);
  const png = ctx.canvas.toBuffer('image/png');
  await fs.writeFile(file, png);
  console.log(`${'og.png'.padEnd(16)} from card.svg  ${(png.length / 1024).toFixed(0)}KB  ${W}x${H}`);
}

if (!(await ensureText())) throw new Error('fonts could not be loaded: the samples would be laid out on estimated widths');
await fs.mkdir(SAMPLES_DIR, { recursive: true });
const cache = new Map();
const written = {};
for (const sample of SAMPLES) {
  const svg = await drawSample(sample, cache);
  written[sample.file] = svg;
  await fs.writeFile(path.join(SAMPLES_DIR, sample.file), svg);
  console.log(`${sample.file.padEnd(16)} ${sample.run}  ${(svg.length / 1024).toFixed(0)}KB`);
}
await socialCard(written['card.svg'], path.join(SAMPLES_DIR, 'og.png'));
