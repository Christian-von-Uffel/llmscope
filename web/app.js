// Browser UI. The eval engine is the same code the CLI uses; the API key goes only to openrouter.ai.
import { planRun, runEval } from '../src/engine.js';
import { analyze } from '../src/analyze.js';
import { renderCard } from '../src/render.js';
import { createOpenRouterProvider } from '../src/providers/openrouter.js';
import { createMockProvider } from '../src/providers/mock.js';
import { setSentimentAnalyzer, resetSentimentAnalyzer, httpSentiment } from '../src/checks/sentiment.js';

const $ = (id) => document.getElementById(id);
const KEY_STORE = 'llmscope:openrouter_key';
let currentRun = null;
let currentSvg = '';
let abort = null;

function readSpec() {
  const variables = {};
  for (const line of $('variables').value.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
    if (m) variables[m[1]] = m[2].split(',').map((s) => s.trim());
  }
  return {
    title: $('title').value,
    prompts: $('prompts').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
    variables,
    models: $('models').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
    primary: $('primary').value,
    keywords: $('keywords').value.split(',').map((s) => s.trim()).filter(Boolean),
    runs: Number($('runs').value) || 1,
    temperature: Number($('temperature').value) || 0,
    max_tokens: Number($('max_tokens').value) || 400,
    system: $('system').value,
    disparity_threshold: $('threshold').value === '' ? null : Number($('threshold').value),
    seed: $('seed').value === '' ? null : Number($('seed').value),
    share_base: $('share_base').value || 'llmscope.dev/e/',
    sentiment_url: $('sentiment_url').value.trim() || null,
  };
}

function writeSpec(spec) {
  if (!spec) return;
  if (spec.title) $('title').value = spec.title;
  if (spec.prompts) $('prompts').value = [].concat(spec.prompts).join('\n');
  if (spec.variables) $('variables').value = Object.entries(spec.variables).filter(([k]) => !/^v\d+$/.test(k)).map(([k, v]) => `${k}: ${v.join(', ')}`).join('\n');
  if (spec.models) $('models').value = [].concat(spec.models).join('\n');
  if (spec.primary) $('primary').value = spec.primary;
  if (spec.keywords) $('keywords').value = [].concat(spec.keywords).join(', ');
  if (spec.runs) $('runs').value = spec.runs;
  if (spec.temperature !== undefined) $('temperature').value = spec.temperature;
  if (spec.max_tokens) $('max_tokens').value = spec.max_tokens;
  if (spec.system !== undefined) $('system').value = spec.system;
  if (spec.disparity_threshold != null) $('threshold').value = spec.disparity_threshold;
  if (spec.seed != null) $('seed').value = spec.seed;
  if (spec.share_base) $('share_base').value = spec.share_base;
}

const b64 = {
  enc: (obj) => btoa(unescape(encodeURIComponent(JSON.stringify(obj)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: (s) => JSON.parse(decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))))),
};

async function refreshPlan() {
  const spec = readSpec();
  const plan = await planRun(spec);
  $('spec-id').textContent = plan.id;
  $('jobcount').textContent = `${plan.jobs.length} requests · ${plan.spec.prompts.length} prompt${plan.spec.prompts.length === 1 ? '' : 's'} × ${Object.values(plan.spec.variables).reduce((a, v) => a * v.length, 1)} variants × ${plan.spec.models.length} models × ${plan.spec.runs} runs`;
  const { sentiment_url, ...shareable } = spec;
  const link = `${location.origin}${location.pathname}#spec=${b64.enc(shareable)}`;
  $('share-link').value = link;
  $('problems').hidden = !plan.problems.length;
  $('problems').textContent = plan.problems.join('\n');
  return plan;
}

function outcomeOf(r) {
  if (r.error && !r.refused) return 'error';
  if (r.refused) return 'refused';
  if (r.matched) return 'matched';
  return 'answered';
}

function renderResponses(results) {
  const tbody = $('responses').querySelector('tbody');
  tbody.innerHTML = '';
  const sorted = [...results].sort((a, b) => a.position - b.position);
  for (const r of sorted) {
    const tr = document.createElement('tr');
    const o = outcomeOf(r);
    tr.innerHTML = `<td>${r.position + 1}</td><td>${r.model.split('/').pop()}</td><td>${esc(r.variantLabel)}</td>`
      + `<td><span class="tag ${o}">${o}</span>${r.refusal_reason && r.refused ? `<div class="hint">${esc(r.refusal_reason)}</div>` : ''}</td>`
      + `<td>${r.tokens}</td><td>${r.sentiment >= 0 ? '+' : ''}${Number(r.sentiment).toFixed(2)}</td>`
      + `<td class="resp clip" title="click to expand">${esc(r.error ? `ERROR: ${r.error}` : r.text)}</td>`;
    tr.querySelector('.resp').addEventListener('click', (e) => e.currentTarget.classList.toggle('clip'));
    tbody.appendChild(tr);
  }
  $('resp-count').textContent = `(${results.length})`;
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function paint(run) {
  const a = analyze(run);
  currentSvg = renderCard(a);
  $('card').innerHTML = currentSvg;
  renderResponses(run.results);
  ['btn-svg', 'btn-png', 'btn-json'].forEach((id) => ($(id).disabled = false));
}

function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function svgToPng(svg, size = 1600) {
  const img = new Image();
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  canvas.getContext('2d').drawImage(img, 0, 0, size, size);
  URL.revokeObjectURL(url);
  return new Promise((res) => canvas.toBlob(res, 'image/png'));
}

async function start(providerKind) {
  const spec = readSpec();
  const plan = await refreshPlan();
  if (plan.problems.length) return;
  let provider;
  if (providerKind === 'mock') provider = createMockProvider({ latency: 120 });
  else {
    const apiKey = $('apikey').value.trim();
    if (!apiKey) { $('problems').hidden = false; $('problems').textContent = 'Enter your OpenRouter API key (or use mock data).'; return; }
    if ($('remember').checked) localStorage.setItem(KEY_STORE, apiKey); else localStorage.removeItem(KEY_STORE);
    provider = createOpenRouterProvider({ apiKey, referer: location.origin, title: 'llmscope' });
  }
  if (spec.sentiment_url) setSentimentAnalyzer(httpSentiment(spec.sentiment_url)); else resetSentimentAnalyzer();

  abort = new AbortController();
  $('btn-run').disabled = $('btn-mock').disabled = true;
  $('btn-stop').hidden = false;
  const partial = { version: 'llmscope/0.1', id: plan.id, spec: plan.spec, provider: provider.name, results: [] };
  $('bar').style.width = '0%';
  let last = 0;
  try {
    currentRun = await runEval(spec, {
      provider, concurrency: 4, signal: abort.signal,
      onProgress: ({ done, total, result }) => {
        partial.results.push(result);
        $('bar').style.width = `${(done / total) * 100}%`;
        $('progress-text').textContent = `${done}/${total} · ${result.model.split('/').pop()} [${result.variantLabel}] ${outcomeOf(result)}`;
        const now = performance.now();
        if (now - last > 250 || done === total) { paint(partial); last = now; }
      },
    });
    paint(currentRun);
    $('progress-text').textContent = `${currentRun.results.length} responses · ${currentRun.aborted ? 'stopped' : 'done'} · ${provider.name}`;
    try { localStorage.setItem(`llmscope:run:${plan.id}`, JSON.stringify(currentRun)); } catch {}
  } catch (err) {
    $('problems').hidden = false;
    $('problems').textContent = String(err.message || err);
  } finally {
    $('btn-run').disabled = $('btn-mock').disabled = false;
    $('btn-stop').hidden = true;
  }
}

// wiring
for (const id of ['title', 'prompts', 'variables', 'models', 'primary', 'keywords', 'runs', 'temperature', 'max_tokens', 'system', 'threshold', 'seed', 'share_base']) {
  $(id).addEventListener('input', () => refreshPlan().catch(console.error));
}
$('btn-plan').addEventListener('click', async () => {
  const plan = await refreshPlan();
  const lines = plan.order.map((ji, i) => { const j = plan.jobs[ji]; return `${i + 1}. ${j.model.split('/').pop()} · run ${j.run} · [${j.variantLabel}]\n   ${j.prompt}`; });
  $('card').innerHTML = `<pre style="color:#d5d8dc;font-size:12px;padding:20px;overflow:auto;width:100%;height:100%;margin:0">${esc(`${plan.jobs.length} requests in shuffled order (id ${plan.id})\n\n` + lines.join('\n'))}</pre>`;
});
$('btn-mock').addEventListener('click', () => start('mock'));
$('btn-run').addEventListener('click', () => start('openrouter'));
$('btn-stop').addEventListener('click', () => abort?.abort());
$('btn-copy').addEventListener('click', () => navigator.clipboard.writeText($('share-link').value));
$('btn-svg').addEventListener('click', () => download(`llmscope-${$('spec-id').textContent}.svg`, new Blob([currentSvg], { type: 'image/svg+xml' })));
$('btn-png').addEventListener('click', async () => download(`llmscope-${$('spec-id').textContent}.png`, await svgToPng(currentSvg)));
$('btn-json').addEventListener('click', () => download(`llmscope-${$('spec-id').textContent}.results.json`, new Blob([JSON.stringify(currentRun, null, 2)], { type: 'application/json' })));

// restore key + shared spec
const savedKey = localStorage.getItem(KEY_STORE);
if (savedKey) { $('apikey').value = savedKey; $('remember').checked = true; }
const hash = new URLSearchParams(location.hash.slice(1));
if (hash.get('spec')) { try { writeSpec(b64.dec(hash.get('spec'))); } catch (e) { console.error('bad spec in URL', e); } }
refreshPlan().then((plan) => {
  const saved = localStorage.getItem(`llmscope:run:${plan.id}`);
  if (saved) { try { currentRun = JSON.parse(saved); paint(currentRun); $('progress-text').textContent = `restored last run for ${plan.id}`; } catch {} }
}).catch(console.error);
