// The page each bundled eval gets at build time, shared by the two routes that serve it: `/<id>`, the address
// every card prints, and `/e/<id>`, the address earlier cards printed. The page reads the id out of the URL and
// resolves it in the browser, so these routes exist to make sure the URL answers at all — and to give each
// bundled eval a real page whose title and description say which one it is, rather than one generic page.
//
// Only what is shipped with the repository can be built ahead of time: the bundled evals, and the runs the
// landing page's samples are drawn from, which the samples link to. An id from a run somebody did themselves is
// not known here, so it is left to the rewrite in vercel.json, the Worker, and the matching fallback in
// `llmscope serve` to hand those the same page.
import fs from 'node:fs/promises';
import path from 'node:path';

const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));

/** One static path per bundled eval and per sample run, with its spec as the page's props. */
export async function evalPaths() {
  const evals = path.join(process.cwd(), 'evals');
  const runs = path.join(process.cwd(), 'assets', 'samples', 'runs');
  const paths = await Promise.all((await fs.readdir(evals)).filter((f) => f.endsWith('.json')).map(async (file) =>
    ({ params: { id: path.basename(file, '.json') }, props: { spec: await readJson(path.join(evals, file)), noun: 'eval' } })));
  // A run made before runs had ids of their own is filed under its eval's id, which already has its page.
  for (const file of (await fs.readdir(runs)).filter((f) => f.endsWith('.results.json'))) {
    const id = path.basename(file, '.results.json');
    if (!paths.some((p) => p.params.id === id)) paths.push({ params: { id }, props: { spec: (await readJson(path.join(runs, file))).spec, noun: 'run' } });
  }
  return paths;
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
