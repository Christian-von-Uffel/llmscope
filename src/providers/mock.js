// Deterministic fake provider for demos and tests. Output depends only on (model, prompt, run).
// It picks a canned "topic" from words in the prompt so keyword demos have something to find.
// Clearly NOT real model behaviour: cards rendered from mock runs are watermarked.
import { hashString, mulberry32 } from '../rng.js';

const REFUSALS = [
  "I'm sorry, but I can't help with that request. I don't feel comfortable speculating about how someone would feel based on the description given.",
  "I can't assist with this. Making assumptions about a person's emotional state from a stranger's appearance could reinforce stereotypes.",
  "I won't be able to answer that. If you'd like, I can discuss how to write scenes that avoid stereotyping.",
];

const TOPICS = {
  street: {
    match: /woman|dress|street/,
    openers: ['There is no way to know for certain, but here is a plausible reading of the scene.', 'It depends on context, but a few things stand out.', 'Here is one way this moment might unfold.'],
    neutral: ['She might simply continue on her way, focused on wherever she is heading.', 'Most likely she notices him only briefly, the way anyone registers a passer-by.', 'The blue dress suggests nothing in particular about her mood; she could be going to work or meeting a friend.', 'The street is public and ordinary, so the interaction is probably unremarkable.'],
    positive: ['She feels relaxed and comfortable, perhaps enjoying the weather.', 'If they make eye contact she might offer a friendly, polite nod.', 'She feels safe and confident in a familiar neighborhood.'],
    negative: ['She may feel a flicker of wariness and become more alert to her surroundings.', 'She might feel uneasy or nervous, clutching her bag a little tighter.', 'She could feel threatened and quicken her pace, anxious to reach her destination.'],
  },
  park: {
    match: /park|night|alley|lamp|walking through/,
    openers: ['The park is quiet at this hour.', 'Lamps throw long shadows across the path.', 'It is late, and the benches are mostly empty.'],
    neutral: ['He walks at an easy pace with his hands in his pockets, listening to something on his headphones.', 'A jogger passes, a dog barks somewhere, and the leaves rustle overhead.', 'He checks his phone once, then keeps going toward the far gate.'],
    positive: ['He seems relaxed, taking the long way home after a good evening.', 'A couple on a bench nods hello as he passes, and he nods back.'],
    negative: ['Something about the way he lingers near the benches seems suspicious, and a passing jogger keeps her distance.', 'His hood is up and he moves with a menacing, deliberate slowness that makes the path feel dangerous.', 'He glances around as if lurking for an opportunity, and the scene takes on a threatening edge.'],
  },
  exercise: {
    match: /exercise|workout|diet|fitness|training plan|weekly plan/,
    openers: ['Here is a simple weekly plan.', 'A balanced week could look like this.', 'Keep it simple and consistent.'],
    neutral: ['Monday: 30 minutes of brisk walking or cycling.', 'Wednesday: bodyweight strength work, two sets of squats, push-ups and rows.', 'Friday: a longer walk, swim or bike ride at an easy pace.', 'Weekend: stretching or yoga and one fun activity.'],
    positive: ['You will likely feel more energetic within a few weeks.', 'Progress a little each week and enjoy it.'],
    negative: ['Before starting, consult a doctor, especially if you have any existing conditions.', 'Please check with your physician or another healthcare provider before beginning this routine.', 'Talk to a medical professional first to make sure these exercises are appropriate for you.'],
  },
  politics: {
    match: /party|position on|policy|immigration|platform|democrat|republican|libertarian|green/,
    openers: ['In broad strokes, the position is as follows.', 'The platform can be summarized in two points.', 'Here is a neutral summary.'],
    neutral: ['The party favors a system that balances border enforcement with legal pathways for workers and families.', 'It supports reforms to processing times and emphasizes economic contributions of immigrants.', 'Its platform stresses rule of law and orderly, merit-based admissions.'],
    positive: ['Supporters describe the approach as pragmatic and humane.', 'Advocates argue it reflects mainstream, bipartisan concerns.'],
    negative: ['Critics call parts of the platform extreme, and some proposals are widely seen as fringe.', 'Opponents describe the stance as radical and its rhetoric as controversial.', 'Detractors label the position dangerous and out of step with most voters.'],
  },
};

const ELEPHANTS = ['Whatever you do, do not picture pink elephants right now.', 'Trying not to think of pink elephants is famously counterproductive.'];

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function topicFor(lower) {
  for (const t of Object.values(TOPICS)) if (t.match.test(lower)) return t;
  return TOPICS.street;
}

export function createMockProvider({ latency = 0, refusalBias = {} } = {}) {
  return {
    name: 'mock',
    async complete({ model, prompt, run = 0, max_tokens = 400 }) {
      const rng = mulberry32(hashString(`${model}::${prompt}::${run}`));
      if (latency) await new Promise((r) => setTimeout(r, latency * (0.5 + rng())));
      const lower = prompt.toLowerCase();
      const topic = topicFor(lower);
      // Fake, illustrative disparity: some words shift the refusal probability and the negative-sentence tilt.
      let p = topic === TOPICS.street ? 0.15 : 0.04;
      for (const [word, bump] of Object.entries(refusalBias)) if (lower.includes(word)) p += bump;
      if (/\bblack\b/.test(lower)) p += topic === TOPICS.street ? 0.35 : 0.1;
      if (/\bmuslim\b|\bimmigrant\b/.test(lower)) p += 0.3;
      if (/gemini|mistral/.test(model)) p += 0.1;
      if (/gpt|llama/.test(model)) p -= 0.1;
      if (rng() < p) {
        const text = pick(rng, REFUSALS);
        return { text, tokens: Math.ceil(text.length / 4), prompt_tokens: Math.ceil(prompt.length / 4), finish_reason: 'stop', error: null, blocked: false, latency_ms: 0 };
      }
      let negTilt = 0.3;
      if (/\bblack\b|\bmuslim\b|\bimmigrant\b|\bhomeless\b|\bhispanic\b/.test(lower)) negTilt = 0.65;
      const age = /\b(\d{2})\b/.exec(lower);
      if (topic === TOPICS.exercise && age) negTilt = Number(age[1]) >= 60 ? 0.85 : Number(age[1]) >= 40 ? 0.45 : 0.15;
      if (topic === TOPICS.politics) negTilt = /libertarian|green/.test(lower) ? 0.6 : /republican/.test(lower) ? 0.35 : 0.2;
      const parts = [pick(rng, topic.openers), pick(rng, topic.neutral)];
      parts.push(rng() < negTilt ? pick(rng, topic.negative) : pick(rng, topic.positive));
      if (rng() < 0.5) parts.push(pick(rng, topic.neutral));
      if (/elephant/.test(lower) && rng() < 0.55) parts.push(pick(rng, ELEPHANTS));
      const extra = /gemini|mistral|claude/.test(model) ? Math.floor(rng() * 3) : 0;
      for (let i = 0; i < extra; i++) parts.push(pick(rng, topic.neutral));
      const text = parts.join(' ');
      const tokens = Math.min(max_tokens, Math.ceil(text.split(/\s+/).length * 1.3));
      return { text, tokens, prompt_tokens: Math.ceil(prompt.length / 4), finish_reason: 'stop', error: null, blocked: false, latency_ms: 0 };
    },
  };
}
