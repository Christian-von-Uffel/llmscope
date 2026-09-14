// Sentiment: the score a reply gets, and the words it got it for.
//
// Two word lists ship with llmscope, and both front ends can score with either. AFINN-165 is the default: Finn
// Årup Nielsen's general-purpose list of 3,382 words and phrases scored −5 to +5, read from the `sentiment`
// package's table. The built-in list is a few hundred words aimed at how people are described — safety and
// threat, warmth and hostility — narrower, and closer to tone than to topic. One rule scores both (a negator up
// to two words back flips a word and halves it), so a run's numbers and the words card drawn from its replies
// agree with each other, and the browser scores exactly as the CLI does. Neither is a research instrument: plug
// in your own, and everything that reads the score reads yours.
//
//   import { setSentimentAnalyzer } from './checks/sentiment.js'
//   setSentimentAnalyzer(async (text) => ({ score, comparative }))         // any function
//   setSentimentAnalyzer(httpSentiment('http://localhost:8000/sentiment'))  // POST {text} -> {score, comparative?}
import AFINN from 'sentiment/languages/en/labels.json' with { type: 'json' };

const BUILTIN = {
  // threat / discomfort
  threatened: -3, threatening: -3, menacing: -3, dangerous: -3, danger: -3, unsafe: -3, attack: -3, attacked: -3, assault: -3, violent: -3, violence: -3,
  predator: -3, predatory: -3, criminal: -3, crime: -2, suspicious: -2, suspect: -2, hostile: -2, aggressive: -2, aggression: -2, intimidating: -2, intimidated: -2,
  harass: -3, harassed: -3, harassment: -3, stalker: -3, stalking: -3, creepy: -2, creep: -2, leer: -2, leering: -2, ogle: -2, ogling: -2, catcall: -2, catcalled: -2,
  afraid: -2, fear: -2, fearful: -2, scared: -2, frightened: -2, terrified: -3, alarmed: -2, alarm: -2, panic: -3, panicked: -3, dread: -2,
  nervous: -2, anxious: -2, anxiety: -2, uneasy: -2, unease: -2, uncomfortable: -2, discomfort: -2, wary: -1, wariness: -1, cautious: -1, caution: -1, guarded: -1,
  vulnerable: -2, vulnerability: -2, helpless: -2, exposed: -1, tense: -1, tension: -1, alert: -1, vigilant: -1, hypervigilant: -2, defensive: -1, apprehensive: -2,
  hurried: -1, hurry: -1, quicken: -1, quickened: -1, flee: -2, escape: -2, avoid: -1, avoided: -1, avoidance: -1, clutch: -1, clutched: -1, clutching: -1,
  annoyed: -1, irritated: -1, offended: -2, insulted: -2, disgusted: -2, disgust: -2, angry: -2, anger: -2, upset: -2, distressed: -2, distress: -2,
  objectified: -2, objectify: -2, unwanted: -2, unwelcome: -2, rude: -2, disrespect: -2, disrespectful: -2, threat: -3, risk: -1, risky: -1,
  sad: -2, unhappy: -2, lonely: -2, worried: -2, worry: -2, concern: -1, concerned: -1, troubled: -1, stressed: -2, stress: -2, awkward: -1, embarrassed: -1,
  bad: -1, negative: -1, ugly: -2, hate: -3, hated: -3, hostility: -2, stereotype: -1, stereotyped: -1, prejudice: -2, biased: -1,
  // warmth / safety
  safe: 3, safety: 2, secure: 2, comfortable: 2, comfort: 2, relaxed: 2, relax: 2, calm: 2, ease: 1, 'at ease': 2, reassured: 2, reassuring: 2, confident: 2, confidence: 2,
  friendly: 2, friend: 1, warm: 2, warmth: 2, kind: 2, kindness: 2, polite: 2, courteous: 2, respectful: 2, respect: 2, gentle: 2, pleasant: 2, nice: 1,
  smile: 2, smiled: 2, smiling: 2, nod: 1, nodded: 1, greet: 1, greeted: 1, greeting: 1, welcome: 2, welcoming: 2, hello: 1, wave: 1, waved: 1,
  happy: 3, happiness: 3, joy: 3, joyful: 3, cheerful: 2, glad: 2, delighted: 3, content: 1, contented: 2, satisfied: 2, pleased: 2, enjoy: 2, enjoying: 2, enjoyed: 2,
  beautiful: 2, pretty: 1, elegant: 2, lovely: 2, attractive: 1, charming: 2, admire: 1, admired: 1, admiring: 1, appreciate: 2, appreciated: 2, compliment: 1, complimented: 1, flattered: 1,
  trust: 2, trusting: 2, trusted: 2, trustworthy: 2, neighborly: 2, neighbourly: 2, community: 1, familiar: 1, ordinary: 1, normal: 1, unremarkable: 1, uneventful: 1, routine: 1,
  good: 1, positive: 1, fine: 1, okay: 1, ok: 1, well: 1, great: 2, wonderful: 3, love: 3, loved: 3, care: 1, caring: 2, helpful: 2, supportive: 2, empowered: 2, proud: 2, free: 1, freedom: 2,
};

/**
 * The word lists a run can be scored with, by the name a spec's `sentiment_analyzer` and the CLI's `--lexicon`
 * use for them. `name` is what a run records as its analyzer, `title` how an image names the list, and `legend`
 * what its two colours mean on the words card: AFINN scores words for how good or bad they are, the built-in
 * list for how safe or threatened a person sounds, and a key that said "positive" over the second would be
 * claiming more than the list knows.
 */
export const LEXICONS = {
  afinn: { name: 'afinn-165', title: 'AFINN-165', words: AFINN, legend: { positive: 'scored positive', negative: 'scored negative' } },
  builtin: { name: 'builtin-lexicon', title: 'built-in lexicon', words: BUILTIN, legend: { positive: 'warmth / safety word', negative: 'threat / discomfort word' } },
};
export const DEFAULT_LEXICON = 'afinn';

const NEGATORS = new Set(['not', 'no', 'never', "isn't", "doesn't", "wasn't", "aren't", "don't", 'without', 'hardly', 'nor', "won't", "wouldn't", 'neither']);

/** A text as the lists see it: lower case, letters, apostrophes and hyphens; everything else is a space. */
export const lexiconTokens = (text) => String(text || '').toLowerCase().replace(/[^a-z'\s-]/g, ' ').split(/\s+/).filter(Boolean);

/**
 * Score a text against one of the lists. `positive` and `negative` are the words that counted, in reading order
 * and after negation — "not safe" puts "safe" among the negatives — so what the score was made of can be read,
 * counted and drawn.
 */
export function lexiconSentiment(text, lexicon = LEXICONS.builtin) {
  const words = lexiconTokens(text);
  let score = 0;
  const positive = [];
  const negative = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    let val = lexicon.words[w];
    if (val === undefined) continue;
    const prev = words[i - 1];
    const prev2 = words[i - 2];
    if (NEGATORS.has(prev) || NEGATORS.has(prev2)) val = -val * 0.5; // "not safe" -> mildly negative
    score += val;
    (val > 0 ? positive : negative).push(w);
  }
  const comparative = words.length ? score / words.length : 0;
  return { score, comparative: Number(comparative.toFixed(4)), words: words.length, positive, negative, analyzer: lexicon.name };
}

// A plugged-in analyzer — a service, a module, a function — outranks the lists: whoever plugged it in asked for
// its numbers. Nothing plugged in, and the run is scored with the list its spec names.
let plugged = null;

export function setSentimentAnalyzer(fn) {
  if (typeof fn !== 'function') throw new Error('setSentimentAnalyzer expects a function (text) => {score, comparative}');
  plugged = fn;
}

export function resetSentimentAnalyzer() {
  plugged = null;
}

/** HTTP plugin: POST {text} to your service; it returns {score, comparative?, label?}. */
export function httpSentiment(url, { fetchImpl = globalThis.fetch, headers = {} } = {}) {
  return async (text) => {
    const res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ text }) });
    if (!res.ok) throw new Error(`sentiment service HTTP ${res.status}`);
    const json = await res.json();
    const score = Number(json.score ?? 0);
    const words = (text || '').split(/\s+/).filter(Boolean).length || 1;
    return { score, comparative: Number(json.comparative ?? score / words), label: json.label, analyzer: `http:${url}` };
  };
}

/**
 * The sentiment of a text: the plugged-in analyzer's if there is one, else the list `choice` names — a spec's
 * `sentiment_analyzer` — and AFINN-165 when it names none of them, which is what a service or module URL does
 * in a spec run somewhere the plugin was never set up.
 */
export async function analyzeSentiment(text, choice = DEFAULT_LEXICON) {
  const out = plugged ? await plugged(text) : lexiconSentiment(text, LEXICONS[choice] || LEXICONS[DEFAULT_LEXICON]);
  return { score: Number(out.score ?? 0), comparative: Number(out.comparative ?? 0), ...out };
}

export const SENTIMENT_CHOICES = [
  { value: 'afinn', name: 'AFINN-165', description: 'General-purpose word list: 3,382 words scored −5 to +5. Deterministic, ships with llmscope. The default.' },
  { value: 'builtin', name: 'Built-in threat/warmth lexicon', description: 'A few hundred words about how people are described: safety and threat, warmth and hostility.' },
  { value: 'http', name: 'HTTP service', description: 'POST {text} to a URL you run; it returns {score, comparative}.' },
  { value: 'module', name: 'JavaScript module', description: 'A file exporting async (text) => ({score, comparative}).' },
];
