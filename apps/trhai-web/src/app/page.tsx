"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Core } from "../components/Core";
import { useAssistant, type AssistantStatus } from "../hooks/useAssistant";
import { useSpeech } from "../hooks/useSpeech";
import { ParticleField } from "../components/ParticleField";
import { useMicrophone } from "../hooks/useMicrophone";
import { Markdown } from "../components/Markdown";
import { Subsystems, type Subsystem } from "../components/Subsystems";
import { CommandAccess } from "../components/CommandAccess";
import { ExecutionTrace } from "../components/ExecutionTrace";
import {
  ActiveTasks, ConnectedServices, MemoryStatus, PersonalityCard, SystemOverview, ToolsGrid,
  type AgentTask, type HealthRow, type Tile
} from "../components/CommandPanels";
import { apiGet, sessionId } from "../lib/api";
import { readStoredPersonality } from "../lib/personality";
import {
  activeAgent, personalityById, readMarketplaceState, readFlow, speakableText, type Agent
} from "@ascend/shared";
import { marketplaceStorageKey } from "../lib/agents";
import ChatSurface from "./chat/page";
import TasksSurface from "./tasks/page";
import CalendarSurface from "./calendar/page";
import MemorySurface from "./memory/page";
import KnowledgeSurface from "./knowledge/page";
import AutomationSurface from "./automation/page";
import AgentsSurface from "./agents/page";
import SecuritySurface from "./security/page";
import SystemSurface from "./system/page";
import FilesSurface from "./files/page";
import SettingsSurface from "./settings/page";
import "./dash.css";

// The command centre.
//
// Built to the reference design: a core at the middle, subsystems flanking
// it, a console down the left, instruments down the right, and a state rail
// across the bottom. The layout is followed closely because it is a good
// layout — a machine you can read at a glance.
//
// What is not followed is any number the reference invents. It shows a health
// dial pinned at 100%, task bars at 72% and 45%, "13.2 GB / 15.0 GB" of
// memory, five connected services, and subsystems at v4.2.1 and v3.8.7 all
// lit green. None of those are things this build can measure, and a dial that
// always reads 100% is not an instrument — it is a picture of one. So every
// panel keeps its place in the design and is filled from something real:
// health is the fraction of checks that actually passed, tasks show the tools
// that genuinely ran instead of a bar nothing measures, and a subsystem that
// is not installed says so rather than showing ACTIVE.
//
// That is the difference between a screen that looks alive and one that is.

type ModelInfo = { available: boolean; model?: string; reason?: string };
type SpeechInfo = { available: boolean; voice?: string; reason?: string };
type TranscribeInfo = { available: boolean; model?: string; reason?: string };
type Reading = { fraction: number | null; detail: string; unavailable: string | null };
type Telemetry = {
  cpu: Reading & { cores: number; model: string };
  memory: Reading;
  gpu: Reading & { name: string | null; vram: Reading | null };
  cloud: { services: string[] };
};
type ScheduleView = { id: string; enabled: boolean };

type Presence = {
  core: "idle" | "listening" | "thinking" | "executing" | "speaking" | "success" | "error";
  label: string;
};

/**
 * What the core does and what the status line says, from real state alone.
 *
 * Listening outranks the request states because it describes the device
 * rather than the request: if the microphone is genuinely open, that is the
 * most important true thing on the screen.
 */
function presence(status: AssistantStatus, listening: boolean, speaking: boolean): Presence {
  if (listening) return { core: "listening", label: "LISTENING" };
  if (status.state === "executing") {
    // The stage says which part of the pipeline this is; the tool says what is
    // doing it. Both are real readings, and neither stands in for the other.
    const stage = status.stage ? `${status.stage.toUpperCase()} · ` : "";
    return { core: "executing", label: `${stage}${status.tool.replace(/_/g, " ").toUpperCase()}` };
  }
  if (status.state === "thinking") {
    // "THINKING" for thirty seconds is true and says almost nothing.
    return { core: "thinking", label: (status.stage ?? "Thinking").toUpperCase() };
  }
  if (status.state === "success") return { core: "success", label: "COMPLETE" };
  if (status.state === "error") return { core: "error", label: "ERROR" };
  if (speaking) return { core: "speaking", label: "SPEAKING" };
  return { core: "idle", label: "STANDING BY" };
}

/** The bottom rail. At most one is lit, and it is lit by real state. */
const stages = ["ENGAGED", "LISTENING", "THINKING", "EXECUTING", "COMPLETE"] as const;

function activeStage(core: Presence["core"], hasConversation: boolean): string | null {
  if (core === "listening") return "LISTENING";
  if (core === "thinking" || core === "speaking") return "THINKING";
  if (core === "executing") return "EXECUTING";
  if (core === "success") return "COMPLETE";
  // "Engaged" means a conversation is genuinely under way, not merely that
  // the page is open — otherwise the rail would light before anything had
  // happened and would mean nothing at all.
  return hasConversation ? "ENGAGED" : null;
}

function greetingFor(date: Date): string {
  const hour = date.getHours();
  if (hour < 5) return "Still up";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/** A top-bar metric. Shows a dash, never a number, when it cannot be read. */
function Metric({ label, reading }: { label: string; reading: Reading | null | undefined }) {
  const fraction = reading?.fraction;
  const known = fraction !== null && fraction !== undefined;
  const percent = known ? Math.round(fraction * 100) : null;
  const tone = !known ? "" : fraction >= 0.9 ? " danger" : fraction >= 0.7 ? " warn" : "";

  return (
    <div className="metric" title={reading?.unavailable ?? reading?.detail ?? ""}>
      <span className="metric-label">{label}</span>
      <span className={`metric-value${tone}`}>{percent === null ? "—" : `${percent}%`}</span>
    </div>
  );
}

const quickAccess = [
  { href: "/automation", label: "Projects & flows", glyph: "◇" },
  { href: "/files", label: "Files & documents", glyph: "▣" },
  { href: "/security", label: "AI tools", glyph: "◐" },
  { href: "/system", label: "System logs", glyph: "▦" }
];

const tiles: Tile[] = [
  { href: "/chat", label: "Chat", glyph: "◉", hint: "Talk to TRHAI" },
  { href: "/files", label: "Files", glyph: "▣", hint: "The workspace on disk" },
  { href: "/knowledge", label: "Knowledge", glyph: "▥", hint: "Documents TRHAI can quote" },
  { href: "/system", label: "System", glyph: "▦", hint: "What is running, and which build" },
  { href: "/automation", label: "Automation", glyph: "◇", hint: "Flows and schedules" },
  { href: "/memory", label: "Memory", glyph: "◍", hint: "Facts TRHAI has kept" },
  { href: "/tasks", label: "Tasks", glyph: "▤", hint: "Your to-do list" },
  { href: "/calendar", label: "Calendar", glyph: "▧", hint: "Your schedule" },
  { href: "/agents", label: "Agents", glyph: "◆", hint: "Installable lenses" },
  { href: "/security", label: "Security", glyph: "◐", hint: "Tools and permissions" },
  { href: "/settings", label: "Settings", glyph: "⚙", hint: "Voice, theme, personality" }
];

/** Every surface of the app, reachable without leaving this screen. */
type SurfaceId =
  | "home" | "chat" | "tasks" | "calendar" | "memory" | "knowledge"
  | "automation" | "agents" | "security" | "system" | "files" | "settings";

const surfaceTitles: Record<SurfaceId, string> = {
  home: "Command centre",
  chat: "Chat",
  tasks: "Tasks",
  calendar: "Calendar",
  memory: "Memory",
  knowledge: "Knowledge",
  automation: "Automation",
  agents: "Agents",
  security: "Security",
  system: "System",
  files: "Files",
  settings: "Settings"
};

/**
 * The panel for a surface.
 *
 * These are the same components the old routes render, used directly rather
 * than copied — so a surface cannot drift between the two ways of reaching
 * it, and /files still works as a bookmark.
 */
function renderSurface(id: SurfaceId) {
  switch (id) {
    case "chat": return <ChatSurface />;
    case "tasks": return <TasksSurface />;
    case "calendar": return <CalendarSurface />;
    case "memory": return <MemorySurface />;
    case "knowledge": return <KnowledgeSurface />;
    case "automation": return <AutomationSurface />;
    case "agents": return <AgentsSurface />;
    case "security": return <SecuritySurface />;
    case "system": return <SystemSurface />;
    case "files": return <FilesSurface />;
    case "settings": return <SettingsSurface />;
    default: return null;
  }
}

/** "/files" -> "files". The tiles and quick links already carry hrefs. */
function surfaceFor(href: string): SurfaceId {
  return (href === "/" ? "home" : href.slice(1)) as SurfaceId;
}

export default function DashboardPage() {
  const [surface, setSurface] = useState<SurfaceId>("home");
  const { messages, status, send } = useAssistant();
  const mic = useMicrophone();
  const speech = useSpeech();

  const [clock, setClock] = useState<Date | null>(null);
  const [draft, setDraft] = useState("");
  const [online, setOnline] = useState<boolean | null>(null);
  const [model, setModel] = useState<ModelInfo | null>(null);
  const [voice, setVoice] = useState<SpeechInfo | null>(null);
  const [stt, setStt] = useState<TranscribeInfo | null>(null);
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null);
  const [tools, setTools] = useState<number | null>(null);
  const [memories, setMemories] = useState<{ total: number; pinned: number } | null>(null);
  const [documents, setDocuments] = useState<number | null>(null);
  const [schedules, setSchedules] = useState<ScheduleView[] | null>(null);
  const [workspace, setWorkspace] = useState<{ files: number; bytes: number } | null>(null);
  const [agentTasks, setAgentTasks] = useState<AgentTask[] | null>(null);
  const [agent, setAgent] = useState<Agent | null>(null);
  const [personality, setPersonality] = useState<{ name: string; traits: string[]; summary: string } | null>(null);
  const [flowName, setFlowName] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);

  const inputRef = useRef<HTMLInputElement>(null);
  const lastSpokenId = useRef<string | null>(null);

  const { core, label } = presence(status, mic.listening, speech.speaking);
  const busy = status.state === "thinking" || status.state === "executing";
  const lastReply = [...messages].reverse().find((message) => message.role === "assistant") ?? null;

  // Clock fills in on the client. Rendering a time on the server guarantees
  // it disagrees with the client a second later.
  useEffect(() => {
    setClock(new Date());
    const ticker = window.setInterval(() => setClock(new Date()), 1000);
    return () => window.clearInterval(ticker);
  }, []);

  useEffect(() => {
    const chosen = personalityById(readStoredPersonality(window.localStorage));
    const installed = activeAgent(readMarketplaceState(window.localStorage, marketplaceStorageKey));
    setAgent(installed);
    // label and voice.tone, which is what a personality genuinely carries —
    // there is no `traits` field, and personalities.ts enforces by test that
    // one cannot be added, because capability lives in the permission layer
    // rather than in a profile you can switch with a click.
    setPersonality({
      name: chosen.label,
      traits: [chosen.voice.cadence, chosen.responseStyle.formality],
      summary: chosen.summary
    });
    setSuggestions(installed?.suggestions ?? chosen.suggestions ?? []);
    setFlowName(readFlow(window.localStorage, "trhai.automation.flow.v1")?.name ?? null);
  }, []);

  const readAll = useCallback(async () => {
    const id = sessionId();
    const [
      modelResult, telemetryResult, speechResult, sttResult,
      capabilityResult, memoryResult, knowledgeResult, scheduleResult,
      filesResult, taskResult
    ] = await Promise.all([
      apiGet<ModelInfo>("/v1/assist/model"),
      apiGet<Telemetry>("/v1/system-telemetry"),
      apiGet<SpeechInfo>("/v1/speech"),
      apiGet<TranscribeInfo>("/v1/transcribe"),
      apiGet<{ tools: unknown[] }>("/v1/capabilities"),
      apiGet<{ memories: Array<{ pinned?: boolean }> }>(`/v1/assist/memory?sessionId=${id}`),
      apiGet<{ documents: unknown[] }>(`/v1/knowledge?sessionId=${id}`),
      apiGet<{ schedules: ScheduleView[] }>("/v1/schedules"),
      apiGet<{ entries: Array<{ directory: boolean; bytes: number }> }>("/v1/files"),
      apiGet<{ tasks: AgentTask[] }>(`/v1/agent-tasks?sessionId=${id}`)
    ]);

    // One reachability answer for the screen, from the request that would
    // fail first. Marking each panel separately unreachable would be ten ways
    // of saying the same thing.
    setOnline(modelResult.ok);
    if (modelResult.ok) setModel(modelResult.data);
    if (telemetryResult.ok) setTelemetry(telemetryResult.data);
    if (speechResult.ok) setVoice(speechResult.data);
    if (sttResult.ok) setStt(sttResult.data);
    if (capabilityResult.ok) setTools(capabilityResult.data.tools.length);
    if (memoryResult.ok) {
      setMemories({
        total: memoryResult.data.memories.length,
        pinned: memoryResult.data.memories.filter((entry) => entry.pinned).length
      });
    }
    if (knowledgeResult.ok) setDocuments(knowledgeResult.data.documents.length);
    if (scheduleResult.ok) setSchedules(scheduleResult.data.schedules);
    if (filesResult.ok) {
      const files = filesResult.data.entries.filter((entry) => !entry.directory);
      setWorkspace({ files: files.length, bytes: files.reduce((sum, entry) => sum + entry.bytes, 0) });
    }
    if (taskResult.ok) setAgentTasks(taskResult.data.tasks);
  }, []);

  useEffect(() => {
    void readAll();
    const poller = window.setInterval(() => void readAll(), 4000);
    return () => window.clearInterval(poller);
  }, [readAll]);

  // Read the newest reply aloud when voice is on. Restored history is never
  // spoken, and each reply is spoken at most once.
  useEffect(() => {
    if (!speech.enabled) return;
    const newest = messages[messages.length - 1];
    if (!newest || newest.role !== "assistant") return;
    if (newest.id.startsWith("restored-")) return;
    // Never mid-stream. Speaking the first token would read one word aloud
    // and stop, and marking it spoken would mean the finished reply is never
    // read at all.
    if (newest.streaming) return;
    if (lastSpokenId.current === newest.id) return;

    lastSpokenId.current = newest.id;
    if (mic.listening) return;
    // Spoken as prose, not as markup: the reply renders as formatted text, so
    // reading "asterisk asterisk" aloud would say something different from
    // what is on screen.
    speech.speak(speakableText(newest.text));
  }, [messages, speech, mic.listening]);

  async function handleMic() {
    if (!mic.listening) {
      // Stop any reply already being read, or the microphone opens into
      // TRHAI's own voice and transcribes it back.
      speech.stop();
      await mic.start();
      return;
    }
    const said = await mic.stop();
    if (said) setDraft((existing) => (existing.trim() ? `${existing.trim()} ${said}` : said));
  }

  function ask(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setDraft("");
    void send(trimmed);
  }

  const modelName = model?.available && model.model
    ? model.model.replace(/^ollama\//, "").replace(/:latest$/, "")
    : null;

  // While the microphone is open this shows the room's real loudness; while
  // speaking, the voice's own amplitude; otherwise how hard the core is
  // working. All three are real, and it is flat when there is genuinely
  // nothing to measure.
  const level = mic.listening
    ? mic.amplitude
    : speech.speaking && speech.amplitude !== undefined
      ? speech.amplitude
      : status.state === "executing" ? 1 : status.state === "thinking" ? 0.6 : 0;

  const enabledSchedules = schedules?.filter((schedule) => schedule.enabled).length ?? null;

  const leftSubsystems: Subsystem[] = [
    {
      name: "Language model",
      detail: modelName,
      online: model === null ? null : model.available,
      reason: model?.reason ?? "No local model is running."
    },
    {
      name: "Transcription",
      detail: stt?.model ?? null,
      online: stt === null ? null : stt.available,
      reason: stt?.reason ?? "No whisper model installed."
    },
    {
      name: "Memory core",
      detail: memories === null ? null : `${memories.total} kept · ${memories.pinned} pinned`,
      online: memories === null ? null : true
    },
    {
      name: "Tool registry",
      detail: tools === null ? null : `${tools} registered`,
      online: tools === null ? null : tools > 0
    }
  ];

  const rightSubsystems: Subsystem[] = [
    {
      name: "Speech synthesis",
      detail: voice?.voice ?? null,
      online: voice === null ? null : voice.available,
      reason: voice?.reason ?? "Piper is not installed.",
      // The one subsystem with a genuine live signal: the neural voice
      // exposes its audio, so this bar is the real amplitude.
      level: speech.speaking ? speech.amplitude ?? 0 : 0
    },
    {
      name: "Scheduler",
      detail: enabledSchedules === null ? null : `${enabledSchedules} active of ${schedules?.length ?? 0}`,
      online: schedules === null ? null : true
    },
    {
      name: "Workspace",
      detail: workspace === null ? null : `${workspace.files} files`,
      online: workspace === null ? null : true
    },
    {
      name: "Automation",
      detail: flowName,
      online: flowName === null ? false : true,
      reason: "No flow saved yet."
    }
  ];

  const healthRows: HealthRow[] = [
    {
      label: "Local API",
      state: online === null ? "checking" : online ? "connected" : "unreachable",
      ok: online
    },
    {
      label: "Model",
      state: model === null ? "checking" : model.available ? "loaded" : "none",
      ok: model === null ? null : model.available
    },
    {
      label: "Voice",
      state: voice === null ? "checking" : voice.available ? "ready" : "absent",
      ok: voice === null ? null : voice.available
    },
    {
      label: "Transcription",
      state: stt === null ? "checking" : stt.available ? "ready" : "absent",
      ok: stt === null ? null : stt.available
    },
    {
      label: "Scheduler",
      state: schedules === null ? "checking" : "running",
      ok: schedules === null ? null : true
    }
  ];

  const stage = activeStage(core, messages.length > 0);
  const failing = healthRows.filter((row) => row.ok === false).length;

  return (
    <div className={`cc cc-${core}`}>
      <header className="cc-top">
        <div className="cc-brand">
          <span className="cc-mark" aria-hidden="true">▽</span>
          <div className="cc-brand-text">
            <span className="cc-wordmark">TRH AI</span>
            <span className="cc-sub">VEXORA</span>
          </div>
        </div>

        <div className="cc-top-status">
          <span className="hud-label">System status</span>
          <span className={`cc-status-word${online ? " ok" : online === false ? " danger" : ""}`}>
            {online === null ? "CONNECTING" : online ? "ONLINE" : "OFFLINE"}
          </span>
          <span className={`cc-dot${online ? " live" : ""}`} aria-hidden="true" />
          {/* Not "all systems operational" as a fixed caption. It counts the
              checks that actually failed, so it can say something different
              when something is wrong. */}
          <span className="faint cc-status-note">
            {online === false
              ? "The local API is not responding"
              : failing === 0
                ? "All checks passing"
                : `${failing} not available`}
          </span>
        </div>

        <div className="cc-metrics">
          <Metric label="CPU" reading={telemetry?.cpu} />
          <Metric label="RAM" reading={telemetry?.memory} />
          <Metric label="GPU" reading={telemetry?.gpu} />
          <Metric label="VRAM" reading={telemetry?.gpu.vram} />
        </div>

        <div className="cc-clock mono">
          {clock ? (
            <>
              <span className="cc-time">
                {clock.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </span>
              <span className="cc-date">
                {clock.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" }).toUpperCase()}
              </span>
            </>
          ) : <span className="cc-time">--:--:--</span>}
        </div>
      </header>

      <div className="cc-body">
        <aside className="cc-left">
          <section className="hud-panel cc-console">
            <span className="hud-label">TRH AI console</span>
            <div className="console-feed">
              {messages.length === 0 ? (
                <p className="faint">
                  {modelName
                    ? `${greetingFor(clock ?? new Date())}, Hank. Answering with ${modelName}.`
                    : "No local model is loaded yet."}
                </p>
              ) : (
                messages.slice(-6).map((message) => (
                  <article key={message.id} className={`console-turn console-${message.role}`}>
                    <span className="console-who">{message.role === "user" ? "YOU" : "TRH AI"}</span>
                    {message.role === "assistant"
                      ? <Markdown text={message.text} className="console-text" />
                      : <p className="console-text">{message.text}</p>}
                  </article>
                ))
              )}
            </div>

            {/* The room, or TRHAI's own voice — whichever is genuinely being
                measured. Flat when neither is, rather than idling for show. */}
            <div className="console-wave" aria-hidden="true">
              {Array.from({ length: 48 }, (_, index) => {
                const profile = Math.abs(Math.sin((index / 48) * Math.PI * 3));
                const height = Math.max(1, Math.round(level * profile * 26));
                return <span key={index} style={{ height: `${height}px` }} />;
              })}
            </div>

            <div className="console-voice">
              <span className="hud-label">Voice input</span>
              <span className={`console-voice-state${mic.listening ? " live" : ""}`}>
                {mic.transcribing ? "Transcribing…" : mic.listening ? "Listening…" : "Idle"}
              </span>
            </div>
            {mic.error ? <p className="cc-note">{mic.error}</p> : null}
          </section>

          <section className="hud-panel">
            <span className="hud-label">Quick access</span>
            <div className="quick">
              {quickAccess.map((item) => (
                <button key={item.href} type="button" className="quick-item"
                  onClick={() => setSurface(surfaceFor(item.href))}>
                  <span className="quick-glyph" aria-hidden="true">{item.glyph}</span>
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          </section>
        </aside>

        <main className="cc-stage">
          <ParticleField state={core} className="cc-particles" />

          {/* One screen: a surface opens here rather than on its own page, so
              the core, the machine readings, the console and the state rail
              all stay where they are while you use it. Nothing unmounts, so a
              reply still arriving keeps arriving. */}
          {surface !== "home" ? (
            <section className="cc-surface" aria-label={surfaceTitles[surface]}>
              <header className="cc-surface-head">
                {/* The core follows you in. Hiding it while a surface is open
                    meant the one thing on this screen that is actually alive
                    disappeared the moment you started using the app — and it
                    is the same component reading the same state, not a badge
                    standing in for it, so it still listens, thinks and speaks
                    here exactly as it does at full size. */}
                <div className="cc-surface-core" title={label}>
                  <Core
                    state={core}
                    size={26}
                    amplitude={mic.listening ? mic.amplitude : speech.speaking ? speech.amplitude : undefined}
                  />
                </div>
                <span className="hud-label">{surfaceTitles[surface]}</span>
                <span className="cc-surface-state">{label}</span>
                <button type="button" className="cc-surface-close" onClick={() => setSurface("home")}>
                  Close
                </button>
              </header>
              <div className="cc-surface-body">{renderSurface(surface)}</div>
            </section>
          ) : null}

          <div className="cc-core-title">
            <h1>TRH AI CORE</h1>
            <span className="cc-core-state">{label}</span>
          </div>

          <div className="cc-core-row">
            <Subsystems items={leftSubsystems} side="left" />

            <div className="cc-core-wrap">
              <Core
                state={core}
                size={330}
                amplitude={mic.listening ? mic.amplitude : speech.speaking ? speech.amplitude : undefined}
              />
            </div>

            <Subsystems items={rightSubsystems} side="right" />
          </div>

          <div className="cc-actions">
            <button
              type="button"
              className={`cc-action${mic.listening ? " live" : ""}`}
              disabled={!mic.supported || mic.transcribing}
              onClick={() => void handleMic()}
              title={mic.supported
                ? "Speak your request. Transcribed on this machine, never uploaded."
                : "This browser exposes no microphone."}
            >
              <span className="cc-action-glyph" aria-hidden="true">◉</span>
              <span>TALK</span>
            </button>
            {/* The reference has a VISION button. There is no vision system in
                this build, and a button that opens nothing is worse than one
                fewer button — so this is FILES, which does something. */}
            <button type="button" className="cc-action" title="The workspace, read straight from disk"
              onClick={() => setSurface(surfaceFor("/files"))}>
              <span className="cc-action-glyph" aria-hidden="true">▣</span>
              <span>FILES</span>
            </button>
            <button
              type="button"
              className={`cc-action cc-action-main${busy ? " live" : ""}`}
              onClick={() => (draft.trim() ? ask(draft) : inputRef.current?.focus())}
              title="Ask TRHAI"
            >
              <span className="cc-action-glyph" aria-hidden="true">▽</span>
              <span>THINK</span>
            </button>
            <button type="button" className="cc-action" title="Documents TRHAI can quote"
              onClick={() => setSurface(surfaceFor("/knowledge"))}>
              <span className="cc-action-glyph" aria-hidden="true">◎</span>
              <span>SEARCH</span>
            </button>
            <button type="button" className="cc-action" title="Flows and schedules that run on their own"
              onClick={() => setSurface(surfaceFor("/automation"))}>
              <span className="cc-action-glyph" aria-hidden="true">◇</span>
              <span>AUTONOMY</span>
            </button>
          </div>

          <div className="cc-ask">
            <input
              ref={inputRef}
              className="cc-ask-field"
              value={draft}
              placeholder={busy ? "TRHAI is working…" : "How can I help you, Hank?"}
              aria-label="Ask TRHAI anything"
              disabled={busy}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") ask(draft); }}
            />
            <button type="button" className="cc-ask-go" onClick={() => ask(draft)} disabled={!draft.trim() || busy}>
              {busy ? "…" : "Send"}
            </button>
          </div>

          {mic.listening ? (
            <p className="cc-note">
              {mic.transcriptionAvailable
                ? "Listening. Press TALK again to stop — transcribed on this machine, never uploaded."
                : `Listening as a level meter only: ${mic.transcriptionReason}`}
            </p>
          ) : null}

          <div className="cc-suggestions">
            {suggestions.slice(0, 4).map((suggestion) => (
              <button key={suggestion} type="button" className="hud-chip" onClick={() => ask(suggestion)}>
                {suggestion}
              </button>
            ))}
          </div>
        </main>

        <aside className="cc-right">
          <CommandAccess />
          <SystemOverview rows={healthRows} />
          <ActiveTasks tasks={agentTasks} />
          <ExecutionTrace busy={busy} />
          <ToolsGrid tiles={tiles} onOpen={(href) => setSurface(surfaceFor(href))} />
          <ConnectedServices services={telemetry?.cloud.services ?? []} />
          <MemoryStatus
            entries={memories?.total ?? null}
            pinned={memories?.pinned ?? null}
            documents={documents}
            workspaceBytes={workspace?.bytes ?? null}
            workspaceFiles={workspace?.files ?? null}
          />
          <PersonalityCard
            name={personality?.name ?? "—"}
            traits={personality?.traits ?? []}
            focus={agent?.focus ?? personality?.summary ?? null}
            agentName={agent?.name ?? null}
          />
        </aside>
      </div>

      <footer className="cc-states mono">
        {stages.map((name) => (
          <span key={name} className={`cc-stage-word${stage === name ? " on" : ""}`}>{name}</span>
        ))}
        <span className="cc-states-note faint">
          {lastReply?.model
            ? `Answered by ${lastReply.model.replace(/^ollama\//, "")}`
            : "Everything on this screen is measured on this machine."}
        </span>
      </footer>
    </div>
  );
}
