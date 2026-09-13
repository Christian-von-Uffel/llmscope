import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureText } from '../src/text.js';
import { SAMPLES, SAMPLES_DIR, pngName, drawSample } from '../scripts/samples.mjs';

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

test('the social card is drawn from the card sample and committed beside it', async () => {
  const og = await fs.stat(path.join(SAMPLES_DIR, 'og.png')).catch(() => null);
  assert.ok(og && og.size > 0, 'assets/samples/og.png is what a posted link unfurls into; scripts/build-samples.mjs draws it');
});
