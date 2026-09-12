// Regenerate the three sample images the landing page shows: node scripts/build-samples.mjs
//
// They are drawn from real runs in out/ with the shipping renderers, so the page can never advertise an image
// the tool no longer draws. Committing the SVGs rather than rendering them in the browser keeps the landing page
// instant and keyless — nobody should need an OpenRouter account to see what the output looks like.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from '../src/analyze.js';
import { renderShareCard } from '../src/render-share.js';
import { renderKeywordCard } from '../src/render-keywords.js';
import { renderResponseSheet } from '../src/sheet.js';
import { rescoreRun } from '../src/engine.js';
import { ensureText, fontFilePaths, FONT_SANS } from '../src/text.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, 'assets', 'samples');

// Each sample answers a different question, so they come from three different runs rather than three views of
// one: a refusal card that splits by identity, a keyword grid with enough marked words to fill it, and a sheet
// of replies where the marks actually land.
const SAMPLES = [
  // No title given, so the sample is the card a run draws by default: the prompt at the head, no finding stated.
  { file: 'card.svg', run: 'D5a3G9', draw: (run) => renderShareCard(analyze(run), { names: {}, date: run.finished_at }) },
  { file: 'keywords.svg', run: 'dbo50g', draw: (run) => renderKeywordCard(run, analyze(run), terms(run), { names: {}, date: run.finished_at, title: 'prompt' }) },
  { file: 'responses.svg', run: 'dbo50g', draw: (run) => renderResponseSheet(run, { size: 1400, select: 'matched', excerpt: 'matches', highlight: terms(run) }).svg },
];

const terms = (run) => run.highlight?.length ? run.highlight : (run.spec.keywords || []);

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

async function load(id) {
  const run = JSON.parse(await fs.readFile(path.join(ROOT, 'out', `${id}.results.json`), 'utf8'));
  rescoreRun(run);
  return run;
}

await ensureText();
await fs.mkdir(OUT, { recursive: true });
const cache = new Map();
const written = {};
for (const { file, run: id, draw } of SAMPLES) {
  if (!cache.has(id)) cache.set(id, await load(id));
  const svg = draw(cache.get(id));
  written[file] = svg;
  await fs.writeFile(path.join(OUT, file), svg);
  console.log(`${file.padEnd(16)} ${id}  ${(svg.length / 1024).toFixed(0)}KB`);
}
await socialCard(written['card.svg'], path.join(OUT, 'og.png'));
