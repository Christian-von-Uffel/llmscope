import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureText } from '../src/text.js';
import { specId, normalizeSpec } from '../src/spec.js';
import { imagePlace } from '../src/images.js';
import { ROOT, SAMPLES, SAMPLES_DIR, pngName, drawSample, loadSampleRun } from '../scripts/samples.mjs';

// The landing page's images are committed, so a renderer change leaves them behind unless something notices.
// This does: each sample is drawn again from the run committed beside it and has to come out byte for byte the
// same. When it does not, the fix is one command, and the message says which.
test('every landing-page sample is what the current renderers draw from its committed run', async () => {
  assert.ok(await ensureText(), 'the samples are measured against the bundled fonts; without them nothing here is exact');
  const cache = new Map();
  for (const sample of SAMPLES) {
    const drawn = await drawSample(sample, cache);
    const committed = await fs.readFile(path.join(SAMPLES_DIR, sample.file), 'utf8').catch(() => null);
    assert.ok(committed !== null, `${sample.file} is missing: run \`node scripts/build-samples.mjs\` and commit assets/samples/`);
    assert.ok(drawn === committed, `${sample.file} is stale — the renderer has moved since it was drawn: run \`node scripts/build-samples.mjs\` and commit assets/samples/`);
  }
});

// The page shows PNGs, not the SVGs the test above redraws, so each has to be there too.
test('every sample has the PNG the page shows', async () => {
  const exists = async (file) => (await fs.stat(file).catch(() => null))?.size > 0;
  for (const sample of SAMPLES) {
    assert.ok(await exists(path.join(SAMPLES_DIR, pngName(sample.file))), `${pngName(sample.file)} is missing: run \`node scripts/build-samples.mjs\` and commit assets/samples/`);
  }
});

test('the social card is committed beside the samples', async () => {
  const og = await fs.stat(path.join(SAMPLES_DIR, 'og.png')).catch(() => null);
  assert.ok(og && og.size > 0, 'assets/samples/og.png is what a posted link unfurls into; scripts/build-samples.mjs draws it');
});

// The page names each sample twice, by hand: the PNG it shows, and the run the sample was drawn from, open on
// that image — linked from the image and from the end of its caption, so a reader can explore the thing they are
// looking at. Both have to keep up with SAMPLES. The run answers on any host because the build ships
// assets/samples/runs/; the eval it is a generation of has to be bundled too, so its page and its spec are there
// for whoever changes something and runs their own. A run made before ids were minted per run carries no
// spec_id, and its id is its eval's.
test('the landing page shows every sample and links it to the run it was drawn from, open on that image', async () => {
  const page = await fs.readFile(path.join(ROOT, 'site', 'src', 'layouts', 'Site.astro'), 'utf8');
  for (const sample of SAMPLES) {
    const png = pngName(sample.file);
    const run = await loadSampleRun(sample.run);
    const evalId = run.spec_id ?? run.id;
    assert.ok(page.includes(`src="/samples/${png}"`), `Site.astro does not show ${png}`);
    const excerpt = sample.kind === 'responses' && sample.opts.excerpt ? sample.opts.excerpt : null;
    const href = `/${run.id}?image=${sample.kind}${excerpt ? `&amp;excerpt=${excerpt}` : ''}`;
    assert.equal(page.split(`href="${href}"`).length - 1, 2, `Site.astro should link ${png} and its caption to ${href}, the run it was drawn from`);
    assert.ok(imagePlace(sample.kind, run, excerpt), `${href} names an image run ${run.id} has no tab for`);
    const bundled = await fs.readFile(path.join(ROOT, 'evals', `${evalId}.json`), 'utf8').catch(() => null);
    assert.ok(bundled !== null, `evals/${evalId}.json is missing: the eval ${png} was drawn from is not bundled`);
    assert.equal(await specId(normalizeSpec(JSON.parse(bundled))), await specId(normalizeSpec(run.spec)), `evals/${evalId}.json is not the eval ${png} was drawn from`);
  }
});
