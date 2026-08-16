import { ModelRouter, type MemoryWriteOutcome } from "./modelRouter.js";

export type OrchestratorInput = {
  mode: "general" | "build" | "code" | "debug" | "research" | "plan" | "coding" | "business" | "creator";
  userMessage: string;
  memoryContext?: Array<{ id?: string; title: string; body: string; pinned?: boolean; createdAt?: string }>;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  /** What actually happened to memory this turn; see MemoryWriteOutcome. */
  memoryWrite?: MemoryWriteOutcome;
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
    memoryWrite: input.memoryWrite
  });

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
