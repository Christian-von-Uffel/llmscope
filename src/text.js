// One text-measurement path for Node and the browser: pretext (@chenglou/pretext) over a canvas 2D context,
// with the same DejaVu Sans files that the PNG renderer uses. Text is measured before it is drawn, so every
// line break on a card or sheet is exact instead of estimated.
import { prepareWithSegments, layoutWithLines } from '@chenglou/pretext';

export const FONT_SANS = 'DejaVu Sans';
export const FONT_MONO = 'DejaVu Sans Mono';
export const FONT_FILES = [
  { pkg: 'dejavu-fonts-ttf/ttf/DejaVuSans.ttf', family: FONT_SANS, weight: 400 },
  { pkg: 'dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf', family: FONT_SANS, weight: 700 },
  { pkg: 'dejavu-fonts-ttf/ttf/DejaVuSansMono.ttf', family: FONT_MONO, weight: 400 },
];
/** DejaVu Sans's ascent and descent as a share of the font size: a text line's box runs from baseline − ascent to baseline + descent. */
export const FONT_METRICS = { ascent: 0.928, descent: 0.236 };

export function font(size, { bold = false, mono = false } = {}) {
  return `${bold ? '700 ' : ''}${size}px "${mono ? FONT_MONO : FONT_SANS}"`;
}

let ctx = null;
let readyPromise = null;
let fontPaths = [];

/** Load fonts and a canvas context. Idempotent; resolves to true when exact measurement is available. */
export function ensureText() {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    try {
      if (typeof document === 'undefined') {
        const { createCanvas, GlobalFonts } = await import('@napi-rs/canvas');
        const { createRequire } = await import('node:module');
        const require = createRequire(import.meta.url);
        fontPaths = FONT_FILES.map((f) => require.resolve(f.pkg));
        FONT_FILES.forEach((f, i) => GlobalFonts.registerFromPath(fontPaths[i], f.family));
        if (typeof globalThis.OffscreenCanvas === 'undefined') {
          globalThis.OffscreenCanvas = class OffscreenCanvasShim {
            constructor(w, h) { this.canvas = createCanvas(w, h); }
            getContext(kind) { return this.canvas.getContext(kind); }
          };
        }
        ctx = createCanvas(1, 1).getContext('2d');
      } else {
        if (document.fonts?.load) {
          await Promise.all([font(16), font(16, { bold: true }), font(16, { mono: true })].map((f) => document.fonts.load(f))).catch(() => {});
        }
        ctx = (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas')).getContext('2d');
      }
      return true;
    } catch {
      ctx = null;
      return false;
    }
  })();
  return readyPromise;
}

export const textReady = () => ctx !== null;
export const fontFilePaths = () => fontPaths;

const cache = new Map();

/** Exact advance width of text in a canvas font string; a glyph-width estimate before ensureText(). */
export function measureWidth(text, fontStr) {
  if (!ctx) return estimateWidth(text, fontStr);
  const key = fontStr + ' ' + text;
  let w = cache.get(key);
  if (w === undefined) {
    if (ctx.font !== fontStr) ctx.font = fontStr;
    w = ctx.measureText(text).width;
    if (cache.size > 50000) cache.clear();
    cache.set(key, w);
  }
  return w;
}

function estimateWidth(text, fontStr) {
  const size = Number(/(\d+(?:\.\d+)?)px/.exec(fontStr)?.[1] || 16);
  const bold = /^700 /.test(fontStr);
  const mono = /Mono/.test(fontStr);
  if (mono) return text.length * 0.6 * size;
  let w = 0;
  for (const ch of text) {
    if (/[ .,:;'|!il]/.test(ch)) w += 0.3;
    else if (/[mwMW@]/.test(ch)) w += 0.85;
    else if (/[A-Z]/.test(ch)) w += 0.7;
    else if (/[0-9]/.test(ch)) w += 0.6;
    else w += 0.56;
  }
  return w * size * (bold ? 1.06 : 1);
}

/** Wrap a paragraph into lines that fit maxWidth (pretext when ready, the estimate otherwise). */
export function wrapText(text, fontStr, maxWidth) {
  if (ctx) {
    try {
      const prepared = prepareWithSegments(text, fontStr);
      const lines = layoutWithLines(prepared, maxWidth, 1).lines.map((l) => l.text.replace(/\s+$/, ''));
      return lines.filter((l, i, a) => l.length || a.length === 1);
    } catch { /* fall through to the estimate */ }
  }
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? cur + ' ' + w : w;
    if (measureWidth(test, fontStr) <= maxWidth || !cur) cur = test;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}
