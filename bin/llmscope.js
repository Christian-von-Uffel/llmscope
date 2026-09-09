#!/usr/bin/env node
// llmscope CLI. No arguments in a terminal opens a menu; every step is also available as a flag for scripts.
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { planRun, runEval, rescoreRun } from '../src/engine.js';
import { analyze, totalTokens } from '../src/analyze.js';
import { renderCard } from '../src/render.js';
import { renderShareCard } from '../src/render-share.js';
import { renderResponseSheet, SELECTIONS } from '../src/sheet.js';
import { ensureText, fontFilePaths, FONT_SANS } from '../src/text.js';
import { usedVariables, normalizeSpec, specId, REASONING_EFFORTS } from '../src/spec.js';
import { createOpenRouterProvider, checkKey } from '../src/providers/openrouter.js';
import { createMockProvider } from '../src/providers/mock.js';
import { setSentimentAnalyzer, resetSentimentAnalyzer, httpSentiment, afinnSentiment, SENTIMENT_CHOICES } from '../src/checks/sentiment.js';
import { createJudge } from '../src/checks/judge.js';
import { fetchModels, pickFrontier, newestPerProvider, estimateCost, formatUsd, priceLabel, FRONTIER_DEFAULTS, MAIN_PROVIDERS, resolveModels, subtractModels, modelFamily, isRunnableModel } from '../src/models.js';
import { resolveApiKey, updateConfig, loadConfig, configPath, maskKey } from '../src/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);
const dim = (s) => (TTY ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s) => (TTY ? `\x1b[1m${s}\x1b[0m` : s);
const amber = (s) => (TTY ? `\x1b[33m${s}\x1b[0m` : s);
const green = (s) => (TTY ? `\x1b[32m${s}\x1b[0m` : s);
const red = (s) => (TTY ? `\x1b[31m${s}\x1b[0m` : s);
const shortModel = (id) => id.split('/').pop().split(':')[0];
const splitList = (v) => (v == null || v === true ? [] : String(v).split(',').map((s) => s.trim()).filter(Boolean));
const signed = (x) => (Number(x) >= 0 ? '+' : '') + Number(x || 0).toFixed(2);

// ---------- args ----------
const REPEATABLE = new Set(['var', 'prompt', 'add-prompt']);
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { args._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    let value = true;
    if (next !== undefined && !next.startsWith('--')) { value = next; i++; }
    if (REPEATABLE.has(key)) args[key] = [].concat(args[key] || [], value);
    else args[key] = value;
  }
  return args;
}

/** --var name=a,b, repeated, parsed into { name: [a, b] }. */
function parseVars(args) {
  const variables = {};
  for (const v of args.var || []) {
    const eq = String(v).indexOf('=');
    if (eq === -1) throw new Error(`--var expects name=value,value (got "${v}")`);
    variables[String(v).slice(0, eq).trim()] = String(v).slice(eq + 1).split(',').map((s) => s.trim());
  }
  return variables;
}

/**
 * Reconcile slots with the prompts after an edit: lift inline {a|b} groups into named slots, then forget the
 * values of slots the prompts no longer ask for, so a reworded eval still validates.
 * @returns {string[]} the slot names that were dropped
 */
function dropUnusedSlots(spec, { quiet = false } = {}) {
  const lifted = normalizeSpec({ prompts: spec.prompts || [], variables: spec.variables || {}, models: ['x'] });
  spec.prompts = lifted.prompts;
  spec.variables = lifted.variables;
  const used = usedVariables(spec.prompts);
  const gone = Object.keys(spec.variables).filter((name) => !used.has(name));
  for (const name of gone) delete spec.variables[name];
  if (gone.length && !quiet) console.log(dim(`the prompt no longer uses ${gone.map((n) => `{${n}}`).join(', ')} — dropped ${gone.length === 1 ? 'that slot' : 'those slots'}`));
  return gone;
}

const promptList = (v) => [].concat(v || []).filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim());

/**
 * Settings flags, applied to a spec however it was built: a saved eval file runs under them too.
 * `fromFile` says the spec had a life before these flags, so a replaced prompt may leave slots behind.
 */
function applyOverrides(spec, args, { fromFile = false } = {}) {
  // The prompt is as overridable as the models: --prompt replaces what the file asks, --add-prompt runs alongside.
  const replaced = promptList(args.prompt);
  const added = promptList(args['add-prompt']);
  if (replaced.length) spec.prompts = replaced;
  if (added.length) spec.prompts = [...(spec.prompts || []), ...added];
  const vars = parseVars(args);
  if (Object.keys(vars).length) spec.variables = { ...spec.variables, ...vars };
  if (fromFile && (replaced.length || added.length)) dropUnusedSlots(spec);
  if (args.type) spec.primary = args.type;
  if (args.keywords) spec.keywords = splitList(args.keywords);
  if (args['keyword-mode']) spec.keyword_mode = args['keyword-mode'];
  if (args.runs) spec.runs = Number(args.runs);
  if (args.temp !== undefined) spec.temperature = Number(args.temp);
  if (args['max-tokens'] || args['max-reply']) spec.max_tokens = Number(args['max-tokens'] || args['max-reply']);
  if (args.thinking !== undefined) spec.thinking_budget = Number(args.thinking);
  if (args.reasoning) spec.reasoning = String(args.reasoning);
  if (args.system) spec.system = args.system;
  if (args.sentiment) spec.sentiment_analyzer = args.sentiment;
  if (args['sentiment-url']) spec.sentiment_analyzer = args['sentiment-url'];
  if (args.seed !== undefined) spec.seed = Number(args.seed);
  return spec;
}

function specFromArgs(args) {
  return applyOverrides({ prompts: [], variables: {}, models: splitList(args.models) }, args);
}

async function readSpec(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

/** Load an eval file for running: remember what it was, then apply any flags that override it. */
async function readSpecFile(file, args) {
  const raw = await readSpec(file);
  args.specFile = file;
  args.fileId = await specId(raw);
  return applyOverrides(raw, args, { fromFile: true });
}

/** Where this run's spec lives: the file it came from, or a new one when flags or the picker changed it. */
function specTarget(plan, args) {
  const changed = !args.specFile || (args.fileId && plan.id !== args.fileId);
  return { file: changed ? `evals/${plan.id}.json` : args.specFile, changed };
}

// ---------- shared services ----------
let modelCache = null;
async function models({ quiet = false } = {}) {
  if (modelCache) return modelCache;
  try {
    if (!quiet) process.stderr.write(dim('fetching model list from openrouter.ai… '));
    modelCache = await fetchModels();
    if (!quiet) process.stderr.write(dim(`${modelCache.length} models\n`));
  } catch (err) {
    if (!quiet) process.stderr.write(red(`unavailable (${err.message}); using built-in defaults\n`));
    modelCache = [];
  }
  return modelCache;
}

function namesMap() {
  return Object.fromEntries((modelCache || []).map((m) => [m.id, m.name]));
}

function titleMode(value, fallback = 'finding') {
  if (value === undefined || value === true) return fallback;
  if (value !== 'finding' && value !== 'prompt') throw new Error(`--title must be "finding" (state the result) or "prompt" (let viewers judge), got "${value}"`);
  return value;
}

async function applySentiment(choice) {
  if (!choice || choice === 'builtin') { resetSentimentAnalyzer(); return 'builtin'; }
  if (choice === 'afinn') { setSentimentAnalyzer(await afinnSentiment()); return 'afinn-165'; }
  if (/^https?:\/\//.test(choice)) { setSentimentAnalyzer(httpSentiment(choice)); return choice; }
  const mod = await import(pathToFileURL(path.resolve(choice)).href);
  setSentimentAnalyzer(mod.default || mod.analyze);
  return choice;
}

async function inquirer() {
  if (!TTY) throw new Error('This step is interactive. Run it in a terminal, or pass flags (see llmscope help).');
  return import('@inquirer/prompts');
}

async function ensureKey({ flag, allowPrompt = true } = {}) {
  const found = await resolveApiKey({ flag });
  if (found.key) return found;
  if (!allowPrompt || !TTY) throw new Error('No OpenRouter API key. Run `llmscope key`, set OPENROUTER_API_KEY, or pass --key.');
  const { password, confirm } = await inquirer();
  console.log(`\n${bold('OpenRouter API key')}  ${dim('create one at https://openrouter.ai/keys — it is only ever sent to openrouter.ai')}`);
  const key = (await password({ message: 'Paste your key:', mask: '•', validate: (v) => (v.trim().startsWith('sk-or-') ? true : 'OpenRouter keys start with sk-or-') })).trim();
  process.stderr.write(dim('checking… '));
  const info = await checkKey({ apiKey: key });
  if (info.ok) console.log(green(`ok`) + dim(info.label ? ` (${info.label}, used ${formatUsd(info.usage || 0)}${info.limit != null ? ` of ${formatUsd(info.limit)}` : ''})` : ''));
  else console.log(red(`could not verify: ${info.error}`) + dim(' (continuing anyway)'));
  if (await confirm({ message: `Save it to ${configPath()} for next time?`, default: true })) {
    await updateConfig({ openrouter_api_key: key });
    console.log(dim('saved (file mode 0600)'));
  }
  return { key, source: 'prompt' };
}

async function buildProvider(args) {
  if (args.provider === 'mock') return createMockProvider();
  const { key } = await ensureKey({ flag: args.key });
  return createOpenRouterProvider({ apiKey: key, models: await models({ quiet: true }) });
}

// ---------- running ----------
const fmtN = (n) => Math.round(n).toLocaleString('en-US');
/** Wall clock in seconds: 0.84s, 12.4s, 184.2s. */
const fmtSeconds = (s) => `${s < 10 ? s.toFixed(2) : s.toFixed(1)}s`;
function progressWriter(total) {
  const width = 24;
  return ({ done, result }) => {
    const flag = result.error ? 'ERR' : result.refused ? 'REFUSED' : result.matched ? 'MATCH' : 'ok';
    const line = `${shortModel(result.model).padEnd(26)} ${('[' + result.variantLabel + ']').padEnd(16)} ${String(totalTokens(result)).padStart(5)}t ${dim(`(${result.prompt_tokens || 0}+${result.tokens})`)}  ${flag}`;
    if (TTY) {
      const filled = Math.round((done / total) * width);
      process.stderr.write(`\r\x1b[K[${'#'.repeat(filled)}${'.'.repeat(width - filled)}] ${done}/${total}  ${line}`);
      if (done === total) process.stderr.write('\n');
    } else process.stderr.write(`[${String(done).padStart(String(total).length)}/${total}] ${line}\n`);
  };
}

function printProblems(run) {
  printErrors(run);
  printOverCap(run);
}

function printErrors(run) {
  const errors = run.results.filter((r) => r.error && !r.refused);
  if (!errors.length) return;
  const groups = new Map();
  for (const r of errors) { const key = r.error.replace(/\(\d+ tokens\)/, '').slice(0, 90); groups.set(key, (groups.get(key) || 0) + 1); }
  console.log(`\n${amber(`${errors.length} of ${run.results.length} replies had no answer`)} ${dim('(gray on the card)')}`);
  for (const [msg, n] of groups) console.log(`  ${String(n).padStart(3)} × ${msg}${msg.length >= 90 ? '…' : ''}`);
  if (errors.some((r) => /cut off/.test(r.error))) console.log(dim('  → thinking models used the whole output cap reasoning: raise --thinking (default 8000), or lower --reasoning'));
  if (errors.some((r) => /402|credits/.test(r.error))) console.log(dim('  → OpenRouter refused for credit reasons: add credits or lower --concurrency 1'));
  if (errors.some((r) => /429|rate/i.test(r.error))) console.log(dim('  → rate limited: lower --concurrency'));
}

/** Replies billed more completion tokens than the cap that was sent: the provider charged thinking on top (xAI does). */
function printOverCap(run) {
  const capOf = (r) => r.max_tokens_sent ?? run.spec.max_tokens;
  const over = run.results.filter((r) => (r.tokens || 0) > capOf(r));
  if (!over.length) return;
  console.log(`\n${amber(`${over.length} of ${run.results.length} replies were billed beyond their output cap`)} ${dim('(thinking charged on top of max_tokens)')}`);
  const worst = new Map();
  for (const r of over) if (!worst.has(r.model) || r.tokens > worst.get(r.model).tokens) worst.set(r.model, r);
  for (const [m, r] of [...worst].sort((a, b) => b[1].tokens - a[1].tokens)) console.log(`  ${shortModel(m).padEnd(28)} up to ${fmtN(r.tokens)} tokens against a cap of ${fmtN(capOf(r))} (${(r.tokens / capOf(r)).toFixed(1)}×)`);
  console.log(dim('  → this provider cannot switch thinking off; --reasoning low trims it, and a spend limit on your OpenRouter key is the only hard stop'));
}

function printSummary(a) {
  console.log(`\n${bold(a.title.kicker)}`);
  const head = ['model'.padEnd(30), ...a.variants.map((v) => v.label.padEnd(22))].join('');
  console.log(dim(head));
  for (const row of a.rows) {
    const cells = row.cells.map((c) => `${c.big} (${Math.round(c.tokens_mean)}t)`.padEnd(22));
    const name = (row.flagged ? amber('≠ ') : '  ') + shortModel(row.model);
    console.log(name.padEnd(30 + (row.flagged && TTY ? 9 : 0)) + cells.join(''));
  }
  const t = a.summary.tokens;
  if (t) console.log(dim(`cells show avg reply tokens · run used ${fmtN(t.total)} tokens = ${fmtN(t.prompt)} prompt + ${fmtN(t.reply)} reply${t.over_cap ? ` · ${t.over_cap} billed over the cap` : ''}`));
  const c = a.summary.cost;
  if (c?.priced) console.log(`${bold('cost')} ${formatUsd(c.usd)} ${dim(`as billed by OpenRouter${c.unpriced ? ` · ${c.unpriced} of ${c.priced + c.unpriced} replies unpriced` : ''}`)}`);
  const d = a.summary.duration_s;
  if (d != null) console.log(`${bold('took')} ${fmtSeconds(d)} ${dim(`wall clock · ${a.summary.total_runs} replies`)}`);
}

async function pngFromSvg(svgText, file) {
  try {
    const { Resvg } = await import('@resvg/resvg-js');
    const fontFiles = fontFilePaths(); // the exact files the layout was measured with
    await fs.writeFile(file, new Resvg(svgText, { font: { fontFiles, loadSystemFonts: true, defaultFontFamily: FONT_SANS } }).render().asPng());
    return file;
  } catch { return null; }
}

async function writeSheet(run, file, { select = 'all', size = 4096, maxFont = null, columns = null, url = null, png = true, log = true } = {}) {
  const { svg, font, columns: cols, replies, exact } = renderResponseSheet(run, { size, maxFont: maxFont || null, columns, select, url });
  const base = file.replace(/\.results\.json$/, '');
  const svgPath = `${base}.responses.svg`;
  await fs.writeFile(svgPath, svg);
  const pngPath = png ? await pngFromSvg(svg, `${base}.responses.png`) : null;
  const note = `${font}px text in ${cols} column${cols > 1 ? 's' : ''}${exact ? '' : dim(' (estimated widths: fonts not loaded)')}`;
  if (log) console.log(`${replies} replies on one ${size}px image · ${SELECTIONS[select]} · ${note}\n  ${pngPath || svgPath}`);
  return { path: pngPath || svgPath, png: pngPath, svg: svgPath, font, columns: cols, replies, note };
}

async function writeOutputs(run, { outDir = 'out', out, svg, png, url, title, detail = false } = {}) {
  const a = analyze(run);
  const mode = titleMode(title, run.spec.card_title || 'finding');
  const svgText = detail
    ? renderCard(a, { url: url || null })
    : renderShareCard(a, { url: url || null, names: namesMap(), date: run.finished_at, title: mode });
  await fs.mkdir(outDir, { recursive: true });
  const suffix = detail ? '.detail' : '';
  const paths = {
    json: out || path.join(outDir, `${run.id}.results.json`),
    svg: svg || path.join(outDir, `${run.id}${suffix}.svg`),
    png: png === false ? null : png || path.join(outDir, `${run.id}${suffix}.png`),
    mode: detail ? 'detail' : mode,
  };
  await fs.writeFile(paths.json, JSON.stringify(run, null, 2));
  await fs.writeFile(paths.svg, svgText);
  if (paths.png && !(await pngFromSvg(svgText, paths.png))) { paths.png = null; console.error(dim('PNG export needs @resvg/resvg-js (npm install @resvg/resvg-js); SVG written instead.')); }
  // Second image: every reply on one sheet, so the pair shows everything a viewer needs.
  const sheet = await writeSheet(run, paths.json, { png: png !== false, url, log: false });
  paths.sheet = sheet.path;
  return { analysis: a, paths, sheet };
}

/** The whole run: defaults, cost estimate, confirmation, execution, outputs. Used by `run`, `new` and the menu. */
/**
 * The models a run uses: the spec's own list, replaced by --models, extended by --add-models, narrowed by
 * --drop-models, with every selector (family, provider, glob) expanded against the live catalogue. Any eval
 * file can therefore be pointed at any models without editing it.
 */
function chooseModels(spec, args, list, { quiet = false } = {}) {
  const say = (line) => { if (!quiet) console.log(line); };
  let picked = args.models ? splitList(args.models) : spec.models;
  if (args['add-models']) picked = [...picked, ...splitList(args['add-models'])];
  if (!picked.length) {
    picked = pickFrontier(list);
    say(dim(`no models given; using frontier defaults: ${picked.map(shortModel).join(', ')}`));
  }
  const { ids, expansions, unmatched } = resolveModels(picked, list);
  for (const e of expansions) {
    if (e.kind === 'id') continue;
    say(dim(`${e.selector} → ${e.ids.length} ${e.kind === 'glob' ? 'matching' : e.kind} model${e.ids.length === 1 ? '' : 's'}: ${e.ids.map(shortModel).join(', ')}`));
  }
  const drop = subtractModels(ids, splitList(args['drop-models']), list);
  if (drop.removed.length) say(dim(`dropped ${drop.removed.length}: ${drop.removed.map(shortModel).join(', ')}`));
  const missed = [...unmatched, ...drop.unmatched];
  if (missed.length) {
    say(amber(`no model matched: ${missed.join(', ')}`) + dim(list.length ? '  (try llmscope models <name> to see what exists)' : '  (the catalogue is unavailable; only exact IDs resolve offline)'));
  }
  return drop.ids;
}

async function execute(inputSpec, args = {}) {
  const spec = normalizeSpec(inputSpec);
  if (args.title !== undefined) spec.card_title = titleMode(args.title);
  const list = await models({ quiet: Boolean(args.quiet) });
  spec.models = chooseModels(spec, args, list);
  let plan = await planRun(spec);
  if (plan.problems.length) throw new Error('Invalid eval:\n - ' + plan.problems.join('\n - '));
  const provider = await buildProvider(args);
  const review = () => {
    const variants = plan.jobs.length / plan.spec.prompts.length / plan.spec.models.length / plan.spec.runs;
    const shape = `${plan.spec.prompts.length} prompt${plan.spec.prompts.length > 1 ? 's' : ''} × ${variants} variant${variants > 1 ? 's' : ''} × ${plan.spec.models.length} model${plan.spec.models.length > 1 ? 's' : ''} × ${plan.spec.runs} run${plan.spec.runs > 1 ? 's' : ''}`;
    let costLine = '';
    if (provider.name !== 'mock') {
      const cost = estimateCost(plan, list);
      costLine = list.length ? `est. ≈${formatUsd(cost.typical)} ${dim(`(up to ${formatUsd(cost.high)} if every reply used its whole budget)`)}` : 'cost unknown (model list unavailable)';
      if (cost.unknown.length) costLine += red(` · not on OpenRouter: ${cost.unknown.join(', ')}`);
    }
    printReview(plan, provider, shape, costLine, specTarget(plan, args));
  };
  review();
  if (TTY && !args.yes) {
    const { select } = await inquirer();
    for (;;) {
      const choice = await select({
        message: provider.name === 'mock' ? 'Run with mock data?' : 'Send these requests to OpenRouter now?',
        choices: [
          { value: 'run', name: 'Run now' },
          { value: 'show', name: 'Show every request first', description: 'Prints each filled-in prompt in the order it will be sent' },
          { value: 'models', name: 'Change models', description: 'a family, a whole provider, or models you tick — the eval file is not modified' },
          { value: 'prompt', name: 'Change the prompt', description: 'the wording, the slot values, or an extra phrasing — also not written back to the file' },
          { value: 'cancel', name: 'Cancel' },
        ],
      });
      if (choice === 'cancel') { console.log(dim('cancelled; nothing was sent')); return null; }
      if (choice === 'run') break;
      if (choice === 'show') { printRequests(plan); continue; }
      if (choice === 'prompt') {
        const edited = await editPrompt(spec);
        if (!edited) continue;
        const replanned = await planRun({ ...spec, ...edited });
        if (replanned.problems.length) { console.log(red(' - ' + replanned.problems.join('\n - '))); continue; }
        Object.assign(spec, edited);
        plan = replanned;
        review();
        continue;
      }
      // Any eval file can be pointed at any models, without editing it: the run gets its own ID and card.
      const families = [...new Set(spec.models.map(modelFamily))].slice(0, 5).map((f) => ({ selector: f, why: `every version and tier of ${f}` }));
      const picked = await pickModels(list, { current: spec.models, suggestions: families, message: 'Run this eval on which models?' });
      if (!picked?.length) continue;
      const chosen = chooseModels({ models: picked }, {}, list);
      const next = await planRun({ ...spec, models: chosen });
      if (next.problems.length) { console.log(red(' - ' + next.problems.join('\n - '))); continue; } // keep the selection that worked
      spec.models = chosen;
      plan = next;
      review();
    }
  }
  const analyzerName = await applySentiment(spec.sentiment_analyzer);
  const judge = args.judge ? createJudge(provider, { model: typeof args.judge === 'string' ? args.judge : undefined }) : null;
  const run = await runEval(spec, { provider, judge, concurrency: Number(args.concurrency) || 4, onProgress: progressWriter(plan.jobs.length) });
  run.sentiment_analyzer = analyzerName;
  const { analysis, paths, sheet } = await writeOutputs(run, { outDir: args['out-dir'] || 'out', out: args.out, svg: args.svg, png: args.png === 'none' ? false : args.png, url: args.url, detail: Boolean(args.detail) });
  printSummary(analysis);
  printProblems(run);
  // Running a file on other models leaves that file alone and writes the eval it actually ran, so it can be rerun.
  const target = specTarget(plan, args);
  const saved = target.changed && args.saveSpec !== false;
  if (saved) {
    await fs.mkdir('evals', { recursive: true });
    await fs.writeFile(target.file, JSON.stringify(spec, null, 2));
  }
  console.log(`\nshare: ${bold(plan.spec.share_base + plan.id)}   rerun: llmscope run ${target.file}`);
  console.log(`results:   ${paths.json}   ${dim(`browse: llmscope results ${plan.id}`)}\ncard:      ${paths.png || paths.svg}   ${dim(`title: ${paths.mode}`)}\nresponses: ${paths.sheet}   ${dim(`${sheet.replies} replies · ${sheet.note}`)}`);
  if (TTY && !args.yes) await afterRun(run, paths, { outDir: args['out-dir'] || 'out', specSaved: saved, analysis, args });
  return run;
}

function printReview(plan, provider, shape, costLine, spec_file = { file: null, changed: true }) {
  const spec = plan.spec;
  const kv = (k, v) => console.log(`  ${dim(k.padEnd(9))} ${v}`);
  console.log(`\n${bold('Review')}  ${dim('id ' + plan.id + (provider.name === 'mock' ? ' · mock data' : ''))}`);
  const measure = spec.primary === 'keyword'
    ? `keyword inclusion — response contains ${spec.keyword_mode === 'all' ? 'all of' : 'any of'}: ${spec.keywords.join(', ')}`
    : spec.primary === 'sentiment' ? `sentiment — analyzer: ${spec.sentiment_analyzer}` : 'refusal rate per group';
  kv('measure', measure);
  spec.prompts.forEach((p, i) => kv(i === 0 ? (spec.prompts.length > 1 ? 'prompts' : 'prompt') : '', p.replace(/\{[^}]+\}/g, (m) => amber(m))));
  const names = Object.keys(spec.variables);
  if (names.length) for (const name of names) kv(`{${name}}`, spec.variables[name].map((v) => (v === '' ? '(none)' : v)).join(', '));
  else kv('slots', dim('none — single-column card'));
  if (spec.system) kv('system', spec.system);
  kv('models', `${spec.models.length}: ${spec.models.map(shortModel).join(', ')}`);
  kv('settings', `${spec.runs} run${spec.runs > 1 ? 's' : ''} per cell · temperature ${spec.temperature} · max reply ${spec.max_tokens} tokens · thinking budget ${spec.thinking_budget} on top for models that think · reasoning ${spec.reasoning}`);
  kv('requests', `${plan.jobs.length}  ${dim(shape)}  ${costLine}`);
  kv('outputs', `out/${plan.id}.{results.json,svg,png} · spec ${spec_file.changed ? 'saved to' : 'from'} ${spec_file.file || `evals/${plan.id}.json`}`);
}

function printRequests(plan) {
  console.log(`\n${plan.jobs.length} requests in the order they will be sent:`);
  plan.order.forEach((jobIndex, pos) => {
    const j = plan.jobs[jobIndex];
    console.log(`${String(pos + 1).padStart(3)}. ${shortModel(j.model).padEnd(28)} run ${j.run}  [${j.variantLabel}]  ${j.prompt}`);
  });
  console.log('');
}

// ---------- results browsing ----------
async function listRuns(outDir = 'out') {
  let files = [];
  try { files = (await fs.readdir(outDir)).filter((f) => f.endsWith('.results.json')); } catch {}
  const runs = [];
  for (const f of files) {
    try {
      const r = JSON.parse(await fs.readFile(path.join(outDir, f), 'utf8'));
      runs.push({ file: path.join(outDir, f), id: r.id, when: r.finished_at || r.started_at || '', n: r.results.length, provider: r.provider, kicker: analyze(r).title.kicker });
    } catch {}
  }
  runs.sort((a, b) => b.when.localeCompare(a.when));
  const seen = new Set(); // the same eval rendered to two files shows once, newest first
  return runs.filter((r) => !seen.has(r.id) && seen.add(r.id));
}

async function loadRun(file) {
  const run = JSON.parse(await fs.readFile(file, 'utf8'));
  const changed = rescoreRun(run);
  if (changed) console.log(dim(`re-scored with the current rules: ${changed} verdict${changed > 1 ? 's' : ''} changed since this run was saved`));
  return run;
}

async function findResults(ref, outDir = 'out') {
  if (ref.endsWith('.json')) return ref;
  const file = path.join(outDir, `${ref}.results.json`);
  try { await fs.access(file); return file; } catch { throw new Error(`no results for "${ref}" (looked for ${file}). \`llmscope results\` lists runs.`); }
}

function outcomeOf(r) {
  if (r.error && !r.refused) return red('ERROR') + dim(` ${r.error}`);
  if (r.refused) return red('REFUSED') + dim(r.refusal_reason ? ` (${r.refusal_reason})` : '');
  if (r.matched) return amber('INCLUDED') + dim(` (${(r.keyword_hits || []).join(', ')})`);
  return green('answered');
}

function printResponses(run, { refusedOnly = false, matchedOnly = false, model = null, variant = null, full = false } = {}) {
  let rs = [...run.results].sort((x, y) => x.position - y.position);
  const filters = [];
  if (refusedOnly) { rs = rs.filter((r) => r.refused); filters.push('refused'); }
  if (matchedOnly) { rs = rs.filter((r) => r.matched); filters.push('included keywords'); }
  if (model) { rs = rs.filter((r) => r.model.includes(model)); filters.push(`model ~ ${model}`); }
  if (variant) { rs = rs.filter((r) => r.variantLabel.toLowerCase() === String(variant).toLowerCase()); filters.push(`variant = ${variant}`); }
  console.log(`\n${bold(`${rs.length} of ${run.results.length} responses`)}${filters.length ? dim(' · ' + filters.join(' · ')) : ''}  ${dim(`(${run.provider}${run.provider === 'mock' ? ', fake replies' : ''})`)}\n`);
  let truncated = false;
  for (const r of rs) {
    console.log(`${bold('#' + (r.position + 1))} ${shortModel(r.model)} ${amber('[' + r.variantLabel + ']')} run ${r.run + 1} · ${outcomeOf(r)} · ${totalTokens(r)} tok ${dim(`(${r.prompt_tokens || 0} prompt + ${r.tokens} reply${r.reasoning_tokens ? ` · ${r.reasoning_tokens} thinking` : ''})`)}${r.tokens > (r.max_tokens_sent ?? run.spec.max_tokens) ? ' ' + amber('over cap') : ''} · sent ${signed(r.sentiment)}`);
    const text = r.error ? `ERROR: ${r.error}` : r.text || '(empty)';
    if (!full && text.length > 320) truncated = true;
    const shown = full || text.length <= 320 ? text : text.slice(0, 320) + '…';
    console.log(shown.split('\n').map((l) => '   ' + l).join('\n') + '\n');
  }
  if (truncated) console.log(dim('long replies truncated · add --full to see everything'));
}

function toCsv(run) {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['position', 'model', 'variant', 'run', 'outcome', 'refusal_reason', 'keyword_hits', 'prompt_tokens', 'reply_tokens', 'reasoning_tokens', 'total_tokens', 'cost_usd', 'sentiment', 'prompt', 'response'];
  const rows = [...run.results].sort((x, y) => x.position - y.position).map((r) => [
    r.position + 1, r.model, r.variantLabel, r.run + 1,
    r.error && !r.refused ? 'error' : r.refused ? 'refused' : r.matched ? 'included' : 'answered',
    r.refusal_reason || '', (r.keyword_hits || []).join('; '), r.prompt_tokens || 0, r.tokens, r.reasoning_tokens ?? '', totalTokens(r), r.cost ?? '', r.sentiment, r.prompt, r.error ? `ERROR: ${r.error}` : r.text,
  ].map(q).join(','));
  return [head.join(','), ...rows].join('\n') + '\n';
}

/** How each model did on the run's primary metric, so a follow-up run can start from "who stood out". */
function modelStandings(run, analysis) {
  const primary = run.spec.primary;
  const rows = (analysis?.rows || []).map((r) => {
    const cells = r.cells.filter((c) => c.n);
    return { model: r.model, value: cells.length ? cells.reduce((sum, c) => sum + c.primary_value, 0) / cells.length : 0 };
  }).sort((a, b) => b.value - a.value);
  const fmt = primary === 'sentiment' ? (v) => signed(v) : (v) => `${Math.round(v * 100)}%`;
  const verb = primary === 'keyword' ? { most: 'included the keywords most often', least: 'included them least often' }
    : primary === 'sentiment' ? { most: 'was the most positive', least: 'was the most negative' }
    : { most: 'refused most', least: 'refused least' };
  return { most: rows[0], least: rows[rows.length - 1], fmt, verb };
}

/** Tick models one provider at a time, newest first, with dates and prices. */
async function browseProviderModels(list, current = []) {
  const { select, checkbox } = await inquirer();
  const pool = list.filter(isRunnableModel);
  const main = MAIN_PROVIDERS.map((p) => p.prefix).filter((p) => pool.some((m) => m.provider === p));
  const rest = [...new Set(pool.map((m) => m.provider))].filter((p) => !main.includes(p)).sort();
  const prefix = await select({
    message: 'Which provider?',
    pageSize: 16,
    choices: [...main, ...rest].map((p) => {
      const n = pool.filter((m) => m.provider === p).length;
      return { value: p, name: `${(MAIN_PROVIDERS.find((x) => x.prefix === p)?.name || p).padEnd(14)} ${dim(`${n} model${n === 1 ? '' : 's'}`)}` };
    }),
  });
  const ms = pool.filter((m) => m.provider === prefix).sort((a, b) => b.created - a.created);
  return checkbox({
    message: `${prefix} models (space toggles, enter confirms):`,
    pageSize: 20,
    choices: ms.map((m) => ({ value: m.id, checked: current.includes(m.id), name: `${m.id.padEnd(44)} ${dim(new Date(m.created * 1000).toISOString().slice(0, 10))}  ${dim(priceLabel(m))}` })),
  });
}

/**
 * Change what the eval asks, without leaving the run: the wording, the slot values, or an extra phrasing.
 * Slots are reconciled after every edit — a new {slot} asks for its values, a slot you wrote out is dropped.
 * @returns {{prompts: string[], variables: object}|null} null when nothing changed
 */
async function editPrompt(spec) {
  const { select, input } = await inquirer();
  const draft = { prompts: [...spec.prompts], variables: JSON.parse(JSON.stringify(spec.variables || {})) };
  const askValues = async (name, current = []) => {
    const raw = await input({
      message: `Values for {${name}} (comma-separated; an empty value is a control):`,
      default: current.join(', '),
      prefill: 'editable',
      validate: (v) => (v.split(',').some((s) => s.trim()) ? true : 'Give at least one value'),
    });
    return raw.split(',').map((s) => s.trim());
  };
  let changed = false;
  for (;;) {
    dropUnusedSlots(draft);
    for (const name of usedVariables(draft.prompts)) {
      if (draft.variables[name]?.length) continue;
      draft.variables[name] = await askValues(name); // a slot the edit just introduced
    }
    const slots = Object.keys(draft.variables);
    console.log(`\n${bold(draft.prompts.length > 1 ? 'Prompts' : 'Prompt')}`);
    draft.prompts.forEach((p, i) => console.log(`  ${draft.prompts.length > 1 ? `${i + 1}. ` : ''}${p.replace(/\{[^}]+\}/g, (m) => amber(m))}`));
    for (const name of slots) console.log(`  ${dim(`{${name}}`)} ${draft.variables[name].map((v) => (v === '' ? dim('(none)') : v)).join(', ')}`);
    const choices = [{ value: '::edit', name: draft.prompts.length > 1 ? 'Edit one of the phrasings' : 'Edit the wording', description: 'slots you keep stay wired to their values' }];
    if (slots.length) choices.push({ value: '::values', name: 'Change the slot values', description: 'the groups being compared — one column per value' });
    choices.push(
      { value: '::add', name: 'Add another phrasing', description: 'runs alongside this one; replies pool into the same rates, which is how one finding is made robust' },
      ...(draft.prompts.length > 1 ? [{ value: '::remove', name: 'Remove a phrasing' }] : []),
      { value: '::done', name: changed ? 'Done' : 'Back', description: changed ? 'back to the review, with the new request count and cost' : undefined },
    );
    const choice = await select({ message: 'Change what the eval asks:', choices, pageSize: 10 });
    if (choice === '::done') return changed ? draft : null;
    if (choice === '::edit') {
      const i = draft.prompts.length === 1 ? 0 : await select({ message: 'Edit which one?', choices: draft.prompts.map((p, idx) => ({ value: idx, name: `${idx + 1}. ${p}` })), pageSize: 10 });
      const next = await input({ message: 'Prompt:', default: draft.prompts[i], prefill: 'editable', validate: (v) => (v.trim() ? true : 'Type a prompt') });
      if (next.trim() !== draft.prompts[i]) { draft.prompts[i] = next.trim(); changed = true; }
    }
    if (choice === '::values') {
      const name = slots.length === 1 ? slots[0] : await select({ message: 'Which slot?', choices: slots.map((n) => ({ value: n, name: `{${n}}`, description: draft.variables[n].join(', ') })) });
      draft.variables[name] = await askValues(name, draft.variables[name]);
      changed = true;
    }
    if (choice === '::add') {
      const p = await input({ message: 'Another phrasing (reuse the same {slots} to keep the columns):', validate: (v) => (v.trim() ? true : 'Type a prompt') });
      draft.prompts.push(p.trim());
      changed = true;
    }
    if (choice === '::remove') {
      const i = await select({ message: 'Remove which one?', choices: draft.prompts.map((p, idx) => ({ value: idx, name: `${idx + 1}. ${p}` })), pageSize: 10 });
      draft.prompts.splice(i, 1);
      changed = true;
    }
  }
}

/**
 * Choose models for a run: one of the offered families or providers, a provider browse, or typed selectors.
 * Returns selectors (a family or glob is expanded by the caller) or null for "leave the selection alone".
 */
async function pickModels(list, { current = [], suggestions = [], message = 'Which models?' } = {}) {
  const { select, input } = await inquirer();
  const choices = [];
  const seen = new Set();
  for (const { selector, why } of suggestions) {
    if (!selector || seen.has(selector)) continue;
    const n = resolveModels([selector], list).ids.length;
    if (n < 2) continue; // a family of one is what we already ran
    seen.add(selector);
    choices.push({ value: selector, name: `Every ${selector} model (${n})`, description: why });
  }
  if (list.length) choices.push({ value: '::browse', name: 'Browse a provider and tick models…', description: "the current run's models start ticked" });
  choices.push(
    { value: '::type', name: 'Type selectors…', description: 'family (gemini), provider (google), glob (x-ai/grok-4*) or exact IDs, comma-separated' },
    { value: '::back', name: current.length ? `Keep the current ${current.length} model${current.length === 1 ? '' : 's'}` : 'Back' },
  );
  const choice = await select({ message, choices, pageSize: 12 });
  if (choice === '::back') return null;
  if (choice === '::browse') return browseProviderModels(list, current);
  if (choice === '::type') {
    // Prefilled with what is selected now, so adding a family is an edit rather than a retype.
    const typed = await input({ message: 'Selectors (comma-separated):', default: current.join(','), prefill: 'editable' });
    return splitList(typed);
  }
  return [choice];
}

/** "Gemini refused most — does that hold for the rest of the family?" The offers come from the run's own results. */
async function pickFollowUpModels(run, analysis) {
  const list = await models({ quiet: true });
  const { most, least, fmt, verb } = modelStandings(run, analysis);
  const suggestions = [];
  if (most) suggestions.push({ selector: modelFamily(most.model), why: `${shortModel(most.model)} ${verb.most} in this run: ${fmt(most.value)}` });
  if (least) suggestions.push({ selector: modelFamily(least.model), why: `${shortModel(least.model)} ${verb.least} in this run: ${fmt(least.value)}` });
  for (const m of [most, least]) if (m) suggestions.push({ selector: m.model.split('/')[0], why: `every model ${shortModel(m.model)}'s provider lists` });
  return pickModels(list, { current: run.spec.models, suggestions, message: 'Run the same eval on which models?' });
}

async function afterRun(run, paths, { outDir = 'out', specSaved = false, analysis = null, args = {} } = {}) {
  const { select } = await inquirer();
  const keyword = run.spec.primary === 'keyword';
  for (;;) {
    const mode = run.spec.card_title || 'finding';
    const choice = await select({
      message: 'What next?',
      choices: [
        { value: 'card', name: 'Open the card image', disabled: paths.png ? false : '(no PNG)' },
        { value: 'title', name: mode === 'finding' ? 'Switch the card title to the prompt (let viewers judge)' : 'Switch the card title to the finding (state the result)' },
        { value: 'detail', name: 'Render the detail card (tokens, sentiment, Δ)' },
        { value: 'rerun', name: 'Run this eval again on other models', description: 'the rest of a family, a whole provider, or models you tick' },
        { value: 'reprompt', name: 'Run this eval again with a different prompt', description: 'reword it, or change the groups, and see whether the result holds' },
        { value: 'sheet', name: 'Open the responses image', description: 'every reply on one 4096px image', disabled: paths.sheet?.endsWith('.png') ? false : '(no PNG)' },
        { value: 'responses', name: 'Print the responses here', description: `every reply with its verdict · later: llmscope results ${run.id}` },
        { value: 'filtered', name: keyword ? 'Print only replies that included the keywords' : 'Print only refusals' },
        { value: 'folder', name: 'Open the results folder', description: paths.json },
        { value: 'done', name: 'Done' },
      ],
    });
    if (choice === 'done') return;
    if (choice === 'card') openFile(paths.png);
    if (choice === 'title') {
      run.spec.card_title = mode === 'finding' ? 'prompt' : 'finding';
      const re = await writeOutputs(run, { outDir, out: paths.json, png: paths.png ? undefined : false });
      paths.svg = re.paths.svg; paths.png = re.paths.png;
      if (specSaved) { try { const f = `evals/${run.id}.json`; const spec = JSON.parse(await fs.readFile(f, 'utf8')); spec.card_title = run.spec.card_title; await fs.writeFile(f, JSON.stringify(spec, null, 2)); } catch {} }
      console.log(`re-rendered with the ${bold(run.spec.card_title)} as title: ${paths.png || paths.svg}`);
      if (paths.png) openFile(paths.png);
    }
    if (choice === 'detail') {
      const re = await writeOutputs(run, { outDir, out: paths.json, detail: true, png: paths.png ? undefined : false });
      console.log(`detail card: ${re.paths.png || re.paths.svg}`);
      if (re.paths.png) openFile(re.paths.png);
    }
    if (choice === 'rerun' || choice === 'reprompt') {
      const changes = choice === 'rerun'
        ? await pickFollowUpModels(run, analysis).then((models) => (models?.length ? { models } : null))
        : await editPrompt(run.spec);
      if (!changes) continue;
      // A follow-up is its own eval: same settings, new question or new models, new ID, card and spec file.
      const next = { ...args, specFile: null, fileId: null, models: undefined, 'add-models': undefined, 'drop-models': undefined, yes: false };
      try {
        await execute({ ...run.spec, ...changes }, next);
      } catch (err) {
        console.log(red(String(err.message || err)));
        continue; // stay with the run we have
      }
      return; // the follow-up run has its own menu
    }
    if (choice === 'responses') printResponses(run);
    if (choice === 'filtered') printResponses(run, keyword ? { matchedOnly: true } : { refusedOnly: true });
    if (choice === 'folder') openFile(path.resolve(path.dirname(paths.json)));
    if (choice === 'sheet') openFile(paths.sheet);
  }
}

function openFile(file) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawn(cmd, [file], { stdio: 'ignore', detached: true }).unref();
}

// ---------- commands ----------
async function cmdRun(args) {
  let spec;
  if (args._[1]) spec = await readSpecFile(args._[1], args);
  else if (args.prompt?.length) spec = specFromArgs(args);
  else throw new Error('Give an eval file (llmscope run evals/x.json) or a prompt (llmscope run --prompt "A {race} man…" --var race=black,white).');
  await execute(spec, args);
}

async function cmdNew(args) {
  const { input, select, checkbox, confirm, number, Separator } = await inquirer();
  console.log(`\n${bold('New eval')}  ${dim('write a prompt with {slots}; each slot gets a list of values; every value runs as its own request')}\n`);
  const primary = await select({
    message: 'What should the card measure?',
    choices: [
      { value: 'refusal', name: 'Refusals', description: 'How often each model declines, per group. Unequal refusal rates are the headline.' },
      { value: 'keyword', name: 'Keyword or phrase inclusion', description: 'Whether replies contain words you choose (threat words, disclaimers, a forbidden phrase).' },
      { value: 'sentiment', name: 'Sentiment', description: 'Average tone of replies per group, using a lexicon or your own analyzer.' },
    ],
  });
  const prompts = [];
  do {
    prompts.push(await input({ message: prompts.length ? `Prompt ${prompts.length + 1} (can reuse the same {slots}):` : 'Prompt (use {race}, {age}… or inline {black|white}):', validate: (v) => (v.trim() ? true : 'Type a prompt') }));
  } while (await confirm({ message: 'Add another prompt?', default: false }));
  const lifted = normalizeSpec({ prompts, models: ['x'] });
  const variables = { ...lifted.variables };
  for (const name of usedVariables(lifted.prompts)) {
    if (variables[name]) continue;
    const raw = await input({ message: `Values for {${name}} (comma-separated; an empty value is a control):`, validate: (v) => (v.split(',').filter((s) => s.trim()).length ? true : 'Give at least one value') });
    variables[name] = raw.split(',').map((s) => s.trim());
  }
  if (!Object.keys(variables).length) console.log(dim('no {slots} found; this will be a single-column eval (fine for constraint tests)'));
  const spec = { primary, prompts, variables };
  if (primary === 'keyword') {
    spec.keywords = splitList(await input({ message: 'Keywords or phrases (comma-separated, /regex/ allowed):', validate: (v) => (splitList(v).length ? true : 'Give at least one') }));
    if (spec.keywords.length > 1) spec.keyword_mode = await select({ message: 'Count a reply as a hit when it contains…', choices: [{ value: 'any', name: 'any of them' }, { value: 'all', name: 'all of them' }] });
  }
  if (primary === 'sentiment') {
    const choice = await select({ message: 'Sentiment analyzer:', choices: SENTIMENT_CHOICES.map((c) => ({ value: c.value, name: c.name, description: c.description })) });
    spec.sentiment_analyzer = choice === 'http' ? await input({ message: 'Service URL:', validate: (v) => (/^https?:\/\//.test(v) ? true : 'http(s):// URL') })
      : choice === 'module' ? await input({ message: 'Path to module:' }) : choice;
  }
  const list = await models();
  const frontier = pickFrontier(list);
  const choices = [];
  if (list.length) {
    for (const group of newestPerProvider(list, MAIN_PROVIDERS.map((p) => p.prefix), 3)) {
      if (!group.models.length) continue;
      choices.push(new Separator(dim(`— ${group.name}`)));
      for (const m of group.models) choices.push({ value: m.id, name: `${m.id.padEnd(42)} ${dim(priceLabel(m))}`, checked: frontier.includes(m.id) });
    }
  } else {
    for (const id of FRONTIER_DEFAULTS) choices.push({ value: id, name: id, checked: true });
  }
  console.log(dim('\nFrontier defaults are pre-selected: the newest flagship from each major provider, which is where active bias shows.'));
  spec.models = await checkbox({ message: 'Models to test (space toggles, enter confirms):', choices, pageSize: 18, validate: (v) => (v.length ? true : 'Pick at least one') });
  console.log(dim('Add more by family (gemini), provider (google), glob (x-ai/grok-4*) or exact ID — a family brings in its mini and preview tiers too.'));
  const extra = splitList(await input({ message: 'Add models (comma-separated, blank for none):', default: '' }));
  if (extra.length) {
    const { ids, expansions, unmatched } = resolveModels(extra, list);
    for (const e of expansions) if (e.kind !== 'id') console.log(dim(`  ${e.selector} → ${e.ids.length} ${e.kind} model${e.ids.length === 1 ? '' : 's'}`));
    if (unmatched.length) console.log(amber(`  no model matched: ${unmatched.join(', ')}`));
    spec.models.push(...ids.filter((id) => !spec.models.includes(id)));
  }
  console.log(dim('\nPress enter to accept a default.'));
  spec.runs = await number({ message: 'Runs per cell (repeats of each request, so rates are not one-offs):', default: 3, min: 1, max: 50, required: true });
  spec.temperature = await number({ message: 'Temperature (0 is the most repeatable):', default: 0, min: 0, max: 2, step: 0.1, required: true });
  spec.max_tokens = await number({ message: 'Max reply length in tokens (about 3 words per 4 tokens; longer replies are cut off):', default: 400, min: 16, max: 4000, required: true });
  spec.thinking_budget = await number({ message: 'Thinking budget in tokens, added on top of the reply cap for models that think by default (0 = none):', default: 8000, min: 0, max: 100000, required: true });
  spec.reasoning = await (await inquirer()).select({
    message: 'Reasoning effort (default = as the model ships; lower it to trim thinking):',
    choices: REASONING_EFFORTS.map((v) => ({ value: v, name: v })),
    default: 'default',
  });
  return execute(spec, { ...args, provider: args.provider });
}

async function cmdKey(args) {
  if (args.clear) { await updateConfig({ openrouter_api_key: null }); console.log('key removed from', configPath()); return; }
  const found = await resolveApiKey({});
  if (args.show || (!TTY && !args.set)) { console.log(found.key ? `${maskKey(found.key)}  (from ${found.source})` : 'no key configured'); return; }
  if (found.key && !args.set) {
    console.log(`current key ${maskKey(found.key)} (from ${found.source}).`);
    const { confirm } = await inquirer();
    if (!(await confirm({ message: 'Replace it?', default: false }))) return;
  }
  await ensureKey({ flag: null });
}

async function cmdModels(args) {
  const list = await models();
  if (!list.length) { console.log('Built-in frontier defaults:\n  ' + FRONTIER_DEFAULTS.join('\n  ')); return; }
  const frontier = new Set(pickFrontier(list));
  const byId = new Map(list.map((m) => [m.id, m]));
  const line = (id) => {
    const m = byId.get(id);
    return `  ${frontier.has(id) ? amber('★') : ' '} ${id.padEnd(46)} ${dim(m ? new Date(m.created * 1000).toISOString().slice(0, 10) : 'not listed')}  ${dim(m ? priceLabel(m) : '')}`;
  };
  const selector = args._[1] || (typeof args.family === 'string' ? args.family : null);
  if (selector) {
    // A whole family or provider, every tier of it: what you ask for when one model stood out and you want the rest.
    const { ids, expansions, unmatched } = resolveModels([selector], list);
    if (unmatched.length || !ids.length) {
      console.log(`nothing matched ${bold(selector)}.  ${dim('Try a family (gemini), a provider (google), a glob (x-ai/grok-4*) or an exact ID.')}`);
      return;
    }
    const kind = expansions[0]?.kind || 'id';
    console.log(`\n${bold(`${ids.length} model${ids.length === 1 ? '' : 's'}`)} ${dim(`· ${kind} “${selector}”`)}`);
    for (const id of ids) console.log(line(id));
    console.log(dim(`\n★ = frontier default. Run an eval on all of them: llmscope run <eval.json> --models ${selector}`));
    return;
  }
  const providers = typeof args.provider === 'string' ? [args.provider] : MAIN_PROVIDERS.map((p) => p.prefix);
  for (const group of newestPerProvider(list, providers, args.all ? 12 : 3)) {
    console.log(`\n${bold(group.name)}`);
    for (const m of group.models) console.log(line(m.id));
  }
  console.log(dim('\n★ = frontier default. This lists the flagship tier only; llmscope models <family|provider> lists every tier of one'));
  console.log(dim('  (llmscope models gemini). Any of those works with --models, --add-models and --drop-models, or in a spec file.'));
}

async function cmdExamples() {
  const dir = path.join(ROOT, 'examples');
  for (const f of (await fs.readdir(dir)).filter((f) => f.endsWith('.json')).sort()) {
    const s = normalizeSpec(await readSpec(path.join(dir, f)));
    console.log(`${bold(('examples/' + f).padEnd(34))} ${s.primary.padEnd(9)} ${dim(s.prompts[0].slice(0, 70) + (s.prompts[0].length > 70 ? '…' : ''))}`);
  }
  console.log(dim('\nRun one: llmscope run examples/identity-swap.json   (add --provider mock to preview without a key)'));
}

async function cmdResults(args) {
  const outDir = args['out-dir'] || 'out';
  const ref = args._[1];
  if (!ref) {
    const runs = await listRuns(outDir);
    if (!runs.length) { console.log(`no runs in ${outDir}/ yet. Run an eval first.`); return; }
    console.log(`${bold('Runs')} ${dim('in ' + outDir + '/')}`);
    for (const r of runs) console.log(`  ${amber(r.id)}  ${dim(r.when.slice(0, 16).replace('T', ' '))}  ${String(r.n).padStart(4)} responses  ${r.kicker}`);
    console.log(dim(`\nllmscope results <id>            every reply with its verdict\nllmscope results <id> --refused  only refusals (--matched, --model gpt, --variant white, --full, --csv)`));
    return;
  }
  const file = await findResults(ref, outDir);
  const run = await loadRun(file);
  if (args.csv) {
    const csv = typeof args.csv === 'string' ? args.csv : file.replace(/\.results\.json$/, '.csv');
    await fs.writeFile(csv, toCsv(run));
    console.log(`wrote ${csv} (${run.results.length} rows)`);
    return;
  }
  if (args.json) { console.log(JSON.stringify(run.results, null, 2)); return; }
  printSummary(analyze(run));
  printProblems(run);
  printResponses(run, { refusedOnly: Boolean(args.refused), matchedOnly: Boolean(args.matched), model: args.model || null, variant: args.variant || null, full: Boolean(args.full) });
  console.log(dim(`files: ${file} · ${file.replace(/\.results\.json$/, '.png')}`));
}

async function cmdSheet(args) {
  const ref = args._[1];
  if (!ref) throw new Error('llmscope sheet <id|results.json> [--per-cell|--refused|--matched] [--size 4096] [--max-font 44] [--columns 4]');
  const file = await findResults(ref, args['out-dir'] || 'out');
  const run = await loadRun(file);
  const select = args['per-cell'] ? 'per-cell' : args.refused ? 'refused' : args.matched ? 'matched' : 'all';
  await writeSheet(run, file, { select, size: Number(args.size) || 4096, maxFont: Number(args['max-font']) || null, columns: Number(args.columns) || null, url: args.url || null });
}

async function cmdRender(args) {
  if (!args._[1]) throw new Error('llmscope render <id|results.json> [--title finding|prompt] [--detail]');
  const file = args._[1].endsWith('.json') ? args._[1] : await findResults(args._[1], args['out-dir'] || 'out');
  const run = await loadRun(file);
  await models({ quiet: true }); // display names for the share card; fine without network
  const { analysis, paths } = await writeOutputs(run, { outDir: path.dirname(file), out: args.out || file, svg: args.svg, png: args.png === 'none' ? false : args.png, url: args.url, title: args.title, detail: Boolean(args.detail) });
  printSummary(analysis);
  console.log(`card:      ${paths.png || paths.svg}   ${dim(`title: ${paths.mode}`)}\nresponses: ${paths.sheet}`);
}

async function cmdId(args) {
  console.log((await planRun(await readSpec(args._[1]))).id);
}

async function cmdExpand(args) {
  // The free preview of a variation: the same overrides as `run`, so you can see it before you pay for it.
  const spec = args._[1] ? await readSpecFile(args._[1], args) : specFromArgs(args);
  if (args.models || args['add-models'] || args['drop-models']) spec.models = chooseModels(spec, args, await models({ quiet: true }));
  const plan = await planRun(spec);
  if (plan.problems.length) console.error('Problems:\n - ' + plan.problems.join('\n - '));
  console.log(`id ${plan.id}`);
  printRequests(plan);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.md': 'text/markdown' };
async function cmdServe(args) {
  const port = Number(args.port) || Number(process.env.PORT) || 5173;
  const server = http.createServer(async (req, res) => {
    try {
      let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (urlPath === '/') urlPath = '/index.html';
      const file = path.join(ROOT, urlPath);
      if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
      const data = await fs.readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    } catch { res.writeHead(404); res.end('not found'); }
  });
  server.listen(port, () => console.log(`llmscope UI: http://localhost:${port}`));
}

async function cmdMenu(args) {
  const { select } = await inquirer();
  const cfg = await loadConfig();
  const found = await resolveApiKey({});
  console.log(`\n${bold('llmscope')} ${dim('· deterministic LLM bias evals · key: ' + (found.key ? `${maskKey(found.key)} (${found.source})` : 'not set'))}`);
  for (;;) {
    const choice = await select({
      message: 'What do you want to do?',
      choices: [
        { value: 'new', name: 'Create a new eval (guided)', description: 'What to measure → prompt with {slots} → values → models → review → run → card image' },
        { value: 'file', name: 'Run an eval file', description: 'Rerun something from evals/ or examples/' },
        { value: 'results', name: 'Browse past results', description: 'Replies and verdicts from runs saved in out/' },
        { value: 'examples', name: 'Browse example evals' },
        { value: 'models', name: 'Show frontier models and prices' },
        { value: 'key', name: found.key ? 'Change OpenRouter API key' : 'Set OpenRouter API key' },
        { value: 'help', name: 'How to use llmscope' },
        { value: 'quit', name: 'Quit' },
      ],
    });
    if (choice === 'quit') return;
    if (choice === 'new') await cmdNew(args);
    if (choice === 'examples') await cmdExamples();
    if (choice === 'models') await cmdModels(args);
    if (choice === 'key') await cmdKey({ set: true });
    if (choice === 'help') console.log(HELP);
    if (choice === 'results') {
      const runs = await listRuns(args['out-dir'] || 'out');
      if (!runs.length) { console.log('no runs saved yet'); continue; }
      const file = await select({ message: 'Which run?', choices: runs.map((r) => ({ value: r.file, name: `${r.id}  ${r.when.slice(0, 16).replace('T', ' ')}  ${r.kicker}` })), pageSize: 12 });
      const run = await loadRun(file);
      const analysis = analyze(run);
      printSummary(analysis);
      const sheetPng = file.replace(/\.results\.json$/, '.responses.png');
      const hasSheet = await fs.access(sheetPng).then(() => true, () => false);
      await afterRun(run, { json: file, png: file.replace(/\.results\.json$/, '.png'), svg: file.replace(/\.results\.json$/, '.svg'), sheet: hasSheet ? sheetPng : (await writeSheet(run, file, { log: false })).path }, { outDir: args['out-dir'] || 'out', analysis, args });
    }
    if (choice === 'file') {
      const files = [];
      for (const dir of ['evals', 'examples']) {
        try { for (const f of (await fs.readdir(path.join(process.cwd(), dir))).filter((f) => f.endsWith('.json')).sort()) files.push(path.join(dir, f)); } catch {}
      }
      if (!files.length) { console.log('no eval files yet; create one first'); continue; }
      const file = await select({ message: 'Which eval?', choices: files.map((f) => ({ value: f, name: f })), pageSize: 15 });
      const fileArgs = { ...args };
      await execute(await readSpecFile(file, fileArgs), fileArgs);
    }
    void cfg;
  }
}

const HELP = `llmscope — deterministic LLM bias evals (bring your own OpenRouter key)

  llmscope                      interactive menu (in a terminal)
  llmscope new                  guided eval: metric → prompt with {slots} → values → models → review → run → card
  llmscope run <spec.json>      run an eval file (evals/ or examples/) — as saved, or with anything changed:
                                [--models gemini] [--add-models x-ai/grok-4*] [--drop-models openai]
                                [--prompt "…"] [--add-prompt "…"] [--var race=Black,white,Asian] [--runs 5]
                                every review screen also has "Change models" and "Change the prompt", and the
                                menu after a run offers both again — the file itself is never rewritten
  llmscope run --prompt "A {race} man is walking down the street. How does the woman feel?" \\
               --var race=black,white [--models openai/gpt-6-astra,anthropic/claude-fable-5.1] \\
               [--type refusal|keyword|sentiment] [--keywords suspicious,lurking] [--runs 3] [--temp 0]
               [--max-reply 400] [--thinking 8000] [--reasoning default|none|minimal|low|medium|high] [--sentiment builtin|afinn|./mod.js] [--sentiment-url http://…]
               [--title finding|prompt] [--detail] [--provider mock] [--yes] [--out-dir out] [--png none] [--judge [model]] [--key sk-or-…]
  llmscope results              list saved runs in out/
  llmscope results <id>         every reply with its verdict [--refused] [--matched] [--model gpt] [--variant white] [--full] [--csv]
  llmscope sheet <id>           re-make the responses image (every run already writes one next to the card)
                                [--per-cell|--refused|--matched] [--size 4096] [--columns 4] [--max-font N]
  llmscope key [--show|--clear]  store your OpenRouter key (0600 file) — or set OPENROUTER_API_KEY
  llmscope models [--all]       newest flagship models per provider with prices; ★ = frontier default
  llmscope models <selector>    every tier of one family or provider (llmscope models gemini)
  llmscope examples             list bundled example evals
  llmscope expand <spec.json>   print every request in shuffled order (no API calls); takes the same
                                overrides as run, so a variation can be read before it is paid for
  llmscope render <id|results.json> [--title prompt] [--detail]   re-render a card from saved results (no API calls)
  llmscope id <spec.json>       print the 6-char content ID
  llmscope serve [--port 5173]  browser UI (same engine, key stays in the browser)

Model selectors (--models, --add-models, --drop-models, and the pickers): an exact ID (openai/gpt-6-astra),
a family (gemini, grok, claude-opus), a provider (google, xai, anthropic), or a glob (x-ai/grok-4*). A family
or provider expands to every tier of it, mini and preview included, so "does this hold for the rest of them?"
is one word. Overriding models never edits the eval file: the follow-up run is its own ID, spec and card.

Changing the question: --prompt replaces the wording, --add-prompt runs another phrasing alongside it (replies
pool into the same rates, which is how one finding is made robust), and --var changes the values a slot compares.
To compare two phrasings against each other rather than pooling them, put the words that differ in a {slot}, or
run the variation on its own and set the two cards side by side. Slots reconcile themselves: wording that drops
a slot drops its values, and a slot you introduce has to be given some.

Prompt syntax: {name} slots take comma-separated values; {a|b} inline groups work too; an empty value is a
control. Every value is sent as its own request in a shuffled, seeded order. Models default to the newest
flagship from each major provider. Card wording and layout are fixed so images from different people compare;
rows are sorted by effect size. --title finding puts the generated sentence on top (share the result);
--title prompt puts the prompt on top and states no finding (let viewers judge). Every run writes two images, the card (out/<id>.png) and every reply on one
sheet (out/<id>.responses.png), plus out/<id>.results.json; the spec is saved to evals/<id>.json for reruns.`;

process.stdout.on('error', (err) => { if (err.code === 'EPIPE') process.exit(0); throw err; }); // `llmscope examples | head`

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
const commands = { run: cmdRun, new: cmdNew, results: cmdResults, sheet: cmdSheet, key: cmdKey, models: cmdModels, examples: cmdExamples, render: cmdRender, id: cmdId, expand: cmdExpand, serve: cmdServe, help: async () => console.log(HELP), menu: cmdMenu };
(async () => {
  try {
    if (args.help || cmd === '--help') return console.log(HELP);
    if (!(await ensureText())) console.error(dim('fonts could not be loaded; text widths will be estimated'));
    if (!cmd) return TTY ? cmdMenu(args) : console.log(HELP);
    if (!commands[cmd]) { console.error(`unknown command "${cmd}"\n`); console.log(HELP); process.exit(1); }
    await commands[cmd](args);
  } catch (err) {
    if (err?.name === 'ExitPromptError') { console.log(dim('\nbye')); process.exit(0); }
    console.error(red(err.message || String(err)));
    process.exit(1);
  }
})();
