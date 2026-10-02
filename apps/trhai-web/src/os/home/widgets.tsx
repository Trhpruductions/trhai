"use client";

import type { ReactNode } from "react";
import { Icon } from "../ui/Icon";
import { Trend } from "../ui/Trend";
import { useSystem, formatRate, formatUptime, percent } from "../state/system";
import { useActivity, useLevels, useVoice } from "../state/assistant";
import { useHealth } from "../state/health";
import { useNav } from "../state/nav";
import { normalisedToPeak } from "../../lib/telemetryHistory";
import type { WidgetId } from "./layout";

// The Home widgets. Every number is a reading the API returned; a reading that
// could not be taken shows a dash and says why, never a plausible figure.

export const widgetTitles: Record<WidgetId, string> = {
  vitals: "System vitals",
  health: "Health",
  modules: "Modules",
  activity: "Live activity",
  tasks: "Tasks",
  upcoming: "Upcoming",
  voice: "Voice"
};

function Reading({ label, value, values, tone, note }: {
  label: string; value: string; values?: Array<number | null>; tone?: "accent" | "violet" | "ok" | "warn"; note?: string | null;
}) {
  return (
    <div className="os-reading">
      <div className="os-reading-head">
        <span className="os-label">{label}</span>
        <span className="os-reading-value os-mono">{value}</span>
      </div>
      {values ? <Trend values={values} height={30} tone={tone} label={label} /> : null}
      {note ? <span className="os-reading-note">{note}</span> : null}
    </div>
  );
}

export function VitalsWidget({ expanded }: { expanded: boolean }) {
  const { telemetry, history } = useSystem();
  const gpu = telemetry?.gpu;
  return (
    <div className="os-readings">
      <Reading label="Processor" value={percent(telemetry?.cpu.fraction)} values={history.cpu} note={telemetry?.cpu.unavailable} />
      <Reading label="Memory" value={percent(telemetry?.memory.fraction)} values={history.memory} tone="violet" note={telemetry?.memory.unavailable} />
      <Reading label="Graphics" value={percent(gpu?.fraction)} values={history.gpu} tone="ok" note={gpu?.unavailable} />
      <Reading
        label="Network"
        value={telemetry?.network ? formatRate(telemetry.network.receivedBytesPerSecond, telemetry.network.sentBytesPerSecond) : "—"}
        values={normalisedToPeak(history.network)}
        tone="warn"
      />
      {expanded ? (
        <dl className="os-kv">
          <div><dt>GPU temperature</dt><dd className="os-mono">{gpu?.temperatureC != null ? `${Math.round(gpu.temperatureC)} °C` : "—"}</dd></div>
          <div><dt>GPU power</dt><dd className="os-mono">{gpu?.powerWatts != null ? `${Math.round(gpu.powerWatts)} W` : "—"}</dd></div>
          <div><dt>Video memory</dt><dd className="os-mono">{gpu?.vram?.detail || "—"}</dd></div>
          <div><dt>Disk</dt><dd className="os-mono">{telemetry?.disk.detail || "—"}</dd></div>
          <div><dt>Up for</dt><dd className="os-mono">{telemetry ? formatUptime(telemetry.uptimeSeconds) : "—"}</dd></div>
        </dl>
      ) : null}
    </div>
  );
}

export function HealthWidget({ expanded }: { expanded: boolean }) {
  const { rows, health } = useHealth();
  const stability = health ? Math.round((health.passed / health.total) * 100) : null;
  const circumference = 2 * Math.PI * 26;
  return (
    <div className="os-health">
      <div className="os-health-ring" role="img" aria-label={stability === null ? "Checking" : `${stability}% of checks passing`}>
        <svg viewBox="0 0 64 64" aria-hidden="true">
          <circle className="os-ring-track" cx="32" cy="32" r="26" />
          <circle
            className={`os-ring-live${stability !== null && stability < 100 ? " warn" : ""}`}
            cx="32" cy="32" r="26"
            strokeDasharray={circumference}
            strokeDashoffset={(1 - (stability ?? 0) / 100) * circumference}
          />
        </svg>
        <span className="os-mono">{stability === null ? "…" : `${stability}%`}</span>
      </div>
      <ul className="os-health-rows">
        {(expanded ? rows : rows.slice(0, 4)).map((row) => (
          <li key={row.label}>
            <span className={`os-dot ${row.ok === null ? "" : row.ok ? "ok" : "warn"}`} aria-hidden="true" />
            <span>{row.label}</span>
            <span className="os-faint os-mono">{row.state}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ModulesWidget({ expanded }: { expanded: boolean }) {
  const { modules } = useHealth();
  return (
    <ul className="os-modules">
      {modules.map((module) => (
        <li key={module.name}>
          <span className={`os-dot ${module.state === "online" ? "ok" : module.state === "standby" ? "accent" : ""}`} aria-hidden="true" />
          <span className="os-module-name">{module.name}</span>
          <span className={`os-chip ${module.state === "online" ? "ok" : module.state === "standby" ? "accent" : ""}`}>{module.state}</span>
          {expanded ? <span className="os-module-detail">{module.detail}</span> : null}
        </li>
      ))}
    </ul>
  );
}

export function ActivityWidget({ expanded }: { expanded: boolean }) {
  const activity = useActivity();
  if (activity.length === 0) {
    return (
      <div className="os-empty">
        <strong>Quiet so far</strong>
        <p>Listening, thinking, tools running and replies appear here as they happen.</p>
      </div>
    );
  }
  return (
    <ol className="os-activity">
      {activity.slice(0, expanded ? 16 : 6).map((entry) => (
        <li key={entry.id} className={entry.tone}>
          <span className="os-activity-time os-mono">{new Date(entry.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
          <span className="os-activity-source">{entry.source}</span>
          <span className="os-activity-text">{entry.text}</span>
        </li>
      ))}
    </ol>
  );
}

export function TasksWidget({ expanded }: { expanded: boolean }) {
  const { tasks, agentTasks } = useSystem();
  const { go } = useNav();
  const open = tasks?.filter((task) => !task.done) ?? [];
  const done = tasks?.filter((task) => task.done).length ?? 0;
  const running = agentTasks?.filter((task) => task.status === "executing").length ?? 0;
  const failed = agentTasks?.filter((task) => task.status === "failed" || task.status === "blocked").length ?? 0;
  const succeeded = agentTasks?.filter((task) => task.status === "succeeded").length ?? 0;
  return (
    <div className="os-tasks-widget">
      <div className="os-counts">
        <div><strong className="os-mono">{open.length}</strong><span>To do</span></div>
        <div><strong className="os-mono">{running}</strong><span>Running</span></div>
        <div><strong className="os-mono">{done + succeeded}</strong><span>Done</span></div>
        <div className={failed ? "warn" : ""}><strong className="os-mono">{failed}</strong><span>Failed</span></div>
      </div>
      {open.length > 0 ? (
        <ul className="os-todo-peek">
          {open.slice(0, expanded ? 8 : 3).map((task) => <li key={task.id}><span className="os-dot accent" aria-hidden="true" />{task.title}</li>)}
        </ul>
      ) : <p className="os-faint os-small">Nothing open. Ask TRH AI to add a task, or add one in Tasks.</p>}
      <button type="button" className="os-btn os-btn-sm os-btn-ghost" onClick={() => go("tasks")}>Open Tasks<Icon name="chevronRight" size={14} /></button>
    </div>
  );
}

function dueIn(iso: string | undefined): string {
  if (!iso) return "";
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return "";
  if (ms < 60_000) return "due now";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours} h`;
  return `in ${Math.round(hours / 24)} d`;
}

export function UpcomingWidget({ expanded }: { expanded: boolean }) {
  const { schedules } = useSystem();
  const upcoming = (schedules ?? []).filter((schedule) => schedule.enabled)
    .sort((a, b) => Date.parse(a.nextDueAt ?? "") - Date.parse(b.nextDueAt ?? ""));
  if (upcoming.length === 0) {
    return (
      <div className="os-empty">
        <strong>Nothing scheduled</strong>
        <p>Try &ldquo;remind me every day at 9 am to stretch&rdquo; in the command bar.</p>
      </div>
    );
  }
  return (
    <ul className="os-upcoming">
      {upcoming.slice(0, expanded ? 8 : 3).map((schedule) => (
        <li key={schedule.id}>
          <span className="os-upcoming-name">{schedule.name ?? "Schedule"}</span>
          <span className="os-faint">{schedule.cadenceLabel}</span>
          <span className="os-chip accent">{dueIn(schedule.nextDueAt)}</span>
        </li>
      ))}
    </ul>
  );
}

function Waveform({ bars = 32 }: { bars?: number }) {
  const { level } = useLevels();
  return (
    <div className="os-wave" aria-hidden="true">
      {Array.from({ length: bars }, (_, index) => {
        const profile = Math.abs(Math.sin((index / bars) * Math.PI * 3));
        return <span key={index} style={{ height: `${Math.max(2, Math.round((0.12 + level * 0.88) * profile * 26))}px` }} />;
      })}
    </div>
  );
}

export function VoiceWidget() {
  const { mic, speech, handsFree, setHandsFree, toggleMic } = useVoice();
  const recognition = mic.supported && mic.transcriptionAvailable !== false;
  return (
    <div className="os-voice-widget">
      <Waveform />
      <ul className="os-health-rows">
        <li><span className={`os-dot ${mic.listening ? "accent live" : recognition ? "ok" : ""}`} aria-hidden="true" /><span>Recognition</span>
          <span className="os-faint os-mono">{mic.transcribing ? "transcribing" : mic.listening ? "listening" : recognition ? "ready" : "unavailable"}</span></li>
        <li><span className={`os-dot ${speech.speaking ? "accent live" : speech.enabled && speech.engine !== "none" ? "ok" : ""}`} aria-hidden="true" /><span>Output</span>
          <span className="os-faint os-mono">{speech.speaking ? "speaking" : speech.engine === "none" ? "no engine" : speech.enabled ? "on" : "muted"}</span></li>
      </ul>
      <div className="os-view-actions">
        <button type="button" className={`os-btn os-btn-sm${mic.listening ? " on" : ""}`} disabled={!mic.supported} onClick={() => void toggleMic()}>
          <Icon name="mic" size={14} />{mic.listening ? "Stop" : "Speak"}
        </button>
        <button type="button" className={`os-btn os-btn-sm${handsFree ? " on" : ""}`} disabled={!recognition} onClick={() => setHandsFree(!handsFree)}>
          <Icon name="wave" size={14} />Hands-free {handsFree ? "on" : "off"}
        </button>
      </div>
    </div>
  );
}

export function widgetBody(id: WidgetId, expanded: boolean): ReactNode {
  switch (id) {
    case "vitals": return <VitalsWidget expanded={expanded} />;
    case "health": return <HealthWidget expanded={expanded} />;
    case "modules": return <ModulesWidget expanded={expanded} />;
    case "activity": return <ActivityWidget expanded={expanded} />;
    case "tasks": return <TasksWidget expanded={expanded} />;
    case "upcoming": return <UpcomingWidget expanded={expanded} />;
    case "voice": return <VoiceWidget />;
  }
}
