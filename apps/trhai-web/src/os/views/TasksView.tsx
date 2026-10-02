"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Markdown } from "../../components/Markdown";
import type { ExecutionEvent } from "../../hooks/useExecutionEvents";
import { apiDelete, apiGet, apiPatch, apiPost, sessionId } from "../../lib/api";
import { whenUsed } from "../../lib/conversationGroups";
import {
  between, cadenceFrom, countWork, dueLabel, filterHistory, filterSchedules, filters, finishedWords, formatDuration,
  formatElapsed, isRunningNow, needsYou, orderSchedules, runWords, taskPhase, taskTitle, taskTypeLabel, toolLabel,
  type AgentTask, type FinishedStatus, type FinishedStep, type FinishedTask, type ScheduleRun, type TaskFilter, type TaskItem
} from "../../lib/taskCenter";
import { Icon } from "../ui/Icon";
import { ViewFrame } from "../ui/ViewFrame";
import { useAssistantState } from "../state/assistant";
import { useNav } from "../state/nav";
import { useNotify } from "../state/notify";
import { useSystem, type ScheduleView } from "../state/system";
import "./views.css";

// Every piece of work in one place: what TRH AI is doing right now, step by
// step; what is waiting on you; what runs on a schedule, with every run it has
// made; everything it has finished and how each went; and your own to-do
// list. All of it is read from the API. Nothing is estimated, and nothing is
// called running unless the API is running it.

const finishedTone: Record<FinishedStatus, string> = { succeeded: "ok", failed: "danger", blocked: "warn", interrupted: "warn" };
const runTone: Record<ScheduleRun["status"], string> = { ok: "ok", failed: "danger", missed: "warn", interrupted: "warn" };
const sid = () => encodeURIComponent(sessionId());

/** "just now", "5m ago", "Yesterday", "2 Oct". */
function ago(iso: string, now: Date): string {
  const said = whenUsed(iso, now);
  if (said === "now") return "just now";
  return /^\d+[mh]$/.test(said) ? `${said} ago` : said;
}

/** A clock time, with the day when it is not today. */
function clockTime(iso: string, now: Date): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const sameDay = at.toDateString() === now.toDateString();
  return at.toLocaleString([], sameDay ? { hour: "numeric", minute: "2-digit" } : { weekday: "short", hour: "numeric", minute: "2-digit" });
}

/** Tools with repeats folded: "write file ×3". */
function toolTally(tools: string[]): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const tool of tools) counts.set(tool, (counts.get(tool) ?? 0) + 1);
  return [...counts.entries()].map(([name, count]) => ({ name, count }));
}

const stepWords: Record<FinishedStep["status"], string> = { ok: "done", failed: "failed", skipped: "skipped", running: "running" };

/** Steps as they happened. `ended` says the work is over, so an open step did not finish. */
function StepList({ steps, ended }: { steps: Array<FinishedStep | ExecutionEvent>; ended: boolean }) {
  return (
    <ol className="os-steps">
      {steps.map((step, index) => {
        const unfinished = ended && step.status === "running";
        return (
          <li key={`${step.startedAt}-${index}`} className={`os-step ${unfinished ? "unfinished" : step.status}`}>
            <span className="os-step-mark" aria-hidden="true">
              {step.status === "ok" ? <Icon name="check" size={13} />
                : step.status === "failed" ? <Icon name="close" size={13} />
                  : step.status === "running" && !unfinished ? <span className="os-dot accent live" />
                    : <span className="os-step-dash" />}
            </span>
            <span className="os-step-label">
              {step.label}
              <span className="os-sr"> - {unfinished ? "did not finish" : stepWords[step.status]}</span>
            </span>
            <span className="os-step-time os-mono">
              {unfinished ? "did not finish" : step.status === "running" ? "running" : step.durationMs !== undefined ? formatDuration(step.durationMs) : ""}
            </span>
            {step.detail ? <span className="os-step-detail">{step.detail}</span> : null}
            {step.artifact ? <span className="os-step-artifact os-mono">{step.artifact}</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

function RunningNow({ task, events, schedules, now, onOpenChat }: {
  task: AgentTask | null; events: ExecutionEvent[]; schedules: ScheduleView[]; now: Date; onOpenChat: () => void;
}) {
  const type = task ? taskTypeLabel(task.taskType) : null;
  // updatedAt is when this attempt started: nothing writes it again until it ends.
  const elapsed = task ? between(task.updatedAt, now) : null;
  return (
    <section className="os-panel os-task-live" aria-label="Running now">
      <header className="os-panel-head">
        <h3 className="os-panel-title">{task || schedules.length ? <span className="os-dot accent live" aria-hidden="true" /> : null}Running now</h3>
      </header>
      <div className="os-panel-body os-stack">
        {!task && schedules.length === 0 ? (
          <div className="os-empty">
            <strong>Nothing running</strong>
            <p>Ask TRH AI to build, fix or look into something and it shows here while it works, step by step.</p>
          </div>
        ) : null}
        {task ? (
          <article className="os-task-card">
            <div className="os-task-card-head">
              {type ? <span className="os-chip accent">{type}</span> : null}
              <strong className="os-task-card-title" title={task.request}>{taskTitle(task.request)}</strong>
              {elapsed !== null ? <span className="os-mono os-small os-dim" title="How long it has been running">{formatElapsed(elapsed)}</span> : null}
            </div>
            {events.length > 0
              ? <StepList steps={events} ended={false} />
              : <p className="os-faint os-small">Working it out. Steps appear here as they happen.</p>}
            <div className="os-task-card-actions">
              <button type="button" className="os-btn os-btn-sm" onClick={onOpenChat}><Icon name="message" size={14} />Open chat</button>
            </div>
          </article>
        ) : null}
        {schedules.map((schedule) => (
          <div key={schedule.id} className="os-task-sched-live">
            <Icon name="clock" size={15} />
            <span><strong>{schedule.name || "A schedule"}</strong> is running</span>
            <span className="os-faint os-small">{schedule.actionLabel}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function WaitingOnYou({ task, busy, onResume }: { task: AgentTask; busy: boolean; onResume: () => void }) {
  const phase = taskPhase(task);
  const word = phase === "stopped" ? "Never finished" : phase === "blocked" ? "Blocked" : "Failed";
  const why = phase === "stopped"
    ? "It stopped part-way. The app may have been closed or restarted while it ran."
    : task.error ?? "";
  return (
    <section className="os-panel os-task-attention" aria-label="Waiting on you">
      <header className="os-panel-head"><h3 className="os-panel-title">Waiting on you</h3></header>
      <div className="os-panel-body">
        <article className="os-task-card">
          <div className="os-task-card-head">
            <span className={`os-chip ${phase === "failed" ? "danger" : "warn"}`}>{word}</span>
            <strong className="os-task-card-title" title={task.request}>{taskTitle(task.request)}</strong>
          </div>
          {why ? <p className="os-task-why">{why}</p> : null}
          <div className="os-task-card-actions">
            <button type="button" className="os-btn os-btn-sm os-btn-primary" disabled={busy} onClick={onResume}>
              <Icon name="play" size={14} />Resume
            </button>
            <span className="os-faint os-small">Picks it up where it stopped, the same as saying &ldquo;continue&rdquo; in chat.</span>
          </div>
        </article>
      </div>
    </section>
  );
}

function ScheduleRow({ schedule, now, onChanged }: { schedule: ScheduleView; now: Date; onChanged: () => void }) {
  const { notify } = useNotify();
  const [showLog, setShowLog] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [runs, setRuns] = useState<ScheduleRun[] | null>(null);
  const [starting, setStarting] = useState(false);
  const name = schedule.name || "Untitled schedule";
  const path = `/v1/schedules/${encodeURIComponent(schedule.id)}`;

  const loadRuns = useCallback(async () => {
    const result = await apiGet<{ runs: ScheduleRun[] }>(`${path}/runs`);
    if (result.ok) setRuns(result.data.runs);
  }, [path]);

  // Read when the log opens, and again whenever its latest run changes under it.
  useEffect(() => {
    if (!showLog) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loadRuns() sets state only after its request returns
    void loadRuns();
  }, [showLog, loadRuns, schedule.lastRunAt, schedule.lastStatus, schedule.running]);

  const toggle = async () => {
    const result = await apiPatch(path, { enabled: !schedule.enabled });
    if (!result.ok) notify({ level: "error", title: "That change did not save", body: result.reason, source: "TASKS" });
    onChanged();
  };

  const runNow = async () => {
    setStarting(true);
    const result = await apiPost(`${path}/run`, {});
    setStarting(false);
    if (result.ok) notify({ level: "info", title: `Running ${name}`, body: "Its result goes in the log when it finishes.", source: "TASKS" });
    else notify({ level: "error", title: `Could not run ${name}`, body: result.reason, source: "TASKS" });
    onChanged();
  };

  const remove = async () => {
    setConfirming(false);
    const result = await apiDelete(path);
    if (result.ok) notify({ level: "success", title: "Schedule deleted", body: name, source: "TASKS" });
    else notify({ level: "error", title: "Could not delete that schedule", body: result.reason, source: "TASKS" });
    onChanged();
  };

  const last = schedule.running ? null : (schedule.lastStatus as ScheduleRun["status"] | null | undefined) ?? null;
  const next = schedule.running
    ? "Running now"
    : !schedule.enabled
      ? "Paused"
      : schedule.nextDueAt ? `Next ${dueLabel(schedule.nextDueAt, now)} · ${clockTime(schedule.nextDueAt, now)}` : "";

  return (
    <li className={`os-sched${schedule.enabled ? "" : " paused"}${schedule.running ? " running" : ""}`}>
      <div className="os-sched-main">
        <span className={`os-dot ${schedule.running ? "accent live" : schedule.enabled ? "ok" : ""}`} aria-hidden="true" />
        <div className="os-sched-text">
          <strong className="os-sched-name">{name}</strong>
          <span className="os-sched-action">{schedule.actionLabel}</span>
          <span className="os-sched-when">
            <span className="os-chip">{schedule.cadenceLabel}</span>
            <span className={schedule.running ? "os-accent-text" : "os-faint"}>{next}</span>
          </span>
          {last ? (
            <span className="os-sched-last">
              <span className={`os-chip ${runTone[last] ?? ""}`}>{runWords[last] ?? last}</span>
              {schedule.lastRunAt && (last === "ok" || last === "failed") ? <span className="os-faint">{ago(schedule.lastRunAt, now)}</span> : null}
              {schedule.lastDetail ? <span className="os-sched-detail" title={schedule.lastDetail}>{schedule.lastDetail}</span> : null}
            </span>
          ) : !schedule.running && !schedule.lastStatus ? <span className="os-faint os-small">Has not run yet.</span> : null}
        </div>
        <div className="os-sched-actions">
          <button type="button" className="os-btn os-btn-ghost os-btn-icon os-btn-sm" disabled={schedule.running || starting}
            aria-label={`Run ${name} now`} data-tip="Run now" data-tip-pos="below" onClick={() => void runNow()}>
            <Icon name="play" size={14} />
          </button>
          <button type="button" className={`os-btn os-btn-ghost os-btn-icon os-btn-sm${showLog ? " on" : ""}`} aria-expanded={showLog}
            aria-label={`${showLog ? "Hide" : "Show"} the run log for ${name}`} data-tip="Run log" data-tip-pos="below" onClick={() => setShowLog(!showLog)}>
            <Icon name="log" size={14} />
          </button>
          <button type="button" className="os-btn os-btn-ghost os-btn-icon os-btn-sm" aria-label={`Delete ${name}`} data-tip="Delete" data-tip-pos="below"
            onClick={() => setConfirming(true)}>
            <Icon name="trash" size={14} />
          </button>
          <button type="button" role="switch" aria-checked={schedule.enabled} className="os-switch"
            aria-label={`${name} is ${schedule.enabled ? "on" : "paused"}`} data-tip={schedule.enabled ? "Pause" : "Turn on"} data-tip-pos="below"
            onClick={() => void toggle()}>
            <span className="os-switch-knob" />
          </button>
        </div>
      </div>
      {confirming ? (
        <div className="os-mem-confirm" role="group" aria-label={`Delete ${name}`}>
          <span>Delete this schedule? It stops running, and its run log goes with it.</span>
          <button type="button" className="os-btn os-btn-sm os-btn-danger" onClick={() => void remove()}>Delete</button>
          <button type="button" className="os-btn os-btn-sm" onClick={() => setConfirming(false)}>Keep</button>
        </div>
      ) : null}
      {showLog ? (
        <div className="os-sched-log">
          {runs === null ? <p className="os-faint os-small">Reading the log…</p>
            : runs.length === 0 ? <p className="os-faint os-small">It has not run yet. Every run is listed here, newest first.</p>
              : (
                <ol className="os-sched-runs">
                  {runs.map((run, index) => {
                    const live = index === 0 && schedule.running && run.status === "interrupted" && run.durationMs === undefined;
                    return (
                      <li key={`${run.at}-${index}`}>
                        <span className={`os-chip ${live ? "accent" : runTone[run.status]}`}>{live ? "Running" : runWords[run.status]}</span>
                        <time className="os-mono os-small" dateTime={run.at} title={new Date(run.at).toLocaleString()}>{clockTime(run.at, now)}</time>
                        <span className="os-sched-run-detail">{live ? "Started. The result goes here when it finishes." : run.detail ?? ""}</span>
                        <span className="os-mono os-small os-faint">{run.durationMs !== undefined ? formatDuration(run.durationMs) : ""}</span>
                      </li>
                    );
                  })}
                </ol>
              )}
        </div>
      ) : null}
    </li>
  );
}

type When = "daily" | "weekdays" | "interval";

function NewScheduleForm({ onDone }: { onDone: (created: boolean) => void }) {
  const { notify } = useNotify();
  const [name, setName] = useState("");
  const [what, setWhat] = useState<"ask" | "remind">("ask");
  const [text, setText] = useState("");
  const [when, setWhen] = useState<When>("daily");
  const [time, setTime] = useState("09:00");
  const [every, setEvery] = useState("30");
  const [unit, setUnit] = useState<"minutes" | "hours">("minutes");
  const [saving, setSaving] = useState(false);

  const cadence = cadenceFrom(when === "interval"
    ? { kind: "interval", every: Number(every), unit }
    : { kind: "daily", time, weekdaysOnly: when === "weekdays" });
  const ready = Boolean(name.trim() && text.trim() && cadence) && !saving;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!ready || !cadence) return;
    setSaving(true);
    const action = what === "ask" ? { kind: "ask", prompt: text.trim() } : { kind: "remind", text: text.trim() };
    const result = await apiPost<{ schedule: ScheduleView }>("/v1/schedules", { name: name.trim(), action, cadence });
    setSaving(false);
    if (!result.ok) {
      notify({ level: "error", title: "Could not save that schedule", body: result.reason, source: "TASKS" });
      return;
    }
    notify({ level: "success", title: "Scheduled", body: `${result.data.schedule.name}: ${result.data.schedule.cadenceLabel}`, source: "TASKS" });
    onDone(true);
  };

  return (
    <form className="os-sched-form" onSubmit={(event) => void submit(event)} aria-label="New schedule">
      <label className="os-field">
        <span className="os-label">Name</span>
        <input className="os-input" value={name} onChange={(event) => setName(event.target.value)} maxLength={120}
          placeholder={what === "ask" ? "Morning summary" : "Stretch break"} autoFocus />
      </label>
      <div className="os-field">
        <span className="os-label" id="sched-what">What it does</span>
        <div className="os-choice" role="radiogroup" aria-labelledby="sched-what">
          {([["ask", "Ask TRH AI"], ["remind", "Remind me"]] as const).map(([id, label]) => (
            <button key={id} type="button" role="radio" aria-checked={what === id} className={what === id ? "on" : ""} onClick={() => setWhat(id)}>{label}</button>
          ))}
        </div>
        <input className="os-input" value={text} onChange={(event) => setText(event.target.value)} maxLength={500}
          aria-label={what === "ask" ? "What to ask" : "What to remind you"}
          placeholder={what === "ask" ? "Summarise what changed in my workspace since yesterday" : "Stand up and stretch"} />
      </div>
      <div className="os-field">
        <span className="os-label" id="sched-when">When</span>
        <div className="os-sched-when-row">
          <div className="os-choice" role="radiogroup" aria-labelledby="sched-when">
            {([["daily", "Every day"], ["weekdays", "Weekdays"], ["interval", "Every…"]] as const).map(([id, label]) => (
              <button key={id} type="button" role="radio" aria-checked={when === id} className={when === id ? "on" : ""} onClick={() => setWhen(id)}>{label}</button>
            ))}
          </div>
          {when === "interval" ? (
            <>
              <input className="os-input os-sched-every" type="number" min={1} max={unit === "hours" ? 24 : 1440} value={every}
                onChange={(event) => setEvery(event.target.value)} aria-label="How often" />
              <div className="os-choice" role="radiogroup" aria-label="Unit">
                {(["minutes", "hours"] as const).map((id) => (
                  <button key={id} type="button" role="radio" aria-checked={unit === id} className={unit === id ? "on" : ""} onClick={() => setUnit(id)}>{id}</button>
                ))}
              </div>
            </>
          ) : (
            <input className="os-input os-sched-time" type="time" value={time} onChange={(event) => setTime(event.target.value)} aria-label="Time of day" />
          )}
        </div>
        {!cadence ? <span className="os-small os-warn-text">{when === "interval" ? "Somewhere from 1 minute to 24 hours." : "Pick a time of day."}</span> : null}
      </div>
      <p className="os-faint os-small os-sched-note">
        It runs on this PC while TRH AI is running. This window does not need to be open.{what === "ask" ? " Each answer is kept in the run log." : " It shows as a notification."}
      </p>
      <div className="os-sched-form-actions">
        <button type="submit" className="os-btn os-btn-primary" disabled={!ready}><Icon name="clock" size={15} />{saving ? "Saving…" : "Save schedule"}</button>
        <button type="button" className="os-btn" onClick={() => onDone(false)}>Cancel</button>
      </div>
    </form>
  );
}

function HistoryItem({ task, now, busy, onAskAgain, onRemoved }: {
  task: FinishedTask; now: Date; busy: boolean; onAskAgain: (request: string) => void; onRemoved: () => void;
}) {
  const { notify } = useNotify();
  const [open, setOpen] = useState(false);
  const took = between(task.startedAt, task.finishedAt);
  const type = taskTypeLabel(task.taskType);
  const title = taskTitle(task.request);
  const tools = toolTally(task.toolsUsed);

  const remove = async () => {
    const result = await apiDelete(`/v1/agent-tasks/history/${encodeURIComponent(task.id)}?sessionId=${sid()}`);
    if (!result.ok) notify({ level: "error", title: "Could not remove that", body: result.reason, source: "TASKS" });
    onRemoved();
  };

  return (
    <li className={`os-hist ${task.status}${open ? " open" : ""}`}>
      <button type="button" className="os-hist-row" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={`os-chip ${finishedTone[task.status]}`}>{finishedWords[task.status]}</span>
        <span className="os-hist-title">{title}</span>
        <span className="os-hist-meta">
          {type ? <span>{type}</span> : null}
          {task.steps.length ? <span>{task.steps.length} step{task.steps.length === 1 ? "" : "s"}</span> : null}
          {took !== null ? <span className="os-mono">{formatDuration(took)}</span> : null}
          <time dateTime={task.finishedAt} title={new Date(task.finishedAt).toLocaleString()}>{ago(task.finishedAt, now)}</time>
        </span>
        <Icon name="chevronDown" size={15} className="os-hist-chevron" />
      </button>
      {open ? (
        <div className="os-hist-body">
          {task.request !== title ? <p className="os-hist-request">{task.request}</p> : null}
          {task.result ? <div className="os-hist-result"><Markdown text={task.result} className="os-markdown" /></div> : null}
          {task.error ? <p className="os-hist-error"><Icon name="alert" size={14} />{task.error}</p> : null}
          {tools.length ? (
            <div className="os-hist-tools" aria-label="Tools it ran">
              {tools.map((tool) => <span key={tool.name} className="os-chip">{toolLabel(tool.name)}{tool.count > 1 ? ` ×${tool.count}` : ""}</span>)}
            </div>
          ) : null}
          {task.steps.length
            ? <StepList steps={task.steps} ended />
            : <p className="os-faint os-small">{tools.length ? "Its tools ran without reporting separate steps." : "Answered directly, without running a tool."}</p>}
          <div className="os-hist-actions">
            <button type="button" className="os-btn os-btn-sm" disabled={busy} onClick={() => onAskAgain(task.request)}>
              <Icon name="refresh" size={14} />Ask again
            </button>
            <button type="button" className="os-btn os-btn-sm os-btn-ghost" onClick={() => void remove()}>
              <Icon name="trash" size={14} />Remove from history
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

function TodoPanel() {
  const { tasks, setTasks } = useSystem();
  const { notify } = useNotify();
  const [draft, setDraft] = useState("");
  const open = tasks?.filter((task) => !task.done) ?? [];
  const done = tasks?.filter((task) => task.done) ?? [];

  const add = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const title = draft.trim();
    if (!title) return;
    const result = await apiPost<{ task: TaskItem }>("/v1/tasks", { sessionId: sessionId(), title });
    if (!result.ok) {
      notify({ level: "error", title: "Could not add that", body: result.reason, source: "TASKS" });
      return;
    }
    setDraft("");
    setTasks((prior) => [...(prior ?? []), result.data.task]);
  };

  const toggle = async (id: string, isDone: boolean) => {
    const result = await apiPatch<{ task: TaskItem }>(`/v1/tasks/${encodeURIComponent(id)}`, { sessionId: sessionId(), done: isDone });
    if (result.ok) setTasks((prior) => prior?.map((task) => (task.id === id ? result.data.task : task)) ?? null);
  };

  const remove = async (id: string) => {
    const result = await apiDelete(`/v1/tasks/${encodeURIComponent(id)}?sessionId=${sid()}`);
    if (result.ok) setTasks((prior) => prior?.filter((task) => task.id !== id) ?? null);
  };

  return (
    <section className="os-panel os-todo" aria-label="Your to-dos">
      <header className="os-panel-head">
        <h3 className="os-panel-title">Your to-dos</h3>
        <span className="os-faint os-small">{tasks === null ? "-" : `${open.length} open · ${done.length} done`}</span>
      </header>
      <div className="os-panel-body os-stack">
        <form className="os-todo-add" onSubmit={(event) => void add(event)}>
          <input className="os-input" value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={200}
            placeholder="Add a to-do" aria-label="Add a to-do" />
          <button type="submit" className="os-btn os-btn-primary os-btn-icon" aria-label="Add the to-do" disabled={!draft.trim()}>
            <Icon name="plus" size={16} />
          </button>
        </form>
        {tasks === null ? <p className="os-faint os-small">Reading the list…</p>
          : tasks.length === 0 ? <p className="os-faint os-small">Nothing on the list. Add one here, or ask TRH AI to add it.</p>
            : (
              <ul className="os-todo-list">
                {[...open, ...done].map((task) => (
                  <li key={task.id} className={task.done ? "done" : ""}>
                    <label className="os-todo-check">
                      <input type="checkbox" checked={task.done} onChange={(event) => void toggle(task.id, event.target.checked)} />
                      <span>{task.title}</span>
                    </label>
                    <button type="button" className="os-btn os-btn-ghost os-btn-icon os-btn-sm" aria-label={`Remove ${task.title}`}
                      onClick={() => void remove(task.id)}>
                      <Icon name="close" size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
      </div>
    </section>
  );
}

export function TasksView() {
  const { agentTasks, schedules, schedulePersistError, refresh } = useSystem();
  const { executionEvents, busy, send } = useAssistantState();
  const { go } = useNav();
  const { notify } = useNotify();
  const [history, setHistory] = useState<FinishedTask[] | null>(null);
  const [limit, setLimit] = useState<number | null>(null);
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [now, setNow] = useState(() => new Date());

  const polled = agentTasks?.[0] ?? null;
  const allSchedules = useMemo(() => schedules ?? [], [schedules]);
  const runningSchedules = allSchedules.filter((schedule) => schedule.running);
  const taskRunning = isRunningNow(polled, history);
  // The polled task, corrected by the history where the history knows better.
  const current = useMemo(() => (polled && polled.running && !taskRunning ? { ...polled, running: false } : polled), [polled, taskRunning]);
  const anyRunning = taskRunning || runningSchedules.length > 0;

  const loadHistory = useCallback(async () => {
    const result = await apiGet<{ history: FinishedTask[]; limit?: number }>(`/v1/agent-tasks/history?sessionId=${sid()}`);
    if (!result.ok) return;
    setHistory(result.data.history);
    if (typeof result.data.limit === "number") setLimit(result.data.limit);
  }, []);

  // Read on arrival, and again whenever the current task moves: finishing is
  // what puts a new entry in the history.
  const taskMoment = polled ? `${polled.id}:${polled.status}:${polled.running}` : "none";
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loadHistory() sets state only after its request returns
    void loadHistory();
  }, [loadHistory, taskMoment]);

  // When the history knew first, read everything else again now rather than
  // leave the header and the other workspaces a poll behind.
  const historyKnewFirst = Boolean(polled?.running) && !taskRunning;
  useEffect(() => {
    if (historyKnewFirst) void refresh();
  }, [historyKnewFirst, refresh]);

  // The clock behind "running for" and "in 12 min": every second while
  // something runs, every half minute otherwise.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), anyRunning ? 1000 : 30_000);
    return () => window.clearInterval(timer);
  }, [anyRunning]);

  const counts = useMemo(() => countWork(current, history ?? [], allSchedules), [current, history, allSchedules]);
  const shownHistory = useMemo(() => filterHistory(history ?? [], query, filter), [history, query, filter]);
  const shownSchedules = useMemo(() => filterSchedules(allSchedules, query), [allSchedules, query]);
  const nextUp = useMemo(() => orderSchedules(allSchedules).find((schedule) => schedule.enabled && !schedule.running && schedule.nextDueAt), [allSchedules]);
  const waiting = needsYou(current);

  const show = {
    running: filter === "running" || (filter === "all" && anyRunning),
    waiting: (filter === "all" || filter === "failed") && waiting && current !== null,
    scheduled: filter === "all" || filter === "scheduled",
    history: filter === "all" || filter === "done" || filter === "failed"
  };

  const toChat = (text: string) => {
    void send(text);
    go("chat");
  };

  const clearHistory = async () => {
    setConfirmClear(false);
    const result = await apiDelete(`/v1/agent-tasks/history?sessionId=${sid()}`);
    if (result.ok) notify({ level: "success", title: "History cleared", body: "Schedules and to-dos are untouched.", source: "TASKS" });
    else notify({ level: "error", title: "Could not clear the history", body: result.reason, source: "TASKS" });
    void loadHistory();
  };

  const enabledCount = allSchedules.filter((schedule) => schedule.enabled).length;

  return (
    <ViewFrame
      id="tasks"
      actions={(
        <>
          {counts.running > 0
            ? <span className="os-chip accent"><span className="os-dot accent live" aria-hidden="true" />{counts.running} running</span>
            : <span className="os-chip">Nothing running</span>}
          {nextUp?.nextDueAt ? (
            <span className="os-chip" title={new Date(nextUp.nextDueAt).toLocaleString()}>
              <Icon name="clock" size={13} />{nextUp.name || "Schedule"} {dueLabel(nextUp.nextDueAt, now)}
            </span>
          ) : null}
        </>
      )}
    >
      <div className="os-tasks-layout">
        <div className="os-tasks-main">
          <div className="os-tasks-toolbar">
            <label className="os-convos-search os-mem-search">
              <Icon name="search" size={15} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setQuery(""); }}
                placeholder="Search work and schedules" aria-label="Search work and schedules" />
            </label>
            <div className="os-choice" role="radiogroup" aria-label="Show">
              {filters.map((option) => (
                <button key={option.id} type="button" role="radio" aria-checked={filter === option.id} className={filter === option.id ? "on" : ""}
                  onClick={() => setFilter(option.id)}>
                  {option.label}{option.id === "all" ? null : <span className="os-faint"> {counts[option.id]}</span>}
                </button>
              ))}
            </div>
          </div>

          {show.running ? (
            <RunningNow task={taskRunning ? current : null} events={executionEvents} schedules={runningSchedules} now={now} onOpenChat={() => go("chat")} />
          ) : null}

          {show.waiting && current ? <WaitingOnYou task={current} busy={busy} onResume={() => toChat("continue")} /> : null}

          {show.scheduled ? (
            <section className="os-panel" aria-label="Scheduled">
              <header className="os-panel-head">
                <h3 className="os-panel-title">Scheduled</h3>
                <div className="os-panel-tools">
                  {allSchedules.length ? <span className="os-faint os-small">{enabledCount} on · {allSchedules.length - enabledCount} paused</span> : null}
                  <button type="button" className={`os-btn os-btn-sm${adding ? " on" : ""}`} aria-expanded={adding} onClick={() => setAdding(!adding)}>
                    <Icon name="plus" size={14} />New schedule
                  </button>
                </div>
              </header>
              <div className="os-panel-body os-stack">
                {schedulePersistError ? (
                  <p className="os-task-alert" role="alert">
                    <Icon name="alert" size={14} />Schedules cannot be saved to disk right now ({schedulePersistError}). They still run, but changes would be lost on a restart.
                  </p>
                ) : null}
                {adding ? <NewScheduleForm onDone={(created) => { setAdding(false); if (created) void refresh(); }} /> : null}
                {shownSchedules.length === 0 ? (
                  allSchedules.length === 0 ? (
                    adding ? null : (
                      <div className="os-empty">
                        <strong>Nothing scheduled</strong>
                        <p>Add one here, or tell TRH AI: &ldquo;remind me every day at 9 to stretch&rdquo;, or &ldquo;every weekday at 8am, summarise the build&rdquo;.</p>
                      </div>
                    )
                  ) : <p className="os-faint os-small">No schedule matches.</p>
                ) : (
                  <ul className="os-sched-list">
                    {shownSchedules.map((schedule) => <ScheduleRow key={schedule.id} schedule={schedule} now={now} onChanged={() => void refresh()} />)}
                  </ul>
                )}
              </div>
            </section>
          ) : null}

          {show.history ? (
            <section className="os-panel" aria-label="History">
              <header className="os-panel-head">
                <h3 className="os-panel-title">History</h3>
                <div className="os-panel-tools">
                  {history && limit ? <span className="os-faint os-small">{history.length} of {limit} kept · the oldest make room</span> : null}
                  {confirmClear ? (
                    <>
                      <span className="os-faint os-small">Clear the whole history?</span>
                      <button type="button" className="os-btn os-btn-sm os-btn-danger" onClick={() => void clearHistory()}>Clear</button>
                      <button type="button" className="os-btn os-btn-sm" onClick={() => setConfirmClear(false)}>Keep</button>
                    </>
                  ) : (
                    <button type="button" className="os-btn os-btn-sm os-btn-ghost" disabled={!history?.length} onClick={() => setConfirmClear(true)}>
                      <Icon name="trash" size={14} />Clear history
                    </button>
                  )}
                </div>
              </header>
              <div className="os-panel-body">
                {history === null ? <p className="os-faint">Reading the history…</p>
                  : shownHistory.length === 0 ? (
                    <div className="os-empty">
                      <strong>{history.length === 0 ? "Nothing finished yet" : filter === "failed" ? "Nothing failed" : filter === "done" ? "Nothing finished yet" : "Nothing matches"}</strong>
                      <p>{history.length === 0
                        ? "Work TRH AI carries out - builds, fixes, files written, checks run - is kept here when it ends, with every step it took."
                        : query ? "Try fewer words." : "Nothing here under this filter."}</p>
                    </div>
                  ) : (
                    <ul className="os-hist-list">
                      {shownHistory.map((task) => (
                        <HistoryItem key={task.id} task={task} now={now} busy={busy} onAskAgain={toChat} onRemoved={() => void loadHistory()} />
                      ))}
                    </ul>
                  )}
              </div>
            </section>
          ) : null}
        </div>

        <aside className="os-tasks-side">
          <TodoPanel />
        </aside>
      </div>
    </ViewFrame>
  );
}
