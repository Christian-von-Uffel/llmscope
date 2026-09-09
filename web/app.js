// Browser UI. Same engine as the CLI; the API key is only ever sent to openrouter.ai from this page.
import { planRun, runEval, rescoreRun } from '../src/engine.js';
import { analyze, totalTokens } from '../src/analyze.js';
import { renderCard } from '../src/render.js';
import { renderShareCard } from '../src/render-share.js';
import { renderResponseSheet } from '../src/sheet.js';
import { modelColors } from '../src/palette.js';
import { ensureText, FONT_FILES } from '../src/text.js';
import { usedVariables, liftInlineVariants } from '../src/spec.js';
import { createOpenRouterProvider, checkKey } from '../src/providers/openrouter.js';
import { createMockProvider } from '../src/providers/mock.js';
import { setSentimentAnalyzer, resetSentimentAnalyzer, httpSentiment } from '../src/checks/sentiment.js';
import { fetchModels, pickFrontier, newestPerProvider, estimateCost, formatUsd, priceLabel, FRONTIER_DEFAULTS, MAIN_PROVIDERS, resolveModels, isRunnableModel } from '../src/models.js';

const $ = (id) => document.getElementById(id);
const KEY_STORE = 'llmscope:openrouter_key';
let currentRun = null;
let lastPainted = null; // the run (partial while streaming) the card currently shows
let currentSvg = '';
let sheetSvg = '';
let view = 'card';
let abort = null;
let modelList = [];
let frontier = FRONTIER_DEFAULTS.slice();
const checked = new Set(frontier);
const varValues = {}; // remembered per slot name across re-renders
let cardView = 'finding'; // finding | prompt | detail
try { cardView = localStorage.getItem('llmscope:card_view') || 'finding'; } catch {}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const splitList = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
const primary = () => document.querySelector('input[name=primary]:checked').value;

// ---------- spec <-> form ----------
function promptLines() {
  return $('prompts').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function renderVariables() {
  const lifted = liftInlineVariants(promptLines(), {});
  const names = [...usedVariables(lifted.prompts)];
  const box = $('variables');
  if (!names.length) { box.innerHTML = '<div class="hint">No {slots} in the prompt yet. Without one you get a single-column eval, which is fine for constraint tests.</div>'; return; }
  box.innerHTML = names.map((name) => {
    const inline = lifted.variables[name];
    const val = inline ? inline.join(', ') : (varValues[name] ?? (name === 'race' ? 'black, white' : ''));
    return `<div class="var"><code>{${esc(name)}}</code><input data-var="${esc(name)}" value="${esc(val)}" placeholder="value, value, value" ${inline ? 'readonly title="inline group from the prompt"' : ''}></div>`;
  }).join('');
  box.querySelectorAll('input[data-var]').forEach((el) => el.addEventListener('input', () => { varValues[el.dataset.var] = el.value; refresh(); }));
}

function selectedModels() {
  const ids = [...checked].filter((id) => (modelList.length ? modelList.some((m) => m.id === id) : true));
  return [...new Set([...ids, ...resolveModels(splitList($('models_extra').value), modelList).ids])];
}

/** What the "add by family" field resolved to, so the count is visible before the run. */
function renderExtraNote() {
  const selectors = splitList($('models_extra').value);
  const note = $('models-extra-note');
  if (!selectors.length) { note.textContent = ''; return; }
  const { ids, expansions, unmatched } = resolveModels(selectors, modelList);
  const parts = expansions.filter((e) => e.kind !== 'id').map((e) => `${e.selector} → ${e.ids.length} ${e.kind} model${e.ids.length === 1 ? '' : 's'}`);
  if (unmatched.length) parts.push(`no match: ${unmatched.join(', ')}`);
  note.textContent = parts.length ? `${ids.length} added · ${parts.join(' · ')}` : `${ids.length} added`;
}

function readSpec() {
  const variables = {};
  $('variables').querySelectorAll('input[data-var]').forEach((el) => { if (!el.readOnly) variables[el.dataset.var] = el.value.split(',').map((s) => s.trim()); });
  const p = primary();
  const spec = {
    prompts: promptLines(),
    variables,
    models: selectedModels(),
    primary: p,
    keywords: p === 'keyword' ? splitList($('keywords').value) : [],
    keyword_mode: $('keyword_mode').value,
    runs: Number($('runs').value) || 1,
    temperature: Number($('temperature').value) || 0,
    max_tokens: Number($('max_tokens').value) || 400,
    thinking_budget: $('thinking_budget').value === '' ? 8000 : Number($('thinking_budget').value),
    reasoning: $('reasoning').value || 'default',
    system: $('system').value,
    disparity_threshold: $('threshold').value === '' ? null : Number($('threshold').value),
    seed: $('seed').value === '' ? null : Number($('seed').value),
    share_base: $('share_base').value || 'llmscope.dev/e/',
    sentiment_analyzer: $('sentiment_kind').value === 'http' ? $('sentiment_url').value.trim() : 'builtin',
    card_title: cardView === 'prompt' ? 'prompt' : 'finding',
  };
  return spec;
}

function writeSpec(spec) {
  if (!spec) return;
  if (spec.prompts) $('prompts').value = [].concat(spec.prompts).join('\n');
  if (spec.variables) for (const [k, v] of Object.entries(spec.variables)) varValues[k] = [].concat(v).join(', ');
  renderVariables();
  if (spec.primary) { document.querySelector(`input[name=primary][value=${spec.primary}]`).checked = true; toggleMetricFields(); }
  if (spec.keywords) $('keywords').value = [].concat(spec.keywords).join(', ');
  if (spec.keyword_mode) $('keyword_mode').value = spec.keyword_mode;
  if (spec.models) { checked.clear(); for (const id of spec.models) checked.add(id); $('models_extra').value = ''; renderModels(); renderExtraNote(); }
  for (const id of ['system', 'share_base']) if (spec[id] !== undefined) $(id).value = spec[id];
  for (const id of ['runs', 'temperature', 'max_tokens', 'thinking_budget', 'reasoning']) if (spec[id] !== undefined) $(id).value = spec[id];
  if (spec.disparity_threshold != null) $('threshold').value = spec.disparity_threshold;
  if (spec.seed != null) $('seed').value = spec.seed;
  if (spec.sentiment_analyzer && spec.sentiment_analyzer !== 'builtin') { $('sentiment_kind').value = 'http'; $('sentiment_url').value = spec.sentiment_analyzer; }
  if (spec.card_title && cardView !== 'detail') setCardView(spec.card_title);
}

function toggleMetricFields() {
  const p = primary();
  $('keyword-fields').hidden = p !== 'keyword';
  $('sentiment-fields').hidden = p !== 'sentiment';
  $('sentiment-url-wrap').hidden = $('sentiment_kind').value !== 'http';
}

// ---------- models ----------
/** [{name, prefix, models}] for an arbitrary set of models: the major providers first, then the rest by name. */
function groupByProvider(models) {
  const order = MAIN_PROVIDERS.map((p) => p.prefix);
  const prefixes = [...new Set(models.map((m) => m.provider))]
    .sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99) || a.localeCompare(b));
  return prefixes.map((prefix) => ({
    prefix,
    name: MAIN_PROVIDERS.find((p) => p.prefix === prefix)?.name || prefix,
    models: models.filter((m) => m.provider === prefix).sort((a, b) => b.created - a.created),
  }));
}

/** Models the box is showing right now — what "select all" acts on. */
let visibleModels = [];

function renderModels() {
  const box = $('model-list');
  const filter = $('model-filter').value.trim().toLowerCase();
  const pool = modelList.filter(isRunnableModel);
  let groups;
  if (!modelList.length) {
    groups = [{ name: 'Frontier defaults (model list unavailable)', models: FRONTIER_DEFAULTS.map((id) => ({ id, name: id, pricing: null })) }];
  } else if (filter) {
    // A search reaches the whole catalogue, every tier of it: that is how you get from one Gemini to all of them.
    groups = groupByProvider(pool.filter((m) => m.id.toLowerCase().includes(filter) || (m.name || '').toLowerCase().includes(filter)));
  } else {
    // Unfiltered: the flagship window, plus anything already ticked outside it.
    groups = newestPerProvider(modelList, MAIN_PROVIDERS.map((p) => p.prefix), 4).map((g) => ({
      ...g,
      models: [...g.models, ...pool.filter((m) => m.provider === g.prefix && checked.has(m.id) && !g.models.some((x) => x.id === m.id))],
    }));
  }
  visibleModels = groups.flatMap((g) => g.models);
  let html = '';
  for (const g of groups) {
    if (!g.models.length) continue;
    html += `<div class="prov">${esc(g.name)}</div>`;
    for (const m of g.models) {
      html += `<label class="m"><input type="checkbox" data-model="${esc(m.id)}" ${checked.has(m.id) ? 'checked' : ''}><span>${esc(m.id)}${frontier.includes(m.id) ? '<span class="star" title="frontier default">★</span>' : ''}</span><span class="price">${esc(m.pricing ? priceLabel(m).replace(' per M tokens', '') : '')}</span></label>`;
    }
  }
  box.innerHTML = html || '<div class="hint" style="padding:10px">no models match</div>';
  box.querySelectorAll('input[data-model]').forEach((el) => el.addEventListener('change', () => { el.checked ? checked.add(el.dataset.model) : checked.delete(el.dataset.model); renderModelStatus(); refresh(); }));
  renderModelStatus();
}

/** The status line and the button that ticks or clears a whole search at once. */
function renderModelStatus() {
  const filter = $('model-filter').value.trim();
  const btn = $('model-all');
  const status = $('model-status');
  if (!modelList.length) { btn.hidden = true; return; }
  const allChecked = visibleModels.length > 0 && visibleModels.every((m) => checked.has(m.id));
  btn.hidden = !filter || !visibleModels.length;
  btn.textContent = allChecked ? `Clear these ${visibleModels.length}` : `Select all ${visibleModels.length}`;
  status.textContent = filter
    ? `${visibleModels.length} of ${modelList.length} match “${filter}” · ${checked.size} selected`
    : `${modelList.length} models · ${checked.size} selected · ★ frontier default`;
}

async function loadModels() {
  try {
    modelList = await fetchModels();
    frontier = pickFrontier(modelList);
    if (checked.size === FRONTIER_DEFAULTS.length && FRONTIER_DEFAULTS.every((id) => checked.has(id))) { checked.clear(); frontier.forEach((id) => checked.add(id)); }
  } catch (err) {
    $('model-status').textContent = `model list unavailable (${err.message}); using built-in defaults`;
  }
  renderModels();
  renderExtraNote();
  refresh();
}

// ---------- plan / estimate ----------
const b64 = {
  enc: (obj) => btoa(unescape(encodeURIComponent(JSON.stringify(obj)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: (s) => JSON.parse(decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))))),
};

async function refresh() {
  const spec = readSpec();
  const plan = await planRun(spec);
  $('spec-id').textContent = plan.id;
  $('share-link').value = `${location.origin}${location.pathname}#spec=${b64.enc(spec)}`;
  $('problems').hidden = !plan.problems.length;
  $('problems').textContent = plan.problems.join('\n');
  const variants = Object.values(plan.spec.variables).reduce((a, v) => a * v.length, 1);
  const shape = `${plan.spec.prompts.length} prompt${plan.spec.prompts.length === 1 ? '' : 's'} × ${variants} variant${variants === 1 ? '' : 's'} × ${plan.spec.models.length} model${plan.spec.models.length === 1 ? '' : 's'} × ${plan.spec.runs} run${plan.spec.runs === 1 ? '' : 's'}`;
  let cost = '';
  if (modelList.length && plan.jobs.length) {
    const c = estimateCost(plan, modelList);
    cost = ` · est. <b>≈${formatUsd(c.typical)}</b> <span class="hint">(up to ${formatUsd(c.high)} if every reply used its whole budget)</span>` + (c.unknown.length ? ` · <span class="bad">not on OpenRouter: ${esc(c.unknown.join(', '))}</span>` : '');
  }
  $('estimate').innerHTML = `<b>${plan.jobs.length}</b> requests · ${esc(shape)}${cost}`;
  return plan;
}

// ---------- run ----------
function outcomeOf(r) {
  if (r.error && !r.refused) return 'error';
  if (r.refused) return 'refused';
  if (r.matched) return 'matched';
  return 'answered';
}

/** The table under the card: every reply, its model name and text in the model's color, the same colors as the responses sheet's legend. */
function renderResponses(results, colors = {}) {
  const tbody = $('responses').querySelector('tbody');
  tbody.innerHTML = '';
  for (const r of [...results].sort((a, b) => a.position - b.position)) {
    const tr = document.createElement('tr');
    const o = outcomeOf(r);
    const color = colors[r.model] ? ` style="color:${colors[r.model]}"` : '';
    const cut = r.finish_reason === 'length';
    const text = r.error && !cut ? `ERROR: ${r.error}` : (r.text || '') + (cut ? '…' : '');
    tr.innerHTML = `<td>${r.position + 1}</td><td class="model"${color}>${esc(r.model.split('/').pop())}</td><td>${esc(r.variantLabel)}</td>`
      + `<td><span class="tag ${o}">${o}</span>${r.refused && r.refusal_reason ? `<div class="hint">${esc(r.refusal_reason)}</div>` : ''}</td>`
      + `<td title="${r.prompt_tokens || 0} prompt + ${r.tokens} reply${r.reasoning_tokens ? ` (${r.reasoning_tokens} thinking)` : ''}">${totalTokens(r)}</td><td>${r.sentiment >= 0 ? '+' : ''}${Number(r.sentiment).toFixed(2)}</td>`
      + `<td class="resp clip"${r.error && !cut ? '' : color} title="click to expand">${esc(text)}</td>`;
    tr.querySelector('.resp').addEventListener('click', (e) => e.currentTarget.classList.toggle('clip'));
    tbody.appendChild(tr);
  }
  $('resp-count').textContent = `(${results.length})`;
}

function setCardView(view) {
  cardView = view;
  try { localStorage.setItem('llmscope:card_view', view); } catch {}
  document.querySelectorAll('#card-view button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
}

function paint(run) {
  lastPainted = run;
  const a = analyze(run);
  const names = Object.fromEntries(modelList.map((m) => [m.id, m.name]));
  currentSvg = cardView === 'detail' ? renderCard(a) : renderShareCard(a, { names, date: run.finished_at, title: cardView });
  sheetSvg = '';
  if (view === 'sheet') showSheet(run); else $('card').innerHTML = currentSvg;
  renderResponses(run.results, modelColors(a.rows.map((r) => r.model)));
  ['btn-svg', 'btn-png', 'btn-json', 'tab-card', 'tab-sheet'].forEach((id) => ($(id).disabled = false));
}

function showSheet(run) {
  if (!sheetSvg) sheetSvg = renderResponseSheet(run, { size: 4096, select: 'all' }).svg;
  $('card').innerHTML = sheetSvg;
}

function setView(v) {
  view = v;
  $('tab-card').classList.toggle('on', v === 'card');
  $('tab-sheet').classList.toggle('on', v === 'sheet');
  if (!currentRun) return;
  if (v === 'sheet') showSheet(currentRun); else $('card').innerHTML = currentSvg;
}
const activeSvg = () => (view === 'sheet' ? sheetSvg : currentSvg);
const activeName = () => `llmscope-${$('spec-id').textContent}${view === 'sheet' ? '.responses' : ''}`;

function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// An SVG drawn into a canvas cannot load page fonts, so PNG export embeds the font files it was measured with.
let fontCss = null;
async function embeddedFontCss() {
  if (fontCss) return fontCss;
  const faces = await Promise.all(FONT_FILES.map(async (f) => {
    const buf = await fetch(`/node_modules/${f.pkg}`).then((r) => r.arrayBuffer());
    let bin = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return `@font-face{font-family:'${f.family}';font-weight:${f.weight};src:url(data:font/ttf;base64,${btoa(bin)}) format('truetype');}`;
  }));
  fontCss = faces.join('');
  return fontCss;
}

async function svgToPng(svg, size = 1600) {
  const css = await embeddedFontCss().catch(() => '');
  if (css) svg = svg.replace(/^(<svg[^>]*>)/, `$1<style>${css}</style>`);
  const img = new Image();
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  canvas.getContext('2d').drawImage(img, 0, 0, size, size);
  URL.revokeObjectURL(url);
  return new Promise((res) => canvas.toBlob(res, 'image/png'));
}

function problem(msg) { $('problems').hidden = !msg; $('problems').textContent = msg || ''; }

async function start(kind) {
  const spec = readSpec();
  const plan = await refresh();
  if (plan.problems.length) return;
  let provider;
  if (kind === 'mock') provider = createMockProvider({ latency: 120 });
  else {
    const apiKey = $('apikey').value.trim();
    if (!apiKey) { problem('Step 1: paste your OpenRouter API key (or preview with mock data).'); $('apikey').focus(); return; }
    if ($('remember').checked) localStorage.setItem(KEY_STORE, apiKey); else localStorage.removeItem(KEY_STORE);
    provider = createOpenRouterProvider({ apiKey, referer: location.origin, title: 'llmscope', models: modelList.length ? modelList : null });
  }
  if (spec.sentiment_analyzer && spec.sentiment_analyzer !== 'builtin') setSentimentAnalyzer(httpSentiment(spec.sentiment_analyzer)); else resetSentimentAnalyzer();
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
    currentRun.sentiment_analyzer = spec.sentiment_analyzer;
    paint(currentRun);
    const errors = currentRun.results.filter((r) => r.error).length;
    $('progress-text').textContent = `${currentRun.results.length} responses · ${currentRun.aborted ? 'stopped' : 'done'} · ${provider.name}${errors ? ` · ${errors} errors` : ''}${currentRun.cost?.priced ? ` · cost ${formatUsd(currentRun.cost.usd)}` : ''}`;
    try { localStorage.setItem(`llmscope:run:${plan.id}`, JSON.stringify(currentRun)); } catch {}
  } catch (err) {
    problem(String(err.message || err));
  } finally {
    $('btn-run').disabled = $('btn-mock').disabled = false;
    $('btn-stop').hidden = true;
  }
}

// ---------- wiring ----------
$('prompts').addEventListener('input', () => { renderVariables(); refresh(); });
for (const id of ['keywords', 'keyword_mode', 'runs', 'temperature', 'max_tokens', 'thinking_budget', 'reasoning', 'system', 'threshold', 'seed', 'share_base', 'models_extra', 'sentiment_url']) $(id).addEventListener('input', () => refresh());
document.querySelectorAll('input[name=primary]').forEach((el) => el.addEventListener('change', () => { toggleMetricFields(); refresh(); }));
$('sentiment_kind').addEventListener('change', () => { toggleMetricFields(); refresh(); });
$('model-filter').addEventListener('input', renderModels);
$('models_extra').addEventListener('input', renderExtraNote);
$('model-all').addEventListener('click', () => {
  const all = visibleModels.every((m) => checked.has(m.id));
  for (const m of visibleModels) (all ? checked.delete(m.id) : checked.add(m.id));
  renderModels();
  refresh();
});
document.querySelectorAll('#card-view button').forEach((b) => b.addEventListener('click', () => { setCardView(b.dataset.view); if (lastPainted) paint(lastPainted); refresh(); }));
$('btn-check').addEventListener('click', async () => {
  const key = $('apikey').value.trim();
  const el = $('key-status');
  if (!key) { el.textContent = 'paste a key first'; return; }
  el.textContent = 'checking…';
  const info = await checkKey({ apiKey: key });
  el.innerHTML = info.ok
    ? `<span class="ok">valid</span>${info.label ? ` · ${esc(info.label)}` : ''} · used ${formatUsd(info.usage || 0)}${info.limit != null ? ` of ${formatUsd(info.limit)}` : ''}`
    : `<span class="bad">${esc(info.error)}</span>`;
});
$('btn-plan').addEventListener('click', async () => {
  const plan = await refresh();
  const lines = plan.order.map((ji, i) => { const j = plan.jobs[ji]; return `${i + 1}. ${j.model.split('/').pop()} · run ${j.run} · [${j.variantLabel}]\n   ${j.prompt}`; });
  $('card').innerHTML = `<pre style="color:#d5d8dc;font-size:12px;padding:20px;overflow:auto;width:100%;height:100%;margin:0">${esc(`${plan.jobs.length} requests in shuffled order (id ${plan.id})\n\n` + lines.join('\n'))}</pre>`;
});
$('btn-mock').addEventListener('click', () => start('mock'));
$('btn-run').addEventListener('click', () => start('openrouter'));
$('btn-stop').addEventListener('click', () => abort?.abort());
$('btn-copy').addEventListener('click', () => navigator.clipboard.writeText($('share-link').value));
$('btn-svg').addEventListener('click', () => download(`${activeName()}.svg`, new Blob([activeSvg()], { type: 'image/svg+xml' })));
$('btn-png').addEventListener('click', async () => download(`${activeName()}.png`, await svgToPng(activeSvg(), view === 'sheet' ? 4096 : 1600)));
$('tab-card').addEventListener('click', () => setView('card'));
$('tab-sheet').addEventListener('click', () => setView('sheet'));
$('btn-json').addEventListener('click', () => download(`llmscope-${$('spec-id').textContent}.results.json`, new Blob([JSON.stringify(currentRun, null, 2)], { type: 'application/json' })));
$('load-results').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const run = JSON.parse(await file.text());
    if (!Array.isArray(run.results) || !run.spec) throw new Error('not an llmscope results file');
    rescoreRun(run);
    currentRun = run;
    writeSpec(run.spec);
    await refresh();
    paint(run);
    $('progress-text').textContent = `loaded ${file.name} · ${run.results.length} responses · ${run.provider}`;
  } catch (err) { problem(`Could not load ${file.name}: ${err.message}`); }
  e.target.value = '';
});

// ---------- boot ----------
await ensureText(); // fonts + canvas measurement before anything is laid out
const savedKey = localStorage.getItem(KEY_STORE);
if (savedKey) { $('apikey').value = savedKey; $('remember').checked = true; }
renderVariables();
toggleMetricFields();
renderModels();
setCardView(cardView);
const hash = new URLSearchParams(location.hash.slice(1));
if (hash.get('spec')) { try { writeSpec(b64.dec(hash.get('spec'))); } catch (e) { console.error('bad spec in URL', e); } }
refresh().then((plan) => {
  const saved = localStorage.getItem(`llmscope:run:${plan.id}`);
  if (saved) { try { currentRun = JSON.parse(saved); paint(currentRun); $('progress-text').textContent = `restored last run for ${plan.id}`; } catch {} }
}).catch(console.error);
loadModels();
