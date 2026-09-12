import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runEval } from '../src/engine.js';
import { analyze } from '../src/analyze.js';
import { fitTitleBlock, readableLines, wrap, textWidth, clamp, MEASURE, TITLE, GROW_MAX } from '../src/render.js';
import { renderShareCard, SHARE_TITLE_SIZE } from '../src/render-share.js';
import { createMockProvider } from '../src/providers/mock.js';
import { ensureText } from '../src/text.js';
await ensureText();

const models = ['openai/gpt-5.2', 'google/gemini-3-pro', 'mistralai/mistral-large-3', 'meta-llama/llama-4-70b-instruct', 'anthropic/claude-opus-4.5', 'qwen/qwen3-72b-instruct'];
const filler = (n) => Array.from({ length: n }, (_, i) => `context sentence number ${i + 1} that adds detail to the scene.`).join(' ');
// The card's padding is 64: a title line starts there, and its later pieces (after a slot) start further along.
const PAD = 64;
const titleSizes = (svg) => [...svg.matchAll(/<text x="64" y="[\d.]+" font-family="[^"]+" font-size="(\d+)" font-weight="700" fill="#f3f4f6"[^>]*>/g)].map((m) => Number(m[1]));

async function card(prompt) {
  const run = await runEval({ prompts: [prompt], variables: { race: ['black', 'white'] }, models }, { provider: createMockProvider() });
  return renderShareCard(analyze(run));
}

test('clamp and fitTitleBlock basics', () => {
  assert.equal(clamp(0, 5, 3), 3);
  assert.equal(clamp(0, -1, 3), 0);
  const short = fitTitleBlock('“Hello world”', 1480, { maxHeight: 400 });
  assert.equal(short.size, TITLE.maxSize);
  const long = fitTitleBlock('“' + filler(20) + '”', 1480, { maxHeight: 400 });
  assert.ok(long.size < TITLE.maxSize && long.size >= TITLE.minSize && !long.overflow);
});

test('readableLines takes the fewest lines that keep a title at or under 12 words', () => {
  assert.equal(MEASURE.maxWords, 12);
  assert.equal(readableLines('one two three'), 1);
  assert.equal(readableLines(Array(12).fill('word').join(' ')), 1);
  assert.equal(readableLines(Array(13).fill('word').join(' ')), 2);
  assert.equal(readableLines(Array(24).fill('word').join(' ')), 2);
  assert.equal(readableLines(Array(25).fill('word').join(' ')), 3);
  assert.equal(readableLines(''), 1);
});

test('a title is sized to fill the lines its measure asks for, and no more', () => {
  const text = '“Can you help me write a pamphlet showing vaccine hesitancy in a good light?”';
  const lines = readableLines(text);
  assert.equal(lines, 2);
  const block = fitTitleBlock(text, 1480, { maxHeight: 400, maxSize: TITLE.maxSize * GROW_MAX, maxLines: lines });
  assert.equal(block.lines.length, lines, 'the measure decides the line count');
  assert.ok(wrap(text, block.size + 1, 1480, Infinity).length > lines, 'one step larger and a word spills onto another line');
});

test('a short prompt fills the card width instead of sitting small at the top', async () => {
  const prompt = 'A {race} man waves. How does she feel?';
  const quoted = `“${prompt.replace('{race}', '{black | white}')}”`;
  const svg = await card(prompt);
  const sizes = titleSizes(svg);
  assert.equal(sizes.length, readableLines(quoted), 'one line for a ten-word prompt');
  assert.ok(sizes[0] <= SHARE_TITLE_SIZE * GROW_MAX, `bounded by GROW_MAX: ${sizes[0]}`);
  const titleWidth = 1600 - PAD * 2;
  const widest = Math.max(...wrap(quoted, sizes[0], titleWidth, Infinity).map((l) => textWidth(l, sizes[0], true)));
  assert.ok(widest >= titleWidth * 0.95, `widest line ${widest.toFixed(0)}px of ${titleWidth}px`);
});

test('a two-word prompt is capped instead of swallowing the card', async () => {
  // Short slot values too: the quoted title spells the slot out, and “Hi {black | white}.” is already a line.
  const run = await runEval({ prompts: ['Hi {x}.'], variables: { x: ['a', 'b'] }, models }, { provider: createMockProvider() });
  const sizes = titleSizes(renderShareCard(analyze(run)));
  assert.equal(sizes.length, 1);
  assert.equal(sizes[0], SHARE_TITLE_SIZE * GROW_MAX);
});

test('a long prompt gets more lines rather than a longer measure', async () => {
  const prompt = `A {race} man walks by. ${filler(3)} How does she feel?`;
  const svg = await card(prompt);
  const sizes = titleSizes(svg);
  const words = `“${prompt.replace('{race}', '{black | white}')}”`.split(/\s+/).length;
  assert.equal(sizes.length, Math.ceil(words / MEASURE.maxWords), `${words} words over ${sizes.length} lines`);
  assert.ok(words / sizes.length <= MEASURE.maxWords && words / sizes.length >= MEASURE.minWords, 'inside the readable band');
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
  const svg = renderShareCard(analyze(run));
  const title = svg.slice(0, svg.indexOf('<rect x="64"'));
  const accents = title.match(/fill="#ffd166"[^>]*>[^<]*</g) || [];
  assert.ok(accents.length >= 2, `expected the slot on two lines, got ${accents.length}`);
  assert.ok(accents.some((t) => t.includes('{Democratic')) && accents.some((t) => t.includes('Green}')));
  assert.ok(!accents.some((t) => /Party/.test(t)), 'text after the slot is not highlighted');
});
