import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runEval } from '../src/engine.js';
import { analyze } from '../src/analyze.js';
import { renderCard, fitTitleBlock, clamp, TITLE } from '../src/render.js';
import { createMockProvider } from '../src/providers/mock.js';

const models = ['openai/gpt-5.2', 'google/gemini-3-pro', 'mistralai/mistral-large-3', 'meta-llama/llama-4-70b-instruct', 'anthropic/claude-opus-4.5', 'qwen/qwen3-72b-instruct'];
const filler = (n) => Array.from({ length: n }, (_, i) => `context sentence number ${i + 1} that adds detail to the scene.`).join(' ');
const titleSizes = (svg) => [...svg.matchAll(/<text x="56" y="[\d.]+" font-family="[^"]+" font-size="(\d+)" font-weight="700" fill="#f3f4f6">/g)].map((m) => Number(m[1]));

async function card(prompt) {
  const run = await runEval({ prompts: [prompt], variables: { race: ['black', 'white'] }, models }, { provider: createMockProvider() });
  return renderCard(analyze(run));
}

test('clamp and fitTitleBlock basics', () => {
  assert.equal(clamp(0, 5, 3), 3);
  assert.equal(clamp(0, -1, 3), 0);
  const short = fitTitleBlock('“Hello world”', 1480, { maxHeight: 400 });
  assert.equal(short.size, TITLE.maxSize);
  const long = fitTitleBlock('“' + filler(20) + '”', 1480, { maxHeight: 400 });
  assert.ok(long.size < TITLE.maxSize && long.size >= TITLE.minSize && !long.overflow);
});

test('short prompt renders at max size', async () => {
  const svg = await card('A {race} man waves. How does she feel?');
  const sizes = titleSizes(svg);
  assert.ok(sizes.length >= 1);
  assert.equal(sizes[0], TITLE.maxSize);
});

test('a 700-char prompt is shown in full at a smaller size, no ellipsis', async () => {
  const prompt = `A {race} man is walking down the street and spots a woman wearing a blue dress. ${filler(10)} How does the woman feel in this situation?`;
  assert.ok(prompt.length > 650);
  const svg = await card(prompt);
  const sizes = titleSizes(svg);
  assert.ok(!svg.includes('…'), 'no truncation');
  assert.ok(svg.includes('situation?”'), 'last word present');
  assert.ok(sizes[0] < TITLE.maxSize && sizes[0] >= TITLE.minSize, `size ${sizes[0]}`);
});

test('a 2400-char prompt borrows grid height and still shows every word', async () => {
  const prompt = `A {race} man walks by. ${filler(40)} How does she feel?`;
  assert.ok(prompt.length > 2300);
  const svg = await card(prompt);
  assert.ok(!svg.includes('…'));
  assert.ok(svg.includes('feel?”'), 'last word present');
  const size = titleSizes(svg)[0];
  assert.ok(size >= TITLE.floorSize && size <= TITLE.minSize, `size ${size}`);
});

test('an absurd 18000-char prompt renders without throwing and ellipsizes as a last resort', async () => {
  const svg = await card(`A {race} man. ${filler(300)} End.`);
  assert.ok(svg.startsWith('<svg') && svg.endsWith('</svg>'));
  assert.ok(svg.includes('…'));
  assert.equal(titleSizes(svg)[0], TITLE.floorSize);
});

test('a variable slot that wraps across two title lines stays highlighted on both', async () => {
  const run = await runEval({ prompts: ['Summarize the {party} Party position on immigration in two sentences.'], variables: { party: ['Democratic', 'Republican', 'Libertarian', 'Green'] }, models: models.slice(0, 3) }, { provider: createMockProvider() });
  const svg = renderCard(analyze(run));
  const title = svg.slice(0, svg.indexOf('<rect x="56"'));
  const accents = title.match(/<tspan fill="#ffd166">[^<]*<\/tspan>/g) || [];
  assert.ok(accents.length >= 2, `expected the slot on two lines, got ${accents.length}`);
  assert.ok(accents.some((t) => t.includes('{Democratic')) && accents.some((t) => t.includes('Green}')));
  assert.ok(!title.includes('<tspan fill="#ffd166"> Party'), 'text after the slot is not highlighted');
});
