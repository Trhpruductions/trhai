import { ModelRouter, type ComposerKnowledge, type MemoryWriteOutcome } from "./modelRouter.js";
import { checkAvailability, generate, readLocalModelConfig } from "./localModel.js";

export type OrchestratorInput = {
  mode: "general" | "build" | "code" | "debug" | "research" | "plan" | "coding" | "business" | "creator";
  userMessage: string;
  memoryContext?: Array<{ id?: string; title: string; body: string; pinned?: boolean; createdAt?: string }>;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  /** What actually happened to memory this turn; see MemoryWriteOutcome. */
  memoryWrite?: MemoryWriteOutcome;
  /** Knowledge passages available to ground an answer. */
  knowledge?: ComposerKnowledge[];
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

  // The deterministic path had nothing, so try a local model if one is running.
  // Only this branch is eligible: a reply grounded in saved memory or a document
  // is an exact quote with a source, and must never be replaced by a generation.
  if (modelReply.strategy === "no-answer") {
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
        buildRequest: modelReply.buildRequest,
        groundedOn: [],
        groundedOnHistory: 0
      };
    }
  }

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
async function answerWithLocalModel(input: OrchestratorInput): Promise<{ text: string; model: string } | null> {
  const config = readLocalModelConfig();
  const availability = await checkAvailability(config);
  if (!availability.available) return null;

  const context = (input.memoryContext ?? []).slice(0, 5).map((entry) => entry.body);
  const result = await generate({ ...config, model: availability.model }, {
    question: input.userMessage,
    context
  });

  return result.ok ? { text: result.text, model: `ollama/${result.model}` } : null;
}
