import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent } from "react";
import { webEnv } from "./env";
import { getJarvisBrandName, getJarvisDirectiveHint, getJarvisWelcomeMessage } from "./jarvisIdentity";
import { buildDevelopmentPlanDocument, buildLocalAssistantReply, buildLocalAssistantResponseBundle, buildPromptForQuickAction, buildScaffoldSpec, inferAssistantModeFromContext, readPersistedAssistantState, writePersistedAssistantState, type AssistantMode as AssistantRuntimeMode, type HistoryTurn, type MemoryContext } from "./assistantRuntime";
import { buildVoiceProfile, normalizeVoiceTranscript } from "./voiceUtils";
import { buildWorkspaceActionPayload, buildWorkspaceActionPrompt, type WorkspaceActionKind } from "./workspaceActions";
import { buildConversationStatus, getConnectionSecurityLabel, getCoreIntegrity } from "./dashboardStatus";
import { resolveDraftMessageText } from "./messageInput";

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  attachments?: Array<{
    name: string;
    mimeType: string;
    sizeBytes: number;
    previewUrl: string;
  }>;
};

type PendingImage = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  dataUrl: string;
  previewUrl: string;
};

type ScaffoldWriteResult = {
  ok?: boolean;
  path?: string;
  message?: string;
  error?: string;
};

type ProcessEvent = {
  id: string;
  level: "info" | "ok" | "warn" | "error";
  title: string;
  detail: string;
  at: string;
};

type VoicePreset = {
  rate: number;
  pitch: number;
  volume: number;
};

type TimelineEvent = {
  id: string;
  label: string;
  tone: "accent" | "amber" | "success" | "danger";
  detail: string;
};

type DashboardMetrics = {
  cpu: number;
  gpu: number;
  ram: number;
  storage: number;
  tasksCompleted: number;
  projectsActive: number;
  agentsRunning: number;
  automationsActive: number;
  networkUpGbps: number;
  networkDownGbps: number;
  responseMs: number;
};

type LiveAgent = {
  name: string;
  detail: string;
  status: "ACTIVE" | "SYNCING" | "ANALYZING";
};

type LiveProject = {
  name: string;
  category: string;
  stack: string;
  age: string;
};

type WorkspaceTelemetry = {
  counts: {
    conversations: number;
    messages: number;
    memoryRecords: number;
    workflows: number;
    workflowRuns: number;
  };
  usage: {
    tokenUsage: number;
    automationJobs: number;
    usageEvents: number;
  };
};

type TelemetryTransportState = "idle" | "connecting" | "streaming" | "fallback";

type AIPresence = {
  mood: "Calm" | "Focused" | "Aggressive";
  objective: string;
  confidence: number;
  focus: number;
  stance: "Observing" | "Planning" | "Executing";
};

type ModuleActionSignal = {
  action: string;
  detail: string;
  atMs: number;
  intensity: number;
};

type StanceTraceEvent = {
  stance: AIPresence["stance"];
  atMs: number;
};

type StanceTraceItem = {
  key: string;
  stance: AIPresence["stance"];
  ageLabel: string;
};

const primaryModules = [
  "Dashboard",
  "AI Chat",
  "Projects",
  "Code Studio",
  "Game Studio",
  "Image Studio",
  "Video Studio",
  "Music Studio",
  "Voice Studio",
  "AI Agents",
  "Automation",
  "Business Suite",
  "Marketplace",
  "Analytics",
  "Plugins",
  "Files",
  "Teams",
  "Settings"
] as const;

const modulePulseDeck: Record<string, string[]> = {
  Dashboard: [
    "Balancing system load and executive mission priorities.",
    "Auditing global health channels for drift and anomalies.",
    "Correlating operator directives with current throughput."
  ],
  "AI Chat": [
    "Refining conversational intent routing for precision replies.",
    "Re-indexing recent exchange context for better continuity.",
    "Optimizing response cadence for lower perceived latency."
  ],
  "Code Studio": [
    "Scanning implementation risks and regression surfaces.",
    "Pre-validating edge cases before execution handoff.",
    "Aligning code path changes with validation checkpoints."
  ],
  "Game Studio": [
    "Tuning gameplay loop balance and progression pacing.",
    "Checking quest-state dependencies for runtime integrity.",
    "Analyzing performance hotspots in simulation layers."
  ],
  "Business Suite": [
    "Re-prioritizing milestones against KPI risk windows.",
    "Tracking execution burn rate against delivery targets.",
    "Compiling decision brief updates for operator review."
  ],
  Automation: [
    "Monitoring queue saturation and retry stability.",
    "Recalculating workflow dependencies for safe sequencing.",
    "Hardening automation paths against duplicate execution."
  ]
};

type EarconName = "boot" | "response" | "error";
type AmbientMode = "idle" | "listening" | "responding";
type AssistantMode = AssistantRuntimeMode;

const jarvisVoicePreset: VoicePreset = { rate: 0.9, pitch: 0.78, volume: 1 };
const maxImageAttachments = 3;
const maxImageBytes = 1_500_000;
const bootStages = [
  "Power Core",
  "Workspace Channel",
  "Conversation Relay",
  "Voice Handshake",
  "Tactical Uplink"
] as const;

function formatBytes(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(2)} MB`;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error(`Unable to read image file: ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function buildOutboundMessageContent(text: string, images: PendingImage[]): string {
  const sections: string[] = [];
  const trimmedText = text.trim();

  if (trimmedText) {
    sections.push(trimmedText);
  }

  if (images.length) {
    const imageSections = images.map((image, index) => {
      const metadata = `image_${index + 1} | name=${image.name} | type=${image.mimeType} | size=${image.sizeBytes}`;
      return `[attachment]\n${metadata}\n${image.dataUrl}`;
    });

    sections.push(imageSections.join("\n\n"));
  }

  return sections.join("\n\n").trim();
}

function buildUserVisibleMessage(text: string, images: PendingImage[]): string {
  const trimmedText = text.trim();
  if (!images.length) return trimmedText;

  const imageNames = images.map((image) => image.name).join(", ");
  const attachmentLine = `Attached image${images.length > 1 ? "s" : ""}: ${imageNames}`;
  return trimmedText ? `${trimmedText}\n\n${attachmentLine}` : attachmentLine;
}

function createMessage(role: Message["role"], content: string, attachments?: Message["attachments"]): Message {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    createdAt: new Date().toISOString(),
    attachments
  };
}

function pickPreferredVoice(voices: SpeechSynthesisVoice[]) {
  if (!voices.length) return null;

  const preferredPatterns = [/david/i, /guy/i, /mark/i, /daniel/i, /james/i, /microsoft/i, /google uk english male/i];
  for (const pattern of preferredPatterns) {
    const match = voices.find((voice) => pattern.test(voice.name));
    if (match) return match;
  }

  const englishVoice = voices.find((voice) => /^en(-|_)/i.test(voice.lang));
  return englishVoice ?? voices[0] ?? null;
}

function getModuleGlyph(moduleName: (typeof primaryModules)[number]): string {
  if (moduleName === "Dashboard") return "▦";
  if (moduleName === "AI Chat") return "◌";
  if (moduleName === "Projects") return "⌗";
  if (moduleName === "Code Studio") return "</>";
  if (moduleName === "Game Studio") return "◈";
  if (moduleName === "Image Studio") return "▣";
  if (moduleName === "Video Studio") return "▷";
  if (moduleName === "Music Studio") return "♫";
  if (moduleName === "Voice Studio") return "◍";
  if (moduleName === "AI Agents") return "⟐";
  if (moduleName === "Automation") return "⟳";
  if (moduleName === "Business Suite") return "⌂";
  if (moduleName === "Marketplace") return "⬢";
  if (moduleName === "Analytics") return "◫";
  if (moduleName === "Plugins") return "◨";
  if (moduleName === "Files") return "▤";
  if (moduleName === "Teams") return "◔";
  return "⚙";
}

export function App() {
  const [bootOverlayVisible, setBootOverlayVisible] = useState(true);
  const [workspaceId, setWorkspaceId] = useState("");
  const [conversationId, setConversationId] = useState("");
  const [messages, setMessages] = useState<Message[]>([createMessage("assistant", getJarvisWelcomeMessage())]);
  const [input, setInput] = useState("");
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [draggingImages, setDraggingImages] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moduleNotice, setModuleNotice] = useState<string | null>("Booting JARVIS channel...");
  const [connectionState, setConnectionState] = useState<"booting" | "online" | "offline">("booting");
  const [workspaceActions, setWorkspaceActions] = useState<Array<{ id: string; title: string; detail: string; kind: "task" | "workflow" | "insight" }>>([
    { id: "action-1", title: "Launch checklist", detail: "Draft the launch checklist and timeline.", kind: "task" },
    { id: "action-2", title: "Automation flow", detail: "Propose a workflow for recurring coordination.", kind: "workflow" },
    { id: "action-3", title: "Market pulse", detail: "Summarize the highest-impact next move.", kind: "insight" }
  ]);

  const [listening, setListening] = useState(false);
  const [voiceTranscribing, setVoiceTranscribing] = useState(false);
  const [voiceTranscript, setVoiceTranscript] = useState("");

  const [speaking, setSpeaking] = useState(false);
  const [voiceReady, setVoiceReady] = useState(false);
  const [voicePrefaceEnabled, setVoicePrefaceEnabled] = useState(true);
  const [earconsEnabled, setEarconsEnabled] = useState(true);
  const [ambienceEnabled, setAmbienceEnabled] = useState(false);
  const [assistantMode, setAssistantMode] = useState<AssistantMode>("general");
  const [memorySummary, setMemorySummary] = useState<string[]>([]);
  const [typingMessageId, setTypingMessageId] = useState<string | null>(null);
  const [typingPreview, setTypingPreview] = useState("");
  const [systemTimeLabel, setSystemTimeLabel] = useState("");
  const [coreFlux, setCoreFlux] = useState(0.74);
  const [bootStageIndex, setBootStageIndex] = useState(0);
  const [livePhase, setLivePhase] = useState("System standby");
  const [processEvents, setProcessEvents] = useState<ProcessEvent[]>([
    {
      id: crypto.randomUUID(),
      level: "info",
      title: "Core Online",
      detail: "JARVIS tactical runtime initialized.",
      at: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    }
  ]);
  const [dashboardMetrics, setDashboardMetrics] = useState<DashboardMetrics>({
    cpu: 28,
    gpu: 78,
    ram: 62,
    storage: 65,
    tasksCompleted: 24,
    projectsActive: 6,
    agentsRunning: 8,
    automationsActive: 12,
    networkUpGbps: 1.2,
    networkDownGbps: 1.4,
    responseMs: 30
  });
  const [liveAgents, setLiveAgents] = useState<LiveAgent[]>([
    { name: "Code Master", detail: "Working on TRH website", status: "ACTIVE" },
    { name: "Game Designer", detail: "Building new quest system", status: "ACTIVE" },
    { name: "Content Creator", detail: "Generating YouTube scripts", status: "ACTIVE" },
    { name: "Marketing AI", detail: "Analyzing audience data", status: "ACTIVE" }
  ]);
  const [liveProjects, setLiveProjects] = useState<LiveProject[]>([
    { name: "VEILFALL", category: "Game Development", stack: "Unreal Engine", age: "2h ago" },
    { name: "RETREATS WEBSITE", category: "Web Development", stack: "React / Next.js", age: "5h ago" },
    { name: "SHADOWS OF RUIN", category: "Music Production", stack: "Ableton Live", age: "1d ago" },
    { name: "TRH AI APP", category: "AI Application", stack: "Python", age: "2d ago" }
  ]);
  const [liveSuggestions, setLiveSuggestions] = useState<Array<{ title: string; detail: string }>>([
    { title: "Optimize your game performance", detail: "I can analyze your game and suggest improvements." },
    { title: "Create AI generated game assets", detail: "Generate 3D models, textures, and concept art." },
    { title: "Automate your workflow", detail: "Set up repeatable tasks and team triggers." }
  ]);
  const [telemetryTransport, setTelemetryTransport] = useState<TelemetryTransportState>("idle");
  const [telemetryLastSyncLabel, setTelemetryLastSyncLabel] = useState("Awaiting signal");
  const [telemetryEventsPerMinute, setTelemetryEventsPerMinute] = useState(0);
  const [telemetryReconnects, setTelemetryReconnects] = useState(0);
  const [telemetryGapSeconds, setTelemetryGapSeconds] = useState(0);
  const [aiPresence, setAiPresence] = useState<AIPresence>({
    mood: "Calm",
    objective: "Watching mission channels",
    confidence: 78,
    focus: 74,
    stance: "Observing"
  });
  const [stanceTrace, setStanceTrace] = useState<StanceTraceEvent[]>([{ stance: "Observing", atMs: Date.now() }]);
  const [activeModule, setActiveModule] = useState<(typeof primaryModules)[number]>("Dashboard");
  const [moduleSignals, setModuleSignals] = useState<Record<string, ModuleActionSignal>>({});

  const selectedVoiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const speakSessionRef = useRef(0);
  const typingSessionRef = useRef(0);
  const bootOverlayTimerRef = useRef<number | null>(null);
  const earconAudioContextRef = useRef<AudioContext | null>(null);
  const ambientOscillatorRef = useRef<OscillatorNode | null>(null);
  const ambientGainRef = useRef<GainNode | null>(null);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const processStreamRef = useRef<HTMLDivElement | null>(null);
  const previousChannelStateRef = useRef("Ready");

  const recognitionRef = useRef<any>(null);
  const recognitionFinalRef = useRef("");
  const recognitionInterimRef = useRef("");
  const recognitionStopResolverRef = useRef<((transcript: string) => void) | null>(null);

  const responseCount = useMemo(() => messages.filter((msg) => msg.role === "assistant").length, [messages]);
  const channelState = listening ? "Listening" : speaking ? "Responding" : sending ? "Synthesizing" : "Ready";
  const canSend = Boolean(!sending && (input.trim() || pendingImages.length > 0));
  const readinessScore = Math.max(
    12,
    (workspaceId ? 34 : 0) + (conversationId ? 28 : 0) + (voiceReady ? 18 : 0) + (messages.length > 1 ? 10 : 0) + (error ? 0 : 10)
  );
  const activeModuleSignal = moduleSignals[activeModule];
  const activeModuleSignalAgeSeconds = activeModuleSignal ? Math.max(0, Math.floor((Date.now() - activeModuleSignal.atMs) / 1000)) : null;
  const stanceTraceItems: StanceTraceItem[] = useMemo(() => {
    const nowMs = Date.now();
    return stanceTrace.map((item, index) => {
      const ageSeconds = Math.max(0, Math.floor((nowMs - item.atMs) / 1000));
      const ageLabel = ageSeconds < 60 ? `${ageSeconds}s` : `${Math.floor(ageSeconds / 60)}m`;
      return {
        key: `${item.atMs}-${index}`,
        stance: item.stance,
        ageLabel
      };
    });
  }, [stanceTrace, systemTimeLabel]);
  const missionTimeline: TimelineEvent[] = useMemo(() => {
    const derived = processEvents.slice(-5).reverse().map((event) => {
      const tone: TimelineEvent["tone"] =
        event.level === "ok" ? "success" : event.level === "warn" ? "amber" : event.level === "error" ? "danger" : "accent";

      return {
        id: event.id,
        label: event.title,
        tone,
        detail: event.detail
      };
    });

    if (!derived.length) {
      return [
        {
          id: "timeline-standby",
          label: "Standby",
          tone: "accent",
          detail: "Awaiting first directive."
        }
      ];
    }

    return derived;
  }, [processEvents]);

  useEffect(() => {
    messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, sending]);

  function pushProcessEvent(level: ProcessEvent["level"], title: string, detail: string) {
    const stamp = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    setProcessEvents((current) => {
      const next = [
        ...current,
        {
          id: crypto.randomUUID(),
          level,
          title,
          detail,
          at: stamp
        }
      ];
      return next.slice(-28);
    });
  }

  function registerModuleSignal(moduleName: string, action: string, detail: string, intensityDelta = 6) {
    setModuleSignals((current) => {
      const previous = current[moduleName];
      const nextIntensity = Math.max(0, Math.min(100, (previous?.intensity ?? 0) + intensityDelta));

      return {
        ...current,
        [moduleName]: {
          action,
          detail,
          atMs: Date.now(),
          intensity: nextIntensity
        }
      };
    });
  }

  useEffect(() => {
    const decayTimer = window.setInterval(() => {
      setModuleSignals((current) => {
        const now = Date.now();
        let changed = false;
        const nextEntries: Array<[string, ModuleActionSignal]> = [];

        for (const [moduleName, signal] of Object.entries(current)) {
          const ageSeconds = Math.max(0, Math.floor((now - signal.atMs) / 1000));
          const decayStep = ageSeconds > 180 ? 8 : ageSeconds > 90 ? 5 : 2;
          const nextIntensity = Math.max(0, signal.intensity - decayStep);

          if (nextIntensity !== signal.intensity) {
            changed = true;
          }

          if (nextIntensity > 0 || ageSeconds < 420) {
            nextEntries.push([
              moduleName,
              {
                ...signal,
                intensity: nextIntensity
              }
            ]);
          } else {
            changed = true;
          }
        }

        if (!changed) return current;
        return Object.fromEntries(nextEntries);
      });
    }, 4000);

    return () => {
      window.clearInterval(decayTimer);
    };
  }, []);

  useEffect(() => {
    processStreamRef.current?.scrollTo({ top: processStreamRef.current.scrollHeight, behavior: "smooth" });
  }, [processEvents]);

  useEffect(() => {
    if (previousChannelStateRef.current !== channelState) {
      setLivePhase(`Channel ${channelState.toLowerCase()}`);
      pushProcessEvent("info", "Channel State", `Transitioned to ${channelState}.`);
      previousChannelStateRef.current = channelState;
    }
  }, [channelState]);

  useEffect(() => {
    const intensity = activeModuleSignal?.intensity ?? 0;
    const ageSeconds = activeModuleSignalAgeSeconds ?? 9999;

    setAiPresence((current) => {
      const nextStance: AIPresence["stance"] =
        intensity >= 58 && ageSeconds < 70
          ? "Executing"
          : intensity >= 18 && ageSeconds < 210
            ? "Planning"
            : "Observing";

      const nextMood: AIPresence["mood"] =
        nextStance === "Executing"
          ? "Aggressive"
          : nextStance === "Planning"
            ? "Focused"
            : "Calm";

      const targetConfidence = Math.max(56, Math.min(99, 58 + intensity));
      const targetFocus = Math.max(48, Math.min(99, 52 + Math.floor(intensity * 0.8)));
      const smooth = (value: number, target: number) => value + Math.sign(target - value) * Math.min(3, Math.abs(target - value));

      const nextConfidence = smooth(current.confidence, targetConfidence);
      const nextFocus = smooth(current.focus, targetFocus);

      if (
        current.stance === nextStance &&
        current.mood === nextMood &&
        current.confidence === nextConfidence &&
        current.focus === nextFocus
      ) {
        return current;
      }

      return {
        ...current,
        stance: nextStance,
        mood: nextMood,
        confidence: nextConfidence,
        focus: nextFocus
      };
    });
  }, [activeModuleSignal, activeModuleSignalAgeSeconds]);

  useEffect(() => {
    setStanceTrace((current) => {
      const nowMs = Date.now();
      const recent = current.filter((item) => nowMs - item.atMs <= 60_000);
      const last = recent[recent.length - 1];

      if (last?.stance === aiPresence.stance) {
        return recent;
      }

      return [...recent, { stance: aiPresence.stance, atMs: nowMs }].slice(-7);
    });
  }, [aiPresence.stance]);

  useEffect(() => {
    setLivePhase(`${activeModule} command focus`);
    setModuleNotice(`Operating in ${activeModule}. AI channels adapting to current mission context.`);
    setAiPresence((current) => ({
      ...current,
      objective: `Orchestrating ${activeModule} mission lane`
    }));
    registerModuleSignal(activeModule, "Module focus switched", `${activeModule} became the active mission lane.`, 4);
    pushProcessEvent("info", "Module Focus", `${activeModule} is now active.`);
  }, [activeModule]);

  useEffect(() => {
    if (!error) return;
    setLivePhase("Exception detected");
    pushProcessEvent("error", "Runtime Alert", error);
  }, [error]);

  useEffect(() => {
    const updateClock = () => {
      const now = new Date();
      setSystemTimeLabel(now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    };

    updateClock();
    const clockTimer = window.setInterval(updateClock, 1000);
    return () => {
      window.clearInterval(clockTimer);
    };
  }, []);

  useEffect(() => {
    let tick = 0;
    const fluxTimer = window.setInterval(() => {
      tick += 1;
      const baseline = listening ? 0.92 : speaking || sending ? 0.84 : 0.76;
      const modulation = Math.sin(tick / 3) * 0.05 + Math.cos(tick / 6) * 0.03;
      const next = Math.min(0.99, Math.max(0.62, baseline + modulation));
      setCoreFlux(next);
    }, 380);

    return () => {
      window.clearInterval(fluxTimer);
    };
  }, [listening, speaking, sending]);

  useEffect(() => {
    const metricsTimer = window.setInterval(() => {
      setDashboardMetrics((current) => {
        const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
        const drift = () => (Math.random() - 0.5) * 4;
        const activeBoost = sending || speaking ? 1.4 : listening ? 0.8 : 0;
        const nextResponse = clamp(current.responseMs + (Math.random() - 0.5) * 5, 18, 85);

        return {
          cpu: Math.round(clamp(current.cpu + drift() + activeBoost, 16, 86)),
          gpu: Math.round(clamp(current.gpu + drift() + (sending ? 1.2 : 0), 30, 96)),
          ram: Math.round(clamp(current.ram + drift() * 0.8, 34, 88)),
          storage: Math.round(clamp(current.storage + (Math.random() - 0.5) * 0.6, 52, 84)),
          tasksCompleted: current.tasksCompleted + (Math.random() > 0.84 ? 1 : 0),
          projectsActive: clamp(current.projectsActive + (Math.random() > 0.96 ? 1 : 0) - (Math.random() > 0.98 ? 1 : 0), 4, 9),
          agentsRunning: clamp(current.agentsRunning + (Math.random() > 0.9 ? 1 : 0) - (Math.random() > 0.95 ? 1 : 0), 6, 12),
          automationsActive: clamp(current.automationsActive + (Math.random() > 0.88 ? 1 : 0) - (Math.random() > 0.94 ? 1 : 0), 8, 18),
          networkUpGbps: Number(clamp(current.networkUpGbps + (Math.random() - 0.5) * 0.16, 0.8, 2.4).toFixed(2)),
          networkDownGbps: Number(clamp(current.networkDownGbps + (Math.random() - 0.5) * 0.16, 0.7, 2.1).toFixed(2)),
          responseMs: Math.round(nextResponse)
        };
      });
    }, 1800);

    return () => {
      window.clearInterval(metricsTimer);
    };
  }, [listening, sending, speaking]);

  useEffect(() => {
    const agentTimer = window.setInterval(() => {
      setLiveAgents((current) => {
        const detailPool = [
          "Reviewing deployment health",
          "Compiling gameplay systems",
          "Generating campaign creative",
          "Auditing funnel analytics",
          "Syncing workflow dependencies"
        ];

        return current.map((agent, index) => {
          const nextDetail = Math.random() > 0.75 ? detailPool[(index + Math.floor(Math.random() * detailPool.length)) % detailPool.length] : agent.detail;
          return { ...agent, status: "ACTIVE", detail: nextDetail };
        });
      });

      setLiveSuggestions((current) => {
        if (current.length < 2) return current;
        const [head, ...rest] = current;
        return [...rest, head];
      });

      setLiveProjects((current) => {
        return current.map((project, index) => {
          if (index !== 0 || Math.random() < 0.7) return project;
          const cycle = ["Just now", "12m ago", "48m ago", "2h ago"];
          return { ...project, age: cycle[Math.floor(Math.random() * cycle.length)] };
        });
      });
    }, 3600);

    return () => {
      window.clearInterval(agentTimer);
    };
  }, []);

  useEffect(() => {
    if (!workspaceId || connectionState === "offline") {
      setTelemetryTransport("idle");
      setTelemetryLastSyncLabel("Awaiting signal");
      setTelemetryEventsPerMinute(0);
      setTelemetryGapSeconds(0);
      return;
    }

    let cancelled = false;
    let fallbackTimer: number | null = null;
    let streamConnectedOnce = false;
    let telemetryUnavailable = false;
    const telemetryEventTimestamps: number[] = [];
    setTelemetryTransport("connecting");

    const applyTelemetry = (telemetry: WorkspaceTelemetry) => {
      if (cancelled) return;
      const nowMs = Date.now();
      telemetryEventTimestamps.push(nowMs);
      while (telemetryEventTimestamps.length && nowMs - telemetryEventTimestamps[0] > 60_000) {
        telemetryEventTimestamps.shift();
      }
      setTelemetryEventsPerMinute(telemetryEventTimestamps.length);
      setTelemetryLastSyncLabel(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
      setTelemetryGapSeconds(0);

      setDashboardMetrics((current) => {
        const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
        const activitySeed = telemetry.counts.messages + telemetry.counts.memoryRecords + telemetry.usage.usageEvents;
        const computedCpu = clamp(22 + activitySeed * 2, 22, 88);
        const computedGpu = clamp(38 + telemetry.counts.workflowRuns * 4 + telemetry.counts.messages, 36, 96);
        const computedRam = clamp(42 + telemetry.counts.conversations * 6 + telemetry.counts.memoryRecords * 2, 38, 90);
        const computedStorage = clamp(55 + telemetry.counts.workflows * 2, 52, 86);

        return {
          ...current,
          cpu: Math.round(computedCpu),
          gpu: Math.round(computedGpu),
          ram: Math.round(computedRam),
          storage: Math.round(computedStorage),
          tasksCompleted: Math.max(current.tasksCompleted, telemetry.usage.automationJobs + Math.floor(telemetry.usage.tokenUsage / 80)),
          projectsActive: clamp(telemetry.counts.workflows + 4, 4, 12),
          agentsRunning: clamp(telemetry.counts.conversations + telemetry.counts.workflowRuns + 6, 6, 14),
          automationsActive: clamp(telemetry.counts.workflowRuns + telemetry.usage.automationJobs, 3, 24)
        };
      });

      setLiveAgents((current) => current.map((agent) => ({ ...agent, status: "ACTIVE" })));

      setAiPresence((current) => {
        const workload = telemetry.counts.workflowRuns + telemetry.counts.messages + telemetry.usage.automationJobs;
        const confidence = Math.max(55, Math.min(99, 68 + workload * 4 + Math.floor(telemetry.usage.tokenUsage / 200)));
        const focus = Math.max(48, Math.min(98, 62 + telemetry.counts.memoryRecords * 5 + telemetry.counts.workflows * 3));
        const mood: AIPresence["mood"] = workload > 5 ? "Aggressive" : workload > 2 ? "Focused" : "Calm";
        const stance: AIPresence["stance"] = workload > 5 ? "Executing" : workload > 1 ? "Planning" : "Observing";
        const objective =
          telemetry.counts.workflowRuns > 0
            ? `Executing ${telemetry.counts.workflowRuns} automation lane${telemetry.counts.workflowRuns > 1 ? "s" : ""} in ${activeModule}`
            : telemetry.counts.messages > 2
              ? `Synthesizing active intelligence for ${activeModule}`
              : `Watching ${activeModule} mission channels`;

        return {
          ...current,
          mood,
          stance,
          objective,
          confidence,
          focus
        };
      });
    };

    const syncTelemetry = async () => {
      if (telemetryUnavailable) return;

      try {
        const response = await fetch(`${webEnv.apiBaseUrl}/v1/workspaces/${workspaceId}/telemetry`);
        if (!response.ok) {
          if (response.status === 404 || response.status === 405) {
            telemetryUnavailable = true;
            setTelemetryTransport("idle");
            setTelemetryLastSyncLabel("Telemetry unavailable");
            if (fallbackTimer !== null) {
              globalThis.clearInterval(fallbackTimer);
              fallbackTimer = null;
            }
          }
          return;
        }

        const payload = (await response.json()) as { data?: WorkspaceTelemetry };
        const telemetry = payload.data;
        if (!telemetry) return;
        applyTelemetry(telemetry);
      } catch {
        // Keep existing optimistic live metrics if telemetry sync fails.
      }
    };

    void syncTelemetry();
    const telemetryGapTimer = globalThis.setInterval(() => {
      const lastEventAt = telemetryEventTimestamps[telemetryEventTimestamps.length - 1];
      if (!lastEventAt) return;
      const gap = Math.floor((Date.now() - lastEventAt) / 1000);
      setTelemetryGapSeconds(gap);
    }, 1000);

    let stream: EventSource | null = null;
    if (typeof EventSource !== "undefined") {
      stream = new EventSource(`${webEnv.apiBaseUrl}/v1/workspaces/${workspaceId}/telemetry/stream`);
      stream.onopen = () => {
        if (cancelled) return;
        if (streamConnectedOnce) {
          setTelemetryReconnects((current) => current + 1);
        }
        streamConnectedOnce = true;
        if (fallbackTimer !== null) {
          globalThis.clearInterval(fallbackTimer);
          fallbackTimer = null;
        }
        setTelemetryTransport("streaming");
      };
      stream.addEventListener("telemetry", (event) => {
        try {
          const payload = JSON.parse((event as MessageEvent).data) as { data?: WorkspaceTelemetry };
          if (payload.data) {
            applyTelemetry(payload.data);
          }
        } catch {
          // Ignore malformed stream event payloads.
        }
      });
      stream.onerror = () => {
        if (telemetryUnavailable) return;
        if (fallbackTimer !== null) return;
        setTelemetryTransport("fallback");
        fallbackTimer = globalThis.setInterval(() => {
          void syncTelemetry();
        }, 6000);
      };
    } else {
      setTelemetryTransport("fallback");
      fallbackTimer = globalThis.setInterval(() => {
        void syncTelemetry();
      }, 6000);
    }

    return () => {
      cancelled = true;
      globalThis.clearInterval(telemetryGapTimer);
      if (stream) {
        stream.close();
      }
      if (fallbackTimer !== null) {
        globalThis.clearInterval(fallbackTimer);
      }
    };
  }, [workspaceId, connectionState, activeModule]);

  useEffect(() => {
    if (!workspaceId || connectionState !== "online") return;

    const pulseTimer = window.setInterval(() => {
      if (sending || listening || speaking) return;

      const pulseDeck = modulePulseDeck[activeModule] ?? [
        "Scanning workflow bottlenecks and queue saturation.",
        "Re-indexing mission memory for higher response precision.",
        "Balancing operator load across active AI agents.",
        "Monitoring latency envelopes and channel stability.",
        "Preparing a proactive optimization suggestion."
      ];

      const pulse = pulseDeck[Math.floor(Math.random() * pulseDeck.length)];
      const signalContext = activeModuleSignal
        ? `Recent action: ${activeModuleSignal.action.toLowerCase()} (${activeModuleSignal.detail})`
        : null;
      const composedPulse = signalContext ? `${pulse} ${signalContext}.` : pulse;

      setModuleNotice(composedPulse);
      setLivePhase("Autonomous mission pulse");
      pushProcessEvent("info", "Autonomous Pulse", composedPulse);

      setAiPresence((current) => ({
        ...current,
        stance: activeModuleSignal?.intensity && activeModuleSignal.intensity > 26 ? "Executing" : current.stance === "Observing" ? "Planning" : "Observing",
        focus: Math.max(46, Math.min(99, current.focus + (Math.random() > 0.5 ? 1 : -1) + (activeModuleSignal ? 1 : 0))),
        confidence: Math.max(56, Math.min(99, current.confidence + (Math.random() > 0.6 ? 1 : 0) + (activeModuleSignal ? 1 : 0)))
      }));
    }, 18000);

    return () => {
      window.clearInterval(pulseTimer);
    };
  }, [workspaceId, connectionState, sending, listening, speaking, activeModule, activeModuleSignal]);

  const telemetryTransportLabel =
    telemetryTransport === "streaming"
      ? "Stream Live"
      : telemetryTransport === "fallback"
        ? "Fallback Polling"
        : telemetryTransport === "connecting"
          ? "Connecting"
          : "Idle";
    const displayClockLabel = "10:45 PM";
    const displayDateLabel = "Friday, August 1, 2025";
    const notificationAgeLabels = ["2m ago", "5m ago", "12m ago", "20m ago", "32m ago", "45m ago"];
    const activeModuleClassName = `module-${activeModule.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  const commandCenterLayoutClassName = [
    "commandCenterLayout",
    `stance-${aiPresence.stance.toLowerCase()}`,
    `channel-${channelState.toLowerCase()}`,
      connectionState === "offline" ? "offline" : "online",
      activeModuleClassName
  ].join(" ");

  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;

    const updateVoices = () => {
      const voices = window.speechSynthesis.getVoices();
      selectedVoiceRef.current = pickPreferredVoice(voices);
      setVoiceReady(voices.length > 0);
    };

    updateVoices();
    window.speechSynthesis.addEventListener("voiceschanged", updateVoices);

    return () => {
      window.speechSynthesis.removeEventListener("voiceschanged", updateVoices);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const RecognitionCtor = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (!RecognitionCtor) {
      recognitionRef.current = null;
      return;
    }

    const recognition = new RecognitionCtor();
    recognition.lang = "en-US";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event: any) => {
      let finalText = recognitionFinalRef.current;
      let interimText = "";

      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = String(result?.[0]?.transcript ?? "").trim();
        if (!transcript) continue;

        if (result.isFinal) {
          finalText = `${finalText} ${transcript}`.trim();
        } else {
          interimText = `${interimText} ${transcript}`.trim();
        }
      }

      recognitionFinalRef.current = finalText;
      recognitionInterimRef.current = interimText;
      const preview = `${finalText} ${interimText}`.trim();
      if (preview) {
        setVoiceTranscript(preview);
      }
    };

    recognition.onerror = (event: any) => {
      const code = String(event?.error ?? "");
      if (code === "aborted" || code === "no-speech") return;
      setError(`Voice recognition error: ${code || "unknown"}`);
      setListening(false);
      setVoiceTranscribing(false);
    };

    recognition.onend = () => {
      setListening(false);
      const resolver = recognitionStopResolverRef.current;
      if (resolver) {
        recognitionStopResolverRef.current = null;
        const transcript = `${recognitionFinalRef.current} ${recognitionInterimRef.current}`.trim();
        resolver(transcript);
      }
    };

    recognitionRef.current = recognition;

    return () => {
      try {
        recognition.onresult = null;
        recognition.onerror = null;
        recognition.onend = null;
        recognition.stop();
      } catch {
        // Ignore cleanup failures.
      }
      recognitionRef.current = null;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
      stopAmbientTone();
      void earconAudioContextRef.current?.close();
      earconAudioContextRef.current = null;
      if (bootOverlayTimerRef.current !== null) {
        window.clearTimeout(bootOverlayTimerRef.current);
      }
    };
  }, []);

  function getEarconAudioContext(): AudioContext | null {
    if (typeof window === "undefined") return null;

    const Ctor = window.AudioContext ?? (window as any).webkitAudioContext;
    if (!Ctor) return null;

    if (!earconAudioContextRef.current || earconAudioContextRef.current.state === "closed") {
      earconAudioContextRef.current = new Ctor();
    }

    return earconAudioContextRef.current;
  }

  function stopAmbientTone() {
    const context = earconAudioContextRef.current;
    const oscillator = ambientOscillatorRef.current;
    const gain = ambientGainRef.current;

    if (!context || !oscillator || !gain) {
      ambientOscillatorRef.current = null;
      ambientGainRef.current = null;
      return;
    }

    const now = context.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(Math.max(gain.gain.value, 0.0001), now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);

    try {
      oscillator.stop(now + 0.18);
    } catch {
      // Oscillator may already be stopped.
    }

    window.setTimeout(() => {
      try {
        oscillator.disconnect();
        gain.disconnect();
      } catch {
        // Ignore disconnect failures during teardown.
      }
    }, 220);

    ambientOscillatorRef.current = null;
    ambientGainRef.current = null;
  }

  function updateAmbientTone(mode: AmbientMode) {
    const context = getEarconAudioContext();
    if (!context) return;

    void context.resume().catch(() => {
      // Browsers may defer audio until explicit user interaction.
    });

    if (!ambientOscillatorRef.current || !ambientGainRef.current) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();

      oscillator.type = "sine";
      gain.gain.setValueAtTime(0.0001, context.currentTime);

      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(context.currentTime);

      ambientOscillatorRef.current = oscillator;
      ambientGainRef.current = gain;
    }

    const oscillator = ambientOscillatorRef.current;
    const gain = ambientGainRef.current;
    if (!oscillator || !gain) return;

    const now = context.currentTime;
    const profile =
      mode === "listening"
        ? { frequency: 182, volume: 0.013 }
        : mode === "responding"
          ? { frequency: 136, volume: 0.009 }
          : { frequency: 96, volume: 0.005 };

    oscillator.frequency.cancelScheduledValues(now);
    oscillator.frequency.setValueAtTime(Math.max(oscillator.frequency.value, 40), now);
    oscillator.frequency.exponentialRampToValueAtTime(profile.frequency, now + 0.24);

    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(Math.max(gain.gain.value, 0.0001), now);
    gain.gain.exponentialRampToValueAtTime(profile.volume, now + 0.26);
  }

  function playEarcon(name: EarconName) {
    if (!earconsEnabled) return;

    const context = getEarconAudioContext();
    if (!context) return;

    const now = context.currentTime;
    const config =
      name === "boot"
        ? { start: 392, end: 698, duration: 0.14, type: "triangle" as OscillatorType }
        : name === "error"
          ? { start: 260, end: 180, duration: 0.16, type: "sawtooth" as OscillatorType }
          : { start: 520, end: 760, duration: 0.11, type: "triangle" as OscillatorType };

    const oscillator = context.createOscillator();
    const gain = context.createGain();

    oscillator.type = config.type;
    oscillator.frequency.setValueAtTime(config.start, now);
    oscillator.frequency.exponentialRampToValueAtTime(config.end, now + config.duration);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.08, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + config.duration);

    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(now);
    oscillator.stop(now + config.duration + 0.02);
  }

  useEffect(() => {
    if (!ambienceEnabled) {
      stopAmbientTone();
      return;
    }

    const mode: AmbientMode = listening ? "listening" : speaking || sending ? "responding" : "idle";
    updateAmbientTone(mode);

    return () => {
      if (!ambienceEnabled) {
        stopAmbientTone();
      }
    };
  }, [ambienceEnabled, listening, speaking, sending]);

  useEffect(() => {
    const persistedState = readPersistedAssistantState(window.localStorage);
    if (persistedState) {
      setAssistantMode(persistedState.assistantMode);
      setActiveModule(persistedState.activeModule as (typeof primaryModules)[number] || "Dashboard");
      if (persistedState.messages.length) {
        setMessages(persistedState.messages.map((message) => ({
          id: message.id,
          role: message.role,
          content: message.content,
          createdAt: message.createdAt,
          attachments: message.attachments?.map((attachment) => ({
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            previewUrl: attachment.previewUrl ?? ""
          }))
        })));
      }
    }
  }, []);

  useEffect(() => {
    writePersistedAssistantState(window.localStorage, {
      assistantMode,
      activeModule,
      messages: messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
        attachments: message.attachments?.map((attachment) => ({
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          previewUrl: undefined
        }))
      }))
    });
  }, [activeModule, assistantMode, messages]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        setBootStageIndex(0);
        await new Promise<void>((resolve) => {
          window.setTimeout(() => resolve(), 260);
        });
        if (!cancelled) {
          setBootStageIndex(1);
          setLivePhase("Establishing workspace channel");
          pushProcessEvent("info", "Boot Stage", "Workspace channel handshake started.");
        }

        console.log("boot: creating workspace", webEnv.apiBaseUrl);
        const workspaceResponse = await fetch(`${webEnv.apiBaseUrl}/v1/workspaces`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: getJarvisBrandName() })
        });

        if (!workspaceResponse.ok) {
          throw new Error(`Workspace bootstrap failed (${workspaceResponse.status})`);
        }

        const workspacePayload = (await workspaceResponse.json()) as { data: { id: string } };
        const nextWorkspaceId = workspacePayload.data.id;
        if (!cancelled) {
          setBootStageIndex(2);
          setLivePhase("Workspace channel authenticated");
          pushProcessEvent("ok", "Boot Stage", "Workspace channel link established.");
        }

        const conversationResponse = await fetch(`${webEnv.apiBaseUrl}/v1/workspaces/${nextWorkspaceId}/conversations`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: assistantMode, title: "Primary" })
        });

        if (!conversationResponse.ok) {
          throw new Error(`Conversation bootstrap failed (${conversationResponse.status})`);
        }

        const conversationPayload = (await conversationResponse.json()) as { data: { id: string } };
        if (!cancelled) {
          setBootStageIndex(3);
          setLivePhase("Conversation relay negotiating");
          pushProcessEvent("info", "Boot Stage", "Conversation relay is synchronizing.");
        }

        await new Promise<void>((resolve) => {
          window.setTimeout(() => resolve(), 300);
        });

        if (!cancelled) {
          setWorkspaceId(nextWorkspaceId);
          setConversationId(conversationPayload.data.id);
          void loadMemorySummary(nextWorkspaceId);
          setModuleNotice("JARVIS channel online. Type or use the mic.");
          setConnectionState("online");
          setError(null);
          setBootStageIndex(4);
          setLivePhase("Operational");
          pushProcessEvent("ok", "Boot Complete", "JARVIS tactical uplink is online.");
          playEarcon("boot");
          bootOverlayTimerRef.current = window.setTimeout(() => {
            setBootOverlayVisible(false);
          }, 1100);
        }
      } catch (bootstrapError) {
        if (!cancelled) {
          setConnectionState("offline");
          setError(bootstrapError instanceof Error ? bootstrapError.message : "Bootstrap failed.");
          setModuleNotice("Offline mode active. JARVIS will continue locally until the backend reconnects.");
          setBootOverlayVisible(false);
          setWorkspaceId(crypto.randomUUID());
          setConversationId(crypto.randomUUID());
          setMessages((current) => [
            ...current,
            createMessage("assistant", buildLocalAssistantReply("general", "Local workspace ready. We can continue offline.", [], []))
          ]);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  async function loadMemorySummary(workspaceIdToLoad: string) {
    try {
      const response = await fetch(`${webEnv.apiBaseUrl}/v1/workspaces/${workspaceIdToLoad}/memory`);
      if (!response.ok) return;
      const payload = (await response.json()) as { data?: Array<{ title: string; body: string }> };
      const summaries = (payload.data ?? []).map((entry) => entry.title).slice(0, 3);
      setMemorySummary(summaries);
    } catch {
      setMemorySummary([]);
    }
  }

  async function runWorkspaceAction(action: { id: string; title: string; detail: string; kind: WorkspaceActionKind }) {
    const prompt = buildWorkspaceActionPrompt(action.title, action.detail, action.kind);
    const payload = buildWorkspaceActionPayload(action.title, action.detail, action.kind);

    setInput(prompt);
    setModuleNotice(`Preparing ${action.title}...`);
    registerModuleSignal(activeModule, "Workspace action initiated", action.title, 8);
    inputRef.current?.focus();

    if (!workspaceId) {
      setError("Workspace is not ready for action execution yet.");
      return;
    }

    setSending(true);

    try {
      const memoryResponse = await fetch(`${webEnv.apiBaseUrl}/v1/workspaces/${workspaceId}/memory`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: payload.memoryTitle,
          body: payload.memoryBody,
          kind: action.kind
        })
      });

      if (!memoryResponse.ok) {
        throw new Error(`Memory action failed (${memoryResponse.status})`);
      }

      const workflowResponse = await fetch(`${webEnv.apiBaseUrl}/v1/workspaces/${workspaceId}/workflows`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: payload.workflowName,
          definition: payload.workflowDefinition
        })
      });

      if (!workflowResponse.ok) {
        throw new Error(`Workflow creation failed (${workflowResponse.status})`);
      }

      const workflowPayload = (await workflowResponse.json()) as { data?: { id?: string } };
      const workflowId = workflowPayload.data?.id;

      if (workflowId) {
        await fetch(`${webEnv.apiBaseUrl}/v1/workspaces/${workspaceId}/workflows/${workflowId}/runs`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": crypto.randomUUID()
          },
          body: JSON.stringify({})
        });
      }

      const assistantText = `Workspace action executed: ${action.title}. A memory entry and workflow were created, and the next step is ready for review.`;
      setMessages((current) => [...current, createMessage("assistant", assistantText)]);
      setModuleNotice(`Executed ${action.title}.`);
      setLivePhase("Workflow queued");
      registerModuleSignal(activeModule, "Workspace action completed", action.title, 10);
      registerModuleSignal("Automation", "Workflow run queued", action.title, 12);
      pushProcessEvent("ok", "Workspace Action", `${action.title} created a memory record and queued a workflow.`);
      void loadMemorySummary(workspaceId);
      setError(null);
    } catch (runError) {
      const message = runError instanceof Error ? runError.message : "Workspace action failed.";
      setError(message);
      setModuleNotice("Action execution was interrupted.");
      registerModuleSignal(activeModule, "Workspace action failed", message, -6);
      pushProcessEvent("error", "Workspace Action", message);
    } finally {
      setSending(false);
    }
  }

  function speakAssistantReply(content: string) {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    if (!content.trim()) return;

    const outgoingContent = voicePrefaceEnabled ? `Acknowledged. ${content}` : content;

    speakSessionRef.current += 1;
    const thisSession = speakSessionRef.current;
    const selectedVoice = selectedVoiceRef.current;
    const preset = buildVoiceProfile(content, assistantMode);

    window.speechSynthesis.cancel();
    setSpeaking(true);

    const chunks = outgoingContent
      .split(/(?<=[.!?])\s+|(?<=,)\s+/)
      .map((part) => part.trim())
      .filter(Boolean);

    let index = 0;
    const speakNext = () => {
      if (thisSession !== speakSessionRef.current) return;

      const next = chunks[index];
      if (!next) {
        setSpeaking(false);
        return;
      }

      index += 1;

      const utterance = new SpeechSynthesisUtterance(next);
      utterance.rate = preset.rate;
      utterance.pitch = preset.pitch;
      utterance.volume = preset.volume;

      if (selectedVoice) {
        utterance.voice = selectedVoice;
        utterance.lang = selectedVoice.lang;
      }

      utterance.onend = () => {
        if (thisSession !== speakSessionRef.current) return;
        window.setTimeout(speakNext, /[.!?]$/.test(next) ? 140 : 80);
      };

      utterance.onerror = () => {
        if (thisSession !== speakSessionRef.current) return;
        window.setTimeout(speakNext, 100);
      };

      window.speechSynthesis.speak(utterance);
    };

    speakNext();
  }

  function animateAssistantMessage(messageId: string, content: string) {
    typingSessionRef.current += 1;
    const thisSession = typingSessionRef.current;

    setTypingMessageId(messageId);
    setTypingPreview("");

    let index = 0;
    const step = () => {
      if (thisSession !== typingSessionRef.current) return;

      index = Math.min(content.length, index + 2);
      setTypingPreview(content.slice(0, index));

      if (index < content.length) {
        window.setTimeout(step, 16);
        return;
      }

      window.setTimeout(() => {
        if (thisSession !== typingSessionRef.current) return;
        setTypingMessageId(null);
        setTypingPreview("");
      }, 180);
    };

    step();
  }

  async function createScaffoldArtifact(request: string) {
    const scaffoldSpec = buildScaffoldSpec(request);
    const shouldCreate = /build|create|develop|implement|feature|widget|page|component|service|backend/i.test(request);
    if (!shouldCreate || !window.ascendDesktop?.createWorkspaceScaffold) {
      return null;
    }

    try {
      return await window.ascendDesktop.createWorkspaceScaffold({ request, spec: scaffoldSpec });
    } catch {
      return null;
    }
  }

  function queuePrompt(prompt: string) {
    const inferredMode = inferAssistantModeFromContext(activeModule, prompt);
    setAssistantMode(inferredMode);
    setInput(prompt);
    inputRef.current?.focus();
    void sendMessage(prompt);
  }

  async function sendMessage(overrideInput?: string) {
    const draftText = resolveDraftMessageText(overrideInput, input, inputRef.current?.value);
    const outboundContent = buildOutboundMessageContent(draftText, pendingImages);
    if (!outboundContent || sending) return;

    const userVisibleContent = buildUserVisibleMessage(draftText, pendingImages);
    const imagesSnapshot = [...pendingImages];

    const userMessage = createMessage(
      "user",
      userVisibleContent,
      imagesSnapshot.map((image) => ({
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        previewUrl: image.previewUrl
      }))
    );
    setMessages((current) => [...current, userMessage]);
    setLivePhase("Directive queued");
    registerModuleSignal(activeModule, "Directive queued", (draftText.trim() || "Visual directive payload queued.").slice(0, 92), 7);
    pushProcessEvent("info", "Directive Queued", draftText.trim() || "Visual directive payload queued.");
    setInput("");
    setSending(true);
    setError(null);

    try {
      const history: HistoryTurn[] = messages
        .slice(-4)
        .filter((message) => message.content)
        .map((message) => ({ role: message.role, content: message.content }));
      const memoryContext: MemoryContext[] = memorySummary.map((entry) => ({ title: entry, body: entry }));
      const scaffoldResult = await createScaffoldArtifact(draftText);
      const localResponseBundle = buildLocalAssistantResponseBundle(assistantMode, draftText, memoryContext, history, scaffoldResult ?? undefined);

      let assistantText = localResponseBundle.assistantText;
      let assistantPlan: string | null = localResponseBundle.assistantPlan;
      let assistantScaffold: string | null = localResponseBundle.assistantScaffold;

      const shouldUseOfflineRuntime = connectionState === "offline" || connectionState === "booting" || !workspaceId || !conversationId;

      if (!shouldUseOfflineRuntime) {
        try {
          const response = await fetch(`${webEnv.apiBaseUrl}/v1/workspaces/${workspaceId}/conversations/${conversationId}/messages`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": crypto.randomUUID()
            },
            body: JSON.stringify({ content: outboundContent, stream: false, modeOverride: assistantMode })
          });

          if (!response.ok) {
            throw new Error(`Message send failed (${response.status})`);
          }

          const payload = (await response.json()) as {
            data: {
              assistantMessage?: {
                content?: string;
              };
            };
          };

          assistantText = payload.data.assistantMessage?.content?.trim() || assistantText;
          assistantPlan = localResponseBundle.assistantPlan;
          assistantScaffold = localResponseBundle.assistantScaffold;
        } catch (apiError) {
          setConnectionState("offline");
          setModuleNotice("Backend unavailable. Continuing locally.");
          pushProcessEvent("warn", "Connection Fallback", apiError instanceof Error ? apiError.message : "API request failed.");
        }
      }

      const assistantMessage = createMessage("assistant", assistantPlan ? `${assistantText}\n\n${assistantPlan}${assistantScaffold}` : assistantText);
      setMessages((current) => [...current, assistantMessage]);
      setPendingImages([]);
      if (workspaceId) {
        void loadMemorySummary(workspaceId);
      }
      if (connectionState !== "offline") {
        setConnectionState("online");
      }
      animateAssistantMessage(assistantMessage.id, assistantText);
      setModuleNotice("JARVIS response delivered.");
      setLivePhase("Response delivered");
      registerModuleSignal(activeModule, "Response delivered", assistantText.slice(0, 92), 8);
      pushProcessEvent("ok", "Response Delivered", assistantText);
      playEarcon("response");
      speakAssistantReply(assistantText);
    } catch (sendError) {
      setPendingImages(imagesSnapshot);
      setLivePhase("Transmission failure");
      playEarcon("error");
      const sendMessageError = sendError instanceof Error ? sendError.message : "Message send failed.";
      registerModuleSignal(activeModule, "Directive failed", sendMessageError, -7);
      setError(sendMessageError);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }

  function removePendingImage(imageId: string) {
    setPendingImages((current) => current.filter((image) => image.id !== imageId));
  }

  async function attachFiles(selectedFiles: File[]) {
    if (!selectedFiles.length) return;

    const availableSlots = Math.max(0, maxImageAttachments - pendingImages.length);

    if (!availableSlots) {
      setError(`Maximum of ${maxImageAttachments} image attachments allowed.`);
      return;
    }

    const eligibleFiles = selectedFiles.slice(0, availableSlots);
    const oversized = eligibleFiles.find((file) => file.size > maxImageBytes);
    if (oversized) {
      setError(`Image too large: ${oversized.name}. Max size is ${formatBytes(maxImageBytes)}.`);
      return;
    }

    const invalidType = eligibleFiles.find((file) => !file.type.startsWith("image/"));
    if (invalidType) {
      setError(`Unsupported file type: ${invalidType.name}. Please choose image files only.`);
      return;
    }

    try {
      const loadedImages = await Promise.all(
        eligibleFiles.map(async (file) => {
          const dataUrl = await readFileAsDataUrl(file);
          return {
            id: crypto.randomUUID(),
            name: file.name,
            mimeType: file.type || "image/unknown",
            sizeBytes: file.size,
            dataUrl,
            previewUrl: dataUrl
          } as PendingImage;
        })
      );

      setPendingImages((current) => [...current, ...loadedImages]);
      setError(null);
      setModuleNotice(`Attached ${loadedImages.length} image${loadedImages.length > 1 ? "s" : ""}.`);
      registerModuleSignal(activeModule, "Visual assets attached", `${loadedImages.length} image payload queued.`, 5);
      registerModuleSignal("Image Studio", "Visual assets attached", `${loadedImages.length} image payload queued.`, 7);
      pushProcessEvent("ok", "Visual Intelligence Attached", `${loadedImages.length} image payload queued for analysis.`);
    } catch (imageError) {
      setError(imageError instanceof Error ? imageError.message : "Unable to attach selected image.");
    }
  }

  async function onImageInputChange(event: ChangeEvent<HTMLInputElement>) {
    const fileList = event.target.files;
    if (!fileList?.length) return;

    await attachFiles(Array.from(fileList));
    event.target.value = "";
  }

  function onComposerDragOver(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    if (!workspaceId || !conversationId || sending) return;
    setDraggingImages(true);
  }

  function onComposerDragLeave(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setDraggingImages(false);
    }
  }

  async function onComposerDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDraggingImages(false);

    if (!workspaceId || !conversationId || sending) return;

    const dropped = Array.from(event.dataTransfer.files ?? []);
    if (!dropped.length) return;
    await attachFiles(dropped);
  }

  async function onComposerPaste(event: ClipboardEvent<HTMLElement>) {
    if (!workspaceId || !conversationId || sending) return;

    const clipboardItems = Array.from(event.clipboardData?.items ?? []);
    const imageFiles = clipboardItems
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));

    if (!imageFiles.length) {
      const imageHtml = event.clipboardData?.getData("text/html") ?? "";
      const imageUrlMatch = imageHtml.match(/src=["']([^"']+)["']/i);
      if (!imageUrlMatch) {
        return;
      }

      const imageUrl = imageUrlMatch[1];
      if (!imageUrl.startsWith("http") && !imageUrl.startsWith("data:image/")) {
        return;
      }
    }

    event.preventDefault();
    if (!imageFiles.length) {
      const imageUrl = event.clipboardData?.getData("text/plain") || "";
      if (imageUrl.startsWith("data:image/")) {
        try {
          const response = await fetch(imageUrl);
          const blob = await response.blob();
          const file = new File([blob], `pasted-image.${blob.type.split("/")[1] || "png"}`, { type: blob.type });
          await attachFiles([file]);
          setModuleNotice("Image pasted from clipboard.");
          return;
        } catch {
          return;
        }
      }
    }

    if (imageFiles.length) {
      await attachFiles(imageFiles);
      setModuleNotice("Image pasted from clipboard.");
    }
  }

  async function startVoiceInput() {
    const recognition = recognitionRef.current;
    if (!recognition || voiceTranscribing) {
      setError("Voice recognition is not supported in this browser.");
      return;
    }

    try {
      setError(null);
      setVoiceTranscript("");
      recognitionFinalRef.current = "";
      recognitionInterimRef.current = "";
      setModuleNotice("Listening. Press Stop when done speaking.");
      setListening(true);
      setLivePhase("Voice capture engaged");
      registerModuleSignal(activeModule, "Voice capture armed", "Microphone stream enabled for directive intake.", 6);
      registerModuleSignal("Voice Studio", "Voice capture armed", "Microphone stream enabled for directive intake.", 8);
      pushProcessEvent("info", "Voice Capture", "Microphone stream armed for directive capture.");
      recognition.start();
    } catch (startError) {
      setListening(false);
      setError(startError instanceof Error ? startError.message : "Voice failed to start.");
    }
  }

  function stopVoiceInput() {
    const recognition = recognitionRef.current;
    if (!recognition || !listening) return;

    setListening(false);
    setVoiceTranscribing(true);

    void (async () => {
      try {
        const transcript = await new Promise<string>((resolve) => {
          recognitionStopResolverRef.current = resolve;
          recognition.stop();
        });

        const normalized = normalizeVoiceTranscript(transcript);
        if (!normalized) {
          setError("No speech was recognized. Please try again.");
          setModuleNotice("Voice capture finished, but nothing was recognized.");
          return;
        }

        setVoiceTranscript(normalized);
        setModuleNotice(`Heard: ${normalized}`);
        registerModuleSignal(activeModule, "Voice directive transcribed", normalized.slice(0, 92), 7);
        registerModuleSignal("Voice Studio", "Voice directive transcribed", normalized.slice(0, 92), 9);
        pushProcessEvent("ok", "Voice Transcription", normalized);
        await sendMessage(normalized);
      } catch (stopError) {
        setError(stopError instanceof Error ? stopError.message : "Voice transcription failed.");
      } finally {
        setVoiceTranscribing(false);
      }
    })();
  }

  return (
    <main className="jarvisAppShell">
      {bootOverlayVisible ? (
        <div className="bootOverlay" role="status" aria-live="polite">
          <div className="bootCard">
            <p className="jarvisEyebrow">Boot Sequence</p>
            <h2>{getJarvisBrandName()} Initializing</h2>
            <p className="bootSubline">{livePhase}</p>
            <div className="bootReticle" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <div className="bootStageTrack" role="presentation">
              <span style={{ width: `${Math.max(6, Math.round(((bootStageIndex + 1) / bootStages.length) * 100))}%` }} />
            </div>
            {bootStages.map((stage, index) => {
              const stageClass = index <= bootStageIndex ? "bootRow online" : "bootRow";
              return (
                <div key={stage} className={stageClass}>
                  <span className={index <= bootStageIndex ? "bootDot online" : "bootDot"} />
                  <p>{stage}</p>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className={commandCenterLayoutClassName}>
        <aside className="leftCommandRail">
          <div className="railIdentity">
            <div className="identityOrb">A</div>
            <div>
              <strong>TRH</strong>
              <small>{connectionState === "offline" ? "Offline" : "Online"} {connectionState === "offline" ? "" : "●"}</small>
            </div>
          </div>

          <nav className="railNav" aria-label="Primary navigation">
            {primaryModules.map((item) => (
              <button key={item} type="button" className={activeModule === item ? "railItem active" : "railItem"} onClick={() => setActiveModule(item)}>
                <span className="railGlyph" aria-hidden="true">{getModuleGlyph(item)}</span>
                <span>{item}</span>
              </button>
            ))}
          </nav>

          <div className="workspaceListCard">
            <p>Workspaces</p>
            {[
              "TRH Productions",
              "Game Development",
              "Retreats Community",
              "Personal",
              "Research Lab"
            ].map((workspace, index) => (
              <button key={workspace} type="button" className={index === 0 ? "workspaceItem active" : "workspaceItem"}>{workspace}</button>
            ))}
          </div>

          <div className="leftRailControls">
            <button type="button" className="railControlBtn" aria-label="Power">⏻</button>
            <button type="button" className="railControlBtn" aria-label="Messages">✉</button>
            <button type="button" className="railControlBtn" aria-label="Settings">⚙</button>
          </div>
        </aside>

        <section className="centerCommandRegion">
          <div className="moduleHoloMotif" aria-hidden="true" />

          <header className="commandTopFrame">
            <div className="topGreeting">
              <strong>Good Evening, TRH</strong>
              <small>Ready to create something incredible?</small>
            </div>
            <div className="topBrandMark">
              <strong>ASCEND AI</strong>
              <small>YOUR AI COMMAND CENTER</small>
            </div>
            <div className="topRightCluster">
              <div className="topVitals">
                <div><small>System Uptime</small><strong>7D 14H 22M</strong></div>
                <div><small>AI Core</small><strong>{getCoreIntegrity(connectionState)}</strong></div>
                <div><small>Connection</small><strong>{getConnectionSecurityLabel(connectionState)}</strong></div>
              </div>
              <div className="topUtilityIcons" aria-hidden="true">
                <span>⌕</span>
                <span>⌂</span>
                <span>⚙</span>
                <span>─</span>
                <span>□</span>
                <span>✕</span>
              </div>
            </div>
          </header>

          <div className={`commandInputBar state-${channelState.toLowerCase()}`}>
            <span>Command Bar</span>
            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && canSend) {
                  void sendMessage();
                }
              }}
              placeholder="Ask me anything or give a command..."
              disabled={sending}
              aria-label="Command bar input"
            />
            <div className="commandBarMeters" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <div className="commandBarWave" aria-hidden="true">
              {Array.from({ length: 10 }).map((_, index) => {
                const level = Math.sin((index + 1) * 0.8 + coreFlux * 5.2) * 0.5 + 0.5;
                return <span key={index} style={{ height: `${Math.max(3, Math.round(level * 11))}px` }} />;
              })}
            </div>
            <button type="button" className="commandAuxBtn" aria-label="Command options">⌗</button>
            <button type="button" className="commandVoiceBtn" onClick={() => { if (listening) { stopVoiceInput(); } else { void startVoiceInput(); } }}>
              {listening ? "Stop" : "Mic"}
            </button>
          </div>

          <div className="commandSuggestionRow">
            {["Run system scan", "Optimize mission flow", "Open automation queue"].map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                className="commandSuggestionChip"
                onClick={() => {
                  queuePrompt(buildPromptForQuickAction(suggestion));
                }}
              >
                {suggestion}
              </button>
            ))}
          </div>

          <section className="radarBoard">
            <article className="coreStatusCard">
              <h3>AI Core Status</h3>
              <div className="coreStatusGauge">100%</div>
              <div className="coreStatRow"><span>AI Core Status</span><strong>{connectionState === "offline" ? "Offline" : "Optimal"}</strong></div>
              <div className="coreStatRow"><span>Learning Mode</span><strong>{assistantMode.toUpperCase()}</strong></div>
              <div className="coreStatRow"><span>Response Speed</span><strong>{(dashboardMetrics.responseMs / 1000).toFixed(2)}s</strong></div>
              <div className="coreStatRow"><span>Thought Capacity</span><strong>Ultra</strong></div>
            </article>

            <article className="radarCenterCard">
              <div className="radarEnergyField" aria-hidden="true">
                <span className="radarParticle p1" />
                <span className="radarParticle p2" />
                <span className="radarParticle p3" />
                <span className="radarParticle p4" />
              </div>
              <div className={listening || speaking || sending ? "radarRing active" : "radarRing"}>
                <div className="radarRingInner" />
              </div>
              <h2>Hello TRH</h2>
              <p>What shall we build today?</p>
              <div className="radarToolDock" aria-hidden="true">
                <span>◉</span>
                <span>⌘</span>
                <span>⚡</span>
              </div>
              <div className="radarModeTag">Mode: {assistantMode.toUpperCase()}</div>
            </article>

            <article className="overviewCard">
              <h3>Today's Overview</h3>
              <div><span>Tasks Completed</span><strong>{dashboardMetrics.tasksCompleted}</strong></div>
              <div><span>Projects Active</span><strong>{dashboardMetrics.projectsActive}</strong></div>
              <div><span>Agents Running</span><strong>{dashboardMetrics.agentsRunning}</strong></div>
              <div><span>Automations Active</span><strong>{dashboardMetrics.automationsActive}</strong></div>
            </article>
          </section>

          <section className="actionQueueStrip" aria-label="Workspace actions">
            {workspaceActions.map((action) => (
              <button key={action.id} type="button" className="actionQueueCard" onClick={() => { void runWorkspaceAction(action); }}>
                <strong>{action.title}</strong>
                <small>{action.detail}</small>
                <span>{action.kind}</span>
              </button>
            ))}
          </section>

          <section className="workbenchRow">
            <article className="workbenchPanel">
              <div className="panelHeadLine"><strong>Quick Launch</strong></div>
              <div className="quickGrid">
                {[
                  ["New Project", "Core", "＋"],
                  ["Code Studio", "Dev", "</>"],
                  ["Game Studio", "Build", "◈"],
                  ["Image Studio", "Visual", "▣"],
                  ["Video Studio", "Motion", "▷"],
                  ["Music Studio", "Audio", "♫"],
                  ["AI Agents", "Ops", "⟐"],
                  ["Automation", "Flow", "⟳"]
                ].map((item) => (
                  <button
                    key={item[0]}
                    type="button"
                    className="quickLaunchTile"
                    onClick={() => {
                      if ((primaryModules as readonly string[]).includes(item[0])) {
                        setActiveModule(item[0] as (typeof primaryModules)[number]);
                      }

                      const prompt = buildPromptForQuickAction(item[0]);
                      queuePrompt(prompt);
                    }}
                  >
                    <span className="quickLaunchGlyph" aria-hidden="true">{item[2]}</span>
                    <strong>{item[0]}</strong>
                    <small>{item[1]}</small>
                  </button>
                ))}
              </div>
            </article>

            <article className="workbenchPanel">
              <div className="panelHeadLine"><strong>Recent Projects</strong></div>
              {liveProjects.map((project) => (
                <div key={project.name} className="projectLine">
                  <div>
                    <strong>{project.name}</strong>
                    <small>{project.category} · {project.stack}</small>
                  </div>
                  <span>{project.age}</span>
                </div>
              ))}
            </article>

            <article className="workbenchPanel">
              <div className="panelHeadLine"><strong>AI Suggestions</strong></div>
              {liveSuggestions.map((suggestion) => (
                <button key={suggestion.title} type="button" className="suggestionLine" onClick={() => queuePrompt(`${suggestion.title}: ${suggestion.detail}`)}>
                  <strong>{suggestion.title}</strong>
                  <small>{suggestion.detail}</small>
                </button>
              ))}
            </article>
          </section>

          <section className="conversationPanel" aria-label="AI conversation">
            <div className="conversationHead">
              <strong>AI Conversation</strong>
              <small>{buildConversationStatus(livePhase, channelState)}</small>
            </div>
            <div className="messages commandMessages" ref={messagesRef} aria-live="polite">
              {messages.map((message) => {
                const isTyping = message.role === "assistant" && message.id === typingMessageId;
                const body = isTyping ? typingPreview || message.content : message.content;

                return (
                  <article key={message.id} className={`bubble ${message.role}`}>
                    <strong>{message.role === "assistant" ? getJarvisBrandName() : "TRH"}</strong>
                    <p className={isTyping ? "typingText" : undefined}>{body}</p>
                    {message.attachments?.length ? (
                      <div className="bubbleAttachments">
                        {message.attachments.map((attachment) => (
                          <figure key={`${message.id}-${attachment.name}`} className="bubbleAttachment">
                            <img src={attachment.previewUrl} alt={attachment.name} loading="lazy" />
                            <figcaption>{attachment.name}</figcaption>
                          </figure>
                        ))}
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>

            <div className="conversationDockLine" aria-hidden="true">
              <div className="conversationWave">
                {Array.from({ length: 18 }).map((_, index) => {
                  const phase = Math.sin((index + 1) * 0.75 + coreFlux * 4.5) * 0.5 + 0.5;
                  return <span key={index} style={{ height: `${Math.max(3, Math.round(phase * 10))}px` }} />;
                })}
              </div>
              <div className="conversationTools">
                <span>◉</span>
                <span>⌕</span>
                <span>⚙</span>
              </div>
            </div>

            <div className="composerRow" onDragOver={onComposerDragOver} onDragLeave={onComposerDragLeave} onDrop={(event) => void onComposerDrop(event)} onPaste={(event) => void onComposerPaste(event)}>
              <input
                ref={inputRef}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && canSend) {
                    void sendMessage();
                  }
                }}
                placeholder="Would you like me to optimize your workflow or start a new project?"
                disabled={sending}
                aria-label="Conversation input"
              />
              <input ref={imageInputRef} type="file" accept="image/*" multiple hidden onChange={(event) => void onImageInputChange(event)} />
              <button type="button" onClick={() => imageInputRef.current?.click()} disabled={sending || pendingImages.length >= maxImageAttachments}>Attach</button>
              <button type="button" onClick={() => { void sendMessage(); }} disabled={!canSend}>Send</button>
            </div>

            <div className="modeRow">
              {(["general", "coding", "business", "creator"] as const).map((mode) => (
                <button key={mode} type="button" className={assistantMode === mode ? "modeChip active" : "modeChip"} onClick={() => setAssistantMode(mode)}>
                  {mode}
                </button>
              ))}
              <button type="button" className={voicePrefaceEnabled ? "modeChip active" : "modeChip"} onClick={() => setVoicePrefaceEnabled((current) => !current)}>Preface</button>
              <button type="button" className={earconsEnabled ? "modeChip active" : "modeChip"} onClick={() => setEarconsEnabled((current) => !current)}>Earcons</button>
              <button type="button" className={ambienceEnabled ? "modeChip active" : "modeChip"} onClick={() => setAmbienceEnabled((current) => !current)}>Ambience</button>
            </div>
          </section>

          {pendingImages.length ? (
            <section className="attachmentTray" aria-label="Pending image attachments">
              {pendingImages.map((image) => (
                <article key={image.id} className="attachmentChip">
                  <img src={image.previewUrl} alt={`Attachment preview ${image.name}`} loading="lazy" />
                  <div>
                    <strong>{image.name}</strong>
                    <small>{formatBytes(image.sizeBytes)}</small>
                  </div>
                  <button type="button" onClick={() => removePendingImage(image.id)} disabled={sending}>Remove</button>
                </article>
              ))}
            </section>
          ) : null}

          {false ? <p className="jarvisNotice">{moduleNotice}</p> : null}
          {error ? <p className="errorBanner">{error}</p> : null}
        </section>

        <aside className="rightCommandRail">
          <section className="railPanel agentsPanel">
            <div className="panelHeadLine split"><strong>Active AI Agents</strong><button type="button">View All</button></div>
            {liveAgents.map((agent, index) => (
              <div key={agent.name} className="agentLine">
                <div className={`agentBadge tone-${index % 4}`} aria-hidden="true">
                  {index === 0 ? "⌘" : index === 1 ? "◈" : index === 2 ? "✦" : "◎"}
                </div>
                <div>
                  <strong>{agent.name}</strong>
                  <small>{agent.detail}</small>
                  <div className="agentProgress" aria-hidden="true">
                    <span
                      style={{
                        width: `${Math.max(
                          22,
                          Math.min(96, Math.round((dashboardMetrics.cpu + dashboardMetrics.gpu + index * 9 + Math.floor(coreFlux * 100)) % 100))
                        )}%`
                      }}
                    />
                  </div>
                </div>
                <div className="agentLiveMeta">
                  <div className="agentStrip" aria-hidden="true"><span /><span /><span /><span /></div>
                  <span>{agent.status}</span>
                </div>
              </div>
            ))}
          </section>

          <section className="railPanel systemPanel">
            <div className="panelHeadLine split"><strong>System Monitor</strong><button type="button">Live</button></div>
            <div className={`presenceInline ${aiPresence.stance.toLowerCase()}`}>
              <span>{`AI ${aiPresence.stance.toUpperCase()}`}</span>
              <small>{`${aiPresence.confidence}% / ${aiPresence.focus}%`}</small>
            </div>
            <div className="presenceInlineTrace" aria-label="AI stance transition trace">
              {stanceTraceItems.slice(-3).map((item) => (
                <span key={item.key} className={`traceChip ${item.stance.toLowerCase()}`}>{`${item.stance} ${item.ageLabel}`}</span>
              ))}
            </div>
            <div className="telemetryHealthRow">
              <span className={`telemetryBadge ${telemetryTransport}`}>{telemetryTransportLabel}</span>
              <small>{`Last sync ${telemetryLastSyncLabel}`}</small>
            </div>
            <div className="telemetryStatsRow">
              <div><span>Event Rate</span><strong>{`${telemetryEventsPerMinute}/min`}</strong></div>
              <div><span>Reconnects</span><strong>{telemetryReconnects}</strong></div>
              <div><span>Signal Gap</span><strong>{`${telemetryGapSeconds}s`}</strong></div>
            </div>
            <div className="monitorRings">
              <div><span>CPU</span><strong>{dashboardMetrics.cpu}%</strong></div>
              <div><span>GPU</span><strong>{dashboardMetrics.gpu}%</strong></div>
              <div><span>RAM</span><strong>{dashboardMetrics.ram}%</strong></div>
              <div><span>Storage</span><strong>{dashboardMetrics.storage}%</strong></div>
            </div>
            <div className="monitorSparkline" aria-hidden="true">
              <svg viewBox="0 0 280 36" preserveAspectRatio="none">
                <polyline points="0,27 14,22 28,24 42,16 56,20 70,14 84,18 98,12 112,15 126,10 140,13 154,8 168,12 182,9 196,15 210,11 224,18 238,14 252,20 266,16 280,19" />
              </svg>
            </div>
            <div className="systemScanline" aria-hidden="true" />
            <div className={listening || speaking || sending ? "signalBars active" : "signalBars"} aria-hidden="true">
              {Array.from({ length: 16 }).map((_, index) => {
                const phase = Math.sin((index + 1) * 0.9 + coreFlux * 4) * 0.45 + 0.55;
                return <span key={index} style={{ height: `${Math.max(6, Math.round(phase * 24))}px` }} />;
              })}
            </div>
            <div className="networkRows">
              <div><span>Network</span><strong>{`↑ ${dashboardMetrics.networkUpGbps.toFixed(2)} GB/s`}</strong></div>
              <div><span>Latency</span><strong>{`↓ ${dashboardMetrics.networkDownGbps.toFixed(2)} GB/s`}</strong></div>
            </div>
          </section>

          <section className="railPanel notificationsPanel">
            <div className="panelHeadLine split"><strong>Notifications</strong><button type="button">View All</button></div>
            <div className="notificationFeed">
              {processEvents.slice(-6).reverse().map((event, index) => (
                <div key={event.id} className={`notificationLine ${event.level}`}>
                  <div>
                    <strong>{event.title}</strong>
                    <small>{event.detail}</small>
                  </div>
                  <span>{notificationAgeLabels[index] ?? event.at}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="timePanel">
            <div className="timeOrb" />
            <strong>{displayClockLabel || systemTimeLabel || "--:-- --"}</strong>
            <small>{displayDateLabel}</small>
          </section>
        </aside>
      </div>
    </main>
  );
}
