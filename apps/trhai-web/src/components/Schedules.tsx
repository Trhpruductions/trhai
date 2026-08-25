"use client";

import { useCallback, useEffect, useState } from "react";
import { apiDelete, apiGet, apiPatch, apiPost } from "../lib/api";
import "./schedules.css";

// Creating and managing scheduled work.
//
// The schedules themselves run in the API process (see scheduler.ts), which
// is what makes a time on this screen a statement about what the machine does
// rather than a picture of one. This is only the way in — every field here
// maps to something the scheduler actually reads.
//
// Each row shows what a schedule last *did*, not just what it intends to do.
// A panel of next-run times with no record of past ones cannot be checked,
// and an automation nobody can check is one nobody should trust.

type Cadence =
  | { kind: "daily"; minuteOfDay: number }
  | { kind: "interval"; minutes: number };

type ScheduleAction = { kind: "ask"; prompt: string } | { kind: "flow" };

type Schedule = {
  id: string;
  name: string;
  prompt: string;
  action: ScheduleAction;
  actionLabel: string;
  cadence: Cadence;
  cadenceLabel: string;
  enabled: boolean;
  nextDueAt: string;
  lastRunAt: string | null;
  lastStatus: "ok" | "failed" | "missed" | null;
  lastDetail: string | null;
};

/** The interval options offered. Anything faster is a busy loop. */
const intervalChoices = [15, 30, 60, 180, 360, 720] as const;

function intervalLabel(minutes: number): string {
  if (minutes === 60) return "Every hour";
  if (minutes % 60 === 0) return `Every ${minutes / 60} hours`;
  return `Every ${minutes} minutes`;
}

function whenText(schedule: Schedule): string {
  if (schedule.lastStatus === null) return "Not run yet";
  if (schedule.lastStatus === "missed") return "Missed — the machine was off";
  if (schedule.lastStatus === "failed") return "Last run failed";
  return schedule.lastRunAt
    ? `Last ran ${new Date(schedule.lastRunAt).toLocaleString(undefined, {
        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
      })}`
    : "Ran";
}

export function Schedules() {
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [kind, setKind] = useState<"daily" | "interval">("daily");
  const [time, setTime] = useState("09:00");
  const [minutes, setMinutes] = useState<number>(60);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // What the schedule does. Only offered as a choice when there is actually a
  // flow to run — a picker whose second option does nothing is worse than no
  // picker, and this way the common case needs no decision at all.
  const [doWhat, setDoWhat] = useState<"ask" | "flow">("ask");
  const [flowName, setFlowName] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await apiGet<{ schedules: Schedule[] }>("/v1/schedules");
    // A failed read leaves the list null rather than showing an empty one:
    // "nothing scheduled" and "could not ask" are different facts.
    if (result.ok) setSchedules(result.data.schedules);
    else setNote(result.reason);
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Whether a flow exists at all, which decides whether running one is even
  // offered. Read once; the automation editor above keeps the server copy in
  // step on its own.
  useEffect(() => {
    let cancelled = false;
    void apiGet<{ flow: { name: string } | null }>("/v1/flow").then((result) => {
      if (!cancelled && result.ok) setFlowName(result.data.flow?.name ?? null);
    });
    return () => { cancelled = true; };
  }, []);

  function cadenceFromForm(): Cadence {
    if (kind === "interval") return { kind: "interval", minutes };
    const [hours, mins] = time.split(":").map(Number);
    return { kind: "daily", minuteOfDay: (hours || 0) * 60 + (mins || 0) };
  }

  async function create() {
    // A flow schedule needs no prompt — the flow is the instruction.
    if (!name.trim() || busy) return;
    if (doWhat === "ask" && !prompt.trim()) return;
    setBusy(true);
    setNote(null);
    try {
      const result = await apiPost<{ schedule: Schedule }>("/v1/schedules", {
        name,
        action: doWhat === "flow" ? { kind: "flow" } : { kind: "ask", prompt },
        cadence: cadenceFromForm()
      });
      if (!result.ok) {
        setNote(result.reason);
        return;
      }
      setName("");
      setPrompt("");
      await load();
      setNote(`Scheduled "${result.data.schedule.name}" · ${result.data.schedule.cadenceLabel}`);
    } finally {
      setBusy(false);
    }
  }

  async function toggle(schedule: Schedule) {
    // Re-read rather than assuming: the server recomputes the next due time
    // when a schedule is switched back on, and guessing it here would show a
    // time the scheduler does not agree with.
    const result = await apiPatch(`/v1/schedules/${schedule.id}`, { enabled: !schedule.enabled });
    if (result.ok) await load();
    else setNote(result.reason);
  }

  async function remove(schedule: Schedule) {
    if (!window.confirm(`Delete "${schedule.name}"? This cannot be undone.`)) return;
    const result = await apiDelete(`/v1/schedules/${schedule.id}`);
    if (result.ok) await load();
    else setNote(result.reason);
  }

  return (
    <section className="schedules">
      <header className="schedules-head">
        <h2>Schedules</h2>
        <p className="muted">
          These run in the local API process, so they fire whether or not this page is open —
          but only while that service is running. Each one asks TRHAI something on a timer and
          keeps the answer.
        </p>
      </header>

      <div className="panel schedules-form">
        <div className="schedules-row">
          <label className="schedules-field schedules-grow">
            <span className="hud-label">Name</span>
            <input className="field" value={name} placeholder="Daily summary"
              onChange={(event) => setName(event.target.value)} />
          </label>

          <label className="schedules-field">
            <span className="hud-label">When</span>
            <select className="field" value={kind}
              onChange={(event) => setKind(event.target.value === "interval" ? "interval" : "daily")}>
              <option value="daily">Every day at…</option>
              <option value="interval">Every…</option>
            </select>
          </label>

          {kind === "daily" ? (
            <label className="schedules-field">
              <span className="hud-label">Time</span>
              <input className="field" type="time" value={time}
                onChange={(event) => setTime(event.target.value)} />
            </label>
          ) : (
            <label className="schedules-field">
              <span className="hud-label">Interval</span>
              <select className="field" value={minutes}
                onChange={(event) => setMinutes(Number(event.target.value))}>
                {intervalChoices.map((choice) => (
                  <option key={choice} value={choice}>{intervalLabel(choice)}</option>
                ))}
              </select>
            </label>
          )}
        </div>

        {flowName ? (
          <label className="schedules-field">
            <span className="hud-label">Do what</span>
            <select className="field" value={doWhat}
              onChange={(event) => setDoWhat(event.target.value === "flow" ? "flow" : "ask")}>
              <option value="ask">Ask TRHAI something</option>
              <option value="flow">Run the saved flow ({flowName})</option>
            </select>
          </label>
        ) : null}

        {doWhat === "ask" ? (
          <label className="schedules-field">
            <span className="hud-label">Ask</span>
            <input className="field" value={prompt} placeholder="Summarise what changed today"
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") void create(); }} />
          </label>
        ) : (
          <p className="faint schedules-note">
            Runs every step of “{flowName}”. Steps needing the desktop bridge or credentials this
            build does not carry are skipped and say so, exactly as they do when run by hand.
          </p>
        )}

        <div className="schedules-row">
          <button type="button" className="btn btn-primary btn-sm"
            disabled={busy || !name.trim() || (doWhat === "ask" && !prompt.trim())} onClick={() => void create()}>
            {busy ? "Adding…" : "Add schedule"}
          </button>
          {note ? <span className="faint schedules-note">{note}</span> : null}
        </div>
      </div>

      {schedules === null ? (
        <p className="faint">Reading schedules…</p>
      ) : schedules.length === 0 ? (
        <p className="faint">Nothing scheduled yet.</p>
      ) : (
        <ul className="schedules-list">
          {schedules.map((schedule) => (
            <li key={schedule.id} className={`panel schedules-item${schedule.enabled ? "" : " off"}`}>
              <div className="schedules-item-body">
                <div className="schedules-item-head">
                  <b>{schedule.name}</b>
                  <span className="chip">{schedule.cadenceLabel}</span>
                </div>
                <p className="faint schedules-prompt">{schedule.actionLabel}</p>
                <p className={`schedules-last${schedule.lastStatus === "failed" ? " danger" : ""}`}>
                  {whenText(schedule)}
                  {schedule.enabled ? (
                    <> · next {new Date(schedule.nextDueAt).toLocaleString(undefined, {
                      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
                    })}</>
                  ) : " · paused"}
                </p>
                {/* What it actually produced, when it produced something. */}
                {schedule.lastDetail ? (
                  <p className="faint schedules-detail">{schedule.lastDetail}</p>
                ) : null}
              </div>

              <div className="schedules-item-actions">
                <button
                  type="button"
                  className={`schedules-toggle${schedule.enabled ? " on" : ""}`}
                  aria-pressed={schedule.enabled}
                  aria-label={`${schedule.enabled ? "Pause" : "Resume"} ${schedule.name}`}
                  onClick={() => void toggle(schedule)}
                >
                  <span className="schedules-knob" />
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void remove(schedule)}>
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
