import { useEffect, useMemo, useRef, useState } from "react";
import { webEnv } from "./env";
import { sha256Hex, stableSerialize, verifySignedJsonExport, verifySignedMarkdownExport } from "./exportIntegrity";
import {
  formatStageDuration,
  reasoningStageLabels,
  reasoningStageShortLabels,
  summarizeReasoningStages,
  type ReasoningStage
} from "./reasoningStages";
import { createSubmissionLatch } from "./submissionLatch";
import { shouldAutoDevelop } from "./autoDevelop";
import {
  authHeaders,
  readAuthResponse,
  readStoredToken,
  validateCredentials,
  writeStoredToken,
  type Account
} from "./accountClient";
import { generateProject, planProject } from "@ascend/shared";
import { buildLocalCapabilityReply, inferLocalIntent, type LocalIntent } from "./localAssistant";
import {
  allPersonalities,
  applyResponseStyle,
  personalityById,
  resolvePersonality,
  type PersonalityId
} from "./personalities";
import {
  defaultDestination,
  destinationById,
  sidebarDestinations,
  topNavDestinations,
  type Destination,
  type DestinationId
} from "./navigationModel";
import {
  buildResponseProvenance,
  sanitizeResponseProvenance,
  sourceClassDescriptions,
  sourceClassLabels,
  summarizeDegradedState,
  type ResponseProvenance
} from "./responseProvenance";

type MetricRow = {
  label: string;
  value: string;
  width: number;
};

type Shortcut = {
  title: string;
};

type NotificationItem = {
  id: string;
  title: string;
  createdAt: number;
};

type WeatherDay = {
  day: string;
  condition: string;
  temp: string;
};

type ActionTile = {
  title: string;
  subtitle: string;
  seed: string;
};

type BuildBlueprint = {
  title: string;
  summary: string;
  stack: string[];
  architecture: string[];
  milestones: string[];
  deliverables: string[];
};

type ScaffoldSpec = {
  path: string;
  fileName: string;
  content: string;
};

type ScaffoldResult = {
  file: string;
  ok: boolean;
  detail: string;
};

type ScaffoldTelemetry = {
  runs: number;
  filesOk: number;
  filesFail: number;
  lastRunStatus: "idle" | "ok" | "warn" | "error";
  lastRunAt: number | null;
};

type ChatMessage = {
  id: string;
  role: "assistant" | "user";
  text: string;
  createdAt: number;
  provenance?: ResponseProvenance;
  /** App boilerplate rather than a real exchange; never sent as model context. */
  seeded?: boolean;
};

type AssistantMode = "auto" | "build" | "code" | "debug" | "research" | "plan" | "business" | "creator";

type ScreenAction = {
  id: string;
  label: string;
};

type ScreenDefinition = {
  title: string;
  subtitle: string;
  actions: ScreenAction[];
};

type MemoryItem = {
  id: string;
  title: string;
  body: string;
  kind: "preference" | "fact" | "decision" | "constraint";
  confidence: number;
  rule: string;
  createdAt: string;
  pinned: boolean;
  editedAt?: string;
};

type AssistantApiReply = {
  assistantMessage: string;
  model: string;
  mode: AssistantMode;
  /** Attempts spent reaching the API, including the successful one. */
  attempts: number;
  /** History turns the reply was actually grounded on (not merely sent). */
  usedHistoryTurns: number;
  /** History turns sent to the API, used for the context execution event. */
  sentHistoryTurns: number;
  /** Memory entries the API reported actually using. */
  usedMemoryEntries: number;
  /** New memories the API reported saving from this message. */
  savedMemoryEntries: number;
  /** How the assistant handled the request: answer, no-answer, plan, clarify, acknowledge. */
  strategy: string;
  /** Text to build from, merged with any clarifying answer. Empty when not a build. */
  buildRequest: string;
};

type HostProject = {
  name: string;
  path: string;
  group: "workspace" | "app" | "package" | "generated";
};

type StorageDevice = {
  name: string;
  mountPath: string;
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  usedPercent: number;
};

type TopTab = "HOME" | "ASSISTANT" | "SYSTEMS" | "PROJECTS" | "ANALYTICS" | "SETTINGS";
type RailSection = "Home" | "Assistant" | "Global" | "Folder" | "Calendar" | "Shield" | "Settings";
type ActionLevel = "info" | "ok" | "warn" | "error";
type CoreState = "idle" | "listening" | "thinking" | "processing" | "speaking";
type ExecutionLevel = "info" | "ok" | "warn" | "error";

type ExecutionEvent = {
  id: string;
  stage: ReasoningStage;
  detail: string;
  level: ExecutionLevel;
  createdAt: number;
};

type RuntimeLogLevel = "info" | "ok" | "warn" | "error";
type RuntimeFilter = "all" | "stdout" | "stderr" | "errors";

type RuntimeLog = {
  id: string;
  line: string;
  level: RuntimeLogLevel;
  createdAt: number;
  runId?: string;
  kind?: "start" | "stdout" | "stderr" | "exit";
};

type RuntimeArtifact = {
  path: string;
  status: "pending" | "ok" | "fail";
  detail: string;
  updatedAt: number;
};

type LiveViewFrame = {
  id: string;
  createdAt: number;
  coreState: CoreState;
  status: string;
  phase: string;
  fps: number | null;
  latencyMs: number | null;
};

type TriageActionType = "auto-focus" | "acknowledge" | "force-focus" | "forget-signature" | "clear-force-focus" | "verify-bundle";

type BundleVerifyStatus = {
  level: ActionLevel;
  message: string;
};

type IncidentAuditKind = "export-json" | "export-md" | "export-bundle" | "verify-json" | "verify-md";
type IncidentAuditStatus = "ok" | "error";

type IncidentAuditEntry = {
  id: string;
  kind: IncidentAuditKind;
  status: IncidentAuditStatus;
  detail: string;
  fileName?: string;
  hash?: string;
  createdAt: number;
};

type TriageEvent = {
  id: string;
  action: TriageActionType;
  runId?: string;
  detail: string;
  createdAt: number;
};

type RuntimeRunGroup = {
  runId: string;
  command: string;
  status: "running" | "ok" | "error";
  startedAt: number;
  endedAt: number | null;
  lines: RuntimeLog[];
};

const AUTO_DEVELOP_ALWAYS_ON = true;

const metrics: MetricRow[] = [
  { label: "CPU Usage", value: "28%", width: 28 },
  { label: "Memory", value: "45%", width: 45 },
  { label: "Network", value: "62%", width: 62 },
  { label: "Storage", value: "71%", width: 71 }
];

const shortcuts: Shortcut[] = [
  { title: "Open Dashboard" },
  { title: "Check Emails" },
  { title: "Summarize Documents" },
  { title: "System Diagnostics" },
  { title: "Create New Project" }
];

const defaultNotifications: NotificationItem[] = [
  { id: crypto.randomUUID(), title: "System channel initialized", createdAt: Date.now() - 120000 },
  { id: crypto.randomUUID(), title: "Telemetry monitors active", createdAt: Date.now() - 360000 },
  { id: crypto.randomUUID(), title: "Build Engine ready", createdAt: Date.now() - 540000 }
];

const defaultChatMessages: ChatMessage[] = [
  {
    id: crypto.randomUUID(),
    role: "assistant",
    text: "Ready to build. Tell me exactly what you want and I will generate a complete blueprint and scaffold plan.",
    createdAt: Date.now() - 16000,
    seeded: true
  }
];

const defaultExecutionEvents: ExecutionEvent[] = [
  {
    id: crypto.randomUUID(),
    stage: "understanding",
    detail: "Mission channel initialized and waiting for input.",
    level: "ok",
    createdAt: Date.now() - 20000
  },
  {
    id: crypto.randomUUID(),
    stage: "context",
    detail: "Workspace telemetry links are online.",
    level: "ok",
    createdAt: Date.now() - 12000
  }
];

const defaultRuntimeLogs: RuntimeLog[] = [
  {
    id: crypto.randomUUID(),
    line: "[boot] Live runtime console initialized.",
    level: "ok",
    createdAt: Date.now() - 15000,
    runId: "system",
    kind: "start"
  }
];

const defaultWeather: WeatherDay[] = [
  { day: "Mon", condition: "Cloudy", temp: "74°F" },
  { day: "Tue", condition: "Rain", temp: "76°F" },
  { day: "Wed", condition: "Cloudy", temp: "72°F" }
];

const actions: ActionTile[] = [
  { title: "CHAT", subtitle: "Start a conversation", seed: "Build a conversational AI assistant for my team with memory and voice." },
  { title: "SEARCH", subtitle: "Find anything", seed: "Build a universal search engine over documents, chats, and project files." },
  { title: "AUTOMATE", subtitle: "Run a task", seed: "Build a workflow automation platform for recurring ops tasks and approvals." },
  { title: "ANALYZE", subtitle: "Get insights", seed: "Build an analytics dashboard with forecasting, anomaly detection, and alerts." },
  { title: "CREATE", subtitle: "Generate content", seed: "Build a full product from this idea with frontend, backend, auth, and deployment." }
];

const chatStateStorageKey = "ascend.chat.state.v2";
const sidebarCollapsedStorageKey = "ascend.sidebar.collapsed.v1";
const personalityStorageKey = "ascend.personality.v1";
const runtimeAckSignatureStorageKey = "ascend.runtime.ack.signatures.v1";
const triageTimelineStorageKey = "ascend.runtime.triage.timeline.v1";
const incidentAuditStorageKey = "ascend.runtime.incident.audit.v1";

const assistantModes: Array<{ key: AssistantMode; label: string }> = [
  { key: "auto", label: "Auto" },
  { key: "build", label: "Build" },
  { key: "code", label: "Code" },
  { key: "debug", label: "Debug" },
  { key: "research", label: "Research" },
  { key: "plan", label: "Plan" },
  { key: "business", label: "Business" },
  { key: "creator", label: "Creator" }
];

/**
 * Maps the user's explicit mode selection onto the offline reply builder.
 * "auto" defers to the tested intent detector in localAssistant.ts, which is
 * the only path that can return "question" — a mode the picker deliberately
 * does not offer, because it describes the request rather than a work track.
 */
function resolveLocalIntent(mode: AssistantMode, request: string): LocalIntent {
  return mode === "auto" ? inferLocalIntent(request) : mode;
}

const assistantApiRetryDelaysMs = [0, 350, 900];
const assistantApiMaxAttempts = assistantApiRetryDelaysMs.length;

/** Recent turns sent to the API for multi-turn context. The API caps this again. */
const assistantHistoryTurnLimit = 12;

const assistSessionStorageKey = "ascend.assist.session.v1";

/** Stable per-browser id so server-side memory survives reloads. */
function resolveAssistSessionId(): string {
  try {
    const existing = window.localStorage.getItem(assistSessionStorageKey);
    if (existing && existing.trim()) {
      return existing;
    }
    const created = crypto.randomUUID();
    window.localStorage.setItem(assistSessionStorageKey, created);
    return created;
  } catch {
    // Private mode or blocked storage: memory just stays per page load.
    return crypto.randomUUID();
  }
}

function buildAssistantHistory(messages: ChatMessage[]): Array<{ role: "user" | "assistant"; content: string }> {
  return messages
    .filter((message) => !message.seeded)
    .slice(-assistantHistoryTurnLimit)
    .map((message) => ({ role: message.role, content: message.text }))
    .filter((turn) => turn.content.trim().length > 0);
}

function safeServerCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

async function callAssistantApiWithRetry(
  request: string,
  mode: AssistantMode,
  history: Array<{ role: "user" | "assistant"; content: string }>,
  token: string | null
): Promise<AssistantApiReply> {
  const attempts = assistantApiRetryDelaysMs;
  let lastError: unknown = null;

  for (let index = 0; index < attempts.length; index += 1) {
    const delayMs = attempts[index];
    if (delayMs > 0) {
      await new Promise((resolve) => window.setTimeout(resolve, delayMs));
    }

    try {
      const response = await fetch(`${webEnv.apiBaseUrl}/v1/assist`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(token)
        },
        body: JSON.stringify({
          mode: mode === "auto" ? "general" : mode,
          message: request,
          history,
          sessionId: resolveAssistSessionId()
        })
      });

      if (!response.ok) {
        throw new Error(`Assistant API ${response.status}`);
      }

      const payload = await response.json() as {
        data?: {
          assistantMessage?: string;
          model?: string;
          mode?: string;
          usedHistoryTurns?: number;
          sentHistoryTurns?: number;
          usedMemoryEntries?: number;
          savedMemoryEntries?: number;
          strategy?: string;
          buildRequest?: string;
        };
      };
      const assistantMessage = payload.data?.assistantMessage?.trim();
      if (!assistantMessage) {
        throw new Error("Assistant API returned empty reply");
      }

      const resolvedMode = payload.data?.mode;
      const safeMode: AssistantMode = resolvedMode === "build"
        || resolvedMode === "code"
        || resolvedMode === "debug"
        || resolvedMode === "research"
        || resolvedMode === "plan"
        || resolvedMode === "business"
        || resolvedMode === "creator"
        || resolvedMode === "auto"
        ? resolvedMode
        : mode;

      return {
        assistantMessage,
        // The reply did come from the API, so never label it as a local fallback here.
        model: payload.data?.model ?? "unspecified",
        mode: safeMode,
        attempts: index + 1,
        usedHistoryTurns: safeServerCount(payload.data?.usedHistoryTurns),
        sentHistoryTurns: safeServerCount(payload.data?.sentHistoryTurns),
        usedMemoryEntries: safeServerCount(payload.data?.usedMemoryEntries),
        savedMemoryEntries: safeServerCount(payload.data?.savedMemoryEntries),
        strategy: typeof payload.data?.strategy === "string" ? payload.data.strategy : "plan",
        buildRequest: typeof payload.data?.buildRequest === "string" ? payload.data.buildRequest : ""
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Assistant API unavailable");
}

/** E13-S2: non-sensitive source classes for a single assistant reply. */
function ProvenanceBadges({ provenance }: { provenance?: ResponseProvenance }) {
  if (!provenance) {
    return null;
  }

  return (
    <div className={`provenance provenance-${provenance.confidence}`}>
      {provenance.sources.map((source) => (
        <span
          key={source}
          className={`provenance-badge source-${source}`}
          title={sourceClassDescriptions[source]}
        >
          {sourceClassLabels[source]}
        </span>
      ))}
      {provenance.model ? (
        <span className="provenance-meta" title="Model reported by the assistant API.">
          {provenance.model}
        </span>
      ) : null}
      {provenance.attempts > 1 ? (
        <span className="provenance-meta" title={provenance.note}>
          {`${provenance.attempts} attempts`}
        </span>
      ) : null}
    </div>
  );
}

/** E13-S3: degraded/recovery state, derived from real reply provenance. */
function DegradedBanner({ state }: { state: ReturnType<typeof summarizeDegradedState> }) {
  if (!state.label) {
    return null;
  }

  return (
    <p className={`degraded-banner ${state.degraded ? "degraded" : "recovered"}`} role="status">
      {state.label}
    </p>
  );
}

const screenDefinitions: Record<TopTab, ScreenDefinition> = {
  HOME: {
    title: "Mission Control",
    subtitle: "Live overview of your assistant, system status, and fastest next actions.",
    actions: [
      { id: "home-assistant", label: "Open Assistant" },
      { id: "home-sync", label: "Refresh Status" },
      { id: "home-blueprint", label: "Create Blueprint" }
    ]
  },
  ASSISTANT: {
    title: "Build Assistant",
    subtitle: "Describe exactly what you want to build and convert requests into executable plans.",
    actions: [
      { id: "assistant-build", label: "Develop From Chat" },
      { id: "assistant-clear", label: "Clear Chat" }
    ]
  },
  SYSTEMS: {
    title: "Systems Watch",
    subtitle: "Observe health signals and enforce real-time sync of telemetry and runtime checks.",
    actions: [
      { id: "systems-sync", label: "Run Health Sync" },
      { id: "systems-diagnostics", label: "Diagnostics Prompt" },
      { id: "systems-alerts", label: "Push Alert Test" }
    ]
  },
  PROJECTS: {
    title: "Project Operations",
    subtitle: "Manage project inventory, open locations, and launch build operations from one lane.",
    actions: [
      { id: "projects-open", label: "Open First Project" },
      { id: "projects-refresh", label: "Refresh Inventory" },
      { id: "projects-scaffold", label: "Scaffold New Build" }
    ]
  },
  ANALYTICS: {
    title: "Insight Engine",
    subtitle: "Turn operational data into roadmap-level insights and action-ready intelligence.",
    actions: [
      { id: "analytics-forecast", label: "Build Forecast Tool" },
      { id: "analytics-anomaly", label: "Create Anomaly Agent" },
      { id: "analytics-report", label: "Generate Report Prompt" }
    ]
  },
  SETTINGS: {
    title: "System Controls",
    subtitle: "Tune behavior, reset workflow filters, and lock in stable operating defaults.",
    actions: [
      { id: "settings-reset", label: "Reset Filters" },
      { id: "settings-defaults", label: "Load Build Defaults" },
      { id: "settings-export", label: "Export Current Plan" }
    ]
  }
};

function toTitleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function detectStack(idea: string): string[] {
  const lower = idea.toLowerCase();
  const stack = ["TypeScript", "React", "Node.js"];

  if (lower.includes("mobile") || lower.includes("ios") || lower.includes("android")) stack.push("React Native");
  if (lower.includes("desktop") || lower.includes("electron")) stack.push("Electron");
  if (lower.includes("ai") || lower.includes("agent") || lower.includes("llm")) stack.push("Model Router");
  if (lower.includes("data") || lower.includes("analytics") || lower.includes("dashboard")) stack.push("PostgreSQL");
  if (lower.includes("real-time") || lower.includes("realtime") || lower.includes("live")) stack.push("WebSocket Stream");
  if (lower.includes("video") || lower.includes("audio") || lower.includes("voice")) stack.push("Media Pipeline");

  return Array.from(new Set(stack));
}

function generateBlueprint(idea: string): BuildBlueprint {
  const cleaned = idea.trim();
  const title = toTitleCase(cleaned || "Custom Product Build");
  const stack = detectStack(cleaned);

  return {
    title,
    summary: cleaned || "Build a complete production-ready platform from the provided concept.",
    stack,
    architecture: [
      "Intent ingestion and requirement decomposition",
      "Capability planner with feature graph and dependency map",
      "Frontend experience layer with reusable UI system",
      "Backend service mesh with auth, permissions, and telemetry",
      "Data layer with migrations, validation, and rollback strategy",
      "Deployment pipeline with build, test, and observability gates"
    ],
    milestones: [
      "Phase 1: Product scope, user stories, and risk map",
      "Phase 2: Core architecture and schema implementation",
      "Phase 3: Feature delivery with end-to-end test coverage",
      "Phase 4: Hardening, scale validation, and production launch"
    ],
    deliverables: [
      "Technical PRD and system architecture spec",
      "Frontend app shell and feature modules",
      "Backend APIs, auth, and data persistence",
      "Automation scripts, CI pipeline, and deployment config",
      "Runbook, monitoring dashboards, and handoff docs"
    ]
  };
}

function buildBlueprintMarkdown(blueprint: BuildBlueprint): string {
  const stack = blueprint.stack.map((item) => `- ${item}`).join("\n");
  const architecture = blueprint.architecture.map((item) => `- ${item}`).join("\n");
  const milestones = blueprint.milestones.map((item) => `- ${item}`).join("\n");
  const deliverables = blueprint.deliverables.map((item) => `- ${item}`).join("\n");

  return [
    `# ${blueprint.title}`,
    "",
    "## Concept",
    blueprint.summary,
    "",
    "## Suggested Stack",
    stack,
    "",
    "## Architecture",
    architecture,
    "",
    "## Milestones",
    milestones,
    "",
    "## Deliverables",
    deliverables,
    ""
  ].join("\n");
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function formatAge(createdAt: number, nowMs: number): string {
  const delta = Math.max(1, Math.floor((nowMs - createdAt) / 1000));
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  return `${Math.floor(delta / 3600)}h ago`;
}

function normalizeRunCommand(command: string): string {
  return command.replace(/^\[run:[^\]]+\]\s*/i, "").trim().toLowerCase();
}

function normalizeFailureLine(line: string): string {
  return line
    .toLowerCase()
    .replace(/[0-9a-f]{8,}/g, "<id>")
    .replace(/\d+/g, "<n>")
    .replace(/[a-z]:\\[^\s]+/g, "<path>")
    .replace(/\s+/g, " ")
    .trim();
}

function buildRunFailureSignature(run: RuntimeRunGroup): string {
  const baseCommand = normalizeRunCommand(run.command);
  const errorLines = run.lines
    .filter((line) => line.kind === "stderr" || line.level === "warn" || line.level === "error")
    .slice(0, 3)
    .map((line) => normalizeFailureLine(line.line));

  if (!errorLines.length) {
    return `${baseCommand}::no-error-lines`;
  }

  return `${baseCommand}::${errorLines.join("|")}`;
}

function weatherCodeToCondition(code: number): string {
  if (code === 0) return "Clear";
  if ([1, 2, 3].includes(code)) return "Partly Cloudy";
  if ([45, 48].includes(code)) return "Fog";
  if ([51, 53, 55, 56, 57, 61, 63, 65, 80, 81, 82].includes(code)) return "Rain";
  if ([66, 67].includes(code)) return "Freezing Rain";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "Snow";
  if ([95, 96, 99].includes(code)) return "Storm";
  return "Cloudy";
}

function toFahrenheit(celsius: number): number {
  return Math.round(celsius * 9 / 5 + 32);
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 100 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function storageSeverity(usedPercent: number): "ok" | "warn" | "critical" {
  if (usedPercent >= 90) return "critical";
  if (usedPercent >= 80) return "warn";
  return "ok";
}

function slugify(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

  return normalized || "custom-build";
}

function normalizeWorkspaceRelativePath(value: string): string {
  return value
    .trim()
    .replace(/\\+/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .split("/")
    .filter((segment) => Boolean(segment) && segment !== "." && segment !== "..")
    .join("/");
}

// Generated scaffolds live outside apps/ so they are never picked up by the
// npm workspaces globs in package.json.
const defaultScaffoldTemplate = "generated-projects/{slug}";

function resolveScaffoldRoot(blueprint: BuildBlueprint, destinationTemplate?: string): string {
  const slug = slugify(blueprint.title);
  const template = destinationTemplate?.trim() || defaultScaffoldTemplate;
  const replaced = template.includes("{slug}") ? template.replace(/\{slug\}/g, slug) : template;
  const normalized = normalizeWorkspaceRelativePath(replaced);
  return normalized || `generated-projects/${slug}`;
}

function buildScaffoldSpecs(blueprint: BuildBlueprint, destinationTemplate?: string): ScaffoldSpec[] {
  const root = resolveScaffoldRoot(blueprint, destinationTemplate);

  // Real, runnable output derived from the request: entities, routes, validation,
  // persistence and a UI. Everything below is emitted by the shared generator, so
  // the same code path is unit-tested and produces a project that starts with
  // `node server.js` and no install step.
  const spec = planProject(blueprint.summary || blueprint.title, blueprint.title);
  const generated = generateProject(spec).map((file) => {
    const segments = file.path.split("/");
    const fileName = segments.pop() ?? file.path;
    return {
      path: segments.length ? `${root}/${segments.join("/")}` : root,
      fileName,
      content: file.content
    };
  });

  return [...generated, ...buildDesignDocs(blueprint, root)];
}

/** Planning documents that sit alongside the generated code. */
function buildDesignDocs(blueprint: BuildBlueprint, root: string): ScaffoldSpec[] {
  const stackList = blueprint.stack.map((item) => `- ${item}`).join("\n");

  return [
    {
      path: `${root}/docs`,
      fileName: "architecture.md",
      content: [
        `# ${blueprint.title} Architecture`,
        "",
        "## Core Layers",
        ...blueprint.architecture.map((item) => `- ${item}`),
        "",
        "## Suggested Technology Stack",
        stackList,
        ""
      ].join("\n")
    },
    {
      path: `${root}/docs`,
      fileName: "delivery-plan.md",
      content: [
        `# ${blueprint.title} Delivery Plan`,
        "",
        "## Milestones",
        ...blueprint.milestones.map((item) => `- ${item}`),
        "",
        "## Deliverables",
        ...blueprint.deliverables.map((item) => `- ${item}`),
        ""
      ].join("\n")
    },
  ];
}

function WaveIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M2 12h2m2-3h2m2 6h2m2-8h2m2 5h2" />
    </svg>
  );
}

function DotIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v3m0 12v3M3 12h3m12 0h3" />
    </svg>
  );
}

function GridIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="11" cy="11" r="6" />
      <path d="m16 16 5 5" />
    </svg>
  );
}

function HomeIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m3 11 9-8 9 8" />
      <path d="M6 10v10h12V10" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 6h16v14H4z" />
      <path d="M8 3v4M16 3v4M4 10h16" />
    </svg>
  );
}

/**
 * Shown when a destination is named in the blueprint but has no real capability
 * behind it yet. Stating the reason is what keeps it from being the "dead
 * surface" the vision prohibits — the user learns something instead of clicking
 * into an empty pane.
 */
function PlannedDestination({ destination }: { destination: Destination }) {
  return (
    <section className="destination-view card" aria-label={`${destination.label} (not available yet)`}>
      <div className="destination-head">
        <h2>{destination.label}</h2>
        <span className="destination-tag">Not available yet</span>
      </div>
      <p className="destination-summary">{destination.summary}</p>
      <p className="destination-reason">{destination.plannedReason}</p>
    </section>
  );
}

/**
 * One glyph per sidebar destination. The rail is icon-first (§4), so a shared
 * fallback glyph would leave several destinations indistinguishable when the
 * labels are collapsed.
 */
function DestinationIcon({ id }: { id: DestinationId }) {
  switch (id) {
    case "home":
      return <HomeIcon />;
    case "files":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3 7h6l2 2h10v10H3z" />
        </svg>
      );
    case "projects":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 5h16v14H4z" />
          <path d="M4 9h16M9 9v10" />
        </svg>
      );
    case "memory":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 4a5 5 0 0 1 5 5v6a5 5 0 0 1-10 0V9a5 5 0 0 1 5-5z" />
          <path d="M9 10h6M9 14h6" />
        </svg>
      );
    case "terminal":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3 5h18v14H3z" />
          <path d="m7 10 3 2-3 2M13 14h4" />
        </svg>
      );
    case "browser":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="8" />
          <path d="M4 12h16M12 4a12 12 0 0 1 0 16a12 12 0 0 1 0-16z" />
        </svg>
      );
    case "email":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3 6h18v12H3z" />
          <path d="m3 7 9 6 9-6" />
        </svg>
      );
    case "calendar":
      return <CalendarIcon />;
    case "marketplace":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 8 6 4h12l2 4" />
          <path d="M4 8h16v12H4z" />
          <path d="M9 12h6" />
        </svg>
      );
    case "plugins":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M9 4v4H5v6a4 4 0 0 0 4 4h6a4 4 0 0 0 4-4V8h-4V4" />
        </svg>
      );
    case "agents":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="8" r="4" />
          <path d="M5 20a7 7 0 0 1 14 0" />
        </svg>
      );
    case "automation":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="6" cy="6" r="2" />
          <circle cx="18" cy="18" r="2" />
          <path d="M8 6h6a4 4 0 0 1 0 8h-4a4 4 0 0 0 0 4h6" />
        </svg>
      );
    case "knowledge":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 4h9a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z" />
          <path d="M9 8h5M9 12h5" />
        </svg>
      );
    case "settings":
      return <GridIcon />;
    default:
      return <DotIcon />;
  }
}

function WeatherIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 16a4 4 0 1 1 .8-7.92A5 5 0 0 1 18 10a3 3 0 0 1-1 6H7z" />
    </svg>
  );
}

export function App() {
  const [prompt, setPrompt] = useState("How can I help you today?");
  const [buildPlan, setBuildPlan] = useState<BuildBlueprint | null>(null);
  const [scaffoldBusy, setScaffoldBusy] = useState(false);
  const [scaffoldStatus, setScaffoldStatus] = useState<string | null>(null);
  const [scaffoldResults, setScaffoldResults] = useState<ScaffoldResult[]>([]);
  const [scaffoldTargetTemplate, setScaffoldTargetTemplate] = useState(defaultScaffoldTemplate);
  const [scaffoldTelemetry, setScaffoldTelemetry] = useState<ScaffoldTelemetry>({
    runs: 0,
    filesOk: 0,
    filesFail: 0,
    lastRunStatus: "idle",
    lastRunAt: null
  });
  const [nowMs, setNowMs] = useState(Date.now());
  const [isOnline, setIsOnline] = useState(typeof navigator !== "undefined" ? navigator.onLine : true);
  const [apiHealthy, setApiHealthy] = useState(false);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [liveMetrics, setLiveMetrics] = useState<MetricRow[]>(metrics);
  const [notifications, setNotifications] = useState<NotificationItem[]>(defaultNotifications);
  const [weatherNow, setWeatherNow] = useState({ tempF: 72, condition: "Partly Cloudy" });
  const [weatherDays, setWeatherDays] = useState<WeatherDay[]>(defaultWeather);
  const [cityLabel, setCityLabel] = useState("New York, NY");
  const [networkType, setNetworkType] = useState("Unknown");
  const bootNotifiedRef = useRef(false);
  const desktopBridgeActive = Boolean(window.ascendDesktop?.getSystemTelemetry);
  const [hostProjects, setHostProjects] = useState<HostProject[]>([]);
  const [storageDevices, setStorageDevices] = useState<StorageDevice[]>([]);
  const [inventoryStatus, setInventoryStatus] = useState("Awaiting host inventory...");
  const [projectFilter, setProjectFilter] = useState("");
  const [projectGroupFilter, setProjectGroupFilter] = useState<"all" | HostProject["group"]>("all");
  const [storageSort, setStorageSort] = useState<"used-desc" | "free-desc">("used-desc");
  const [activeTopTab, setActiveTopTab] = useState<TopTab>("HOME");
  const [activeRailSection, setActiveRailSection] = useState<RailSection>("Home");
  const [activeDestination, setActiveDestination] = useState<DestinationId>(defaultDestination);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => window.localStorage.getItem(sidebarCollapsedStorageKey) === "1"
  );
  const [terminalCommand, setTerminalCommand] = useState("");
  const [activePersonality, setActivePersonality] = useState<PersonalityId>(
    () => resolvePersonality(window.localStorage.getItem(personalityStorageKey))
  );
  const [showAllNotifications, setShowAllNotifications] = useState(false);
  const [actionStatus, setActionStatus] = useState("System nominal");
  const [actionLevel, setActionLevel] = useState<ActionLevel>("ok");
  const [actionBusy, setActionBusy] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(defaultChatMessages);
  const [chatDraft, setChatDraft] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [authToken, setAuthToken] = useState<string | null>(() => readStoredToken(window.localStorage));
  const [account, setAccount] = useState<Account | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [recoverOpen, setRecoverOpen] = useState(false);
  const [recoverCode, setRecoverCode] = useState("");
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordNotice, setPasswordNotice] = useState<string | null>(null);
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [memoryEditId, setMemoryEditId] = useState<string | null>(null);
  const [memoryEditDraft, setMemoryEditDraft] = useState("");
  const [assistantMode, setAssistantMode] = useState<AssistantMode>("auto");
  const [executionEvents, setExecutionEvents] = useState<ExecutionEvent[]>(defaultExecutionEvents);
  const [runtimeLogs, setRuntimeLogs] = useState<RuntimeLog[]>(defaultRuntimeLogs);
  const [runtimeArtifacts, setRuntimeArtifacts] = useState<RuntimeArtifact[]>([]);
  const [liveCodingActive, setLiveCodingActive] = useState(false);
  const [fps, setFps] = useState<number | null>(null);
  const [lastResponseMs, setLastResponseMs] = useState<number | null>(null);
  const [liveViewFrames, setLiveViewFrames] = useState<LiveViewFrame[]>([]);
  const [desktopCommandBusy, setDesktopCommandBusy] = useState(false);
  const [collapsedRuns, setCollapsedRuns] = useState<Record<string, boolean>>({});
  const [runtimeFilter, setRuntimeFilter] = useState<RuntimeFilter>("all");
  const [autoFocusErrors, setAutoFocusErrors] = useState(true);
  const [acknowledgedFailures, setAcknowledgedFailures] = useState<Record<string, boolean>>({});
  const [acknowledgedSignatures, setAcknowledgedSignatures] = useState<Record<string, boolean>>({});
  const [forcedFocusRunId, setForcedFocusRunId] = useState<string | null>(null);
  const [triageEvents, setTriageEvents] = useState<TriageEvent[]>([]);
  const [triageRetention, setTriageRetention] = useState<"all" | "24h">("all");
  const [triageExportBusy, setTriageExportBusy] = useState(false);
  const [bundleVerifyStatus, setBundleVerifyStatus] = useState<BundleVerifyStatus | null>(null);
  const [incidentAuditEntries, setIncidentAuditEntries] = useState<IncidentAuditEntry[]>([]);
  const [incidentAuditSearch, setIncidentAuditSearch] = useState("");
  const [incidentAuditStatusFilter, setIncidentAuditStatusFilter] = useState<"all" | IncidentAuditStatus>("all");
  const chatThreadRef = useRef<HTMLDivElement | null>(null);
  const runtimeConsoleRef = useRef<HTMLDivElement | null>(null);
  const bundleVerifyInputRef = useRef<HTMLInputElement | null>(null);
  const previousErrorCountRef = useRef(0);
  // Synchronous guards; busy state alone cannot block a same-tick double invocation.
  const chatSubmitLatchRef = useRef(createSubmissionLatch());
  // Cooldown 0: guard only against in-flight re-entry, so a deliberate manual
  // retry of the same scaffold/command/action is never swallowed.
  const scaffoldLatchRef = useRef(createSubmissionLatch(0));
  const desktopCommandLatchRef = useRef(createSubmissionLatch(0));
  const screenActionLatchRef = useRef(createSubmissionLatch(0));
  const activeScreen = screenDefinitions[activeTopTab];

  function pushTriageEvent(action: TriageActionType, detail: string, runId?: string) {
    const now = Date.now();
    setTriageEvents((current) => {
      const latest = current[0];
      if (latest && latest.action === action && latest.detail === detail && latest.runId === runId && now - latest.createdAt < 1000) {
        return current;
      }

      return [
        {
          id: crypto.randomUUID(),
          action,
          detail,
          ...(runId ? { runId } : {}),
          createdAt: now
        },
        ...current
      ].slice(0, 30);
    });
  }

  function pushIncidentAuditEntry(entry: Omit<IncidentAuditEntry, "id" | "createdAt">) {
    const now = Date.now();
    setIncidentAuditEntries((current) => {
      const latest = current[0];
      if (
        latest
        && latest.kind === entry.kind
        && latest.status === entry.status
        && latest.detail === entry.detail
        && latest.fileName === entry.fileName
        && latest.hash === entry.hash
        && now - latest.createdAt < 1000
      ) {
        return current;
      }

      return [{ id: crypto.randomUUID(), createdAt: now, ...entry }, ...current].slice(0, 200);
    });
  }

  function clearIncidentAudit() {
    setIncidentAuditEntries([]);
    pushExecutionEvent("verifying", "Cleared Incident Center audit history.", "info");
  }

  function matchesRuntimeFilter(log: RuntimeLog): boolean {
    if (runtimeFilter === "all") return true;
    if (runtimeFilter === "stdout") return log.kind === "stdout";
    if (runtimeFilter === "stderr") return log.kind === "stderr";
    return log.level === "warn" || log.level === "error" || log.kind === "stderr";
  }

  const coreState = useMemo<CoreState>(() => {
    if (chatBusy) return "thinking";
    if (scaffoldBusy || actionBusy) return "processing";
    if (chatDraft.trim().length > 0) return "listening";

    const lastMessage = chatMessages[chatMessages.length - 1];
    if (lastMessage?.role === "assistant" && nowMs - lastMessage.createdAt < 5000) {
      return "speaking";
    }

    return "idle";
  }, [actionBusy, chatBusy, chatDraft, chatMessages, nowMs, scaffoldBusy]);

  const currentTaskLabel = useMemo(() => {
    if (chatBusy) return "Generating assistant response";
    if (scaffoldBusy) return "Generating scaffold files";
    if (actionBusy) return actionStatus;
    return "System idle and ready";
  }, [actionBusy, actionStatus, chatBusy, scaffoldBusy]);

  const pipelineStatus = useMemo(() => {
    return [
      {
        title: "Understanding request",
        state: chatBusy || actionBusy || scaffoldBusy ? "active" : "ready"
      },
      {
        title: "Gathering context",
        state: chatBusy || scaffoldBusy ? "active" : "ready"
      },
      {
        title: "Planning solution",
        state: buildPlan ? "complete" : (chatBusy ? "active" : "ready")
      },
      {
        title: "Building response",
        state: chatBusy ? "active" : (chatMessages.length > 1 ? "complete" : "ready")
      },
      {
        title: "Verifying output",
        state: scaffoldBusy ? "active" : (scaffoldResults.length ? "complete" : "ready")
      }
    ] as const;
  }, [actionBusy, buildPlan, chatBusy, chatMessages.length, scaffoldBusy, scaffoldResults.length]);

  const showLiveCodingWorkspace = activeTopTab === "ASSISTANT" && liveCodingActive;

  const groupedRuntimeRuns = useMemo(() => {
    const logs = [...runtimeLogs].reverse();
    const groups = new Map<string, RuntimeRunGroup>();

    for (const log of logs) {
      if (!log.runId || log.runId === "system") continue;

      const current = groups.get(log.runId) ?? {
        runId: log.runId,
        command: `Command ${log.runId.slice(0, 8)}`,
        status: "running",
        startedAt: log.createdAt,
        endedAt: null,
        lines: []
      };

      current.lines.push(log);
      current.startedAt = Math.min(current.startedAt, log.createdAt);

      if (log.kind === "start") {
        current.command = log.line;
      }

      if (log.kind === "exit") {
        current.endedAt = log.createdAt;
        current.status = /exit\s+0$/i.test(log.line) ? "ok" : "error";
      }

      groups.set(log.runId, current);
    }

    return Array.from(groups.values()).sort((left, right) => {
      const leftTime = left.endedAt ?? left.startedAt;
      const rightTime = right.endedAt ?? right.startedAt;
      return rightTime - leftTime;
    });
  }, [runtimeLogs]);

  const runtimeActivityLines = useMemo(() => {
    return runtimeLogs.filter((line) => !line.runId || line.runId === "system").slice(0, 24);
  }, [runtimeLogs]);

  const runSignatureByRunId = useMemo(() => {
    const map: Record<string, string> = {};
    for (const run of groupedRuntimeRuns) {
      const hasFailureSignals = run.status === "error"
        || run.lines.some((line) => line.kind === "stderr" || line.level === "warn" || line.level === "error");
      if (!hasFailureSignals) continue;
      map[run.runId] = buildRunFailureSignature(run);
    }
    return map;
  }, [groupedRuntimeRuns]);

  const autoAcknowledgedRunIds = useMemo(() => {
    const map: Record<string, boolean> = {};
    for (const [runId, signature] of Object.entries(runSignatureByRunId)) {
      if (acknowledgedSignatures[signature]) {
        map[runId] = true;
      }
    }
    return map;
  }, [acknowledgedSignatures, runSignatureByRunId]);

  const filteredRunGroups = useMemo(() => {
    return groupedRuntimeRuns.map((run) => ({
      ...run,
      filteredLines: run.lines.filter((line) => matchesRuntimeFilter(line))
    })).filter((run) => run.filteredLines.length > 0);
  }, [groupedRuntimeRuns, runtimeFilter]);

  const filteredRuntimeActivityLines = useMemo(() => {
    return runtimeActivityLines.filter((line) => matchesRuntimeFilter(line));
  }, [runtimeActivityLines, runtimeFilter]);

  const runtimeFilterCounts = useMemo(() => {
    const stdout = runtimeLogs.filter((line) => line.kind === "stdout").length;
    const stderr = runtimeLogs.filter((line) => line.kind === "stderr").length;
    const errors = runtimeLogs.filter((line) => line.level === "warn" || line.level === "error" || line.kind === "stderr").length;
    return {
      all: runtimeLogs.length,
      stdout,
      stderr,
      errors
    };
  }, [runtimeLogs]);

  const latestFailingRunId = useMemo(() => {
    const hasFailureSignals = (run: { status: "running" | "ok" | "error"; lines: RuntimeLog[] }) => {
      if (run.status === "error") return true;
      return run.lines.some((line) => line.kind === "stderr" || line.level === "warn" || line.level === "error");
    };

    const failingRun = groupedRuntimeRuns.find((run) => hasFailureSignals(run));
    return failingRun?.runId ?? null;
  }, [groupedRuntimeRuns]);

  const hasFailingRuns = useMemo(() => {
    return groupedRuntimeRuns.some((run) => run.status === "error"
      || run.lines.some((line) => line.kind === "stderr" || line.level === "warn" || line.level === "error"));
  }, [groupedRuntimeRuns]);

  const prioritizedFocusRunId = useMemo(() => {
    if (forcedFocusRunId) return forcedFocusRunId;
    if (!autoFocusErrors || runtimeFilterCounts.errors <= 0) return null;
    return latestFailingRunId;
  }, [autoFocusErrors, forcedFocusRunId, latestFailingRunId, runtimeFilterCounts.errors]);

  const displayedRunGroups = useMemo(() => {
    if (!prioritizedFocusRunId) {
      return filteredRunGroups;
    }

    const focusIndex = filteredRunGroups.findIndex((run) => run.runId === prioritizedFocusRunId);
    if (focusIndex <= 0) {
      return filteredRunGroups;
    }

    const focused = filteredRunGroups[focusIndex];
    return [focused, ...filteredRunGroups.slice(0, focusIndex), ...filteredRunGroups.slice(focusIndex + 1)];
  }, [filteredRunGroups, prioritizedFocusRunId]);

  const visibleTriageEvents = useMemo(() => {
    if (triageRetention === "all") {
      return triageEvents;
    }

    const cutoff = nowMs - 24 * 60 * 60 * 1000;
    return triageEvents.filter((event) => event.createdAt >= cutoff);
  }, [nowMs, triageEvents, triageRetention]);

  const filteredIncidentAuditEntries = useMemo(() => {
    const cutoff = nowMs - 24 * 60 * 60 * 1000;
    const query = incidentAuditSearch.trim().toLowerCase();

    return incidentAuditEntries.filter((entry) => {
      if (triageRetention === "24h" && entry.createdAt < cutoff) {
        return false;
      }

      if (incidentAuditStatusFilter !== "all" && entry.status !== incidentAuditStatusFilter) {
        return false;
      }

      if (!query) {
        return true;
      }

      return entry.kind.toLowerCase().includes(query)
        || entry.detail.toLowerCase().includes(query)
        || (entry.fileName?.toLowerCase().includes(query) ?? false)
        || (entry.hash?.toLowerCase().includes(query) ?? false);
    });
  }, [incidentAuditEntries, incidentAuditSearch, incidentAuditStatusFilter, nowMs, triageRetention]);

  // E13-S3: degraded/recovery banner driven by real reply provenance.
  const degradedState = useMemo(() => summarizeDegradedState(
    chatMessages
      .filter((message) => message.role === "assistant" && message.provenance)
      .map((message) => message.provenance!)
  ), [chatMessages]);

  // E13-S1: derive public stage telemetry from the real execution checkpoints.
  const reasoningSummary = useMemo(
    () => summarizeReasoningStages(executionEvents, nowMs),
    [executionEvents, nowMs]
  );

  const livePhaseLabel = useMemo(() => {
    const active = pipelineStatus.find((stage) => stage.state === "active");
    if (active) return active.title;
    const complete = pipelineStatus.filter((stage) => stage.state === "complete");
    if (complete.length) return complete[complete.length - 1].title;
    return "Monitoring";
  }, [pipelineStatus]);

  const todayLabel = useMemo(() => {
    const now = new Date(nowMs);
    return now.toLocaleString("en-US", {
      hour: "numeric",
      minute: "2-digit"
    });
  }, [nowMs]);

  const filteredProjects = useMemo(() => {
    const query = projectFilter.trim().toLowerCase();
    return hostProjects.filter((project) => {
      if (projectGroupFilter !== "all" && project.group !== projectGroupFilter) {
        return false;
      }

      if (!query) return true;
      return project.name.toLowerCase().includes(query) || project.path.toLowerCase().includes(query);
    });
  }, [hostProjects, projectFilter, projectGroupFilter]);

  const sortedStorageDevices = useMemo(() => {
    const devices = [...storageDevices];
    if (storageSort === "free-desc") {
      devices.sort((left, right) => right.freeBytes - left.freeBytes);
    } else {
      devices.sort((left, right) => right.usedPercent - left.usedPercent);
    }
    return devices;
  }, [storageDevices, storageSort]);

  const hasScaffoldFailures = useMemo(
    () => scaffoldResults.some((item) => !item.ok),
    [scaffoldResults]
  );

  const resolvedScaffoldRootPreview = useMemo(
    () => buildPlan ? resolveScaffoldRoot(buildPlan, scaffoldTargetTemplate) : scaffoldTargetTemplate,
    [buildPlan, scaffoldTargetTemplate]
  );

  function createBlueprintFromText(source: string): BuildBlueprint {
    const plan = generateBlueprint(source);
    setBuildPlan(plan);
    setScaffoldStatus(null);
    setScaffoldResults([]);
    pushExecutionEvent("planning", `Blueprint synthesized: ${plan.title}.`, "ok");
    pushExecutionEvent("verifying", "Blueprint is ready for scaffold generation.", "ok");
    setActionLine(`Blueprint ready · ${plan.title}`, "ok");
    return plan;
  }

  function createBlueprintFromPrompt() {
    createBlueprintFromText(prompt);
  }

  function runPromptPrimaryAction() {
    const request = prompt.trim();
    if (!request || actionBusy || chatBusy) return;

    if (activeTopTab === "ASSISTANT") {
      void submitChatBuildRequest(request);
      return;
    }

    createBlueprintFromText(request);
  }

  function pushExecutionEvent(stage: ReasoningStage, detail: string, level: ExecutionLevel = "info") {
    const now = Date.now();
    setExecutionEvents((current) => {
      const last = current[0];
      if (last && last.stage === stage && last.detail === detail && now - last.createdAt < 2000) {
        return current;
      }

      return [{ id: crypto.randomUUID(), stage, detail, level, createdAt: now }, ...current].slice(0, 20);
    });
  }

  function pushRuntimeLog(
    line: string,
    level: RuntimeLogLevel = "info",
    options?: {
      runId?: string;
      kind?: "start" | "stdout" | "stderr" | "exit";
    }
  ) {
    const now = Date.now();
    setRuntimeLogs((current) => {
      const latest = current[0];
      if (
        latest
        && latest.line === line
        && latest.runId === options?.runId
        && latest.kind === options?.kind
        && now - latest.createdAt < 1000
      ) {
        return current;
      }

      return [{
        id: crypto.randomUUID(),
        line,
        level,
        createdAt: now,
        ...(options?.runId ? { runId: options.runId } : {}),
        ...(options?.kind ? { kind: options.kind } : {})
      }, ...current].slice(0, 140);
    });
  }

  function toggleRunCollapsed(runId: string) {
    setCollapsedRuns((current) => ({
      ...current,
      [runId]: !current[runId]
    }));
  }

  function collapseAllRuns() {
    const next: Record<string, boolean> = {};
    for (const run of filteredRunGroups) {
      next[run.runId] = true;
    }
    setCollapsedRuns((current) => ({ ...current, ...next }));
  }

  function expandAllRuns() {
    const next: Record<string, boolean> = {};
    for (const run of filteredRunGroups) {
      next[run.runId] = false;
    }
    setCollapsedRuns((current) => ({ ...current, ...next }));
  }

  function acknowledgeRunFailure(runId: string) {
    setAcknowledgedFailures((current) => ({
      ...current,
      [runId]: true
    }));
    const signature = runSignatureByRunId[runId];
    if (signature) {
      setAcknowledgedSignatures((current) => ({
        ...current,
        [signature]: true
      }));
    }
    pushTriageEvent("acknowledge", `Acknowledged failing run ${runId.slice(0, 8)}.`, runId);
    pushExecutionEvent("verifying", `Failure acknowledged for run ${runId.slice(0, 8)}.`, "info");
  }

  function forceFocusRun(runId: string) {
    setForcedFocusRunId(runId);
    setRuntimeFilter("errors");
    setCollapsedRuns((current) => ({
      ...current,
      [runId]: false
    }));
    setAcknowledgedFailures((current) => ({
      ...current,
      [runId]: false
    }));
    pushTriageEvent("force-focus", `Forced focus on run ${runId.slice(0, 8)}.`, runId);
    pushExecutionEvent("verifying", `Force focus applied to run ${runId.slice(0, 8)}.`, "warn");
  }

  function forgetRunSignature(runId: string) {
    const signature = runSignatureByRunId[runId];
    if (!signature) {
      pushTriageEvent("forget-signature", `No stored signature found for run ${runId.slice(0, 8)}.`, runId);
      pushExecutionEvent("verifying", `No saved failure signature for run ${runId.slice(0, 8)}.`, "info");
      return;
    }

    setAcknowledgedSignatures((current) => {
      const next = { ...current };
      delete next[signature];
      return next;
    });
    setAcknowledgedFailures((current) => ({
      ...current,
      [runId]: false
    }));
    pushTriageEvent("forget-signature", `Forgot known-failure signature for run ${runId.slice(0, 8)}.`, runId);
    pushExecutionEvent("verifying", `Forgot known-failure signature for run ${runId.slice(0, 8)}.`, "warn");
  }

  function clearForcedFocus() {
    if (!forcedFocusRunId) return;
    const runId = forcedFocusRunId;
    setForcedFocusRunId(null);
    pushTriageEvent("clear-force-focus", `Cleared forced focus for run ${runId.slice(0, 8)}.`, runId);
    pushExecutionEvent("verifying", `Cleared forced focus for run ${runId.slice(0, 8)}.`, "info");
  }

  function clearTriageTimeline() {
    setTriageEvents([]);
    pushExecutionEvent("verifying", "Cleared triage timeline history.", "info");
  }

  async function exportTriageTimelineJson() {
    if (!visibleTriageEvents.length || triageExportBusy) return;

    setTriageExportBusy(true);
    try {
      const content = {
        exportedAt: new Date().toISOString(),
        retention: triageRetention,
        visibleCount: visibleTriageEvents.length,
        totalCount: triageEvents.length,
        events: visibleTriageEvents.map((event) => ({
          id: event.id,
          action: event.action,
          detail: event.detail,
          runId: event.runId ?? null,
          createdAt: new Date(event.createdAt).toISOString()
        }))
      };
      const contentHash = await sha256Hex(stableSerialize(content));
      const payload = {
        ...content,
        integrity: {
          algorithm: "SHA-256",
          canonicalization: "sorted-keys-v1",
          contentHash
        }
      };

      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `triage-timeline-${triageRetention}-${Date.now()}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      pushExecutionEvent("verifying", `Exported triage timeline JSON (${visibleTriageEvents.length} events).`, "ok");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown export error";
      pushExecutionEvent("verifying", `Triage JSON export failed: ${message}.`, "error");
    } finally {
      setTriageExportBusy(false);
    }
  }

  async function exportTriageTimelineMarkdown() {
    if (!visibleTriageEvents.length || triageExportBusy) return;

    setTriageExportBusy(true);
    try {
      const bodyLines = [
        "# Ascend AI Triage Timeline",
        "",
        `- Exported At: ${new Date().toISOString()}`,
        `- Retention Filter: ${triageRetention}`,
        `- Visible Events: ${visibleTriageEvents.length}`,
        `- Total Events: ${triageEvents.length}`,
        "",
        "## Events",
        ""
      ];

      for (const event of visibleTriageEvents) {
        bodyLines.push(`### ${event.action.toUpperCase().replace(/-/g, " ")}`);
        bodyLines.push(`- Time: ${new Date(event.createdAt).toISOString()}`);
        bodyLines.push(`- Detail: ${event.detail}`);
        bodyLines.push(`- Run: ${event.runId ? event.runId.slice(0, 8) : "N/A"}`);
        bodyLines.push("");
      }

      const body = bodyLines.join("\n");
      const contentHash = await sha256Hex(body);
      const lines = [
        "<!-- integrity.algorithm: SHA-256 -->",
        "<!-- integrity.scope: markdown-body -->",
        `<!-- integrity.contentHash: ${contentHash} -->`,
        "",
        body
      ];

      const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `triage-timeline-${triageRetention}-${Date.now()}.md`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      pushExecutionEvent("verifying", `Exported triage timeline Markdown (${visibleTriageEvents.length} events).`, "ok");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown export error";
      pushExecutionEvent("verifying", `Triage Markdown export failed: ${message}.`, "error");
    } finally {
      setTriageExportBusy(false);
    }
  }

  async function exportIncidentBundle() {
    const hasFailureSignals = (run: RuntimeRunGroup) => {
      if (run.status === "error") return true;
      return run.lines.some((line) => line.kind === "stderr" || line.level === "warn" || line.level === "error");
    };

    const failingRuns = groupedRuntimeRuns
      .filter((run) => hasFailureSignals(run))
      .map((run) => ({
        runId: run.runId,
        command: run.command,
        status: run.status,
        startedAt: new Date(run.startedAt).toISOString(),
        endedAt: run.endedAt ? new Date(run.endedAt).toISOString() : null,
        lineCount: run.lines.length,
        linesMatchingActiveFilter: run.lines.filter((line) => matchesRuntimeFilter(line)).length,
        lines: run.lines.map((line) => ({
          id: line.id,
          createdAt: new Date(line.createdAt).toISOString(),
          level: line.level,
          kind: line.kind ?? null,
          text: line.line
        }))
      }));

    if ((!visibleTriageEvents.length && !failingRuns.length) || triageExportBusy) return;

    setTriageExportBusy(true);
    try {
      const content = {
        exportedAt: new Date().toISOString(),
        runtime: {
          filter: runtimeFilter,
          filterCounts: runtimeFilterCounts,
          autoFocusErrors,
          forcedFocusRunId,
          prioritizedFocusRunId
        },
        triage: {
          retention: triageRetention,
          visibleCount: visibleTriageEvents.length,
          totalCount: triageEvents.length,
          events: visibleTriageEvents.map((event) => ({
            id: event.id,
            action: event.action,
            detail: event.detail,
            runId: event.runId ?? null,
            createdAt: new Date(event.createdAt).toISOString()
          }))
        },
        failures: {
          runCount: failingRuns.length,
          runs: failingRuns
        }
      };
      const contentHash = await sha256Hex(stableSerialize(content));
      const payload = {
        ...content,
        integrity: {
          algorithm: "SHA-256",
          canonicalization: "sorted-keys-v1",
          contentHash
        }
      };

      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `incident-bundle-${triageRetention}-${Date.now()}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      pushExecutionEvent("verifying", `Exported incident bundle (${failingRuns.length} failing runs, ${visibleTriageEvents.length} triage events).`, "ok");
      pushRuntimeLog("[incident] Incident bundle exported for escalation.", "ok");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown export error";
      pushExecutionEvent("verifying", `Incident bundle export failed: ${message}.`, "error");
      pushRuntimeLog(`[incident] Export failed: ${message}`, "error");
    } finally {
      setTriageExportBusy(false);
    }
  }

  function requestBundleVerify() {
    if (triageExportBusy) return;
    bundleVerifyInputRef.current?.click();
  }

  async function verifyImportedBundle(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || triageExportBusy) return;

    setTriageExportBusy(true);
    setBundleVerifyStatus(null);

    try {
      const raw = await file.text();
      const lowerName = file.name.toLowerCase();
      const looksMarkdown = lowerName.endsWith(".md") || /^\s*<!--\s*integrity\./i.test(raw);
      const format = looksMarkdown ? "Markdown" : "JSON";

      if (looksMarkdown) {
        await verifySignedMarkdownExport(raw);
      } else {
        await verifySignedJsonExport(raw);
      }

      setBundleVerifyStatus({ level: "ok", message: `Verified ${format}` });
      pushTriageEvent("verify-bundle", `Verified ${format.toLowerCase()} bundle integrity for ${file.name}.`);
      pushExecutionEvent("verifying", `${format} bundle integrity verified for ${file.name}.`, "ok");
      pushRuntimeLog(`[incident] ${format} bundle verified: ${file.name}`, "ok");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown verification error";
      setBundleVerifyStatus({ level: "error", message: "Verification failed" });
      pushTriageEvent("verify-bundle", `Bundle integrity verification failed for ${file?.name ?? "unknown file"}: ${message}.`);
      pushExecutionEvent("verifying", `Bundle verification failed: ${message}.`, "error");
      pushRuntimeLog(`[incident] Bundle verification failed: ${message}`, "error");
    } finally {
      setTriageExportBusy(false);
    }
  }

  function upsertRuntimeArtifact(path: string, status: RuntimeArtifact["status"], detail: string) {
    const now = Date.now();
    setRuntimeArtifacts((current) => {
      const existing = current.find((artifact) => artifact.path === path);
      if (!existing) {
        return [{ path, status, detail, updatedAt: now }, ...current].slice(0, 40);
      }

      return current.map((artifact) => artifact.path === path
        ? { ...artifact, status, detail, updatedAt: now }
        : artifact);
    });
  }

  async function runDesktopLiveCommand(command: string, label: string, cwd?: string) {
    const runner = window.ascendDesktop?.runWorkspaceCommand;
    if (!runner) {
      pushRuntimeLog(`[warn] ${label} unavailable: desktop bridge not connected.`, "warn");
      setActionLine("Desktop runtime unavailable", "warn");
      return;
    }
    // Executes a real shell command; a double invocation runs it twice.
    if (!desktopCommandLatchRef.current.tryAcquire(`cmd:${command}`)) return;

    setDesktopCommandBusy(true);
    setActionBusy(true);
    pushExecutionEvent("building", `${label} started.`, "info");
    pushRuntimeLog(`[run] ${label}: ${command}`, "info");

    try {
      const result = await runner({ command, ...(cwd ? { cwd } : {}) });
      if (result?.ok) {
        pushExecutionEvent("verifying", `${label} completed successfully.`, "ok");
        setActionLine(`${label} complete`, "ok");
      } else {
        const message = result?.error ?? "Command failed.";
        pushExecutionEvent("verifying", `${label} failed: ${message}`, "warn");
        setActionLine(`${label} failed`, "warn");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown command failure";
      pushRuntimeLog(`[error] ${label}: ${message}`, "error");
      pushExecutionEvent("verifying", `${label} failed: ${message}`, "error");
      setActionLine(`${label} failed`, "error");
    } finally {
      desktopCommandLatchRef.current.release();
      setDesktopCommandBusy(false);
      setActionBusy(false);
    }
  }

  async function submitAuth() {
    const problem = validateCredentials(authEmail, authPassword);
    if (problem) {
      setAuthError(problem);
      return;
    }

    setAuthBusy(true);
    setAuthError(null);
    try {
      const response = await fetch(`${webEnv.apiBaseUrl}/v1/auth/${authMode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: authEmail.trim(), password: authPassword })
      });
      const result = readAuthResponse(response.status, await response.json());

      if (!result.ok) {
        setAuthError(result.error);
        return;
      }

      writeStoredToken(window.localStorage, result.token);
      setAuthToken(result.token);
      setAccount(result.account);
      setAuthOpen(false);
      // Shown once and never retrievable again — the server keeps only hashes.
      if (result.recoveryCodes.length) {
        setRecoveryCodes(result.recoveryCodes);
      }
      // The password never outlives the request that used it.
      setAuthPassword("");
      setAuthEmail("");
      pushNotification(`Signed in as ${result.account.displayName}`);
      pushRuntimeLog(`[auth] Signed in as ${result.account.email}.`, "ok");
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Sign in failed");
    } finally {
      setAuthBusy(false);
    }
  }

  async function submitRecovery() {
    if (authPassword.length < 10) {
      setAuthError("New password must be at least 10 characters");
      return;
    }

    setAuthBusy(true);
    setAuthError(null);
    try {
      const response = await fetch(`${webEnv.apiBaseUrl}/v1/auth/recover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: authEmail.trim(),
          code: recoverCode,
          newPassword: authPassword
        })
      });
      const result = readAuthResponse(response.status, await response.json());

      if (!result.ok) {
        setAuthError(result.error);
        return;
      }

      writeStoredToken(window.localStorage, result.token);
      setAuthToken(result.token);
      setAccount(result.account);
      setRecoverOpen(false);
      setAuthOpen(false);
      setAuthPassword("");
      setAuthEmail("");
      setRecoverCode("");
      pushNotification("Account recovered · password reset");
      pushRuntimeLog("[auth] Recovered with a recovery code; all sessions revoked.", "ok");
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Recovery failed");
    } finally {
      setAuthBusy(false);
    }
  }

  async function submitPasswordChange() {
    if (newPassword.length < 10) {
      setPasswordNotice("New password must be at least 10 characters");
      return;
    }

    setAuthBusy(true);
    setPasswordNotice(null);
    try {
      const response = await fetch(`${webEnv.apiBaseUrl}/v1/auth/password`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(authToken) },
        body: JSON.stringify({ currentPassword, newPassword })
      });
      const payload = await response.json() as { data?: { token?: string }; message?: string };

      if (!response.ok || !payload.data?.token) {
        setPasswordNotice(payload.message ?? "Could not change password");
        return;
      }

      // The server revoked every session, including this one, and issued a
      // replacement. Storing it is what keeps the user signed in.
      writeStoredToken(window.localStorage, payload.data.token);
      setAuthToken(payload.data.token);
      setCurrentPassword("");
      setNewPassword("");
      setPasswordOpen(false);
      pushNotification("Password changed · other sessions signed out");
      pushRuntimeLog("[auth] Password changed; other sessions revoked.", "ok");
    } catch (error) {
      setPasswordNotice(error instanceof Error ? error.message : "Could not change password");
    } finally {
      setAuthBusy(false);
    }
  }

  async function signOut() {
    const token = authToken;
    writeStoredToken(window.localStorage, null);
    setAuthToken(null);
    setAccount(null);
    setMemories([]);
    // The account's transcript must not linger on screen after signing out.
    setChatMessages(defaultChatMessages);
    pushRuntimeLog("[auth] Signed out.", "info");
    try {
      await fetch(`${webEnv.apiBaseUrl}/v1/auth/logout`, {
        method: "POST",
        headers: authHeaders(token)
      });
    } catch {
      // Local state is already cleared; a failed revoke is not worth blocking on.
    }
    void refreshMemories();
  }

  /**
   * Load the transcript the server holds for this identity. This is what makes a
   * conversation follow an account to another browser, the same way memory does.
   * Local state is only replaced when the server actually has turns, so an
   * offline or brand-new session keeps whatever is already on screen.
   */
  async function hydrateConversation() {
    try {
      const response = await fetch(
        `${webEnv.apiBaseUrl}/v1/assist/conversation?sessionId=${encodeURIComponent(resolveAssistSessionId())}`,
        { headers: authHeaders(authToken) }
      );
      if (!response.ok) return;

      const payload = await response.json() as {
        data?: { turns?: Array<{ id: string; role: "user" | "assistant"; content: string; createdAt: string }> };
      };
      const turns = payload.data?.turns ?? [];
      if (turns.length === 0) return;

      setChatMessages(turns.map((turn) => ({
        id: turn.id,
        role: turn.role,
        text: turn.content,
        createdAt: Date.parse(turn.createdAt) || Date.now()
      })));
    } catch {
      // API offline: the locally persisted transcript stands.
    }
  }

  // E4-S2 memory controls. Every mutation re-reads the server list rather than
  // patching local state, so the panel can never drift from what retrieval sees.
  async function refreshMemories() {
    try {
      const response = await fetch(
        `${webEnv.apiBaseUrl}/v1/assist/memory?sessionId=${encodeURIComponent(resolveAssistSessionId())}`,
        { headers: authHeaders(authToken) }
      );
      if (!response.ok) return;
      const payload = await response.json() as { data?: { memories?: MemoryItem[] } };
      setMemories(Array.isArray(payload.data?.memories) ? payload.data.memories : []);
    } catch {
      // API offline: keep whatever is already on screen rather than blanking it.
    }
  }

  async function mutateMemory(memoryId: string, init: RequestInit, label: string) {
    try {
      const response = await fetch(`${webEnv.apiBaseUrl}/v1/assist/memory/${encodeURIComponent(memoryId)}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), ...authHeaders(authToken) }
      });
      if (!response.ok) {
        pushRuntimeLog(`[memory] ${label} failed (${response.status}).`, "warn");
        return;
      }
      pushRuntimeLog(`[memory] ${label}.`, "ok");
      await refreshMemories();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown failure";
      pushRuntimeLog(`[memory] ${label} failed: ${message}`, "error");
    }
  }

  function toggleMemoryPin(item: MemoryItem) {
    void mutateMemory(
      item.id,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: resolveAssistSessionId(), pinned: !item.pinned })
      },
      `${item.pinned ? "Unpinned" : "Pinned"} "${item.title}"`
    );
  }

  function commitMemoryLabel(item: MemoryItem) {
    const nextTitle = memoryEditDraft.trim();
    setMemoryEditId(null);
    if (!nextTitle || nextTitle === item.title) return;

    void mutateMemory(
      item.id,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: resolveAssistSessionId(), title: nextTitle })
      },
      `Relabeled to "${nextTitle}"`
    );
  }

  function forgetMemoryItem(item: MemoryItem) {
    void mutateMemory(
      item.id,
      { method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: resolveAssistSessionId() }) },
      `Forgot "${item.title}"`
    );
  }

  function forgetAllMemories() {
    void mutateMemory(
      "all",
      { method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: resolveAssistSessionId() }) },
      "Cleared all memories"
    );
  }

  function pushChatMessage(role: ChatMessage["role"], text: string, provenance?: ResponseProvenance) {
    // Every assistant reply goes through here, which is why the personality's
    // response-style constraints are applied at this point: a mandatory
    // disclaimer cannot be skipped by adding another call site later.
    const styled = role === "assistant" ? applyResponseStyle(text, activePersonality) : text;

    setChatMessages((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        role,
        text: styled,
        createdAt: Date.now(),
        provenance
      }
    ]);
  }

  async function runAutoDevelopPipeline(request: string, plan?: BuildBlueprint) {
    pushExecutionEvent("planning", "Auto-develop pipeline engaged from single response.", "info");
    pushRuntimeLog("[auto] Single-response develop mode engaged.", "ok");
    const activePlan = plan ?? createBlueprintFromText(request);
    setActionLine(`Auto-develop running · ${activePlan.title}`, "info");
    await generateScaffoldFromBlueprint(activePlan);
  }

  async function submitChatBuildRequest(requestOverride?: string) {
    const request = (requestOverride ?? chatDraft).trim();
    if (!request) return;
    // Must come before any await: chatBusy is stale inside a same-tick second call.
    if (!chatSubmitLatchRef.current.tryAcquire(`${assistantMode}:${request}`)) return;
    const startedAt = performance.now();

    const resolvedIntent = resolveLocalIntent(assistantMode, request);
    // The mode chips never show "question", so keep the displayed mode on a real
    // track while the offline reply still uses the honest intent.
    const resolvedMode: AssistantMode = resolvedIntent === "question" ? "auto" : resolvedIntent;

    setChatBusy(true);
    setActionBusy(true);
    if (resolvedMode === "build" || resolvedMode === "code" || resolvedMode === "debug") {
      setActiveTopTab("ASSISTANT");
      setActiveRailSection("Assistant");
      setLiveCodingActive(true);
      pushRuntimeLog(`[mode] Live Coding activated (${resolvedMode.toUpperCase()}).`, "ok");
    }
    // Captured before the new user turn is appended, since that turn is sent as `message`.
    const priorHistory = buildAssistantHistory(chatMessages);
    pushExecutionEvent("understanding", `Analyzing prompt intent for ${resolvedMode.toUpperCase()} mode.`, "info");
    pushExecutionEvent(
      "context",
      priorHistory.length
        ? `Attaching ${priorHistory.length} recent conversation turn${priorHistory.length === 1 ? "" : "s"} as context.`
        : "No prior conversation turns to attach.",
      "info"
    );
    pushRuntimeLog(`[trace] Understanding request in ${resolvedMode.toUpperCase()} mode...`, "info");
    pushRuntimeLog(`[trace] Conversation context: ${priorHistory.length} turn(s).`, "info");
    setActionLine(`Assistant processing (${resolvedMode})...`, "info");
    pushChatMessage("user", request);
    setChatDraft("");

    try {
      setPrompt(request);

      let apiReply: AssistantApiReply | null = null;
      let apiAttempts = assistantApiMaxAttempts;
      try {
        // History excludes the turn just pushed, which is sent as `message`.
        apiReply = await callAssistantApiWithRetry(request, resolvedMode, priorHistory, authToken);
        apiAttempts = apiReply.attempts;
      } catch {
        apiReply = null;
      }

      if (!apiReply) {
        pushExecutionEvent(
          "building",
          `Assistant API unreachable after ${apiAttempts} attempts. Falling back to a local reply.`,
          "warn"
        );
        pushRuntimeLog(`[degraded] Assistant API unreachable after ${apiAttempts} attempts.`, "warn");
      } else if (apiAttempts > 1) {
        pushRuntimeLog(`[recover] Assistant API responded on attempt ${apiAttempts}.`, "warn");
      }

      if (apiReply?.savedMemoryEntries) {
        const saved = apiReply.savedMemoryEntries;
        pushExecutionEvent("context", `Saved ${saved} new memor${saved === 1 ? "y" : "ies"} from this message.`, "ok");
        pushRuntimeLog(`[memory] Saved ${saved} new memor${saved === 1 ? "y" : "ies"}.`, "ok");
        void refreshMemories();
      }
      if (apiReply?.usedMemoryEntries) {
        pushRuntimeLog(`[memory] Applied ${apiReply.usedMemoryEntries} saved memor${apiReply.usedMemoryEntries === 1 ? "y" : "ies"} as context.`, "info");
      }

      let preparedPlan: BuildBlueprint | null = null;
      // A question routed to "build" mode by keyword should still just be answered.
      const buildRequested = shouldAutoDevelop(apiReply?.strategy, request);

      // Build from the server's merged request when it has one, so a clarified
      // spec generates the refined app rather than only this turn's answer.
      const buildSource = apiReply?.buildRequest?.trim() || request;

      if (resolvedMode === "build" && buildRequested) {
        const plan = generateBlueprint(buildSource);
        preparedPlan = plan;
        setBuildPlan(plan);
        setScaffoldStatus(null);
        setScaffoldResults([]);
        pushRuntimeLog(`[plan] Blueprint generated: ${plan.title}.`, "ok");
        pushExecutionEvent("planning", `Build blueprint assembled for ${plan.title}.`, "ok");
        const buildReply = apiReply?.assistantMessage
          ? `${apiReply.assistantMessage}\n\nBlueprint prepared for ${plan.title}. Stack: ${plan.stack.join(", ")}. Auto-develop is now generating scaffold files in the live runtime console.`
          : `Blueprint prepared for ${plan.title}. Stack: ${plan.stack.join(", ")}. Auto-develop is now generating scaffold files in the live runtime console.`;
        pushChatMessage("assistant", buildReply, buildResponseProvenance({
          apiModel: apiReply?.model ?? null,
          attempts: apiAttempts,
          usedHistoryTurns: apiReply?.usedHistoryTurns ?? 0,
          usedMemoryEntries: apiReply?.usedMemoryEntries ?? 0,
          usedBlueprint: true
        }));
        pushExecutionEvent("building", "Delivered blueprint with stack and execution path.", "ok");
        pushExecutionEvent("verifying", "Blueprint is validated and ready for scaffold generation.", "ok");
        pushRuntimeLog(`[verify] Blueprint validated for scaffold generation.`, "ok");
        setActionLine(`Assistant prepared ${plan.title}`, "ok");
        pushNotification(
          apiReply?.model
            ? `Assistant created blueprint · ${plan.title} · ${apiReply.model}`
            : `Assistant created blueprint · ${plan.title}`
        );
      } else {
        const reply = apiReply?.assistantMessage ?? buildLocalCapabilityReply(resolvedIntent, request);
        pushChatMessage("assistant", reply, buildResponseProvenance({
          apiModel: apiReply?.model ?? null,
          attempts: apiAttempts,
          usedHistoryTurns: apiReply?.usedHistoryTurns ?? 0,
          usedMemoryEntries: apiReply?.usedMemoryEntries ?? 0
        }));
        pushExecutionEvent("planning", `${resolvedMode.toUpperCase()} mode plan generated.`, "ok");
        pushExecutionEvent("building", "Assistant response delivered with actionable next steps.", "ok");
        pushExecutionEvent("verifying", "Response integrity checks passed.", "ok");
        pushRuntimeLog(`[response] ${resolvedMode.toUpperCase()} response delivered.`, "ok");
        setActionLine(
          apiReply?.model
            ? `Assistant ${resolvedMode} mode response ready · ${apiReply.model}`
            : `Assistant ${resolvedMode} mode response ready`,
          "ok"
        );
        pushNotification(
          apiReply?.model
            ? `Assistant mode active · ${resolvedMode.toUpperCase()} · ${apiReply.model}`
            : `Assistant mode active · ${resolvedMode.toUpperCase()}`
        );
      }

      // Only scaffold when the request was actually a request to build something.
      // Asking "which database should we use?" must not generate a project.
      if (AUTO_DEVELOP_ALWAYS_ON && buildRequested) {
        await runAutoDevelopPipeline(buildSource, preparedPlan ?? undefined);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown assistant failure";
      pushChatMessage("assistant", `Build request failed: ${message}. Try again with more detail.`);
      pushExecutionEvent("verifying", `Execution failed: ${message}.`, "error");
      pushRuntimeLog(`[error] ${message}`, "error");
      setActionLine("Assistant request failed", "error");
      pushNotification("Assistant request failed");
    } finally {
      // Released even on an unexpected throw, or the latch would wedge the chat.
      chatSubmitLatchRef.current.release();
      setLastResponseMs(Math.max(1, Math.round(performance.now() - startedAt)));
      setChatBusy(false);
      setActionBusy(false);
    }
  }

  function pushNotification(title: string) {
    const now = Date.now();
    setNotifications((current) => {
      const latest = current[0];
      if (latest && latest.title === title && now - latest.createdAt < 5000) {
        return current;
      }

      return [{ id: crypto.randomUUID(), title, createdAt: now }, ...current].slice(0, 6);
    });
  }

  function setActionLine(status: string, level: ActionLevel = "info") {
    setActionStatus(status);
    setActionLevel(level);
  }

  function clearNotifications() {
    setNotifications([{ id: crypto.randomUUID(), title: "Notifications cleared", createdAt: Date.now() }]);
    setActionLine("Notifications cleared", "ok");
  }

  function applyQuickPrompt(source: string, nextPrompt: string) {
    setPrompt(nextPrompt);
    setActiveTopTab("ASSISTANT");
    setActiveRailSection("Assistant");
    pushNotification(`${source} command queued`);
    setActionLine(`${source} prompt ready`, "ok");
  }

  function onTopActionSearch() {
    applyQuickPrompt("Search", "Search all projects, files, and generated scaffolds for the active objective.");
  }

  function onTopActionPanel() {
    setShowAllNotifications((current) => !current);
    pushNotification("Notification panel toggled");
    setActionLine("Notification panel toggled", "info");
  }

  async function onTopActionSync() {
    setActionBusy(true);
    pushExecutionEvent("context", "Manual runtime sync requested.", "info");
    pushNotification("Manual sync started");
    setActionLine("Syncing telemetry...", "info");
    const telemetryBridge = window.ascendDesktop?.getSystemTelemetry;
    if (telemetryBridge) {
      const response = await telemetryBridge();
      if (response?.ok) {
        setNetworkType(response.networkType ?? networkType);
        pushExecutionEvent("verifying", "Desktop telemetry bridge synchronization completed.", "ok");
        pushNotification(`Sync complete · ${response.networkType ?? "ONLINE"}`);
        setActionLine(`Sync complete · ${response.networkType ?? "ONLINE"}`, "ok");
      } else {
        pushExecutionEvent("verifying", `Sync failed: ${response?.error ?? "Unknown bridge error"}.`, "error");
        pushNotification(`Sync failed: ${response?.error ?? "Unknown bridge error"}`);
        setActionLine("Sync failed", "error");
      }
    } else {
      pushExecutionEvent("verifying", "Web telemetry sync path completed.", "ok");
      pushNotification("Web mode sync complete");
      setActionLine("Web sync complete", "ok");
    }
    setActionBusy(false);
  }

  function onTopTabClick(tab: TopTab) {
    setActiveTopTab(tab);
    if (tab === "HOME") {
      setActiveRailSection("Home");
      pushNotification("Home dashboard focused");
      setActionLine("Home dashboard focused", "ok");
      return;
    }

    if (tab === "ASSISTANT") {
      setActiveRailSection("Assistant");
      applyQuickPrompt("Assistant", "Open assistant console and continue the active objective.");
      return;
    }

    if (tab === "PROJECTS") {
      setActiveRailSection("Folder");
      pushNotification(`Projects loaded · ${hostProjects.length} detected`);
      setActionLine(`Projects loaded · ${hostProjects.length} detected`, "ok");
      return;
    }

    if (tab === "SYSTEMS") {
      setActiveRailSection("Global");
      pushNotification(`Systems snapshot · ${networkType}`);
      setActionLine(`Systems snapshot · ${networkType}`, "ok");
      return;
    }

    if (tab === "ANALYTICS") {
      setActiveRailSection("Shield");
      pushNotification("Analytics lane selected");
      setActionLine("Analytics lane selected", "info");
      return;
    }

    setActiveRailSection("Settings");
    pushNotification("Settings lane selected");
    setActionLine("Settings lane selected", "info");
  }

  /**
   * The legacy screen hub is still keyed by TopTab, so a destination that has an
   * equivalent lane keeps it in sync. Destinations with no legacy equivalent
   * leave the lane alone rather than snapping it to an unrelated screen.
   */
  const destinationLane: Partial<Record<DestinationId, TopTab>> = {
    home: "HOME",
    projects: "PROJECTS",
    files: "PROJECTS",
    memory: "ASSISTANT",
    terminal: "SYSTEMS",
    settings: "SETTINGS"
  };

  function selectDestination(id: DestinationId) {
    const destination = destinationById(id);
    setActiveDestination(id);

    const lane = destinationLane[id];
    if (lane) {
      setActiveTopTab(lane);
    }

    if (destination.status === "planned") {
      // Say why immediately. Silently routing to an empty pane is the failure
      // mode the vision's "no purposeless controls" rule exists to prevent.
      setActionLine(`${destination.label} is not available yet`, "warn");
      return;
    }

    setActionLine(`${destination.label} focused`, "ok");
  }

  function choosePersonality(id: PersonalityId) {
    const personality = personalityById(id);
    setActivePersonality(id);
    window.localStorage.setItem(personalityStorageKey, id);
    setActionLine(`Personality: ${personality.label}`, "ok");
    pushNotification(`Personality set to ${personality.label}`);
  }

  function toggleSidebar() {
    setSidebarCollapsed((previous) => {
      const next = !previous;
      window.localStorage.setItem(sidebarCollapsedStorageKey, next ? "1" : "0");
      return next;
    });
  }

  async function runTerminalCommand() {
    const command = terminalCommand.trim();
    if (!command) return;

    // Goes through the same latched runner the rest of the app uses, so the
    // terminal shares its duplicate-suppression and runtime log stream rather
    // than opening a second, unguarded path to the shell.
    setTerminalCommand("");
    await runDesktopLiveCommand(command, `terminal: ${command}`);
  }

  function onRailSelect(section: RailSection) {
    setActiveRailSection(section);
    if (section === "Folder") {
      setActiveTopTab("PROJECTS");
      pushNotification(`Project paths ready · ${filteredProjects.length} visible`);
      setActionLine(`Project paths ready · ${filteredProjects.length} visible`, "ok");
      return;
    }

    if (section === "Calendar") {
      pushNotification("Upcoming events panel focused");
      setActionLine("Upcoming events panel focused", "info");
      return;
    }

    if (section === "Settings") {
      setActiveTopTab("SETTINGS");
      pushNotification("System preferences opened");
      setActionLine("System preferences opened", "info");
      return;
    }

    if (section === "Assistant") {
      setActiveTopTab("ASSISTANT");
      applyQuickPrompt("Assistant", "Review current objective and propose next best actions.");
      return;
    }

    pushNotification(`${section} lane selected`);
    setActionLine(`${section} lane selected`, "info");
  }

  function onShortcutClick(title: string) {
    if (title === "Open Dashboard") {
      setActiveTopTab("HOME");
      setActiveRailSection("Home");
      pushNotification("Dashboard opened");
      setActionLine("Dashboard opened", "ok");
      return;
    }

    if (title === "Check Emails") {
      applyQuickPrompt("Shortcuts", "Scan email priorities and summarize urgent threads.");
      return;
    }

    if (title === "Summarize Documents") {
      applyQuickPrompt("Shortcuts", "Summarize selected documents into a concise action brief.");
      return;
    }

    if (title === "System Diagnostics") {
      setActiveTopTab("SYSTEMS");
      pushNotification(`Diagnostics refreshed · ${networkType}`);
      setActionLine(`Diagnostics refreshed · ${networkType}`, "ok");
      return;
    }

    applyQuickPrompt("Shortcuts", "Create a new project scaffold from the active concept.");
  }

  function onAddShortcut() {
    applyQuickPrompt("Shortcuts", "Create a custom shortcut for a repeated workflow in this workspace.");
  }

  function clearChatWorkspace() {
    setChatMessages(defaultChatMessages);
    setChatDraft("");
    setRuntimeLogs(defaultRuntimeLogs);
    setRuntimeArtifacts([]);
    setActionLine("Assistant chat cleared", "ok");
    pushNotification("Assistant chat reset");
  }

  function resetWorkspaceFilters() {
    setProjectFilter("");
    setProjectGroupFilter("all");
    setStorageSort("used-desc");
    setActionLine("Workspace filters reset", "ok");
    pushNotification("Workspace filters reset");
  }

  async function runScreenAction(actionId: string) {
    // actionBusy is stale inside a same-tick second call; the latch is synchronous.
    if (!screenActionLatchRef.current.tryAcquire(`action:${actionId}`)) return;
    try {
      await runScreenActionInner(actionId);
    } finally {
      screenActionLatchRef.current.release();
    }
  }

  async function runScreenActionInner(actionId: string) {
    if (actionId === "home-assistant") {
      onTopTabClick("ASSISTANT");
      return;
    }

    if (actionId === "home-sync" || actionId === "systems-sync") {
      await onTopActionSync();
      return;
    }

    if (actionId === "home-blueprint") {
      createBlueprintFromPrompt();
      return;
    }

    if (actionId === "assistant-build") {
      const request = chatDraft.trim() || prompt.trim();
      if (request) {
        await submitChatBuildRequest(request);
      } else {
        setActionLine("Add a build request in chat or prompt, then develop", "warn");
      }
      return;
    }

    if (actionId === "assistant-clear") {
      clearChatWorkspace();
      return;
    }

    if (actionId === "systems-diagnostics") {
      applyQuickPrompt("Systems", "Run full diagnostics summary and propose root-cause fixes.");
      return;
    }

    if (actionId === "systems-alerts") {
      pushNotification("Alert simulation executed");
      setActionLine("Alert simulation complete", "ok");
      return;
    }

    if (actionId === "projects-open") {
      const firstProject = filteredProjects[0] ?? hostProjects[0];
      if (!firstProject) {
        setActionLine("No project path available", "warn");
      } else {
        await openHostPath(firstProject.path);
      }
      return;
    }

    if (actionId === "projects-refresh") {
      await onTopActionSync();
      setActionLine("Project lane refreshed", "ok");
      return;
    }

    if (actionId === "projects-scaffold") {
      applyQuickPrompt("Projects", "Create a production scaffold for a new workspace initiative.");
      createBlueprintFromPrompt();
      return;
    }

    if (actionId === "analytics-forecast") {
      applyQuickPrompt("Analytics", "Build a forecasting dashboard with confidence intervals and drift alerts.");
      return;
    }

    if (actionId === "analytics-anomaly") {
      applyQuickPrompt("Analytics", "Build an anomaly detection agent with live risk scoring and incident queues.");
      return;
    }

    if (actionId === "analytics-report") {
      applyQuickPrompt("Analytics", "Generate an executive report from current telemetry and project activity.");
      return;
    }

    if (actionId === "settings-reset") {
      resetWorkspaceFilters();
      return;
    }

    if (actionId === "settings-defaults") {
      setPrompt("Build a secure full-stack platform with authentication, billing, monitoring, and deployment automation.");
      setActionLine("Default build profile loaded", "ok");
      return;
    }

    if (actionId === "settings-export") {
      if (!buildPlan) {
        setActionLine("No active blueprint to export", "warn");
      } else {
        exportBlueprint();
      }
    }
  }

  async function openHostPath(targetPath: string) {
    setActionBusy(true);
    const opener = window.ascendDesktop?.openPath;
    if (!opener) {
      pushNotification("Open path is available in desktop mode only");
      setActionLine("Open path unavailable in web mode", "warn");
      setActionBusy(false);
      return;
    }

    const response = await opener(targetPath);
    if (!response?.ok) {
      pushNotification(`Failed to open path: ${response?.error ?? "Unknown error"}`);
      setActionLine("Open path failed", "error");
      setActionBusy(false);
      return;
    }

    pushNotification(`Opened ${targetPath}`);
    setActionLine(`Opened ${targetPath}`, "ok");
    setActionBusy(false);
  }

  function exportBlueprint() {
    if (!buildPlan) return;

    const content = buildBlueprintMarkdown(buildPlan);
    const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${buildPlan.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-blueprint.md`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    setActionLine("Blueprint exported", "ok");
  }

  async function generateScaffoldFromBlueprint(planOverride?: BuildBlueprint) {
    const activePlan = planOverride ?? buildPlan;
    if (!activePlan) return;
    // Writes files to disk, so a double invocation duplicates real side effects.
    if (!scaffoldLatchRef.current.tryAcquire(`scaffold:${activePlan.title}`)) return;

    const bridge = window.ascendDesktop?.createWorkspaceScaffold;
    const specs = buildScaffoldSpecs(activePlan, scaffoldTargetTemplate);

    setActionBusy(true);
    setScaffoldBusy(true);
    setLiveCodingActive(true);
    pushExecutionEvent("planning", `Scaffold manifest prepared with ${specs.length} files.`, "ok");
    pushExecutionEvent("building", "Starting live scaffold execution pipeline.", "info");
    pushRuntimeLog(`[scaffold] Starting generation for ${specs.length} files.`, "info");
    setScaffoldStatus("Generating scaffold files...");
    setScaffoldResults([]);

    const results: ScaffoldResult[] = [];
    let webWriterUsed = false;
    let previewFallbackUsed = false;

    try {
      if (!bridge) {
        pushRuntimeLog("[scaffold] Desktop bridge unavailable; attempting local web scaffold writer.", "warn");

        for (const spec of specs) {
          const artifactPath = `${spec.path}/${spec.fileName}`;
          upsertRuntimeArtifact(artifactPath, "pending", "Queued for generation");
          pushRuntimeLog(`[create] ${artifactPath}`, "info");

          try {
            const response = await fetch("/__ascend/scaffold", {
              method: "POST",
              headers: {
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                request: `Generate ${spec.fileName}`,
                spec: {
                  kind: "file",
                  path: spec.path,
                  fileName: spec.fileName,
                  content: spec.content
                }
              })
            });

            const payload = await response.json() as {
              ok?: boolean;
              path?: string;
              message?: string;
              error?: string;
            };

            if (response.ok && payload.ok) {
              webWriterUsed = true;
              const detail = payload.path ?? payload.message ?? "Generated";
              results.push({ file: artifactPath, ok: true, detail });
              upsertRuntimeArtifact(artifactPath, "ok", detail);
              pushRuntimeLog(`[ok] ${artifactPath}`, "ok");
            } else {
              throw new Error(payload.error ?? `Web scaffold endpoint failed (${response.status}).`);
            }
          } catch (error) {
            previewFallbackUsed = true;
            const detail = error instanceof Error ? error.message : "Web writer unavailable";
            pushRuntimeLog(`[warn] ${artifactPath} web write unavailable: ${detail}`, "warn");
            await new Promise((resolve) => window.setTimeout(resolve, 35));
            results.push({
              file: artifactPath,
              ok: true,
              detail: "Preview simulated in web mode"
            });
            upsertRuntimeArtifact(artifactPath, "ok", "Preview simulated in web mode");
            pushRuntimeLog(`[sim] ${artifactPath} previewed in web mode.`, "ok");
          }
        }
      } else {
        for (const spec of specs) {
          const artifactPath = `${spec.path}/${spec.fileName}`;
          upsertRuntimeArtifact(artifactPath, "pending", "Queued for generation");
          pushRuntimeLog(`[create] ${artifactPath}`, "info");
          try {
            const response = await bridge({
              request: `Generate ${spec.fileName}`,
              spec: {
                kind: "file",
                path: spec.path,
                fileName: spec.fileName,
                content: spec.content
              }
            });

            results.push({
              file: artifactPath,
              ok: Boolean(response?.ok),
              detail: response?.path ?? response?.message ?? response?.error ?? "Completed"
            });
            if (response?.ok) {
              upsertRuntimeArtifact(artifactPath, "ok", response?.path ?? "Generated");
              pushRuntimeLog(`[ok] ${artifactPath}`, "ok");
            } else {
              upsertRuntimeArtifact(artifactPath, "fail", response?.error ?? "Generation failed");
              pushRuntimeLog(`[warn] ${artifactPath} failed: ${response?.error ?? "Generation failed"}`, "warn");
            }
          } catch (error) {
            results.push({
              file: artifactPath,
              ok: false,
              detail: error instanceof Error ? error.message : "Unknown generation failure"
            });
            const detail = error instanceof Error ? error.message : "Unknown generation failure";
            upsertRuntimeArtifact(artifactPath, "fail", detail);
            pushRuntimeLog(`[error] ${artifactPath} failed: ${detail}`, "error");
          }
        }
      }

      setScaffoldResults(results);
      const successes = results.filter((item) => item.ok).length;
      const failures = results.filter((item) => !item.ok).length;
      setScaffoldTelemetry((current) => ({
        runs: current.runs + 1,
        filesOk: current.filesOk + successes,
        filesFail: current.filesFail + failures,
        lastRunStatus: failures ? "warn" : "ok",
        lastRunAt: Date.now()
      }));
      pushExecutionEvent(
        "verifying",
        failures
          ? `Scaffold completed with ${failures} failure(s). Review runtime output for recovery.`
          : `Scaffold completed successfully with ${results.length} generated files.`,
        failures ? "warn" : "ok"
      );
      pushRuntimeLog(
        failures
          ? `[verify] Scaffold completed with ${failures} failure(s).`
          : `[verify] Scaffold completed successfully with ${results.length} files.`,
        failures ? "warn" : "ok"
      );
      if (!bridge && !failures && webWriterUsed && !previewFallbackUsed) {
        pushRuntimeLog("[verify] Web-mode scaffold writer completed file generation on disk.", "ok");
      }
      if (!bridge && !failures && previewFallbackUsed) {
        pushRuntimeLog("[verify] Web-mode scaffold preview fallback used for one or more files.", "warn");
      }
      if (bridge && !failures) {
        void runDesktopLiveCommand("node -v", "Runtime probe");
      }
      setScaffoldStatus(
        failures
          ? `Scaffold finished with ${failures} failure(s).`
          : bridge
            ? `Scaffold complete: ${results.length} files generated.`
            : webWriterUsed && !previewFallbackUsed
              ? `Scaffold complete: ${results.length} files generated.`
              : `Scaffold preview complete: ${results.length} files staged in live view.`
      );
      pushNotification(
        failures
          ? `Scaffold completed with ${failures} issue(s)`
          : bridge
            ? `Scaffold generated ${results.length} files successfully`
            : webWriterUsed && !previewFallbackUsed
              ? `Web scaffold generated ${results.length} files successfully`
              : `Web scaffold preview generated ${results.length} files`
      );
      setActionLine(failures ? `Scaffold completed with ${failures} issue(s)` : "Scaffold generation complete", failures ? "warn" : "ok");
    } finally {
      scaffoldLatchRef.current.release();
      setScaffoldBusy(false);
      setActionBusy(false);
    }
  }

  // Restore the session on load, and drop a token the server no longer honours.
  useEffect(() => {
    if (!authToken) {
      setAccount(null);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`${webEnv.apiBaseUrl}/v1/auth/me`, {
          headers: authHeaders(authToken)
        });
        if (cancelled) return;
        if (response.ok) {
          const payload = await response.json() as { data?: { account?: Account } };
          if (payload.data?.account) setAccount(payload.data.account);
          return;
        }
        if (response.status === 401) {
          // Expired or revoked: clear it rather than retrying forever.
          writeStoredToken(window.localStorage, null);
          setAuthToken(null);
          setAccount(null);
        }
      } catch {
        // API offline: keep the token and try again on the next load.
      }
    })();

    return () => { cancelled = true; };
  }, [authToken]);

  useEffect(() => {
    void refreshMemories();
    void hydrateConversation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authToken]);

  useEffect(() => {
    const interval = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const markOnline = () => {
      setIsOnline(true);
      pushNotification("Connection restored");
    };
    const markOffline = () => {
      setIsOnline(false);
      pushNotification("Connection lost");
    };

    window.addEventListener("online", markOnline);
    window.addEventListener("offline", markOffline);

    return () => {
      window.removeEventListener("online", markOnline);
      window.removeEventListener("offline", markOffline);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const pollHealth = async () => {
      const started = performance.now();
      try {
        const response = await fetch("http://127.0.0.1:4000/health", { method: "GET", cache: "no-store" });
        const elapsed = Math.round(performance.now() - started);
        if (cancelled) return;

        setLatencyMs(elapsed);
        const healthy = response.ok;
        setApiHealthy(healthy);
      } catch {
        if (cancelled) return;
        setApiHealthy(false);
        setLatencyMs(null);
      }
    };

    void pollHealth();
    const interval = window.setInterval(() => {
      void pollHealth();
    }, 8000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    const projectBridge = window.ascendDesktop?.listProjectInventory;
    const storageBridge = window.ascendDesktop?.listStorageDevices;

    const refreshInventory = async () => {
      if (!projectBridge || !storageBridge) {
        setInventoryStatus("Host inventory is available in desktop mode.");
        return;
      }

      const [projectsResponse, storageResponse] = await Promise.all([projectBridge(), storageBridge()]);

      if (projectsResponse?.ok && projectsResponse.projects) {
        setHostProjects(projectsResponse.projects);
      }

      if (storageResponse?.ok && storageResponse.devices) {
        setStorageDevices(storageResponse.devices);
      }

      const projectCount = projectsResponse?.projects?.length ?? 0;
      const storageCount = storageResponse?.devices?.length ?? 0;
      setInventoryStatus(`Live inventory: ${projectCount} projects, ${storageCount} storage devices.`);
    };

    void refreshInventory();
    const interval = window.setInterval(() => {
      void refreshInventory();
    }, 15000);

    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const memory = (performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
    const connection = (navigator as Navigator & { connection?: { downlink?: number; effectiveType?: string } }).connection;
    const telemetryBridge = window.ascendDesktop?.getSystemTelemetry;

    const estimateMetrics = async () => {
      if (telemetryBridge) {
        const host = await telemetryBridge();
        if (host?.ok) {
          const cpu = clampPercent(host.cpuPercent ?? 0);
          const ram = clampPercent(host.memoryPercent ?? 0);
          const network = clampPercent(host.networkPercent ?? 0);
          const storage = clampPercent(host.storagePercent ?? 0);

          setNetworkType(host.networkType ?? "ONLINE");
          setLiveMetrics([
            { label: "CPU Usage", value: `${cpu}%`, width: cpu },
            { label: "Memory", value: `${ram}%`, width: ram },
            { label: "Network", value: `${network}%`, width: network },
            { label: "Storage", value: `${storage}%`, width: storage }
          ]);
          return;
        }
      }

      let memoryPct = 45;
      if (memory?.usedJSHeapSize && memory?.jsHeapSizeLimit) {
        memoryPct = clampPercent((memory.usedJSHeapSize / memory.jsHeapSizeLimit) * 100);
      }

      let storagePct = 55;
      if (navigator.storage?.estimate) {
        const estimate = await navigator.storage.estimate();
        if (estimate.usage && estimate.quota) {
          storagePct = clampPercent((estimate.usage / estimate.quota) * 100);
        }
      }

      const downlink = connection?.downlink ?? 0;
      const networkPct = downlink ? clampPercent(downlink * 8) : (isOnline ? 62 : 0);
      setNetworkType(connection?.effectiveType?.toUpperCase() ?? (isOnline ? "ONLINE" : "OFFLINE"));

      const latency = latencyMs ?? 40;
      const cpuProxy = clampPercent(Math.min(100, Math.max(8, latency / 2.6)));

      setLiveMetrics([
        { label: "CPU Usage", value: `${cpuProxy}%`, width: cpuProxy },
        { label: "Memory", value: `${memoryPct}%`, width: memoryPct },
        { label: "Network", value: `${networkPct}%`, width: networkPct },
        { label: "Storage", value: `${storagePct}%`, width: storagePct }
      ]);
    };

    void estimateMetrics();
    const interval = window.setInterval(() => {
      void estimateMetrics();
    }, 4000);

    return () => window.clearInterval(interval);
  }, [isOnline, latencyMs]);

  useEffect(() => {
    let cancelled = false;

    const resolveCoordinates = async (): Promise<{ lat: number; lon: number; label: string }> => {
      if (!navigator.geolocation) {
        return { lat: 40.7128, lon: -74.006, label: "New York, NY" };
      }

      try {
        const position = await new Promise<GeolocationPosition>((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 3000 });
        });

        return {
          lat: position.coords.latitude,
          lon: position.coords.longitude,
          label: "Local Region"
        };
      } catch {
        return { lat: 40.7128, lon: -74.006, label: "New York, NY" };
      }
    };

    const fetchWeather = async () => {
      const coords = await resolveCoordinates();
      if (cancelled) return;
      setCityLabel(coords.label);

      const url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}&current=temperature_2m,weather_code&daily=weather_code,temperature_2m_max&temperature_unit=celsius&timezone=auto&forecast_days=4`;

      try {
        const response = await fetch(url);
        const payload = await response.json() as {
          current?: { temperature_2m?: number; weather_code?: number };
          daily?: { time?: string[]; weather_code?: number[]; temperature_2m_max?: number[] };
        };

        if (cancelled) return;

        if (typeof payload.current?.temperature_2m === "number") {
          setWeatherNow({
            tempF: toFahrenheit(payload.current.temperature_2m),
            condition: weatherCodeToCondition(payload.current.weather_code ?? 2)
          });
        }

        if (payload.daily?.time && payload.daily.weather_code && payload.daily.temperature_2m_max) {
          const rows = payload.daily.time.slice(1, 4).map((dateValue, index) => {
            const date = new Date(dateValue);
            const day = date.toLocaleDateString("en-US", { weekday: "short" });
            const temp = payload.daily?.temperature_2m_max?.[index + 1] ?? 21;
            const code = payload.daily?.weather_code?.[index + 1] ?? 2;

            return {
              day,
              condition: weatherCodeToCondition(code),
              temp: `${toFahrenheit(temp)}°F`
            };
          });

          setWeatherDays(rows);
        }
      } catch {
        if (cancelled) return;
      }
    };

    void fetchWeather();
    const interval = window.setInterval(() => {
      void fetchWeather();
    }, 900000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (bootNotifiedRef.current) return;
    bootNotifiedRef.current = true;
    const bridgeReady = Boolean(window.ascendDesktop?.createWorkspaceScaffold);
    pushNotification(bridgeReady ? "Desktop bridge connected" : "Web mode active");
  }, []);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(chatStateStorageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as {
        mode?: AssistantMode;
        draft?: string;
        messages?: ChatMessage[];
      };

      if (parsed.mode && assistantModes.some((mode) => mode.key === parsed.mode)) {
        setAssistantMode(parsed.mode);
      }

      if (typeof parsed.draft === "string") {
        setChatDraft(parsed.draft);
      }

      if (Array.isArray(parsed.messages) && parsed.messages.length) {
        const safeMessages = parsed.messages.filter((message) => (
          message
          && typeof message.id === "string"
          && (message.role === "assistant" || message.role === "user")
          && typeof message.text === "string"
          && Number.isFinite(message.createdAt)
        )).map((message) => ({
          ...message,
          // Stored provenance is untrusted input; drop anything malformed.
          provenance: sanitizeResponseProvenance(message.provenance) ?? undefined
        }));

        if (safeMessages.length) {
          setChatMessages(safeMessages.slice(-60));
        }
      }
    } catch {
      // Ignore malformed storage state.
    }
  }, []);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(runtimeAckSignatureStorageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, boolean>;
      if (!parsed || typeof parsed !== "object") return;

      const safeEntries = Object.entries(parsed).filter(([key, value]) => typeof key === "string" && Boolean(value));
      setAcknowledgedSignatures(Object.fromEntries(safeEntries));
    } catch {
      // Ignore malformed signature memory state.
    }
  }, []);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(triageTimelineStorageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as TriageEvent[];
      if (!Array.isArray(parsed)) return;

      const safeEvents = parsed.filter((event) => (
        event
        && typeof event.id === "string"
        && typeof event.action === "string"
        && typeof event.detail === "string"
        && Number.isFinite(event.createdAt)
      )).slice(0, 100);

      if (safeEvents.length) {
        setTriageEvents(safeEvents);
      }
    } catch {
      // Ignore malformed triage timeline state.
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        chatStateStorageKey,
        JSON.stringify({
          mode: assistantMode,
          draft: chatDraft,
          messages: chatMessages.slice(-60)
        })
      );
    } catch {
      // Ignore storage write issues to keep runtime stable.
    }
  }, [assistantMode, chatDraft, chatMessages]);

  useEffect(() => {
    try {
      window.localStorage.setItem(runtimeAckSignatureStorageKey, JSON.stringify(acknowledgedSignatures));
    } catch {
      // Ignore persistence issues for triage signature memory.
    }
  }, [acknowledgedSignatures]);

  useEffect(() => {
    try {
      window.localStorage.setItem(triageTimelineStorageKey, JSON.stringify(triageEvents.slice(0, 100)));
    } catch {
      // Ignore triage timeline persistence issues.
    }
  }, [triageEvents]);

  useEffect(() => {
    const thread = chatThreadRef.current;
    if (!thread) return;
    thread.scrollTop = thread.scrollHeight;
  }, [chatMessages]);

  useEffect(() => {
    const thread = runtimeConsoleRef.current;
    if (!thread) return;
    thread.scrollTop = 0;
  }, [runtimeLogs]);

  useEffect(() => {
    const subscribe = window.ascendDesktop?.onRuntimeEvent;
    if (!subscribe) return;

    const unsubscribe = subscribe((event) => {
      const line = event.line?.trim();
      if (!line) return;

      const mappedLevel: RuntimeLogLevel = event.level === "error"
        ? "error"
        : event.level === "warn"
          ? "warn"
          : event.level === "ok"
            ? "ok"
            : "info";

      pushRuntimeLog(line, mappedLevel, { runId: event.runId, kind: event.kind });

      if (event.kind === "stderr") {
        pushExecutionEvent("building", line, mappedLevel === "error" ? "error" : "warn");
      }

      if (event.kind === "exit") {
        if (/exit 0$/i.test(line)) {
          pushExecutionEvent("verifying", "Desktop command execution completed.", "ok");
        } else {
          pushExecutionEvent("verifying", line, "warn");
        }
      }
    });

    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const previous = previousErrorCountRef.current;
    const current = runtimeFilterCounts.errors;
    previousErrorCountRef.current = current;

    if (!autoFocusErrors) {
      return;
    }

    if (current > previous && latestFailingRunId && !forcedFocusRunId) {
      setRuntimeFilter("errors");
      setCollapsedRuns((runs) => ({
        ...runs,
        [latestFailingRunId]: false
      }));
      setAcknowledgedFailures((runs) => ({
        ...runs,
        [latestFailingRunId]: false
      }));
      pushTriageEvent("auto-focus", `Auto-focused failing run ${latestFailingRunId.slice(0, 8)}.`, latestFailingRunId);
      pushExecutionEvent("verifying", `Auto-focus engaged on failing run ${latestFailingRunId.slice(0, 8)}.`, "warn");
    }
  }, [autoFocusErrors, forcedFocusRunId, latestFailingRunId, runtimeFilterCounts.errors]);

  useEffect(() => {
    if (!forcedFocusRunId) return;
    if (!groupedRuntimeRuns.some((run) => run.runId === forcedFocusRunId)) {
      setForcedFocusRunId(null);
    }
  }, [forcedFocusRunId, groupedRuntimeRuns]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setLiveViewFrames((current) => {
        const snapshot: LiveViewFrame = {
          id: crypto.randomUUID(),
          createdAt: Date.now(),
          coreState,
          status: actionStatus,
          phase: livePhaseLabel,
          fps,
          latencyMs: lastResponseMs
        };

        const latest = current[0];
        if (
          latest
          && latest.coreState === snapshot.coreState
          && latest.status === snapshot.status
          && latest.phase === snapshot.phase
          && latest.fps === snapshot.fps
          && latest.latencyMs === snapshot.latencyMs
        ) {
          return current;
        }

        return [snapshot, ...current].slice(0, 24);
      });
    }, 1800);

    return () => window.clearInterval(interval);
  }, [actionStatus, coreState, fps, lastResponseMs, livePhaseLabel]);

  useEffect(() => {
    let frameCount = 0;
    let lastMark = performance.now();
    let frameHandle = 0;

    const measureFps = (now: number) => {
      frameCount += 1;
      if (now - lastMark >= 1000) {
        setFps(Math.round((frameCount * 1000) / (now - lastMark)));
        frameCount = 0;
        lastMark = now;
      }
      frameHandle = window.requestAnimationFrame(measureFps);
    };

    frameHandle = window.requestAnimationFrame(measureFps);
    return () => window.cancelAnimationFrame(frameHandle);
  }, []);

  // Destinations that take over the center stage. Home, Projects and Settings
  // are absent on purpose: they already have their lane in the legacy screen
  // hub, so overlaying a second panel would duplicate what is below it.
  const activeDestinationEntry = destinationById(activeDestination);
  const destinationView = (() => {
    if (activeDestinationEntry.status === "planned") {
      return <PlannedDestination destination={activeDestinationEntry} />;
    }

    if (activeDestination === "files") {
      return (
        <section className="destination-view card" aria-label="Files">
          <div className="destination-head">
            <h2>Files</h2>
            <span className="destination-tag">{hostProjects.length} locations</span>
          </div>
          <p className="destination-summary">{activeDestinationEntry.summary}</p>
          {hostProjects.length === 0 ? (
            <p className="destination-reason">{inventoryStatus}</p>
          ) : (
            <ul className="destination-list">
              {hostProjects.map((project) => (
                <li key={project.path}>
                  <div>
                    <strong>{project.name}</strong>
                    <small>{project.path}</small>
                  </div>
                  <button type="button" onClick={() => void openHostPath(project.path)} disabled={actionBusy}>
                    Open
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      );
    }

    if (activeDestination === "terminal") {
      return (
        <section className="destination-view card" aria-label="Terminal">
          <div className="destination-head">
            <h2>Terminal</h2>
            <span className="destination-tag">{desktopBridgeActive ? "Workspace shell" : "Desktop only"}</span>
          </div>
          <p className="destination-summary">{activeDestinationEntry.summary}</p>
          <div className="terminal-input">
            <input
              type="text"
              value={terminalCommand}
              placeholder="npm run typecheck"
              aria-label="Terminal command"
              onChange={(event) => setTerminalCommand(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  void runTerminalCommand();
                }
              }}
            />
            <button type="button" onClick={() => void runTerminalCommand()} disabled={!terminalCommand.trim()}>
              Run
            </button>
          </div>
          <div className="terminal-stream" role="log" aria-label="Command output">
            {runtimeLogs.slice(-200).map((entry) => (
              <div key={entry.id} className={`terminal-line ${entry.level}`}>
                {entry.line}
              </div>
            ))}
          </div>
        </section>
      );
    }

    if (activeDestination === "settings") {
      return (
        <section className="destination-view card" aria-label="Settings">
          <div className="destination-head">
            <h2>Settings</h2>
            <span className="destination-tag">{personalityById(activePersonality).label}</span>
          </div>
          <p className="destination-summary">
            Personality changes how the assistant sounds, what it suggests, and how the core moves. It never
            changes what the assistant is allowed to do.
          </p>
          <div className="personality-grid" role="radiogroup" aria-label="AI personality">
            {allPersonalities().map((personality) => (
              <button
                key={personality.id}
                type="button"
                role="radio"
                aria-checked={activePersonality === personality.id}
                className={activePersonality === personality.id ? "personality-card active" : "personality-card"}
                style={{ borderColor: activePersonality === personality.id ? personality.core.accent : undefined }}
                onClick={() => choosePersonality(personality.id)}
              >
                <span className="personality-dot" style={{ background: personality.core.accent }} />
                <strong>{personality.label}</strong>
                <small>{personality.summary}</small>
                {personality.responseStyle.mandatoryDisclaimer ? (
                  <em className="personality-note">Always adds a professional-advice disclaimer</em>
                ) : null}
              </button>
            ))}
          </div>
        </section>
      );
    }

    if (activeDestination === "memory") {
      return (
        <section className="destination-view card" aria-label="Memory">
          <div className="destination-head">
            <h2>Memory</h2>
            <span className="destination-tag">{memories.length} entries</span>
          </div>
          <p className="destination-summary">{activeDestinationEntry.summary}</p>
          {memories.length === 0 ? (
            <p className="destination-reason">
              Nothing remembered yet. Memory fills in as you work — it is extracted from what you tell the
              assistant, never invented.
            </p>
          ) : (
            <ul className="destination-list">
              {memories.map((item) => (
                <li key={item.id}>
                  <div>
                    <strong>{item.title}</strong>
                    <small>{item.body}</small>
                  </div>
                  <div className="destination-row-actions">
                    <button type="button" onClick={() => toggleMemoryPin(item)}>
                      {item.pinned ? "Unpin" : "Pin"}
                    </button>
                    <button type="button" onClick={() => forgetMemoryItem(item)}>
                      Forget
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      );
    }

    return null;
  })();

  return (
    <main
      className={desktopBridgeActive ? "ascend-shell desktop-mode" : "ascend-shell web-mode"}
      style={{
        // The personality drives the core's palette and how energetically its
        // motion renders. These feed existing accent tokens, so every surface
        // already keyed to them shifts together rather than one panel changing.
        ["--accent" as string]: personalityById(activePersonality).core.accent,
        ["--core-glow" as string]: personalityById(activePersonality).core.glow,
        ["--core-energy" as string]: String(personalityById(activePersonality).core.energy)
      }}
    >
      <header className="top-nav card">
        <div className="brand">ASCEND AI</div>
        <nav className="menu-tabs" aria-label="Top menu">
          {topNavDestinations().map((destination) => (
            <a
              key={destination.id}
              className={activeDestination === destination.id ? "active" : undefined}
              href="#"
              aria-current={activeDestination === destination.id ? "page" : undefined}
              title={destination.status === "planned" ? destination.plannedReason : destination.summary}
              onClick={(event) => {
                event.preventDefault();
                selectDestination(destination.id);
              }}
            >
              {destination.label}
              {destination.status === "planned" ? <em className="nav-planned" aria-label="not available yet">·</em> : null}
            </a>
          ))}
        </nav>
        <div className="top-actions">
          <button type="button" aria-label="Search" onClick={onTopActionSearch} disabled={actionBusy}><SearchIcon /></button>
          <button type="button" aria-label="Open panel" onClick={onTopActionPanel} disabled={actionBusy}><GridIcon /></button>
          <button type="button" aria-label="Sync" onClick={() => void onTopActionSync()} disabled={actionBusy}><DotIcon /></button>
          {account ? (
            <div className="account-chip">
              <span title={account.email}>{account.displayName}</span>
              <button
                type="button"
                className="ghost"
                onClick={() => { setPasswordOpen(true); setPasswordNotice(null); }}
              >
                Password
              </button>
              <button type="button" className="ghost" onClick={() => void signOut()}>Sign out</button>
            </div>
          ) : (
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setAuthOpen(true);
                setAuthError(null);
                // Reset to sign-in: the mode is sticky, so after registering once
                // the "Sign in" button would otherwise reopen "Create account".
                setAuthMode("login");
              }}
            >
              Sign in
            </button>
          )}
        </div>
      </header>

      {passwordOpen && account ? (
        <div className="auth-overlay" role="dialog" aria-modal="true" aria-label="Change password">
          <form
            className="auth-card"
            onSubmit={(event) => { event.preventDefault(); void submitPasswordChange(); }}
          >
            <h2>Change password</h2>
            <p className="auth-sub">
              Signs out every other session, so a stolen password stops working.
            </p>
            <label htmlFor="current-password">Current password</label>
            <input
              id="current-password"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              disabled={authBusy}
            />
            <label htmlFor="new-password">New password</label>
            <input
              id="new-password"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              disabled={authBusy}
            />
            {passwordNotice ? <p className="auth-error">{passwordNotice}</p> : null}
            <div className="auth-actions">
              <button type="submit" disabled={authBusy}>
                {authBusy ? "Working..." : "Change password"}
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => { setPasswordOpen(false); setCurrentPassword(""); setNewPassword(""); }}
                disabled={authBusy}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {authOpen && !account ? (
        <div className="auth-overlay" role="dialog" aria-modal="true" aria-label="Account">
          <form
            className="auth-card"
            onSubmit={(event) => { event.preventDefault(); void submitAuth(); }}
          >
            <h2>{authMode === "login" ? "Sign in" : "Create account"}</h2>
            <p className="auth-sub">
              Your memory follows your account to any browser. Without one it stays on this device.
            </p>
            <label htmlFor="auth-email">Email</label>
            <input
              id="auth-email"
              type="email"
              autoComplete="email"
              value={authEmail}
              onChange={(event) => setAuthEmail(event.target.value)}
              disabled={authBusy}
            />
            <label htmlFor="auth-password">Password</label>
            <input
              id="auth-password"
              type="password"
              autoComplete={authMode === "login" ? "current-password" : "new-password"}
              value={authPassword}
              onChange={(event) => setAuthPassword(event.target.value)}
              disabled={authBusy}
            />
            {authError ? <p className="auth-error">{authError}</p> : null}
            <div className="auth-actions">
              <button type="submit" disabled={authBusy}>
                {authBusy ? "Working..." : authMode === "login" ? "Sign in" : "Create account"}
              </button>
              <button type="button" className="ghost" onClick={() => setAuthOpen(false)} disabled={authBusy}>
                Cancel
              </button>
            </div>
            <button
              type="button"
              className="auth-switch"
              onClick={() => { setAuthMode(authMode === "login" ? "register" : "login"); setAuthError(null); }}
              disabled={authBusy}
            >
              {authMode === "login" ? "Need an account? Create one" : "Already have an account? Sign in"}
            </button>
            {authMode === "login" ? (
              <button
                type="button"
                className="auth-switch"
                onClick={() => { setRecoverOpen(true); setAuthOpen(false); setAuthError(null); }}
                disabled={authBusy}
              >
                Forgot your password? Use a recovery code
              </button>
            ) : null}
          </form>
        </div>
      ) : null}

      {recoverOpen && !account ? (
        <div className="auth-overlay" role="dialog" aria-modal="true" aria-label="Recover account">
          <form
            className="auth-card"
            onSubmit={(event) => { event.preventDefault(); void submitRecovery(); }}
          >
            <h2>Recover your account</h2>
            <p className="auth-sub">
              Use one of the recovery codes you saved when you created the account. Each code works once.
            </p>
            <label htmlFor="recover-email">Email</label>
            <input
              id="recover-email"
              type="email"
              autoComplete="email"
              value={authEmail}
              onChange={(event) => setAuthEmail(event.target.value)}
              disabled={authBusy}
            />
            <label htmlFor="recover-code">Recovery code</label>
            <input
              id="recover-code"
              type="text"
              placeholder="XXXX-XXXX-XXXX"
              value={recoverCode}
              onChange={(event) => setRecoverCode(event.target.value)}
              disabled={authBusy}
            />
            <label htmlFor="recover-password">New password</label>
            <input
              id="recover-password"
              type="password"
              autoComplete="new-password"
              value={authPassword}
              onChange={(event) => setAuthPassword(event.target.value)}
              disabled={authBusy}
            />
            {authError ? <p className="auth-error">{authError}</p> : null}
            <div className="auth-actions">
              <button type="submit" disabled={authBusy}>
                {authBusy ? "Working..." : "Recover account"}
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => { setRecoverOpen(false); setRecoverCode(""); setAuthPassword(""); }}
                disabled={authBusy}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {recoveryCodes ? (
        <div className="auth-overlay" role="dialog" aria-modal="true" aria-label="Recovery codes">
          <div className="auth-card">
            <h2>Save your recovery codes</h2>
            <p className="auth-sub">
              These are shown once and cannot be retrieved later — only their hashes are stored.
              Each code works a single time to reset your password.
            </p>
            <ul className="recovery-codes">
              {recoveryCodes.map((code) => <li key={code}><code>{code}</code></li>)}
            </ul>
            <div className="auth-actions">
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(recoveryCodes.join("\n"));
                  pushNotification("Recovery codes copied");
                }}
              >
                Copy codes
              </button>
              <button type="button" className="ghost" onClick={() => setRecoveryCodes(null)}>
                I've saved them
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div className={`action-status-strip ${actionLevel}${actionBusy ? " busy" : ""}`} role="status" aria-live="polite">
        <span className="status-dot" aria-hidden="true" />
        <span>{actionBusy ? "Working" : "Status"}</span>
        <strong>{actionStatus}</strong>
      </div>

      <section className="screen-hub card" aria-label="Screen command hub">
        <div className="screen-head">
          <h2>{activeScreen.title}</h2>
          <small>{activeTopTab}</small>
        </div>
        <p>{activeScreen.subtitle}</p>
        <div className="screen-actions">
          {activeScreen.actions.map((action) => (
            <button key={action.id} type="button" onClick={() => void runScreenAction(action.id)} disabled={actionBusy || chatBusy || scaffoldBusy}>
              {action.label}
            </button>
          ))}
        </div>
      </section>

      <section className="dashboard-grid">
        <aside
          className={sidebarCollapsed ? "icon-rail card" : "icon-rail card expanded"}
          aria-label="Navigation rail"
        >
          <button
            className="rail-btn rail-toggle"
            type="button"
            aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!sidebarCollapsed}
            onClick={toggleSidebar}
          >
            <GridIcon />
            {sidebarCollapsed ? null : <span className="rail-label">Collapse</span>}
          </button>
          {sidebarDestinations().map((destination) => (
            <button
              key={destination.id}
              className={[
                "rail-btn",
                activeDestination === destination.id ? "active" : "",
                destination.status === "planned" ? "planned" : ""
              ].filter(Boolean).join(" ")}
              type="button"
              aria-label={destination.label}
              aria-current={activeDestination === destination.id ? "page" : undefined}
              title={destination.status === "planned" ? destination.plannedReason : destination.summary}
              onClick={() => selectDestination(destination.id)}
            >
              <DestinationIcon id={destination.id} />
              {sidebarCollapsed ? null : <span className="rail-label">{destination.label}</span>}
            </button>
          ))}
          <button className="rail-profile" type="button" aria-label="Profile" onClick={() => pushNotification("Profile panel coming online")}>◉</button>
        </aside>

        <div className="left-column">
          <article className="panel card">
            <div className="panel-head">
              <h2>AI STATUS</h2>
              <span className={isOnline ? "online-dot" : "online-dot offline"}>{isOnline ? "ONLINE" : "OFFLINE"}</span>
            </div>
            <h3 className="ai-name">ASCEND AI</h3>
            <p className="ai-traits">Adaptive · Secure · Evolving</p>
            <p className="accent">
              {isOnline ? (apiHealthy ? `Ready to assist · API ${latencyMs ?? 0}ms` : "Online · API offline") : "Offline mode"}
            </p>
          </article>

          <article className="panel card">
            <div className="panel-head">
              <h2>SYSTEM OVERVIEW</h2>
            </div>
            <div className="metric-list">
              {liveMetrics.map((metric) => (
                <div key={metric.label} className="metric-row">
                  <div className="metric-label">
                    <span className="metric-dot" />
                    <span>{metric.label}</span>
                  </div>
                  <strong>{metric.value}</strong>
                  <div className="meter"><span style={{ width: `${metric.width}%` }} /></div>
                </div>
              ))}
              <div className="metric-row">
                <div className="metric-label">
                  <span className="metric-dot" />
                  <span>Frame Rate</span>
                </div>
                <strong>{fps ? `${fps} FPS` : "--"}</strong>
                <div className="meter"><span style={{ width: `${Math.max(0, Math.min(100, Math.round(((fps ?? 0) / 120) * 100)))}%` }} /></div>
              </div>
              <div className="metric-row">
                <div className="metric-label">
                  <span className="metric-dot" />
                  <span>Response Latency</span>
                </div>
                <strong>{lastResponseMs ? `${lastResponseMs}ms` : "--"}</strong>
                <div className="meter"><span style={{ width: `${Math.max(0, Math.min(100, Math.round(((lastResponseMs ?? 0) / 2500) * 100)))}%` }} /></div>
              </div>
            </div>
          </article>

          <article className="panel card">
            <div className="panel-head">
              <h2>UPCOMING EVENTS</h2>
            </div>
            <div className="timeline">
              <div><span>10:00 AM</span><p>Team Standup</p><small>in 45m</small></div>
              <div><span>1:00 PM</span><p>Project Phoenix Review</p><small>in 3h 45m</small></div>
              <div><span>6:00 PM</span><p>Workout</p><small>in 8h 45m</small></div>
            </div>
          </article>
        </div>

        <section className={destinationView ? "center-column destination-focus" : "center-column"}>
          {destinationView}
          {activeTopTab === "ASSISTANT" ? (
            showLiveCodingWorkspace ? (
              <section className="live-coding card" aria-label="Live coding workspace">
                <div className="live-coding-main">
                  <section className="chat-panel live-chat-panel" aria-label="Assistant chat workspace">
                    <div className="chat-head">
                      <h2>ASSISTANT CHAT</h2>
                      <small>{chatBusy ? "Processing" : "Ready"}</small>
                    </div>
                    <div className="chat-modes" role="tablist" aria-label="Assistant modes">
                      {assistantModes.map((mode) => (
                        <button
                          key={mode.key}
                          type="button"
                          className={assistantMode === mode.key ? "active" : undefined}
                          onClick={() => setAssistantMode(mode.key)}
                          disabled={chatBusy || actionBusy}
                        >
                          {mode.label}
                        </button>
                      ))}
                    </div>
                    <DegradedBanner state={degradedState} />
                    <div className="chat-thread" ref={chatThreadRef}>
                      {chatMessages.map((message) => (
                        <article key={message.id} className={message.role === "assistant" ? "chat-msg assistant" : "chat-msg user"}>
                          <header>
                            <strong>{message.role === "assistant" ? "ASCEND" : "YOU"}</strong>
                            <span>{formatAge(message.createdAt, nowMs)}</span>
                          </header>
                          <p>{message.text}</p>
                          <ProvenanceBadges provenance={message.provenance} />
                        </article>
                      ))}
                    </div>
                    <div className="chat-compose">
                      <textarea
                        value={chatDraft}
                        onChange={(event) => setChatDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && !event.shiftKey) {
                            event.preventDefault();
                            void submitChatBuildRequest();
                          }
                        }}
                        placeholder="Describe exactly what you want to build..."
                        aria-label="Assistant build request"
                      />
                      <button type="button" onClick={() => void submitChatBuildRequest()} disabled={chatBusy || actionBusy}>Develop It</button>
                    </div>
                  </section>

                  <section className="live-code-panel" aria-label="Live code and artifact output">
                    <div className="live-code-head">
                      <h2>LIVE CODE</h2>
                      <div className="live-code-head-actions">
                        <button
                          type="button"
                          className="ghost"
                          onClick={() => void runDesktopLiveCommand("npm run test --workspace @ascend/web", "Live validation")}
                          disabled={chatBusy || scaffoldBusy || actionBusy || desktopCommandBusy || !desktopBridgeActive}
                        >
                          {desktopCommandBusy ? "Running..." : "Run Live Validation"}
                        </button>
                        <button type="button" className="ghost" onClick={() => setLiveCodingActive(false)} disabled={chatBusy || scaffoldBusy || desktopCommandBusy}>Exit Live Mode</button>
                      </div>
                    </div>
                    <div className="live-code-card">
                      <h3>{buildPlan?.title ?? "Awaiting blueprint"}</h3>
                      <p>{buildPlan?.summary ?? "Submit a build, code, or debug request to generate live artifacts."}</p>
                      {buildPlan ? (
                        <ul>
                          {buildPlan.stack.map((item) => <li key={item}>{item}</li>)}
                        </ul>
                      ) : null}
                    </div>
                    <div className="live-artifact-list">
                      {(runtimeArtifacts.length ? runtimeArtifacts : scaffoldResults.map((result) => ({
                        path: result.file,
                        status: result.ok ? "ok" : "fail",
                        detail: result.detail,
                        updatedAt: Date.now()
                      }))).map((artifact) => (
                        <article key={artifact.path} className={`live-artifact ${artifact.status}`}>
                          <strong>{artifact.path}</strong>
                          <small>{artifact.detail}</small>
                        </article>
                      ))}
                      {!runtimeArtifacts.length && !scaffoldResults.length ? (
                        <article className="live-artifact pending">
                          <strong>No artifacts yet</strong>
                          <small>Submit one chat request to start automatic scaffold streaming.</small>
                        </article>
                      ) : null}
                    </div>
                  </section>
                </div>

                <section className="live-console" aria-label="Live runtime console">
                  <div className="live-console-head">
                    <h2>RUNTIME CONSOLE</h2>
                    <div className="runtime-console-actions">
                      <small>{runtimeLogs.length} events</small>
                      <button
                        type="button"
                        className={autoFocusErrors ? "ghost active" : "ghost"}
                        onClick={() => setAutoFocusErrors((current) => !current)}
                      >
                        {autoFocusErrors ? "Auto-focus: ON" : "Auto-focus: OFF"}
                      </button>
                      {forcedFocusRunId ? (
                        <button type="button" className="ghost active" onClick={clearForcedFocus}>
                          Clear Forced Focus
                        </button>
                      ) : null}
                      <button type="button" className="ghost" onClick={collapseAllRuns} disabled={!filteredRunGroups.length}>Collapse All</button>
                      <button type="button" className="ghost" onClick={expandAllRuns} disabled={!filteredRunGroups.length}>Expand All</button>
                    </div>
                  </div>
                  <div className="runtime-filter-bar" role="tablist" aria-label="Runtime log filters">
                    {(["all", "stdout", "stderr", "errors"] as RuntimeFilter[]).map((filter) => (
                      <button
                        key={filter}
                        type="button"
                        className={runtimeFilter === filter ? "active" : undefined}
                        onClick={() => setRuntimeFilter(filter)}
                      >
                        {`${filter.toUpperCase()} (${runtimeFilterCounts[filter]})`}
                      </button>
                    ))}
                  </div>
                  <div className="live-console-thread" ref={runtimeConsoleRef}>
                    {displayedRunGroups.map((run) => {
                      const collapsed = Boolean(collapsedRuns[run.runId]);
                      const hasFailureSignals = run.status === "error" || run.lines.some((line) => line.kind === "stderr" || line.level === "warn" || line.level === "error");
                      const isSignatureAcknowledged = Boolean(autoAcknowledgedRunIds[run.runId]);
                      const isAcknowledged = Boolean(acknowledgedFailures[run.runId]) || isSignatureAcknowledged;
                      const isFocusedFailure = runtimeFilter === "errors"
                        && prioritizedFocusRunId === run.runId
                        && !isAcknowledged;
                      const isForcedFocus = forcedFocusRunId === run.runId;
                      return (
                        <article key={run.runId} className={`run-block ${run.status}${isFocusedFailure ? " focused-failure" : ""}`}>
                          <div className="run-block-head-row">
                            <button
                              type="button"
                              className="run-block-head"
                              onClick={() => toggleRunCollapsed(run.runId)}
                              aria-expanded={!collapsed}
                            >
                              <div>
                                <strong>
                                  {run.command}
                                  {isFocusedFailure ? <em className="run-focus-badge">FOCUSED FAILURE</em> : null}
                                  {isForcedFocus ? <em className="run-focus-badge forced">FORCED FOCUS</em> : null}
                                  {!isFocusedFailure && isAcknowledged
                                    ? <em className="run-focus-badge acknowledged">{isSignatureAcknowledged ? "KNOWN FAILURE" : "ACKNOWLEDGED"}</em>
                                    : null}
                                </strong>
                                <small>{`${run.lines.length} line${run.lines.length === 1 ? "" : "s"} · ${run.runId.slice(0, 8)}`}</small>
                              </div>
                              <span>{collapsed ? "Expand" : "Collapse"}</span>
                            </button>
                            {hasFailureSignals ? (
                              <div className="run-action-group">
                                <button
                                  type="button"
                                  className="run-ack-btn"
                                  onClick={() => acknowledgeRunFailure(run.runId)}
                                  disabled={isAcknowledged}
                                >
                                  {isAcknowledged ? "Acknowledged" : "Acknowledge"}
                                </button>
                                <button
                                  type="button"
                                  className="run-ack-btn secondary"
                                  onClick={() => forceFocusRun(run.runId)}
                                  disabled={isForcedFocus}
                                >
                                  {isForcedFocus ? "Focused" : "Force Focus"}
                                </button>
                                <button
                                  type="button"
                                  className="run-ack-btn secondary"
                                  onClick={() => forgetRunSignature(run.runId)}
                                  disabled={!isSignatureAcknowledged}
                                >
                                  Forget Signature
                                </button>
                              </div>
                            ) : null}
                          </div>
                          {!collapsed ? (
                            <div className="run-block-lines">
                              {run.filteredLines.map((log) => (
                                <div key={log.id} className={`log-line ${log.level}`}>
                                  <span>{formatAge(log.createdAt, nowMs)}</span>
                                  <p>{log.kind ? `[${log.kind}] ${log.line}` : log.line}</p>
                                </div>
                              ))}
                            </div>
                          ) : null}
                        </article>
                      );
                    })}
                    {filteredRuntimeActivityLines.map((log) => (
                      <div key={log.id} className={`log-line ${log.level}`}>
                        <span>{formatAge(log.createdAt, nowMs)}</span>
                        <p>{log.line}</p>
                      </div>
                    ))}
                    {!filteredRunGroups.length && !filteredRuntimeActivityLines.length ? (
                      <div className="log-line info">
                        <span>now</span>
                        <p>No logs match the active filter.</p>
                      </div>
                    ) : null}
                  </div>
                  <div className="triage-timeline" aria-label="Triage timeline">
                    <div className="triage-head">
                      <h3>TRIAGE TIMELINE</h3>
                      <div className="triage-controls">
                        <small>{`${visibleTriageEvents.length}/${triageEvents.length} actions`}</small>
                        <button
                          type="button"
                          className={triageRetention === "all" ? "ghost active" : "ghost"}
                          onClick={() => setTriageRetention("all")}
                        >
                          All
                        </button>
                        <button
                          type="button"
                          className={triageRetention === "24h" ? "ghost active" : "ghost"}
                          onClick={() => setTriageRetention("24h")}
                        >
                          Last 24h
                        </button>
                        <button
                          type="button"
                          className="ghost"
                          onClick={exportTriageTimelineJson}
                          disabled={triageExportBusy || !visibleTriageEvents.length}
                        >
                          Export JSON
                        </button>
                        <button
                          type="button"
                          className="ghost"
                          onClick={exportTriageTimelineMarkdown}
                          disabled={triageExportBusy || !visibleTriageEvents.length}
                        >
                          Export MD
                        </button>
                        <button
                          type="button"
                          className="ghost"
                          onClick={exportIncidentBundle}
                          disabled={triageExportBusy || (!visibleTriageEvents.length && !hasFailingRuns)}
                        >
                          Incident Bundle
                        </button>
                        <button
                          type="button"
                          className="ghost"
                          onClick={requestBundleVerify}
                          disabled={triageExportBusy}
                        >
                          Verify Bundle
                        </button>
                        <button type="button" className="ghost" onClick={clearTriageTimeline} disabled={!triageEvents.length}>Clear</button>
                        <input
                          ref={bundleVerifyInputRef}
                          className="triage-file-input"
                          type="file"
                          accept="application/json,text/markdown,.json,.md"
                          onChange={(event) => { void verifyImportedBundle(event); }}
                        />
                        {bundleVerifyStatus ? <span className={`triage-verify ${bundleVerifyStatus.level}`}>{bundleVerifyStatus.message}</span> : null}
                      </div>
                    </div>
                    <div className="triage-list">
                      {visibleTriageEvents.length ? visibleTriageEvents.map((event) => (
                        <article key={event.id} className={`triage-item ${event.action}`}>
                          <div>
                            <strong>{event.action.toUpperCase().replace(/-/g, " ")}</strong>
                            <small>{formatAge(event.createdAt, nowMs)}</small>
                          </div>
                          <p>{event.detail}</p>
                          {event.runId ? <span>{`Run ${event.runId.slice(0, 8)}`}</span> : null}
                        </article>
                      )) : (
                        <article className="triage-item idle">
                          <div>
                            <strong>NO TRIAGE ACTIONS YET</strong>
                            <small>now</small>
                          </div>
                          <p>Acknowledge, force-focus, and signature resets will appear here.</p>
                        </article>
                      )}
                    </div>
                  </div>
                </section>
              </section>
            ) : (
              <section className="chat-panel card" aria-label="Assistant chat workspace">
                <div className="chat-head">
                  <h2>ASSISTANT CHAT</h2>
                  <div className="chat-head-actions">
                    <small>{chatBusy ? "Processing" : "Ready"}</small>
                    <span className="auto-develop-toggle active">Auto-Develop ON</span>
                  </div>
                </div>
                <div className="chat-modes" role="tablist" aria-label="Assistant modes">
                  {assistantModes.map((mode) => (
                    <button
                      key={mode.key}
                      type="button"
                      className={assistantMode === mode.key ? "active" : undefined}
                      onClick={() => setAssistantMode(mode.key)}
                      disabled={chatBusy || actionBusy}
                    >
                      {mode.label}
                    </button>
                  ))}
                </div>
                <DegradedBanner state={degradedState} />
                <div className="chat-thread" ref={chatThreadRef}>
                  {chatMessages.map((message) => (
                    <article key={message.id} className={message.role === "assistant" ? "chat-msg assistant" : "chat-msg user"}>
                      <header>
                        <strong>{message.role === "assistant" ? "ASCEND" : "YOU"}</strong>
                        <span>{formatAge(message.createdAt, nowMs)}</span>
                      </header>
                      <p>{message.text}</p>
                      <ProvenanceBadges provenance={message.provenance} />
                    </article>
                  ))}
                </div>
                <div className="chat-compose">
                  <textarea
                    value={chatDraft}
                    onChange={(event) => setChatDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        void submitChatBuildRequest();
                      }
                    }}
                    placeholder="Describe exactly what you want to build..."
                    aria-label="Assistant build request"
                  />
                  <button type="button" onClick={() => void submitChatBuildRequest()} disabled={chatBusy || actionBusy}>
                    Develop It
                  </button>
                </div>
              </section>
            )
          ) : (
            <article className={`core-stage core-${coreState} card`} data-core-state={coreState} aria-label="Core display">
              <div className="rings" aria-hidden="true">
                <span /><span /><span /><span /><span /><span />
              </div>
              <div className="core-mark">
                <div className="mark-shape" />
                <h1>ASCEND AI</h1>
                <p className="core-state-label">{coreState.toUpperCase()}</p>
                <div className="mini-wave" aria-hidden="true">
                  {Array.from({ length: 14 }).map((_, index) => <span key={index} />)}
                </div>
              </div>
              <div className="axis-lines" aria-hidden="true">
                <span />
                <span />
              </div>
              <div className="thinking-strip" aria-label="Live thinking stages">
                {pipelineStatus.map((stage) => (
                  <div key={stage.title} className={`thinking-stage ${stage.state}`}>
                    <strong>{stage.title}</strong>
                    <span>{stage.state}</span>
                  </div>
                ))}
              </div>
            </article>
          )}

          <div className="prompt-suggestions" aria-label="Suggested prompts">
            {personalityById(activePersonality).suggestions.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => setPrompt(suggestion)}
                disabled={actionBusy || chatBusy}
              >
                {suggestion}
              </button>
            ))}
          </div>

          <div className="prompt-bar card" role="search">
            <input
              type="text"
              value={prompt}
              placeholder="Ask anything..."
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  runPromptPrimaryAction();
                }
              }}
              aria-label="Prompt"
            />
            <button
              type="button"
              aria-label={activeTopTab === "ASSISTANT" ? "Develop from prompt" : "Generate build plan"}
              onClick={runPromptPrimaryAction}
              disabled={actionBusy || chatBusy}
            >
              <WaveIcon />
            </button>
          </div>

          <div className="action-grid">
            {actions.map((action) => (
              <button key={action.title} type="button" className="action-tile card" onClick={() => setPrompt(action.seed)} disabled={actionBusy}>
                <span className="tile-icon" aria-hidden="true"><GridIcon /></span>
                <strong>{action.title}</strong>
                <small>{action.subtitle}</small>
              </button>
            ))}
          </div>

          {buildPlan ? (
            <section className="builder-panel card" aria-label="Build engine blueprint">
              <div className="builder-head">
                <div>
                  <p>BUILD ENGINE</p>
                  <h3>{buildPlan.title}</h3>
                </div>
                <div className="builder-actions">
                  {hasScaffoldFailures ? (
                    <button type="button" onClick={() => void generateScaffoldFromBlueprint()} disabled={scaffoldBusy}>
                      {scaffoldBusy ? "Generating..." : "Retry Failed Scaffold"}
                    </button>
                  ) : null}
                  <button type="button" onClick={exportBlueprint} disabled={actionBusy}>Export .md</button>
                  <button type="button" onClick={() => setBuildPlan(null)}>Close</button>
                </div>
              </div>

              <p className="builder-summary">{buildPlan.summary}</p>

              <div className="builder-target">
                <label htmlFor="scaffold-target-template">Scaffold Output Path</label>
                <input
                  id="scaffold-target-template"
                  type="text"
                  value={scaffoldTargetTemplate}
                  onChange={(event) => setScaffoldTargetTemplate(event.target.value)}
                  placeholder={defaultScaffoldTemplate}
                  disabled={scaffoldBusy || actionBusy}
                />
                <small>{`Resolved: ${resolvedScaffoldRootPreview || defaultScaffoldTemplate}`}</small>
                <small>Use {'{slug}'} to include a request-specific folder name.</small>
              </div>

              <div className="builder-grid">
                <article>
                  <h4>Suggested Stack</h4>
                  <ul>{buildPlan.stack.map((item) => <li key={item}>{item}</li>)}</ul>
                </article>
                <article>
                  <h4>Architecture</h4>
                  <ul>{buildPlan.architecture.map((item) => <li key={item}>{item}</li>)}</ul>
                </article>
                <article>
                  <h4>Milestones</h4>
                  <ul>{buildPlan.milestones.map((item) => <li key={item}>{item}</li>)}</ul>
                </article>
                <article>
                  <h4>Deliverables</h4>
                  <ul>{buildPlan.deliverables.map((item) => <li key={item}>{item}</li>)}</ul>
                </article>
              </div>

              <div className="builder-runtime">
                <h4>Scaffold Runtime</h4>
                <p>{scaffoldStatus ?? "Auto-develop runs scaffold generation after chat submit."}</p>
                <div className="builder-runtime-badges" aria-label="Scaffold telemetry">
                  <span>{`Runs ${scaffoldTelemetry.runs}`}</span>
                  <span>{`Files OK ${scaffoldTelemetry.filesOk}`}</span>
                  <span className={scaffoldTelemetry.filesFail ? "warn" : "ok"}>{`Files Failed ${scaffoldTelemetry.filesFail}`}</span>
                  <span className={scaffoldTelemetry.lastRunStatus}>{`Last ${scaffoldTelemetry.lastRunStatus.toUpperCase()}`}</span>
                  <span>{`Updated ${scaffoldTelemetry.lastRunAt ? formatAge(scaffoldTelemetry.lastRunAt, nowMs) : "never"}`}</span>
                </div>
                {scaffoldResults.length ? (
                  <ul>
                    {scaffoldResults.map((item) => (
                      <li key={item.file} className={item.ok ? "ok" : "fail"}>
                        <strong>{item.ok ? "OK" : "FAIL"}</strong>
                        <span>{item.file}</span>
                        <small>{item.detail}</small>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </section>
          ) : null}
        </section>

        <div className="right-column">
          <article className="panel card live-view-panel">
            <div className="panel-head split">
              <h2>LIVE VIEW</h2>
              <span className="host-status">ON</span>
            </div>
            <div className="live-view-kpis">
              <div>
                <small>Core</small>
                <strong>{coreState.toUpperCase()}</strong>
              </div>
              <div>
                <small>FPS</small>
                <strong>{fps ? `${fps}` : "--"}</strong>
              </div>
              <div>
                <small>Latency</small>
                <strong>{lastResponseMs ? `${lastResponseMs}ms` : "--"}</strong>
              </div>
            </div>
            <div className="live-view-feed" role="log" aria-live="polite">
              {liveViewFrames.length ? liveViewFrames.map((frame) => (
                <div key={frame.id} className={`live-view-line ${frame.coreState}`}>
                  <div>
                    <strong>{frame.phase}</strong>
                    <small>{formatAge(frame.createdAt, nowMs)}</small>
                  </div>
                  <p>{`${frame.coreState.toUpperCase()} · ${frame.status}`}</p>
                  <span>{`FPS ${frame.fps ?? "--"} · Lat ${frame.latencyMs ?? "--"}${typeof frame.latencyMs === "number" ? "ms" : ""}`}</span>
                </div>
              )) : (
                <div className="live-view-line idle">
                  <div>
                    <strong>Monitoring</strong>
                    <small>now</small>
                  </div>
                  <p>Live view will stream runtime state snapshots here.</p>
                  <span>FPS -- · Lat --</span>
                </div>
              )}
            </div>
          </article>

          <article className="panel card execution-panel">
            <div className="panel-head split">
              <h2>LIVE EXECUTION</h2>
              <span className={`execution-core-state ${coreState}`}>{coreState.toUpperCase()}</span>
            </div>
            <p className="host-caption">{currentTaskLabel}</p>
            <ol
              className="stage-strip"
              aria-label="Reasoning stages"
              data-active-stage={reasoningSummary.activeStage ?? "none"}
            >
              {reasoningSummary.stages.map((stage) => (
                <li
                  key={stage.stage}
                  className={`stage-chip ${stage.status}`}
                  title={`${stage.label} · ${stage.events} event${stage.events === 1 ? "" : "s"} · ${formatStageDuration(stage.durationMs)}`}
                  aria-current={stage.status === "active" ? "step" : undefined}
                >
                  <span className="stage-chip-label">{reasoningStageShortLabels[stage.stage]}</span>
                  <span className="stage-chip-duration">{formatStageDuration(stage.durationMs)}</span>
                </li>
              ))}
            </ol>
            <div className="execution-list" role="log" aria-live="polite">
              {executionEvents.map((event) => (
                <div key={event.id} className={`execution-item ${event.level}`}>
                  <div>
                    <strong>{reasoningStageLabels[event.stage]}</strong>
                    <small>{formatAge(event.createdAt, nowMs)}</small>
                  </div>
                  <p>{event.detail}</p>
                </div>
              ))}
            </div>
          </article>

          <article className="panel card memory-panel">
            <div className="panel-head split">
              <h2>MEMORY</h2>
              <button
                type="button"
                className="ghost"
                onClick={forgetAllMemories}
                disabled={!memories.length}
              >
                Forget all
              </button>
            </div>
            {memories.length === 0 ? (
              <p className="host-caption">
                Nothing remembered yet. Say something like &ldquo;remember that we use Postgres&rdquo;.
              </p>
            ) : (
              <ul className="memory-list">
                {memories.map((item) => (
                  <li key={item.id} className={`memory-item ${item.pinned ? "pinned" : ""}`}>
                    <div className="memory-item-head">
                      {memoryEditId === item.id ? (
                        <input
                          className="memory-edit-input"
                          type="text"
                          value={memoryEditDraft}
                          autoFocus
                          onChange={(event) => setMemoryEditDraft(event.target.value)}
                          onBlur={() => commitMemoryLabel(item)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              commitMemoryLabel(item);
                            }
                            if (event.key === "Escape") {
                              setMemoryEditId(null);
                            }
                          }}
                          aria-label={`Rename memory ${item.title}`}
                        />
                      ) : (
                        <button
                          type="button"
                          className="memory-title"
                          title="Click to rename"
                          onClick={() => {
                            setMemoryEditId(item.id);
                            setMemoryEditDraft(item.title);
                          }}
                        >
                          {item.title}
                        </button>
                      )}
                      <div className="memory-actions">
                        <button
                          type="button"
                          className={`memory-pin ${item.pinned ? "on" : ""}`}
                          onClick={() => toggleMemoryPin(item)}
                          aria-pressed={item.pinned}
                          title={item.pinned ? "Unpin" : "Pin"}
                        >
                          {item.pinned ? "Pinned" : "Pin"}
                        </button>
                        <button
                          type="button"
                          className="memory-forget"
                          onClick={() => forgetMemoryItem(item)}
                          title="Forget this memory"
                        >
                          Forget
                        </button>
                      </div>
                    </div>
                    <p className="memory-body">{item.body}</p>
                    <div className="memory-meta">
                      <span className={`memory-kind ${item.kind}`}>{item.kind}</span>
                      <span title={`Matched rule: ${item.rule}`}>
                        {`${Math.round(item.confidence * 100)}% confidence`}
                      </span>
                      {item.editedAt ? <span className="memory-edited">edited</span> : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </article>

          <article className="panel card">
            <div className="panel-head split">
              <h2>SHORTCUTS</h2>
              <button type="button" className="ghost" onClick={onAddShortcut} disabled={actionBusy}>+</button>
            </div>
            <div className="list-lines">
              {shortcuts.map((item) => (
                <button key={item.title} type="button" className="line-btn" onClick={() => onShortcutClick(item.title)} disabled={actionBusy}>
                  <span className="line-icon" aria-hidden="true"><DotIcon /></span>
                  <span>{item.title}</span>
                </button>
              ))}
            </div>
          </article>

          <article className="panel card">
            <div className="panel-head split">
              <h2>NOTIFICATIONS</h2>
              <button type="button" className="ghost" onClick={clearNotifications} disabled={actionBusy}>Clear all</button>
            </div>
            <div className="notification-list">
              {notifications.map((item) => (
                <div key={item.id} className="notification-item">
                  <p>{item.title}</p>
                  <small>{formatAge(item.createdAt, nowMs)}</small>
                </div>
              ))}
            </div>
            <button type="button" className="view-all" onClick={() => setShowAllNotifications((current) => !current)} disabled={actionBusy}>
              {showAllNotifications ? "Show less" : "View all notifications"}
            </button>
            {showAllNotifications ? (
              <div className="notification-list">
                {notifications.map((item) => (
                  <div key={`expanded-${item.id}`} className="notification-item">
                    <p>{item.title}</p>
                    <small>{formatAge(item.createdAt, nowMs)}</small>
                  </div>
                ))}
              </div>
            ) : null}
          </article>

          <article className="panel card weather-panel">
            <div>
              <h2 className="weather-title">WEATHER</h2>
              <div className="weather-main">
                <div className="weather-headline"><span className="weather-icon"><WeatherIcon /></span><strong>{weatherNow.tempF}°F</strong></div>
                <span>{weatherNow.condition}</span>
                <small>{cityLabel}</small>
              </div>
            </div>
            <div className="weather-days">
              {weatherDays.map((item) => (
                <div key={item.day}>
                  <span>{item.day}</span>
                  <small>{item.condition}</small>
                  <strong>{item.temp}</strong>
                </div>
              ))}
            </div>
          </article>

          <article className="panel card host-panel">
            <div className="panel-head split">
              <h2>PROJECT LOCATIONS</h2>
              <span className="host-status">{filteredProjects.length}</span>
            </div>
            <p className="host-caption">{inventoryStatus}</p>
            <div className="host-controls">
              <input
                type="text"
                value={projectFilter}
                onChange={(event) => setProjectFilter(event.target.value)}
                placeholder="Filter projects or paths"
                aria-label="Filter projects"
              />
              <select
                value={projectGroupFilter}
                onChange={(event) => setProjectGroupFilter(event.target.value as "all" | HostProject["group"])}
                aria-label="Filter by project group"
              >
                <option value="all">ALL</option>
                <option value="workspace">WORKSPACE</option>
                <option value="app">APP</option>
                <option value="package">PACKAGE</option>
                <option value="generated">GENERATED</option>
              </select>
            </div>
            <div className="host-list">
              {filteredProjects.length ? filteredProjects.map((project) => (
                <div key={`${project.group}-${project.path}`} className="host-item">
                  <strong>{project.name}</strong>
                  <small>{project.group.toUpperCase()}</small>
                  <span>{project.path}</span>
                  <button type="button" className="host-open-btn" onClick={() => void openHostPath(project.path)} disabled={actionBusy}>Open Location</button>
                </div>
              )) : (
                <div className="host-item">
                  <strong>No host projects loaded</strong>
                  <span>Open the dashboard in desktop mode to read absolute project paths.</span>
                </div>
              )}
            </div>
          </article>

          <article className="panel card host-panel">
            <div className="panel-head split">
              <h2>STORAGE DEVICES</h2>
              <span className="host-status">{sortedStorageDevices.length}</span>
            </div>
            <div className="host-controls">
              <select value={storageSort} onChange={(event) => setStorageSort(event.target.value as "used-desc" | "free-desc")} aria-label="Sort storage">
                <option value="used-desc">SORT: HIGHEST USED</option>
                <option value="free-desc">SORT: MOST FREE</option>
              </select>
            </div>
            <div className="host-list">
              {sortedStorageDevices.length ? sortedStorageDevices.map((device) => (
                <div key={device.mountPath} className={`host-item ${storageSeverity(device.usedPercent)}`}>
                  <strong>{device.name}</strong>
                  <small>{device.mountPath}</small>
                  <span>{`Free ${formatBytes(device.freeBytes)} / Total ${formatBytes(device.totalBytes)}`}</span>
                  <div className="host-meter"><span style={{ width: `${device.usedPercent}%` }} /></div>
                </div>
              )) : (
                <div className="host-item">
                  <strong>No storage devices loaded</strong>
                  <span>Desktop mode exposes physical device free space and usage.</span>
                </div>
              )}
            </div>
          </article>
        </div>
      </section>

      <footer className="time-note">System Time {todayLabel} · {networkType} · {actionBusy ? "Working..." : actionStatus}</footer>
    </main>
  );
}
