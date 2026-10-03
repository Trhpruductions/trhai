"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { apiGet, sessionId } from "../../lib/api";
import { emptySeries, pushSample, type Series } from "../../lib/telemetryHistory";
import { readDismissedRendering, renderingKey, writeDismissedRendering } from "../../lib/renderingDismissal";
import type { AgentTask, TaskItem } from "../../lib/taskCenter";
import { useNotify } from "./notify";

// What TRH AI knows about the machine and its own services, read from the
// local API. Moved here from the old single-screen page unchanged in what it
// asks and how often: everything the stage shows every 4 seconds while the
// window is visible, nothing while it is hidden, and the things that cannot
// change without a restart asked once.

export type ModelInfo = { available: boolean; model?: string; reason?: string };
export type TranscribeInfo = { available: boolean; model?: string; reason?: string };
export type Reading = { fraction: number | null; detail: string; unavailable: string | null };
export type Telemetry = {
  cpu: Reading & { cores: number; model: string; speedMhz: number };
  memory: Reading;
  gpu: Reading & { name: string | null; vram: Reading | null; temperatureC: number | null; clockMhz: number | null; powerWatts: number | null };
  cloud: { services: string[]; detail?: string };
  disk: Reading;
  network: Reading & { receivedBytesPerSecond: number | null; sentBytesPerSecond: number | null };
  uptimeSeconds: number;
};
export type Identity = { username: string; hostname: string; platform: string };
export type ScheduleView = {
  id: string; name?: string; enabled: boolean; cadenceLabel?: string; actionLabel?: string;
  nextDueAt?: string; lastRunAt?: string | null; lastStatus?: string | null; lastDetail?: string | null; createdAt?: string;
  /** Running in the API right now. */
  running?: boolean;
};
export type CapabilityTool = { name: string; level: number; levelLabel: string; description?: string };
export type CapabilityInfo = { tools: CapabilityTool[]; videoRendering?: boolean; web?: boolean; codeExecution?: boolean; model?: string | null };
export type RenderingView = { name: string; title: string; kind: "mockup" | "diagram"; html: string; createdAt: string };

type SystemState = {
  /** Whether the local API answered the last read; null before the first. */
  online: boolean | null;
  model: ModelInfo | null;
  /** The model's name as people say it - "qwen2.5-coder:7b". */
  modelName: string | null;
  telemetry: Telemetry | null;
  history: Series;
  capabilities: CapabilityInfo | null;
  memories: { total: number; pinned: number } | null;
  documents: number | null;
  schedules: ScheduleView[] | null;
  schedulePersistError: string | null;
  workspace: { files: number; bytes: number } | null;
  agentTasks: AgentTask[] | null;
  tasks: TaskItem[] | null;
  setTasks: (update: (prior: TaskItem[] | null) => TaskItem[] | null) => void;
  rendering: RenderingView | null;
  renderingDismissed: boolean;
  dismissRendering: () => void;
  identity: Identity | null;
  buildVersion: string;
  stt: TranscribeInfo | null;
  /** Read everything again now, rather than at the next tick. */
  refresh: () => Promise<void>;
};

const SystemContext = createContext<SystemState | null>(null);

/** Two minutes of readings at the four-second poll. */
const historyLength = 30;
const pollMs = 4000;
/** The counts and the model's availability: they change when something is done, not by themselves. */
const settledPollMs = 20_000;

export function SystemProvider({ children }: { children: ReactNode }) {
  const { notify } = useNotify();
  const [online, setOnline] = useState<boolean | null>(null);
  const [model, setModel] = useState<ModelInfo | null>(null);
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null);
  const [history, setHistory] = useState<Series>(emptySeries);
  const [capabilities, setCapabilities] = useState<CapabilityInfo | null>(null);
  const [memories, setMemories] = useState<{ total: number; pinned: number } | null>(null);
  const [documents, setDocuments] = useState<number | null>(null);
  const [schedules, setSchedules] = useState<ScheduleView[] | null>(null);
  const [schedulePersistError, setSchedulePersistError] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<{ files: number; bytes: number } | null>(null);
  const [agentTasks, setAgentTasks] = useState<AgentTask[] | null>(null);
  const [tasks, setTasksState] = useState<TaskItem[] | null>(null);
  const [rendering, setRendering] = useState<RenderingView | null>(null);
  const [dismissedRendering, setDismissedRendering] = useState<string | null>(null);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [buildVersion, setBuildVersion] = useState("0.0.0");
  const [stt, setStt] = useState<TranscribeInfo | null>(null);

  // What moves by the second: the gauges, the work under way, the schedules
  // that may be running. Read every four seconds while the window is visible.
  const readLive = useCallback(async () => {
    const id = sessionId();
    const [telemetryResult, taskResult, scheduleResult] = await Promise.all([
      apiGet<Telemetry>("/v1/system-telemetry"),
      apiGet<{ tasks: AgentTask[] }>(`/v1/agent-tasks?sessionId=${id}`),
      apiGet<{ schedules: ScheduleView[]; persistenceError?: string | null }>("/v1/schedules")
    ]);
    // Whether the service answered at all - any of the three will do.
    setOnline(telemetryResult.ok || taskResult.ok || scheduleResult.ok);
    // A reading that could not be taken is a hole, never the last number left
    // on screen as if it were current.
    const reading = telemetryResult.ok ? telemetryResult.data : null;
    setTelemetry(reading);
    setHistory((prior) => pushSample(prior, reading, historyLength));
    if (taskResult.ok) setAgentTasks(taskResult.data.tasks);
    if (scheduleResult.ok) {
      setSchedules(scheduleResult.data.schedules);
      setSchedulePersistError(scheduleResult.data.persistenceError ?? null);
    }
  }, []);

  // What changes when something is done - a reply, a save - rather than by
  // itself: counts, the model's availability, the latest rendering. These
  // used to be read with the gauges every four seconds, which meant a walk of
  // up to 5,000 workspace entries and two questions to the model engine, every four
  // seconds, for figures that change a few times an hour. Now every twenty,
  // and at once after anything that changes them - see refresh().
  const readSettled = useCallback(async () => {
    const id = sessionId();
    const [modelResult, capabilityResult, memoryResult, filesResult, renderingResult, knowledgeResult, todoResult] = await Promise.all([
      apiGet<ModelInfo>("/v1/assist/model"),
      apiGet<CapabilityInfo>("/v1/capabilities"),
      apiGet<{ memories: Array<{ pinned?: boolean }> }>(`/v1/assist/memory?sessionId=${id}`),
      apiGet<{ entries: Array<{ directory: boolean; bytes: number }> }>("/v1/files"),
      apiGet<{ latest: RenderingView | null }>("/v1/renderings"),
      apiGet<{ documents: unknown[] }>(`/v1/knowledge?sessionId=${id}`),
      apiGet<{ tasks: TaskItem[] }>(`/v1/tasks?sessionId=${id}`)
    ]);
    if (modelResult.ok) setModel(modelResult.data);
    if (capabilityResult.ok) setCapabilities(capabilityResult.data);
    if (renderingResult.ok) setRendering(renderingResult.data.latest);
    if (memoryResult.ok) {
      setMemories({
        total: memoryResult.data.memories.length,
        pinned: memoryResult.data.memories.filter((entry) => entry.pinned).length
      });
    }
    if (knowledgeResult.ok) setDocuments(knowledgeResult.data.documents.length);
    if (filesResult.ok) {
      const files = filesResult.data.entries.filter((entry) => !entry.directory);
      setWorkspace({ files: files.length, bytes: files.reduce((sum, entry) => sum + entry.bytes, 0) });
    }
    if (todoResult.ok) setTasksState(todoResult.data.tasks);
  }, []);

  const readAll = useCallback(async () => {
    await Promise.all([readLive(), readSettled()]);
  }, [readLive, readSettled]);

  // Polling stops while the window is hidden and resumes with a fresh read.
  useEffect(() => {
    let poller: number | null = null;
    let settledPoller: number | null = null;
    const start = () => {
      if (poller !== null) return;
      void readAll();
      poller = window.setInterval(() => void readLive(), pollMs);
      settledPoller = window.setInterval(() => void readSettled(), settledPollMs);
    };
    const stop = () => {
      if (poller === null) return;
      window.clearInterval(poller);
      if (settledPoller !== null) window.clearInterval(settledPoller);
      poller = null;
      settledPoller = null;
    };
    const onVisibility = () => (document.hidden ? stop() : start());
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
  }, [readAll, readLive, readSettled]);

  // Constants of the machine and the install, asked once.
  useEffect(() => {
    void apiGet<{ apiVersion: string }>("/v1/build-info").then((result) => {
      if (result.ok && result.data.apiVersion) setBuildVersion(result.data.apiVersion);
    });
    void apiGet<Identity>("/v1/identity").then((result) => {
      if (result.ok) setIdentity(result.data);
    });
    void apiGet<TranscribeInfo>("/v1/transcribe").then((result) => {
      if (result.ok) setStt(result.data);
    });
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a stored preference, unknowable on the server
    setDismissedRendering(readDismissedRendering(window.localStorage));
  }, []);

  // The service going away, and coming back, are worth saying once each.
  const lastOnline = useRef<boolean | null>(null);
  useEffect(() => {
    const was = lastOnline.current;
    lastOnline.current = online;
    if (was === null || online === null || was === online) return;
    if (online) {
      notify({ level: "success", title: "Local API back online", body: "TRH AI's service is answering again.", source: "SYSTEM" });
    } else {
      notify({
        level: "error", title: "Local API not responding", source: "SYSTEM",
        body: "TRH AI's service on this PC stopped answering. Everything resumes when it is back.",
        action: { label: "Retry now", run: () => void readAll() }
      });
    }
  }, [online, notify, readAll]);

  const setTasks = useCallback((update: (prior: TaskItem[] | null) => TaskItem[] | null) => setTasksState(update), []);
  const dismissRendering = useCallback(() => {
    if (!rendering) return;
    const key = renderingKey(rendering);
    setDismissedRendering(key);
    writeDismissedRendering(window.localStorage, key);
  }, [rendering]);

  const modelName = model?.available && model.model ? model.model.replace(/^(?:local|ollama)\//, "").replace(/:latest$/, "") : null;
  const renderingDismissed = rendering ? renderingKey(rendering) === dismissedRendering : true;

  const value = useMemo<SystemState>(() => ({
    online, model, modelName, telemetry, history, capabilities, memories, documents, schedules, schedulePersistError,
    workspace, agentTasks, tasks, setTasks, rendering, renderingDismissed, dismissRendering, identity, buildVersion, stt,
    refresh: readAll
  }), [online, model, modelName, telemetry, history, capabilities, memories, documents, schedules, schedulePersistError,
    workspace, agentTasks, tasks, setTasks, rendering, renderingDismissed, dismissRendering, identity, buildVersion, stt, readAll]);

  return <SystemContext.Provider value={value}>{children}</SystemContext.Provider>;
}

export function useSystem(): SystemState {
  const system = useContext(SystemContext);
  if (!system) throw new Error("useSystem needs SystemProvider");
  return system;
}

/** "↓1.2 MB/s ↑340 KB/s" - a network rate, both ways, in units a person reads. */
export function formatRate(rx: number | null, tx: number | null): string {
  if (rx === null && tx === null) return "—";
  return `↓${formatBytesPerSecond(rx ?? 0)} ↑${formatBytesPerSecond(tx ?? 0)}`;
}

export function formatBytesPerSecond(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B/s`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB/s`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB/s`;
}

export function formatUptime(totalSeconds: number): string {
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function percent(fraction: number | null | undefined): string {
  return fraction === null || fraction === undefined ? "—" : `${Math.round(fraction * 100)}%`;
}
