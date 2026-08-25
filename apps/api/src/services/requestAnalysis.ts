// Request analysis for the assistant reply engine.
//
// There is no language model in this stack, so "understanding" here means a
// deterministic read of the request's shape: is the user asking something,
// instructing something, or stating something? That single distinction is what
// lets the assistant answer a question instead of replying with a work plan.

export type RequestShape = "question" | "command" | "statement";

export type QuestionType =
  | "identity"   // what / which
  | "method"     // how
  | "reason"     // why
  | "time"       // when
  | "person"     // who
  | "place"      // where
  | "confirm"    // yes/no
  | "none";

export type RequestAnalysis = {
  shape: RequestShape;
  questionType: QuestionType;
  /** Content words with stopwords removed, used for memory relevance matching. */
  topics: string[];
  /** True when the request carries too little signal to act on confidently. */
  vague: boolean;
  /** The imperative verb for a command, when one is identifiable. */
  action: string | null;
  /**
   * True when the message asks the assistant to do something. Distinguishes
   * "I need a dashboard" (work) from "The API runs on port 4000" (a fact), which
   * otherwise both look like plain statements and both wrongly earn a plan.
   */
  hasRequestMarker: boolean;
};

/** Phrases that signal the user wants work done rather than stating a fact. */
const requestMarkers = [
  /\b(i|we)\s+(need|want|would like)\b/i,
  /\bhelp\s+(me|us)\b/i,
  /\blet'?s\b/i,
  /\b(can|could|would)\s+you\b/i,
  /\b(we|you)\s+should\b/i,
  /\b(needs?|requires?)\b/i,
  /^please\b/i
];

const stopwords = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "could", "did", "do", "does",
  "for", "from", "had", "has", "have", "he", "her", "him", "his", "how", "i", "if", "in", "into",
  "is", "it", "its", "just", "me", "my", "of", "on", "or", "our", "please", "she", "should", "so",
  "than", "that", "the", "their", "them", "then", "there", "these", "they", "this", "to", "up",
  "us", "was", "we", "were", "what", "when", "where", "which", "while", "who", "why", "will",
  "with", "would", "you", "your", "am", "been", "being", "not", "no", "yes", "get", "got", "want",
  "need", "like", "make", "let", "now", "new", "use", "using", "about", "all", "any", "some"
]);

const commandVerbs = new Set([
  "build", "create", "make", "generate", "add", "write", "implement", "fix", "debug", "refactor",
  "design", "plan", "draft", "review", "test", "deploy", "set", "setup", "configure", "update",
  "remove", "delete", "explain", "summarize", "analyze", "compare", "list", "show", "find",
  // British spellings of verbs already on this list. The same request typed
  // by someone who writes "summarise" fell through to "statement" and was
  // filed away rather than answered — a spelling should not decide whether
  // the assistant does the work.
  "summarise", "analyse", "optimise", "organise", "customise",
  "optimize", "migrate", "install", "run", "scaffold",
  // Caught live: "Look inside the calculator project, list its files, then
  // read server.js and tell me whether the arithmetic looks correct" led
  // with a word not in this set, fell through to "statement", and was
  // acknowledged instead of ever reaching the agent — every tool call in it
  // never happened. These are the verbs a project-inspection request
  // actually starts with, not covered by any of the ones already here.
  "look", "inspect", "check", "read", "open", "verify", "investigate", "search",
  // Caught live, same failure, different tool family: "Calculate 47 times 12"
  // got "Got it — I'll keep that in mind for this conversation" and never
  // touched the calculator. These are leading verbs for tools that exist —
  // remember, forget, pin, calculate — that were simply never added here.
  // "Remember" already has a separate deterministic save path for a bare
  // fact, which is why that specific case did not visibly fail; it is added
  // anyway so a compound request ("Remember X, then build Y") is recognised
  // as a command from the start rather than depending on a different branch
  // to notice the rest of the sentence.
  "remember", "forget", "pin", "unpin", "calculate", "save", "recall",
  // Caught live, same failure again, the day fetch_url was added: "Fetch
  // https://example.com and tell me what it says" got "Got it — I'll keep
  // that in mind" and fetch_url was never called. The verb is the tool's own
  // name — about as natural a phrasing as exists — and it was still missing.
  "fetch", "visit", "browse"
]);

const questionLeads: Array<{ pattern: RegExp; type: QuestionType }> = [
  { pattern: /^(what|which)\b/i, type: "identity" },
  { pattern: /^how\b/i, type: "method" },
  { pattern: /^why\b/i, type: "reason" },
  { pattern: /^when\b/i, type: "time" },
  { pattern: /^who\b/i, type: "person" },
  { pattern: /^where\b/i, type: "place" },
  { pattern: /^(do|does|did|is|are|was|were|can|could|should|would|will|have|has)\b/i, type: "confirm" }
];

/**
 * "Carry on with what you were doing", in the ways people actually say it.
 *
 * Exported so the one place that decides whether a message is a continuation
 * is this one. The orchestrator needs the same answer to know whether to
 * resume a stored task, and a second copy of this regex living there would
 * drift the first time either was edited.
 *
 * Deliberately anchored to the start. "Continue" as an opener is a
 * continuation; "we should continue testing this later" is a statement that
 * merely contains the word, and resuming on it would hijack the turn.
 */
const continuationPattern =
  /^(continue|proceed|resume|go ahead|do it|do that|apply (?:it|that)|make (?:the )?changes|finish it|carry on)\b/i;

export function isContinuationRequest(message: unknown): boolean {
  return typeof message === "string" && continuationPattern.test(message.trim());
}

/** Phrases that ask about stored knowledge even without a question mark. */
const recallPatterns = [
  /^(remind me|tell me|what did we|what do we|what are our|what is our|what's our)\b/i,
  /\b(do you remember|what did i say|what do i prefer)\b/i
];

const minTopicLength = 3;
const maxTopics = 12;
const vagueWordThreshold = 2;

/**
 * Light suffix normalization so "service" and "services" match. Full stemming
 * needs a library; this covers the plural/gerund cases that dominate real queries
 * without mangling short words.
 */
export function normalizeTerm(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) {
    return `${word.slice(0, -3)}y`;
  }
  if (word.length > 4 && (word.endsWith("ses") || word.endsWith("xes") || word.endsWith("ches"))) {
    return word.slice(0, -2);
  }
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) {
    return word.slice(0, -1);
  }
  if (word.length > 5 && word.endsWith("ing")) {
    return word.slice(0, -3);
  }
  if (word.length > 4 && word.endsWith("ed")) {
    return word.slice(0, -2);
  }
  return word;
}

export function extractTopics(message: string): string[] {
  const seen = new Set<string>();
  const topics: string[] = [];

  for (const raw of message.toLowerCase().split(/[^a-z0-9+#.-]+/)) {
    const word = raw.replace(/^[.-]+|[.-]+$/g, "");
    if (word.length < minTopicLength || stopwords.has(word)) {
      continue;
    }

    const normalized = normalizeTerm(word);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    topics.push(normalized);
    if (topics.length >= maxTopics) {
      break;
    }
  }

  return topics;
}

function firstWord(message: string): string {
  return message.trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, "") ?? "";
}

/** Longest leading clause still treated as a qualifier rather than a sentence. */
const maxQualifierWords = 5;

/**
 * The first word after a short leading clause, or null when there isn't one.
 *
 * "In two sentences, explain X" and "Briefly, summarise Y" put the qualifier
 * first and the verb second. Read from the first word alone both look like
 * statements, and a statement is something the user is telling the assistant
 * — so "In two sentences, explain what a semaphore is." was answered with
 * "Got it, I'll keep that in mind."
 *
 * Bounded at a few words on purpose. A long clause before a comma is a
 * sentence in its own right, and reading its second half as the real request
 * would turn an ordinary statement containing a comma into an order.
 */
export function leadAfterQualifier(message: string): string | null {
  const comma = message.indexOf(",");
  if (comma <= 0) return null;

  const qualifier = message.slice(0, comma).trim();
  if (!qualifier || qualifier.split(/\s+/).length > maxQualifierWords) return null;

  const rest = message.slice(comma + 1).trim();
  return rest ? firstWord(rest) : null;
}

export function analyzeRequest(message: unknown): RequestAnalysis {
  const text = typeof message === "string" ? message.trim() : "";
  const topics = extractTopics(text);

  if (!text) {
    return {
      shape: "statement",
      questionType: "none",
      topics: [],
      vague: true,
      action: null,
      hasRequestMarker: false
    };
  }

  const lead = firstWord(text);
  // The verb after a leading qualifier, when there is one.
  //
  // "Explain what a semaphore is in two sentences" is a command. "In two
  // sentences, explain what a semaphore is" is the same request with the
  // qualifier moved to the front — and it was read as a statement, because
  // the first word is "In". A statement is something the user is telling the
  // assistant, so the reply was "Got it, I'll keep that in mind" to a
  // question that wanted an answer.
  //
  // Only a short leading clause counts. Anything longer is a sentence in its
  // own right, and treating its second half as the real request would let a
  // genuine statement that happens to contain a comma be read as an order.
  const qualified = leadAfterQualifier(text);
  const endsWithQuestionMark = text.endsWith("?");
  const isRecall = recallPatterns.some((pattern) => pattern.test(text));

  let questionType: QuestionType = "none";
  for (const candidate of questionLeads) {
    if (!candidate.pattern.test(text)) {
      continue;
    }
    // An auxiliary lead is ambiguous: "Do it" is an order, "Do we ship?" is a
    // question. Only a question mark settles it. Wh-words need no such proof.
    if (candidate.type === "confirm" && !endsWithQuestionMark) {
      break;
    }
    questionType = candidate.type;
    break;
  }

  // A leading command verb wins over a question word only when there is no "?".
  // "List the options" is a command; "What should I list?" is a question.
const looksImperative =
  (commandVerbs.has(lead) || (qualified !== null && commandVerbs.has(qualified)) || isContinuationRequest(text))
  && !endsWithQuestionMark
  && questionType === "none";

  let shape: RequestShape;
  if (looksImperative) {
    shape = "command";
  } else if (endsWithQuestionMark || questionType !== "none" || isRecall) {
    shape = "question";
    if (questionType === "none") {
      questionType = "identity";
    }
  } else {
    shape = "statement";
  }

  return {
    shape,
    questionType,
    topics,
    // Short requests with almost no content words cannot be acted on well.
    vague: topics.length < vagueWordThreshold,
    action: shape === "command" ? lead : null,
    hasRequestMarker: looksImperative || requestMarkers.some((pattern) => pattern.test(text))
  };
}
