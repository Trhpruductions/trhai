import { scoreMemories } from "./memoryRelevance.js";

// The sentence of a passage that a question is about.
//
// An answer from the knowledge base is a passage quoted whole, because the
// match is lexical and a quote is evidence where a paraphrase would be a
// guess. But a passage is a paragraph. Asked "how many vacation days do new
// employees get?", the reply was four sentences - the handbook's title, the
// vacation rule, the office's closing day and when expenses are due - and the
// reader had to find the one that answered.
//
// This picks that sentence out, word for word, to be read first. Nothing is
// interpreted and nothing is dropped: the caller still quotes the whole
// passage underneath, so a sentence picked wrongly costs a line of reading,
// never the answer.

/** A sentence must share at least this many of the question's terms to be the one it is about. */
const minimumSharedTerms = 2;
/** A passage shorter than this many sentences is read whole: there is nothing to pick from. */
const minimumSentences = 3;
/** Picking more than this share of a passage is not picking. */
const largestShare = 0.6;

/**
 * A sentence that continues the one before it: "It lasts two years." says
 * nothing on its own, and everything with the sentence it follows.
 */
const continuesTheLast = /^(?:it|they|this|that|these|those|he|she|its|their|both|each)\b/i;

/**
 * The text cut into sentences, each exactly as written.
 *
 * A sentence ends at a full stop, question mark or exclamation mark that is
 * followed by a space and something a sentence starts with. So "3.5", "v1.2"
 * and "e.g. this" are left whole. An abbreviation before a capital ("Dr.
 * Smith") does split; the worst that follows is a shorter line above a
 * passage that is quoted in full anyway.
 */
export function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(\[])/).map((sentence) => sentence.trim()).filter(Boolean);
}

/**
 * The sentence of `passage` that `question` is about - with the sentence
 * after it when that one only continues it - or null when no one sentence
 * stands out: the passage is short, nothing shares enough with the question,
 * two sentences share as much, or the pick would be most of the passage.
 */
export function answeringSentence(question: string, passage: string): string | null {
  const sentences = sentencesOf(passage);
  if (sentences.length < minimumSentences) return null;

  // Scored the way passages themselves are matched to a question, so the
  // sentence picked is the one that made the passage match.
  const scored = scoreMemories(question, sentences.map((sentence, index) => ({
    id: String(index), title: "", body: sentence, pinned: false, createdAt: new Date(0).toISOString()
  })));
  const shared = new Map(scored.map((entry) => [Number(entry.memory.id), entry.matchedTerms.length]));
  const most = Math.max(0, ...shared.values());
  if (most < minimumSharedTerms) return null;
  const best = sentences.map((_, index) => index).filter((index) => shared.get(index) === most);
  // Two sentences that share as much: neither is "the" answer.
  if (best.length !== 1) return null;

  const at = best[0];
  const next = sentences[at + 1];
  const picked = next && continuesTheLast.test(next) ? `${sentences[at]} ${next}` : sentences[at];
  if (picked.length > passage.length * largestShare) return null;
  return picked;
}
