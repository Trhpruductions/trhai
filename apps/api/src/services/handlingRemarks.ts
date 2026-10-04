// An answer, without the account of how the question was handled.
//
// Found on the evaluation of 4 October: Qwen3 answers a plain question and
// then says how it dealt with it. "The novel Pride and Prejudice was written by
// Jane Austen. This is general knowledge and does not require checking the
// user's documents or memory." "The capital of Australia is Canberra. The user
// has not recorded this information in their knowledge base or memories."
// Eleven of twenty-four replies to eight questions did it.
//
// The system prompt tells the model to keep two kinds of question apart - the
// user's own records, and the world - and Qwen3 reports which kind it was. It
// already says to speak to the user as "you". A line added to it saying not to
// explain the handling changed nothing: ten of twenty-four. So the sentences
// are taken out here, by what they say. Nobody who asked who wrote a novel
// asked whether their documents were consulted.
//
// Narrow on purpose. A sentence goes only when it is about the handling - it
// talks of general knowledge in the same breath as the user's records or the
// tools, or it speaks of "the user" having recorded nothing. A reply that is
// nothing else is left alone, and so is any reply to a request that itself
// asks about notes, documents, tools or sources: there, the same sentence is
// the answer.

const generalKnowledge = /\bgeneral(?:\s+\w+){0,2}\s+knowledge\b/i;

/**
 * The user's own records and the tools: what the model was told to keep apart
 * from general knowledge. Their documents, not documents at large - "the
 * earliest recorded use" and "many documents mention it" are about the world.
 */
const theirRecords = new RegExp(
  String.raw`\b(?:(?:your|the user's|their|my|any|no|these|those)\s+(?:\w+\s+){0,2}?(?:documents?|memor(?:y|ies)|notes?|files?|knowledge\s+base|data)`
  + String.raw`|personal\s+(?:data|information|files)|private\s+(?:data|notes|documents|information)|tools?`
  + String.raw`|recorded\s+(?:data|documents?|memor(?:y|ies)|information)|documents?\s+or\s+memor(?:y|ies)|memor(?:y|ies)\s+or\s+documents?)\b`,
  "i"
);

/** Sentences that are about the handling whatever else is in them. */
const alwaysARemark: RegExp[] = [
  // "This information is based on general knowledge of the periodic table." Not "This is an estimate
  // based on general knowledge and may be out of date", which says something about the answer.
  /^\W*this (?:information|answer|response|fact) is based on general(?:\s+\w+){0,2}\s+knowledge\b/i,
  // "The user has not recorded any information about this topic in their memory or documents."
  /^\W*the user (?:has|have|had)(?:n't| not) (?:recorded|saved|stored|shared|mentioned|provided|noted)\b/i,
  // "No tools were needed."
  /^\W*no tools? (?:were|was|are|is) (?:needed|used|required|necessary)\b/i
];

/** Sentences that are about the handling only when they speak of the user's records or the tools. */
const aRemarkAboutTheirRecords: RegExp[] = [
  // "I don't need to consult any tools to provide this answer." Not "I don't need to check: citizens travel freely."
  /^\W*i (?:do not|don't|did not|didn't) need to (?:use|consult|check|access|search)\b/i,
  // "It does not require accessing the user's personal data or files."
  /^\W*(?:this|it|that)(?:\s+\w+)? (?:does not|doesn't|did not|didn't) require (?:accessing|checking|consulting|searching|using)\b/i
];

function isAboutTheHandling(sentence: string): boolean {
  // The model writes both apostrophes, and has wrapped a remark in a tag of its own.
  const said = sentence.replace(/’/g, "'").replace(/^(?:\s*<\/?[a-z]+>\s*)+/i, "");
  if (alwaysARemark.some((remark) => remark.test(said))) return true;
  if (!theirRecords.test(said)) return false;
  return generalKnowledge.test(said) || aRemarkAboutTheirRecords.some((remark) => remark.test(said));
}

/** A request that is itself about where an answer comes from. */
const asksAboutTheHandling =
  /\b(?:notes?|documents?|docs|memor(?:y|ies)|files?|tools?|sources?|general knowledge|how do you know|where did you (?:get|find)|did you (?:check|use|search|look))\b/i;

/**
 * `line` as sentences. A sentence ends at ., ! or ? followed by space and the
 * start of another, which may sit inside a tag: Qwen3 has wrapped its remark
 * as "<note> ... </note>".
 */
function sentencesOf(line: string): string[] {
  return line.split(/(?<=[.!?])\s+(?=(?:<[a-z]+>\s*)*["'“(\[*_]*\p{Lu})/u);
}

/**
 * `reply` without the sentences that only say how the question was handled.
 * The same reply when there are none, when the request asked about that, or
 * when nothing else would be left.
 */
export function withoutHandlingRemarks(reply: string, request: string): string {
  if (asksAboutTheHandling.test(request ?? "")) return reply;

  let inCode = false;
  let removed = false;
  const lines = reply.split("\n").map((line) => {
    if (/^\s*```/.test(line)) {
      inCode = !inCode;
      return line;
    }
    if (inCode) return line;
    const sentences = sentencesOf(line);
    const kept = sentences.filter((sentence) => !isAboutTheHandling(sentence));
    if (kept.length === sentences.length) return line;
    removed = true;
    return kept.join(" ");
  });
  if (!removed) return reply;

  const answer = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return /\p{L}/u.test(answer) ? answer : reply;
}
