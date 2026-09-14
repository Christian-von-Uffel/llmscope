import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulate, contrast, deltaEOK, worstContrast, closestPair, oklab, VISION } from '../src/a11y.js';
import { COLORS } from '../src/analyze.js';
import { MARK_BG, MARK_TEXT, BADGES } from '../src/sheet.js';
import { modelColors, modelPalette } from '../src/palette.js';
import { ensureText } from '../src/text.js';
await ensureText();

test('the simulation is the standard transform: normal is identity, grayscale is achromatic, red and green collapse for a deuteranope', () => {
  assert.equal(simulate('#ffd166', 'normal'), '#ffd166');
  const gray = simulate('#c11f1f', 'grayscale');
  assert.equal(gray.slice(1, 3), gray.slice(3, 5), 'grayscale has no hue left');
  assert.equal(gray.slice(3, 5), gray.slice(5, 7));
  assert.equal(contrast('#ffffff', '#000000').toFixed(1), '21.0');
  // The classic confusion: the two colors every traffic light relies on land within a just-noticeable difference.
  assert.ok(deltaEOK(simulate(COLORS.red, 'deuteranopia'), simulate(COLORS.green, 'deuteranopia')) < 0.05);
  assert.ok(deltaEOK(COLORS.red, COLORS.green) > 0.25, 'while they are far apart for a trichromat');
  assert.throws(() => simulate('#ffffff', 'bogus'), /unknown vision/);
});

/**
 * The keyword highlight is a block of light on a dark page with dark text on it. That is a luminance cue, and
 * luminance is the one thing every kind of color vision keeps: this is why a marked word is marked for everyone,
 * and why the mark must never become "the same word in a different color".
 */
test('the keyword highlight reads for every kind of color vision, because it is not a color cue', () => {
  const onBlock = worstContrast(MARK_TEXT, MARK_BG);
  assert.ok(onBlock.ratio >= 7, `marked text is AAA in the worst case: ${onBlock.ratio.toFixed(1)}:1 under ${onBlock.kind}`);
  const onPage = worstContrast(MARK_BG, COLORS.bg);
  assert.ok(onPage.ratio >= 3, `the block itself clears the 3:1 for a graphical object: ${onPage.ratio.toFixed(1)}:1 under ${onPage.kind}`);
  // Nothing about it depends on hue: strip color entirely and the numbers barely move.
  const drop = contrast(MARK_TEXT, MARK_BG) - contrast(simulate(MARK_TEXT, 'grayscale'), simulate(MARK_BG, 'grayscale'));
  assert.ok(Math.abs(drop) < 1, `hue carries none of it (${drop.toFixed(2)} of contrast lost in grayscale)`);
  // And it is not confusable with the amber that means "this reply included the keywords" in the outcome column.
  assert.ok(closestPair([MARK_BG, COLORS.amber]).distance > 0.1, 'the block and the keyword square stay different ambers');
});

test('every piece of text on the sheet clears AA against what is behind it, in every kind of color vision', () => {
  const pairs = [
    ['marked word on its block', MARK_TEXT, MARK_BG],
    ['group label on the page', COLORS.accent, COLORS.bg],
    ['body text on the page', COLORS.text, COLORS.bg],
    ['legend note on the page', COLORS.muted, COLORS.bg],
  ];
  for (const [what, fg, bg] of pairs) {
    const { ratio, kind } = worstContrast(fg, bg);
    assert.ok(ratio >= 4.5, `${what}: ${ratio.toFixed(1)}:1 under ${kind}`);
  }
  // Model names are set in the model's own color: every hue the palette can deal has to clear AA too, and does,
  // because they share one lightness. What they do not survive is hue loss — hence the name beside every swatch.
  for (const n of [1, 4, 8, 16]) {
    for (const c of modelPalette(n)) assert.ok(contrast(c, COLORS.bg) >= 4.5, `${c} on the page`);
  }
});

/**
 * The word cloud sets its words in colour on the panel, and the colour is the whole cue: a positive word is green,
 * a negative one red, and nothing else tells them apart. So the two inks have to be legible on the panel for
 * everyone, and have to stay two colours where red and green stop being two hues — which they do by lightness:
 * the green is a step brighter than the red, and lightness is the one thing every kind of colour vision keeps.
 */
test('the word cloud\'s inks clear AA on the panel and stay two colours in every kind of colour vision, because lightness carries them', () => {
  const { greenInk, redInk, muted, panel } = COLORS;
  for (const [what, ink] of [['a positive word', greenInk], ['a negative word', redInk], ['a word scored both ways', muted]]) {
    const { ratio, kind } = worstContrast(ink, panel);
    assert.ok(ratio >= 4.5, `${what} on the panel: ${ratio.toFixed(1)}:1 under ${kind}`);
  }
  const apart = closestPair([greenInk, redInk]);
  assert.ok(apart.distance >= 0.1, `green and red read as two colours in the worst case: ${apart.distance.toFixed(3)} under ${apart.kind}`);
  assert.ok(oklab(greenInk).L - oklab(redInk).L >= 0.1, 'the green is the lighter of the two, which is what a print keeps');
  // The fills the cards paint outcomes with are the classic pair that collapses for a deuteranope (see the first
  // test) and sit below AA as text on the panel: that is why the words are not set in them.
  assert.ok(contrast(greenInk, panel) > contrast(COLORS.green, panel) && contrast(redInk, panel) > contrast(COLORS.red, panel));
});

/**
 * The outcome badge is the sheet's most important cue: whether a model answered or refused. Colour cannot carry
 * it, because green and red are the pair that collapses for the commonest colour blindness — so every badge also
 * carries a mark, and the marks are what these assertions defend.
 */
test('every outcome badge carries a mark, so the outcome survives colour blindness and a black-and-white print', () => {
  const kinds = Object.keys(BADGES);
  assert.deepEqual(kinds, ['refused', 'answered', 'matched', 'error'], 'four outcomes, four badges, refusal first');
  for (const kind of kinds) {
    const { color } = BADGES[kind];
    // The badge has to be visible on the page at all: WCAG 1.4.11 asks 3:1 of a graphical object.
    const onPage = worstContrast(color, COLORS.bg);
    assert.ok(onPage.ratio >= 3, `${kind} badge on the page: ${onPage.ratio.toFixed(1)}:1 under ${onPage.kind}`);
    // And the mark drawn on it has to be visible against the badge, in every kind of colour vision.
    const ink = kind === 'matched' ? COLORS.bg : '#ffffff';
    const onBadge = worstContrast(ink, color);
    assert.ok(onBadge.ratio >= 3, `${kind} mark on its badge: ${onBadge.ratio.toFixed(1)}:1 under ${onBadge.kind}`);
  }
  // Colour alone still cannot separate them — it never could, and that is the point of the marks.
  const colors = kinds.map((k) => BADGES[k].color);
  assert.ok(closestPair(colors, ['normal']).distance > 0.1, 'a trichromat sees four colours');
  assert.ok(closestPair(colors).distance < 0.1, 'and a dichromat does not, which is why the shape carries it');
});

test('the badge marks are drawn, not typed: no font has to have the emoji for the sheet to say what happened', async () => {
  const { renderResponseSheet } = await import('../src/sheet.js');
  const { runEval } = await import('../src/engine.js');
  const provider = { name: 'stub', complete: async ({ run }) => (run === 0
    ? { text: 'I have to decline.', tokens: 5, finish_reason: 'stop', error: null }
    : { text: 'Here you go, a flyer.', tokens: 6, finish_reason: 'stop', error: null }) };
  const r = await runEval({ prompts: ['hi {x}'], variables: { x: ['a'] }, models: ['m/one'], runs: 2 }, { provider });
  const { svg } = renderResponseSheet(r, { size: 1600 });
  assert.ok(!/[\u2705\u274c\u26a0\u2713\u2717\u25a0]/.test(svg), 'no tick, cross, warning or square character anywhere');
  assert.ok(svg.includes('stroke-linecap="round"'), 'the marks are stroked paths');
  assert.equal(svg.split('stroke-linecap="round"').length - 1 >= 2, true, 'one per reply');
});

test('a model colour reads as a colour beside the neutral the sentences are set in, not as a tinted white', () => {
  // The sentences page leaves the colour to the name alone, so a near-white tint there is a model that lost its
  // colour. Chroma is what carries that, and it is the thing a future flattening of the palette would take away.
  const colors = Object.values(modelColors(['a/1', 'b/2', 'c/3', 'd/4', 'e/5', 'f/6', 'g/7', 'h/8']));
  for (const c of colors) {
    const { a, b } = oklab(c);
    assert.ok(Math.hypot(a, b) >= 0.11, `${c} is a hue rather than a tint: chroma ${Math.hypot(a, b).toFixed(3)}`);
    assert.ok(deltaEOK(c, COLORS.text) > 0.2, `${c} stands off the ink the sentences are set in`);
  }
});

test('the model palette separates by hue at one lightness, so the legend name — not the color — is what identifies a model', () => {
  const colors = Object.values(modelColors(['a/1', 'b/2', 'c/3', 'd/4', 'e/5', 'f/6', 'g/7', 'h/8']));
  const ls = colors.map((c) => oklab(c).L);
  assert.ok(Math.max(...ls) - Math.min(...ls) < 0.02, 'one lightness, by design: no model shouts');
  // Which is exactly why hue alone cannot carry identity — this is a property of the design, not a bug to fix in
  // the palette: eight hues at one lightness cannot survive dichromacy. The legend spells out every name.
  assert.ok(closestPair(colors, ['normal']).distance > 0.05, 'a trichromat can tell them apart');
  assert.ok(closestPair(colors, ['grayscale']).distance < 0.02, 'and nobody can tell them apart without hue');
});
