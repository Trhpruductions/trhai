"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, sessionId } from "../lib/api";
import "./trace.css";

// What the assistant is actually doing, step by step, while it does it.
//
// The screen could already say *that* it was working — the core moves, a tool
// name appears in the status line — but not what the work consisted of. Ask
// for an app and you watched a spinner for thirty seconds and then read a
// paragraph claiming a folder existed. The claim was true; you had no way to
// watch it become true, and no way to tell a build that wrote nine files from
// one that wrote two and stopped.
//
// Every row here is an event the API emitted at the moment the thing
// happened. Nothing is predicted: there is no "installing…" row until an
// install has actually started, and its outcome is written when the install
// actually returns. A list of steps drawn in advance would be a plan wearing
// a progress bar, which is the failure this whole interface is built against.

type ExecutionEvent = {
  id: string;
  kind: "plan" | "create" | "write" | "install" | "test" | "verify" | "launch" | "command" | "read";
  label: string;
  status: "running" | "ok" | "failed" | "skipped";
  detail?: string;
  artifact?: string;
  startedAt: string;
  durationMs?: number;
};

/** How often the trace re-reads while work is in flight. */
const activeMs = 400;
/** And when nothing is running — slow enough to be nearly free. */
const idleMs = 2500;

const glyphs: Record<ExecutionEvent["kind"], string> = {
  plan: "◇", create: "✦", write: "▣", install: "⤓",
  test: "◎", verify: "✓", launch: "▶", command: "›", read: "▥"
};

function duration(ms: number | undefined): string {
  if (ms === undefined) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function ExecutionTrace({ busy }: { busy: boolean }) {
  const [events, setEvents] = useState<ExecutionEvent[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  const read = useCallback(async () => {
    const result = await apiGet<{ events: ExecutionEvent[] }>(
      `/v1/execution?sessionId=${encodeURIComponent(sessionId())}`
    );
    if (result.ok) setEvents(result.data.events);
  }, []);

  // Polls quickly only while something is actually running. A trace that
  // asked four times a second forever would be a cost paid permanently for a
  // panel that is empty most of the time.
  const anyRunning = events.some((event) => event.status === "running");
  useEffect(() => {
    void read();
    const period = busy || anyRunning ? activeMs : idleMs;
    const poller = window.setInterval(() => void read(), period);
    return () => window.clearInterval(poller);
  }, [read, busy, anyRunning]);

  if (events.length === 0) {
    return (
      <section className="hud-panel">
        <span className="hud-label">Execution</span>
        <p className="faint trace-empty">
          Steps appear here as they happen — files written, checks run, commands executed.
        </p>
      </section>
    );
  }

  return (
    <section className="hud-panel">
      <div className="trace-head">
        <span className="hud-label">Execution</span>
        <span className="faint trace-count">{events.length} step{events.length === 1 ? "" : "s"}</span>
      </div>

      <ol className="trace">
        {events.map((event) => {
          const isOpen = open === event.id;
          const hasDetail = Boolean(event.detail);
          return (
            <li key={event.id} className={`trace-step trace-${event.status}`}>
              <button
                type="button"
                className="trace-row"
                aria-expanded={hasDetail ? isOpen : undefined}
                onClick={() => hasDetail && setOpen(isOpen ? null : event.id)}
              >
                <span className="trace-glyph" aria-hidden="true">{glyphs[event.kind]}</span>
                <span className="trace-label" title={event.label}>{event.label}</span>
                {/* A running step shows no duration, because it does not have
                    one yet. Showing a number that keeps climbing would imply
                    it had finished at each moment it was read. */}
                <span className="trace-meta">
                  {event.status === "running" ? "running" : duration(event.durationMs)}
                </span>
              </button>

              {isOpen && event.detail ? (
                <pre className="trace-detail">{event.detail}</pre>
              ) : null}
              {event.artifact ? (
                <span className="trace-artifact mono" title={event.artifact}>{event.artifact}</span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
