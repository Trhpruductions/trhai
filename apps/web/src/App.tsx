import { useEffect, useMemo, useRef, useState } from "react";
import { webEnv } from "./env";

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

type ChatMessage = {
  id: string;
  role: "assistant" | "user";
  text: string;
  createdAt: number;
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

type AssistantApiReply = {
  assistantMessage: string;
  model: string;
  mode: AssistantMode;
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
    createdAt: Date.now() - 16000
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

const topTabs: TopTab[] = ["HOME", "ASSISTANT", "SYSTEMS", "PROJECTS", "ANALYTICS", "SETTINGS"];
const chatStateStorageKey = "ascend.chat.state.v2";

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

function inferAssistantMode(request: string): AssistantMode {
  const value = request.toLowerCase();
  if (/bug|fix|error|issue|broken|stack trace|exception/.test(value)) return "debug";
  if (/research|compare|investigate|analyze options|benchmark/.test(value)) return "research";
  if (/roadmap|plan|milestone|architecture|scope/.test(value)) return "plan";
  if (/revenue|pricing|go[- ]to[- ]market|kpi|sales|cost/.test(value)) return "business";
  if (/design|branding|creative|content|campaign|story/.test(value)) return "creator";
  if (/code|function|class|api|refactor|typescript|react|node/.test(value)) return "code";
  if (/build|create|app|platform|tool|dashboard|system/.test(value)) return "build";
  return "build";
}

function buildCapabilityResponse(mode: AssistantMode, request: string): string {
  if (mode === "code") {
    return `Coding track active. I will produce implementation-ready code strategy for: ${request}. Next: define modules, APIs, tests, and rollout checks.`;
  }

  if (mode === "debug") {
    return `Debug track active. I will isolate root cause and provide corrective actions for: ${request}. Next: reproduce issue, trace failing path, patch safely, and verify.`;
  }

  if (mode === "research") {
    return `Research track active. I will break down ${request} into options, tradeoffs, risks, and recommended path with execution steps.`;
  }

  if (mode === "plan") {
    return `Planning track active. I will convert ${request} into milestones, owners, dependencies, and delivery checkpoints.`;
  }

  if (mode === "business") {
    return `Business track active. I will map ${request} into KPIs, operating model, cost/revenue assumptions, and launch strategy.`;
  }

  if (mode === "creator") {
    return `Creator track active. I will shape ${request} into creative direction, assets, messaging, and production execution.`;
  }

  return `Build track active. I will convert ${request} into architecture, stack, milestones, and scaffold outputs.`;
}

async function callAssistantApiWithRetry(request: string, mode: AssistantMode): Promise<AssistantApiReply> {
  const attempts = [0, 350, 900];
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
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          mode: mode === "auto" ? "general" : mode,
          message: request
        })
      });

      if (!response.ok) {
        throw new Error(`Assistant API ${response.status}`);
      }

      const payload = await response.json() as {
        data?: { assistantMessage?: string; model?: string; mode?: string };
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
        model: payload.data?.model ?? "local-fallback",
        mode: safeMode
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Assistant API unavailable");
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
      { id: "assistant-build", label: "Generate From Prompt" },
      { id: "assistant-scaffold", label: "Generate Scaffold" },
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

const railItems: Array<{ key: RailSection; label: string }> = [
  { key: "Home", label: "Home" },
  { key: "Assistant", label: "Assistant" },
  { key: "Global", label: "Global" },
  { key: "Folder", label: "Folder" },
  { key: "Calendar", label: "Calendar" },
  { key: "Shield", label: "Shield" },
  { key: "Settings", label: "Settings" }
];

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

function buildScaffoldSpecs(blueprint: BuildBlueprint): ScaffoldSpec[] {
  const slug = slugify(blueprint.title);
  const root = `generated-projects/${slug}`;
  const readme = buildBlueprintMarkdown(blueprint);
  const stackList = blueprint.stack.map((item) => `- ${item}`).join("\n");

  return [
    {
      path: root,
      fileName: "README.md",
      content: readme
    },
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
    {
      path: `${root}/app/src`,
      fileName: "main.ts",
      content: [
        "export type BuildConfig = {",
        "  name: string;",
        "  summary: string;",
        "  stack: string[];",
        "};",
        "",
        "export const buildConfig: BuildConfig = {",
        `  name: ${JSON.stringify(blueprint.title)},`,
        `  summary: ${JSON.stringify(blueprint.summary)},`,
        `  stack: ${JSON.stringify(blueprint.stack)}`,
        "};",
        "",
        "console.log(`[build] ${buildConfig.name} initialized`);",
        ""
      ].join("\n")
    },
    {
      path: `${root}/api/src`,
      fileName: "index.ts",
      content: [
        "import express from \"express\";",
        "",
        "const app = express();",
        "app.use(express.json());",
        "",
        "app.get(\"/health\", (_request, response) => {",
        "  response.json({ ok: true, service: \"build-api\" });",
        "});",
        "",
        "app.post(\"/plan\", (_request, response) => {",
        `  response.json({ title: ${JSON.stringify(blueprint.title)}, ready: true });`,
        "});",
        "",
        "const port = Number(process.env.PORT ?? 4300);",
        "app.listen(port, () => {",
        "  console.log(`[build-api] listening on ${port}`);",
        "});",
        ""
      ].join("\n")
    },
    {
      path: root,
      fileName: "package.json",
      content: [
        "{",
        `  \"name\": \"${slug}\",`,
        "  \"private\": true,",
        "  \"type\": \"module\",",
        "  \"scripts\": {",
        "    \"start\": \"node ./api/src/index.ts\",",
        "    \"dev\": \"node ./api/src/index.ts\"",
        "  }",
        "}",
        ""
      ].join("\n")
    }
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
  const [showAllNotifications, setShowAllNotifications] = useState(false);
  const [actionStatus, setActionStatus] = useState("System nominal");
  const [actionLevel, setActionLevel] = useState<ActionLevel>("ok");
  const [actionBusy, setActionBusy] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(defaultChatMessages);
  const [chatDraft, setChatDraft] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [assistantMode, setAssistantMode] = useState<AssistantMode>("auto");
  const chatThreadRef = useRef<HTMLDivElement | null>(null);
  const activeScreen = screenDefinitions[activeTopTab];

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

  function createBlueprintFromPrompt() {
    const plan = generateBlueprint(prompt);
    setBuildPlan(plan);
    setScaffoldStatus(null);
    setScaffoldResults([]);
    setActionLine(`Blueprint ready · ${plan.title}`, "ok");
  }

  function pushChatMessage(role: ChatMessage["role"], text: string) {
    setChatMessages((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        role,
        text,
        createdAt: Date.now()
      }
    ]);
  }

  async function submitChatBuildRequest() {
    const request = chatDraft.trim();
    if (!request || chatBusy) return;

    const resolvedMode = assistantMode === "auto" ? inferAssistantMode(request) : assistantMode;

    setChatBusy(true);
    setActionBusy(true);
    setActionLine(`Assistant processing (${resolvedMode})...`, "info");
    pushChatMessage("user", request);
    setChatDraft("");

    try {
      setPrompt(request);

      let apiReply: AssistantApiReply | null = null;
      try {
        apiReply = await callAssistantApiWithRetry(request, resolvedMode);
      } catch {
        apiReply = null;
      }

      if (resolvedMode === "build") {
        const plan = generateBlueprint(request);
        setBuildPlan(plan);
        setScaffoldStatus(null);
        setScaffoldResults([]);
        const buildReply = apiReply?.assistantMessage
          ? `${apiReply.assistantMessage}\n\nBlueprint prepared for ${plan.title}. Stack: ${plan.stack.join(", ")}. Use Generate Scaffold to create the starter files now.`
          : `Blueprint prepared for ${plan.title}. Stack: ${plan.stack.join(", ")}. Use Generate Scaffold to create the starter files now.`;
        pushChatMessage("assistant", buildReply);
        setActionLine(`Assistant prepared ${plan.title}`, "ok");
        pushNotification(
          apiReply?.model
            ? `Assistant created blueprint · ${plan.title} · ${apiReply.model}`
            : `Assistant created blueprint · ${plan.title}`
        );
      } else {
        const reply = apiReply?.assistantMessage ?? buildCapabilityResponse(resolvedMode, request);
        pushChatMessage("assistant", reply);
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
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown assistant failure";
      pushChatMessage("assistant", `Build request failed: ${message}. Try again with more detail.`);
      setActionLine("Assistant request failed", "error");
      pushNotification("Assistant request failed");
    }

    setChatBusy(false);
    setActionBusy(false);
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
    pushNotification("Manual sync started");
    setActionLine("Syncing telemetry...", "info");
    const telemetryBridge = window.ascendDesktop?.getSystemTelemetry;
    if (telemetryBridge) {
      const response = await telemetryBridge();
      if (response?.ok) {
        setNetworkType(response.networkType ?? networkType);
        pushNotification(`Sync complete · ${response.networkType ?? "ONLINE"}`);
        setActionLine(`Sync complete · ${response.networkType ?? "ONLINE"}`, "ok");
      } else {
        pushNotification(`Sync failed: ${response?.error ?? "Unknown bridge error"}`);
        setActionLine("Sync failed", "error");
      }
    } else {
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
    if (actionBusy) return;

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
      createBlueprintFromPrompt();
      return;
    }

    if (actionId === "assistant-scaffold") {
      if (buildPlan) {
        await generateScaffoldFromBlueprint();
      } else {
        setActionLine("Create a blueprint before scaffold", "warn");
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

  async function generateScaffoldFromBlueprint() {
    if (!buildPlan) return;
    setActionBusy(true);

    const bridge = window.ascendDesktop?.createWorkspaceScaffold;
    if (!bridge) {
      setScaffoldStatus("Scaffold generation is available in desktop mode only.");
      setActionLine("Scaffold unavailable in web mode", "warn");
      setActionBusy(false);
      return;
    }

    const specs = buildScaffoldSpecs(buildPlan);
    setScaffoldBusy(true);
    setScaffoldStatus("Generating scaffold files...");
    setScaffoldResults([]);

    const results: ScaffoldResult[] = [];

    for (const spec of specs) {
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
          file: `${spec.path}/${spec.fileName}`,
          ok: Boolean(response?.ok),
          detail: response?.path ?? response?.message ?? response?.error ?? "Completed"
        });
      } catch (error) {
        results.push({
          file: `${spec.path}/${spec.fileName}`,
          ok: false,
          detail: error instanceof Error ? error.message : "Unknown generation failure"
        });
      }
    }

    setScaffoldResults(results);
    const failures = results.filter((item) => !item.ok).length;
    setScaffoldStatus(
      failures ? `Scaffold finished with ${failures} failure(s).` : `Scaffold complete: ${results.length} files generated.`
    );
    pushNotification(
      failures ? `Scaffold completed with ${failures} issue(s)` : `Scaffold generated ${results.length} files successfully`
    );
    setActionLine(failures ? `Scaffold completed with ${failures} issue(s)` : "Scaffold generation complete", failures ? "warn" : "ok");
    setScaffoldBusy(false);
    setActionBusy(false);
  }

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
        ));

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
    const thread = chatThreadRef.current;
    if (!thread) return;
    thread.scrollTop = thread.scrollHeight;
  }, [chatMessages]);

  return (
    <main className={desktopBridgeActive ? "ascend-shell desktop-mode" : "ascend-shell web-mode"}>
      <header className="top-nav card">
        <div className="brand">ASCEND AI</div>
        <nav className="menu-tabs" aria-label="Top menu">
          {topTabs.map((tab) => (
            <a
              key={tab}
              className={activeTopTab === tab ? "active" : undefined}
              href="#"
              onClick={(event) => {
                event.preventDefault();
                onTopTabClick(tab);
              }}
            >
              {tab}
            </a>
          ))}
        </nav>
        <div className="top-actions">
          <button type="button" aria-label="Search" onClick={onTopActionSearch} disabled={actionBusy}><SearchIcon /></button>
          <button type="button" aria-label="Open panel" onClick={onTopActionPanel} disabled={actionBusy}><GridIcon /></button>
          <button type="button" aria-label="Sync" onClick={() => void onTopActionSync()} disabled={actionBusy}><DotIcon /></button>
        </div>
      </header>

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
        <aside className="icon-rail card" aria-label="Navigation rail">
          {railItems.map((item) => (
            <button
              key={item.key}
              className={activeRailSection === item.key ? "rail-btn active" : "rail-btn"}
              type="button"
              aria-label={item.label}
              onClick={() => onRailSelect(item.key)}
            >
              {item.key === "Home" ? <HomeIcon /> : null}
              {item.key === "Assistant" ? <DotIcon /> : null}
              {item.key === "Global" ? <GridIcon /> : null}
              {item.key === "Folder" ? <WaveIcon /> : null}
              {item.key === "Calendar" ? <CalendarIcon /> : null}
              {item.key === "Shield" ? <DotIcon /> : null}
              {item.key === "Settings" ? <GridIcon /> : null}
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

        <section className="center-column">
          {activeTopTab === "ASSISTANT" ? (
            <section className="chat-panel card" aria-label="Assistant chat workspace">
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
              <div className="chat-thread" ref={chatThreadRef}>
                {chatMessages.map((message) => (
                  <article key={message.id} className={message.role === "assistant" ? "chat-msg assistant" : "chat-msg user"}>
                    <header>
                      <strong>{message.role === "assistant" ? "ASCEND" : "YOU"}</strong>
                      <span>{formatAge(message.createdAt, nowMs)}</span>
                    </header>
                    <p>{message.text}</p>
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
                <button type="button" onClick={() => void submitChatBuildRequest()} disabled={chatBusy || actionBusy}>Build It</button>
              </div>
            </section>
          ) : (
            <article className="core-stage card" aria-label="Core display">
              <div className="rings" aria-hidden="true">
                <span /><span /><span /><span /><span /><span />
              </div>
              <div className="core-mark">
                <div className="mark-shape" />
                <h1>ASCEND AI</h1>
                <div className="mini-wave" aria-hidden="true">
                  {Array.from({ length: 14 }).map((_, index) => <span key={index} />)}
                </div>
              </div>
              <div className="axis-lines" aria-hidden="true">
                <span />
                <span />
              </div>
            </article>
          )}

          <div className="prompt-bar card" role="search">
            <input
              type="text"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  createBlueprintFromPrompt();
                }
              }}
              aria-label="Prompt"
            />
            <button type="button" aria-label="Generate build plan" onClick={createBlueprintFromPrompt} disabled={actionBusy}><WaveIcon /></button>
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
                  <button type="button" onClick={() => void generateScaffoldFromBlueprint()} disabled={scaffoldBusy}>
                    {scaffoldBusy ? "Generating..." : "Generate Scaffold"}
                  </button>
                  <button type="button" onClick={exportBlueprint} disabled={actionBusy}>Export .md</button>
                  <button type="button" onClick={() => setBuildPlan(null)}>Close</button>
                </div>
              </div>

              <p className="builder-summary">{buildPlan.summary}</p>

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
                <p>{scaffoldStatus ?? "Ready to generate project scaffold from this blueprint."}</p>
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
