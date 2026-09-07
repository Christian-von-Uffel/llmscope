// Eval spec: normalize, expand variables into variants, canonicalize, ID, build jobs.
import { shortId } from './id.js';

export const PRIMARY_METRICS = ['refusal', 'keyword', 'sentiment'];

export const DEFAULTS = Object.freeze({
  title: 'Identity swap',
  prompts: [],
  system: '',
  variables: {},
  models: [],
  runs: 1,
  temperature: 0,
  max_tokens: 400,
  primary: 'refusal',
  keywords: [],
  keyword_mode: 'any', // any | all
  disparity_threshold: null, // null => 0.25 for rates, 0.3 for sentiment
  seed: null,
  // presentation only (not part of the ID)
  labels: null, // { pass, fail } legend overrides
  share_base: 'llmscope.dev/e/',
});

// Fields that change what the eval actually does. Everything else is presentation.
export const CANONICAL_FIELDS = [
  'prompts', 'system', 'variables', 'models', 'runs', 'temperature',
  'max_tokens', 'primary', 'keywords', 'keyword_mode', 'seed',
];

const INLINE_RE = /\{([^{}|]*\|[^{}]*)\}/g; // {black|white}
const VAR_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g; // {race}

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
  let counter = Object.keys(vars).filter((k) => /^v\d+$/.test(k)).length;
  const out = prompts.map((p) =>
    p.replace(INLINE_RE, (_, body) => {
      const key = body.split('|').map((s) => s.trim()).join('|');
      let name = seen.get(key);
      if (!name) {
        counter += 1;
        name = `v${counter}`;
        seen.set(key, name);
        vars[name] = key.split('|');
      }
      return `{${name}}`;
    }),
  );
  return { prompts: out, variables: vars };
}

export function normalizeSpec(input = {}) {
  const spec = { ...DEFAULTS, ...input };
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
  spec.primary = PRIMARY_METRICS.includes(spec.primary) ? spec.primary : 'refusal';
  spec.keyword_mode = spec.keyword_mode === 'all' ? 'all' : 'any';
  spec.system = String(spec.system || '');
  spec.title = String(spec.title || DEFAULTS.title).trim() || DEFAULTS.title;
  if (spec.seed === '' || spec.seed === undefined) spec.seed = null;
  if (spec.disparity_threshold === '' || spec.disparity_threshold === undefined) spec.disparity_threshold = null;
  if (spec.disparity_threshold !== null) spec.disparity_threshold = Number(spec.disparity_threshold);
  return spec;
}

export function validateSpec(spec) {
  const problems = [];
  if (!spec.prompts.length) problems.push('Add at least one prompt.');
  if (!spec.models.length) problems.push('Add at least one model.');
  if (spec.primary === 'keyword' && !spec.keywords.length) problems.push('Keyword metric needs at least one keyword.');
  const used = usedVariables(spec.prompts);
  for (const name of used) if (!spec.variables[name]) problems.push(`Variable {${name}} is used but has no values.`);
  for (const name of Object.keys(spec.variables)) if (!used.has(name)) problems.push(`Variable {${name}} is defined but not used in any prompt.`);
  return problems;
}

export function usedVariables(prompts) {
  const used = new Set();
  for (const p of prompts) for (const m of p.matchAll(VAR_RE)) used.add(m[1]);
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
    .replace(VAR_RE, (m, name) => (name in combo ? combo[name] : m))
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ ([,.;:!?])/g, '$1')
    .trim();
}

export function stableStringify(value) {
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
  return template.replace(VAR_RE, (m, name) => (variables[name] ? `{${variables[name].map((v) => (v === '' ? '(none)' : v)).join(' | ')}}` : m));
}
