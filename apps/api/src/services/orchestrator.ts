import { ModelRouter, type ComposerKnowledge, type MemoryWriteOutcome } from "./modelRouter.js";
import { checkAvailability, generate, orderedCandidates, readLocalModelConfig } from "./localModel.js";
import { buildCapabilityReply } from "./replyComposer.js";
import { runAgent, type ToolOutcome } from "./agentLoop.js";
import { setActivity } from "./agentActivity.js";
import { isContinuationRequest } from "./requestAnalysis.js";
import { detectTaskType } from "./taskPlanning.js";
import { getResumableTask, recordTask, updateTask } from "./taskStore.js";
import {
  consumePendingConfirmation,
  describePendingAction,
  getPendingConfirmation,
  isAffirmative,
  recordPendingConfirmation
} from "./pendingConfirmation.js";

export type OrchestratorInput = {
  mode: "general" | "build" | "code" | "debug" | "research" | "plan" | "coding" | "business" | "creator";
  userMessage: string;
  /** Present only when there is a session to report live tool activity against. */
  sessionId?: string;
  memoryContext?: Array<{ id?: string; title: string; body: string; pinned?: boolean; createdAt?: string }>;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  /** What actually happened to memory this turn; see MemoryWriteOutcome. */
  memoryWrite?: MemoryWriteOutcome;
  /** Knowledge passages available to ground an answer. */
  knowledge?: ComposerKnowledge[];
  /**
   * Writes a fact to memory for the "remember" tool. Omitted when there is
   * nowhere to write, in which case the tool reports that nothing was saved
   * rather than the assistant claiming otherwise. "duplicate" is a success —
   * the fact is already there — not a failure to report as one.
   */
  saveMemory?: (fact: string) => "saved" | "duplicate" | "empty";
  /** Removes a saved memory by id, for the "forget" tool. */
  forgetMemory?: (id: string) => boolean;
  /** Documents in this session, for the document tools. */
  documents?: Array<{ id: string; title: string; body: string }>;
  /** Saves a new document, for the "write_document" tool. */
  saveDocument?: (title: string, body: string) => boolean;
  /** Replaces a document's body, for the "update_document" tool. */
  updateDocument?: (id: string, body: string) => boolean;
  /** Deletes a document, for the "delete_document" tool. */
  deleteDocument?: (id: string) => boolean;
  /** Pins or unpins a memory, for the "pin_memory" tool. */
  pinMemory?: (id: string, pinned: boolean) => boolean;
  /**
   * Fired with each new piece of a generated reply, for callers that can show
   * it arriving. Optional throughout: without it every request is made and
   * answered exactly as before.
   *
   * Only ever fires on the branch that reaches a model. A reply quoted from
   * saved memory or a stored document is not generated a token at a time and
   * has nothing to stream — it is already whole when it is found.
   */
  onToken?: (text: string) => void;
};

export type OrchestratorResult = {
  model: string;
  assistantMessage: string;
  inputTokens: number;
  outputTokens: number;
  /** How the reply was produced. */
  strategy: string;
  /** The text a build should be generated from, when this was a build request. */
  buildRequest?: string;
  /**
   * Tools the assistant actually called, in order, each with whether it
   * achieved anything. Empty when it used none.
   */
  toolsUsed?: ToolOutcome[];
  /**
   * A destructive action waiting on the user's approval.
   *
   * Present only when the permission gate refused something this turn. The
   * client renders a confirmation dialog from it; without this the refusal
   * is only a sentence in the reply, and the user has to know to type "yes".
   */
  pendingConfirmation?: { tool: string; verb: string; target: string };
  /** Memory ids the reply was actually grounded on, not merely retrieved. */
  groundedOn: string[];
  /** Conversation turns the reply was actually grounded on, not merely sent. */
  groundedOnHistory: number;
};

const modelRouter = new ModelRouter();

export async function runAssistantOrchestrator(
  input: OrchestratorInput
): Promise<OrchestratorResult> {
  // An affirmative answers the offer that is actually standing, or it is
  // ordinary conversation. Consumed rather than merely read, so one "yes"
  // cannot authorise a second destructive action later in the same session.
  //
  // A null here is a real answer: "yes" with nothing pending grants nothing
  // at all, which is the whole point of holding the offer rather than
  // trusting the word on its own. Checked before continuation because the
  // two overlap — "do it" is both — and answering a standing offer to delete
  // something is the more specific reading.
  const approving = input.sessionId && isAffirmative(input.userMessage)
    ? consumePendingConfirmation(input.sessionId)
    : null;

  // A continuation carries no content of its own — "do it" is two words with
  // nothing to act on. What it means is entirely in the task it refers back
  // to, so that task's request is what the rest of this function works from.
  //
  // When nothing is resumable the message is left exactly as it arrived. It
  // then reaches the composer's vague branch and asks what to do, which is
  // the honest answer: inventing a task here to look responsive is the
  // failure this whole store exists to prevent.
  const resuming = input.sessionId && !approving && isContinuationRequest(input.userMessage)
    ? getResumableTask(input.sessionId)
    : null;

  const effectiveMessage = approving
    ? approving.request
    : resuming
      ? resuming.request
      : input.userMessage;

  if (resuming && input.sessionId) {
    updateTask(input.sessionId, { status: "executing" });
  }

  const modelReply = await modelRouter.generate({
    mode: input.mode,
    userMessage: effectiveMessage,
    memoryContext: input.memoryContext,
    history: input.history,
    memoryWrite: input.memoryWrite,
    knowledge: input.knowledge
  });

  // "What can you do?" must describe what is actually wired up right now, so the
  // one branch whose answer depends on the backend asks before answering.
  if (modelReply.strategy === "capability") {
    const config = readLocalModelConfig();
    const availability = await checkAvailability(config);
    if (availability.available) {
      return {
        ...toResult(modelReply),
        assistantMessage: buildCapabilityReply(`ollama/${availability.model}`)
      };
    }
  }

  // The deterministic path had nothing, so try a local model if one is running.
  // Only this branch is eligible: a reply grounded in saved memory or a document
  // is an exact quote with a source, and must never be replaced by a generation.
  // Eligible when the deterministic path had no answer, and also when it fell
  // back to a generic plan for something that is not a build. "Explain what a
  // REST API is" was answered with "1. Clarify the end state ... 2. Identify the
  // highest-impact next move", which is a template, not an answer. Only a
  // "create" request produces an app, so only there is the plan worth keeping.
  // Every plan is now eligible, including a "create" one.
  //
  // That exception existed because a create request produced a scaffold the
  // model could not, so the deterministic plan was the better answer. The
  // assistant can build the app itself now, and keeping the exception made
  // build_app unreachable from a conversation: "build me an app to track
  // invoices" returned a four-step plan and never called the tool that would
  // have built it.
  const isPlan = modelReply.strategy === "plan";

  // A grounded answer or a confirmed save that only covers part of the
  // message is also eligible.
  //
  // Two live failures of the same shape. "Which database does my billing run
  // on, and what is today's date?" matched memory on the database, returned
  // that answer whole, and dropped the date half without a word. "Remember
  // that the server room door code is 4471. Then tell me every door code I
  // have saved." saved the fact and answered with a bare "Saved." — the
  // remember branch returns as soon as it recognises the opening clause and
  // never reads what follows. Both are covered by the same partial flag; the
  // agent can call search_memory, list_memories or current_datetime and
  // answer the rest, and if there is no model to ask, the partial reply below
  // still stands, because half an answer beats none.
  const isPartialAnswer = modelReply.partial === true
    && (modelReply.strategy === "answer" || modelReply.strategy === "acknowledge");

  if (modelReply.strategy === "no-answer" || isPlan || isPartialAnswer) {
    // When the deterministic path already found or just wrote the fact, hand
    // it over rather than making the model search for it again. Asked the
    // database and the date, memory had matched the database — and the
    // agent's own search_memory then came back empty and it reported the
    // database as unrecorded. Rediscovering a fact we are already holding is
    // a coin flip we do not need to take.
    const known = isPartialAnswer
      ? modelReply.strategy === "answer"
        ? modelReply.groundedOn.map((id) => input.memoryContext?.find((entry) => entry.id === id))
          .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
          .map((entry) => entry.body)
        // The acknowledge case: groundedOn is empty, since nothing was
        // searched — this was a write, not a retrieval. What was actually
        // written is what needs to be handed over instead.
        : input.memoryWrite?.savedBodies ?? []
      : [];

    // A "plan" reply's buildRequest is the merged text — the original request
    // plus a clarifying answer, when there was one — while input.userMessage
    // is only ever this single turn. Caught live: "Build me something to help
    // my business", then asked to clarify, answered "customers with email,
    // phone and company". The composer correctly merged those into one build
    // request and returned strategy "plan" — and the agent was then handed
    // only the current turn, "customers with email, phone and company", with
    // no idea it was ever about a build. It searched the user's documents for
    // "customers" and reported finding nothing. Passing the merged text here
    // is what the composer already computed and this branch already trusts;
    // not using it was passing up the answer sitting one line above.
    //
    // For a "create" plan specifically, the deterministic path has already
    // decided this is a build — that is the entire reason this branch exists.
    // The agent still gets to choose its own tool, and on the next attempt at
    // this exact scenario it chose plan_app over build_app: it worked out
    // what the app would contain, correctly, and then invented a description
    // of a "Build screen" with a "Plan" selector that this app does not have,
    // rather than building anything. Stating the right tool by name is the
    // same move already proven twice on this branch — the date stated
    // outright rather than left to current_datetime, a fact stated as already
    // saved rather than left to the model's own search — because a model that
    // is told what to do and does something else anyway is not fixed by
    // asking more politely; it is fixed by removing the choice that goes
    // wrong.
    const question = isPlan && modelReply.buildRequest
      ? modelReply.planTaskType === "create"
        ? `${modelReply.buildRequest}\n\nCall build_app with this. Not plan_app — the user wants it `
          + `actually built, not described. Do not stop at explaining what it would contain.`
        : modelReply.buildRequest
      : undefined;

    // This branch is where real work happens — it is the one that reaches the
    // agent and its tools. Recording here rather than on every turn keeps the
    // store to things there is actually something to resume, instead of
    // filing a "task" for every greeting.
    if (input.sessionId && !resuming) {
      recordTask(input.sessionId, {
        request: effectiveMessage,
        taskType: detectTaskType(effectiveMessage),
        status: "executing"
      });
    }

    const generated = await answerWithLocalModel(
      { ...input, userMessage: effectiveMessage },
      known,
      question,
      // Authorised for this turn only, and only for the exact tool the user
      // was asked about. An approval does not become a standing permission.
      approving ? new Set([approving.tool]) : undefined
    );

    // The gate refused something. Hold the offer open so the user's "yes"
    // has a specific action to attach to, rather than being read as blanket
    // permission for whatever comes next.
    if (input.sessionId && generated?.awaitingConfirmation) {
      recordPendingConfirmation(input.sessionId, {
        tool: generated.awaitingConfirmation.tool,
        arguments: generated.awaitingConfirmation.arguments,
        request: effectiveMessage
      });
    }

    if (input.sessionId) {
      updateTask(input.sessionId, generated
        ? {
          status: "succeeded",
          // Names only: the task store is a record of what ran, not the
          // source of a user-facing label.
          toolsUsed: generated.toolsUsed.map((used) => used.name),
          lastResult: generated.text
        }
        // No local model to ask. The work did not fail on its merits — it never
        // ran — so it stays resumable and says why, rather than being recorded
        // as a failure or quietly dropped.
        : { status: "blocked", error: "No local model was available to run this." });
    }

    // Read back rather than reconstructed, so what the dialog offers is
    // exactly what a later approval will consume.
    const nowPending = input.sessionId ? getPendingConfirmation(input.sessionId) : null;
    const described = nowPending ? describePendingAction(nowPending) : null;

    if (generated) {
      return {
        model: generated.model,
        assistantMessage: generated.text,
        inputTokens: modelReply.inputTokens,
        outputTokens: estimateTokens(generated.text),
        // A distinct strategy: this was written by a model, not quoted from
        // anything the user saved, and the client labels provenance from it.
        strategy: "generated",
        toolsUsed: generated.toolsUsed,
        ...(nowPending && described
          ? { pendingConfirmation: { tool: nowPending.tool, ...described } }
          : {}),
        // No build offer here. Only a "create" plan survives to be built, and
        // neither case that reaches this branch is one — so carrying the
        // discarded plan's build request through put a "Build this" button
        // under a two-sentence explanation of what a mutex is.
        buildRequest: undefined,
        groundedOn: [],
        groundedOnHistory: 0
      };
    }
  }

  return toResult(modelReply);
}

function toResult(modelReply: Awaited<ReturnType<ModelRouter["generate"]>>): OrchestratorResult {
  return {
    model: modelReply.model,
    assistantMessage: modelReply.output,
    inputTokens: modelReply.inputTokens,
    outputTokens: modelReply.outputTokens,
    strategy: modelReply.strategy,
    buildRequest: modelReply.buildRequest,
    groundedOn: modelReply.groundedOn,
    groundedOnHistory: modelReply.groundedOnHistory
  };
}

/** Rough token estimate, matching the router's own accounting. */
function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

/**
 * Ask a local model, or return null if there is not one to ask.
 *
 * Availability is checked per request rather than cached. A user starts Ollama
 * after the API, or stops it mid-session, and a cached "unavailable" would keep
 * the feature dark until a restart for no reason the user could see.
 */
async function answerWithLocalModel(
  input: OrchestratorInput,
  /** Facts already retrieved for this question, so the model need not re-find them. */
  known: string[] = [],
  /**
   * What to actually ask, when it differs from input.userMessage — the merged
   * buildRequest for a "plan" turn, which carries an earlier turn's context
   * that the current message alone does not.
   */
  askAs?: string,
  /** Tool names the user authorised this turn; see the permission ladder. */
  confirmedActions?: ReadonlySet<string>
): Promise<{
  text: string;
  model: string;
  toolsUsed: ToolOutcome[];
  awaitingConfirmation?: { tool: string; arguments: Record<string, unknown> };
} | null> {
  const config = readLocalModelConfig();
  const availability = await checkAvailability(config);
  if (!availability.available) return null;

  const { sessionId } = input;
  const onToolStart = sessionId ? (tool: string) => setActivity(sessionId, tool) : undefined;

  // The agent loop rather than a single completion.
  //
  // A one-shot call could only work with whatever context happened to be
  // attached to the request, which meant the model saw at most a handful of
  // memories and never the documents. Here it asks for what it needs and gets
  // the real thing back — and can follow one lookup with another.
  // Stated as fact rather than as a hint, and stated as already saved rather
  // than merely found. Without "do not save it again", a remember-then-ask
  // turn handed the fact over correctly and the model still called remember
  // on it a second time — redundant at best, and confusing when that second,
  // unnecessary write failed and the reply had to explain a failure that
  // never needed to happen.
  const baseQuestion = askAs ?? input.userMessage;

  const question = known.length > 0
    ? `${baseQuestion}\n\nAlready in the user's saved memory — it is stored, do not save it again, `
      + `just use it directly:\n`
      + known.map((fact) => `- ${fact}`).join("\n")
    : baseQuestion;

  // Worked down in order rather than betting on one.
  //
  // A model that is listed is not a model that will load. Asked to answer,
  // Ollama returned 500 "cudaMalloc failed: out of memory" for the 8B model
  // and a failed CPU buffer allocation for the 3B one — while the app went on
  // reporting the first as available and silently falling back on every single
  // question, with nothing on screen to say why.
  const candidates = orderedCandidates(config.model, availability.installedModels, config.modelFromEnv ?? true);
  const attempted: string[] = [];

  for (const model of candidates) {
    attempted.push(model);
    const result = await runAgent({ ...config, model }, question, {
    memories: (input.memoryContext ?? []).map((entry, index) => ({
      id: entry.id ?? `memory-${index}`,
      title: entry.title,
      body: entry.body,
      pinned: entry.pinned ?? false,
      createdAt: entry.createdAt ?? new Date(index).toISOString()
    })),
    knowledge: (input.knowledge ?? []).map((entry) => ({
      id: entry.id,
      title: entry.title,
      body: entry.body,
      pinned: entry.pinned ?? false,
      createdAt: entry.createdAt,
      documentTitle: entry.documentTitle
    })),
    saveMemory: input.saveMemory,
    forgetMemory: input.forgetMemory,
    documents: input.documents,
    saveDocument: input.saveDocument,
    updateDocument: input.updateDocument,
    deleteDocument: input.deleteDocument,
    pinMemory: input.pinMemory,
    confirmedActions,
    // The transcript the request already carries, so "what did I just ask you"
    // is answerable without saving every turn to memory first.
    conversation: input.history
  }, fetch, onToolStart, input.onToken);

    if (result.ok) {
      return {
        text: result.text,
        model: `ollama/${result.model}`,
        toolsUsed: result.toolsUsed,
        ...(result.awaitingConfirmation ? { awaitingConfirmation: result.awaitingConfirmation } : {})
      };
    }

    // Only a model that could not be loaded, or that produced nothing at all,
    // is worth replacing. One that loaded and answered badly will answer
    // badly again, and trying every installed model against it just makes the
    // user wait.
    //
    // Logged either way. This used to return null in silence, which meant a
    // model failing mid-conversation was invisible: the caller fell back to a
    // deterministic reply that looks like a deliberate answer, and nothing
    // anywhere said the model had been asked and had failed.
    if (!result.modelUnusable) {
      console.warn(`[assist] ${model} could not answer: ${result.reason}`);
      return null;
    }
    console.warn(`[assist] ${model} unusable: ${result.reason}`);
  }

  if (attempted.length > 0) {
    console.error(`[assist] no local model could be loaded; tried ${attempted.join(", ")}`);
  }

  return null;
}

