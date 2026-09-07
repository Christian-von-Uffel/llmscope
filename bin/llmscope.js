#!/usr/bin/env node
// CLI: run | render | id | expand | serve
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { planRun, runEval } from '../src/engine.js';
import { analyze } from '../src/analyze.js';
import { renderCard } from '../src/render.js';
import { createOpenRouterProvider } from '../src/providers/openrouter.js';
import { createMockProvider } from '../src/providers/mock.js';
import { setSentimentAnalyzer, httpSentiment } from '../src/checks/sentiment.js';
import { createJudge } from '../src/checks/judge.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else { args[key] = next; i++; }
    } else args._.push(a);
  }
  return args;
}

async function readSpec(file) {
  if (!file) throw new Error('spec file required');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function writePng(svg, file) {
  let Resvg;
  try { ({ Resvg } = await import('@resvg/resvg-js')); } catch {
    console.error('PNG export needs @resvg/resvg-js: npm install @resvg/resvg-js  (SVG was still written)');
    return false;
  }
  const r = new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: 'DejaVu Sans' } });
  await fs.writeFile(file, r.render().asPng());
  return true;
}

async function outputs(run, args) {
  const a = analyze(run);
  const svg = renderCard(a, { url: args.url || null });
  if (args.out) await fs.writeFile(args.out, JSON.stringify(run, null, 2));
  if (args.svg) await fs.writeFile(args.svg, svg);
  if (args.png) await writePng(svg, args.png);
  return a;
}

function printSummary(a) {
  console.log(`\n${a.title.kicker}`);
  console.log(`id: ${a.id}   share: ${a.spec.share_base}${a.id}`);
  const head = ['model'.padEnd(32), ...a.variants.map((v) => v.label.padEnd(22))].join('');
  console.log(head);
  for (const row of a.rows) {
    const cells = row.cells.map((c) => `${c.big} (${Math.round(c.tokens_mean)}t)`.padEnd(22));
    console.log(`${(row.flagged ? '≠ ' : '  ') + row.model.split('/').pop()}`.padEnd(32) + cells.join(''));
  }
}

async function cmdRun(args) {
  const spec = await readSpec(args._[1]);
  const plan = await planRun(spec);
  if (plan.problems.length) { console.error('Invalid spec:\n - ' + plan.problems.join('\n - ')); process.exit(2); }
  const providerName = args.provider || 'openrouter';
  const provider = providerName === 'mock'
    ? createMockProvider()
    : createOpenRouterProvider({ apiKey: process.env.OPENROUTER_API_KEY });
  if (args.sentiment) {
    const mod = await import(pathToFileURL(path.resolve(args.sentiment)).href);
    setSentimentAnalyzer(mod.default || mod.analyze);
  }
  if (args['sentiment-url']) setSentimentAnalyzer(httpSentiment(args['sentiment-url']));
  const judge = args.judge ? createJudge(provider, { model: typeof args.judge === 'string' ? args.judge : undefined }) : null;
  console.error(`${plan.id}: ${plan.jobs.length} requests (${plan.spec.prompts.length} prompts × ${plan.jobs.length / plan.spec.prompts.length / plan.spec.models.length / plan.spec.runs} variants × ${plan.spec.models.length} models × ${plan.spec.runs} runs) via ${provider.name}`);
  const run = await runEval(spec, {
    provider, judge,
    concurrency: Number(args.concurrency) || 4,
    onProgress: ({ done, total, result }) => {
      const flag = result.error ? 'ERR' : result.refused ? 'REFUSED' : result.matched ? 'MATCH' : 'ok';
      process.stderr.write(`[${String(done).padStart(String(total).length)}/${total}] ${flag.padEnd(7)} ${result.model.split('/').pop().padEnd(28)} ${result.variantLabel.padEnd(18)} ${String(result.tokens).padStart(4)}t\n`);
    },
  });
  const a = await outputs(run, args);
  printSummary(a);
}

async function cmdRender(args) {
  const run = JSON.parse(await fs.readFile(args._[1], 'utf8'));
  const a = await outputs(run, { ...args, out: null });
  printSummary(a);
}

async function cmdId(args) {
  const plan = await planRun(await readSpec(args._[1]));
  console.log(plan.id);
}

async function cmdExpand(args) {
  const plan = await planRun(await readSpec(args._[1]));
  if (plan.problems.length) console.error('Problems:\n - ' + plan.problems.join('\n - '));
  console.log(`id ${plan.id} · ${plan.jobs.length} requests, shuffled order:`);
  plan.order.forEach((jobIndex, pos) => {
    const j = plan.jobs[jobIndex];
    console.log(`${String(pos + 1).padStart(3)}. ${j.model.split('/').pop().padEnd(28)} run ${j.run}  [${j.variantLabel}]  ${j.prompt}`);
  });
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
    } catch {
      res.writeHead(404); res.end('not found');
    }
  });
  server.listen(port, () => console.log(`llmscope UI: http://localhost:${port}`));
}

const HELP = `llmscope — deterministic LLM bias evals

  llmscope run <spec.json> [--provider openrouter|mock] [--out results.json] [--svg card.svg] [--png card.png]
                           [--concurrency 4] [--judge [model]] [--sentiment ./my.js] [--sentiment-url http://...] [--url llmscope.dev/e/XXXXXX]
  llmscope render <results.json> --svg card.svg [--png card.png]
  llmscope expand <spec.json>     show every request in the shuffled order (no API calls)
  llmscope id <spec.json>         print the 6-char content ID
  llmscope serve [--port 5173]    serve the browser UI

  Set OPENROUTER_API_KEY for real runs.`;

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
const commands = { run: cmdRun, render: cmdRender, id: cmdId, expand: cmdExpand, serve: cmdServe };
if (!cmd || !commands[cmd] || args.help) { console.log(HELP); process.exit(cmd && !commands[cmd] ? 1 : 0); }
commands[cmd](args).catch((err) => { console.error(err.message || err); process.exit(1); });
