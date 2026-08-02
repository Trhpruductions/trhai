export type AssistantMode = "general" | "coding" | "business" | "creator";

export type MemoryContext = {
  title: string;
  body: string;
};

export type HistoryTurn = {
  role: "user" | "assistant";
  content: string;
};

export type ScaffoldSpec = {
  kind: "component" | "page" | "service" | "doc";
  path: string;
  fileName: string;
  content: string;
};

export type PersistedAssistantState = {
  assistantMode: AssistantMode;
  activeModule: string;
  messages: Array<{
    id: string;
    role: "user" | "assistant";
    content: string;
    createdAt: string;
    attachments?: Array<{
      name: string;
      mimeType: string;
      sizeBytes: number;
      previewUrl?: string;
    }>;
  }>;
};

const assistantStateStorageKey = "ascend.assistant.state";

export function readPersistedAssistantState(storage: Storage | undefined): PersistedAssistantState | null {
  if (!storage) return null;

  try {
    const rawValue = storage.getItem(assistantStateStorageKey);
    if (!rawValue) return null;
    const parsed = JSON.parse(rawValue) as Partial<PersistedAssistantState>;
    if (!parsed || typeof parsed !== "object") return null;
    return {
      assistantMode: parsed.assistantMode === "coding" || parsed.assistantMode === "business" || parsed.assistantMode === "creator"
        ? parsed.assistantMode
        : "general",
      activeModule: typeof parsed.activeModule === "string" && parsed.activeModule.trim() ? parsed.activeModule : "Dashboard",
      messages: Array.isArray(parsed.messages) ? parsed.messages.filter((message): message is PersistedAssistantState["messages"][number] => {
        return Boolean(message && typeof message.id === "string" && typeof message.content === "string" && typeof message.createdAt === "string");
      }).map((message) => ({
        ...message,
        attachments: (message.attachments ?? []).map((attachment) => ({
          ...attachment,
          previewUrl: undefined
        }))
      })) : []
    };
  } catch {
    return null;
  }
}

export function writePersistedAssistantState(storage: Storage | undefined, state: PersistedAssistantState): void {
  if (!storage) return;

  try {
    storage.setItem(assistantStateStorageKey, JSON.stringify(state));
  } catch {
    // Ignore persistence errors so the app remains usable offline.
  }
}

export function buildScaffoldSpec(message: string): ScaffoldSpec {
  const normalized = message.toLowerCase();
  const widget = /widget|card|panel|dashboard/i.test(normalized);
  const page = /page|screen|view/i.test(normalized);
  const service = /api|service|backend|route/i.test(normalized);
  const doc = /spec|proposal|plan|requirements|flow|architecture|design/i.test(normalized);
  const todoList = /todo|task list|checklist|task/i.test(normalized);

  if (page) {
    const safeName = toPascalCase(message.split(/\s+/).slice(0, 4).join(" ")) || "FeaturePage";
    return {
      kind: "page",
      path: "apps/web/src/pages/",
      fileName: `${safeName}.tsx`,
      content: `import React from "react";\n\nexport function ${safeName}() {\n  return <section>${safeName} placeholder</section>;\n}\n`
    };
  }

  if (service) {
    const safeName = toPascalCase(message.split(/\s+/).slice(0, 4).join(" ")) || "FeatureService";
    return {
      kind: "service",
      path: "apps/api/src/services/",
      fileName: `${safeName}.ts`,
      content: `export function ${safeName}() {\n  return { ok: true };\n}\n`
    };
  }

  if (doc) {
    const docNameSource = message
      .split(/\bfor\b/i)[1]
      ?.replace(/^(?:the|a|an)\s+/i, "")
      .trim() || message;
    const safeName = toPascalCase(docNameSource) || "FeatureSpec";
    return {
      kind: "doc",
      path: "docs/",
      fileName: `${safeName}.md`,
      content: `# ${safeName}\n\n## Summary\n\n- Objective: ${message}\n- Scope: ${safeName}\n\n## Acceptance Criteria\n\n- The proposal is clearly scoped.\n- The implementation can be reviewed in one pass.\n`
    };
  }

  if (todoList) {
    const safeName = "TodoList";
    return {
      kind: "component",
      path: "apps/web/src/components/",
      fileName: `${safeName}.tsx`,
      content: `import React, { useState } from "react";

export function ${safeName}() {
  const [items, setItems] = useState(["Draft scope", "Review constraints"]);

  return (
    <section className="${safeName.toLowerCase()}">
      <h2>${safeName}</h2>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <p>Sample task list scaffold ready for refinement.</p>
    </section>
  );
}
`
    };
  }

  const inferredName = /dashboard|team|activity|status|analytics/i.test(normalized)
    ? "TeamActivityWidget"
    : /settings|profile|preferences/i.test(normalized)
      ? "SettingsPanel"
      : /chart|graph|metric/i.test(normalized)
        ? "AnalyticsWidget"
        : "FeatureWidget";
  const safeName = inferredName || "FeatureWidget";
  return {
    kind: "component",
    path: "apps/web/src/components/",
    fileName: `${safeName}.tsx`,
    content: `import React from "react";\n\nexport function ${safeName}() {\n  return <div className=\"${safeName.toLowerCase()}\">${safeName}</div>;\n}\n`
  };
}

export function buildDevelopmentPlanDocument(mode: AssistantMode, message: string): string {
  const blueprint = buildDevelopmentBlueprint(mode, message);
  const targetArea = inferTargetArea(message);
  const scaffoldSpec = buildScaffoldSpec(message);
  const scaffoldTarget = `${scaffoldSpec.path}${scaffoldSpec.fileName}`;

  return [
    "## Development Plan",
    "",
    `- Objective: ${message}`,
    `- Mode: ${mode}`,
    `- Suggested Files: ${targetArea}`,
    `- Scaffold Target: ${scaffoldTarget}`,
    "",
    "### Implementation Steps",
    blueprint,
    "",
    "### Acceptance Criteria",
    "- The change is scoped to a narrow slice of functionality.",
    "- The implementation is verified with the relevant build and test step.",
    "- The result is ready for review and refinement."
  ].join("\n");
}

export function buildLocalAssistantResponseBundle(
  mode: AssistantMode,
  message: string,
  memoryContext: MemoryContext[],
  history: HistoryTurn[],
  scaffoldResult?: { path?: string; error?: string }
): { assistantText: string; assistantPlan: string; assistantScaffold: string } {
  const assistantText = buildLocalAssistantReply(mode, message, memoryContext, history);
  const assistantPlan = buildDevelopmentPlanDocument(mode, message);
  const scaffoldSpec = buildScaffoldSpec(message);
  const scaffoldSummary = scaffoldResult?.error
    ? `\n\nScaffold write failed: ${scaffoldResult.error}`
    : scaffoldResult?.path
      ? `\n\nScaffold created at: ${scaffoldResult.path}`
      : "";
  const assistantScaffold = JSON.stringify({
    ...scaffoldSpec,
    ...(scaffoldResult?.path ? { createdPath: scaffoldResult.path } : {})
  }, null, 2);

  return {
    assistantText,
    assistantPlan,
    assistantScaffold: assistantScaffold
      ? `\n\nScaffold Spec:\n\n${assistantScaffold}${scaffoldSummary}`
      : scaffoldSummary
  };
}

export function inferAssistantModeFromContext(moduleName: string, message: string): AssistantMode {
  const normalizedModule = moduleName.toLowerCase();
  const normalizedMessage = message.toLowerCase();

  if (/code|api|service|debug|build|implement|feature|component|widget|test|deploy/i.test(normalizedModule + " " + normalizedMessage)) {
    return "coding";
  }

  if (/business|market|analytics|ops|workflow|launch|plan|strategy|kpi|revenue|finance/i.test(normalizedModule + " " + normalizedMessage)) {
    return "business";
  }

  if (/image|video|music|game|creative|design|story|visual|brand|content/i.test(normalizedModule + " " + normalizedMessage)) {
    return "creator";
  }

  return "general";
}

export function buildPromptForQuickAction(action: string): string {
  const normalized = action.toLowerCase();

  if (normalized.includes("system scan")) {
    return "Run a system scan and summarize the most urgent findings.";
  }

  if (normalized.includes("optimize mission flow")) {
    return "Optimize the current mission flow and propose concrete next steps.";
  }

  if (normalized.includes("automation queue")) {
    return "Open the automation queue and outline the highest-value automation opportunities.";
  }

  if (normalized.includes("new project")) {
    return "Create a new project plan with milestones, stack, and a first implementation sprint.";
  }

  if (normalized.includes("code studio")) {
    return "Open the code studio and outline the first implementation steps for this request.";
  }

  if (normalized.includes("game studio")) {
    return "Outline a game studio build plan with the first milestone and required assets.";
  }

  if (normalized.includes("image studio")) {
    return "Draft an image studio workflow for concept generation and iteration.";
  }

  if (normalized.includes("video studio")) {
    return "Plan a video studio workflow with shot list, timeline, and delivery milestones.";
  }

  if (normalized.includes("music studio")) {
    return "Create a music studio plan for composition, arrangement, and production checkpoints.";
  }

  if (normalized.includes("ai agents")) {
    return "Define the first AI agents workflow and the handoff between automation and review.";
  }

  if (normalized.includes("automation")) {
    return "Propose an automation workflow with clear triggers, actions, and success criteria.";
  }

  return action.trim() || "Start a focused execution plan.";
}

export function buildLocalAssistantReply(
  mode: AssistantMode,
  message: string,
  memoryContext: MemoryContext[],
  history: HistoryTurn[]
): string {
  const memorySummary = memoryContext.slice(0, 3).map((entry) => `- ${entry.title}: ${entry.body}`).join("\n");
  const recentHistory = history.slice(-2).map((turn) => `${turn.role}: ${turn.content}`).join(" | ");
  const intent = detectIntent(message);
  const actionTrack = buildActionTrack(mode, message);
  const blueprint = buildDevelopmentBlueprint(mode, message);

  const prefix =
    mode === "coding"
      ? "Coding mode active."
      : mode === "business"
        ? "Business mode active."
        : mode === "creator"
          ? "Creator mode active."
          : "General mode active.";

  return `${prefix} Local runtime is sustaining mission continuity while uplink is unavailable.\n\nMission Signals:\nIntent: ${intent}\nMemory links: ${memoryContext.length}\nConversation momentum: ${history.length > 0 ? "active" : "new"}\n\nImplementation Blueprint:\n${blueprint}\n\nImmediate Action Track:\n${actionTrack}\n\nContext:\n${memorySummary || "- No workspace memory captured yet."}\n\nRecent history:\n${recentHistory || "- No prior exchanges."}\n\nOperator Request: ${message}`;
}

function detectIntent(message: string): string {
  const value = message.toLowerCase();
  if (/bug|fix|error|issue|fail|broken|debug/.test(value)) return "Stabilization";
  if (/launch|ship|release|deploy|publish/.test(value)) return "Delivery";
  if (/plan|roadmap|strategy|decision|kpi|milestone/.test(value)) return "Planning";
  if (/design|creative|brand|visual|story|ui|ux/.test(value)) return "Creative";
  if (/automate|workflow|pipeline|schedule|agent/.test(value)) return "Automation";
  if (/build|create|develop|implement|feature|widget|component/.test(value)) return "Implementation";
  return "Execution";
}

function buildActionTrack(mode: AssistantMode, message: string): string {
  const compact = message.length > 92 ? `${message.slice(0, 89)}...` : message;

  if (mode === "coding") {
    return [
      `1. Scope implementation boundaries for: ${compact}`,
      "2. Pinpoint failure surfaces and containment checks.",
      "3. Define concrete verification sequence."
    ].join("\n");
  }

  if (mode === "business") {
    return [
      `1. Convert request into owner and milestone lanes: ${compact}`,
      "2. Define measurable outcomes and timing windows.",
      "3. Sequence stakeholder follow-through checkpoints."
    ].join("\n");
  }

  if (mode === "creator") {
    return [
      `1. Shape concept direction around: ${compact}`,
      "2. Define deliverables and quality gates.",
      "3. Prepare launch-ready narrative package."
    ].join("\n");
  }

  return [
    `1. Break the objective into execution lanes: ${compact}`,
    "2. Highlight top risk and fastest win.",
    "3. Produce immediate next-step checklist."
  ].join("\n");
}

function inferTargetArea(message: string): string {
  const normalized = message.toLowerCase();
  if (/dashboard|widget|card|panel/i.test(normalized)) return "apps/web/src/components";
  if (/api|server|route|backend/i.test(normalized)) return "apps/api/src/services";
  if (/desktop|electron/i.test(normalized)) return "apps/desktop/src";
  if (/todo|task list|checklist/i.test(normalized)) return "apps/web/src/components";
  return "apps/web/src";
}

function toPascalCase(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9]+/g, " ").trim();
  if (!normalized) return "Feature";

  const segments = normalized
    .split(/\s+/)
    .filter(Boolean)
    .filter((segment) => !/^(the|a|an)$/i.test(segment));

  return segments
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join("");
}

function buildDevelopmentBlueprint(mode: AssistantMode, message: string): string {
  const targetArea = inferTargetArea(message);
  const implementationNotes = mode === "coding"
    ? [
        `- Start with a small slice of the feature in ${targetArea}.`,
        "- Build the UI or service contract first, then wire state and persistence.",
        "- Add verification hooks so the change can be tested quickly."
      ]
    : [
        `- Frame the request as a milestone plan centered on ${targetArea}.`,
        "- Split the work into experience, integration, and verification steps.",
        "- Capture acceptance criteria that can be reviewed in one pass."
      ];

  return [
    `- Objective: ${message}`,
    `- Target area: ${targetArea}`,
    "- Implementation steps:",
    ...implementationNotes,
    "- Verification: run the relevant build/test command, review the result, and iterate until it is stable."
  ].join("\n");
}
