// Regenerate the sample images the landing page shows: node scripts/build-samples.mjs
//
// They are drawn from the runs committed in assets/samples/runs/ with the shipping renderers, through the same
// catalogue the CLI writes from, so the page can never advertise an image the tool no longer draws — and
// test/samples.test.js fails the moment a renderer change leaves one behind. Committing the images rather than
// rendering them in the browser keeps the landing page instant and keyless: nobody should need an OpenRouter
// account to see what the output looks like.
//
// Each sample is written twice. The SVG is exactly what the renderer drew, and what the test holds it to. The
// PNG beside it is what the page shows, set in the fonts the layout was measured with — see PNG_WIDTH in
// scripts/samples.mjs for why an <img> of the SVG itself came out stretched.
import fs from 'node:fs/promises';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { ensureText, fontFilePaths, FONT_FILES, FONT_SANS } from '../src/text.js';
import { SAMPLES, SAMPLES_DIR, PNG_WIDTH, pngName, drawSample } from './samples.mjs';

/**
 * Throws unless resvg draws something with each bundled file on its own. Given no font at all it draws nothing
 * where the text should be, and given only the system's it sets a sample in Helvetica and Menlo and fits them
 * to the widths DejaVu was measured at — which is how every sample on the page once came out with its text
 * stretched. One file at a time, because a face that is missing is otherwise stood in for by any face that did
 * load.
 */
function assertFontsRender(fontFiles) {
  fontFiles.forEach((file, i) => {
    const { family, weight } = FONT_FILES[i];
    const probe = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><text x="10" y="44" font-family="'${family}'" font-size="36" font-weight="${weight}">Wg</text></svg>`;
    const drew = new Resvg(probe, { font: { fontFiles: [file], loadSystemFonts: false, defaultFontFamily: family } }).render().pixels.some((v) => v !== 0);
    if (!drew) throw new Error(`${family} ${weight} did not load into the rasterizer from ${file}: the samples would be drawn without it`);
  });
}

/** The image as a PNG `width` pixels wide, set in FONTS — filled in below, once the fonts are found. */
const rasterize = (svg, width) => new Resvg(svg, { font: FONTS, fitTo: { mode: 'width', value: width } }).render().asPng();

/**
 * The social card, from the results card that was just drawn. Cards are square because they are made to be
 * read, and every feed crops a square to its own ratio — so rather than let one crop the numbers off, the card
 * is drawn whole onto a 1200x630 ground in the colour it already carries.
 *
 * It is written here, next to the images it is made from, because it is committed like they are: the deploy
 * copies it and never renders it, so hosting the site needs no native renderer at all.
 */
async function socialCard(svg, file) {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const [W, H] = [1200, 630];
  const square = new Resvg(svg, { font: FONTS, fitTo: { mode: 'height', value: H } }).render().asPng();
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
// The rasterizer's fonts: the bundled files and nothing else, and only now, since fontFilePaths() is empty until
// ensureText() has found them. No system fonts, so nothing can stand in for a face; the probe, so a face that
// fails to load stops the build instead of quietly leaving its text out.
const FONTS = { fontFiles: fontFilePaths(), loadSystemFonts: false, defaultFontFamily: FONT_SANS };
assertFontsRender(FONTS.fontFiles);
await fs.mkdir(SAMPLES_DIR, { recursive: true });
const cache = new Map();
const written = {};
for (const sample of SAMPLES) {
  const svg = await drawSample(sample, cache);
  written[sample.file] = svg;
  await fs.writeFile(path.join(SAMPLES_DIR, sample.file), svg);
  const png = rasterize(svg, PNG_WIDTH);
  await fs.writeFile(path.join(SAMPLES_DIR, pngName(sample.file)), png);
  console.log(`${sample.file.padEnd(16)} ${sample.run}  ${(svg.length / 1024).toFixed(0)}KB  → ${pngName(sample.file)} ${(png.length / 1024).toFixed(0)}KB`);
}
await socialCard(written['card.svg'], path.join(SAMPLES_DIR, 'og.png'));
