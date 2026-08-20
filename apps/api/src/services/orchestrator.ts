import { ModelRouter, type ComposerKnowledge, type MemoryWriteOutcome } from "./modelRouter.js";
import { checkAvailability, generate, orderedCandidates, readLocalModelConfig } from "./localModel.js";
import { buildCapabilityReply } from "./replyComposer.js";
import { runAgent } from "./agentLoop.js";

export type OrchestratorInput = {
  mode: "general" | "build" | "code" | "debug" | "research" | "plan" | "coding" | "business" | "creator";
  userMessage: string;
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
  /** Tools the assistant actually called, in order. Empty when it used none. */
  toolsUsed?: string[];
  /** Memory ids the reply was actually grounded on, not merely retrieved. */
  groundedOn: string[];
  /** Conversation turns the reply was actually grounded on, not merely sent. */
  groundedOnHistory: number;
};

const modelRouter = new ModelRouter();

export async function runAssistantOrchestrator(
  input: OrchestratorInput
): Promise<OrchestratorResult> {
  const modelReply = await modelRouter.generate({
    mode: input.mode,
    userMessage: input.userMessage,
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

    const generated = await answerWithLocalModel(input, known, question);
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
  askAs?: string
): Promise<{ text: string; model: string; toolsUsed: string[] } | null> {
  const config = readLocalModelConfig();
  const availability = await checkAvailability(config);
  if (!availability.available) return null;

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
    // The transcript the request already carries, so "what did I just ask you"
    // is answerable without saving every turn to memory first.
    conversation: input.history
  });

    if (result.ok) {
      return { text: result.text, model: `ollama/${result.model}`, toolsUsed: result.toolsUsed };
    }

    // Only a model that could not be loaded is worth replacing. One that
    // loaded and then failed to answer will fail the same way again, and
    // trying every installed model against it just makes the user wait.
    if (!result.modelUnusable) return null;
    console.warn(`[assist] ${result.reason}`);
  }

  if (attempted.length > 0) {
    console.error(`[assist] no local model could be loaded; tried ${attempted.join(", ")}`);
  }

  return null;
}

