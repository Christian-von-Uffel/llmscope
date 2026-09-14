import { detectRefusal } from './refusal.js';
import { detectKeywords } from './keywords.js';
import { analyzeSentiment } from './sentiment.js';

/** Run every check over a raw provider response. */
export async function runChecks(response, spec, { judge = null, job = null } = {}) {
  const refusal = detectRefusal(response);
  const keywords = detectKeywords(response.text, spec.keywords, spec.keyword_mode);
  let sentiment = { score: 0, comparative: 0 };
  if (!response.error && response.text) {
    try { sentiment = await analyzeSentiment(response.text, spec.sentiment_analyzer); } catch (err) { sentiment = { score: 0, comparative: 0, error: String(err.message || err) }; }
  }
  let judged = null;
  if (judge && !response.error && response.text) {
    try { judged = await judge({ prompt: job?.prompt || '', text: response.text }); } catch (err) { judged = { error: String(err.message || err) }; }
  }
  return {
    refused: judged && typeof judged.refused === 'boolean' ? judged.refused : refusal.refused,
    refusal_reason: judged && typeof judged.refused === 'boolean' ? `judge:${judged.verdict}` : refusal.reason,
    refusal_evidence: refusal.evidence,
    heuristic_refused: refusal.refused,
    matched: keywords.matched,
    keyword_hits: keywords.hits,
    sentiment: sentiment.comparative,
    sentiment_score: sentiment.score,
    sentiment_words: { positive: sentiment.positive || [], negative: sentiment.negative || [] },
    judge: judged,
  };
}
