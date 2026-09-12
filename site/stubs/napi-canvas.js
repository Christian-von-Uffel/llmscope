// Browser stand-in for @napi-rs/canvas. src/text.js reaches for it only when there is no `document`, so in the
// browser this module is loaded by the bundler and never evaluated by the app.
const nope = () => { throw new Error('@napi-rs/canvas is the Node measurement path; the browser measures with its own canvas'); };
export const createCanvas = nope;
export const GlobalFonts = { registerFromPath: nope };
export default { createCanvas, GlobalFonts };
