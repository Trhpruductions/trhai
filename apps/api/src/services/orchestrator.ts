import { ModelRouter } from "./modelRouter.js";

export type OrchestratorInput = {
  mode: "general" | "coding" | "business" | "creator";
  userMessage: string;
  memoryContext?: Array<{ title: string; body: string }>;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
};

export type OrchestratorResult = {
  model: string;
  assistantMessage: string;
  inputTokens: number;
  outputTokens: number;
};

const modelRouter = new ModelRouter();

export async function runAssistantOrchestrator(
  input: OrchestratorInput
): Promise<OrchestratorResult> {
  const modelReply = await modelRouter.generate({
    mode: input.mode,
    userMessage: input.userMessage,
    memoryContext: input.memoryContext,
    history: input.history
  });

  return {
    model: modelReply.model,
    assistantMessage: modelReply.output,
    inputTokens: modelReply.inputTokens,
    outputTokens: modelReply.outputTokens
  };
}
