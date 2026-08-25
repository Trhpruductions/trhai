"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "../lib/api";
import "./commands.css";

// The switch that lets TRHAI run commands on this machine, and the log of
// what it has actually run.
//
// Both halves matter. Everything else the assistant can do is bounded by the
// workspace; a command is not, so the control for it belongs on the front
// screen rather than buried in settings — if it is on, that should be visible
// without going looking.
//
// The log is not decoration either. An assistant that can act on your machine
// and does not show you what it did is asking to be trusted on its own
// account of events, which is exactly the thing this app refuses to do
// everywhere else.

type CommandRun = {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  startedAt: string;
};

type CommandState = { armed: boolean; armedUntil: string | null; history: CommandRun[] };

function remaining(until: string | null, now: number): string {
  if (!until) return "";
  const seconds = Math.max(0, Math.round((new Date(until).getTime() - now) / 1000));
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m left`;
  return `${seconds}s left`;
}

function outcomeOf(run: CommandRun): { word: string; tone: string } {
  if (run.timedOut) return { word: "timed out", tone: "warn" };
  if (run.exitCode === 0) return { word: "ok", tone: "ok" };
  if (run.exitCode === null) return { word: "did not start", tone: "danger" };
  return { word: `exit ${run.exitCode}`, tone: "danger" };
}

export function CommandAccess() {
  const [state, setState] = useState<CommandState | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  // Ticks so the countdown is live rather than frozen at whatever the last
  // poll happened to catch.
  const [now, setNow] = useState<number | null>(null);

  const read = useCallback(async () => {
    const result = await apiGet<CommandState>("/v1/commands");
    if (result.ok) setState(result.data);
  }, []);

  useEffect(() => {
    setNow(Date.now());
    void read();
    const poller = window.setInterval(() => { setNow(Date.now()); void read(); }, 3000);
    return () => window.clearInterval(poller);
  }, [read]);

  async function toggle() {
    if (busy || !state) return;
    setBusy(true);
    try {
      await apiPost(state.armed ? "/v1/commands/disarm" : "/v1/commands/arm", {});
      await read();
    } finally {
      setBusy(false);
    }
  }

  const armed = state?.armed ?? false;

  return (
    <section className={`hud-panel cmd${armed ? " cmd-armed" : ""}`}>
      <div className="cmd-head">
        <span className="hud-label">Machine control</span>
        {armed && now !== null ? (
          <span className="cmd-left">{remaining(state?.armedUntil ?? null, now)}</span>
        ) : null}
      </div>

      <p className="faint cmd-what">
        {armed
          ? "TRHAI can run commands on this machine right now. It switches off on its own shortly, or now if you say so."
          : "Off. TRHAI can read and write in its workspace, but cannot run anything on this machine."}
      </p>

      <button
        type="button"
        className={`cmd-toggle${armed ? " on" : ""}`}
        disabled={busy || state === null}
        aria-pressed={armed}
        onClick={() => void toggle()}
      >
        {busy ? "…" : armed ? "Switch off" : "Let TRHAI use this machine"}
      </button>

      {state && state.history.length > 0 ? (
        <div className="cmd-log">
          <span className="hud-label">Ran</span>
          <ul>
            {state.history.slice(0, 6).map((run, index) => {
              const outcome = outcomeOf(run);
              const id = `${run.startedAt}-${index}`;
              const isOpen = open === id;
              return (
                <li key={id} className="cmd-run">
                  <button
                    type="button"
                    className="cmd-run-head"
                    aria-expanded={isOpen}
                    onClick={() => setOpen(isOpen ? null : id)}
                  >
                    <code className="cmd-text" title={run.command}>{run.command}</code>
                    <span className={`cmd-outcome ${outcome.tone}`}>{outcome.word}</span>
                  </button>
                  {/* The real output, not a summary of it. A log you cannot
                      open is a claim that something happened. */}
                  {isOpen ? (
                    <pre className="cmd-output">
                      {(run.stdout + (run.stderr ? `\n${run.stderr}` : "")).trim() || "(printed nothing)"}
                    </pre>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
