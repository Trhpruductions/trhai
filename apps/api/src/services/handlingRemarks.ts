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
// tools, names their documents and memory together the way the instructions
// do, or speaks of "the user" having recorded nothing. What is never touched:
// a reply's opening "I don't have ..." or "I couldn't find ...", which is its
// answer; code; a reply that is nothing else; and any reply to a request that
// itself asks about notes, documents, tools or sources, where the same
// sentence is the answer.

/**
 * General knowledge, however it is put. Through the whole app, with the first
 * wordings taken out, Qwen3 said: "Your memory or files do not contain this
 * information, as it is widely known."
 */
const generalKnowledge = /\bgeneral(?:\s+\w+){0,2}\s+knowledge\b|\b(?:common|public)\s+knowledge\b|\b(?:widely|commonly|well)[- ]known\b/i;

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

/**
 * Documents and memory named together - "the user's documents or memory",
 * "your memory or files" - is the wording of this app's own instructions. In
 * an answer about the world it is only ever the model reporting on them. Not
 * "loads your documents into memory", which is how a computer works.
 */
const theirRecordsAsAPair = new RegExp(
  String.raw`\b(?:documents?|files?|notes?|knowledge\s+base)(?:\s*,\s*(?:(?:or|and)\s+)?|\s+(?:or|and)\s+)(?:(?:their|your|the|saved)\s+)?memor(?:y|ies)\b`
  + String.raw`|\bmemor(?:y|ies)(?:\s*,\s*(?:(?:or|and)\s+)?|\s+(?:or|and)\s+)(?:(?:their|your|the|saved)\s+)?(?:documents?|files?|notes?|knowledge\s+base)\b`,
  "i"
);

/** Sentences that are about the handling whatever else is in them. */
const alwaysARemark: RegExp[] = [
  // "This information is based on general knowledge of the periodic table." Not "This is an estimate
  // based on general knowledge and may be out of date", which says something about the answer.
  /^\W*this (?:information|answer|response|fact) is based on general(?:\s+\w+){0,2}\s+knowledge\b/i,
  // "The user has not recorded any information about this topic in their memory or documents."
  /^\W*the user (?:has|have|had)(?:n't| not) (?:recorded|saved|stored|shared|mentioned|provided|noted)\b/i,
  // "No tools were needed." - and wherever in the sentence it comes: "It is not related to the user's
  // personal data, documents, or systems, so no tools were needed to answer this question."
  /\bno tools? (?:were|was|are|is) (?:needed|used|required|necessary)\b/i
];

const needsNo = String.raw`(?:does not|doesn't|did not|didn't) (?:require|need|involve) (?:any |a )?(?:access(?:ing)?|checking|consulting|searching|using|looking)\b`;

/** Sentences that are about the handling only when they speak of the user's records or the tools. */
const aRemarkAboutTheirRecords: RegExp[] = [
  // "I don't need to consult any tools to provide this answer." Not "I don't need to check: citizens travel freely."
  /^\W*i (?:do not|don't|did not|didn't) need to (?:use|consult|check|access|search)\b/i,
  // "It does not require accessing the user's personal data or files." The answer is the subject - not
  // "This app does not require access to your files", which is about an app.
  new RegExp(String.raw`^\W*(?:this|it|that)(?:\s+(?:question|information|answer|fact|response|query|request))? ${needsNo}`, "i"),
  // "This is a general chemistry fact and does not require checking the user's personal data."
  new RegExp(String.raw`^\W*(?:this|it|that)\s+(?:is|was|information|answer|fact|response)\b[^.!?\n]*\b${needsNo}`, "i")
];

/**
 * The same said to the user's face: "You have not recorded any specific
 * details about this painting in your documents or memories." A remark when
 * the question was about a painting. The answer, when the question was about
 * them - so it is asked only of a request that is not (see asksAboutThemselves).
 */
const youHaveNotRecorded = /^\W*you (?:have|had)(?:n't| not) (?:recorded|saved|stored|shared|mentioned|provided|noted)\b/i;

/**
 * The same again as the tail of a sentence worth keeping: "This concept is
 * fundamental in operating systems, though the user's documents or memory do
 * not contain specific details about semaphores." Only the tail goes.
 */
const thoughTheirRecordsDoNot =
  /,?\s*(?:though|although|but|as|since|because|while)\s+(?:the user['’]s|your)\s+(?:saved\s+)?(?:documents?|memor(?:y|ies)|files?|notes?|records?)(?:\s+(?:or|and)\s+(?:documents?|memor(?:y|ies)|files?|notes?|records?))*\s+(?:do|does|did)(?:n['’]t| not)\s+(?:contain|include|mention|have)\b[^.!?\n]*/i;

/**
 * A request about the person asking - "what's my dog's name?", "what did I
 * tell you about the printer?". Not "tell me who wrote it", where "me" is only
 * who the answer is for.
 */
function asksAboutThemselves(request: string): boolean {
  const asked = request.replace(/’/g, "'").replace(/\b(?:tell|give|show|remind|help|let|teach|send|get)\s+(?:me|us)\b/gi, " ");
  return /\b(?:i|i'm|i've|i'd|i'll|my|mine|myself|me|we|we've|our|ours|us)\b/i.test(asked);
}

function isAboutTheHandling(sentence: string, aboutThemselves: boolean): boolean {
  // The model writes both apostrophes, and has wrapped a remark in a tag of its own.
  const said = sentence.replace(/’/g, "'").replace(/^(?:\s*<\/?[a-z]+>\s*)+/i, "");
  if (alwaysARemark.some((remark) => remark.test(said))) return true;
  // Asked about themselves, what is and is not in their records is the answer.
  if (!aboutThemselves && theirRecordsAsAPair.test(said)) return true;
  if (!theirRecords.test(said)) return false;
  if (!aboutThemselves && youHaveNotRecorded.test(said)) return true;
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

  const aboutThemselves = asksAboutThemselves(request ?? "");
  let inCode = false;
  let removed = false;
  // A reply that opens by speaking for itself - "I don't have ...", "I couldn't find ..." - opens with its
  // answer, and that sentence stays whatever it says of their records. Any other opening is read like the
  // rest: Qwen3 has also put the remark first, and the answer after it.
  let answered = false;
  const lines = reply.split("\n").map((line) => {
    if (/^\s*```/.test(line)) {
      inCode = !inCode;
      return line;
    }
    if (inCode) return line;
    const sentences = sentencesOf(line);
    const kept: string[] = [];
    for (const sentence of sentences) {
      const opens = !answered && /\p{L}/u.test(sentence);
      if (opens) answered = true;
      const speaksForItself = opens && /^\W*i\b/i.test(sentence.replace(/’/g, "'"));
      // The tail first: what is left of the sentence may be worth keeping.
      const withoutItsTail = aboutThemselves ? sentence : sentence.replace(thoughTheirRecordsDoNot, "");
      if (!speaksForItself && isAboutTheHandling(withoutItsTail, aboutThemselves)) continue;
      kept.push(withoutItsTail);
    }
    if (kept.length === sentences.length && kept.every((sentence, index) => sentence === sentences[index])) return line;
    removed = true;
    return kept.join(" ");
  });
  if (!removed) return reply;

  // Nothing but such sentences: poor as the reply is, an empty one would be worse.
  const answer = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return /\p{L}/u.test(answer) ? answer : reply;
}
