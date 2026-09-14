# llmscope — working notes for Claude

llmscope is a deterministic LLM bias eval harness: one prompt with a `{slot}`, run across models through
OpenRouter, scored for refusals, keywords and sentiment, drawn as shareable images. It ships two front ends over
one engine: the CLI in `bin/llmscope.js` and the website in `site/` + `web/`. Keeping those two in step is the
main thing to get right here.

## The contract: one implementation, read from both sides

- **`src/` is the engine and is shared.** The CLI imports it directly; Astro bundles the same files into the
  browser. A renderer, a check or a spec change reaches both places at once. Never copy engine logic into
  `bin/` or `web/`.
- **`src/images.js` is the catalogue of images.** One row per image a run is drawn as: its kind, filename
  suffix, canvas size, when a run writes it (`always`, `marked`, `asked`), its browser tab, and how it is drawn
  at its defaults. The CLI's `writeOutputs` writes from it and names files by it; `web/app.js` builds its tabs,
  draws and names downloads from it; `scripts/samples.mjs` draws the landing-page samples through it. **Adding an
  image is adding a row there, nowhere else.** `test/images.test.js` holds the row's shape.
- **The landing-page samples are committed and tested.** `assets/samples/*.svg` are drawn from the runs in
  `assets/samples/runs/` by `node scripts/build-samples.mjs`; `test/samples.test.js` fails byte-for-byte when a
  renderer change leaves one behind. The deploy only copies them: it never renders.
- **File and download names carry the run's id, not the eval's.** A run's id is fresh per run (`freshId`); the
  eval's id is content-addressed (`specId`) and names the file in `evals/`. `out/<run id><suffix>.svg` on disk,
  `llmscope-<run id><suffix>.svg` in the browser.
- **The browser form stays simple.** It carries prompt, slot values, measure, models and repeats; every other
  knob is a CLI flag and a `src/spec.js` default. Do not add settings to the page unless asked.

## After changing something

| you changed | then |
|---|---|
| anything under `src/` | `npm test` |
| a renderer, a check, or `src/images.js` | `npm test` — `test/samples.test.js` will say if the samples are stale; then `node scripts/build-samples.mjs` and commit `assets/samples/` |
| what a run writes, or the browser's tabs | edit `src/images.js` only; check `README.md`, which names the tabs and the files in prose (search for "Card / Words" and "Where things go") |
| `web/`, `site/`, or `src/` code the page uses | `npm run build`, then look at it: `llmscope serve` serves `dist/` on 5173, `npm run dev` runs Astro on 4321 (`.claude/launch.json` has both) |
| `bin/llmscope.js` help text or the README | keep the two saying the same thing; `test/cli.test.js` greps the help |

`npm test` is offline and keyless (mock provider). The suite renders real SVGs, so it needs the bundled fonts
and `@napi-rs/canvas`; both install with `npm install`.

## Layout, briefly

`bin/llmscope.js` menu, wizard, flags, output writers · `src/engine.js` planRun/runEval · `src/spec.js`
normalize, ids, jobs · `src/analyze.js` grid and headline · `src/render*.js`, `src/sheet.js` the renderers ·
`src/images.js` the catalogue · `web/app.js` + `web/store.js` the page (store is DOM-free and tested; keep pure
page logic out of the DOM so it can be) · `site/src/layouts/Site.astro` the page's markup · `scripts/` build
steps · `out/` and `evals/` are runtime output (`out/` is gitignored).

## Process

- Do not commit unless asked. The user reviews the working tree.
- Work done in a worktree under `.claude/worktrees/` is not on `main` until it is applied there: before ending a
  session, `git diff main` from the worktree and say what is still outstanding.
- Verify in the browser rather than describing: open the built site, click the tabs, read the console.
