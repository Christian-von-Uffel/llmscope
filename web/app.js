// Browser UI. Same engine as the CLI; the API key is only ever sent to openrouter.ai from this page.
//
// The page has three stages — the landing page, the key prompt, and the app — and they are one document rather
// than three, so the app is already parsed and its model list already loading while someone is still reading the
// hero. A returning reader with a saved key never sees the first two at all.
import { planRun, runEval, rescoreRun } from '../src/engine.js';
import { totalTokens, outcomeOf, replyBody } from '../src/analyze.js';
import { EXCERPTS } from '../src/sheet.js';
import { IMAGES, imageOf, sheetKind, drawImage, markedWords } from '../src/images.js';
import { RESPONSE_FILTERS, filterResponses, parseSearch, shownText, markSpans, toCsv, toJson } from '../src/responses.js';
import { isValidKeyword, splitTerms, mergeTerms, countKeywords, cleanTerms, batchKey } from '../src/checks/keywords.js';
import { logoBody, providerOf } from '../src/logos.js';
import { ensureText, FONT_FILES } from '../src/text.js';
import { usedVariables, liftInlineVariants, strayBraces, defaultCardTitle, normalizeSpec, CANONICAL_FIELDS } from '../src/spec.js';
import { isValidId, freshId } from '../src/id.js';
import { createOpenRouterProvider, checkKey, maskKey, fetchBalance, OPENROUTER_CREDITS_URL } from '../src/providers/openrouter.js';
import { createMockProvider } from '../src/providers/mock.js';
import { fetchModels, pickFrontier, newestPerProvider, estimateCost, formatUsd, priceLabel, FRONTIER_DEFAULTS, MAIN_PROVIDERS, resolveModels, isRunnableModel, cleanModels, formatModels, modelKey } from '../src/models.js';
import * as store from './store.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const splitList = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
const primary = () => document.querySelector('input[name=primary]:checked').value;

// ---------- state ----------
let currentRun = null;
let lastPainted = null; // the run (partial while streaming) the card currently shows
let paintedId = null; // which run the marked words below belong to
// Every image drawn for the run on show, by kind, with the options it was drawn under: a 4096px sheet is the
// expensive part of switching tabs, so each is kept until the run, the words or its own options change.
const drawn = new Map();
let view = 'card'; // the image on show: a kind from IMAGES
let abort = null;
let modelList = [];
// What the connected key can still spend, read when the app opens and again after every run. null until read.
let balance = null;
let frontier = FRONTIER_DEFAULTS.slice();
const checked = new Set(frontier);
const varValues = {}; // remembered per slot name across re-renders
// What the form currently describes: the eval's content-addressed id, and the link that carries its whole spec.
// The link is what Share link copies. Downloads are not named after this id but after the run on show: a run's
// files carry the run's own id, as they do in out/, so two runs of one eval never download to the same name and
// a card downloaded after the form was edited is still named for the run it draws.
let planId = '';
let shareLink = '';
const shownId = () => currentRun?.id || planId;

// Two sets of marked words, and the gap between them is the feature. `marked` is what the images were drawn
// with; `pending` is what the box says right now. Typing changes the table immediately, because finding the
// word is the thing you are doing. Redrawing a four-thousand-pixel sheet mid-hunt is not, so the images wait
// for the button.
let marked = [];
let pending = [];

// The published eval this form came from, if any: {id, spec}. Kept so the form can say where it started and
// what has moved since, and so Reset can put it back. Cleared when a run is opened from anywhere else.
let openedFrom = null;
let resolved = null; // the eval the resolved screen is showing
// An eval waiting on a key: "Run it as is" with no key connected goes through the key step and lands here.
let pendingEval = null;

// null until the reader picks one, so an untouched toggle leaves the default to decide — which is the prompt,
// whatever the card measured.
let cardView = store.getPref('card_view', null);
const resultsView = (p) => cardView || defaultCardTitle(p);
// The keyword card leads with the prompts too, and the toggle over it remembers a separate choice rather than
// inheriting the results card's: the two images are read for different reasons.
let keywordView = store.getPref('keyword_view', 'prompt');

// Text measurement is needed by anything that draws a card, and by boot. Kept separate from `ready` so the
// resolved screen can wait for the fonts without waiting for the rest of boot, which may be waiting on it.
const textReady = ensureText();

// ---------- stages ----------
function setStage(name) {
  document.documentElement.dataset.stage = name;
  window.scrollTo(0, 0);
  if (name === 'key') $('apikey').focus({ preventScroll: true });
}

// ---------- opening an eval by id ----------
/**
 * What someone pasted, as an id. A bare id, a share link with the spec in its hash, or a card's footer URL are
 * all things people copy, and all three name an eval, so all three are accepted.
 * @returns {{kind:'id', id:string} | {kind:'spec', spec:object} | null}
 */
function parseEvalRef(input) {
  const text = String(input || '').trim();
  if (!text) return null;
  const hash = text.match(/[#&]spec=([A-Za-z0-9\-_]+)/);
  if (hash) { try { return { kind: 'spec', spec: b64.dec(hash[1]) }; } catch { return null; } }
  // llmscope.dev/e/D5a3G9, with or without a scheme, and the bare id itself.
  const tail = text.replace(/[?#].*$/, '').split('/').filter(Boolean).pop() || '';
  return isValidId(tail) ? { kind: 'id', id: tail } : null;
}

/**
 * Turn a reference into something to look at. Three places are asked in turn: this browser's own runs, the
 * evals/ directory of whatever origin is serving this page, and the spec carried in a share link. A bare id
 * from a stranger's post resolves only once a registry exists to answer for it, which is what Supabase is for;
 * until then the error says so rather than pretending the id was malformed.
 */
async function resolveEvalRef(ref) {
  if (!ref) return { error: 'That is not an eval ID or an llmscope link. An ID is six characters, like D5a3G9.' };
  // A share link carries the whole spec, so it always resolves — but the id it computes to may be one this
  // browser or this site has already run, and then it has a card to show. Same screen either way.
  if (ref.kind === 'spec') {
    const spec = normalizeSpec(ref.spec);
    const { id } = await planRun(spec);
    const own = await store.latestRunFor(id);
    if (own) return { id: own.id, spec: normalizeSpec(own.spec), run: own };
    return (await lookupPublished(id)) || { id, spec };
  }
  // A run's own id first, then an eval's — the newest run this browser has of it — then what the site publishes.
  const run = (await store.loadRun(ref.id)) || (await store.latestRunFor(ref.id));
  if (run) return { id: run.id, spec: normalizeSpec(run.spec), run };
  return (await lookupPublished(ref.id))
    || { error: `Nothing here answers to ${ref.id}. This browser can open its own runs and the evals published on this site; an ID from somebody else's post needs the full share link for now.` };
}

/**
 * What this origin has published under an id. A finished run is asked for first because it answers with its
 * card as well as its spec; a bare spec is the fallback. Null when the origin publishes neither.
 */
async function lookupPublished(id) {
  for (const [path, take] of [
    [`/out/${id}.results.json`, (j) => (Array.isArray(j.results) ? { id, spec: normalizeSpec(j.spec), run: j } : null)],
    [`/evals/${id}.json`, (j) => ({ id, spec: normalizeSpec(j) })],
  ]) {
    try {
      const res = await fetch(path);
      if (!res.ok) continue;
      const found = take(await res.json());
      if (found) { if (found.run) rescoreRun(found.run); return found; }
    } catch { /* nothing published at this path on this origin; try the next */ }
  }
  return null;
}

/** Show the eval, whatever it came from, before a single request is sent. */
async function openEvalRef(ref, errorBox) {
  const found = await resolveEvalRef(ref);
  if (found.error) {
    if (errorBox) { errorBox.hidden = false; errorBox.textContent = found.error; }
    return false;
  }
  if (errorBox) errorBox.hidden = true;
  await showResolved(found);
  return true;
}

// The header's Open… menu. Focus lands in the id box when it opens; it closes once something has been opened,
// on Escape, or on a click anywhere else, so it never has to be put away by hand.
const opener = document.querySelector('details.opener');
const closeOpener = () => { if (opener) opener.open = false; };
if (opener) {
  opener.addEventListener('toggle', () => { if (opener.open) opener.querySelector('input[type=text]').focus(); });
  document.addEventListener('click', (e) => { if (opener.open && !opener.contains(e.target)) closeOpener(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeOpener(); });
}

for (const form of document.querySelectorAll('form[data-open-id]')) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = form.querySelector('input');
    const box = form.parentElement.querySelector('.id-error') || form.nextElementSibling;
    const ok = await openEvalRef(parseEvalRef(input.value), box?.classList.contains('id-error') ? box : null);
    if (ok) { input.value = ''; closeOpener(); }
  });
}

for (const el of document.querySelectorAll('[data-go]')) {
  el.addEventListener('click', (e) => {
    const to = el.dataset.go;
    if (el.tagName === 'A') e.preventDefault();
    if (to === 'demo') { setStage('app'); ready.then(() => start('mock')); return; }
    // "Start evaluating" asks for a key only when there is none. A reader who came back to the landing page
    // from the app already has theirs, in the box or in storage; the key page is reached again through
    // "Change key", which goes there by name rather than through this.
    if (to === 'key' && (keyValue() || store.readKey())) { setStage('app'); return; }
    setStage(to);
  });
}

// ---------- the resolved screen ----------
const nOf = (x, one, many = one + 's') => `${x} ${x === 1 ? one : many}`;
const MEASURE = { refusal: 'Refusals', keyword: 'Keywords or phrases', sentiment: 'Sentiment' };

/** The eval's shape in the words the form uses for the same things. */
function evalDetail(spec) {
  const rows = [];
  for (const [name, values] of Object.entries(spec.variables || {})) {
    rows.push([`{${name}}`, values.map((v) => v || '(none)').join(' · ')]);
  }
  rows.push(['Measures', MEASURE[spec.primary] || spec.primary]);
  if (spec.primary === 'keyword') rows.push(['Words', spec.keywords.length ? spec.keywords.join(', ') : 'none yet — chosen after reading the replies']);
  const names = spec.models.map((m) => prettyModel(m));
  rows.push(['Models', `${spec.models.length} — ${names.slice(0, 3).join(', ')}${names.length > 3 ? `, +${names.length - 3}` : ''}`]);
  return rows;
}

/** A model's display name if the catalogue has arrived, else the half of the id that names the model. */
const prettyModel = (id) => (modelList.find((m) => m.id === id)?.name || id).replace(/^[^:]+:\s*/, '').trim();

/**
 * The screen between seeing an eval somewhere and running it: what it asks, of whom, and what it will cost on
 * your key. Nothing is sent from here — the two buttons are the only ways out.
 */
async function showResolved(found) {
  resolved = found;
  const { spec, id, run } = found;
  const plan = await planRun(spec);
  $('resolved-id').textContent = id || plan.id;
  $('resolved-prompt').innerHTML = `&ldquo;${highlightSlots(spec.prompts[0] || '')}&rdquo;`;
  paintResolvedDetail(spec, plan);
  // The card only exists where the replies do; an eval published as a spec alone has no picture yet.
  const card = $('resolved-card');
  card.hidden = !run;
  document.querySelector('.resolved-grid').classList.toggle('no-card', !run);
  if (run) { await textReady; card.innerHTML = drawImage('card', run, { names: Object.fromEntries(modelList.map((m) => [m.id, m.name])), date: run.finished_at }).svg; }
  setStage('resolved');
}

function paintResolvedDetail(spec, plan) {
  const rows = evalDetail(spec);
  rows.push(['Repeats', `${nOf(spec.runs, 'run')} per cell, so ${nOf(plan.jobs.length, 'request')}`]);
  rows.push(['Your cost', costLine(plan)]);
  $('resolved-detail').innerHTML = rows.map(([k, v]) =>
    `<div class="row"><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('');
}

/** The prompt with its slots marked, the way the card marks them. */
const highlightSlots = (text) => esc(text).replace(/\{[^{}]+\}/g, (m) => `<b>${m}</b>`);

/** What a run of this plan costs, once the catalogue is in. */
function costLine(plan) {
  if (!modelList.length || !plan.jobs.length) return '<b>—</b> on your own OpenRouter key';
  const c = estimateCost(plan, modelList);
  return `<b>≈ ${formatUsd(c.typical)}</b> on your own OpenRouter key${balanceHtml(c.typical)}`;
}

// ---------- the balance ----------
/** "$1.20 left on OpenRouter", naming the key's own limit when that is what stops a run first. */
const balanceWords = (b) => `${formatUsd(b.remaining)} in credits left${b.ceiling === 'key' ? ' under this key’s spend limit' : ''}`;

/** The balance beside a cost: plain when the run fits, red with the place to top up when it does not. */
function balanceHtml(cost) {
  if (!balance?.ok) return '';
  if (cost != null && balance.remaining < cost) {
    return ` · <span class="bad">only ${balanceWords(balance)}</span> · <a href="${OPENROUTER_CREDITS_URL}" target="_blank" rel="noopener">${balance.ceiling === 'key' ? 'raise the limit or add credits' : 'add credits'} ↗</a>`;
  }
  return ` · ${balanceWords(balance)}`;
}

/** Read the balance for the key in use and redraw every line that shows it. Nothing to read without a key. */
async function loadBalance() {
  const key = keyValue() || store.readKey();
  balance = key ? await fetchBalance({ apiKey: key }) : null;
  await refresh();
  if (resolved && document.documentElement.dataset.stage === 'resolved') paintResolvedDetail(resolved.spec, await planRun(resolved.spec));
  return balance;
}

/** Put a resolved eval on the form. Its id becomes the origin every later edit is measured against. */
async function adoptResolved() {
  if (!resolved) return;
  openedFrom = resolved.id ? { id: resolved.id, spec: resolved.spec } : null;
  writeSpec(resolved.spec);
  await refresh();
  if (resolved.run) await openRun(resolved.run, `opened ${resolved.id} · ${resolved.run.results.length} responses · ${resolved.run.provider}`);
}

/** Where "Run it as is" and "Change something first" go: straight to work, or through the key first. */
async function leaveResolved(andRun) {
  if (!store.readKey() && !keyValue()) {
    pendingEval = { spec: resolved.spec, id: resolved.id, run: andRun };
    syncPending();
    return setStage('key');
  }
  setStage('app');
  await adoptResolved();
  if (andRun) start('openrouter');
}

function syncPending() {
  const box = $('key-pending');
  box.hidden = !pendingEval;
  if (!pendingEval) return;
  box.innerHTML = `Waiting to run <code>${esc(pendingEval.id || 'this eval')}</code>${pendingEval.line ? ` · ${esc(pendingEval.line)}` : ''}`;
}

// ---------- things this browser has typed before ----------
// There is no evals/ or out/ to read from in a browser, so recall here is this browser's own history. It fills
// the dropdown on both keyword boxes and on the model set box: pick a whole batch, not a word at a time.
function rememberBatch(terms) {
  const list = cleanTerms(terms);
  if (!list.length) return;
  store.rememberBatch(list, batchKey);
  renderBatches();
}

function renderBatches() {
  $('keyword-batches').innerHTML = store.keywordBatches().map((t) => `<option value="${esc(t.join(', '))}"></option>`).join('');
}

function rememberModelSet(ids) {
  const list = cleanModels(ids);
  if (!list.length) return;
  store.rememberModelSet(list, modelKey);
  renderModelSets();
}

function renderModelSets() {
  const sets = store.modelSets();
  $('model-sets').innerHTML = sets.map((ids) => `<option value="${esc(formatModels(ids))}"></option>`).join('');
  $('model-set-note').textContent = sets.length
    ? `${sets.length} earlier set${sets.length === 1 ? '' : 's'} in the dropdown · the list below is still how you pick`
    : 'the list below is how you pick · a run remembers the set for next time';
}

/** Tick exactly these IDs. Used by a loaded spec and by typing in the set box. */
function applyModelSet(ids) {
  checked.clear();
  for (const id of cleanModels(ids)) checked.add(id);
  $('model-set').value = formatModels([...checked]);
  renderModels();
  refresh();
}

function syncModelSetField() {
  if (document.activeElement === $('model-set')) return;
  $('model-set').value = formatModels([...checked]);
}

/** Turn the set box into ticks: IDs as written, families and globs expanded against the live list. */
function commitModelSetField() {
  const sels = splitList($('model-set').value);
  if (!sels.length) return syncModelSetField();
  const { ids, unmatched } = resolveModels(sels, modelList);
  if (unmatched.length) $('model-set-note').textContent = `no match: ${unmatched.join(', ')}`;
  if (!ids.length) return syncModelSetField();
  applyModelSet(ids);
  renderModelSets();
}

// ---------- form <-> spec ----------
const promptLines = () => $('prompts').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

function renderVariables() {
  const lifted = liftInlineVariants(promptLines(), {});
  const names = [...usedVariables(lifted.prompts)];
  const box = $('variables');
  // Empty braces name no slot, so they would reach the model as written.
  const stray = strayBraces(lifted.prompts).length
    ? '<div class="hint warn">{} names no slot and is sent to the model as written. Name the slot in your own words, like {environmental concern}, or double the braces ({{ }}) to send them literally.</div>'
    : '';
  if (!names.length) { box.innerHTML = `${stray}<div class="hint">No {slots} in the prompt yet. Without one you get a single-column eval, which is fine for constraint tests.</div>`; return; }
  box.innerHTML = stray + names.map((name) => {
    const inline = lifted.variables[name];
    const val = inline ? inline.join(', ') : (varValues[name] ?? (name === 'group' ? 'Black, white, Muslim, Jewish,' : ''));
    return `<div class="var"><code>{${esc(name)}}</code><input data-var="${esc(name)}" value="${esc(val)}" placeholder="value, value, value" ${inline ? 'readonly title="inline group from the prompt"' : ''}></div>`;
  }).join('');
  box.querySelectorAll('input[data-var]').forEach((el) => el.addEventListener('input', () => { varValues[el.dataset.var] = el.value; refresh(); }));
}

const selectedModels = () => [...checked].filter((id) => (modelList.length ? modelList.some((m) => m.id === id) : true));

/**
 * What the form is asking for. The web form carries the five fields a reader actually decides — prompt, slot
 * values, measure, models, repeats — and lets `DEFAULTS` in src/spec.js supply the rest, unchanged. The knobs
 * that are missing here are not disabled anywhere: `llmscope run` still takes every one of them, and a spec
 * file loaded with "Load results…" keeps whatever it was run with.
 */
function readSpec() {
  const variables = {};
  $('variables').querySelectorAll('input[data-var]').forEach((el) => { if (!el.readOnly) variables[el.dataset.var] = el.value.split(',').map((s) => s.trim()); });
  const p = primary();
  return {
    prompts: promptLines(),
    variables,
    models: selectedModels(),
    primary: p,
    keywords: p === 'keyword' ? splitTerms($('keywords').value) : [],
    keyword_mode: $('keyword_mode').value,
    runs: Number($('runs').value) || 1,
    card_title: cardView, // null until the toggle is touched, so the saved eval follows the default rather than freezing it
  };
}

/** Put a spec back on the form. A loaded run may carry fields the form has no box for; those simply stay on it. */
function writeSpec(spec) {
  if (!spec) return;
  if (spec.prompts) $('prompts').value = [].concat(spec.prompts).join('\n');
  if (spec.variables) for (const [k, v] of Object.entries(spec.variables)) varValues[k] = [].concat(v).join(', ');
  renderVariables();
  if (spec.primary) { document.querySelector(`input[name=primary][value=${spec.primary}]`).checked = true; toggleMetricFields(); }
  if (spec.keywords) $('keywords').value = [].concat(spec.keywords).join(', ');
  if (spec.keyword_mode) $('keyword_mode').value = spec.keyword_mode;
  if (spec.runs !== undefined) $('runs').value = spec.runs;
  if (spec.models) { checked.clear(); for (const id of spec.models) checked.add(id); renderModels(); syncModelSetField(); }
  // A loaded eval's own heading shows in the toggle, but is not remembered as this reader's choice: only the
  // buttons set the preference. Otherwise one eval that names a heading would go on overriding the default for
  // every later run in this browser.
  if (spec.card_title) { cardView = spec.card_title; syncCardView(); }
}

function toggleMetricFields() {
  $('keyword-fields').hidden = primary() !== 'keyword';
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

let visibleModels = []; // what the box is showing right now — what "select all" acts on

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
      html += `<label class="m" title="${esc(m.id)}"><input type="checkbox" data-model="${esc(m.id)}" ${checked.has(m.id) ? 'checked' : ''}><span>${esc(m.id)}${frontier.includes(m.id) ? '<span class="star" title="frontier default">★</span>' : ''}</span><span class="price">${esc(m.pricing ? priceLabel(m).replace(' per M tokens', '') : '')}</span></label>`;
    }
  }
  box.innerHTML = html || '<div class="hint none">no models match</div>';
  box.querySelectorAll('input[data-model]').forEach((el) => el.addEventListener('change', () => {
    el.checked ? checked.add(el.dataset.model) : checked.delete(el.dataset.model);
    $('model-set').value = formatModels([...checked]);
    renderModelStatus();
    refresh();
  }));
  renderModelStatus();
}

/** The status line and the button that ticks or clears a whole search at once. */
function renderModelStatus() {
  const filter = $('model-filter').value.trim();
  const btn = $('model-all');
  if (!modelList.length) { btn.hidden = true; return; }
  const allChecked = visibleModels.length > 0 && visibleModels.every((m) => checked.has(m.id));
  btn.hidden = !filter || !visibleModels.length;
  btn.textContent = allChecked ? `Clear these ${visibleModels.length}` : `Select all ${visibleModels.length}`;
  $('model-status').textContent = filter
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
  syncModelSetField();
  refresh();
  // A card restored before the catalogue arrived was drawn with bare IDs for model names. Now that the display
  // names are here, draw it again rather than leaving one run's card spelled differently from the next.
  if (lastPainted) paint(lastPainted);
}

// ---------- plan and estimate ----------
const b64 = {
  enc: (obj) => btoa(unescape(encodeURIComponent(JSON.stringify(obj)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: (s) => JSON.parse(decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))))),
};

const problem = (msg) => { $('problems').hidden = !msg; $('problems').textContent = msg || ''; };

/**
 * What has moved since the eval was opened, in the words of the form. Comparing the canonical fields is exactly
 * what gives the run a different id, so this list and the new id can never disagree about whether anything
 * changed.
 */
const FIELD_NAMES = {
  prompts: 'prompt wording', variables: 'slot values', models: 'models', runs: 'runs per cell',
  primary: 'the measure', keywords: 'keywords', keyword_mode: 'how keywords count',
  system: 'system prompt', temperature: 'temperature', max_tokens: 'reply cap',
  thinking_budget: 'thinking budget', reasoning: 'reasoning effort', seed: 'seed',
};
const sizeOf = (v) => (Array.isArray(v) ? v.length : null);

function describeChanges(before, after) {
  const out = [];
  for (const f of CANONICAL_FIELDS) {
    if (JSON.stringify(before[f]) === JSON.stringify(after[f])) continue;
    const [a, b] = [sizeOf(before[f]), sizeOf(after[f])];
    out.push(a != null && b != null && a !== b ? `${FIELD_NAMES[f] || f} (${a} → ${b})` : FIELD_NAMES[f] || f);
  }
  return out;
}

/** The strip over the form: which published eval this started from, and whether it is still that eval. */
function syncOrigin(plan) {
  const box = $('origin');
  box.hidden = !openedFrom;
  if (!openedFrom) return;
  const changes = describeChanges(openedFrom.spec, plan.spec);
  const head = changes.length
    ? `<div class="origin-head"><div>Modified from <code>${esc(openedFrom.id)}</code></div><div class="hint">now eval <code class="now">${esc(plan.id)}</code></div></div>`
    : `<div class="origin-head"><div>Opened <code>${esc(openedFrom.id)}</code></div><div class="hint">unchanged</div></div>`;
  const note = changes.length
    ? `Changed: ${esc(changes.join(', '))}. Everything else is as it was published.`
    : 'Change the prompt, the models or the keywords and this becomes an eval of your own. Every run gets its own ID either way.';
  box.innerHTML = `${head}<div class="hint">${note}</div>`
    + (changes.length ? `<div class="origin-actions"><button id="btn-reset-origin" class="btn ghost small">Reset to ${esc(openedFrom.id)}</button></div>` : '');
  const reset = $('btn-reset-origin');
  if (reset) reset.addEventListener('click', async () => { writeSpec(openedFrom.spec); await refresh(); });
}

/**
 * Dim the steps below the first one that is not answered yet. Five dense blocks at full strength read as five
 * demands; this way the form asks for one thing at a time and the rest waits its turn. Hovering or tabbing into
 * a dimmed step brings it straight back, so nothing is ever hidden behind the dimming — it only sets priority.
 */
function syncStepFocus(plan) {
  const noValues = plan.problems.some((p) => p.startsWith('Variable {'));
  const done = [
    plan.spec.prompts.length > 0,
    !noValues,
    true, // a measure is always chosen; it recedes only because something above it is missing
    plan.spec.models.length > 0,
    plan.problems.length === 0,
  ];
  const first = done.indexOf(false);
  document.querySelectorAll('.step[data-step]').forEach((el, i) => {
    el.classList.toggle('pending', first !== -1 && i > first);
  });
}

async function refresh() {
  const spec = readSpec();
  const plan = await planRun(spec);
  planId = plan.id;
  shareLink = `${location.origin}${location.pathname}#spec=${b64.enc(spec)}`;
  problem(plan.problems.join('\n'));
  const variants = Object.values(plan.spec.variables).reduce((a, v) => a * v.length, 1);
  const n = (x, one, many = one + 's') => `${x} ${x === 1 ? one : many}`;
  const shape = `${n(plan.spec.prompts.length, 'prompt')} × ${n(variants, 'variant')} × ${n(plan.spec.models.length, 'model')} × ${n(plan.spec.runs, 'run')}`;
  let cost = '';
  if (modelList.length && plan.jobs.length) {
    const c = estimateCost(plan, modelList);
    cost = ` · est. <b>≈${formatUsd(c.typical)}</b> (up to ${formatUsd(c.high)} if every reply used its whole budget)`
      + (c.unknown.length ? ` · <span class="bad">not on OpenRouter: ${esc(c.unknown.join(', '))}</span>` : '')
      + balanceHtml(c.typical);
  }
  $('estimate').innerHTML = `<b>${plan.jobs.length}</b> requests · ${esc(shape)}${cost}`;
  syncStepFocus(plan);
  syncOrigin(plan);
  return plan;
}

// ---------- the responses table ----------
const tableSelect = () => $('resp-filter').querySelector('button.on')?.dataset.select || 'all';
const tableSearch = () => $('resp-search').value;
const tableRows = (run) => filterResponses(run, { select: tableSelect(), search: tableSearch() });

/**
 * Which model said it: the provider's mark and the model id, set in the same monospace the id is written in
 * everywhere else. The responses image tells its models apart by colour because it has no room to repeat the
 * name; the table has the name on every row, so colour there was decoration standing in for nothing.
 */
const modelCell = (id) => {
  const body = logoBody(id);
  const mark = body
    ? `<svg class="mark" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${body}</svg>`
    : `<span class="mark none" aria-hidden="true"></span>`;
  return `${mark}<span class="id">${esc(id.split('/').pop())}</span>`;
};

/** A reply as table HTML: what is marked sits on an amber block, the sheet's marker pen in CSS. */
const markHtml = (text, terms) => markSpans(text, terms).map((p) => (p.mark ? `<mark>${esc(p.text)}</mark>` : esc(p.text))).join('');

/** Scroll a clipped cell so the first marked word sits in the window, not above it. */
function revealMark(td) {
  const root = td.classList.contains('clip') ? (td.querySelector('.resp-preview') || td) : (td.querySelector('.resp-full') || td);
  const mark = root.querySelector('mark');
  if (!mark || !td.clientHeight) return;
  const delta = mark.getBoundingClientRect().top - td.getBoundingClientRect().top - td.clientHeight * 0.25;
  if (delta > 0) td.scrollTop += delta;
}

/** Why the table is empty, in the terms of whatever emptied it. */
function emptyNote(run, select, looking = []) {
  if (!run.results.length) return 'This run has no replies yet.';
  if (looking.length) return `No reply matched ${looking.map((t) => `“${t}”`).join(', ')}.`;
  if (select === 'refused') return 'No reply in this run was refused.';
  if (select === 'matched') return 'No reply in this run included the eval’s keywords. Marking words re-reads a run, it never re-scores one, so the words in the box above do not change this.';
  return 'Nothing to show.';
}

/**
 * The table under the card: every reply, whose model said it, and the text. It narrows and excerpts exactly the
 * way the responses image and the CLI printout do — one filter, one set of excerpt modes — and marks hits where
 * they fall, so which reply used a word, and in which sentence, is a question the page answers without leaving it.
 */
function renderResponses(run) {
  const select = tableSelect();
  const { terms: looking, invalid } = parseSearch(tableSearch());
  const terms = mergeTerms(pending, looking);
  const { rs } = tableRows(run);
  const table = $('responses');
  const tbody = table.querySelector('tbody');
  table.classList.toggle('searching', looking.length > 0);
  // The sentiment column is a number about the measure; on a refusal or keyword run it is a column of noise.
  table.classList.toggle('no-sentiment', run.spec?.primary !== 'sentiment');
  tbody.innerHTML = '';
  for (const r of rs) {
    const tr = document.createElement('tr');
    const o = outcomeOf(r);
    // An excerpt can come back empty — a reply with no match at all is a bare ellipsis — and an error that also
    // counted as a refusal has nothing else to show, so the row falls back to what came back.
    const fallback = r.error ? `ERROR: ${r.error}` : '(empty reply)';
    const full = shownText(r, 'full', terms) || fallback;
    // A search opens a window on the sentences that hit, so a long reply does not hide the word you typed.
    // Otherwise the row carries the whole reply, clipped to a few lines until it is clicked.
    const preview = (looking.length ? shownText(r, 'matches', looking) : full) || fallback;
    const body = preview === full
      ? markHtml(full, terms)
      : `<span class="resp-preview">${markHtml(preview, terms)}</span><span class="resp-full">${markHtml(full, terms)}</span>`;
    tr.innerHTML = `<td>${r.position + 1}</td><td class="model" title="${esc(r.model)}">${modelCell(r.model)}</td><td>${esc(r.variantLabel)}</td>`
      + `<td><span class="tag ${o}">${o}</span>${r.refused && r.refusal_reason ? `<div class="hint">${esc(r.refusal_reason)}</div>` : ''}</td>`
      + `<td title="${r.prompt_tokens || 0} prompt + ${r.tokens} reply${r.reasoning_tokens ? ` (${r.reasoning_tokens} thinking)` : ''}">${totalTokens(r)}</td>`
      + `<td class="sent">${r.sentiment >= 0 ? '+' : ''}${Number(r.sentiment).toFixed(2)}</td>`
      + `<td class="resp clip" title="click to expand">${body}</td>`;
    tr.querySelector('.resp').addEventListener('click', (e) => {
      const td = e.currentTarget;
      td.classList.toggle('clip');
      if (!td.classList.contains('clip')) revealMark(td);
    });
    tbody.appendChild(tr);
    revealMark(tr.querySelector('.resp'));
  }
  if (!rs.length) tbody.innerHTML = `<tr><td colspan="7" class="hint">${esc(emptyNote(run, select, looking))}</td></tr>`;
  const pool = looking.length ? filterResponses(run, { select }).rs.length : run.results.length;
  $('resp-count').textContent = rs.length === run.results.length ? `(${rs.length})` : `(${rs.length} of ${pool})`;
  ['btn-resp-json', 'btn-resp-csv'].forEach((id) => ($(id).disabled = !rs.length));
  renderFilters(run, select);
  renderSearchStatus(run, { looking, invalid, pool });
}

/**
 * Which replies the table lists, as three buttons carrying their own counts. This was a dropdown reading "every
 * reply", which sat beside the search box and so read as a description of the search rather than as a filter of
 * its own. Counts on the face of it answer the question the control was asking the reader to guess.
 */
function renderFilters(run, select) {
  const box = $('resp-filter');
  const n = (s) => filterResponses(run, { select: s }).rs.length;
  const scored = (run.spec?.keywords || []).length > 0;
  const opts = [['all', 'All'], ['refused', 'Refused'], ...(scored ? [['matched', 'Matched']] : [])];
  box.innerHTML = opts.map(([key, label]) =>
    `<button data-select="${key}" class="${key === select ? 'on' : ''}" title="${esc(RESPONSE_FILTERS[key])}">${label} <b>${n(key)}</b></button>`).join('');
  box.querySelectorAll('button[data-select]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.select === tableSelect()) return;
    box.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    renderResponses(run);
    $('responses').closest('.resp-frame').scrollTop = 0;
  }));
}

/** Hits in the listed replies, and whether what you searched for can still be added to what the images mark. */
function renderSearchStatus(run, { looking, invalid, pool }) {
  const status = $('resp-search-status');
  const add = $('btn-resp-highlight');
  const canAdd = mergeTerms(pending, looking).length > pending.length;
  add.disabled = !canAdd;
  add.textContent = looking.length && !canAdd ? 'Already highlighted' : 'Add to highlights';
  const bits = [];
  if (invalid.length) bits.push(`${invalid.map((t) => `“${t}”`).join(', ')} is not a valid pattern`);
  if (looking.length) {
    const counts = countKeywords(filterResponses(run, { select: tableSelect() }).rs.map(replyBody), looking);
    bits.push(counts.map((c) => (c.hits
      ? `“${c.keyword}” ${c.hits} hit${c.hits === 1 ? '' : 's'} in ${c.replies} of ${pool}`
      : `“${c.keyword}” none`)).join(' · '));
  }
  status.hidden = !bits.length;
  status.textContent = bits.join(' · ');
}

// ---------- marked words and the manual redraw ----------
/** The box, read and cleaned. */
const boxTerms = () => splitTerms($('highlight-terms').value).filter(isValidKeyword);
const sameTerms = (a, b) => a.length === b.length && a.every((t, i) => t === b[i]);

/** The box changed: mark the table now, and tell the button there is something to draw. */
function pendingChanged() {
  pending = boxTerms();
  if (currentRun) renderResponses(currentRun);
  syncRenderButton();
}

function syncRenderButton() {
  const btn = $('btn-render');
  const note = $('render-note');
  const dirty = !sameTerms(pending, marked);
  btn.disabled = !dirty || !currentRun;
  if (!currentRun) { note.textContent = ''; return; }
  const added = pending.filter((t) => !marked.includes(t)).length;
  const gone = marked.filter((t) => !pending.includes(t)).length;
  note.textContent = dirty
    ? `${[added && `${added} added`, gone && `${gone} removed`].filter(Boolean).join(', ')} — the replies below are marked already; press Render images to redraw the card and the sheet.`
    : marked.length ? `${marked.length} word${marked.length === 1 ? '' : 's'} marked on the images.` : 'No words marked yet. Search the replies below and add what you find.';
}

/** Commit the box to the images. The only thing in the page that redraws an SVG from a change of words. */
function renderMarked() {
  marked = pending.slice();
  rememberBatch(marked);
  if (!currentRun) return syncRenderButton();
  currentRun.highlight = marked; // saved with the run, so `llmscope sheet <id>` marks the same words
  drawn.clear();
  syncTabs();
  if (!marked.length && imageOf(view).when !== 'always') setView('card');
  else showActive(currentRun);
  syncRenderButton();
  store.saveRun(currentRun); // never rejects: a full quota is reported by the return value, not thrown
}

/** Put terms in the box without redrawing anything — used by "Add to highlights". */
function offerTerms(terms) {
  $('highlight-terms').value = terms.join(', ');
  pendingChanged();
}

// ---------- the card and its tabs ----------
// The tabs are the catalogue's rows, in its order: an image the CLI writes is an image the page offers, and one
// added there appears here without this file changing. The ends of every reply have no tab of their own — they
// are the Responses tab's *ends* excerpt — and download under their own name all the same.
$('tabs').innerHTML = IMAGES.filter((i) => i.tab).map((i) =>
  `<button id="tab-${i.kind}" class="${i.kind === view ? 'on' : ''}" disabled title="${esc(i.hint)}">${esc(i.tab)}</button>`).join('');
for (const i of IMAGES) if (i.tab) $(`tab-${i.kind}`).addEventListener('click', () => setView(i.kind));

/** The heading a titled image is drawn with: the keyword card remembers its own choice, the results card the other. */
const titleFor = (kind) => (kind === 'keywords' ? keywordView : resultsView(lastPainted?.spec?.primary ?? primary()));
const titleView = () => titleFor(view);

function setCardView(next) {
  if (view === 'keywords') { keywordView = next; store.setPref('keyword_view', next); }
  else { cardView = next; store.setPref('card_view', next); }
  syncCardView();
}

function syncCardView() {
  const on = titleView();
  document.querySelectorAll('#card-view button').forEach((b) => b.classList.toggle('on', b.dataset.view === on));
}

/** The right-hand panel is about a run, so before there is one it is not there at all. */
function showResults() {
  document.documentElement.dataset.hasResults = '';
}

function paint(run) {
  lastPainted = run;
  showResults();
  drawn.clear(); // new replies, or display names newly arrived: every image is drawn again as it is asked for
  // A streaming run repaints many times a second; the words someone typed mid-run survive all of them, and only
  // a genuinely different run resets the box.
  if (run.id !== paintedId) {
    paintedId = run.id;
    marked = cleanTerms(markedWords(run));
    pending = marked.slice();
    $('highlight-terms').value = pending.join(', ');
  }
  document.querySelector('.markbar').hidden = false;
  syncTabs();
  if (!marked.length && imageOf(view).when !== 'always') setView('card');
  ['btn-json', 'btn-share'].forEach((id) => ($(id).disabled = false));
  showActive(run);
  renderResponses(run);
  syncRenderButton();
}

/** Which tabs can be opened: every image a run writes on its own, and the ones about marked words once there are words. */
function syncTabs() {
  for (const i of IMAGES) if (i.tab) $(`tab-${i.kind}`).disabled = i.when !== 'always' && !marked.length;
}

/**
 * What the image on show is drawn with, from the page's state: display names once the catalogue is in, the
 * heading toggle where one applies, the marked words, and the Responses tab's excerpt. Everything else stays
 * at the defaults a run is drawn with — the CLI's flags are the CLI's.
 */
function drawOpts(kind) {
  return {
    names: Object.fromEntries(modelList.map((m) => [m.id, m.name])),
    title: imageOf(kind).titled ? titleFor(kind) : 'prompt',
    highlight: marked,
    excerpt: kind === 'responses' ? $('sheet-excerpt').value || 'full' : 'full',
  };
}

/**
 * Draw the image on show, or take it from the cache, and put it in the frame. An image with nothing to draw —
 * the sentences page when none of the marked words matched — says so where the picture would be, the way the
 * CLI refuses to draw headings over nothing, and offers nothing to download.
 */
function showActive(run) {
  const opts = drawOpts(view);
  const key = `${opts.title}|${opts.excerpt}|${marked.join(',')}`;
  if (drawn.get(view)?.key !== key) drawn.set(view, { key, ...drawImage(view, run, opts) });
  const { svg, empty } = drawn.get(view);
  const why = empty || 'nothing to draw';
  $('card').innerHTML = svg
    || `<div class="empty"><p>${esc(why[0].toUpperCase() + why.slice(1))}.</p><p>Search the replies below for a word that did turn up, add it to the highlighted words, and render again.</p></div>`;
  $('btn-svg').disabled = $('btn-png').disabled = !svg;
}

function setView(v) {
  view = v;
  for (const i of IMAGES) if (i.tab) $(`tab-${i.kind}`).classList.toggle('on', v === i.kind);
  $('sheet-excerpt').hidden = v !== 'responses';
  $('card-view').hidden = !imageOf(v).titled; // a sheet has no heading to choose
  syncCardView();
  if (currentRun) showActive(currentRun);
}

// ---------- downloads ----------
const activeSvg = () => drawn.get(view)?.svg || '';
/** The image on show as the catalogue knows it: the Responses tab's ends excerpt is the ends image, here as on disk. */
const activeKind = () => (view === 'responses' ? sheetKind({ select: 'all', excerpt: $('sheet-excerpt').value || 'full' }) : view);
const activeName = () => `llmscope-${shownId()}${imageOf(activeKind()).suffix}`;

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
    const buf = await fetch(`/fonts/${f.pkg.split('/').pop()}`).then((r) => r.arrayBuffer());
    // A face is three quarters of a megabyte, so it is encoded a block at a time: spreading the whole array
    // into String.fromCharCode passes one argument per byte and overflows the call stack.
    let bin = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return `@font-face{font-family:'${f.family}';font-weight:${f.weight};src:url(data:font/ttf;base64,${btoa(bin)}) format('truetype');}`;
  }));
  fontCss = faces.join('');
  return fontCss;
}

async function svgToPng(svg, size = 1600) {
  const withFonts = svg.replace('>', `><style>${await embeddedFontCss()}</style>`);
  const url = URL.createObjectURL(new Blob([withFonts], { type: 'image/svg+xml' }));
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
  const canvas = Object.assign(document.createElement('canvas'), { width: size, height: size });
  canvas.getContext('2d').drawImage(img, 0, 0, size, size);
  URL.revokeObjectURL(url);
  return new Promise((res) => canvas.toBlob(res, 'image/png'));
}

/** A button that says what it just did, then goes back to saying what it does. */
function flash(id, text) {
  const b = $(id);
  const was = b.textContent;
  b.textContent = text;
  setTimeout(() => { b.textContent = was; }, 1400);
}

// ---------- the key ----------
const keyValue = () => $('apikey').value.trim();

// The Continue button follows the box, whoever filled it. The markup ships it disabled for the empty box a
// stranger sees; a key put there by boot or by "Change key" has to enable it too, or a reader who walks
// landing → Start evaluating with a saved key finds their own key in the box and no way past it.
function fillKey(value) {
  $('apikey').value = value || '';
  $('btn-unlock').disabled = !keyValue();
}

function syncKeyBadge() {
  // The box first: a key entered without "remember" is a real key for this session even though nothing is
  // stored, and a badge that called it "no key" would be telling the reader their run is about to fail.
  const key = keyValue() || store.readKey();
  $('key-badge').innerHTML = key ? `key ${esc(maskKey(key))}` : '<span class="bad">no key</span>';
}

async function verifyKey() {
  const key = keyValue();
  const el = $('key-status');
  if (!key) { el.textContent = 'Paste a key first.'; return { ok: false }; }
  if (!key.startsWith('sk-or-')) { el.textContent = 'OpenRouter keys start with sk-or-'; return { ok: false }; }
  el.textContent = 'checking…';
  const [info, bal] = await Promise.all([checkKey({ apiKey: key }), fetchBalance({ apiKey: key })]);
  if (info.ok) balance = bal;
  el.innerHTML = info.ok
    ? `<span class="ok">valid</span>${info.label ? ` · ${esc(info.label)}` : ''} · used ${formatUsd(info.usage || 0)}${info.limit != null ? ` of ${formatUsd(info.limit)}` : ''}${bal.ok ? ` · ${balanceWords(bal)}` : ''}`
    : `<span class="bad">${esc(info.error)}</span>`;
  return info;
}

async function continueWithKey() {
  const btn = $('btn-unlock');
  btn.disabled = true;
  const info = await verifyKey();
  btn.disabled = !keyValue();
  if (!info.ok) { $('apikey').focus({ preventScroll: true }); return; }
  if ($('remember').checked) store.writeKey(keyValue()); else store.clearKey();
  syncKeyBadge();
  setStage('app');
  refresh(); // the estimate now knows the balance
  if (pendingEval) {
    const { run } = pendingEval;
    pendingEval = null;
    syncPending();
    await adoptResolved();
    if (run) return start('openrouter');
  }
  $('prompts').focus();
}

// ---------- runs ----------
async function start(kind) {
  await ready;
  const spec = readSpec();
  rememberBatch(spec.keywords);
  rememberModelSet(spec.models);
  const plan = await refresh();
  if (plan.problems.length) return;
  let provider;
  if (kind === 'mock') provider = createMockProvider({ latency: 120 });
  else {
    const apiKey = keyValue() || store.readKey();
    if (!apiKey) { problem('Connect an OpenRouter key to run. Press Change key above.'); return; }
    provider = createOpenRouterProvider({ apiKey, referer: location.origin, title: 'llmscope', models: modelList.length ? modelList : null });
  }
  abort = new AbortController();
  $('btn-run').disabled = true;
  $('btn-stop').hidden = false;
  // The run's own id, minted here so the partial painted mid-run and the finished run are one run to the page —
  // the words typed into the marking box while it streams survive the last repaint. It is not the eval's id:
  // running the same eval again is a new generation, saved beside the last one rather than over it.
  const id = await freshId(plan.id);
  const partial = { version: 'llmscope/0.1', id, spec_id: plan.id, spec: plan.spec, provider: provider.name, results: [] };
  // The page's run is this one from its first reply. The table, the marking box and Save results all read
  // `currentRun`, and until the run had finished they read the previous run while the card showed this one.
  currentRun = partial;
  paintedId = null; // a new run brings its own marked words
  $('bar').style.width = '0%';
  $('progress-text').textContent = 'starting…';
  let last = 0;
  try {
    currentRun = await runEval(spec, {
      provider, id, concurrency: 4, signal: abort.signal,
      onProgress: ({ done, total, result }) => {
        partial.results.push(result);
        $('bar').style.width = `${(done / total) * 100}%`;
        $('progress-text').textContent = `${done}/${total} · ${result.model.split('/').pop()} [${result.variantLabel}] ${outcomeOf(result)}`;
        const now = performance.now();
        if (now - last > 250 || done === total) { paint(partial); last = now; }
      },
    });
    if (partial.highlight) currentRun.highlight = partial.highlight; // words marked while it streamed stay marked
    paint(currentRun);
    const errors = currentRun.results.filter((r) => r.error).length;
    const doneLine = `${currentRun.results.length} responses · ${currentRun.aborted ? 'stopped' : 'done'} · ${provider.name}`
      + `${errors ? ` · ${errors} errors` : ''}${currentRun.cost?.priced ? ` · cost ${formatUsd(currentRun.cost.usd)}` : ''}`;
    $('progress-text').textContent = doneLine;
    await store.saveRun(currentRun);
    await renderRecent();
    if (provider.balance) {
      // What is left after this run, on the line that says what it cost; the estimate below picks it up too.
      const after = await loadBalance();
      if (after?.ok) $('progress-text').innerHTML = `${esc(doneLine)} · ${balanceWords(after)}${after.remaining < (currentRun.cost?.usd || 0) ? ` · <a href="${OPENROUTER_CREDITS_URL}" target="_blank" rel="noopener">add credits ↗</a>` : ''}`;
    }
  } catch (err) {
    problem(String(err.message || err));
  } finally {
    $('btn-run').disabled = false;
    $('btn-stop').hidden = true;
  }
}

/** Open a run this browser already has: the same path a fresh run takes, minus the requests. */
async function openRun(run, note) {
  rescoreRun(run);
  currentRun = run;
  paintedId = null;
  writeSpec(run.spec);
  await refresh();
  paint(run);
  $('progress-text').textContent = note;
}

// ---------- runs you have already done ----------
async function renderRecent() {
  const runs = await store.listRuns();
  // Older index rows stored the raw template, often then cut in the picker. Read the run so the line is the
  // same prompt the card titles, in full, even for rows saved before that.
  for (const e of runs) {
    const run = await store.loadRun(e.id);
    if (run) e.prompt = store.runPromptLine(run);
  }
  const sel = $('recent-runs');
  sel.hidden = !runs.length;
  sel.innerHTML = '<option value="">Reopen an earlier run…</option>'
    + runs.map((e) => `<option value="${esc(e.id)}">${esc(store.runPickerLabel(e))}</option>`).join('');
}

async function pickRun(id) {
  if (!id) return;
  const run = await store.loadRun(id);
  if (!run) return problem(`Run ${id} is no longer saved in this browser.`);
  openedFrom = null; // reopening your own run is not a fork of somebody's published one
  await openRun(run, `reopened ${id} · ${run.results.length} responses · ${run.provider}`);
}

// ======================================================================
// wiring
// ======================================================================
$('prompts').addEventListener('input', () => { renderVariables(); refresh(); });
for (const id of ['keywords', 'keyword_mode', 'runs']) $(id).addEventListener('input', () => refresh());
document.querySelectorAll('input[name=primary]').forEach((el) => el.addEventListener('change', () => { toggleMetricFields(); refresh(); }));
$('model-filter').addEventListener('input', renderModels);
$('model-all').addEventListener('click', () => {
  const all = visibleModels.every((m) => checked.has(m.id));
  for (const m of visibleModels) (all ? checked.delete(m.id) : checked.add(m.id));
  $('model-set').value = formatModels([...checked]);
  renderModels();
  refresh();
});
$('model-set').addEventListener('change', commitModelSetField);
$('model-set').addEventListener('blur', (e) => { if (!e.relatedTarget?.closest?.('#model-list')) commitModelSetField(); });

$('apikey').addEventListener('input', () => { fillKey($('apikey').value); $('key-status').textContent = ''; });
$('apikey').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); continueWithKey(); } });
$('btn-unlock').addEventListener('click', () => continueWithKey());
$('btn-change-key').addEventListener('click', () => { fillKey(store.readKey()); setStage('key'); });

$('btn-run-as-is').addEventListener('click', () => leaveResolved(true));
$('btn-change-first').addEventListener('click', () => leaveResolved(false));
$('btn-run').addEventListener('click', () => start('openrouter'));
$('btn-stop').addEventListener('click', () => abort?.abort());
$('btn-share').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(shareLink); flash('btn-share', 'Copied'); }
  catch (err) { problem(`Could not copy to the clipboard: ${err.message}`); }
});

document.querySelectorAll('#card-view button').forEach((b) => b.addEventListener('click', () => {
  setCardView(b.dataset.view);
  if (lastPainted) paint(lastPainted);
  refresh();
}));

$('btn-svg').addEventListener('click', () => download(`${activeName()}.svg`, new Blob([activeSvg()], { type: 'image/svg+xml' })));
$('btn-png').addEventListener('click', async () => download(`${activeName()}.png`, await svgToPng(activeSvg(), imageOf(activeKind()).size)));
$('btn-json').addEventListener('click', () => download(`llmscope-${shownId()}.results.json`, new Blob([JSON.stringify(currentRun, null, 2)], { type: 'application/json' })));

// "How much of each reply", the same three modes the CLI's rebuild menu offers.
$('sheet-excerpt').innerHTML = Object.entries(EXCERPTS).map(([value, text]) => `<option value="${value}">${esc(text)}</option>`).join('');
$('sheet-excerpt').addEventListener('change', () => { if (currentRun) showActive(currentRun); });

// The marked words. Typing marks the table; the button is what reaches the images.
$('highlight-terms').addEventListener('input', pendingChanged);
$('btn-render').addEventListener('click', renderMarked);

// Search is the table's main instrument: type a word or a /regex/ and it keeps only the replies that used it,
// with the hit in a framed window. The filter beside it narrows to refusals or to the replies the eval scored
// as matching, with the same three words the responses image uses, so a filter means the same thing in both.
// "How much of each reply" is a question only the image has to answer, because it has one fixed square to fit
// everything into; a table row clips itself and expands on a click.
$('resp-search').addEventListener('input', () => {
  if (!currentRun) return;
  renderResponses(currentRun);
  $('responses').closest('.resp-frame').scrollTop = 0;
});
$('btn-resp-highlight').addEventListener('click', () => {
  const { terms } = parseSearch(tableSearch());
  if (!terms.length) return;
  offerTerms(mergeTerms(pending, terms));
  flash('btn-resp-highlight', 'Added');
});
$('recent-runs').addEventListener('change', (e) => { pickRun(e.target.value); e.target.value = ''; });

// The two takeaway formats: JSON for a script, CSV for a spreadsheet. Both carry the listed replies in full,
// whatever the excerpt is showing — an excerpt is a reading aid, and a reply cut short in an export would
// quietly poison whatever is counted from it outside the tool.
const exportName = (select) => {
  const { terms } = parseSearch(tableSearch());
  const extra = [select === 'all' ? '' : select, terms.length ? 'search' : ''].filter(Boolean).join('.');
  return `llmscope-${shownId()}${extra ? '.' + extra : ''}`;
};
$('btn-resp-json').addEventListener('click', async () => {
  if (!currentRun) return;
  const { rs, filters } = tableRows(currentRun);
  try {
    await navigator.clipboard.writeText(JSON.stringify(toJson(currentRun, { rs, filters, select: tableSelect() }), null, 2));
    flash('btn-resp-json', `Copied ${rs.length}`);
  } catch (err) { problem(`Could not copy to the clipboard: ${err.message}`); }
});
$('btn-resp-csv').addEventListener('click', () => {
  if (!currentRun) return;
  download(`${exportName(tableSelect())}.csv`, new Blob([toCsv(currentRun, tableRows(currentRun).rs)], { type: 'text/csv' }));
});
$('load-results').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  closeOpener();
  try {
    const run = JSON.parse(await file.text());
    if (!Array.isArray(run.results) || !run.spec) throw new Error('not an llmscope results file');
    openedFrom = null; // a file from disk is not a fork of a published eval, any more than a reopened run is
    await openRun(run, `loaded ${file.name} · ${run.results.length} responses · ${run.provider}`);
    await store.saveRun(run);
    await renderRecent();
  } catch (err) { problem(`Could not load ${file.name}: ${err.message}`); }
  e.target.value = '';
});

// ======================================================================
// boot
// ======================================================================
// Everything above is wired before this point, so the stage buttons work while the fonts are still arriving.
const ready = (async () => {
  await textReady; // fonts and canvas measurement, before anything is laid out
  const saved = store.readKey();
  if (saved) { fillKey(saved); $('remember').checked = true; }
  syncKeyBadge();
  renderVariables();
  toggleMetricFields();
  renderBatches();
  renderModelSets();
  syncCardView();
  // An eval reaches the page two ways. A share link carries the whole spec in its hash, and the URL every card
  // prints in its footer names one by id at /e/<id>. The hash is asked first because it resolves on its own,
  // with nothing to look the id up against.
  const shared = parseEvalRef(location.hash)
    || (location.pathname.startsWith('/e/') ? parseEvalRef(location.pathname) : null);
  if (!shared) {
    const sets = store.modelSets();
    if (sets.length) { checked.clear(); for (const id of sets[0]) checked.add(id); }
  }
  renderModels();
  syncModelSetField();
  await renderRecent();
  syncRenderButton();
  const plan = await refresh();
  if (!shared) {
    const last = await store.latestRunFor(plan.id);
    if (last) await openRun(last, `restored ${last.id}, the last run of this eval`);
  }
  await loadModels();
  await loadBalance();
  // Last, so the cost on it is the real one rather than a dash the reader has to watch change.
  if (shared) await openEvalRef(shared, null);
})();
ready.catch(console.error);
