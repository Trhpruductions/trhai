import { composeReply, type ComposerMemory } from "./replyComposer.js";

type RouteMode = "general" | "build" | "code" | "debug" | "research" | "plan" | "coding" | "business" | "creator";

export type ModelReply = {
  model: string;
  output: string;
  inputTokens: number;
  outputTokens: number;
  /** How the reply was produced, for provenance and telemetry. */
  strategy: string;
  /** The text a build should be generated from (original + clarifying answer). */
  buildRequest?: string;
  /** Memory ids the reply was actually grounded on. */
  groundedOn: string[];
  /** Conversation turns the reply was actually grounded on. */
  groundedOnHistory: number;
};

export type MemoryContext = {
  id?: string;
  title: string;
  body: string;
  pinned?: boolean;
  createdAt?: string;
};

export type ConversationTurn = {
  role: "user" | "assistant";
  content: string;
};

export type ModelPrompt = {
  mode: RouteMode;
  userMessage: string;
  memoryContext?: MemoryContext[];
  history?: ConversationTurn[];
};

export class ModelRouter {
  async generate(prompt: ModelPrompt): Promise<ModelReply> {
    const normalized = prompt.userMessage.trim();
    const model = this.pickModel(prompt.mode);
    const composed = composeReply({
      mode: prompt.mode,
      message: normalized,
      memories: toComposerMemories(prompt.memoryContext ?? []),
      history: prompt.history ?? []
    });

    return {
      model,
      output: composed.text,
      inputTokens: estimateTokens(normalized),
      outputTokens: estimateTokens(composed.text),
      strategy: composed.strategy,
      buildRequest: composed.buildRequest,
      groundedOn: composed.groundedOn,
      groundedOnHistory: composed.groundedOnHistory
    };
  }

  private pickModel(mode: RouteMode): string {
    const codingModes: RouteMode[] = ["build", "code", "debug", "research", "plan", "coding"];
    if (codingModes.includes(mode)) return "coding-core-v1";
    if (mode === "business") return "business-core-v1";
    if (mode === "creator") return "creator-core-v1";
    return "general-core-v1";
  }

}

/** Memory entries reach the router in a few shapes; normalize for scoring. */
function toComposerMemories(entries: MemoryContext[]): ComposerMemory[] {
  return entries.map((entry, index) => ({
    id: entry.id ?? `memory-${index}`,
    title: entry.title,
    body: entry.body,
    pinned: entry.pinned ?? false,
    createdAt: entry.createdAt ?? new Date(0).toISOString()
  }));
}

function estimateTokens(value: string): number {
  if (!value) return 0;
  return Math.ceil(value.length / 4);
}
