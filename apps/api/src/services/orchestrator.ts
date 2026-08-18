import { ModelRouter, type ComposerKnowledge, type MemoryWriteOutcome } from "./modelRouter.js";
import { checkAvailability, generate, readLocalModelConfig } from "./localModel.js";
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
   * rather than the assistant claiming otherwise.
   */
  saveMemory?: (fact: string) => boolean;
  /** Removes a saved memory by id, for the "forget" tool. */
  forgetMemory?: (id: string) => boolean;
  /** Documents in this session, for the document tools. */
  documents?: Array<{ id: string; title: string; body: string }>;
  /** Saves a new document, for the "write_document" tool. */
  saveDocument?: (title: string, body: string) => boolean;
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
  const isCannedPlan = modelReply.strategy === "plan" && modelReply.planTaskType !== "create";
  if (modelReply.strategy === "no-answer" || isCannedPlan) {
    const generated = await answerWithLocalModel(input);
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
  input: OrchestratorInput
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
  const result = await runAgent({ ...config, model: availability.model }, input.userMessage, {
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
    saveDocument: input.saveDocument
  });

  return result.ok
    ? { text: result.text, model: `ollama/${result.model}`, toolsUsed: result.toolsUsed }
    : null;
}
