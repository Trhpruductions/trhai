// Reply composition.
//
// The previous engine emitted one fixed skeleton for every input — mode heading,
// "Mission Signals", a generic 3-step action track, a memory dump, a history dump,
// and an echo of the request. It never answered anything.
//
// This composer branches on what was actually asked. The governing rule is that it
// must never imply knowledge it does not have: if no stored memory matches the
// question, it says so plainly rather than filling the gap with confident-sounding
// boilerplate.

import { analyzeRequest, type RequestAnalysis } from "./requestAnalysis.js";
import { selectRelevantMemories, type ScorableMemory, type ScoredMemory } from "./memoryRelevance.js";
import { buildTaskPlan } from "./taskPlanning.js";
import { getSystemCapabilities, toolsByLevel } from "./systemCapabilities.js";
import {
  buildClarifyingQuestion,
  findSpecGaps,
  isAwaitingRefinement,
  mergeRefinement,
  planProject
} from "@ascend/shared";

export type ComposerMode =
  | "general" | "build" | "code" | "debug" | "research" | "plan" | "coding" | "business" | "creator";

export type ComposerMemory = ScorableMemory;

export type ConversationTurn = {
  role: "user" | "assistant";
  content: string;
};

/**
 * What actually happened to memory on this turn.
 *
 * The composer used to answer "Saved." purely because the message began with
 * "remember", with no idea whether a write had occurred — so an anonymous
 * request with nowhere to save to was still told its fact was stored. A reply
 * may only claim a save when it has evidence of one, which is why this is a
 * report of an outcome rather than an intent.
 */
export type MemoryWriteOutcome = {
  /** Whether this request had somewhere to save at all (a session or account). */
  available: boolean;
  /** How many memories were actually written from this message. */
  saved: number;
  /**
   * The text of what was actually written, when this turn wrote anything.
   *
   * Lets a "remember that X, then do Y" turn hand X to the model directly
   * rather than making it call search_memory for a fact that was written a
   * moment ago in the very message it is answering.
   */
  savedBodies?: string[];
};

export type ComposerInput = {
  mode: ComposerMode;
  message: string;
  memories: ComposerMemory[];
  history?: ConversationTurn[];
  /**
   * Omitted only by tests that are not exercising memory writes. Production
   * always supplies it, and when it is missing the composer declines to claim a
   * save rather than assuming one.
   */
  memoryWrite?: MemoryWriteOutcome;
  /** Passages from the session's knowledge documents, already chunked. */
  knowledge?: ComposerKnowledge[];
};

/** A knowledge passage the reply may quote, carrying the document it came from. */
export type ComposerKnowledge = ScorableMemory & {
  documentId: string;
  documentTitle: string;
};

export type ComposedReply = {
  text: string;
  /** What the composer decided to do — surfaced for telemetry and tests. */
  strategy:
    | "answer" | "no-answer" | "plan" | "clarify" | "acknowledge" | "clarify-build"
    | "not-saved" | "smalltalk" | "capability";
  /**
   * For a build request, the text the plan should actually be built from — the
   * original request merged with any clarifying answer. Absent when the turn was
   * not a build request.
   */
  buildRequest?: string;
  /** Memory ids actually used to ground the reply. Empty unless strategy is "answer". */
  groundedOn: string[];
  /** Conversation turns actually used to ground the reply. */
  groundedOnHistory: number;
  /**
   * True when this answers only part of what was asked.
   *
   * A grounded answer is returned whole, so a two-part question whose first
   * half matched memory lost its second half without a word. The caller uses
   * this to prefer a model that can answer both — and to keep this reply when
   * there is no model, since half an answer beats none.
   */
  partial?: boolean;
  /**
   * For a "plan" reply, what kind of work was detected. Only "create" produces
   * an app, so it is the only kind where the generic plan is the better answer
   * than a model's — everything else reads as a canned four-step template.
   */
  planTaskType?: string;
};

function isCodingMode(mode: ComposerMode): boolean {
  return mode === "build" || mode === "code" || mode === "debug"
    || mode === "research" || mode === "plan" || mode === "coding";
}

/**
 * A follow-up borrows the previous turn's subject only when it has almost no
 * subject of its own ("what about staging?"). Any looser and carry-over pollutes
 * a self-contained question with unrelated text, which then matches the very turn
 * it was copied from — a circular "answer".
 */
const followUpTopicThreshold = 1;

/**
 * Expand an anaphoric follow-up ("what about staging?", "is it faster?") with the
 * subject of the previous user turn, so it can be scored against something real.
 */
function resolveQuery(message: string, history: ConversationTurn[]): string {
  const analysis = analyzeRequest(message);
  if (analysis.topics.length > followUpTopicThreshold) {
    return message;
  }

  const previousUserTurn = [...history].reverse().find((turn) => turn.role === "user");
  return previousUserTurn ? `${message} ${previousUserTurn.content}` : message;
}

/**
 * Recent user turns, newest first, shaped for relevance scoring.
 *
 * Assistant turns are deliberately excluded. The assistant's own replies are not
 * evidence — grounding an answer on them would let a guess from one turn harden
 * into a cited fact on the next.
 */
function searchableHistory(history: ConversationTurn[]): ComposerMemory[] {
  return history
    .filter((turn) => turn.role === "user" && turn.content.trim().length > 0)
    // Only what the user asserted. A question holds no answer, and neither does
    // a request for work — "In one sentence, what is TypeScript?" was answered
    // by quoting the earlier "Explain what a REST API is in two sentences",
    // which is the user's own instruction handed back to them.
    //
    // Excluding questions alone was not enough: "Explain ..." is command-shaped,
    // so it passed the earlier filter. Statements are the only turns that carry
    // information, which is also what closes the loop where resolveQuery appends
    // the previous turn and it then matches itself.
    .filter((turn) => analyzeRequest(turn.content).shape === "statement")
    .map((turn, index) => ({
      id: `turn-${index}`,
      title: "earlier in this conversation",
      body: turn.content.trim(),
      pinned: false,
      createdAt: new Date(index).toISOString()
    }));
}

function citeMemories(matches: Array<ScoredMemory<ComposerMemory>>): string {
  return matches.map((entry) => {
    const { title, body } = entry.memory;
    // A freshly extracted memory's title is derived from its body, so citing both
    // just repeats the sentence. Only show the label once the user has renamed it.
    const titleAddsInfo = title.trim().toLowerCase() !== body.trim().toLowerCase()
      && !body.trim().toLowerCase().startsWith(title.trim().toLowerCase());
    return titleAddsInfo ? `- ${body} _(${title})_` : `- ${body}`;
  }).join("\n");
}

function answerLead(analysis: RequestAnalysis): string {
  switch (analysis.questionType) {
    case "method":
      return "Here is what you've told me that bears on how to do that:";
    case "reason":
      return "Here is the reasoning you've recorded:";
    case "time":
      return "Here is the timing you've recorded:";
    case "person":
      return "Here is who you've recorded:";
    case "place":
      return "Here is where you've recorded:";
    case "confirm":
      return "Based on what you've told me:";
    default:
      return "Based on what you've told me:";
  }
}

/**
 * How much better a document passage must score to outrank saved memory.
 *
 * A fact the user stated deliberately should win a close call; a passage that
 * matches the question far better should win outright.
 *
 * Two, from measurement rather than taste. Asked which database billing uses,
 * a passage reading "The billing database is described elsewhere in this
 * document" scores 1.44x the memory holding the actual answer — it shares the
 * vocabulary and answers nothing, and lexical scoring cannot tell the
 * difference. A passage that does hold the answer scores about 5x. Those two
 * cases sit either side of 2, so that is where the line goes.
 */
/** Interrogatives. Two in one message means two things were asked. */
const questionWords = /\b(what|which|when|where|who|whose|whom|why|how)\b/gi;

/**
 * Whether a message asks more than one thing.
 *
 * "Which database does my billing run on, and what is today's date?" was
 * answered with the database alone: memory matched, the grounded answer was
 * returned whole, and the second half was dropped silently.
 *
 * Counting interrogatives is crude, and it is the signal that actually
 * separates this from a single question with a long subject — "what is the
 * difference between TCP and UDP" has one interrogative and asks one thing.
 */
export function isMultiPartQuestion(message: string): boolean {
  const matches = message.match(questionWords);
  return (matches?.length ?? 0) > 1;
}

/**
 * Whether a "remember that ..." message carries a second instruction after it.
 *
 * Caught live: "Remember that the server room door code is 4471. Then tell me
 * every door code I have saved." saved the fact correctly and answered with a
 * bare acknowledgement — the trailing request was never even read, because
 * the remember branch returns as soon as it recognises the opening clause.
 * isMultiPartQuestion does not catch this: "tell me" carries no interrogative
 * word at all, and the fact is stated once rather than asked about twice.
 *
 * The first sentence is always assumed to be the memory clause and is
 * skipped; anything sentence after it that reads as a request or a question
 * counts as a second instruction.
 */
export function rememberHasTrailingRequest(message: string): boolean {
  const sentences = message.split(/(?<=[.!?])\s+/).map((sentence) => sentence.trim()).filter(Boolean);
  if (sentences.length < 2) return false;

  return sentences.slice(1).some((sentence) => {
    // "Then tell me ..." reads as a statement on its own: analyzeRequest's
    // recall check is anchored to the start of the sentence, and "then" sits
    // in front of the very phrase ("tell me") that would have matched it. The
    // connective carries no meaning of its own here, so it is dropped before
    // asking what kind of sentence this actually is — the same judgement a
    // reader makes without noticing they made it.
    const withoutConnective = sentence.replace(/^(then|also|and|now|next|plus)\b[,\s]*/i, "");
    const analysis = analyzeRequest(withoutConnective);
    return analysis.shape === "question" || analysis.hasRequestMarker;
  });
}

export const memoryPreference = 2;

/** Openers and acknowledgements that are conversation, not a request for work. */
const greetingPattern = /^(hi|hey|hello|yo|howdy|sup|good\s+(morning|afternoon|evening))\b[\s!.,]*$/i;
const thanksPattern = /^(thanks|thank\s+you|ty|cheers|appreciate\s+it|nice|cool|great|awesome|perfect)\b[\s!.,]*$/i;
const acknowledgementPattern = /^(ok|okay|k|sure|right|got\s+it|fine|yep|yes|no|nope|never\s*mind|nvm|forget\s+it)\b[\s!.,]*$/i;

/**
 * Asking what this thing is, or what it can do.
 *
 * Two different word orders carry the same question, and both have to match.
 * "What can you do?" inverts the verb and subject the way a direct question
 * does; "Explain what you can do" does not — English does not invert inside
 * an embedded clause — so a pattern that only recognised the first missed
 * exactly the phrasing a longer, more detailed capability question actually
 * arrives in. Caught live: a request that opened "Explain what you can do,
 * what tools you have, what permissions you have..." matched none of the
 * original alternatives and fell through to the agent loop, which then
 * called sixteen tools — including three that write — trying to search its
 * way to an answer about itself.
 *
 * The "are you" branch requires a sentence boundary right after "you" —
 * `(?=[?.!,]|\s*$)` — so "who are you" matches but "what are you doing this
 * weekend" does not; without that lookahead the original pattern already
 * matched the second one, since its trailing `(?:\s+do|\s+for\s+me)?` was
 * optional and so satisfied by nothing at all.
 */
const capabilityPattern = new RegExp([
  // "what can you do", "what do you do", "who are you" — direct question
  // order, optionally opening with a greeting.
  String.raw`^(?:so\s+)?(?:hi|hey|hello)?[\s,]*(?:what|who)\s+`
    + String.raw`(?:can\s+you(?:\s+do|\s+for\s+me)?|do\s+you(?:\s+do|\s+for\s+me)?|are\s+you(?=[?.!,]|\s*$))\b`,
  String.raw`^what(?:'s| is)\s+this\b`,
  String.raw`^help$`,
  // "what you can do", "what you're able to do" — embedded-clause order,
  // unanchored: this is normally one clause inside a longer request rather
  // than the whole message.
  String.raw`\bwhat\s+you\s+(?:can|could)\s+do\b`,
  String.raw`\bwhat\s+you(?:'re|\s+are)\s+able\s+to\s+do\b`,
  // "your tools", "your permissions", "your limitations" — a possessive
  // naming one of the assistant's own attributes is a strong, low-risk
  // signal on its own, wherever in the message it falls.
  String.raw`\byour\s+(?:tools?|capabilit(?:y|ies)|features?|permissions?|limitations?|integrations?)\b`,
  // "what tools do you have", "what permissions you have", "what
  // integrations are available" — direct and embedded order again, with room
  // for a common adverb ("currently", "actually") between "have" and its
  // subject, which real phrasing of this question often carries.
  String.raw`\bwhat\s+(?:tools?|permissions?|integrations?|capabilit(?:y|ies)|features?)\s+`
    + String.raw`(?:do\s+you\s+(?:currently\s+|actually\s+|really\s+|now\s+)?have`
    + String.raw`|you\s+(?:currently\s+|actually\s+|really\s+|now\s+)?have|are\s+available)\b`,
  String.raw`\bcapabilit(?:y|ies)\s+(?:tests?|reports?|audits?)\b`,
  String.raw`\bwhat\s+model\s+(?:are\s+you|do\s+you)\b`
].join("|"), "i");

/**
 * What this build can actually do, stated plainly.
 *
 * Worth being exact rather than encouraging: there is no language model here, so
 * a user who expects one will otherwise discover it by asking something ordinary
 * and getting "I don't have anything saved". Saying so up front is the whole
 * difference between a tool with limits and a tool that seems broken.
 */
/**
 * Every registered tool, grouped by what it is allowed to do without being
 * asked — the same ladder toolPermissions.ts and runTool enforce, read from
 * the registry rather than restated. A tool never appears here unless it is
 * genuinely callable, and every tool that is callable appears here: this and
 * the permission gate can never disagree about what exists.
 */
function toolInventorySection(localModel: string | null): string {
  const capabilities = getSystemCapabilities(localModel);
  const groups = toolsByLevel(capabilities);

  const lines = groups.map((group) => {
    const names = group.tools.map((tool) => tool.name).join(", ");
    const needsOk = group.tools.some((tool) => tool.requiresConfirmation)
      ? " — needs your confirmation first"
      : "";
    return `- ${group.label}${needsOk}: ${names}`;
  });

  const missing = [
    !capabilities.web ? "no web or internet access" : null,
    !capabilities.codeExecution ? "no arbitrary code execution" : null,
    capabilities.integrations.length === 0 ? "no third-party integrations connected" : null
  ].filter((entry): entry is string => entry !== null);

  return [
    `Full tool inventory (${capabilities.tools.length} registered):`,
    ...lines,
    missing.length > 0 ? `Also true right now: ${missing.join(", ")}.` : null
  ].filter((line): line is string => line !== null).join("\n");
}

export function buildCapabilityReply(localModel?: string): string {
  // Two different true statements, depending on what is actually running.
  // Claiming there is no model while one is answering would be as wrong as
  // promising one that was never installed, and a user who reads either and
  // then sees the opposite stops believing the rest of this reply.
  const opening = localModel
    ? `I run locally. General questions go to ${localModel} on this machine — nothing leaves it, and there is no API key involved.`
    : "I run locally, with no language model behind me — so I can't answer general questions from world knowledge, and I won't pretend to.";

  const closing = localModel
    ? "What I answer from memory or your documents is quoted with its source. Anything else is written by the model."
    : "Install Ollama and pull a model if you want me to answer general questions too.";

  return [
    opening,
    "",
    "What I can actually do:",
    "- Build a working app from a description. \"Build a task tracker where projects have many tasks\" produces a real REST API with storage, validation and tests.",
    "- Remember things you tell me. Start with \"remember that ...\" and I'll use it later.",
    "- Answer from your documents. Add them under Knowledge and I'll quote the relevant passage back with its source.",
    "- Run flows you build under Automation, and keep your schedule under Calendar.",
    "",
    "Ask me to build something, or tell me a fact to remember.",
    "",
    closing,
    "",
    // Read from the tool registry itself — see systemCapabilities.ts — so
    // this section can never list a tool that was removed or omit one that
    // was added after this paragraph above was written.
    toolInventorySection(localModel ?? null)
  ].join("\n");
}

export function composeReply(input: ComposerInput): ComposedReply {
  const message = input.message.trim();
  const analysis = analyzeRequest(message);
  const history = input.history ?? [];

  // Handled before anything else: these are short and topic-free, so every later
  // branch reads them as a vague work request and answers "tell me your stack
  // and deadline", which is a strange reply to "thanks".
  if (capabilityPattern.test(message)) {
    return { text: buildCapabilityReply(), strategy: "capability", groundedOn: [], groundedOnHistory: 0 };
  }

  if (greetingPattern.test(message)) {
    return {
      text: "Hello. Ask me to build something, tell me a fact to remember, or ask what I can do.",
      strategy: "smalltalk",
      groundedOn: [],
      groundedOnHistory: 0
    };
  }

  if (thanksPattern.test(message)) {
    return { text: "Any time.", strategy: "smalltalk", groundedOn: [], groundedOnHistory: 0 };
  }

  if (acknowledgementPattern.test(message)) {
    return { text: "Noted — say the word when you want something done.", strategy: "smalltalk", groundedOn: [], groundedOnHistory: 0 };
  }

  // Was the previous turn a build clarification? If so this message is the
  // answer, and must reach the build path whatever its grammatical shape —
  // "customers with email and phone" is a bare noun phrase that would otherwise
  // be filed as a passing remark.
  const lastAssistantTurn = [...history].reverse().find((turn) => turn.role === "assistant");
  const previousUserTurn = [...history].reverse().filter((turn) => turn.role === "user")[0];
  const refining = isAwaitingRefinement(lastAssistantTurn?.content) && Boolean(previousUserTurn);

  // A question is answered from saved memory, then from this conversation, or
  // explicitly not answered at all. Skipped while refining: "customers?" in
  // answer to "what are the records?" is a spec, not a question to look up.
  if (analysis.shape === "question" && !refining) {
    const query = resolveQuery(message, history);
    const matches = selectRelevantMemories(query, input.memories);
    const fromKnowledge = selectRelevantMemories(query, input.knowledge ?? [], 2);

    // A fact the user dictated outranks a passage that merely shares vocabulary
    // with the question — but as a preference, not a veto.
    //
    // This used to return on any memory that cleared the threshold, so the
    // knowledge base was never consulted once a memory matched at all. Asked
    // for the rollback procedure, "Deploys happen on Fridays." scored 0.321,
    // barely over the bar, and won outright against the passage holding the
    // actual procedure at 1.575. A five-fold better match was discarded.
    //
    // Multiplicative because these scores are not bounded to 1: a passage has
    // to beat the best memory by a margin, not by a fixed number of points.
    const bestMemory = matches[0]?.score ?? 0;
    const bestPassage = fromKnowledge[0]?.score ?? 0;
    const knowledgeIsDecisivelyBetter = bestPassage > bestMemory * memoryPreference;

    if (matches.length > 0 && !knowledgeIsDecisivelyBetter) {
      return {
        text: `${answerLead(analysis)}\n\n${citeMemories(matches)}\n\nIf that's out of date, tell me and I'll update it.`,
        strategy: "answer",
        groundedOn: matches.map((entry) => entry.memory.id),
        groundedOnHistory: 0,
        // Memory answered something, but the question asked for more than one
        // thing and this covers only whichever part matched.
        partial: isMultiPartQuestion(query)
      };
    }

    if (fromKnowledge.length > 0) {
      // Quoted verbatim with its source named. Matching here is lexical, so the
      // passage is evidence, not an interpretation — presenting it as a settled
      // answer would overstate what a term-overlap match establishes.
      const quoted = fromKnowledge
        .map((entry) => `- "${entry.memory.body}"\n  — ${entry.memory.documentTitle}`)
        .join("\n\n");

      return {
        text: `From your knowledge base:\n\n${quoted}\n\nThat is quoted from the document, not interpreted. If it doesn't answer the question, the wording may just not match.`,
        strategy: "answer",
        groundedOn: fromKnowledge.map((entry) => entry.memory.id),
        groundedOnHistory: 0
      };
    }

    // Nothing saved matches, but the answer may simply have been said earlier.
    const fromHistory = selectRelevantMemories(query, searchableHistory(history), 2);
    if (fromHistory.length > 0) {
      const quoted = fromHistory.map((entry) => `- "${entry.memory.body}"`).join("\n");
      return {
        text: `You mentioned this earlier in our conversation:\n\n${quoted}\n\nSay "remember that ..." if you want me to keep it beyond this session.`,
        strategy: "answer",
        groundedOn: [],
        groundedOnHistory: fromHistory.length
      };
    }

    const stored = input.memories.length;
    const documents = new Set((input.knowledge ?? []).map((entry) => entry.documentId)).size;
    const nothingStored = "I don't have anything saved that answers that yet.";

    // Naming what was searched matters: "nothing matches" reads as "you have
    // nothing", which is wrong and misleading when a document is sitting there
    // that simply uses different words.
    const searched = [
      stored > 0 ? `${stored} saved memor${stored === 1 ? "y" : "ies"}` : "",
      documents > 0 ? `${documents} document${documents === 1 ? "" : "s"}` : ""
    ].filter(Boolean).join(" and ");

    const storedButUnmatched = `I searched ${searched} and nothing matched that question. Matching is on wording, so it may be phrased differently in there.`;

    return {
      text: `${searched === "" ? nothingStored : storedButUnmatched}\n\nTell me the answer and I'll remember it — start with "remember that ..." and it will be saved for next time.`,
      strategy: "no-answer",
      groundedOn: [],
      groundedOnHistory: 0
    };
  }

  // Too little signal to plan against — unless this is itself the answer to
  // an earlier clarifying question, in which case it is judged together with
  // the original request rather than alone. A short, on-topic answer like "a
  // CRM" is vague by itself but is not vague once merged with what it is
  // answering; asking the same clarifying question a second time would leave
  // the conversation unable to progress. Found by inspection while fixing the
  // sibling bug just above at line 483, which already carries this guard.
  if (analysis.vague && !refining) {
    return {
      text: "I need a bit more to work with. Tell me what you're trying to end up with, and any constraint that matters (stack, deadline, audience), and I'll turn it into a concrete plan.",
      strategy: "clarify",
      groundedOn: [],
      groundedOnHistory: 0
    };
  }

  if (/^(remember|note)\b/i.test(message)) {
    const write = input.memoryWrite;

    // Only a confirmed write earns the confirmation.
    if (write && write.saved > 0) {
      return {
        text: "Saved. I'll use that as context from here on — you can review or remove it in the Memory panel.",
        strategy: "acknowledge",
        groundedOn: [],
        groundedOnHistory: 0,
        // "Remember that X. Then tell me Y" saved X correctly and never
        // looked at the trailing "tell me Y" — the branch returns as soon as
        // it recognises the opening clause. Flagged the same way a grounded
        // answer that only covers half a question is flagged.
        partial: rememberHasTrailingRequest(message)
      };
    }

    // Nowhere to save to. Saying "Saved" here is how the user loses a fact they
    // believe is stored, so it names the reason and what to do about it.
    if (write && !write.available) {
      return {
        text: "I can't save that — this request has no session or account to store it against, so it would be lost. Sign in (or send a session id) and tell me again, and it will stick.",
        strategy: "not-saved",
        groundedOn: [],
        groundedOnHistory: 0
      };
    }

    // A session exists but nothing could be pulled out of the sentence.
    return {
      text: "Nothing was saved — I couldn't pick a clear fact out of that. Try \"remember that <subject> is <fact>\", for example \"remember that the deploy server is rack-4\".",
      strategy: "not-saved",
      groundedOn: [],
      groundedOnHistory: 0
    };
  }

  // A plain declarative is information, not a work order. "The API runs on port
  // 4000" should be absorbed, not answered with a three-step delivery plan.
  //
  // This is deliberately independent of mode. The client infers mode from
  // keywords, so merely saying "api" lands you in code mode — which must not by
  // itself turn a statement of fact into a request for work.
  if (analysis.shape === "statement" && !analysis.hasRequestMarker && !refining) {
    return {
      text: "Got it — I'll keep that in mind for this conversation. Say \"remember that ...\" if you want me to hold on to it permanently, or tell me what you'd like done with it.",
      strategy: "acknowledge",
      groundedOn: [],
      groundedOnHistory: 0
    };
  }

  // When refining, the plan is built from the original request plus this reply.
  const buildRequest = refining ? mergeRefinement(previousUserTurn!.content, message) : message;

  const plan = buildTaskPlan(buildRequest, input.mode);

  // Only a create-shaped request produces an app, so only that is worth
  // questioning. Asking someone to specify fields for "fix the flaky test"
  // would be noise.
  if (plan.taskType === "create") {
    const spec = planProject(buildRequest);
    const gaps = findSpecGaps(spec);

    // Never ask twice: if this turn is already the answer, build with what we have.
    if (gaps.length > 0 && !refining) {
      return {
        text: buildClarifyingQuestion(spec, gaps),
        strategy: "clarify-build",
        groundedOn: [],
        groundedOnHistory: 0
      };
    }
  }

  const relevant = selectRelevantMemories(buildRequest, input.memories, 2);
  const constraints = relevant.length
    ? `\n\nConstraints I'm carrying from memory:\n${citeMemories(relevant)}`
    : "";
  const preamble = refining
    ? `Building from: "${buildRequest}"\n\n`
    : "";

  return {
    text: `${preamble}${plan.steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}${constraints}`,
    strategy: "plan",
    planTaskType: plan.taskType,
    groundedOn: relevant.map((entry) => entry.memory.id),
    groundedOnHistory: refining ? 1 : 0,
    buildRequest
  };
}
