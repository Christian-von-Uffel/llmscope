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
import { ensureText, fontFilePaths, measureWidth, font, FONT_FILES, FONT_METRICS, FONT_MONO, FONT_SANS } from '../src/text.js';
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
 * The social card: a hook, not a result. A results card shrunk into a feed's 1200x630 thumbnail is too small to
 * read, so what a posted link unfurls into is the page's microscope and three words — on the dark ground the
 * cards and the favicon use, with the favicon's amber on the word the tool is about.
 *
 * It is written here, beside the samples, because it is committed like they are: the deploy copies it and never
 * renders it, so hosting the site needs no native renderer at all.
 */
async function socialCard(file) {
  const [W, H] = [1200, 630];
  const [GROUND, INK, AMBER, MUTED] = ['#0f1113', '#f5f5f1', '#e0a44a', '#8a9099'];
  // The hero drawing (#ico-scope-xl in site/src/layouts/Site.astro): its strokes span x 18–69, y 8–80 of a
  // 96-unit box, so it is centred on that span rather than on the box.
  const scale = 5.4;
  const [cx, cy] = [305, H / 2];
  const scope = `<g transform="translate(${cx - 43.5 * scale} ${cy - 44 * scale}) scale(${scale})">
    <g fill="none" stroke="${INK}" stroke-width="3.1" stroke-linecap="round" stroke-linejoin="round">
      <rect x="42" y="8" width="7" height="10" rx="2.5"/><rect x="38" y="16" width="15" height="24" rx="4"/>
      <path d="M45.5 40v8"/><path d="M18 56h34"/><path d="M53 22c15 8 15 32 3 40"/><circle cx="67" cy="42" r="4"/>
      <path d="M56 62v8"/><path d="M34 70h28l7 10H27z"/>
    </g>
    <circle cx="45.5" cy="56" r="3.6" fill="${AMBER}"/>
  </g>`;
  // Two lines set as large as the room right of the drawing allows, measured rather than guessed.
  const [left, right] = [590, 80];
  const room = W - left - right;
  const size = Math.min(128, Math.floor(room / Math.max(measureWidth('See AI', font(100, { bold: true })), measureWidth('model bias', font(100, { bold: true }))) * 100));
  const lead = size * 1.08;
  const small = 34;
  const block = lead + size * FONT_METRICS.ascent + small * 2.1;
  const top = (H - block) / 2 + size * FONT_METRICS.ascent;
  const model = measureWidth('model ', font(size, { bold: true }));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${GROUND}"/>
  ${scope}
  <g font-family="'${FONT_SANS}'" font-weight="700" font-size="${size}" letter-spacing="-0.01em">
    <text x="${left}" y="${top}" fill="${INK}">See AI</text>
    <text x="${left}" y="${top + lead}" fill="${INK}">model</text>
    <text x="${left + model}" y="${top + lead}" fill="${AMBER}">bias</text>
  </g>
  <text x="${left + 4}" y="${top + lead + small * 2.1}" font-family="'${FONT_MONO}'" font-size="${small}" fill="${MUTED}">llmscope.dev</text>
</svg>`;
  const png = new Resvg(svg, { font: FONTS }).render().asPng();
  await fs.writeFile(file, png);
  console.log(`${'og.png'.padEnd(16)} hook  ${(png.length / 1024).toFixed(0)}KB  ${W}x${H}`);
}

if (!(await ensureText())) throw new Error('fonts could not be loaded: the samples would be laid out on estimated widths');
// The rasterizer's fonts: the bundled files and nothing else, and only now, since fontFilePaths() is empty until
// ensureText() has found them. No system fonts, so nothing can stand in for a face; the probe, so a face that
// fails to load stops the build instead of quietly leaving its text out.
const FONTS = { fontFiles: fontFilePaths(), loadSystemFonts: false, defaultFontFamily: FONT_SANS };
assertFontsRender(FONTS.fontFiles);
await fs.mkdir(SAMPLES_DIR, { recursive: true });
const cache = new Map();
for (const sample of SAMPLES) {
  const svg = await drawSample(sample, cache);
  await fs.writeFile(path.join(SAMPLES_DIR, sample.file), svg);
  const png = rasterize(svg, PNG_WIDTH);
  await fs.writeFile(path.join(SAMPLES_DIR, pngName(sample.file)), png);
  console.log(`${sample.file.padEnd(16)} ${sample.run}  ${(svg.length / 1024).toFixed(0)}KB  → ${pngName(sample.file)} ${(png.length / 1024).toFixed(0)}KB`);
}
await socialCard(path.join(SAMPLES_DIR, 'og.png'));
