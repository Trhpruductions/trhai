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
};

export type ComposedReply = {
  text: string;
  /** What the composer decided to do — surfaced for telemetry and tests. */
  strategy: "answer" | "no-answer" | "plan" | "clarify" | "acknowledge" | "clarify-build" | "not-saved";
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

export function composeReply(input: ComposerInput): ComposedReply {
  const message = input.message.trim();
  const analysis = analyzeRequest(message);
  const history = input.history ?? [];

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

    if (matches.length > 0) {
      return {
        text: `${answerLead(analysis)}\n\n${citeMemories(matches)}\n\nIf that's out of date, tell me and I'll update it.`,
        strategy: "answer",
        groundedOn: matches.map((entry) => entry.memory.id),
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
    const nothingStored = "I don't have anything saved that answers that yet.";
    const storedButUnmatched = `I have ${stored} saved memor${stored === 1 ? "y" : "ies"}, but none of them match that question.`;

    return {
      text: `${stored === 0 ? nothingStored : storedButUnmatched}\n\nTell me the answer and I'll remember it — start with "remember that ..." and it will be saved for next time.`,
      strategy: "no-answer",
      groundedOn: [],
      groundedOnHistory: 0
    };
  }

  // Too little signal to plan against.
  if (analysis.vague) {
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
        groundedOnHistory: 0
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
    groundedOn: relevant.map((entry) => entry.memory.id),
    groundedOnHistory: refining ? 1 : 0,
    buildRequest
  };
}
