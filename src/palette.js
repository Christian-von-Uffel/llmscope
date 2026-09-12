// Per-model text colors for the responses sheet. Hues are spread evenly around the OKLCH wheel at one fixed
// lightness and chroma, so every color is equally bright (none shouts) and all of them clear WCAG AA contrast
// (≥ 4.5:1) on the dark background. Models are then dealt hues from opposite halves of the wheel in turn, so the
// models that sit next to each other on the sheet and in the legend are never the two closest hues. Names stay
// bold next to the color, so hue is never the only cue.
//
// The chroma is as high as one lightness allows. A near-white tint reads as a color while it runs under a whole
// paragraph, which is how the responses sheet uses it — but the sentences page sets its text in one neutral and
// leaves the color to the name alone, and there a pale tint on a short bold word reads as white that went
// slightly wrong. Past C 0.14 at this lightness the blues and greens fall outside sRGB and get clipped, which
// costs the palette the equal lightness it is built on: the numbers are the most saturated pair that keeps the
// realised lightnesses inside 0.012 of each other, at 8.7:1 or better on the page.
//
// Taking each hue to its own sRGB ceiling instead buys more saturation, and costs contrast — the worst color on
// the page drops from 8.7:1 to 7.5:1, because the hues with room to spare have it below this lightness. The
// palette is read as text, so the contrast is worth more than the saturation.

import { contrast as contrastRatio } from './a11y.js';

const BG = '#0f1113';

function oklchToHex(L, C, hDeg) {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  const toSrgb = (c) => { const v = Math.max(0, Math.min(1, c)); return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055; };
  return '#' + lin.map((c) => Math.round(toSrgb(c) * 255).toString(16).padStart(2, '0')).join('');
}

/**
 * WCAG contrast, against this page's own background unless told otherwise. The ratio is a11y.js's, so the
 * palette is scored with the same numbers the color-vision checks report back.
 */
export const contrast = (hexA, hexB = BG) => contrastRatio(hexA, hexB);

/** Evenly spaced hues; starts at 60° so the first colors avoid the red/green used for outcomes. */
export function modelPalette(n, { lightness = 0.78, chroma = 0.14, offset = 60 } = {}) {
  return Array.from({ length: Math.max(1, n) }, (_, i) => oklchToHex(lightness, chroma, (offset + (360 * i) / Math.max(1, n)) % 360));
}

/** Distance between two positions around a list that wraps: the last model neighbours the first. */
const around = (a, b, n) => Math.min(Math.abs(a - b), n - Math.abs(a - b));

/** How hard the search tries for one spacing before settling for the next one down. A palette is not a puzzle. */
const SEARCH_BUDGET = 20000;

/**
 * The deal: which hue each model takes, for a run of n models.
 *
 * Evenly spaced hues leave n neighbouring pairs on the wheel, and those pairs are the ones a reader has the most
 * trouble telling apart. They cannot be removed — n hues on a circle always have n neighbours — so the deal
 * decides where they land instead: as many models apart as the count allows, counting around the list, because
 * the list wraps (the legend's last name sits beside its first, and a batch can show any two models together).
 *
 * The spacing asked for starts one below the ceiling on an even count: n/2 would need every neighbouring pair to
 * sit at opposite ends of the list, and a hue has two neighbours while a position has one opposite. Below that
 * the search finds a deal quickly, and where it does not it settles for the next spacing down rather than
 * spending a page render proving that one is impossible.
 */
const deals = new Map();
function hueDeal(n) {
  if (deals.has(n)) return deals.get(n);
  const found = search(n);
  deals.set(n, found);
  return found;
}

function search(n) {
  for (let apart = n % 2 ? (n - 1) / 2 : n / 2 - 1; apart >= 2; apart--) {
    // The wheel turns, so the first model may as well take the first hue: every deal is some rotation of one
    // that does.
    const hues = [0];
    const taken = new Array(n).fill(false);
    taken[0] = true;
    let visits = 0;
    const fits = (hue, at) => hues.every((h, i) => around(h, hue, n) !== 1 || around(i, at, n) >= apart);
    const place = (at) => {
      if (at === n) return true;
      if (visits++ > SEARCH_BUDGET) return false;
      // Hues furthest from the one just placed are tried first: the deal being looked for is one that keeps
      // jumping across the wheel, so guessing that way finds it in a fraction of the attempts.
      const from = hues[at - 1];
      const candidates = [...Array(n).keys()].sort((x, y) => around(y, from, n) - around(x, from, n));
      for (const hue of candidates) {
        if (taken[hue] || !fits(hue, at)) continue;
        taken[hue] = true;
        hues.push(hue);
        if (place(at + 1)) return true;
        taken[hue] = false;
        hues.pop();
      }
      return false;
    };
    if (place(1)) return hues;
  }
  // Four models on a wheel leave a neighbouring pair beside each other whatever the deal, and two or three have
  // no room to arrange at all: the hues go round in order and the legend's names carry the rest.
  return Array.from({ length: n }, (_, i) => i);
}

/**
 * Hue index for the model at position i of n. Models whose hues sit next to each other on the wheel are kept as
 * far apart in the list as the count allows — for 8 models, 3 apart rather than the 1 that the old interleave
 * left between the first model and the last.
 */
export function spreadIndex(i, n) {
  const size = Math.max(1, n);
  return hueDeal(size)[((i % size) + size) % size];
}

/** Map model IDs → colors, in the order given (card order), neighbours dealt hues from opposite halves of the wheel. */
export function modelColors(models) {
  const palette = modelPalette(models.length);
  return Object.fromEntries(models.map((m, i) => [m, palette[spreadIndex(i, models.length)]]));
}
