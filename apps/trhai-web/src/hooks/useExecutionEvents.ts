"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, sessionId } from "../lib/api";

// The execution log, read once for the whole screen.
//
// This polling used to live inside ExecutionTrace, which was fine while that
// panel was the only thing showing it. The main screen now has its own live
// view of the same events, and two components each running their own interval
// would ask the API for identical data twice as often - and could disagree for
// the few hundred milliseconds between their ticks, which is exactly the kind
// of "screen contradicting itself" this interface is built to avoid.
//
// One reader, one set of events, every view showing the same thing.

export type ExecutionEvent = {
  id: string;
  kind: "plan" | "create" | "write" | "install" | "test" | "verify" | "launch" | "command" | "read";
  label: string;
  status: "running" | "ok" | "failed" | "skipped";
  detail?: string;
  artifact?: string;
  startedAt: string;
  durationMs?: number;
};

/** How often to re-read while work is in flight. */
const activeMs = 400;
/** And when nothing is running - slow enough to be nearly free. */
const idleMs = 2500;

export function useExecutionEvents(busy: boolean) {
  const [events, setEvents] = useState<ExecutionEvent[]>([]);

  const read = useCallback(async () => {
    const result = await apiGet<{ events: ExecutionEvent[] }>(
      `/v1/execution?sessionId=${encodeURIComponent(sessionId())}`
    );
    if (result.ok) setEvents(result.data.events);
  }, []);

  // Polls quickly only while something is actually running. A trace that asked
  // four times a second forever would be a cost paid permanently for a view
  // that is empty most of the time.
  const anyRunning = events.some((event) => event.status === "running");

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- polls the execution log - this state comes from outside React
    void read();
    const period = busy || anyRunning ? activeMs : idleMs;
    const poller = window.setInterval(() => void read(), period);
    return () => window.clearInterval(poller);
  }, [read, busy, anyRunning]);

  return events;
}

/**
 * The step being worked on right now, or null.
 *
 * "Right now" means a row the API has opened and not yet closed - not the last
 * row, which after a finished turn is a completed step and would leave the
 * screen claiming work that ended minutes ago.
 */
export function runningEvent(events: ExecutionEvent[]): ExecutionEvent | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].status === "running") return events[index];
  }
  return null;
}

/**
 * How long a step has taken, as text.
 *
 * A finished step reports the duration the API measured - the screen repeats
 * that number rather than producing its own. A running one is counted forward
 * from its own start, so the figure is the real age of the work and never an
 * estimate of how long is left. Nothing here fills a bar toward a total,
 * because no part of this knows what the total is.
 */
export function elapsed(event: ExecutionEvent, now: number): string {
  const ms = event.durationMs ?? Math.max(0, now - Date.parse(event.startedAt));
  if (!Number.isFinite(ms)) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Which steps the compact readout shows.
 *
 * The newest few, because the stage has a core on it and the full history
 * belongs in the rail. The one exception is the step actually in flight: a slow
 * install can be pushed off the end by quicker steps finishing after it, and a
 * readout of what is happening now that has scrolled past the running step is
 * showing everything except the thing it exists for. It is pinned to the top of
 * the list in that case, and the oldest visible row gives up its place.
 */
export function visibleSteps(events: ExecutionEvent[], limit: number): ExecutionEvent[] {
  const tail = events.slice(-limit);
  const current = runningEvent(events);
  if (!current || tail.includes(current)) return tail;
  return [current, ...tail.slice(1)];
}
