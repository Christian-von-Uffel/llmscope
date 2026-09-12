// Color-vision checks for the sheet's palette. Two questions matter for an image whose whole job is to be read:
// does text stay legible against what is behind it, and do the colors the reader is asked to tell apart stay apart?
//
// Simulation uses the Machado, Oliveira & Fernandes (2009) matrices at full severity — the dichromat end of each
// axis, so a pass here covers the milder anomalous-trichromat cases too — applied in linear sRGB, as that paper
// defines them. `grayscale` is not a form of color blindness; it stands in for everything that strips hue anyway:
// a black-and-white print, a failing projector, a screenshot run through a filter.
//
// Distance is Euclidean in OKLab, which is near-perceptually-uniform, so one threshold means the same thing at
// every lightness and hue — unlike distance in sRGB, where green swamps blue.

export const VISION = ['normal', 'protanopia', 'deuteranopia', 'tritanopia', 'grayscale'];

// Machado et al. 2009, table 1, severity 1.0. Rows are the linear-RGB output of each channel.
const MATRICES = {
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
  tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]],
};

const toLinear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toSrgb = (v) => { const c = Math.max(0, Math.min(1, v)); return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055; };
const channels = (hex) => [1, 3, 5].map((i) => parseInt(String(hex).slice(i, i + 2), 16) / 255);
const hex = (rgb) => '#' + rgb.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('');

/** Relative luminance (WCAG 2.x): the same number `contrast` in palette.js is built on. */
function luminance(color) {
  const [r, g, b] = channels(color).map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio, 1:1 to 21:1. */
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** What `color` looks like to a reader with that color vision. 'normal' returns it unchanged. */
export function simulate(color, kind = 'normal') {
  if (kind === 'normal') return String(color).toLowerCase();
  const lin = channels(color).map(toLinear);
  if (kind === 'grayscale') {
    const y = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
    return hex([y, y, y].map(toSrgb));
  }
  const m = MATRICES[kind];
  if (!m) throw new Error(`unknown vision "${kind}" (one of ${VISION.join(', ')})`);
  return hex(m.map((row) => row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2]).map(toSrgb));
}

/** OKLab coordinates of an sRGB hex: L (0-1) plus the two opponent axes. */
export function oklab(color) {
  const [r, g, b] = channels(color).map(toLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    L: 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  };
}

/** Perceptual distance in OKLab. ~0.02 is the smallest difference anyone sees; 0.1 reads as "a different color". */
export function deltaEOK(x, y) {
  const p = oklab(x);
  const q = oklab(y);
  return Math.hypot(p.L - q.L, p.a - q.a, p.b - q.b);
}

/** The worst contrast between `fg` and `bg` across every kind of color vision, and which kind it happens under. */
export function worstContrast(fg, bg, kinds = VISION) {
  return kinds.reduce((worst, kind) => {
    const ratio = contrast(simulate(fg, kind), simulate(bg, kind));
    return ratio < worst.ratio ? { kind, ratio } : worst;
  }, { kind: 'normal', ratio: Infinity });
}

/** The closest pair in a set of colors, and the vision it collapses under: what a color-only cue really costs. */
export function closestPair(colors, kinds = VISION) {
  let worst = { a: null, b: null, kind: 'normal', distance: Infinity };
  for (const kind of kinds) {
    const sim = colors.map((c) => simulate(c, kind));
    for (let i = 0; i < colors.length; i++) {
      for (let j = i + 1; j < colors.length; j++) {
        const distance = deltaEOK(sim[i], sim[j]);
        if (distance < worst.distance) worst = { a: colors[i], b: colors[j], kind, distance };
      }
    }
  }
  return worst;
}
