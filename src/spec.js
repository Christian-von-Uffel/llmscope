// Eval spec: normalize, expand variables into variants, canonicalize, ID, build jobs.
import { shortId } from './id.js';

const PRIMARY_METRICS = ['refusal', 'keyword', 'sentiment'];
// Reasoning effort sent with every request. 'default' sends nothing: the model thinks as it ships.
export const REASONING_EFFORTS = ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

const DEFAULTS = Object.freeze({
  prompts: [],
  system: '',
  variables: {},
  models: [],
  runs: 1,
  temperature: 0,
  max_tokens: 400,
  thinking_budget: 8000, // tokens added on top of max_tokens for models that think by default, so thinking cannot starve the reply
  reasoning: 'default', // see REASONING_EFFORTS
  primary: 'refusal',
  keywords: [],
  keyword_mode: 'any', // any | all
  disparity_threshold: null, // null => 0.25 for rates, 0.3 for sentiment
  seed: null,
  // analysis / presentation only (not part of the ID). Card wording is fixed on purpose so images are comparable.
  sentiment_analyzer: 'afinn', // afinn | builtin | http(s)://url | ./module.js — see checks/sentiment.js
  card_title: null, // null: whatever the default heading is (see defaultCardTitle) · finding: the sentence · prompt: the prompts
  share_base: 'llmscope.dev/e/',
});

// Fields that change what the eval actually does. Everything else is presentation.
export const CANONICAL_FIELDS = [
  'prompts', 'system', 'variables', 'models', 'runs', 'temperature',
  'max_tokens', 'thinking_budget', 'reasoning', 'primary', 'keywords', 'keyword_mode', 'seed',
];

// Every {…} in a prompt is a slot, named in whatever words you think in: {race}, {environmental concern},
// {2020}, {the "safe" framing}. A bar makes it an inline group that fills itself: {black|white}. Surrounding
// whitespace is not part of a name, so {race} and { race } are one slot. To send a literal brace, double it:
// {{ and }} reach the model as { and }.
const TOKEN_RE = /\{\{|\}\}|\{[^{}]*\}/g;

/**
 * What one {…} token is: an escaped brace, an inline group, a named slot, or empty braces that name nothing.
 * @returns {{kind:'escape'|'inline'|'slot'|'empty', text?:string, values?:string[], name?:string}}
 */
function braceToken(token) {
  if (token === '{{' || token === '}}') return { kind: 'escape', text: token[0] };
  const inner = token.slice(1, -1).trim();
  if (!inner) return { kind: 'empty' };
  if (inner.includes('|')) return { kind: 'inline', values: inner.split('|').map((s) => s.trim()) };
  return { kind: 'slot', name: inner };
}

/** A brace group the eval fills in. `{{`, `}}` and `{}` are not. */
export function isSlotToken(token) {
  const kind = braceToken(token).kind;
  return kind === 'slot' || kind === 'inline';
}

/** Brace groups naming nothing — `{}` — which the model would be asked for as written. */
export function strayBraces(prompts) {
  const stray = new Set();
  for (const p of [].concat(prompts || [])) {
    for (const m of String(p).matchAll(TOKEN_RE)) if (braceToken(m[0]).kind === 'empty') stray.add(m[0]);
  }
  return [...stray];
}

function asList(v) {
  if (Array.isArray(v)) return v.map((s) => String(s).trim());
  if (typeof v === 'string') return v.split(/\r?\n|,/).map((s) => s.trim()).filter(Boolean);
  return [];
}

/**
 * Convert inline {a|b} groups into named variables so batch prompts can share them.
 * Identical inline groups across prompts map to the same variable name.
 */
export function liftInlineVariants(prompts, variables) {
  const vars = { ...variables };
  const seen = new Map(); // "black|white" -> name
  const taken = new Set(Object.keys(vars)); // never reuse a name a slot already answers to
  let counter = 0;
  const out = prompts.map((p) =>
    p.replace(TOKEN_RE, (tok) => {
      const t = braceToken(tok);
      if (t.kind !== 'inline') return tok; // an escaped brace or a named slot is left exactly as written
      const key = t.values.join('|');
      let name = seen.get(key);
      if (!name) {
        do { counter += 1; name = `v${counter}`; } while (taken.has(name));
        taken.add(name);
        seen.set(key, name);
        vars[name] = [...t.values];
      }
      return `{${name}}`;
    }),
  );
  return { prompts: out, variables: vars };
}

export function normalizeSpec(input = {}) {
  const { title, labels, ...rest } = input || {}; // legacy fields, ignored: card wording is standardized
  const spec = { ...DEFAULTS, ...rest };
  spec.prompts = asList(spec.prompts).filter(Boolean);
  spec.models = asList(spec.models).filter(Boolean);
  spec.keywords = asList(spec.keywords).filter(Boolean);
  const variables = {};
  for (const [name, values] of Object.entries(spec.variables || {})) {
    const list = Array.isArray(values) ? values.map((s) => String(s).trim()) : asList(values);
    if (list.length) variables[name] = list;
  }
  const lifted = liftInlineVariants(spec.prompts, variables);
  spec.prompts = lifted.prompts;
  spec.variables = lifted.variables;
  spec.runs = Math.max(1, Math.floor(Number(spec.runs) || 1));
  spec.temperature = Number(spec.temperature) || 0;
  spec.max_tokens = Math.max(1, Math.floor(Number(spec.max_tokens) || DEFAULTS.max_tokens));
  spec.thinking_budget = Number.isFinite(Number(spec.thinking_budget)) && spec.thinking_budget !== '' && spec.thinking_budget !== null ? Math.max(0, Math.floor(Number(spec.thinking_budget))) : DEFAULTS.thinking_budget;
  spec.reasoning = REASONING_EFFORTS.includes(spec.reasoning) ? spec.reasoning : DEFAULTS.reasoning;
  spec.primary = PRIMARY_METRICS.includes(spec.primary) ? spec.primary : 'refusal';
  spec.keyword_mode = spec.keyword_mode === 'all' ? 'all' : 'any';
  spec.system = String(spec.system || '');
  if (spec.seed === '' || spec.seed === undefined) spec.seed = null;
  // Left null unless the eval names one, rather than stamped with today's default: a saved eval that froze the
  // default would keep showing an old heading after the default moved, and nobody chose that heading. Readers of
  // this field resolve null through defaultCardTitle.
  spec.card_title = CARD_TITLES.includes(spec.card_title) ? spec.card_title : null;
  if (spec.disparity_threshold === '' || spec.disparity_threshold === undefined) spec.disparity_threshold = null;
  if (spec.disparity_threshold !== null) spec.disparity_threshold = Number(spec.disparity_threshold);
  return spec;
}

const CARD_TITLES = ['finding', 'prompt'];

/**
 * Which heading a card leads with when the eval does not say: the prompt, whatever was measured. A reader who has
 * not been shown the question cannot judge whether the numbers under it mean anything, and the ask is the part a
 * reader who came for the data wants first. Leading with it states no conclusion and leaves the grid to say what
 * came back. The generated sentence is one flag away — `--title finding`, or the Finding button over the preview —
 * for when the result rather than the ask is the point of the image.
 *
 * The metric is still taken, so a future card can lead with its own default without changing every caller.
 *
 * Presentation only: `card_title` is not a canonical field, so this never moves an eval's id.
 */
export const defaultCardTitle = (primary) => 'prompt';

export function validateSpec(spec) {
  const problems = [];
  if (!spec.prompts.length) problems.push('Add at least one prompt.');
  if (!spec.models.length) problems.push('Add at least one model.');
  // A keyword eval with no words is the exploratory case: collect the replies first, read them, then decide which
  // words are worth marking. Scoring nothing is a real answer to "I do not know yet what I am looking for", so it
  // is allowed — the empty run says so on its own card rather than being refused up front.
  const used = usedVariables(spec.prompts);
  for (const name of used) if (!spec.variables[name]) problems.push(`Variable {${name}} is used but has no values.`);
  for (const name of Object.keys(spec.variables)) if (!used.has(name)) problems.push(`Variable {${name}} is defined but not used in any prompt.`);
  return problems;
}

export function usedVariables(prompts) {
  const used = new Set();
  for (const p of prompts) {
    for (const m of String(p).matchAll(TOKEN_RE)) {
      const t = braceToken(m[0]);
      if (t.kind === 'slot') used.add(t.name);
    }
  }
  return used;
}

/** Cartesian product of variable values -> [{race:'black'}, {race:'white'}] */
export function variantCombos(variables) {
  const names = Object.keys(variables);
  if (!names.length) return [{}];
  let combos = [{}];
  for (const name of names) {
    const next = [];
    for (const c of combos) for (const v of variables[name]) next.push({ ...c, [name]: v });
    combos = next;
  }
  return combos;
}

export function comboKey(combo) {
  return Object.keys(combo).sort().map((k) => `${k}=${combo[k]}`).join('&') || '(none)';
}

export function comboLabel(combo) {
  const vals = Object.values(combo).map((v) => (v === '' ? '(none)' : v));
  return vals.length ? vals.join(' / ') : '—';
}

export function fillTemplate(template, combo) {
  return template
    .replace(TOKEN_RE, (tok) => {
      const t = braceToken(tok);
      if (t.kind === 'escape') return t.text; // {{ and }} were how the prompt asked for a literal brace
      return t.kind === 'slot' && t.name in combo ? combo[t.name] : tok;
    })
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ ([,.;:!?])/g, '$1')
    .trim();
}

function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function canonicalSpec(spec) {
  const s = normalizeSpec(spec);
  const picked = {};
  for (const f of CANONICAL_FIELDS) picked[f] = s[f];
  // Model order does not change the eval; sort so reordering yields the same ID.
  picked.models = [...picked.models].sort();
  return stableStringify(picked);
}

export async function specId(spec) {
  return shortId(canonicalSpec(spec));
}

/** Flat list of every request the eval will make (before shuffling). */
export function buildJobs(spec) {
  const combos = variantCombos(spec.variables);
  const jobs = [];
  spec.prompts.forEach((template, promptIndex) => {
    combos.forEach((combo, variantIndex) => {
      const prompt = fillTemplate(template, combo);
      spec.models.forEach((model) => {
        for (let run = 0; run < spec.runs; run++) {
          jobs.push({ promptIndex, template, prompt, variantIndex, combo, variantKey: comboKey(combo), variantLabel: comboLabel(combo), model, run });
        }
      });
    });
  });
  return jobs;
}

/** Human-readable template with the variable slot expanded, for the card title. */
export function displayTemplate(template, variables) {
  return template.replace(TOKEN_RE, (tok) => {
    const t = braceToken(tok);
    if (t.kind === 'escape') return t.text;
    if (t.kind !== 'slot' || !variables[t.name]) return tok;
    return `{${variables[t.name].map((v) => (v === '' ? '(none)' : v)).join(' | ')}}`;
  });
}
