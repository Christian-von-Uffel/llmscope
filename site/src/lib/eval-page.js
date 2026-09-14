// The page each bundled eval gets at build time, shared by the two routes that serve it: `/<id>`, the address
// every card prints, and `/e/<id>`, the address earlier cards printed. The page reads the id out of the URL and
// resolves it in the browser, so these routes exist to make sure the URL answers at all — and to give each
// bundled eval a real page whose title and description say which one it is, rather than one generic page.
//
// Only the evals shipped with the repository can be built ahead of time. An id from a run somebody did
// themselves is not known here, so it is left to the rewrite in vercel.json, the Worker, and the matching
// fallback in `llmscope serve` to hand those the same page.
import fs from 'node:fs/promises';
import path from 'node:path';

/** One static path per bundled eval, with its spec as the page's props. */
export async function evalPaths() {
  const dir = path.join(process.cwd(), 'evals');
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'));
  return Promise.all(files.map(async (file) => {
    const spec = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'));
    return { params: { id: path.basename(file, '.json') }, props: { spec } };
  }));
}

/**
 * What the eval actually asks, as the line a posted link unfurls into. One prompt is quoted whole; several are
 * counted, since the interesting thing about a set of wordings is that there is a set of them.
 */
export function describeEval(spec) {
  const prompts = spec.prompts || [];
  const groups = Object.values(spec.variables || {}).flat().filter(Boolean);
  const asked = prompts.length === 1 ? `“${prompts[0]}”` : `${prompts.length} wordings of one prompt`;
  const across = groups.length ? ` compared across ${groups.join(', ')}` : '';
  return `${asked}${across}. Run this eval on your own key and see which models answer differently.`;
}
