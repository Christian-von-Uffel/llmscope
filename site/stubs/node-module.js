// Browser stand-in for node:module. Used by src/text.js only to resolve font files on disk under Node; the
// browser loads the same faces over HTTP from /fonts instead.
export const createRequire = () => { throw new Error('node:module is Node-only; the browser loads fonts from /fonts'); };
export default { createRequire };
