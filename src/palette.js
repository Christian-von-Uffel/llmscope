// Per-model text colors for the responses sheet. Hues are spread evenly around the OKLCH wheel at one fixed
// lightness and chroma, so every color is equally bright (none shouts) and all of them clear WCAG AA contrast
// (≥ 4.5:1) on the dark background. Models are then dealt hues from opposite halves of the wheel in turn, so the
// models that sit next to each other on the sheet and in the legend are never the two closest hues. Names stay
// bold next to the color, so hue is never the only cue.

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

function luminance(hex) {
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

export function contrast(hexA, hexB = BG) {
  const [hi, lo] = [luminance(hexA), luminance(hexB)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Evenly spaced hues; starts at 60° so the first colors avoid the red/green used for outcomes. */
export function modelPalette(n, { lightness = 0.85, chroma = 0.11, offset = 60 } = {}) {
  return Array.from({ length: Math.max(1, n) }, (_, i) => oklchToHex(lightness, chroma, (offset + (360 * i) / Math.max(1, n)) % 360));
}

/**
 * Hue index for the model at position i of n: the first half of the wheel and the second half, interleaved
 * (0, n/2, 1, n/2+1, …), so consecutive models are about half a wheel apart and never adjacent hues. For n = 8 the
 * nearest consecutive pair is 135° apart, against 45° for the wheel walked in order.
 */
export function spreadIndex(i, n) {
  return i % 2 === 0 ? i / 2 : Math.ceil(n / 2) + (i - 1) / 2;
}

/** Map model IDs → colors, in the order given (card order), neighbours dealt hues from opposite halves of the wheel. */
export function modelColors(models) {
  const palette = modelPalette(models.length);
  return Object.fromEntries(models.map((m, i) => [m, palette[spreadIndex(i, models.length)]]));
}
