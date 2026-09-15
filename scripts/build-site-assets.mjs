// Everything the website serves as a plain file, gathered into site/public/: node scripts/build-site-assets.mjs
//
// All of it already exists somewhere else in the repo, so none of it is committed twice — this is the copy
// step, and the directories it writes are generated. It runs before every build and every dev server.
//
//   /fonts/*.ttf          the three DejaVu faces the cards are measured with, from node_modules
//   /samples/*.png        the landing page's example images, from assets/samples/ — the PNGs the page shows
//   /samples/runs/*.json  the runs they are drawn from, which the images link to, from assets/samples/runs/
//   /evals/<id>.json      the bundled evals, so a share link naming one resolves on the deployed site
//   /og.png               the social card, committed alongside the samples it is drawn from
//
// site/public/favicon.svg is committed rather than generated, so it is left alone here.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { FONT_FILES } from '../src/text.js';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC = path.join(ROOT, 'site', 'public');
const GENERATED = ['fonts', 'samples', 'evals', 'og.png'];

/** Copy `files` into `<public>/<dir>`, reporting what landed. */
async function into(dir, files) {
  const target = path.join(PUBLIC, dir);
  await fs.mkdir(target, { recursive: true });
  let bytes = 0;
  for (const from of files) {
    const to = path.join(target, path.basename(from));
    await fs.copyFile(from, to);
    bytes += (await fs.stat(to)).size;
  }
  console.log(`${('/' + dir).padEnd(10)} ${String(files.length).padStart(3)} files  ${(bytes / 1024).toFixed(0)}KB`);
}

// Only what this script writes is cleared, so a sample or an eval deleted from the repo also leaves the site
// while the committed favicon stays put.
for (const name of GENERATED) await fs.rm(path.join(PUBLIC, name), { recursive: true, force: true });
await fs.mkdir(PUBLIC, { recursive: true });

// The fonts the browser draws with have to be the ones the layout was measured against, so they are resolved
// through the same list src/text.js registers under Node rather than named a second time here.
await into('fonts', FONT_FILES.map((f) => require.resolve(f.pkg)));

const dirFiles = async (dir, keep) =>
  (await fs.readdir(path.join(ROOT, dir))).filter(keep).map((f) => path.join(ROOT, dir, f));

// The PNGs only: the SVGs beside them are what the test redraws, not what the page shows.
await into('samples', await dirFiles('assets/samples', (f) => f.endsWith('.png') && f !== 'og.png'));
// The runs the samples are drawn from, which each sample links to, so the link opens on a host with no registry.
await into('samples/runs', await dirFiles('assets/samples/runs', (f) => f.endsWith('.results.json')));
await into('evals', await dirFiles('evals', (f) => f.endsWith('.json')));

// The social card sits at the root of the site because that is the URL the meta tags name. It is drawn by
// scripts/build-samples.mjs and committed, so this build — and the hosted one — only ever copies it.
const og = path.join(ROOT, 'assets', 'samples', 'og.png');
if (await fs.stat(og).catch(() => null)) {
  await fs.copyFile(og, path.join(PUBLIC, 'og.png'));
  console.log(`/og.png      1 file   ${((await fs.stat(og)).size / 1024).toFixed(0)}KB`);
} else {
  console.warn('/og.png      missing — run `node scripts/build-samples.mjs` to draw it');
}
