// The words that travel with the card. A PNG carries no text — no glyphs, no metadata chunk any platform reads —
// so everything that makes a shared image findable, quotable or accessible has to be generated beside it and
// pasted in by hand. This module writes those words once, in the shapes the four platforms actually ask for.
//
// Alt text is the part that matters most. It is what a screen reader announces, what a search engine indexes,
// and the only place the finding survives if the image fails to load. The limits below are the platforms' own,
// and the tightest of them governs the short form so that one string can be pasted anywhere without editing.
import { findingFor, prettyName, setupLine } from './render-share.js';
import { METRIC_LABEL } from './analyze.js';

// X rejects a photo over 5 MB outright, and it is the tightest of the four. An image that will not upload is
// worth less than a smaller one that will, so this is a hard ceiling rather than a suggestion.
export const PLATFORM_MAX_BYTES = 5 * 1024 * 1024;

const ALT_SHORT_MAX = 300; // LinkedIn's alt field, the tightest of the four
const ALT_LONG_MAX = 1000; // X and Facebook allow this much; Instagram is not documented, so it gets the short form

/** Cut at a word boundary and mark the cut, so a truncated sentence never reads as a complete one. */
function ellipsize(text, max) {
  const s = String(text).trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[,;:.\s]+$/, '')}…`;
}

/** One model's result as words: "Claude Sonnet 4.5: 3/5 for “men”, 0/5 for “women”". */
function modelLine(a, row, names) {
  const p = a.spec.primary;
  const value = (cell) => {
    if (!cell.n) return 'no reply';
    if (p === 'sentiment') return (cell.sentiment_mean >= 0 ? '+' : '') + cell.sentiment_mean.toFixed(2);
    const count = p === 'keyword' ? cell.matched : cell.refused;
    return cell.n === 1 ? (cell.errors ? 'error' : cell.refused ? 'refused' : p === 'keyword' ? (cell.matched ? 'included' : 'not included') : 'answered') : `${count}/${cell.n}`;
  };
  const named = a.variants.length > 1 || a.variants[0]?.label !== '—';
  // A bare "3/3" says nothing on its own, so a count carries the word it counts.
  const unit = p === 'keyword' ? ' included' : p === 'refusal' ? ' refused' : '';
  const words = (cell) => `${value(cell)}${unit && cell.n > 1 ? unit : ''}`;
  const cells = row.cells.map((c) => (named ? `${words(c)} for “${c.variantLabel}”` : words(c))).join(', ');
  return `${prettyName(row.model, names)}: ${cells}`;
}

/**
 * What the image says, for the alt field. Parts are dropped from the end rather than the whole string being
 * truncated, so the finding — the one thing a reader loses nothing else by keeping — always survives the limit.
 * @param {object} a analysis
 * @param {object} [opts]
 * @param {boolean} [opts.long] include the per-model numbers, for platforms that allow 1000 characters
 */
export function altText(a, { names = {}, long = false } = {}) {
  const max = long ? ALT_LONG_MAX : ALT_SHORT_MAX;
  const metric = (METRIC_LABEL[a.spec.primary] || a.spec.primary).toLowerCase();
  const groups = a.variants.length > 1 ? ` across ${a.variants.length} wordings of one prompt` : '';
  const opener = `Results chart: ${a.rows.length} language models tested for ${metric}${groups}.`;
  const finding = `${findingFor(a).headline}.`;
  // No full stop after a prompt that already ends in one: “…in a good light?”. reads as a typo.
  const prompt = a.title.prompt ? `Prompt: “${a.title.prompt}”${/[.!?…]$/.test(a.title.prompt.trim()) ? '' : '.'}` : '';
  const mock = a.mock ? 'Mock data, not real model output.' : '';

  // Kept in this order; the first part that does not fit ends the string.
  const parts = [opener, finding, mock, prompt].filter(Boolean);
  let out = '';
  for (const part of parts) {
    const next = out ? `${out} ${part}` : part;
    if (next.length > max) {
      // The prompt is the one part worth showing in truncated form: it is the subject of the whole image.
      if (part === prompt && max - out.length > 60) out = `${out} ${ellipsize(prompt, max - out.length - 1)}`;
      return out;
    }
    out = next;
  }
  // Rows are already sorted by effect size, so filling the remaining budget row by row keeps the models that
  // carry the finding and drops the tail. A count of what was dropped is cheaper than an unexplained stop.
  if (long) {
    const lines = a.rows.map((row) => modelLine(a, row, names));
    let shown = 0;
    let body = '';
    for (const line of lines) {
      const left = lines.length - shown - 1;
      const tail = left ? ` And ${left} more model${left > 1 ? 's' : ''}.` : '';
      const next = `${body}${body ? ' ' : ''}${line}.`;
      if (out.length + 1 + next.length + tail.length > max) break;
      body = next;
      shown += 1;
    }
    if (shown) {
      const left = lines.length - shown;
      out = `${out} ${body}${left ? ` And ${left} more model${left > 1 ? 's' : ''}.` : ''}`;
    }
  }
  return out;
}

/** The post body: the finding, then enough method for a reader to judge it, then the link to rerun it. */
export function caption(a, { names = {}, url = null } = {}) {
  const shareUrl = url || `${a.spec.share_base || ''}${a.id}`;
  const method = [
    setupLine(a).toLowerCase(),
    `temperature ${a.spec.temperature}`,
    'each value sent as its own request, in shuffled order',
  ].join(' · ');
  return [
    `${findingFor(a).headline}.`,
    a.title.prompt ? `\nPrompt: “${a.title.prompt}”` : '',
    a.title.more ? a.title.more : '',
    `\n${method}`,
    a.mock ? '\nMock data: these are not real model replies.' : '',
    `\nRerun it yourself: ${shareUrl}`,
  ].filter(Boolean).join('\n');
}

/**
 * The whole share kit as one pasteable file. Written next to the card because the card is the artifact people
 * actually post, and these are the fields they have to fill in by hand when they do.
 */
export function shareText(a, { names = {}, url = null } = {}) {
  const short = altText(a, { names });
  const long = altText(a, { names, long: true });
  const blocks = [
    ['ALT TEXT — short form', `fits every platform's limit (${ALT_SHORT_MAX} characters); paste as-is`, short],
    ['ALT TEXT — long form', `for X and Facebook (${ALT_LONG_MAX} characters)`, long],
    ['CAPTION', 'the post body', caption(a, { names, url })],
  ];
  return blocks.map(([title, note, body]) => `${title}\n${note}\n${'-'.repeat(72)}\n${body}\n`).join('\n');
}
