#!/usr/bin/env node
// llmscope CLI. No arguments in a terminal opens a menu; every step is also available as a flag for scripts.
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { planRun, runEval, rescoreRun } from '../src/engine.js';
import { analyze, totalTokens, defaultThreshold, outcomeOf, replyBody } from '../src/analyze.js';
import { shortModel, signed } from '../src/render.js';
import { sentenceCount, selectResponses, excerpt as excerptOf, sheetPresets, SELECTIONS, EXCERPTS, SORTS, SENTENCE_SORTS, SENTENCE_LAYOUTS, SENTENCE_VOICES, SENTENCE_DEFAULTS, MARK_STYLES } from '../src/sheet.js';
import { IMAGES, imagesFor, imageSuffix, sheetKind, markedWords, drawImage } from '../src/images.js';
import { filterResponses, toCsv, toJson } from '../src/responses.js';
import { shareText, altText, PLATFORM_MAX_BYTES } from '../src/share.js';
import { ensureText, fontFilePaths, FONT_SANS } from '../src/text.js';
import { usedVariables, normalizeSpec, specId, strayBraces, isSlotToken, defaultCardTitle, displayTemplate, REASONING_EFFORTS } from '../src/spec.js';
import { freshId } from '../src/id.js';
import { createOpenRouterProvider, checkKey, maskKey } from '../src/providers/openrouter.js';
import { createMockProvider } from '../src/providers/mock.js';
import { setSentimentAnalyzer, resetSentimentAnalyzer, httpSentiment, afinnSentiment, SENTIMENT_CHOICES } from '../src/checks/sentiment.js';
import { createJudge } from '../src/checks/judge.js';
import { findKeywordSpans, countKeywords, isValidKeyword, splitTerms, stripPattern } from '../src/checks/keywords.js';
import { inputWithRecall, isRecall } from '../src/input-recall.js';
import { loadKeywordSets, saveKeywordSet, resolveKeywordTerms, keywordBatches, loadKeywordHistory, rememberKeywordBatch, keywordsDir } from '../src/keyword-sets.js';
import { promptBank, loadPromptHistory, rememberPrompt, modelBank, loadModelHistory, rememberModels } from '../src/recall.js';
import { fetchModels, pickFrontier, newestPerProvider, estimateCost, formatUsd, priceLabel, FRONTIER_DEFAULTS, MAIN_PROVIDERS, resolveModels, subtractModels, modelFamily, isRunnableModel, cleanModels, formatModels, modelKey } from '../src/models.js';
import { resolveApiKey, updateConfig, loadConfig, configPath } from '../src/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);
const dim = (s) => (TTY ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s) => (TTY ? `\x1b[1m${s}\x1b[0m` : s);
const amber = (s) => (TTY ? `\x1b[33m${s}\x1b[0m` : s);
const green = (s) => (TTY ? `\x1b[32m${s}\x1b[0m` : s);
const red = (s) => (TTY ? `\x1b[31m${s}\x1b[0m` : s);
const mark = (s) => (TTY ? `\x1b[43m\x1b[30m${s}\x1b[0m` : `[${s}]`); // the terminal's version of the sheet's amber block
// Inquirer ships cyan for the current row, the confirmed answer, and the help under a list. Replace that
// baby blue with the same amber the rest of the CLI already uses, so every menu reads as one palette.
const MENU_THEME = {
  style: {
    highlight: (text) => amber(text),
    answer: (text) => amber(text),
    description: (text) => amber(text),
    searchTerm: (text) => amber(text),
    key: (text) => amber(bold(`<${text}>`)),
  },
};
function mergeTheme(base, extra) {
  if (!extra) return base;
  return { ...base, ...extra, style: { ...base.style, ...extra.style } };
}
// Amber marks what the eval fills in. A brace group that names no slot is shown red, because it looks wired and is not.
const showSlots = (p) => p.replace(/\{[^{}]*\}/g, (m) => (isSlotToken(m) ? amber(m) : red(m)));
/** Empty braces name no slot, so the model would be asked for `{}` as written. Every other {…} is a slot. */
function warnStrayBraces(prompts) {
  const stray = strayBraces(prompts);
  if (!stray.length) return stray;
  console.log(amber('  {} names no slot — the model is asked for it as written, braces and all'));
  console.log(dim('  name the slot in your own words ({environmental concern}), or double the braces ({{ }}) to send them literally'));
  return stray;
}
const splitList = (v) => (v == null || v === true ? [] : String(v).split(',').map((s) => s.trim()).filter(Boolean));

// ---------- args ----------
const REPEATABLE = new Set(['var', 'prompt', 'add-prompt', 'highlight']);
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
  if (args.keywords) spec.keywords = splitTerms(args.keywords);
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

/** Read a spec by path, falling back to the one packaged with llmscope so `run examples/x.json` works anywhere. */
async function readSpec(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT' || path.isAbsolute(file)) throw err;
    return JSON.parse(await fs.readFile(path.join(ROOT, file), 'utf8'));
  }
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

function titleMode(value, fallback = 'prompt') {
  if (value === undefined || value === true) return fallback;
  if (value !== 'finding' && value !== 'prompt') throw new Error(`--title must be "prompt" (show what was asked) or "finding" (state the result), got "${value}"`);
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

let promptsCache;
async function inquirer() {
  if (!TTY) throw new Error('This step is interactive. Run it in a terminal, or pass flags (see llmscope help).');
  if (promptsCache) return promptsCache;
  const prompts = await import('@inquirer/prompts');
  const wrap = (fn) => (config, ...rest) => fn({ ...config, theme: mergeTheme(MENU_THEME, config.theme) }, ...rest);
  promptsCache = {
    ...prompts,
    select: wrap(prompts.select),
    search: wrap(prompts.search),
    checkbox: wrap(prompts.checkbox),
    confirm: wrap(prompts.confirm),
    input: wrap(prompts.input),
    password: wrap(prompts.password),
    number: wrap(prompts.number),
    expand: wrap(prompts.expand),
    editor: wrap(prompts.editor),
    rawlist: wrap(prompts.rawlist),
  };
  return promptsCache;
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

/**
 * Which provider a guided eval will run on, settled before the first question instead of after the last one.
 * Without this, someone who has never used OpenRouter answers the whole flow and meets "paste your key" at the
 * end, with no way forward and nothing kept. Asking first makes "I do not have one yet" an answer rather than
 * a dead end, and mock replies are a real way to see what the eval would look like.
 * Mutates `args`, so hand it a copy the caller owns.
 * @returns {Promise<boolean>} false when the user chose to go back
 */
async function chooseProviderUpFront(args) {
  if (args.provider || !TTY) return true;
  if ((await resolveApiKey({ flag: args.key })).key) return true;
  const { select } = await inquirer();
  console.log(`\n${bold('No OpenRouter API key yet')}  ${dim('llmscope sends every request through openrouter.ai, so a real run needs one')}`);
  const choice = await select({
    message: 'How should this eval run?',
    choices: [
      { value: 'key', name: 'Paste an OpenRouter key now', description: 'create one at https://openrouter.ai/keys — it is only ever sent to openrouter.ai, and llmscope can save it for next time' },
      { value: 'mock', name: 'Build it against mock replies', description: 'the eval, the review and the card are real; the answers are fake. The eval is saved, so the same run repeats with a key later' },
      { value: 'back', name: 'Back to the menu' },
    ],
  });
  if (choice === 'back') return false;
  if (choice === 'mock') { args.provider = 'mock'; return true; }
  const { key } = await ensureKey({ flag: args.key });
  args.key = key; // carried into the run, so a key the user chose not to save is not asked for a second time
  return true;
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
  const cellText = (c) => `${c.big} (${Math.round(c.tokens_mean)}t)`;
  // One width for the header and every cell under it, so a long variant label — which is what you get when the
  // phrasing itself is a slot — stays lined up with its numbers instead of running into the next column.
  const width = (min, max, lengths) => Math.min(max, Math.max(min, ...lengths));
  const w = width(22, 34, [...a.variants.map((v) => v.label.length + 2), ...a.rows.flatMap((r) => r.cells.map((c) => cellText(c).length + 2))]);
  const nameW = width(14, 30, a.rows.map((r) => shortModel(r.model).length + 4));
  const col = (s, n) => (s.length > n - 1 ? s.slice(0, n - 2) + '…' : s).padEnd(n);
  console.log(dim(col('model', nameW) + a.variants.map((v) => col(v.label, w)).join('')));
  for (const row of a.rows) {
    const cells = row.cells.map((c) => col(cellText(c), w));
    const name = (row.flagged ? amber('≠ ') : '  ') + shortModel(row.model);
    console.log(name.padEnd(nameW + (row.flagged && TTY ? 9 : 0)) + cells.join(''));
  }
  const t = a.summary.tokens;
  if (t) console.log(dim(`cells show avg reply tokens · run used ${fmtN(t.total)} tokens = ${fmtN(t.prompt)} prompt + ${fmtN(t.reply)} reply${t.over_cap ? ` · ${t.over_cap} billed over the cap` : ''}`));
  const c = a.summary.cost;
  if (c?.priced) console.log(`${bold('cost')} ${formatUsd(c.usd)} ${dim(`as billed by OpenRouter${c.unpriced ? ` · ${c.unpriced} of ${c.priced + c.unpriced} replies unpriced` : ''}`)}`);
  const d = a.summary.duration_s;
  if (d != null) console.log(`${bold('took')} ${fmtSeconds(d)} ${dim(`wall clock · ${a.summary.total_runs} replies`)}`);
}

// Steps down from full size until the file fits, coarsely: each one costs a re-render, and the point is to
// clear the limit, not to sit exactly under it.
const SHRINK_STEPS = [0.75, 0.625, 0.5, 0.4, 0.3];

/**
 * @param {number|null} [opts.maxBytes] scale the whole vector down until the PNG fits, so an image meant for a
 *   feed is never rejected at upload for being too large. Layout is untouched; only the pixel count changes.
 * @returns {Promise<{path: string, bytes: number, width: number, scaled: boolean}|null>} null when resvg is absent
 */
async function pngFromSvg(svgText, file, { maxBytes = null } = {}) {
  try {
    const { Resvg } = await import('@resvg/resvg-js');
    const fontFiles = fontFilePaths(); // the exact files the layout was measured with
    const font = { fontFiles, loadSystemFonts: true, defaultFontFamily: FONT_SANS };
    const full = Number(svgText.match(/<svg[^>]*\swidth="(\d+(?:\.\d+)?)"/)?.[1]) || 0;
    let rendered = new Resvg(svgText, { font }).render();
    let png = rendered.asPng();
    let scaled = false;
    if (maxBytes && full) {
      for (const step of SHRINK_STEPS) {
        if (png.length <= maxBytes) break;
        rendered = new Resvg(svgText, { font, fitTo: { mode: 'width', value: Math.round(full * step) } }).render();
        png = rendered.asPng();
        scaled = true;
      }
    }
    await fs.writeFile(file, png);
    return { path: file, bytes: png.length, width: rendered.width, scaled };
  } catch { return null; }
}

// What the responses SVG can do that a flat image cannot, said wherever the sheet is handed over.
const SHEET_LINKS = 'opens in a browser: click a group or a model name to jump there, the background to zoom back out';

/** Which replies the narrowing flags ask for. One reading, so `--refused` means the same on every command. */
const selectFrom = (args) => (args.refused ? 'refused' : args.matched ? 'matched' : 'all');

/** --excerpt full|ends|matches, refused rather than silently ignored when it is anything else. */
function excerptMode(args) {
  const mode = args.excerpt === undefined || args.excerpt === true ? 'full' : String(args.excerpt);
  if (!EXCERPTS[mode]) throw new Error(`--excerpt ${mode}: use one of ${Object.keys(EXCERPTS).join(', ')}`);
  return mode;
}

/** --sort group|model: how the sheet batches the replies. Same treatment — a typo stops the run. */
function sortMode(args) {
  const mode = args.sort === undefined || args.sort === true ? 'group' : String(args.sort);
  if (!SORTS[mode]) throw new Error(`--sort ${mode}: use one of ${Object.keys(SORTS).join(', ')}`);
  return mode;
}

async function writeSheet(run, file, { select = 'all', size = 4096, maxFont = null, columns = null, url = null, png = true, log = true, highlight, excerpt = 'full', sort = 'group' } = {}) {
  // The edit lands on the run first, so every later image of it marks the same words without being told again.
  const marking = markedTerms(run, highlight);
  // "the sentences that matched" needs something to match: say so rather than drawing a page of ellipses.
  if (excerpt === 'matches' && !marking.length) {
    throw new Error('--excerpt matches shows the sentences a keyword matched, and this run marks nothing: name the words to match with --highlight word,phrase');
  }
  // The ends of every reply are an image of their own, written by every run beside the full sheet; every other
  // selection or excerpt redraws the responses image. The catalogue says which is which, and names both.
  const kind = sheetKind({ select, excerpt });
  const { svg, font, columns: cols, replies, exact, highlight: terms } = drawImage(kind, run, { size, maxFont: maxFont || null, columns, select, url, highlight: marking, excerpt, sort });
  const base = file.replace(/\.results\.json$/, '');
  const svgPath = `${base}${imageSuffix(kind)}.svg`;
  await fs.writeFile(svgPath, svg);
  const raster = png ? await pngFromSvg(svg, `${base}${imageSuffix(kind)}.png`, { maxBytes: PLATFORM_MAX_BYTES }) : null;
  const pngPath = raster?.path || null;
  // The SVG is the sheet you read and the PNG is the sheet you post. Only the SVG carries the links — a model
  // name jumps to that model's replies, the background jumps back out, the URL opens the eval — and it is text,
  // so it stays sharp however far in you zoom. So it is the one every "open the responses" leads to.
  const fitted = raster?.scaled ? ` · scaled to ${raster.width}px to fit the ${Math.round(PLATFORM_MAX_BYTES / 1e6)}MB upload limit` : '';
  const note = `${font}px text in ${cols} column${cols > 1 ? 's' : ''}${exact ? '' : dim(' (estimated widths: fonts not loaded)')}${fitted}`;
  if (log) {
    console.log(`${replies} replies on one ${size}px image · ${SELECTIONS[select]} ${SORTS[sort]}${excerpt === 'full' ? '' : ` · ${EXCERPTS[excerpt]}`} · ${note}\n  ${svgPath}   ${dim(SHEET_LINKS)}${pngPath ? `\n  ${pngPath}   ${dim('the same sheet as a PNG, for posting')}` : ''}`);
    if (terms.length) printHitCounts(selectResponses(run, select).responses, terms);
  }
  return { path: svgPath, png: pngPath, svg: svgPath, font, columns: cols, replies, note, highlight: terms, excerpt, sort };
}

const SENTENCE_LINKS = 'opens in a browser: click a batch heading or a model name to jump there, the background to zoom back out';

/** One named choice off a menu, refused rather than silently ignored when it is anything else. */
function pick(args, flag, menu, fallback) {
  const mode = args[flag] === undefined || args[flag] === true ? fallback : String(args[flag]);
  if (!menu[mode]) throw new Error(`--${flag} ${mode}: use one of ${Object.keys(menu).join(', ')}`);
  return mode;
}

/** --mark: how a keyword match is drawn. Same treatment as the other choices — a typo stops the run. */
const markStyleMode = (args) => pick(args, 'mark', MARK_STYLES, SENTENCE_DEFAULTS.mark);

/** --layout rows|stack|flow: how a batch is set out on the sentences page. */
const sentenceLayoutMode = (args) => pick(args, 'layout', SENTENCE_LAYOUTS, SENTENCE_DEFAULTS.layout);

/** --voice neutral|model: what the sentences themselves are set in. */
const sentenceVoiceMode = (args) => pick(args, 'voice', SENTENCE_VOICES, SENTENCE_DEFAULTS.voice);

/**
 * `--markdown` leaves the models' own markdown in the sentences. The page strips it by default: the models
 * answer in markdown, this page is not a markdown renderer, and "### 1. **Origin of the Myth**" spends a reader's
 * attention on marks the page cannot draw. Nothing but the marks is touched.
 */
const sentenceClean = (args) => !(args.markdown === true || args.markdown === 'keep');

/** --sort group|model|keyword for the sentences page, refused rather than silently ignored when it is anything else. */
function sentenceSortMode(args) {
  const mode = args.sort === undefined || args.sort === true ? 'group' : String(args.sort);
  if (!SENTENCE_SORTS[mode]) throw new Error(`--sort ${mode}: use one of ${Object.keys(SENTENCE_SORTS).join(', ')}`);
  return mode;
}

/**
 * Under the sentences image: each batch, and the same matches split down the other axis. Batched by wording that
 * split is the models, which is the number the page exists to produce — the model putting the most of these
 * words into this group's answers, next to what the rest of the field did with the same group. It counts matches
 * rather than sentences, because the matches are the measurement and the sentences are only how they are shown.
 * It is printed rather than drawn because a reader wants to paste it somewhere, and the image already shows it.
 */
function printSentenceBatches(page) {
  // The heading is coloured the way the image heads the same batch: a wording amber, a marked word on its block.
  const plain = (b) => (page.sort === 'model' ? shortModel(b.label) : b.label);
  const shown = (b) => (page.sort === 'group' ? amber(plain(b)) : page.sort === 'keyword' ? mark(plain(b)) : bold(plain(b)));
  const width = Math.max(0, ...page.batches.map((b) => plain(b).length));
  const pad = (b) => ' '.repeat(Math.max(0, width - plain(b).length));
  for (const b of page.batches) {
    console.log(`  ${shown(b)}${pad(b)}  ${b.matches ? sentenceCount(b, page.sort, page.highlight) : dim(sentenceCount(b, page.sort, page.highlight))}`);
    if (b.split.length) console.log(dim(`      ${b.split.map((part) => `${part.label} ${part.matches}`).join(' · ')}`));
  }
  if (page.missing.length) console.log(dim(`  ${page.missing.join(', ')} matched nothing anywhere in these replies`));
}

/**
 * The sentences image: every sentence a marked word turned up in, batched by the variable the eval swapped.
 * Opt-in rather than written by every run — it is the page you ask for once the rates have told you which group
 * to go and read, and which model to read it for.
 */
async function writeSentenceSheet(run, file, { select = 'all', sort = 'group', mark = SENTENCE_DEFAULTS.mark, layout = SENTENCE_DEFAULTS.layout, voice = SENTENCE_DEFAULTS.voice, clean = SENTENCE_DEFAULTS.clean, size = 4096, maxFont = null, columns = null, url = null, png = true, log = true, highlight, suffix = '' } = {}) {
  // As on the sheet, the edit lands on the run first, so every later image of it marks the same words.
  const marking = markedTerms(run, highlight);
  if (!marking.length) throw new Error('the sentences image is every sentence a marked word turned up in, and this run marks nothing: name the words with --highlight word,phrase (a keyword eval already marks its own)');
  const page = drawImage('sentences', run, { size, maxFont: maxFont || null, columns, select, sort, mark, layout, voice, clean, url, highlight: marking });
  // A page of headings over nothing is not an answer: the catalogue says which words were looked for instead.
  if (!page.svg) throw new Error(page.empty);
  const base = file.replace(/\.results\.json$/, '');
  // A page drawn any way but the default writes its own file, so the two can be opened side by side and compared.
  const changed = [
    mark === SENTENCE_DEFAULTS.mark ? null : mark,
    layout === SENTENCE_DEFAULTS.layout ? null : layout,
    voice === SENTENCE_DEFAULTS.voice ? null : voice,
    clean === SENTENCE_DEFAULTS.clean ? null : 'markdown',
  ].filter(Boolean);
  const tag = suffix || changed.map((v) => `.${v}`).join('');
  const svgPath = `${base}${imageSuffix('sentences')}${tag}.svg`;
  await fs.writeFile(svgPath, page.svg);
  const raster = png ? await pngFromSvg(page.svg, `${base}${imageSuffix('sentences')}${tag}.png`, { maxBytes: PLATFORM_MAX_BYTES }) : null;
  const pngPath = raster?.path || null;
  if (log) {
    const fitted = raster?.scaled ? ` · scaled to ${raster.width}px to fit the ${Math.round(PLATFORM_MAX_BYTES / 1e6)}MB upload limit` : '';
    const words = `${page.missing.length ? `${page.words} of ${page.words + page.missing.length}` : page.words} marked word${page.words + page.missing.length === 1 ? '' : 's'}`;
    console.log(`${page.matches} keyword match${page.matches === 1 ? '' : 'es'} in ${page.sentences} sentence${page.sentences === 1 ? '' : 's'} from ${page.replies} repl${page.replies === 1 ? 'y' : 'ies'} on one ${size}px image · ${words}${select === 'all' ? '' : ` · ${SELECTIONS[select]}`} · ${SENTENCE_SORTS[page.sort]} · ${SENTENCE_LAYOUTS[page.layout]} · matches ${MARK_STYLES[page.mark]} · ${page.font}px text in ${page.columns} column${page.columns > 1 ? 's' : ''}${page.exact ? '' : dim(' (estimated widths: fonts not loaded)')}${fitted}\n  ${svgPath}   ${dim(SENTENCE_LINKS)}${pngPath ? `\n  ${pngPath}   ${dim('the same page as a PNG, for posting')}` : ''}`);
    printSentenceBatches(page);
  }
  return { path: svgPath, png: pngPath, svg: svgPath, ...page };
}

async function writeOutputs(run, { outDir = 'out', out, svg, png, url, title, highlight, excerpt = 'full', sort = 'group' } = {}) {
  markedTerms(run, highlight); // before the run is written out, so the results file carries the edit
  const a = analyze(run);
  const mode = titleMode(title, run.spec.card_title || defaultCardTitle(run.spec.primary));
  await fs.mkdir(outDir, { recursive: true });
  const paths = {
    json: out || path.join(outDir, `${run.id}.results.json`),
    svg: svg || path.join(outDir, `${run.id}${imageSuffix('card')}.svg`),
    png: png === false ? null : png || path.join(outDir, `${run.id}${imageSuffix('card')}.png`),
    mode,
    keywords: null,
  };
  await fs.writeFile(paths.json, JSON.stringify(run, null, 2));
  // The card is the artifact people post, and a PNG carries no words. Alt text and a caption go beside it so
  // the finding is still readable to a screen reader, to a search engine, and to anyone whose images failed.
  paths.share = paths.json.replace(/\.results\.json$/, '.share.txt');
  await fs.writeFile(paths.share, shareText(a, { names: namesMap(), url: url || null }));
  // Every image the run writes, in the catalogue's order: the card, then the keyword card when words are marked,
  // then the two sheets. The same list is what the browser offers and what the landing page's samples are drawn
  // through, so what a run leaves in out/ and what the page shows can only differ by a row missing from one of
  // them — and a row with no writer of its own here is still written, at its defaults.
  const written = {};
  const opts = { a, png: png !== false, url, excerpt, sort, title: mode };
  for (const image of imagesFor(run)) {
    const writer = WRITERS[image.kind] || ((r, p, o) => writeImage(r, p.json, image.kind, o));
    written[image.kind] = await writer(run, paths, opts);
  }
  return { analysis: a, paths, sheet: written.responses, keywords: written.keywords || null };
}

/**
 * How each image in the catalogue is written beside a run's results. The card, the sheets and the keyword card
 * have writers of their own because each says something on the way out — the sheet its text size and column
 * count, the keyword card its word count — and `paths` learns where each one landed.
 */
const WRITERS = {
  async card(run, paths, { a, url, title }) {
    const { svg } = drawImage('card', run, { a, url: url || null, names: namesMap(), date: run.finished_at, title });
    await fs.writeFile(paths.svg, svg);
    if (paths.png && !(await pngFromSvg(svg, paths.png, { maxBytes: PLATFORM_MAX_BYTES }))) { paths.png = null; console.error(dim('PNG export needs @resvg/resvg-js (npm install @resvg/resvg-js); SVG written instead.')); }
    return { path: paths.png || paths.svg, png: paths.png, svg: paths.svg };
  },
  // Every reply on one sheet, so the card and the sheet together show a viewer everything.
  async responses(run, paths, { png, url, excerpt, sort }) {
    const sheet = await writeSheet(run, paths.json, { png, url, log: false, excerpt, sort });
    paths.sheet = sheet.path;
    paths.sheetPng = sheet.png;
    return sheet;
  },
  // The first and last sentence of every reply, so where twenty models each opened and landed can be read side
  // by side without the whole of any reply in the way. The full sheet is for reading one reply; this one is for
  // comparing all of them.
  async ends(run, paths, { png, url, sort }) {
    const ends = await writeSheet(run, paths.json, { png, url, log: false, excerpt: 'ends', sort });
    paths.ends = ends.path;
    paths.endsPng = ends.png;
    return ends;
  },
  // The rate of each marked word by group and by model. The catalogue offers it only when there are words.
  async keywords(run, paths, { png, url }) {
    const card = await writeKeywordCard(run, paths.json, { terms: markedTerms(run), url, png, log: false });
    paths.keywords = card.path;
    return card;
  },
};

/** Any image in the catalogue, drawn at its defaults and written beside the run's results: what a kind gets until it has a writer of its own. */
async function writeImage(run, file, kind, { a = null, url = null, png = true, title = 'prompt', highlight } = {}) {
  const drawn = drawImage(kind, run, { a, url: url || null, names: namesMap(), date: run.finished_at, title, highlight: markedTerms(run, highlight) });
  if (!drawn.svg) throw new Error(drawn.empty);
  const base = file.replace(/\.results\.json$/, '');
  const svgPath = `${base}${imageSuffix(kind)}.svg`;
  await fs.writeFile(svgPath, drawn.svg);
  const raster = png ? await pngFromSvg(drawn.svg, `${base}${imageSuffix(kind)}.png`, { maxBytes: PLATFORM_MAX_BYTES }) : null;
  return { ...drawn, path: raster?.path || svgPath, png: raster?.path || null, svg: svgPath };
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
  // The run's own id, minted now so the review names the files the run will write. It is not the eval's id: that
  // one is content-addressed and names the file in evals/, and the same eval run twice is two runs, two ids.
  const runId = await freshId(plan.id);
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
    printReview(plan, provider, shape, costLine, specTarget(plan, args), runId);
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
          // The review counts variants, so the way to change them has to be findable under that word too,
          // not only behind "Change the prompt", which is where it used to live.
          ...(Object.keys(spec.variables || {}).length
            ? [{ value: 'values', name: `Change the variants  ${dim(Object.entries(spec.variables).map(([n, v]) => `{${n}} ${v.map((x) => x || '(none)').join(', ')}`).join(' · '))}`, description: 'add, remove or reword the groups being compared — one column per value, and the file is not modified' }]
            : []),
          { value: 'prompt', name: 'Change the prompt', description: 'the wording, another phrasing alongside it, or the variants — also not written back to the file' },
          { value: 'settings', name: `Change the settings  ${dim(`${spec.runs} run${spec.runs > 1 ? 's' : ''} per cell · temperature ${spec.temperature} · ${spec.max_tokens} max reply tokens`)}`, description: 'runs per cell, temperature, reply cap, thinking budget, reasoning effort — the request count and cost redraw' },
          { value: 'cancel', name: 'Cancel' },
        ],
      });
      if (choice === 'cancel') {
        // "Nothing was sent" is about the requests. The eval itself was just described by hand, so it is kept:
        // backing out of a run should cost the run, not the ten answers that defined it.
        const target = specTarget(plan, args);
        if (target.changed && args.saveSpec !== false) {
          await fs.mkdir('evals', { recursive: true });
          await fs.writeFile(target.file, JSON.stringify(spec, null, 2));
        }
        console.log(dim(`cancelled; nothing was sent · the eval is saved: llmscope run ${target.file}`));
        return null;
      }
      if (choice === 'run') break;
      if (choice === 'show') { printRequests(plan); continue; }
      if (choice === 'prompt' || choice === 'values' || choice === 'settings') {
        const edited = choice === 'settings' ? await editSettings(spec) : await editPrompt(spec, { start: choice === 'values' ? '::values' : null, outDir: args['out-dir'] || 'out' });
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
      const picked = await pickModels(list, { current: spec.models, suggestions: families, message: 'Run this eval on which models?', outDir: args['out-dir'] || 'out' });
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
  const run = await runEval(spec, { provider, judge, id: runId, concurrency: Number(args.concurrency) || 4, onProgress: progressWriter(plan.jobs.length) });
  run.sentiment_analyzer = analyzerName;
  const { analysis, paths, sheet, keywords } = await writeOutputs(run, { outDir: args['out-dir'] || 'out', out: args.out, svg: args.svg, png: args.png === 'none' ? false : args.png, url: args.url, highlight: highlightTerms(args), excerpt: excerptMode(args), sort: sortMode(args) });
  printSummary(analysis);
  printProblems(run);
  // Running a file on other models leaves that file alone and writes the eval it actually ran, so it can be rerun.
  const target = specTarget(plan, args);
  const saved = target.changed && args.saveSpec !== false;
  if (saved) {
    await fs.mkdir('evals', { recursive: true });
    await fs.writeFile(target.file, JSON.stringify(spec, null, 2));
  }
  void keywords;
  console.log(`\nshare: ${bold(plan.spec.share_base + run.id)}   rerun: llmscope run ${target.file}`);
  console.log(`results:   ${paths.json}   ${dim(`browse: llmscope results ${run.id}`)}\ncard:      ${paths.png || paths.svg}   ${dim(`title: ${paths.mode} · post this one`)}\nresponses: ${paths.sheet}   ${dim(`${sheet.replies} replies · ${sheet.note}${sheet.highlight.length ? ` · highlighting ${sheet.highlight.join(', ')}` : ''} · ${SHEET_LINKS}`)}\nends:      ${paths.ends}   ${dim('the first and last sentence of every reply · how each model opens and where it lands')}${paths.keywords ? `\nkeywords:  ${paths.keywords}   ${dim(`${keywordSummary(analysis, run)} · post this beside the card`)}` : ''}\nalt text:  ${paths.share}   ${dim('alt text and caption to paste with the card')}`);
  // Printed, not just written: the alt field is filled in at the moment of posting, and that is the terminal.
  console.log(`\n${bold('alt text')} ${dim('(paste into the image description field)')}\n${altText(analysis, { names: namesMap() })}`);
  if (TTY && !args.yes) await afterRun(run, paths, { outDir: args['out-dir'] || 'out', specSaved: saved, analysis, args });
  return run;
}

function printReview(plan, provider, shape, costLine, spec_file = { file: null, changed: true }, runId = plan.id) {
  const spec = plan.spec;
  // A slot named in words is a wide label; widen the whole column for it rather than let one row jut out.
  const pad = Math.min(26, Math.max(9, ...Object.keys(spec.variables).map((n) => n.length + 2)));
  const kv = (k, v) => console.log(`  ${dim(k.padEnd(pad))} ${v}`);
  console.log(`\n${bold('Review')}  ${dim('id ' + runId + (provider.name === 'mock' ? ' · mock data' : ''))}`);
  const measure = spec.primary === 'keyword'
    ? `keyword inclusion — response contains ${spec.keyword_mode === 'all' ? 'all of' : 'any of'}: ${spec.keywords.join(', ')}`
    : spec.primary === 'sentiment' ? `sentiment — analyzer: ${spec.sentiment_analyzer}` : 'refusal rate per wording';
  kv('measure', measure);
  spec.prompts.forEach((p, i) => kv(i === 0 ? (spec.prompts.length > 1 ? 'prompts' : 'prompt') : '', showSlots(p)));
  const names = Object.keys(spec.variables);
  if (names.length) for (const name of names) kv(`{${name}}`, spec.variables[name].map((v) => (v === '' ? '(none)' : v)).join(', '));
  else kv('slots', dim('none — single-column card'));
  if (spec.system) kv('system', spec.system);
  kv('models', `${spec.models.length}: ${spec.models.map(shortModel).join(', ')}`);
  kv('settings', `${spec.runs} run${spec.runs > 1 ? 's' : ''} per cell · temperature ${spec.temperature} · max reply ${spec.max_tokens} tokens · thinking budget ${spec.thinking_budget} on top for models that think · reasoning ${spec.reasoning}`);
  kv('requests', `${plan.jobs.length}  ${dim(shape)}  ${costLine}`);
  // The run's files carry the run's id; the eval file carries the eval's, so a rerun lands beside this run, not on it.
  kv('outputs', `out/${runId}.{results.json,svg,png} · spec ${spec_file.changed ? 'saved to' : 'from'} ${spec_file.file || `evals/${plan.id}.json`}`);
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
/**
 * What a saved run looks like at a glance. A list of runs is a list of near-identical kickers
 * ("REFUSAL RATE · 4 OF 15 MODELS TESTED REFUSED") unless it also carries the three things that
 * actually tell two evals apart: the prompt, the words being matched, and the models asked.
 */
function familySummary(models = []) {
  const counts = new Map();
  for (const id of models) counts.set(modelFamily(id), (counts.get(modelFamily(id)) || 0) + 1);
  const parts = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([f, n]) => (n > 1 ? `${f}×${n}` : f));
  // A focused set is the identifying fact ("gemini×15"); a broad sweep is not, so it just gets counted.
  return parts.length > 3 ? `${models.length} models, ${parts.length} families` : parts.join(', ');
}

const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

/** The prompt with `{slot}` replaced by the values it takes, so a list of runs is not a list of `{v1}`. */
function shownPrompt(r) {
  return displayTemplate(r.prompt || '', r.variables || {});
}

/**
 * Cut a prompt to n characters. If the usual left clip would hide the `{…}` group, start at the
 * opening brace instead — the values in there are what tell two otherwise-identical prompts apart.
 */
function clipPrompt(s, n) {
  s = oneLine(s);
  if (s.length <= n) return s;
  const open = s.indexOf('{');
  const close = open >= 0 ? s.indexOf('}', open) : -1;
  if (close < 0 || close < n - 1) return clip(s, n);
  return clip(s.slice(open), n);
}

function specIdentity(spec = {}) {
  const prompts = spec.prompts || [];
  const variables = spec.variables || {};
  return {
    check: spec.primary || '',
    prompt: oneLine(prompts[0] || ''),
    morePrompts: Math.max(0, prompts.length - 1),
    slots: Object.keys(variables),
    variables,
    keywords: spec.keywords || [],
    models: spec.models || [],
    families: familySummary(spec.models || []),
  };
}

function runIdentity(run) {
  return {
    ...specIdentity(run.spec || {}),
    id: run.id,
    eval: run.spec_id || null, // the eval this run is a generation of; runs saved before runs had their own ids carry none
    when: run.finished_at || run.started_at || '',
    n: (run.results || []).length,
    mock: run.provider === 'mock',
    kicker: analyze(run).title.kicker,
  };
}

/** The half-line that sits beside the name: what is checked, over which models, on how many replies. */
function runFacts(r) {
  const bits = [r.check, r.families];
  if (r.n != null) bits.push(`${r.n} replies`);
  if (r.keywords.length) bits.splice(1, 0, `“${clip(r.keywords.join(', '), 40)}”`);
  if (r.mock) bits.push('mock'); // the slots are not listed here: their values get a line of their own below
  return bits.filter(Boolean).join(' · ');
}

/**
 * The values a slot will be filled with. An eval that compares groups is only legible once you can see
 * the groups: `{party}` on its own says nothing about whether this run is about US or German parties.
 */
function slotLines(r, indent = '  ') {
  const pad = Math.min(26, Math.max(10, ...r.slots.map((n) => n.length + 2)));
  return r.slots.map((name) => `${indent}${dim(`{${name}}`.padEnd(pad))} ${(r.variables[name] || []).map((v) => (v === '' ? dim('(none)') : v)).join(', ')}`);
}

/** The flag that changes those values without touching the file, spelled out with this eval's own slot. */
function swapHint(file, r) {
  if (!r.slots.length) return null;
  const name = r.slots[0];
  return `llmscope run ${file} --var ${name}=${(r.variables[name] || []).slice(0, 3).map((v) => v || '""').join(',')}`;
}

/** Everything typed into a run, as one searchable string for --find. Slot values count: `{v1}` is not what people type. */
const runHaystack = (r) => [
  r.id, r.eval || '', r.prompt, shownPrompt(r), r.check, r.keywords.join(' '), r.slots.join(' '),
  Object.values(r.variables || {}).flat().join(' '), r.models.join(' '), r.kicker,
].join(' ').toLowerCase();

async function listRuns(outDir = 'out', { find = '' } = {}) {
  let files = [];
  try { files = (await fs.readdir(outDir)).filter((f) => f.endsWith('.results.json')); } catch {}
  const runs = [];
  for (const f of files) {
    try {
      const r = JSON.parse(await fs.readFile(path.join(outDir, f), 'utf8'));
      runs.push({ file: path.join(outDir, f), ...runIdentity(r) });
    } catch {}
  }
  runs.sort((a, b) => b.when.localeCompare(a.when));
  const seen = new Set(); // the same eval rendered to two files shows once, newest first
  const unique = runs.filter((r) => !seen.has(r.id) && seen.add(r.id));
  const needle = String(find || '').trim().toLowerCase();
  return needle ? unique.filter((r) => runHaystack(r).includes(needle)) : unique;
}

async function loadRun(file, { quiet = false } = {}) {
  const run = JSON.parse(await fs.readFile(file, 'utf8'));
  const changed = rescoreRun(run);
  // A note, not output: when stdout is the replies themselves it goes to stderr so the blob stays the replies.
  if (changed) (quiet ? console.error : console.log)(dim(`re-scored with the current rules: ${changed} verdict${changed > 1 ? 's' : ''} changed since this run was saved`));
  return run;
}

async function findResults(ref, outDir = 'out') {
  if (ref.endsWith('.json')) return ref;
  const file = path.join(outDir, `${ref}.results.json`);
  try { await fs.access(file); return file; } catch {}
  // An eval's id names its file in evals/, not a run; given one, the newest run of that eval is what is meant.
  const ofEval = (await listRuns(outDir)).find((r) => r.eval === ref);
  if (ofEval) { console.error(dim(`${ref} is an eval; showing its newest run, ${ofEval.id}`)); return ofEval.file; }
  throw new Error(`no results for "${ref}" (looked for ${file}). \`llmscope results\` lists runs.`);
}

/**
 * What `--highlight` asks for, in three states, because "mark nothing" and "never said" are different things:
 *   left out                     → undefined, keep whatever the run is already marking
 *   `--highlight word,phrase`    → those terms (repeatable; /regex/ allowed)
 *   `--no-highlight`, `… none`   → [], mark nothing
 *   `--highlight reset` (or bare)→ null, forget the edit and go back to the eval's own keywords
 * Marking is presentation only, so a refusal run can be pointed at a word after the fact without rescoring.
 */
function highlightTerms(args) {
  if (args['no-highlight']) return [];
  if (args.highlight === undefined) return undefined;
  const given = [].concat(args.highlight);
  if (given.length === 1 && given[0] === 'none') return [];
  if (given.length === 1 && (given[0] === true || given[0] === 'reset')) return null;
  const terms = given.flatMap(splitTerms);
  if (!terms.length) return null;
  const bad = terms.filter((t) => !isValidKeyword(t));
  if (bad.length) throw new Error(`--highlight ${bad.join(', ')}: not a valid pattern (plain words and phrases need no slashes; /regex/ does)`);
  return terms;
}

/**
 * The terms a run is marking, after applying an edit. The run itself remembers them, so an edit made once holds
 * for every later image and printout of that run — until the next edit, or `--highlight reset`, which forgets it
 * and hands the job back to the eval's own keywords. `undefined` is not an edit; it just reads what is there.
 */
function markedTerms(run, edit) {
  if (edit !== undefined) {
    if (edit === null) delete run.highlight;
    else run.highlight = edit;
  }
  return markedWords(run);
}

/** Save the run back, so an edit to what it marks outlives the command that made it. */
async function saveRun(run, file) {
  await fs.writeFile(file, JSON.stringify(run, null, 2));
}

// ---------- keyword batches ----------
/**
 * The same batch of keywords gets typed into four prompts and two flags, so all six read one list: what was
 * typed lately, the named sets in keywords/, the evals on disk and the runs already finished. Nothing here
 * changes a verdict; it only saves retyping words that already exist somewhere in the project.
 */
let setsCache = null;
async function keywordSets() {
  if (!setsCache) setsCache = await loadKeywordSets();
  return setsCache;
}

async function keywordChoices(outDir = 'out') {
  return keywordBatches({
    sets: await keywordSets(),
    history: await loadKeywordHistory(),
    evalDirs: [path.resolve('evals'), path.join(ROOT, 'examples')],
    runDirs: [path.resolve(outDir)],
  });
}

/** Pick a batch by eye or by typing at it: the words themselves, a set name, an eval filename or a run ID. */
async function pickKeywordBatch(batches) {
  const { search } = await inquirer();
  if (!batches.length) {
    console.log(dim('nothing saved to pick from yet — type the words once and they are here next time'));
    return null;
  }
  const choices = batches.map((b) => ({
    value: b,
    name: `${clip(b.terms.join(', '), 44).padEnd(44)} ${dim(clip(b.origin, 30))}`,
    description: [
      b.description,
      `${b.terms.length} term${b.terms.length === 1 ? '' : 's'}: ${b.terms.join(', ')}`,
      b.set && b.source !== 'set' ? `these are the words of @${b.set}` : null,
    ].filter(Boolean).join('\n'),
  }));
  choices.push({ value: null, name: dim('Back — keep typing'), description: 'leave the words as they are' });
  const hay = (b) => (b ? [b.terms.join(' '), b.origin, b.set || '', b.description].join(' ').toLowerCase() : 'back');
  return search({
    message: 'Which batch? (type to filter by word, set name, eval or run)',
    pageSize: 12,
    source: (term) => {
      const t = String(term || '').trim().toLowerCase();
      return t ? choices.filter((c) => hay(c.value).includes(t)) : choices;
    },
  });
}

/**
 * Ask for a batch of keywords with every batch the project already has one key away: up-arrow walks the recent
 * ones, ctrl-r opens the picker, and @name pastes a saved set in mid-list. What is accepted is remembered, so
 * the next eval that wants the same words does not retype them.
 */
async function askKeywords({ message, current = [], required = false, outDir = 'out' } = {}) {
  const sets = await keywordSets();
  const batches = await keywordChoices(outDir);
  const history = batches.map((b) => b.terms.join(', '));
  const hint = batches.length
    ? dim(`  ↑ ${batches.length} earlier batch${batches.length === 1 ? '' : 'es'} · ctrl-r to pick one${sets.length ? ' · @name pastes a saved set' : ''}`)
    : '';
  let seed = current.join(', ');
  for (;;) {
    const answer = await inputWithRecall({
      message,
      default: seed,
      prefill: 'editable',
      history,
      recall: batches.length > 0,
      hint,
      theme: MENU_THEME,
      validate: (v) => {
        const { terms, missing } = resolveKeywordTerms(v, sets);
        if (missing.length) return `no keyword set named ${missing.join(', ')} — llmscope sets lists them`;
        const bad = terms.filter((t) => !isValidKeyword(t));
        if (bad.length) return `not a valid pattern: ${bad.join(', ')} (plain words and phrases need no slashes; /regex/ does)`;
        if (required && !terms.length) return 'Give at least one';
        return true;
      },
    });
    if (isRecall(answer)) {
      const picked = await pickKeywordBatch(batches);
      // A picked set goes back in as @name rather than its words: shorter to read, and it stays a reference.
      seed = picked ? (picked.set ? `@${picked.set}` : picked.terms.join(', ')) : answer.typed;
      continue;
    }
    const { terms } = resolveKeywordTerms(answer, sets);
    await rememberKeywordBatch(terms);
    return terms;
  }
}

// ---------- prompt recall ----------
/**
 * The same recall over prompts. Testing a subtle change means running the last wording with two words moved,
 * so the previous wording has to be a keystroke away: up-arrow walks what this project has asked before, most
 * recent first, and ctrl-r opens the picker. Nothing here changes a prompt; it only saves retyping one.
 */
async function promptChoices(outDir = 'out') {
  return promptBank({
    history: await loadPromptHistory(),
    evalDirs: [path.resolve('evals'), path.join(ROOT, 'examples')],
    runDirs: [path.resolve(outDir)],
  });
}

async function pickPrompt(entries) {
  const { search } = await inquirer();
  if (!entries.length) {
    console.log(dim('nothing asked yet — the first prompt you type is here for the next one'));
    return null;
  }
  const choices = entries.map((e) => ({
    value: e,
    // Padded before it is coloured, so the slots can be picked out without the escape codes shifting the column.
    name: `${showSlots(clip(oneLine(e.prompt), 46).padEnd(46))} ${dim(clip(e.origin, 26))}`,
    description: showSlots(clip(oneLine(e.prompt), 300)),
  }));
  choices.push({ value: null, name: dim('Back — keep typing'), description: 'leave the wording as it is' });
  const hay = (e) => (e ? `${e.prompt} ${e.origin}`.toLowerCase() : 'back');
  return search({
    message: 'Which prompt? (type to filter by wording, eval or run)',
    pageSize: 12,
    source: (term) => {
      const t = String(term || '').trim().toLowerCase();
      return t ? choices.filter((c) => hay(c.value).includes(t)) : choices;
    },
  });
}

/** Ask for one prompt, with every prompt this project has asked one key away. What is accepted is remembered. */
async function askPrompt({ message, current = '', outDir = 'out' } = {}) {
  const entries = await promptChoices(outDir);
  const history = entries.map((e) => e.prompt);
  const hint = entries.length
    ? dim(`  ↑ ${entries.length} earlier prompt${entries.length === 1 ? '' : 's'} · ctrl-r to pick one`)
    : '';
  let seed = current;
  for (;;) {
    const answer = await inputWithRecall({
      message,
      default: seed,
      prefill: 'editable',
      history,
      recall: entries.length > 0,
      hint,
      theme: MENU_THEME,
      validate: (v) => (v.trim() ? true : 'Type a prompt'),
    });
    if (isRecall(answer)) {
      const picked = await pickPrompt(entries);
      seed = picked ? picked.prompt : answer.typed;
      continue;
    }
    await rememberPrompt(answer);
    return answer;
  }
}

// ---------- model-set recall ----------
/**
 * The same recall over model sets. A new eval starts from the last set you picked, or the frontier defaults
 * if you have not picked one yet; up-arrow walks every set this project has used, and ctrl-r opens the
 * catalogue list so a set can still be ticked rather than retyped.
 */
async function modelChoices(outDir = 'out', frontier = []) {
  return modelBank({
    history: await loadModelHistory(),
    evalDirs: [path.resolve('evals'), path.join(ROOT, 'examples')],
    runDirs: [path.resolve(outDir)],
    frontier,
  });
}

/** Tick models from the live catalogue, newest flagships first, with whatever is already chosen pre-ticked. */
async function checkboxModels(list, current = []) {
  const { checkbox, Separator } = await inquirer();
  const picked = new Set(cleanModels(current));
  const frontier = new Set(pickFrontier(list));
  const choices = [];
  if (list.length) {
    const pool = list.filter(isRunnableModel);
    for (const group of newestPerProvider(list, MAIN_PROVIDERS.map((p) => p.prefix), 3)) {
      const extra = pool.filter((m) => m.provider === group.prefix && picked.has(m.id) && !group.models.some((x) => x.id === m.id));
      const models = [...group.models, ...extra];
      if (!models.length) continue;
      choices.push(new Separator(dim(`— ${group.name}`)));
      for (const m of models) {
        choices.push({
          value: m.id,
          name: `${m.id.padEnd(42)} ${dim(priceLabel(m))}${frontier.has(m.id) ? ' ★' : ''}`,
          checked: picked.has(m.id),
        });
      }
    }
    const shown = new Set(choices.map((c) => c.value).filter(Boolean));
    const rest = [...picked].filter((id) => !shown.has(id));
    if (rest.length) {
      choices.push(new Separator(dim('— already selected')));
      for (const id of rest) choices.push({ value: id, name: id, checked: true });
    }
  } else {
    const ids = picked.size ? [...picked] : FRONTIER_DEFAULTS;
    const seen = new Set();
    for (const id of [...ids, ...FRONTIER_DEFAULTS]) {
      if (seen.has(id)) continue;
      seen.add(id);
      choices.push({ value: id, name: id, checked: picked.size ? picked.has(id) : true });
    }
  }
  return checkbox({
    message: 'Models to test (space toggles, enter confirms):',
    choices,
    pageSize: 18,
    validate: (v) => (v.length ? true : 'Pick at least one'),
  });
}

/** Pick a remembered set by eye, or open the catalogue list. Back leaves the typed text alone. */
async function pickModelSet(list, { current = [], entries = [] } = {}) {
  const { search } = await inquirer();
  const byKey = new Map(entries.map((e) => [modelKey(e.models), e]));
  const choices = entries.map((e) => ({
    value: formatModels(e.models),
    name: `${String(e.models.length).padStart(2)}  ${clip(e.models.map(shortModel).join(', '), 44).padEnd(44)} ${dim(clip(e.origin, 24))}`,
    description: `${e.models.length} model${e.models.length === 1 ? '' : 's'}: ${e.models.join(', ')}`,
  }));
  choices.push({ value: '::list', name: 'Pick from the list…', description: 'tick models by provider, newest first' });
  choices.push({ value: null, name: dim('Back — keep typing'), description: 'leave the models as they are' });
  const hay = (v) => {
    if (v === '::list') return 'pick list catalogue tick';
    if (!v) return 'back';
    const e = byKey.get(modelKey(splitList(v)));
    return `${v} ${e?.origin || ''}`.toLowerCase();
  };
  const picked = await search({
    message: 'Which models? (type to filter by name, eval or run)',
    pageSize: 12,
    source: (term) => {
      const t = String(term || '').trim().toLowerCase();
      return t ? choices.filter((c) => hay(c.value).includes(t)) : choices;
    },
  });
  if (picked === '::list') return checkboxModels(list, current);
  return picked ? splitList(picked) : null;
}

/**
 * Ask for a model set with every set the project already has one key away: up-arrow walks the recent ones,
 * ctrl-r opens the picker (and the catalogue list), and a family, provider, glob or ID types the same way
 * --models does. What is accepted is remembered, so the next eval starts from it.
 */
async function askModels(list, { current = [], outDir = 'out' } = {}) {
  const frontier = pickFrontier(list);
  const recent = await loadModelHistory();
  const entries = await modelChoices(outDir, frontier);
  const history = entries.map((e) => formatModels(e.models));
  const hint = dim(`  ↑ ${entries.length} earlier set${entries.length === 1 ? '' : 's'} · ctrl-r to pick from the list · family, provider, glob or ID`);
  let seed = formatModels(current.length ? current : (recent[0]?.models || frontier));
  for (;;) {
    const answer = await inputWithRecall({
      message: 'Models to test:',
      default: seed,
      prefill: 'editable',
      history,
      recall: true,
      hint,
      theme: MENU_THEME,
      validate: (v) => {
        const sels = splitList(v);
        if (!sels.length) return 'Pick at least one model';
        const { ids, unmatched } = resolveModels(sels, list);
        if (unmatched.length) return `no model matched: ${unmatched.join(', ')}`;
        if (!ids.length) return 'Pick at least one model';
        return true;
      },
    });
    if (isRecall(answer)) {
      const typed = resolveModels(splitList(answer.typed), list).ids;
      const start = typed.length ? typed : splitList(seed);
      const picked = entries.length
        ? await pickModelSet(list, { current: start, entries })
        : await checkboxModels(list, start.length ? start : frontier);
      if (picked?.length) seed = formatModels(picked);
      else seed = answer.typed;
      continue;
    }
    const { ids, expansions, unmatched } = resolveModels(splitList(answer), list);
    for (const e of expansions) if (e.kind !== 'id') console.log(dim(`  ${e.selector} → ${e.ids.length} ${e.kind} model${e.ids.length === 1 ? '' : 's'}`));
    if (unmatched.length) console.log(amber(`  no model matched: ${unmatched.join(', ')}`));
    await rememberModels(ids);
    return ids;
  }
}

/**
 * `--keywords @hedges,maybe` and `--highlight @threat` name saved sets. Expand them once, before any command
 * runs, so everything downstream sees plain words. A name matching nothing stops the run rather than quietly
 * becoming a literal keyword: an eval scored on the word "@hedges" looks like it worked and measures nothing.
 */
async function expandKeywordSetFlags(args) {
  for (const flag of ['keywords', 'highlight']) {
    const given = args[flag];
    if (given === undefined) continue;
    const list = [].concat(given);
    if (!list.some((v) => typeof v === 'string' && v.includes('@'))) continue;
    const sets = await keywordSets();
    const parts = list.map((v) => {
      if (typeof v !== 'string' || !v.includes('@')) return v;
      const { terms, missing } = resolveKeywordTerms(v, sets);
      if (missing.length) throw new Error(`--${flag} ${missing.join(', ')}: no such keyword set. \`llmscope sets\` lists them (they live in ${path.relative(process.cwd(), keywordsDir()) || 'keywords'}/)`);
      return terms.join(',');
    });
    args[flag] = Array.isArray(given) ? parts : parts[0];
  }
}

/**
 * A reply with every match wrapped in the terminal's highlight. Only in a terminal, where the mark is color
 * over the same characters: piped or redirected, a reply stays exactly what the model said, and the count line
 * under the replies carries the same information without editing anyone's words.
 */
function markHits(text, terms) {
  if (!TTY || !terms.length) return text;
  let out = '';
  let last = 0;
  for (const s of findKeywordSpans(text, terms)) { out += text.slice(last, s.start) + mark(text.slice(s.start, s.end)); last = s.end; }
  return out + text.slice(last);
}

const VERDICT_LABEL = { error: 'ERROR', refused: 'REFUSED', matched: 'INCLUDED', answered: 'answered' };

/**
 * One reply's verdict, split into the label and the detail behind it. Which outcome it is comes from analyze.js,
 * so a badge on screen and a line in an exported file are two spellings of one judgement, never two judgements.
 */
function verdictOf(r) {
  const kind = outcomeOf(r);
  const detail = kind === 'error' ? String(r.error)
    : kind === 'refused' ? (r.refusal_reason || '')
      : kind === 'matched' ? (r.keyword_hits || []).map(stripPattern).join(', ')
        : '';
  return { kind, label: VERDICT_LABEL[kind], detail };
}

/** The verdict as a terminal badge: the label in its own color, the detail dimmed behind it. */
function verdictBadge(r) {
  const { kind, label, detail } = verdictOf(r);
  const tint = kind === 'answered' ? green : kind === 'matched' ? amber : red;
  if (!detail) return tint(label);
  return tint(label) + dim(kind === 'error' ? ` ${detail}` : ` (${detail})`);
}

/** The same verdict with no color, for a file that will be read outside a terminal. */
function verdictText(r) {
  const { kind, label, detail } = verdictOf(r);
  if (!detail) return label;
  return kind === 'error' ? `${label} ${detail}` : `${label} (${detail})`;
}

function printResponses(run, { full = false, highlight = null, excerpt: mode = 'full', rs: given = null, filters: givenFilters = [] } = {}) {
  const { rs, filters } = given ? { rs: given, filters: givenFilters } : filterResponses(run);
  // Whatever the run marks — the same words the responses image marks, resolved by the caller.
  const terms = highlight || [];
  console.log(`\n${bold(`${rs.length} of ${run.results.length} responses`)}${filters.length ? dim(' · ' + filters.join(' · ')) : ''}${mode === 'full' ? '' : dim(' · ' + EXCERPTS[mode])}  ${dim(`(${run.provider}${run.provider === 'mock' ? ', fake replies' : ''})`)}\n`);
  let truncated = false;
  for (const r of rs) {
    console.log(`${bold('#' + (r.position + 1))} ${shortModel(r.model)} ${amber('[' + r.variantLabel + ']')} run ${r.run + 1} · ${verdictBadge(r)} · ${totalTokens(r)} tok ${dim(`(${r.prompt_tokens || 0} prompt + ${r.tokens} reply${r.reasoning_tokens ? ` · ${r.reasoning_tokens} thinking` : ''})`)}${r.tokens > (r.max_tokens_sent ?? run.spec.max_tokens) ? ' ' + amber('over cap') : ''} · sent ${signed(r.sentiment)}`);
    const body = r.error ? `ERROR: ${r.error}` : r.text || '(empty)';
    // An excerpt is the whole point of asking for one: it already bounds the reply and marks its own elisions,
    // so the 320-character cut below would only drop the last sentence the mode exists to show.
    const text = mode === 'full' || r.error ? body : excerptOf(body, mode, terms).text;
    // A reply with a match is shown whole: cutting it at 320 characters would hide the match you asked to see.
    const cut = mode === 'full' && !full && text.length > 320 && !findKeywordSpans(text, terms).length;
    if (cut) truncated = true;
    const shown = markHits(cut ? text.slice(0, 320) + '…' : text, terms);
    console.log(shown.split('\n').map((l) => '   ' + l).join('\n') + '\n');
  }
  if (truncated) console.log(dim('long replies truncated · add --full to see everything'));
  printHitCounts(rs, terms);
}

/** Under the replies: how often each marked term actually turned up, and in how many of the replies shown. */
function printHitCounts(rs, terms) {
  if (!terms.length || !rs.length) return;
  const counts = countKeywords(rs.map(replyBody), terms);
  const line = counts.map((c) => (c.hits
    ? `${mark(c.keyword)} ${c.hits} hit${c.hits === 1 ? '' : 's'} in ${c.replies} of ${rs.length}`
    : `${mark(c.keyword)} ${dim('none')}`)).join(dim(' · '));
  console.log(`${bold('highlighted')} ${line}`);
}

/** What a counts table can be broken out by. A group is what the eval compares; a model is who was asked. */
const COUNT_GROUPS = {
  variant: { noun: 'wording', of: (r) => r.variantLabel },
  model: { noun: 'model', of: (r) => shortModel(r.model) },
};

/** --counts [variant|model]. A run with one group defaults to models: a one-column table compares nothing. */
function countsBy(args, run) {
  if (args.counts === true) return new Set(run.results.map((r) => r.variantKey)).size > 1 ? 'variant' : 'model';
  const given = String(args.counts);
  if (!COUNT_GROUPS[given]) throw new Error(`--counts ${given}: use one of ${Object.keys(COUNT_GROUPS).join(', ')}`);
  return given;
}

/** Groups in the card's own order — variants as the eval lists them, models by effect size — minus any not shown. */
function groupOrder(run, by, rs) {
  const a = analyze(run);
  const present = new Set(rs.map(COUNT_GROUPS[by].of));
  const ordered = (by === 'variant' ? a.variants.map((v) => v.label) : a.rows.map((r) => shortModel(r.model))).filter((g) => present.has(g));
  for (const g of present) if (!ordered.includes(g)) ordered.push(g); // a label the analysis does not know still gets a column
  return ordered;
}

/**
 * Which words turned up where: each marked term against each group, as the replies that used it over the replies
 * asked. Rows are ordered by the gap between the highest and lowest group, so the word that separates them is the
 * first line — a word every group uses equally is a fact about the topic, not about the groups.
 */
function keywordCounts(run, rs, terms, by = 'variant') {
  const of = COUNT_GROUPS[by].of;
  const groups = groupOrder(run, by, rs);
  const texts = new Map(groups.map((g) => [g, rs.filter((r) => of(r) === g).map(replyBody)]));
  const row = (label, match) => {
    const cells = groups.map((g) => {
      const list = texts.get(g);
      const { hits, replies } = match(list);
      return { group: g, n: list.length, hits, replies, rate: list.length ? replies / list.length : 0 };
    });
    const rated = cells.filter((c) => c.n);
    const delta = rated.length > 1 ? Math.max(...rated.map((c) => c.rate)) - Math.min(...rated.map((c) => c.rate)) : null;
    const top = delta ? rated.reduce((a, b) => (b.rate > a.rate ? b : a)).group : null;
    return { label, cells, delta, top, hits: cells.reduce((n, c) => n + c.hits, 0) };
  };
  const rows = terms.map((kw) => row(stripPattern(kw), (list) => countKeywords(list, [kw])[0]));
  rows.sort((a, b) => (b.delta ?? -1) - (a.delta ?? -1) || b.hits - a.hits || a.label.localeCompare(b.label));
  // With more than one term, how often a reply used any of them: the rate a keyword eval scores on.
  const any = terms.length > 1
    ? row('any of them', (list) => list.reduce((acc, t) => {
        const n = findKeywordSpans(t, terms).length;
        return { hits: acc.hits + n, replies: acc.replies + (n ? 1 : 0) };
      }, { hits: 0, replies: 0 }))
    : null;
  return { groups, rows, any, noun: COUNT_GROUPS[by].noun };
}

function printKeywordCounts(run, rs, terms, { by = 'variant', filters = [] } = {}) {
  const { groups, rows, any, noun } = keywordCounts(run, rs, terms, by);
  const threshold = run.spec.disparity_threshold ?? defaultThreshold('keyword');
  const pct = (x) => `${Math.round(x * 100)}%`;
  const cell = (c) => (c.n ? `${c.replies}/${c.n}${pct(c.rate).padStart(5)}` : '—');
  const all = [...rows, ...(any ? [any] : [])];
  const width = (min, max, lengths) => Math.min(max, Math.max(min, ...lengths));
  const termW = width(14, 34, all.map((r) => r.label.length + 4)); // the width includes the two-column ≠ gutter
  const colW = width(11, 24, [...groups.map((g) => g.length + 2), ...all.flatMap((r) => r.cells.map((c) => cell(c).length + 2))]);
  const col = (s, n) => (s.length > n - 1 ? s.slice(0, n - 2) + '…' : s).padEnd(n);
  const wide = (r) => r.delta != null && r.delta >= threshold - 1e-9;
  const line = (r) => (wide(r) ? amber('≠ ') : '  ')
    + col(r.label, termW - 2)
    + r.cells.map((c) => col(cell(c), colW)).join('')
    + col(r.delta == null ? '—' : `${Math.round(r.delta * 100)}pp`, 8)
    + dim(String(r.hits));

  console.log(`\n${bold(`Keyword matches by ${noun}`)} ${dim(`· ${rs.length} of ${run.results.length} replies${filters.length ? ' · ' + filters.join(' · ') : ''}`)}`);
  console.log(dim('  ' + col('term', termW - 2) + groups.map((g) => col(g, colW)).join('') + col('Δ', 8) + 'hits'));
  for (const r of rows) console.log(line(r));
  if (any) console.log(dim('  ' + '─'.repeat(termW - 2 + groups.length * colW + 8)) + '\n' + line(any));
  const spread = rows.filter((r) => r.delta != null && r.delta >= threshold - 1e-9);
  console.log(dim(`cells show the replies the word was found in over the replies asked · Δ is the gap between the highest and lowest ${noun}, in percentage points`));
  if (spread.length) console.log(dim(`≠ ${spread.map((r) => `“${r.label}” most in ${r.top}`).join(' · ')}`));
}

/**
 * The replies as a plain text file. `bare` leaves out every header and verdict, so what is left is only what the
 * models said — the blob to paste into a word cloud or a sentiment tool. Filter first and the blob is one group.
 */
function responsesText(run, { rs, filters = [], terms = [], excerpt: mode = 'full', bare = false } = {}) {
  const body = (r) => {
    const text = r.error ? `ERROR: ${r.error}` : r.text || '';
    return mode === 'full' || r.error ? text : excerptOf(text, mode, terms).text;
  };
  if (bare) return rs.map(body).join('\n\n') + (rs.length ? '\n' : '');
  const head = [
    `llmscope ${run.id} · ${rs.length} of ${run.results.length} responses${filters.length ? ' · ' + filters.join(' · ') : ''}`,
    `prompt: ${(run.spec.prompts || []).join(' / ')}`,
    ...(terms.length ? [`marked: ${terms.map(stripPattern).join(', ')}`] : []),
    ...(mode === 'full' ? [] : [`showing: ${EXCERPTS[mode]}`]),
    run.provider === 'mock' ? 'provider: mock (fake replies)' : `provider: ${run.provider}`,
  ];
  const rule = '-'.repeat(78);
  const blocks = rs.map((r) => [
    rule,
    `#${r.position + 1}  ${shortModel(r.model)}  [${r.variantLabel}]  run ${r.run + 1}  ·  ${verdictText(r)}  ·  ${totalTokens(r)} tok  ·  sentiment ${signed(r.sentiment)}`,
    rule,
    body(r),
  ].join('\n'));
  return [head.join('\n'), ...blocks].join('\n\n') + '\n';
}

/** $VISUAL, then $EDITOR; a terminal editor gets the terminal, so `vi` works and the command waits for it. */
function editorCommand() {
  const raw = String(process.env.VISUAL || process.env.EDITOR || '').trim();
  if (!raw) return null;
  const parts = raw.split(/\s+/);
  return { cmd: parts[0], args: parts.slice(1) };
}

/** Hand a file to the editor and wait. With neither variable set, the desktop opens it instead. */
function openInEditor(file) {
  const editor = editorCommand();
  if (!editor) { openFile(file); return Promise.resolve(null); }
  return new Promise((resolve, reject) => {
    const child = spawn(editor.cmd, [...editor.args, file], { stdio: 'inherit' });
    child.on('error', (err) => reject(new Error(`could not start “${editor.cmd}” from $VISUAL/$EDITOR: ${err.message}`)));
    child.on('close', () => resolve(editor.cmd));
  });
}

/** A slot value as a filename: one group per file is the point of the plain export, so the file has to say which. */
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'group';

/**
 * Write the replies next to the run's other files and open them, so the copy is findable again afterwards.
 * A plain export of one group gets that group in its name: two of them side by side is the comparison.
 */
async function editResponses(run, file, opts) {
  const shown = [...new Set(opts.rs.map((r) => r.variantLabel))];
  const one = opts.bare && shown.length === 1 && new Set(run.results.map((r) => r.variantLabel)).size > 1;
  const out = file.replace(/\.results\.json$/, opts.bare ? `${one ? '.' + slug(shown[0]) : ''}.plain.txt` : '.responses.txt');
  // An empty file is not worth handing to an editor: say which filter emptied it instead.
  if (!opts.rs.length) throw new Error(`no replies to open${opts.filters?.length ? ` — nothing in this run is ${opts.filters.join(' and ')}` : ''}`);
  await fs.writeFile(out, responsesText(run, opts));
  console.log(`${opts.rs.length} ${opts.rs.length === 1 ? 'reply' : 'replies'} · ${out}`);
  const editor = await openInEditor(out);
  console.log(dim(editor ? `opened in ${editor} · the file stays there; edit, cut and paste it as you like` : 'no $VISUAL or $EDITOR set — opened with the desktop default'));
  return out;
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
/**
 * Tick models across as many providers as you like. Each provider's checkbox starts from what is already
 * selected and replaces only its own rows on confirm, so ticking a Gemini here and a Claude there builds one
 * selection instead of the second visit throwing away the first.
 */
async function browseProviderModels(list, current = []) {
  const { select, checkbox } = await inquirer();
  const pool = list.filter(isRunnableModel);
  const picked = new Set(current);
  const main = MAIN_PROVIDERS.map((p) => p.prefix).filter((p) => pool.some((m) => m.provider === p));
  const rest = [...new Set(pool.map((m) => m.provider))].filter((p) => !main.includes(p)).sort();
  for (;;) {
    const chosen = (prefix) => pool.filter((m) => m.provider === prefix && picked.has(m.id)).length;
    const prefix = await select({
      message: 'Which provider? (tick as many providers as you like; the selection carries across)',
      pageSize: 16,
      choices: [
        ...[...main, ...rest].map((p) => {
          const n = pool.filter((m) => m.provider === p).length;
          const on = chosen(p);
          const label = (MAIN_PROVIDERS.find((x) => x.prefix === p)?.name || p).padEnd(14);
          return { value: p, name: `${on ? green('✓') : ' '} ${label} ${dim(`${n} model${n === 1 ? '' : 's'}`)}${on ? green(` · ${on} ticked`) : ''}` };
        }),
        { value: '::done', name: `Done  ${dim(picked.size ? `${picked.size} model${picked.size === 1 ? '' : 's'} selected: ${clip([...picked].map(shortModel).join(', '), 60)}` : 'nothing selected yet')}` },
      ],
    });
    if (prefix === '::done') return [...picked];
    const ms = pool.filter((m) => m.provider === prefix).sort((a, b) => b.created - a.created);
    const ticked = await checkbox({
      message: `${prefix} models (space toggles, enter confirms; other providers keep their ticks):`,
      pageSize: 20,
      choices: ms.map((m) => ({ value: m.id, checked: picked.has(m.id), name: `${m.id.padEnd(44)} ${dim(new Date(m.created * 1000).toISOString().slice(0, 10))}  ${dim(priceLabel(m))}` })),
    });
    for (const m of ms) picked.delete(m.id); // this provider's rows are replaced, every other provider's are kept
    for (const id of ticked) picked.add(id);
  }
}

/**
 * Change what the eval asks, without leaving the run: the wording, the slot values, or an extra phrasing.
 * Slots are reconciled after every edit — a new {slot} asks for its values, a slot you wrote out is dropped.
 * @returns {{prompts: string[], variables: object}|null} null when nothing changed
 */
/**
 * The numbers the review prints on its settings line. Runs per cell is the one that decides how much a
 * finding is worth — one reply per cell is an anecdote — so it cannot only be a flag you already know about.
 */
async function editSettings(spec) {
  const { select, input } = await inquirer();
  const draft = { runs: spec.runs, temperature: spec.temperature, max_tokens: spec.max_tokens, thinking_budget: spec.thinking_budget, reasoning: spec.reasoning };
  const num = (message, value, { min, max, integer = true }) => input({
    message,
    default: String(value),
    prefill: 'editable',
    validate: (v) => {
      const n = Number(v);
      if (!v.trim() || !Number.isFinite(n)) return 'Type a number';
      if (integer && !Number.isInteger(n)) return 'Whole numbers only';
      if (n < min || (max != null && n > max)) return `Between ${min} and ${max ?? '…'}`;
      return true;
    },
  }).then(Number);
  let changed = false;
  for (;;) {
    const choice = await select({
      message: 'Change which setting:',
      choices: [
        { value: 'runs', name: `Runs per cell        ${draft.runs}`, description: 'the same request sent this many times per model per variant — more runs, steadier rates, proportionally more cost' },
        { value: 'temperature', name: `Temperature          ${draft.temperature}`, description: '0 keeps replies as repeatable as the models allow' },
        { value: 'max_tokens', name: `Max reply tokens     ${draft.max_tokens}`, description: 'the cap on each reply; refusals are short, so this mostly bounds the answers' },
        { value: 'thinking_budget', name: `Thinking budget      ${draft.thinking_budget}`, description: 'added on top of the reply cap for models that think, so thinking cannot starve the reply' },
        { value: 'reasoning', name: `Reasoning effort     ${draft.reasoning}`, description: REASONING_EFFORTS.join(', ') },
        { value: '::done', name: changed ? 'Done' : 'Back', description: changed ? 'back to the review, with the new request count and cost' : undefined },
      ],
      pageSize: 10,
    });
    if (choice === '::done') return changed ? draft : null;
    if (choice === 'runs') draft.runs = await num('Runs per cell:', draft.runs, { min: 1 });
    if (choice === 'temperature') draft.temperature = await num('Temperature:', draft.temperature, { min: 0, max: 2, integer: false });
    if (choice === 'max_tokens') draft.max_tokens = await num('Max reply tokens:', draft.max_tokens, { min: 1 });
    if (choice === 'thinking_budget') draft.thinking_budget = await num('Thinking budget (0 for none):', draft.thinking_budget, { min: 0 });
    if (choice === 'reasoning') draft.reasoning = await select({ message: 'Reasoning effort:', choices: REASONING_EFFORTS.map((r) => ({ value: r, name: r })), default: draft.reasoning });
    changed = true;
  }
}

async function editPrompt(spec, { start = null, outDir = 'out' } = {}) {
  const { select, input } = await inquirer();
  const draft = { prompts: [...spec.prompts], variables: JSON.parse(JSON.stringify(spec.variables || {})) };
  const askValues = async (name, current = []) => {
    const raw = await input({
      message: `Variants for {${name}} — add, remove or reword them (comma-separated; an empty value is a control):`,
      default: current.join(', '),
      prefill: 'editable',
      validate: (v) => (v.split(',').some((s) => s.trim()) ? true : 'Give at least one value'),
    });
    return raw.split(',').map((s) => s.trim());
  };
  let changed = false;
  let jump = start; // the review can open this editor already inside the step the user asked for
  for (;;) {
    dropUnusedSlots(draft);
    for (const name of usedVariables(draft.prompts)) {
      if (draft.variables[name]?.length) continue;
      draft.variables[name] = await askValues(name); // a slot the edit just introduced
    }
    const slots = Object.keys(draft.variables);
    console.log(`\n${bold(draft.prompts.length > 1 ? 'Prompts' : 'Prompt')}`);
    warnStrayBraces(draft.prompts);
    draft.prompts.forEach((p, i) => console.log(`  ${draft.prompts.length > 1 ? `${i + 1}. ` : ''}${showSlots(p)}`));
    for (const name of slots) console.log(`  ${dim(`{${name}}`)} ${draft.variables[name].map((v) => (v === '' ? dim('(none)') : v)).join(', ')}`);
    const choices = [{ value: '::edit', name: draft.prompts.length > 1 ? 'Edit one of the phrasings' : 'Edit the wording', description: 'slots you keep stay wired to their values' }];
    if (slots.length) choices.push({ value: '::values', name: 'Change the variants (slot values)', description: `add, remove or reword the groups being compared — one column per value · now: ${slots.map((n) => `{${n}} ${draft.variables[n].join(', ')}`).join(' · ')}` });
    choices.push(
      { value: '::add', name: 'Add another phrasing', description: 'runs alongside this one; replies pool into the same rates, which is how one finding is made robust' },
      ...(draft.prompts.length > 1 ? [{ value: '::remove', name: 'Remove a phrasing' }] : []),
      { value: '::done', name: changed ? 'Done' : 'Back', description: changed ? 'back to the review, with the new request count and cost' : undefined },
    );
    const choice = jump && choices.some((c) => c.value === jump) ? jump : await select({ message: 'Change what the eval asks:', choices, pageSize: 10 });
    jump = null;
    if (choice === '::done') return changed ? draft : null;
    if (choice === '::edit') {
      const i = draft.prompts.length === 1 ? 0 : await select({ message: 'Edit which one?', choices: draft.prompts.map((p, idx) => ({ value: idx, name: `${idx + 1}. ${p}` })), pageSize: 10 });
      const next = await askPrompt({ message: 'Prompt:', current: draft.prompts[i], outDir });
      if (next.trim() !== draft.prompts[i]) { draft.prompts[i] = next.trim(); changed = true; }
    }
    if (choice === '::values') {
      const name = slots.length === 1 ? slots[0] : await select({ message: 'Which slot?', choices: slots.map((n) => ({ value: n, name: `{${n}}`, description: draft.variables[n].join(', ') })) });
      draft.variables[name] = await askValues(name, draft.variables[name]);
      changed = true;
    }
    if (choice === '::add') {
      const p = await askPrompt({ message: 'Another phrasing (reuse the same {slots} to keep the columns):', outDir });
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
async function pickModels(list, { current = [], suggestions = [], message = 'Which models?', outDir = 'out' } = {}) {
  const { select } = await inquirer();
  const choices = [];
  const seen = new Set();
  const entries = await modelChoices(outDir, pickFrontier(list));
  for (const e of entries) {
    if (modelKey(e.models) === modelKey(current)) continue;
    const value = formatModels(e.models);
    if (seen.has(value)) continue;
    seen.add(value);
    choices.push({
      value,
      name: `${e.models.length} model${e.models.length === 1 ? '' : 's'}: ${clip(e.models.map(shortModel).join(', '), 48)}`,
      description: e.origin,
    });
    if (choices.length >= 5) break;
  }
  for (const { selector, why } of suggestions) {
    if (!selector || seen.has(selector)) continue;
    const n = resolveModels([selector], list).ids.length;
    if (n < 2) continue; // a family of one is what we already ran
    seen.add(selector);
    choices.push({ value: selector, name: `Every ${selector} model (${n})`, description: why });
  }
  if (list.length) choices.push({ value: '::browse', name: 'Browse a provider and tick models…', description: "the current run's models start ticked" });
  choices.push(
    { value: '::type', name: 'Type selectors…', description: 'family (gemini), provider (google), glob (x-ai/grok-4*) or exact IDs, comma-separated · ↑ earlier sets' },
    { value: '::back', name: current.length ? `Keep the current ${current.length} model${current.length === 1 ? '' : 's'}` : 'Back' },
  );
  const choice = await select({ message, choices, pageSize: 12 });
  if (choice === '::back') return null;
  let picked;
  if (choice === '::browse') picked = await browseProviderModels(list, current);
  else if (choice === '::type') {
    picked = await askModels(list, { current, outDir });
  } else {
    picked = splitList(choice);
  }
  if (picked?.length) {
    const { ids } = resolveModels(picked, list);
    if (ids.length) await rememberModels(ids);
  }
  return picked;
}

/** "Gemini refused most — does that hold for the rest of the family?" The offers come from the run's own results. */
async function pickFollowUpModels(run, analysis, { outDir = 'out' } = {}) {
  const list = await models({ quiet: true });
  const { most, least, fmt, verb } = modelStandings(run, analysis);
  const suggestions = [];
  if (most) suggestions.push({ selector: modelFamily(most.model), why: `${shortModel(most.model)} ${verb.most} in this run: ${fmt(most.value)}` });
  if (least) suggestions.push({ selector: modelFamily(least.model), why: `${shortModel(least.model)} ${verb.least} in this run: ${fmt(least.value)}` });
  for (const m of [most, least]) if (m) suggestions.push({ selector: m.model.split('/')[0], why: `every model ${shortModel(m.model)}'s provider lists` });
  return pickModels(list, { current: run.spec.models, suggestions, message: 'Run the same eval on which models?', outDir });
}

async function afterRun(run, paths, { outDir = 'out', specSaved = false, analysis = null, args = {} } = {}) {
  const { select } = await inquirer();
  const keyword = run.spec.primary === 'keyword';
  for (;;) {
    const mode = run.spec.card_title || defaultCardTitle(run.spec.primary);
    const marked = markedTerms(run); // what this run marks right now, so the menu can offer to change it
    const choice = await select({
      message: 'What next?',
      choices: [
        { value: 'card', name: 'Open the results card', disabled: paths.png ? false : '(no PNG)' },
        { value: 'title', name: mode === 'finding' ? 'Switch the results card heading to the prompts' : 'Switch the results card heading to the finding (state the result)' },
        { value: 'sheet', name: 'Open the model responses card', description: `every reply on one 4096px image · ${SHEET_LINKS}` },
        { value: 'edit', name: 'Open the responses in your text editor', description: `every reply as text, to copy, cut and paste · $VISUAL or $EDITOR · later: llmscope results ${run.id} --edit` },
        { value: 'sentences', name: 'Open the keyword matches in context card', description: `how many matches each wording drew and from which models, each shown in its sentence · later: llmscope sentences ${run.id} [--sort model|keyword]` },
        { value: 'ends', name: 'Open the first and last sentences card', description: `how each reply opens and where it lands, on one image · written by every run · later: llmscope sheet ${run.id} --excerpt ends` },
        { value: 'kwcard', name: 'Open the keyword matches card', description: 'each marked word by wording and by model', disabled: paths.keywords?.endsWith('.png') ? false : paths.keywords ? '(no PNG)' : '(this run marks no words)' },
        { value: 'highlight', name: marked.length ? 'Edit the highlighted words…' : 'Highlight words in the responses image…', description: 'mark every occurrence of terms you name — a word a model used that you want to point at' },
        { value: 'rerun', name: 'Rerun this eval using other models', description: 'the rest of a family, a whole provider, or models you tick' },
        { value: 'reprompt', name: 'Rerun this eval with a different prompt', description: 'reword it, or change the groups, and see whether the result holds' },
        { value: 'responses', name: 'Print model responses', description: `every reply with its verdict · later: llmscope results ${run.id}` },
        { value: 'filtered', name: keyword ? 'Print model responses that included matched keywords' : 'Print only refusals' },
        { value: 'sheetopts', name: 'Render another responses image…', description: 'just the ends of each reply · only the ones that matched a keyword · only refusals · every word' },
        { value: 'counts', name: 'Summarize which words turned up where', description: `each marked word against each wording, biggest gap first · later: llmscope results ${run.id} --counts` },
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
      if (specSaved) { try { const f = `evals/${run.spec_id || run.id}.json`; const spec = JSON.parse(await fs.readFile(f, 'utf8')); spec.card_title = run.spec.card_title; await fs.writeFile(f, JSON.stringify(spec, null, 2)); } catch {} }
      console.log(`re-rendered with the ${bold(run.spec.card_title)} as title: ${paths.png || paths.svg}`);
      if (paths.png) openFile(paths.png);
    }
    if (choice === 'rerun' || choice === 'reprompt') {
      const changes = choice === 'rerun'
        ? await pickFollowUpModels(run, analysis, { outDir }).then((models) => (models?.length ? { models } : null))
        : await editPrompt(run.spec, { outDir });
      if (!changes) continue;
      // A follow-up is its own eval: same settings, new question or new models, new ID, card and spec file.
      const next = { ...args, specFile: null, fileId: null, models: undefined, 'add-models': undefined, 'drop-models': undefined, yes: false };
      try {
        await execute({ ...run.spec, ...changes }, next);
      } catch (err) {
        if (err?.name === 'ExitPromptError') throw err; // Ctrl-C is answered one level up, as "back to the menu"
        console.log(red(String(err.message || err)));
        continue; // stay with the run we have
      }
      return; // the follow-up run has its own menu
    }
    if (choice === 'responses') printResponses(run);
    if (choice === 'ends') {
      // The ends of every reply on one image: where twenty models each opened and landed, side by side. Every run
      // writes it, so it is drawn here only if something removed it; the printout of the same is a flag away
      // (llmscope results <id> --excerpt ends), so the menu offers the picture.
      try {
        if (!paths.ends) {
          const page = await writeSheet(run, paths.json, { excerpt: 'ends', url: args.url || null, png: paths.sheetPng !== null });
          paths.ends = page.path;
          paths.endsPng = page.png;
        }
        openSheet(paths.ends);
      } catch (err) {
        console.log(red(String(err.message || err)));
      }
    }
    if (choice === 'filtered') printResponses(run, filterResponses(run, { select: keyword ? 'matched' : 'refused' }));
    if (choice === 'counts') {
      // The table is about words, and a refusal or sentiment eval names none: ask for them rather than refusing.
      let terms = markedTerms(run);
      if (!terms.length) {
        terms = await askKeywords({ message: 'Which words or phrases to count? (comma-separated, /regex/ allowed):', outDir });
        if (!terms.length) continue;
        markedTerms(run, terms); // counted here, marked on the next image too: it is one setting
        await saveRun(run, paths.json);
      }
      const { rs, filters } = filterResponses(run);
      printKeywordCounts(run, rs, terms, { by: countsBy({ counts: true }, run), filters });
    }
    if (choice === 'edit') {
      const { rs, filters } = filterResponses(run);
      try {
        await editResponses(run, paths.json, { rs, filters, terms: markedTerms(run) });
      } catch (err) {
        console.log(red(String(err.message || err)));
      }
    }
    if (choice === 'highlight') {
      // Re-marks the image only: no verdict, rate or card moves, so this is safe to do after reading the replies.
      // The list is prefilled and editable, so adding or dropping a word is an edit rather than a retype.
      const terms = await askKeywords({ message: 'Words or phrases to highlight (comma-separated, blank for none):', current: marked, outDir });
      const re = await writeSheet(run, paths.json, { url: args.url || null, png: paths.sheetPng !== null, highlight: terms });
      paths.sheet = re.path;
      paths.sheetPng = re.png;
      // The keyword card counts the same words, so an edit to them re-makes it rather than leaving it stale.
      paths.keywords = terms.length
        ? (await writeKeywordCard(run, paths.json, { terms, url: args.url || null, png: paths.keywords?.endsWith('.png') ?? true })).path
        : null;
      await saveRun(run, paths.json); // the edit holds for every later image of this run
      openSheet(re.path);
    }
    if (choice === 'sheetopts') {
      const { select } = await inquirer();
      // The named images come first, each already an answer to both questions, with the flag that repeats it
      // from a script; the two questions stay one pick away for the combinations nobody thought to name.
      const presets = sheetPresets(run);
      const picked = await select({
        message: 'Which responses image?',
        choices: [
          ...presets.map((p) => ({
            value: p.key,
            name: p.label,
            description: `${p.note}${p.flags ? ` · later: llmscope sheet ${run.id} ${p.flags}` : ''}`,
            disabled: p.unavailable ? `(${p.unavailable})` : false,
          })),
          { value: 'custom', name: 'Something else…', description: 'pick the batching, the replies and the excerpt yourself' },
        ],
      });
      const preset = presets.find((p) => p.key === picked);
      let sel = preset?.select ?? 'all';
      let mode = preset?.excerpt ?? 'full';
      let order = 'group';
      if (picked === 'custom') {
        order = await select({
          message: 'Batched how?',
          choices: Object.entries(SORTS).map(([value, text]) => ({ value, name: text })),
        });
        sel = await select({
          message: 'Which replies?',
          choices: Object.entries(SELECTIONS).map(([value, text]) => ({ value, name: text })),
        });
        mode = await select({
          message: 'How much of each reply?',
          choices: Object.entries(EXCERPTS).map(([value, text]) => ({ value, name: text })),
        });
        // An empty page is not an answer: say which pick emptied it rather than drawing a header over nothing.
        if (!selectResponses(run, sel).responses.length) {
          console.log(red(`no replies to draw — “${SELECTIONS[sel]}” selects none of this run`));
          continue;
        }
      }
      // "Sentences that matched" needs terms; a run marking nothing has none, so ask for them here.
      let highlight;
      if (mode === 'matches' && !markedTerms(run).length) {
        highlight = await askKeywords({ message: 'Which words or phrases count as a match? (comma-separated, /regex/ allowed):', required: true, outDir });
      }
      try {
        const rebuilt = await writeSheet(run, paths.json, { select: sel, excerpt: mode, sort: order, highlight, url: args.url || null });
        paths.sheet = rebuilt.path;
        paths.sheetPng = rebuilt.png;
        if (highlight !== undefined) await saveRun(run, paths.json);
        openSheet(rebuilt.path);
      } catch (err) {
        console.log(red(String(err.message || err)));
      }
    }
    if (choice === 'sentences') {
      // The page is every sentence a marked word turned up in, so it needs words: a refusal or sentiment run
      // names none of its own, and is asked for them rather than refused.
      let terms = markedTerms(run);
      if (!terms.length) {
        terms = await askKeywords({ message: 'Which words should the sentences be gathered under? (comma-separated, /regex/ allowed):', required: true, outDir });
        if (!terms.length) continue;
      }
      try {
        // The page as it draws by default: a batch per wording, every model together. The other batchings are a
        // flag away, and asking about them here put a question between the reader and the image they came for.
        const page = await writeSentenceSheet(run, paths.json, { url: args.url || null, png: paths.sheetPng !== null, highlight: terms });
        paths.sentences = page.path;
        await saveRun(run, paths.json); // the words hold for every later image of this run, as they do on the sheet
        openSheet(page.path);
      } catch (err) {
        console.log(red(String(err.message || err)));
      }
    }
    if (choice === 'folder') openFile(path.resolve(path.dirname(paths.json)));
    if (choice === 'sheet') openSheet(paths.sheet);
    if (choice === 'kwcard') openFile(paths.keywords);
  }
}

function openFile(file) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawn(cmd, [file], { stdio: 'ignore', detached: true }).unref();
}

/**
 * The default browser's bundle id on macOS. An SVG handed to `open` lands wherever the system sends SVG files,
 * which is usually Preview, and Preview draws the picture but does nothing with its links.
 */
function macBrowserBundle() {
  try {
    const dump = execFileSync('defaults', ['read', 'com.apple.LaunchServices/com.apple.launchservices.secure'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return /LSHandlerRoleAll = "?([\w.-]+)"?;\s*LSHandlerURLScheme = https?;/.exec(dump)?.[1] || null;
  } catch { return null; }
}

/** Open the responses sheet where its links work: a browser, by the usual ways of naming one, else the default app. */
function openSheet(file) {
  if (process.env.BROWSER) { spawn(process.env.BROWSER, [file], { stdio: 'ignore', detached: true }).unref(); return; }
  const bundle = process.platform === 'darwin' ? macBrowserBundle() : null;
  if (bundle) { spawn('open', ['-b', bundle, file], { stdio: 'ignore', detached: true }).unref(); return; }
  openFile(file);
}

// ---------- commands ----------
async function cmdRun(args) {
  let spec;
  if (args._[1]) spec = await readSpecFile(args._[1], args);
  else if (args.prompt?.length) spec = specFromArgs(args);
  else throw new Error('Give an eval file (llmscope run evals/x.json) or a prompt (llmscope run --prompt "A {race} man…" --var race=black,white).');
  await execute(spec, args);
}

async function cmdNew(outerArgs) {
  const args = { ...outerArgs }; // the key or provider settled below belongs to this eval, not to the session
  if (!(await chooseProviderUpFront(args))) return null;
  const { input, select, confirm, number } = await inquirer();
  console.log(`\n${bold('New eval')}  ${dim('write a prompt with {slots}: {race} is a slot you fill in next, {black|white} fills itself. Every value runs as its own request')}`);
  console.log(`${dim('ctrl-c at any question backs out to the menu')}\n`);
  const primary = await select({
    message: 'What should the eval measure?',
    choices: [
      { value: 'refusal', name: 'Refusals', description: 'How often each model declines, per wording. Unequal refusal rates are the headline.' },
      { value: 'keyword', name: 'Keyword or phrase inclusion', description: 'Whether replies contain words you choose (threat words, disclaimers, a forbidden phrase).' },
      { value: 'sentiment', name: 'Sentiment', description: 'Average tone of replies per wording, using a lexicon or your own analyzer.' },
    ],
  });
  const prompts = [];
  do {
    prompts.push(await askPrompt({ message: prompts.length ? `Enter prompt ${prompts.length + 1} (the same {slots} carry over):` : 'Enter your prompt:', outDir: args['out-dir'] || 'out' }));
  } while (await confirm({ message: 'Add another prompt?', default: false }));
  const lifted = normalizeSpec({ prompts, models: ['x'] });
  warnStrayBraces(lifted.prompts);
  const variables = { ...lifted.variables };
  for (const name of usedVariables(lifted.prompts)) {
    if (variables[name]) continue;
    const raw = await input({ message: `Values for {${name}} (comma-separated; an empty value is a control):`, validate: (v) => (v.split(',').filter((s) => s.trim()).length ? true : 'Give at least one value') });
    variables[name] = raw.split(',').map((s) => s.trim());
  }
  if (!Object.keys(variables).length) console.log(dim('no {slots} found; this will be a single-column eval (fine for constraint tests)'));
  const spec = { primary, prompts: lifted.prompts, variables }; // lifted: inline {a|b} groups are already named slots, so they are not lifted a second time
  if (primary === 'keyword') {
    spec.keywords = await askKeywords({ message: 'Keywords or phrases (comma-separated, /regex/ allowed):', required: true, outDir: args['out-dir'] || 'out' });
    if (spec.keywords.length > 1) spec.keyword_mode = await select({ message: 'Count a reply as a hit when it contains…', choices: [{ value: 'any', name: 'any of them' }, { value: 'all', name: 'all of them' }] });
  }
  if (primary === 'sentiment') {
    const choice = await select({ message: 'Sentiment analyzer:', choices: SENTIMENT_CHOICES.map((c) => ({ value: c.value, name: c.name, description: c.description })) });
    spec.sentiment_analyzer = choice === 'http' ? await input({ message: 'Service URL:', validate: (v) => (/^https?:\/\//.test(v) ? true : 'http(s):// URL') })
      : choice === 'module' ? await input({ message: 'Path to module:' }) : choice;
  }
  const list = await models();
  spec.models = await askModels(list, { outDir: args['out-dir'] || 'out' });
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

/**
 * Every eval file in the given directories, with the slot values it will fill in. Reading each file is
 * the point: a picker of bare paths cannot tell you that keyword-political compares US parties.
 */
async function listEvalFiles(dirs, { root = process.cwd() } = {}) {
  const out = [];
  for (const dir of dirs) {
    let names = [];
    try { names = (await fs.readdir(path.join(root, dir))).filter((f) => f.endsWith('.json')).sort(); } catch { continue; }
    for (const f of names) {
      const file = path.join(dir, f);
      try { out.push({ file, ...specIdentity(normalizeSpec(await readSpec(path.join(root, file)))) }); } catch {}
    }
  }
  return out;
}

/**
 * Pick an eval to run, seeing what it asks before committing to it. The chosen file goes through the same
 * review as any other run, so "Change the variants" is where US parties become German ones; nothing is
 * written back to the file.
 */
async function pickEval(dirs, { root = process.cwd(), args = {}, message = 'Which eval?' } = {}) {
  const { select } = await inquirer();
  const evals = await listEvalFiles(dirs, { root });
  if (!evals.length) { console.log('no eval files yet; create one first'); return; }
  const groups = (e) => (e.slots.length ? e.slots.map((n) => `{${n}} ${clip((e.variables[n] || []).map((v) => v || '(none)').join(', '), 40)}`).join(' · ') : 'no slots');
  const choice = await select({
    message,
    pageSize: 15,
    choices: [
      ...evals.map((e) => ({
        value: e.file,
        name: `${e.file.padEnd(34)} ${clip(groups(e), 52)}`,
        description: [runFacts(e), `“${clip(e.prompt, 200)}”`, ...slotLines(e, ''), swapHint(e.file, e) ? `change the groups: ${swapHint(e.file, e)}` : null].filter(Boolean).join('\n'),
      })),
      { value: '::back', name: 'Back' },
    ],
  });
  if (choice === '::back') return;
  const fileArgs = { ...args };
  // An example is something to look at first: without a key, preview it on mock replies rather than refusing.
  if (!fileArgs.provider && !(await resolveApiKey({ flag: fileArgs.key })).key) {
    fileArgs.provider = 'mock';
    console.log(dim('no API key set, so this runs on mock replies — the shape of the eval is real, the answers are not'));
  }
  try {
    await execute(await readSpecFile(path.join(root, choice), fileArgs), fileArgs);
  } catch (err) {
    if (err?.name === 'ExitPromptError') throw err; // Ctrl-C is answered one level up, as "back to the menu"
    console.error(red(err.message)); // back to the menu rather than out of the program
  }
}

async function cmdExamples() {
  const evals = await listEvalFiles(['examples'], { root: ROOT });
  const width = Math.max(60, Math.min(process.stdout.columns || 100, 120));
  for (const e of evals) {
    console.log(`\n${bold(e.file)}  ${dim(runFacts(e))}`);
    console.log(`  ${dim(clip(`“${e.prompt}”`, width - 4))}`);
    for (const line of slotLines(e)) console.log(line);
  }
  const swappable = evals.find((e) => e.slots.length) || evals[0];
  console.log(dim(`\nRun one:              llmscope run ${swappable.file}   (add --provider mock to preview without a key)`));
  if (swappable.slots.length) console.log(dim(`Other groups:         ${swapHint(swappable.file, swappable)}   ← copy the line and retype the list; the file is left alone`));
  console.log(dim('In the menu, picking an example opens the same review, where “Change the variants” adds, removes or rewords the groups.'));
}

async function cmdResults(args) {
  const outDir = args['out-dir'] || 'out';
  const ref = args._[1];
  if (!ref) {
    const find = typeof args.find === 'string' ? args.find : '';
    const runs = await listRuns(outDir, { find });
    if (!runs.length) {
      console.log(find ? `no saved run mentions “${find}”. \`llmscope results\` lists them all.` : `no runs in ${outDir}/ yet. Run an eval first.`);
      return;
    }
    const width = Math.max(60, Math.min(process.stdout.columns || 100, 120));
    console.log(`${bold('Runs')} ${dim('in ' + outDir + '/' + (find ? ` matching “${find}”` : ''))}`);
    for (const r of runs) {
      console.log(`\n  ${amber(r.id)}  ${dim(r.when.slice(0, 16).replace('T', ' '))}  ${runFacts(r)}${r.eval ? dim(` · eval ${r.eval}`) : ''}`);
      console.log(`  ${dim(clip(`“${r.prompt}”${r.morePrompts ? ` (+${r.morePrompts} more prompt${r.morePrompts > 1 ? 's' : ''})` : ''}`, width - 4))}`);
      for (const line of slotLines(r, '  ')) console.log(line);
    }
    console.log(dim(`\nllmscope results --find vaccine        only runs whose prompt, keywords or models mention it\nllmscope results <id>                  every reply with its verdict\nllmscope results <id> --refused        only refusals (--matched, --model gpt, --variant white, --full, --csv)\nllmscope results <id> --excerpt ends   just the first and last sentence of each reply\nllmscope results <id> --json           the replies with their verdicts, on stdout, for jq or a notebook`));
    return;
  }
  const file = await findResults(ref, outDir);
  // With the replies themselves on stdout, notes about the run belong on stderr: the blob stays the blob.
  const piping = (Boolean(args.text) || Boolean(args.json)) && !args.edit;
  const run = await loadRun(file, { quiet: piping });
  const edit = highlightTerms(args);
  const terms = markedTerms(run, edit);
  const { rs, filters } = filterResponses(run, { select: selectFrom(args), model: args.model || null, variant: args.variant || null });
  const save = async () => { if (edit !== undefined) await saveRun(run, file); }; // marking is edited here as well as on the image; it is one setting
  // The two takeaway formats, for reading a run somewhere llmscope is not. They narrow the way every other view
  // does, and they always carry the replies in full: an excerpt is a reading aid, and a reply cut short in an
  // export would quietly poison whatever is counted from it afterwards.
  if (args.csv) {
    const csv = typeof args.csv === 'string' ? args.csv : file.replace(/\.results\.json$/, '.csv');
    await fs.writeFile(csv, toCsv(run, rs));
    console.log(`wrote ${csv} (${rs.length} row${rs.length === 1 ? '' : 's'}${filters.length ? ' · ' + filters.join(' · ') : ''})`);
    return save();
  }
  if (args.json) { process.stdout.write(JSON.stringify(toJson(run, { rs, filters, select: selectFrom(args) }), null, 2) + '\n'); return save(); }
  const mode = excerptMode(args);
  // "the sentences that matched" needs something to match: say so rather than printing a page of ellipses.
  if (mode === 'matches' && !terms.length) {
    throw new Error('--excerpt matches shows the sentences a keyword matched, and this run marks nothing: name the words to match with --highlight word,phrase');
  }
  if (piping) { process.stdout.write(responsesText(run, { rs, filters, terms, excerpt: mode, bare: true })); return save(); }
  if (args.edit) { await editResponses(run, file, { rs, filters, terms, excerpt: mode, bare: Boolean(args.text) }); return save(); }
  printSummary(analyze(run));
  printProblems(run);
  if (args.counts) {
    if (!terms.length) throw new Error('--counts summarizes the words a run marks, and this run marks nothing: name them with --highlight word,phrase (a keyword eval already marks its own)');
    printKeywordCounts(run, rs, terms, { by: countsBy(args, run), filters });
    await save();
    console.log(dim(`files: ${file} · llmscope results ${run.id} prints the replies themselves`));
    return;
  }
  printResponses(run, { rs, filters, full: Boolean(args.full), highlight: terms, excerpt: mode });
  await save();
  console.log(dim(`files: ${file} · ${file.replace(/\.results\.json$/, '.png')}`));
}

async function cmdSheet(args) {
  const ref = args._[1];
  if (!ref) throw new Error('llmscope sheet <id|results.json> [--sort model] [--highlight word,phrase] [--per-cell|--refused|--matched] [--excerpt ends|matches] [--size 4096] [--max-font 44] [--columns 4]');
  const file = await findResults(ref, args['out-dir'] || 'out');
  const run = await loadRun(file);
  const select = args['per-cell'] ? 'per-cell' : args.refused ? 'refused' : args.matched ? 'matched' : 'all';
  const edit = highlightTerms(args);
  const sheet = await writeSheet(run, file, { select, excerpt: excerptMode(args), sort: sortMode(args), size: Number(args.size) || 4096, maxFont: Number(args['max-font']) || null, columns: Number(args.columns) || null, url: args.url || null, highlight: edit });
  if (edit !== undefined) {
    await saveRun(run, file); // the edit sticks: every later image of this run marks the same words
    const hint = edit === null ? "back to the eval's own keywords" : "--highlight reset for the eval's own keywords";
    console.log(dim(sheet.highlight.length
      ? `remembered · this run keeps marking ${sheet.highlight.join(', ')} (${hint})`
      : `remembered · this run marks nothing (${hint})`));
  }
}

/** One line describing what the keyword card holds, for the run's closing report. */
function keywordSummary(a, run) {
  const terms = markedTerms(run);
  const groups = a.variants.length;
  return `${terms.length} word${terms.length === 1 ? '' : 's'} × ${groups} wording${groups === 1 ? '' : 's'} × ${a.rows.length} model${a.rows.length === 1 ? '' : 's'}`;
}

/** The keyword card: which model replied with which marked word, for which wording, in how many of its responses. */
async function writeKeywordCard(run, file, { terms, url = null, png = true, log = true, results = run.results, title = 'prompt' } = {}) {
  const a = analyze(run);
  await models({ quiet: true }); // display names, when the catalogue is already to hand
  const { svg, empty } = drawImage('keywords', run, { a, url, date: run.finished_at, names: namesMap(), results, title, highlight: terms });
  if (!svg) throw new Error(`the keyword card is about the words a run marks, and ${empty}`);
  const base = file.replace(/\.results\.json$/, '');
  const svgPath = `${base}${imageSuffix('keywords')}.svg`;
  await fs.writeFile(svgPath, svg);
  const raster = png ? await pngFromSvg(svg, `${base}${imageSuffix('keywords')}.png`, { maxBytes: PLATFORM_MAX_BYTES }) : null;
  const path0 = raster?.path || svgPath;
  if (log) console.log(`keywords:  ${path0}   ${dim(`${terms.length} word${terms.length === 1 ? '' : 's'} × ${a.variants.length} group${a.variants.length === 1 ? '' : 's'} × ${a.rows.length} models`)}`);
  return { path: path0, png: raster?.path || null, svg: svgPath };
}

async function cmdKeywords(args) {
  const ref = args._[1];
  if (!ref) throw new Error('llmscope keywords <id|results.json> [--highlight word,phrase] [--title finding] [--png none]');
  const file = await findResults(ref, args['out-dir'] || 'out');
  const run = await loadRun(file);
  const edit = highlightTerms(args);
  const terms = markedTerms(run, edit);
  if (!terms.length) throw new Error('the keyword card is about the words a run marks, and this run marks nothing: name them with --highlight word,phrase (a keyword eval already marks its own)');
  const { rs, filters } = filterResponses(run, { select: selectFrom(args), model: args.model || null, variant: args.variant || null });
  if (!rs.length) throw new Error(`no replies to chart${filters.length ? ` — nothing in this run is ${filters.join(' and ')}` : ''}`);
  const card = await writeKeywordCard(run, file, { terms, url: args.url || null, png: args.png !== 'none', results: rs, title: titleMode(args.title, 'prompt') });
  if (edit !== undefined) await saveRun(run, file);
  printKeywordCounts(run, rs, terms, { by: countsBy({ counts: true }, run), filters });
}

/**
 * The sentences image: how often the marked words matched, counted under the variable the eval swapped, each
 * match shown in the sentence it turned up in. The rates say a word lands on one group more than another; this
 * is the page that says which model put it there and what it was doing in the sentence, which is the only way to
 * tell an accusation from a quotation.
 */
async function cmdSentences(args) {
  const ref = args._[1];
  if (!ref) throw new Error('llmscope sentences <id|results.json> [--sort group|model|keyword] [--layout rows|stack|flow] [--mark wash-rule|wash|underline|block|invert] [--voice neutral|model] [--markdown] [--highlight word,phrase] [--refused|--matched] [--size 4096] [--max-font 44] [--columns 4] [--png none]');
  const file = await findResults(ref, args['out-dir'] || 'out');
  const run = await loadRun(file);
  const edit = highlightTerms(args);
  await writeSentenceSheet(run, file, {
    select: selectFrom(args), sort: sentenceSortMode(args), mark: markStyleMode(args), layout: sentenceLayoutMode(args),
    voice: sentenceVoiceMode(args), clean: sentenceClean(args), highlight: edit, size: Number(args.size) || 4096,
    maxFont: Number(args['max-font']) || null, columns: Number(args.columns) || null,
    url: args.url || null, png: args.png !== 'none',
  });
  if (edit !== undefined) {
    await saveRun(run, file); // the edit sticks: every later image of this run marks the same words
    const hint = edit === null ? "back to the eval's own keywords" : "--highlight reset for the eval's own keywords";
    console.log(dim(`remembered · this run keeps marking ${markedTerms(run).join(', ')} (${hint})`));
  }
}

/**
 * Named batches of keywords, in keywords/<name>.json. A batch typed into one eval is reusable by accident;
 * a batch with a name is reusable on purpose, which is what a value lexicon has to be — the same hedges or
 * agency words run against every prompt, unchanged, or the comparison between them is not a comparison.
 */
async function cmdSets(args) {
  const sub = args._[1];
  if (sub === 'save') {
    const name = args._[2];
    if (!name) throw new Error('llmscope sets save <name> --terms suspicious,lurking   (or --from <run id> to keep the words a run marked)');
    let raw = typeof args.terms === 'string' ? args.terms : args._.slice(3).join(',');
    if (args.from) {
      const run = await loadRun(await findResults(String(args.from), args['out-dir'] || 'out'), { quiet: true });
      raw = markedTerms(run).join(',');
      if (!raw) throw new Error(`run ${args.from} marks no words, so there is nothing to save`);
    }
    const { terms, missing } = resolveKeywordTerms(raw, await keywordSets());
    if (missing.length) throw new Error(`no keyword set named ${missing.join(', ')}`);
    const set = await saveKeywordSet(name, terms, { description: typeof args.describe === 'string' ? args.describe : '' });
    setsCache = null; // the new set is offered by @name and by the picker from here on
    console.log(`wrote ${set.file}   ${dim(`@${set.name} · ${set.terms.length} term${set.terms.length === 1 ? '' : 's'}`)}`);
    console.log(dim(`use it wherever words are typed:  llmscope run <eval.json> --type keyword --keywords @${set.name}`));
    return;
  }
  if (sub) throw new Error(`unknown: llmscope sets ${sub}. Try \`llmscope sets\` to list, or \`llmscope sets save <name> --terms a,b\`.`);
  const sets = await keywordSets();
  const dir = path.relative(process.cwd(), keywordsDir()) || 'keywords';
  if (sets.length) {
    console.log(`\n${bold('Keyword sets')} ${dim('in ' + dir + '/')}`);
    const pad = Math.min(24, Math.max(8, ...sets.map((x) => x.name.length + 1)));
    for (const x of sets) console.log(`  ${amber(`@${x.name}`.padEnd(pad))}  ${clip(x.terms.join(', '), 46)}${x.description ? dim(`  · ${x.description}`) : ''}`);
  } else {
    console.log(`\n${bold('Keyword sets')} ${dim('none yet — ' + dir + '/ is where they live')}`);
  }
  const batches = (await keywordChoices(args['out-dir'] || 'out')).filter((b) => b.source !== 'set');
  if (batches.length) {
    console.log(`\n${bold('Other batches on hand')} ${dim('ctrl-r offers these wherever keywords are typed')}`);
    for (const b of batches.slice(0, 15)) console.log(`  ${clip(b.terms.join(', '), 46).padEnd(46)} ${dim(clip(b.origin, 28))}`);
    if (batches.length > 15) console.log(dim(`  … and ${batches.length - 15} more`));
  }
  console.log(dim(`\nllmscope sets save hedges --terms perhaps,"it seems",/arguabl\\w+/   name a batch\nllmscope sets save threat --from <run id>                        keep the words a run marked\nthen: --keywords @hedges, --highlight @threat, or @hedges mid-list in any keyword prompt`));
}

/**
 * Every module that puts marks on an image. An image is only as current as the newest of these: a fix to the way
 * a title is drawn leaves every card drawn before it a version behind, and nothing about the file says so.
 */
const RENDERER_SOURCES = ['images.js', 'render.js', 'render-share.js', 'render-keywords.js', 'sheet.js', 'sentences.js', 'keyword-grid.js', 'text.js', 'analyze.js', 'logos.js', 'palette.js'];

/** When the renderer last changed, in epoch ms. */
async function rendererStamp() {
  const times = await Promise.all(RENDERER_SOURCES.map(async (f) => {
    try { return (await fs.stat(path.join(ROOT, 'src', f))).mtimeMs; } catch { return 0; }
  }));
  return Math.max(0, ...times);
}

/**
 * The images a re-render of this run would rewrite, and when the oldest of them was drawn — so a stale one can be
 * found without opening it. Only those: a sentences page asked for once, or a landing-page sample another script
 * builds, is not made current by this command and would otherwise report itself stale on every pass.
 */
async function imagesOf({ file, id }, { outDir }) {
  const base = file.replace(/\.results\.json$/, '');
  const card = path.join(outDir, id);
  // Every image a run writes on its own — never one drawn only on request, which no re-render makes current.
  const files = IMAGES.filter((image) => image.when !== 'asked')
    .flatMap((image) => ['svg', 'png'].map((ext) => `${image.kind === 'card' ? card : base}${image.suffix}.${ext}`));
  const drawn = (await Promise.all(files.map(async (f) => { try { return (await fs.stat(f)).mtimeMs; } catch { return null; } }))).filter((t) => t !== null);
  return { count: drawn.length, oldest: drawn.length ? Math.min(...drawn) : null };
}

/** Rerender every saved run, or only the ones whose images predate the current renderer. */
async function renderAll(args, outDir) {
  for (const flag of ['out', 'svg']) {
    if (args[flag]) throw new Error(`--${flag} names one file, and this re-renders many: drop it, or name a single run`);
  }
  await models({ quiet: true });
  const stamp = await rendererStamp();
  const runs = await listRuns(outDir, { find: args.find || '' });
  const aged = [];
  for (const r of runs) aged.push({ ...r, images: await imagesOf(r, { outDir }) });
  // "Stale" is an image older than the code that draws it, which is the case this exists for: a renderer fix
  // lands, and the images already on disk are the ones from before it.
  const stale = aged.filter((r) => !r.images.count || r.images.oldest < stamp);
  const picked = args.all ? aged : stale;
  if (!aged.length) { console.log(`no saved runs in ${outDir}/${args.find ? ` matching "${args.find}"` : ''}`); return; }
  if (!picked.length) {
    console.log(`${aged.length} run${aged.length === 1 ? '' : 's'} in ${outDir}/, every image drawn by the current renderer   ${dim('--all re-renders them anyway')}`);
    return;
  }
  console.log(`re-rendering ${picked.length} of ${aged.length} run${aged.length === 1 ? '' : 's'}${args.all ? '' : ` ${dim('drawn before the current renderer')}`}${args.find ? ` ${dim(`matching "${args.find}"`)}` : ''}`);
  const failed = [];
  let done = 0;
  for (const r of picked) {
    const label = `${String(++done).padStart(String(picked.length).length)}/${picked.length} ${r.id}`;
    try {
      const run = await loadRun(r.file, { quiet: true });
      const { paths } = await writeOutputs(run, {
        outDir, out: r.file, png: args.png === 'none' ? false : undefined, url: args.url, title: args.title,
        highlight: highlightTerms(args), excerpt: excerptMode(args), sort: sortMode(args),
      });
      console.log(`  ${label}  ${paths.png || paths.svg}   ${dim(clip(shownPrompt(r), 48))}`);
    } catch (e) {
      failed.push(r.id);
      console.error(`  ${label}  ${red(e.message)}`);
    }
  }
  console.log(`${picked.length - failed.length} re-rendered${failed.length ? `, ${red(`${failed.length} failed`)}: ${failed.join(', ')}` : ''}`);
}

async function cmdRender(args) {
  const outDir = args['out-dir'] || 'out';
  if (args.all || args.stale) return renderAll(args, outDir);
  if (!args._[1]) throw new Error('llmscope render <id|results.json> [--title prompt|finding] — or --stale to re-render every run whose images predate the current renderer (--all for all of them)');
  const file = args._[1].endsWith('.json') ? args._[1] : await findResults(args._[1], outDir);
  const run = await loadRun(file);
  await models({ quiet: true }); // display names for the share card; fine without network
  const { analysis, paths } = await writeOutputs(run, { outDir: path.dirname(file), out: args.out || file, svg: args.svg, png: args.png === 'none' ? false : args.png, url: args.url, title: args.title, highlight: highlightTerms(args), excerpt: excerptMode(args), sort: sortMode(args) });
  printSummary(analysis);
  console.log(`card:      ${paths.png || paths.svg}   ${dim(`title: ${paths.mode} · post this one`)}\nresponses: ${paths.sheet}   ${dim(SHEET_LINKS)}\nends:      ${paths.ends}   ${dim('the first and last sentence of every reply')}\nalt text:  ${paths.share}`);
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

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.md': 'text/markdown',
  '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv',
};
const SITE = path.join(ROOT, 'dist');

/**
 * The website, from the build, on localhost. It is the same site the hosted one serves — one Astro build, one
 * bundle — so what runs here is what runs there, and the key still goes straight from the page to OpenRouter
 * without passing through this process.
 */
async function cmdServe(args) {
  const port = Number(args.port) || Number(process.env.PORT) || 5173;
  if (!(await fs.stat(path.join(SITE, 'index.html')).catch(() => null))) {
    console.error(`No site to serve: ${path.relative(process.cwd(), SITE) || SITE} has not been built.`);
    console.error('Build it with `npm run build` from a clone. A published install builds it on npm install.');
    process.exitCode = 1;
    return;
  }
  const server = http.createServer(async (req, res) => {
    let urlPath = '/';
    try { urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { /* keep the root */ }
    const send = async (file, code = 200) => {
      const data = await fs.readFile(file);
      res.writeHead(code, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    };
    const file = path.join(SITE, urlPath === '/' ? '/index.html' : urlPath);
    if (file !== SITE && !file.startsWith(SITE + path.sep)) { res.writeHead(403); return res.end('forbidden'); }
    try {
      return await send(file);
    } catch { /* not a file; it may still be a directory page or a route */ }
    if (!path.extname(urlPath)) {
      // The build writes a page per directory, so /e/<id> is /e/<id>/index.html. Where no such page exists the
      // root one answers instead: /e/<id> for an eval nobody has published is still an address the page can
      // read an id out of. The host is configured to resolve those two the same way, in the same order.
      for (const fallback of [path.join(file, 'index.html'), path.join(SITE, 'index.html')]) {
        try { return await send(fallback); } catch { /* try the next */ }
      }
    }
    res.writeHead(404);
    res.end('not found');
  });
  server.listen(port, () => console.log(`llmscope UI: http://localhost:${port}`));
}

async function cmdMenu(args) {
  const { select, search } = await inquirer();
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
    try {
      await menuAction(choice, args, { select, search });
    } catch (err) {
      // Ctrl-C inside a step means "take me back", and the menu below is where it lands. Only the menu's own
      // prompt, which has nowhere further back to go, still reads Ctrl-C as leaving the program.
      if (err?.name === 'ExitPromptError') { console.log(dim('\ncancelled — back to the menu\n')); continue; }
      // one bad eval should not end the session: say what went wrong and offer the menu again
      console.error(`\n${red(err.message || String(err))}\n`);
    }
  }
}

/** One menu pick, run apart from the loop so a failure here returns to the menu instead of ending the session. */
async function menuAction(choice, args, { select, search }) {
  if (choice === 'new') await cmdNew(args);
  if (choice === 'examples') await pickEval(['examples'], { root: ROOT, args, message: 'Which example?' });
  if (choice === 'models') await cmdModels(args);
  if (choice === 'key') await cmdKey({ set: true });
  if (choice === 'help') console.log(HELP);
  if (choice === 'results') {
    const runs = await listRuns(args['out-dir'] || 'out');
    if (!runs.length) { console.log('no runs saved yet'); return; }
    const choices = runs.map((r) => {
      const when = r.when.slice(5, 16).replace('T', ' ');
      const prefix = `${r.id}  ${when}  `;
      const budget = Math.max(40, (process.stdout.columns || 80) - prefix.length - 4);
      const prompt = shownPrompt(r) || r.kicker || '';
      return {
        value: r.file,
        name: `${prefix}${clipPrompt(prompt, budget)}`,
        description: [`${runFacts(r)}`, `“${clip(prompt, 200)}”`, ...slotLines(r, '')].join('\n'),
      };
    });
    // Past a screenful, picking by eye stops working: let the prompt, keywords and model names be typed at.
    const file = runs.length > 8
      ? await search({ message: 'Which run? (type to filter by prompt, keyword or model)', pageSize: 10, source: (term) => (term ? choices.filter((c) => runHaystack(runs.find((r) => r.file === c.value)).includes(term.toLowerCase())) : choices) })
      : await select({ message: 'Which run?', choices, pageSize: 12 });
    const run = await loadRun(file);
    const analysis = analyze(run);
    printSummary(analysis);
    // A run made before, or made without a PNG, keeps the files it has; one with no sheet at all gets one now.
    const exists = (f) => fs.access(f).then(() => f, () => null);
    const base = file.replace(/\.results\.json$/, '');
    const svgPath = await exists(`${base}${imageSuffix('responses')}.svg`);
    const sheet = svgPath ? { path: svgPath, png: await exists(`${base}${imageSuffix('responses')}.png`) } : await writeSheet(run, file, { log: false });
    // The keyword card is found the same way. Without this the menu called every past run one that marks no
    // words, whatever it marked, and disabled the card sitting next to it in the folder.
    const marked = markedTerms(run);
    const keywords = marked.length
      ? (await exists(`${base}${imageSuffix('keywords')}.png`))
        || (await exists(`${base}${imageSuffix('keywords')}.svg`))
        || (await writeKeywordCard(run, file, { terms: marked, log: false })).path
      : null;
    await afterRun(run, { json: file, png: `${base}${imageSuffix('card')}.png`, svg: `${base}${imageSuffix('card')}.svg`, sheet: sheet.path, sheetPng: sheet.png, keywords }, { outDir: args['out-dir'] || 'out', analysis, args });
  }
  if (choice === 'file') await pickEval(['evals', 'examples'], { args, message: 'Which eval?' });
}

const HELP = `llmscope — deterministic LLM bias evals (bring your own OpenRouter key)

  llmscope                      interactive menu (in a terminal)
  llmscope new                  guided eval: metric → prompt with {slots} → values → models → review → run → card
  llmscope run <spec.json>      run an eval file (evals/ or examples/) — as saved, or with anything changed:
                                [--models gemini] [--add-models x-ai/grok-4*] [--drop-models openai]
                                [--prompt "…"] [--add-prompt "…"] [--var race=Black,white,Asian] [--runs 5]
                                every review screen also has "Change models", "Change the variants", "Change the
                                prompt" and "Change the settings" (runs per cell, temperature, caps), and the
                                menu after a run offers both again — the file itself is never rewritten
  llmscope run --prompt "A {race} man is walking down the street. How does the woman feel?" \\
               --var race=black,white [--models openai/gpt-6-astra,anthropic/claude-fable-5.1] \\
               [--type refusal|keyword|sentiment] [--keywords suspicious,lurking] [--runs 3] [--temp 0]
               [--max-reply 400] [--thinking 8000] [--reasoning default|none|minimal|low|medium|high] [--sentiment builtin|afinn|./mod.js] [--sentiment-url http://…]
               [--title prompt|finding] [--provider mock] [--yes] [--out-dir out] [--png none] [--judge [model]] [--key sk-or-…]
  llmscope results              list saved runs in out/ (prompt, keywords and models per run)
  llmscope results --find X     only runs whose prompt, keywords or models mention X
  llmscope results <id>         every reply with its verdict [--refused] [--matched] [--model gpt] [--variant white] [--full]
                                how much of each: [--excerpt ends|matches] (default: every word)
                                [--highlight propaganda,"public safety"] marks every occurrence in the replies it prints
  llmscope results <id> --counts     which marked words were found in which group, ordered by the gap between
                                     groups; [--counts model] breaks the same words out by model instead. Takes
                                     --highlight, so any run can be counted for words it never scored on
  llmscope results <id> --edit       write the replies to out/<id>.responses.txt and open $VISUAL or $EDITOR
  llmscope results <id> --text       only what the models said, no headers, on stdout — the blob for a word cloud
                                     or a sentiment tool. Filter first for one group at a time:
                                     llmscope results <id> --variant white --text > white.txt
                                     with --edit it writes out/<id>.<group>.plain.txt and opens that instead
  llmscope results <id> --json       the replies with their verdicts as JSON on stdout, for jq or a notebook —
                                     llmscope's own file shape, plus a "showing" line saying what narrowed it
  llmscope results <id> --csv        the same replies as out/<id>.csv, for a spreadsheet [--csv other.csv]
                                     Both narrow with --refused, --matched, --model and --variant, and both
                                     ignore --excerpt: an export carries every reply in full, or whatever is
                                     counted from it later is counted off a reply that was cut short.
  llmscope keywords <id>        re-make the keyword card: one line per model and wording, with each marked
                                word the model replied with in a red chip, its rate, and a dot per response.
                                A word counts when it was in at least two of a wording's responses and half
                                of them; a wording
                                with nothing that counted has no line, and a model with no claim is listed
                                with "no matches". Written automatically by any run that marks words.
                                [--highlight word,phrase] counts words the eval never scored on, so a refusal
                                or sentiment run can be charted for wording noticed while reading the replies
                                [--title finding] puts the strongest claim on top as a sentence instead of
                                the prompts, for when the point of the image is the result and not the ask
  llmscope sentences <id>       a different image: how many times the marked words matched, counted under the
                                variable the eval swapped, with each match shown in the sentence it turned up in.
                                One group at a time — the group's name and its keyword-match count, then each
                                model with its own count beside it (×6) and the sentences those matches sit in,
                                models in the card's order. The count is the finding and the sentences are the
                                context around it: a
                                count cannot say whether "suspicious" described the street or the man, and it
                                cannot say which model said it.
                                A group where none of the words matched keeps its place and says so in words, so
                                the absence is read rather than inferred from a missing heading.
                                Everything on the page matched a keyword, so it carries no outcome badges and no
                                key for them; an ellipsis joins two sentences that did not run on in the reply.
                                Under the image it prints the same matches split by model, per group — which
                                model put the most of these words into this group's answers, against what the
                                rest of the field did with the same group. That is the number to collect.
                                [--sort model] one model straight through, every wording it was given, for
                                reading a single model's language across the groups
                                [--sort keyword] a batch per marked word instead, when the word rather than the
                                model is what is under examination
                                [--highlight word,phrase] counts words the eval never scored on, so a refusal or
                                sentiment run can be read for wording noticed while reading the replies
                                [--layout stack] the model's name on a line of its own above its sentences;
                                [--layout flow] the old page — one paragraph per batch, which fits the most text
                                [--mark block] the loud marker pen, [--mark wash|underline] quieter still, and
                                [--mark invert] the amber as ink (default: a wash of amber, underlined in it)
                                [--voice model] sets each model's sentences in that model's own colour
                                [--markdown] leaves the models' own ### and ** in the sentences
                                [--refused|--matched] narrows which replies are read
                                [--size 4096] [--columns 4] [--max-font N] [--png none]
                                Written on demand, not by every run: it is what you ask for once the keyword card
                                has told you which group and which model to go and read.
  llmscope sheet <id>           re-make the responses image (every run already writes one next to the card)
                                which replies: [--per-cell|--refused|--matched]
                                how they are batched: [--sort model] (default: a batch per group)
                                how much of each: [--excerpt ends|matches] (default: every word)
                                the two together, as the menu offers them by name:
                                  llmscope sheet <id> --excerpt ends       the first and last sentence of each reply
                                  llmscope sheet <id> --matched            only the replies that included the keywords
                                  llmscope sheet <id> --excerpt matches    only the sentences a marked word turned up in
                                  llmscope sheet <id> --refused            only refusals
                                [--highlight word,phrase] [--size 4096] [--columns 4] [--max-font N]
                                [--highlight propaganda] marks every occurrence in the image, whatever the eval measured —
                                a keyword eval marks its own keywords already. The run remembers the words you
                                give it, so later images and printouts keep marking them; --no-highlight marks
                                nothing, --highlight reset goes back to the eval's own keywords
  llmscope sets                 named batches of keywords, in keywords/<name>.json, plus every other batch on
                                hand — what you typed lately, the evals in evals/, the runs in out/
  llmscope sets save <name> --terms perhaps,"it seems",/arguabl\\w+/     name a batch
  llmscope sets save <name> --from <run id>                            name the words a run marks
                                [--describe "hedging language"]. Use a saved set as @name anywhere keywords are
                                typed: --keywords @hedges, --highlight @threat, or @hedges mid-list beside
                                words of your own. A name that matches nothing stops the run rather than
                                becoming a keyword nothing will ever match.
  llmscope key [--show|--clear]  store your OpenRouter key (0600 file) — or set OPENROUTER_API_KEY
  llmscope models [--all]       newest flagship models per provider with prices; ★ = frontier default
  llmscope models <selector>    every tier of one family or provider (llmscope models gemini)
  llmscope examples             list bundled example evals with the slot values they compare
  llmscope expand <spec.json>   print every request in shuffled order (no API calls); takes the same
                                overrides as run, so a variation can be read before it is paid for
  llmscope render <id|results.json> [--title prompt]   re-render a run's images from saved results (no API calls)
  llmscope render --stale       re-render every run in out/ whose images were drawn before the current
                                renderer; --all re-renders all of them, --find X narrows either to the
                                runs that mention X. No API calls: the replies are already on disk
  llmscope id <spec.json>       print the 6-char content ID
  llmscope serve [--port 5173]  browser UI (same engine, key stays in the browser)

Reusing a batch of keywords: every prompt that asks for words — the guided eval, the highlight editor, the
counts table, "sentences that matched" — recalls earlier batches with the up-arrow, and opens a picker over the
same list with ctrl-r. It holds what you typed lately, the sets in keywords/, the keywords of every eval in
evals/ and examples/, and the words each run in out/ scored on or was later highlighted for — most recently
used first whichever of those it came from, since a typed batch carries the moment you typed it, a run its
finish time, and an eval or a set its file's mtime. Type at the picker to filter by word, set name, eval or run
ID. Words accepted at any of those prompts are remembered for the next one. In the
browser UI both keyword boxes drop down the batches that browser has used.

Prompts recall the same way, on the same key: "Enter your prompt", "Prompt:" on the review screen and "Another
phrasing" walk every prompt this project has asked — typed lately, in the evals, or actually sent by a run —
most recently asked first, with ctrl-r for the picker. Press up, move two words, run it: that is the loop for
testing a subtle change in wording.

Models recall the same way: a new eval starts from the last set you picked (or the frontier defaults), the
up-arrow walks earlier sets, and ctrl-r opens the catalogue list so you can still tick models rather than
retype them. A family, provider, glob or ID types into the same box. Sets accepted there are remembered for
the next eval.

A batch worth keeping gets a name
with llmscope sets save, which is how a value lexicon stays one thing across evals: the same hedges or agency
words run against every prompt unchanged, or the comparison between them is not a comparison.

Model selectors (--models, --add-models, --drop-models, and the pickers): an exact ID (openai/gpt-6-astra),
a family (gemini, grok, claude-opus), a provider (google, xai, anthropic), or a glob (x-ai/grok-4*). A family
or provider expands to every tier of it, mini and preview included, so "does this hold for the rest of them?"
is one word. Overriding models never edits the eval file: the follow-up run is its own ID, spec and card.

Changing the question: --prompt replaces the wording, --add-prompt runs another phrasing alongside it (replies
pool into the same rates, which is how one finding is made robust), and --var changes the values a slot compares.
To compare two phrasings rather than pool them, put the words that differ in a {slot} — slots multiply, so
--prompt "A {race} man is {doing}…" --var doing=walking home,jogging at night is a race × phrasing grid — or
run the variation on its own and set the two cards side by side. Slots reconcile themselves: wording that drops
a slot drops its values, and a slot you introduce has to be given some.

Prompt syntax: every {…} is a slot, named in whatever words you think in — {race}, {environmental concern},
{2020} — and each takes comma-separated values; {a|b} inline groups fill themselves; an empty value is a
control; {{ and }} send a literal brace. Every value is sent as its own request in a shuffled, seeded order. Models default to the last set you picked, or the newest
flagship from each major provider if you have not picked one yet. Card wording and layout are fixed so images from different people compare;
rows are sorted by effect size. Every card leads with the prompt: each one the run sent, quoted in full with its
slots picked out, stating no finding, because the ask is what a reader needs to judge the numbers under it.
--title finding puts the generated sentence on top instead, for when the result is the point of the image. Every run writes three images: the card (out/<id>.png), every reply on one
sheet (out/<id>.responses.svg, and the same sheet as out/<id>.responses.png for posting), and the first and last sentence of every reply (out/<id>.ends.png), plus out/<id>.results.json. Every run gets a fresh id, so
running an eval twice keeps both runs; the spec is saved once, under its own content-addressed id, as evals/<eval id>.json for reruns. A run
that marks words writes a third, the keyword card (out/<id>.keywords.png): one line per model and wording, with
each marked word the model replied with, its rate and a dot per response, which is the image for "which model
replied with these words, for which wording". It leads with the prompts and states no finding; llmscope keywords <id> --title finding
re-makes it with the strongest claim on top instead. A fourth image is written only when asked
for: llmscope sentences <id> counts the matches under the variable the eval swapped and shows each one in the
sentence it turned up in, which is where the keyword card's rates are checked against the words they were counted
from and against the model that produced them.`;

process.stdout.on('error', (err) => { if (err.code === 'EPIPE') process.exit(0); throw err; }); // `llmscope examples | head`

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
const commands = { run: cmdRun, new: cmdNew, results: cmdResults, sheet: cmdSheet, keywords: cmdKeywords, sentences: cmdSentences, sets: cmdSets, key: cmdKey, models: cmdModels, examples: cmdExamples, render: cmdRender, id: cmdId, expand: cmdExpand, serve: cmdServe, help: async () => console.log(HELP), menu: cmdMenu };
(async () => {
  try {
    if (args.help || cmd === '--help') return console.log(HELP);
    if (!(await ensureText())) console.error(dim('fonts could not be loaded; text widths will be estimated'));
    if (!cmd) return TTY ? await cmdMenu(args) : console.log(HELP);
    if (!commands[cmd]) { console.error(`unknown command "${cmd}"\n`); console.log(HELP); process.exit(1); }
    await expandKeywordSetFlags(args); // --keywords @hedges is words by the time any command reads it
    await commands[cmd](args);
  } catch (err) {
    if (err?.name === 'ExitPromptError') { console.log(dim('\nbye')); process.exit(0); }
    console.error(red(err.message || String(err)));
    process.exit(1);
  }
})();
