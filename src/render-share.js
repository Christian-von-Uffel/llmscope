// Share card: one finding in words, one number per cell, nothing that dies at thumbnail size.
import { COLORS, keywordPhrase, noKeywordsYet, METRIC_LABEL, brandLine, countedLine, runsLine } from './analyze.js';
import { esc, textWidth, wrap, fit, shortModel, clamp, fillLastLine, promptBlock, TITLE, GROW_MAX, monthStamp } from './render.js';
import { pinTextWidths, SANS, MONO } from './text.js';
import { logoFor } from './logos.js';

/** A value as the card quotes it, empty included. Shared with the keyword card so the two never disagree. */
export const quoted = (s) => `“${s === '' ? 'none' : s}”`;

export function prettyName(id, names = {}) {
  if (names[id]) return names[id].replace(/^[^:]+:\s*/, '');
  return shortModel(id).split('-').map((w) => (/^(gpt|glm|grok|qwen|llama|deepseek)$/i.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))).join(' ');
}

/** The finding as a sentence. Conservative: a direction is only claimed when every flagged row points the same way. */
export function findingFor(a) {
  const { spec, rows, variants } = a;
  const n = rows.length;
  const p = spec.primary;
  // Nothing was scored, so there is no finding and the sentence says exactly that rather than reporting a
  // rate of zero against a word that was never named.
  if (noKeywordsYet(spec)) return { headline: `${n} model${n === 1 ? '' : 's'} answered; no keywords set yet`, direction: null };
  const kwPhrase = spec.keywords.length <= 3 ? `used ${keywordPhrase(spec)}` : `used at least one of ${spec.keywords.length} keywords`;
  if (variants.length > 1) {
    const flagged = rows.filter((r) => r.flagged);
    const k = flagged.length;
    const verb = p === 'refusal' ? 'refuse' : p === 'keyword' ? kwPhrase.replace(/^used/, 'use') : 'reply negatively';
    if (!k) return { headline: `No model ${p === 'refusal' ? 'refuses' : p === 'keyword' ? verb.replace(/^use/, 'uses') : 'replies negatively'} at different rates depending on the wording`, direction: null };
    const worst = (row) => row.cells.filter((c) => c.n).reduce((best, c) => (p === 'sentiment' ? c.primary_value < best.primary_value : c.primary_value > best.primary_value) ? c : best);
    const tops = flagged.map((r) => worst(r).variantLabel);
    const same = tops.every((t) => t === tops[0]);
    if (same) {
      const g = tops[0];
      if (variants.length === 2) {
        const other = variants.find((v) => v.label !== g).label;
        return { headline: `${k} of ${n} models ${verb} more often for ${quoted(g)} than for ${quoted(other)}`, direction: g };
      }
      return { headline: `${k} of ${n} models ${verb} most often for ${quoted(g)}`, direction: g };
    }
    return { headline: `${k} of ${n} models ${verb} at different rates depending on the wording`, direction: null };
  }
  if (p === 'keyword') return { headline: `${rows.filter((r) => r.matchedAny).length} of ${n} models ${kwPhrase} in their reply`, direction: null };
  if (p === 'sentiment') return { headline: `${rows.filter((r) => r.cells[0]?.sentiment_mean < 0).length} of ${n} models replied negatively`, direction: null };
  return { headline: `${rows.filter((r) => r.refusedAny).length} of ${n} models refused this prompt`, direction: null };
}

function cellWords(cell, primary) {
  if (cell.n === 0) return '—';
  if (primary === 'sentiment') return (cell.sentiment_mean >= 0 ? '+' : '') + cell.sentiment_mean.toFixed(2);
  const count = primary === 'keyword' ? cell.matched : cell.refused;
  if (cell.n === 1) return cell.errors ? 'error' : cell.refused ? 'refused' : primary === 'keyword' ? (cell.matched ? 'included' : 'not included') : 'answered';
  return `${count}/${cell.n}`;
}

export { monthStamp };

/** Neutral line for prompt-title cards: what was run, not what was found. */
export function setupLine(a) {
  const s = a.spec;
  const groups = a.variants.length;
  return [
    METRIC_LABEL[s.primary] || s.primary.toUpperCase(),
    `${a.rows.length} MODELS`,
    groups > 1 ? `${groups} WORDINGS` : null,
    s.prompts.length > 1 ? `${s.prompts.length} PROMPTS` : null,
    a.summary.runs_per_cell > 1 ? `${a.summary.runs_per_cell} RUNS EACH` : null,
  ].filter(Boolean).join(' · ');
}

/**
 * @param {object} opts
 * @param {'prompt'|'finding'} [opts.title] prompt (the default): every prompt the run sent is the headline and no
 *   finding is stated, so viewers draw their own conclusion from what was asked and what came back.
 *   finding: the generated sentence is the headline and the first prompt is quoted small below it.
 */
/** The design size of the prompt heading; a short prompt may grow to GROW_MAX times it and no further. */
export const SHARE_TITLE_SIZE = 64;

export function renderShareCard(a, { width = 1600, height = 1600, names = {}, url = null, date = null, title = 'prompt' } = {}) {
  const W = width; const H = height; const pad = 64;
  const shareUrl = url || `${a.spec.share_base || ''}${a.id}`;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`, `<rect width="${W}" height="${H}" fill="${COLORS.bg}"/>`];
  const text = (x, y, str, { size = 24, weight = 400, fill = COLORS.text, font = SANS, anchor = 'start', extra = '' } = {}) =>
    parts.push(`<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="${font}" font-size="${size}" font-weight="${weight}" fill="${fill}" ${extra}>${esc(str)}</text>`);

  const maxW = W - pad * 2;
  // top strip: brand + what was measured, then the date. The name alone says who made the image; it does not say
  // what the image is, and the reader of a screenshot has nothing else to go on. Both halves are measured with
  // their letter-spacing charged in — SVG adds tracking after every glyph and the font metrics know nothing about
  // it — so the brand gives way rather than running under the date.
  let y = pad + 22;
  const stamp = `${monthStamp(date)}${a.mock ? ' · MOCK DATA' : ''}`;
  const brand = brandLine(a);
  const stampW = textWidth(stamp, 26, false, true) + 2 * stamp.length;
  text(pad, y, brand, { size: fit(brand, 26, maxW - stampW - 40, true, 15, true, 2), weight: 700, fill: COLORS.muted, font: MONO, extra: 'letter-spacing="2"' });
  text(W - pad, y, stamp, { size: 26, fill: a.mock ? COLORS.accent : COLORS.muted, font: MONO, anchor: 'end', extra: 'letter-spacing="2"' });

  const quoted = `“${a.title.prompt}”`;
  // Grid geometry first: the results are the point of the card, so the title may only use the height the rows do not
  // need. Rows never go below TITLE.minRowH, however long the prompt is.
  const footerH = 120;
  const gap = 10;
  const rowsN = Math.max(1, a.rows.length);
  const colsN = Math.max(1, a.variants.length);
  const headerH = colsN > 1 || a.variants[0]?.label !== '—' ? 80 : 0;
  const gridBottom = H - footerH;
  if (title === 'prompt') {
    // The prompt is the heading, and what was counted is the line under it. A reader cannot judge a number without
    // holding the question it answers, so the question goes first and the measure second; the setup line that used
    // to sit above the prompt led with a category — a metric name and a count of "groups" — that the reader had
    // not met yet, and spent the top of the card on it.
    y += 40;
    // Every prompt the run sent is quoted, all at one size, so none of them reads as the one that mattered. Each
    // prompt's measure decides how many lines it takes (8-12 words each); pretext then sizes the whole block to
    // fill them. A block too long for its share of the card borrows the height the grid can spare, and no more —
    // and if even that is not enough, the prompts that still read are quoted and the rest are counted off. The
    // card would rather admit it left one out than shrink them all past reading size.
    const sub = countedLine(a.spec);
    const subSize = fit(sub, 38, maxW, false, 20);
    // The subheading is charged for before the prompt takes its share, so a long prompt cannot crowd it out.
    const subH = subSize * 1.3 + 20;
    const gridMinH = headerH + rowsN * TITLE.minRowH + gap * (rowsN - 1);
    const availableH = Math.max(TITLE.floorSize * TITLE.lineHeight, Math.min(H * 0.40, gridBottom - y - 44 - subH - gridMinH));
    const block = promptBlock(a.title.prompts, {
      x: pad, y, maxWidth: maxW, maxHeight: availableH, preferredHeight: Math.min(H * 0.28, availableH),
      slots: a.title.slots, maxSize: SHARE_TITLE_SIZE * GROW_MAX,
    });
    parts.push(...block.svg);
    // Grey, and not the accent or the body white: the prompt above sets its slots in amber and the rest in white,
    // so either of those would read as another line of the heading rather than as the line that describes it. The
    // tone break is what separates them; it does the work that would otherwise cost the grid a band of white space.
    y = block.bottom + 20 + subSize;
    text(pad, y, sub, { size: subSize, fill: COLORS.muted });
    y += 44;
  } else {
    // headline: the finding
    const finding = findingFor(a);
    let hs = 76; let lines;
    for (;;) { lines = wrap(finding.headline, hs, maxW, Infinity); if (lines.length <= 3 || hs <= 44) break; hs -= 2; }
    // A headline ending on one stranded word reads as a mistake. The measure gives way, never the size.
    lines = fillLastLine(finding.headline, hs, maxW, lines);
    y += 50;
    for (const line of lines) { y += hs * 1.08; text(pad, y, line, { size: hs, weight: 700 }); }
    // prompt, quoted, small
    const ps = 30;
    const plines = wrap(quoted, ps, maxW, 3, false);
    y += 26;
    for (const line of plines) { y += ps * 1.25; text(pad, y, line, { size: ps, fill: COLORS.muted }); }
    if (a.title.more) { y += 34; text(pad, y, a.title.more, { size: 24, fill: COLORS.muted }); }
    y += 44;
  }

  // grid: one number per cell
  const gridTop = y;
  const labelW = Math.round(W * 0.34);
  const rowH = (gridBottom - gridTop - headerH - gap * (rowsN - 1)) / rowsN;
  const cellW = (W - pad * 2 - labelW - gap * colsN) / colsN;
  const gridX = pad + labelW + gap;
  if (headerH) a.variants.forEach((v, i) => {
    const x = gridX + i * (cellW + gap) + cellW / 2;
    const size = fit(v.label, 44, cellW - 24, true, 18);
    text(x, gridTop + headerH / 2 + size / 3, v.label, { size, weight: 700, fill: COLORS.accent, anchor: 'middle' });
  });
  a.rows.forEach((row, ri) => {
    const ry = gridTop + headerH + ri * (rowH + gap);
    parts.push(`<rect x="${pad}" y="${ry}" width="${labelW}" height="${rowH}" rx="6" fill="${COLORS.panel}"/>`);
    if (row.flagged) parts.push(`<rect x="${pad}" y="${ry}" width="10" height="${rowH}" rx="3" fill="${COLORS.accent}"/>`);
    const name = prettyName(row.model, names);
    const logo = logoFor(row.model);
    const ls0 = clamp(28, rowH * 0.44, 52);
    const lx0 = pad + 30;
    if (logo) parts.push(`<image x="${lx0}" y="${(ry + rowH / 2 - ls0 / 2).toFixed(1)}" width="${ls0}" height="${ls0}" href="${logo}" opacity="0.92"/>`);
    else {
      parts.push(`<circle cx="${lx0 + ls0 / 2}" cy="${ry + rowH / 2}" r="${ls0 / 2}" fill="${COLORS.gray}"/>`);
      text(lx0 + ls0 / 2, ry + rowH / 2 + ls0 * 0.2, name[0].toUpperCase(), { size: ls0 * 0.6, weight: 700, anchor: 'middle' });
    }
    const nx = lx0 + ls0 + 20;
    const ns = fit(name, clamp(20, rowH * 0.36, 40), labelW - (nx - pad) - 20, true, 16);
    text(nx, ry + rowH / 2 + ns / 3, name, { size: ns, weight: 700 });
    row.cells.forEach((cell, ci) => {
      const cx = gridX + ci * (cellW + gap);
      parts.push(`<rect x="${cx}" y="${ry}" width="${cellW}" height="${rowH}" rx="6" fill="${COLORS.gray}" opacity="0.45"/>`);
      let sx = cx;
      for (const seg of cell.segments) {
        const w = (seg.count / cell.n) * cellW;
        parts.push(`<rect x="${sx.toFixed(1)}" y="${ry}" width="${w.toFixed(1)}" height="${rowH}" fill="${seg.color}"/>`);
        sx += w;
      }
      const label = cellWords(cell, a.spec.primary);
      const ls = fit(label, clamp(24, rowH * 0.5, 64), cellW - 32, true, 16);
      text(cx + cellW / 2, ry + rowH / 2 + ls / 3, label, { size: ls, weight: 700, fill: '#fff', anchor: 'middle' });
    });
  });

  // footer: the key on its own line, then the method and the link under it. The legend used to share a line with
  // the URL and shrink until it collided with it; giving it the full width is what lets it be sized rather than
  // squeezed. Every part of it is measured — swatch, gap, label, the space to the next item — so the size that
  // comes out is the largest one that actually fits, not the smallest one the loop was allowed to reach.
  const legendY = H - 82;
  const metaY = H - 32;
  const legend = a.legend.filter((l) => l.key !== 'error' || a.rows.some((r) => r.cells.some((c) => c.errors)));
  const ITEM_GAP = 36;
  const legendWidth = (sz) => legend.reduce((w, item) => w + sz + 12 + textWidth(item.label, sz), 0) + ITEM_GAP * (legend.length - 1);
  let ls2 = 26;
  while (legendWidth(ls2) > maxW && ls2 > 14) ls2 -= 1;
  let lx = pad;
  for (const item of legend) {
    parts.push(`<rect x="${lx.toFixed(1)}" y="${(legendY - ls2 + 4).toFixed(1)}" width="${ls2}" height="${ls2}" rx="5" fill="${item.color}"/>`);
    lx += ls2 + 12;
    text(lx.toFixed(1), legendY, item.label, { size: ls2 });
    lx += textWidth(item.label, ls2) + ITEM_GAP;
  }
  // What a reader cannot deduce from the image, and nothing else. The id is already the last path segment of the
  // link beside it, and "each value sent as its own request" describes the harness rather than this run. "Per
  // cell" named a thing only the person who drew the grid can see; the reader sees models and groups, so the
  // line counts in those.
  const meta = [runsLine(a), `temperature ${a.spec.temperature}`].join(' · ');
  text(W - pad, metaY, shareUrl, { size: 30, font: MONO, anchor: 'end' });
  // The method line gives way to the link rather than running under it.
  text(pad, metaY, meta, { size: fit(meta, 22, maxW - textWidth(shareUrl, 30, false, true) - 40, false, 12, true), fill: COLORS.muted, font: MONO });
  parts.push('</svg>');
  return pinTextWidths(parts.join('\n'));
}
