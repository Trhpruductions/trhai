// How a saved fact is worded, and how loosely two wordings are compared.
//
// Shared by the tools that act on a memory the model names and by the
// composer that quotes the transcript, because both failed at the same thing.
// "forget that my printer is on the second floor" arrived as forget with the
// fact "that my printer is on the second floor" - the user's sentence with the
// verb taken off - and was compared literally against the stored "my printer
// is on the second floor", so a deletion the user had just confirmed did
// nothing. And a fact the user had just asked to forget was quoted straight
// back out of the transcript, because the transcript is not memory.

/** Ways a fact gets introduced when it is repeated rather than stated. */
const leadIns = /^(?:the (?:saved |stored )?(?:fact|memory|note|one) (?:that |about |saying )?|that |about )/;

const quotes = /^["'“”‘’]+|["'“”‘’.!]+$/g;

const copulas = [" is ", " are ", " was ", " were ", " = "];

/** Words that carry no part of what a fact is about. */
const stopWords = new Set([
  "the", "a", "an", "my", "our", "your", "this", "that", "these", "those",
  "is", "are", "was", "were", "be", "of", "to", "in", "on", "at", "for",
  "and", "or", "it", "its", "i", "we", "you", "me", "us"
]);

/**
 * A fact reduced to its wording: lower case, unquoted, without the lead-in
 * that repeats it ("the fact that", "that"), single-spaced.
 */
export function normalizeFact(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(quotes, "")
    .replace(leadIns, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The words of a fact that say what it is about, in order. */
export function contentWords(text: string): string[] {
  return normalizeFact(text)
    .split(/[^a-z0-9']+/)
    .filter((word) => word.length > 0 && !stopWords.has(word));
}

/** "my api port is 9090" -> "my api port". Null when there is no copula. */
export function subjectOf(text: string): string | null {
  const lower = normalizeFact(text);
  for (const copula of copulas) {
    const at = lower.indexOf(copula);
    if (at > 0) return lower.slice(0, at).trim();
  }
  return null;
}

/**
 * Whether a piece of text states the given fact: the same wording anywhere in
 * it, or the same subject given a value.
 *
 * The second half is what makes forgetting hold. "forget my api port" removes
 * "my api port is 9090"; an earlier "my api port is 8080" in the transcript
 * is the same fact with an older value, not a different fact.
 */
export function statesFact(text: string, fact: string): boolean {
  const wanted = normalizeFact(fact);
  if (!wanted) return false;
  const have = normalizeFact(text);
  if (have.includes(wanted)) return true;

  const subject = subjectOf(wanted);
  if (!subject) return false;
  return copulas.some((copula) => have.includes(`${subject}${copula}`));
}

/**
 * A conversation with every turn that states a forgotten fact taken out, for
 * anything that hands the transcript to the model.
 *
 * Deleting the memory was not enough: the turn it was made from was still in
 * the history the model reads. Live, "forget that my favourite colour is
 * teal" deleted it, and "what is my favourite colour?" was answered "Based on
 * what you've shared, your favourite colour is teal". A reply to a turn taken
 * out goes with it - "Saved." answers nothing on its own - and so does any
 * reply that repeated the fact.
 */
export function withoutForgotten<T extends { role: string; content: string }>(turns: T[], forgotten: string[]): T[] {
  if (forgotten.length === 0) return turns;
  const kept: T[] = [];
  let answeringRemoved = false;
  for (const turn of turns) {
    if (forgotten.some((fact) => statesFact(turn.content, fact))) {
      answeringRemoved = turn.role === "user";
      continue;
    }
    if (answeringRemoved && turn.role === "assistant") {
      answeringRemoved = false;
      continue;
    }
    answeringRemoved = false;
    kept.push(turn);
  }
  return kept;
}

export type FactMatch<T> =
  | { kind: "one"; memory: T }
  | { kind: "several"; candidates: T[] }
  | { kind: "none" };

/**
 * The saved memory a piece of wording names, matched by wording rather than
 * id.
 *
 * The wording is repeated by a model or typed by the user, and both
 * paraphrase. "forget that my printer is on the second floor" names "my
 * printer is on the second floor" with the user's "that" still attached;
 * "forget my api port" names "my api port is 8080" by its subject alone;
 * "the api port" not even with the same determiner.
 *
 * So: the exact wording, then the wording contained in a body, then every
 * content word present. More than one candidate at a level is reported as
 * such rather than resolved by guessing - for a deletion, the wrong match is
 * worse than no match.
 */
export function matchMemories<T extends { body: string }>(fact: string, memories: T[]): FactMatch<T> {
  const wanted = normalizeFact(fact);
  if (!wanted) return { kind: "none" };

  const exact = memories.find((memory) => normalizeFact(memory.body) === wanted);
  if (exact) return { kind: "one", memory: exact };

  const containing = memories.filter((memory) => normalizeFact(memory.body).includes(wanted));
  if (containing.length === 1) return { kind: "one", memory: containing[0] };
  if (containing.length > 1) return { kind: "several", candidates: containing };

  const words = contentWords(wanted);
  if (words.length === 0) return { kind: "none" };
  const byWords = memories.filter((memory) => {
    const have = new Set(contentWords(memory.body));
    return words.every((word) => have.has(word));
  });
  if (byWords.length === 1) return { kind: "one", memory: byWords[0] };
  if (byWords.length > 1) return { kind: "several", candidates: byWords };
  return { kind: "none" };
}
