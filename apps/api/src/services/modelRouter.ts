type RouteMode = "general" | "coding" | "business" | "creator";

export type ModelReply = {
  model: string;
  output: string;
  inputTokens: number;
  outputTokens: number;
};

export type MemoryContext = {
  title: string;
  body: string;
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
    const output = this.buildReply(prompt.mode, normalized, prompt.memoryContext ?? [], prompt.history ?? []);

    return {
      model,
      output,
      inputTokens: estimateTokens(normalized),
      outputTokens: estimateTokens(output)
    };
  }

  private pickModel(mode: RouteMode): string {
    if (mode === "coding") return "coding-core-v1";
    if (mode === "business") return "business-core-v1";
    if (mode === "creator") return "creator-core-v1";
    return "general-core-v1";
  }

  private buildReply(mode: RouteMode, message: string, memoryContext: MemoryContext[], history: ConversationTurn[]): string {
    const memorySummary = memoryContext.slice(0, 3).map((entry) => `- ${entry.title}: ${entry.body}`).join("\n");
    const recentHistory = history.slice(-2).map((turn) => `${turn.role}: ${turn.content}`).join(" | ");
    const intent = detectIntent(message);
    const actionTrack = buildActionTrack(mode, message);
    const stance = buildStance(mode, intent);

    const signalBlock = [
      `Intent: ${intent}`,
      `Memory links: ${memoryContext.length}`,
      `Conversation momentum: ${history.length > 0 ? "active" : "new"}`
    ].join("\n");

    if (mode === "coding") {
      return `Coding mode active. ${stance}\n\nMission Signals:\n${signalBlock}\n\nImmediate Action Track:\n${actionTrack}\n\nContext:\n${memorySummary || "- No workspace memory captured yet."}\n\nRecent history:\n${recentHistory || "- No prior exchanges."}\n\nOperator Request: ${message}`;
    }

    if (mode === "business") {
      return `Business mode active. ${stance}\n\nMission Signals:\n${signalBlock}\n\nImmediate Action Track:\n${actionTrack}\n\nContext:\n${memorySummary || "- No workspace memory captured yet."}\n\nRecent history:\n${recentHistory || "- No prior exchanges."}\n\nOperator Request: ${message}`;
    }

    if (mode === "creator") {
      return `Creator mode active. ${stance}\n\nMission Signals:\n${signalBlock}\n\nImmediate Action Track:\n${actionTrack}\n\nContext:\n${memorySummary || "- No workspace memory captured yet."}\n\nRecent history:\n${recentHistory || "- No prior exchanges."}\n\nOperator Request: ${message}`;
    }

    return `General mode active. ${stance}\n\nMission Signals:\n${signalBlock}\n\nImmediate Action Track:\n${actionTrack}\n\nContext:\n${memorySummary || "- No workspace memory captured yet."}\n\nRecent history:\n${recentHistory || "- No prior exchanges."}\n\nOperator Request: ${message}`;
  }
}

function detectIntent(message: string): string {
  const value = message.toLowerCase();
  if (/bug|fix|error|issue|fail|broken/.test(value)) return "Stabilization";
  if (/launch|ship|release|deploy/.test(value)) return "Delivery";
  if (/plan|roadmap|strategy|decision|kpi/.test(value)) return "Planning";
  if (/design|creative|brand|visual|story/.test(value)) return "Creative";
  if (/automate|workflow|pipeline|schedule/.test(value)) return "Automation";
  return "Execution";
}

function buildStance(mode: RouteMode, intent: string): string {
  const modeLabel = mode === "coding"
    ? "engineering"
    : mode === "business"
      ? "operations"
      : mode === "creator"
        ? "creative"
        : "mission";

  return `AI core is in ${modeLabel} stance, aligned to ${intent.toLowerCase()} objectives.`;
}

function buildActionTrack(mode: RouteMode, message: string): string {
  const compact = message.length > 92 ? `${message.slice(0, 89)}...` : message;

  if (mode === "coding") {
    return [
      `1. Scope implementation boundaries for: ${compact}`,
      "2. Identify risk points and prevention safeguards.",
      "3. Define validation checks and expected outcomes."
    ].join("\n");
  }

  if (mode === "business") {
    return [
      `1. Convert request into owner + milestone lanes: ${compact}`,
      "2. Attach measurable KPI targets and risk controls.",
      "3. Sequence execution in weekly decision checkpoints."
    ].join("\n");
  }

  if (mode === "creator") {
    return [
      `1. Translate objective into creative direction: ${compact}`,
      "2. Define production assets and review gates.",
      "3. Package launch-ready deliverables and narrative hooks."
    ].join("\n");
  }

  return [
    `1. Break request into action lanes: ${compact}`,
    "2. Surface highest-impact next move and blocker risks.",
    "3. Produce immediate follow-up checklist for execution."
  ].join("\n");
}

function estimateTokens(value: string): number {
  if (!value) return 0;
  return Math.ceil(value.length / 4);
}
