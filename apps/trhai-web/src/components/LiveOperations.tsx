"use client";

import { elapsed, visibleSteps, type ExecutionEvent } from "../hooks/useExecutionEvents";
import "./liveops.css";

// What TRHAI is doing, on the screen it is doing it on.
//
// The stage could say *that* work was happening - the core changes state, a
// tool name appears under the title - but the steps themselves were only in
// the execution panel, in a rail that is closed by default. So the main screen
// showed a machine that was clearly busy and would not say with what.
//
// Every row here is an event the API emitted at the moment the thing happened.
// Nothing is predicted and nothing is drawn ahead of itself: a step appears
// when it starts, and its outcome is written when it actually returns. The
// elapsed figure on a running step is its real start time counted forward, and
// on a finished one it is the duration the API measured - never an estimate,
// and never a bar filling toward a number nobody knows yet.
//
// The compact form is deliberate. This sits under a core that is the point of
// the screen, so it shows the work in flight and the few steps behind it, and
// leaves the full history to the rail.

/** How many finished steps stay on screen behind the running one. */
const tailLength = 4;

const glyphs: Record<ExecutionEvent["kind"], string> = {
  plan: "◇", create: "✦", write: "▣", install: "⤓",
  test: "◎", verify: "✓", launch: "▶", command: "›", read: "▥"
};


export function LiveOperations({ events, now }: { events: ExecutionEvent[]; now: number }) {
  if (events.length === 0) return null;

  // Counted over the whole log, not the visible tail.
  //
  // A step that takes a while - an install, a long command - keeps running
  // while quicker steps finish after it, and once it fell off the end of the
  // tail the header went back to reporting a step count. The panel stopped
  // saying anything was running at exactly the moment something slow was.
  const running = events.filter((event) => event.status === "running").length;

  // Newest last in the log; the interesting end is the newest few, with the
  // step actually in flight kept in view. See visibleSteps.
  const shown = visibleSteps(events, tailLength + 1);

  return (
    <section className="liveops" aria-live="polite" aria-label="What TRHAI is doing">
      <header className="liveops-head">
        <span className="liveops-title">OPERATIONS</span>
        <span className="liveops-rule" aria-hidden="true" />
        <span className="liveops-count">
          {running > 0 ? `${running} RUNNING` : `${events.length} STEP${events.length === 1 ? "" : "S"}`}
        </span>
      </header>

      <ol className="liveops-list">
        {shown.map((event) => (
          <li key={event.id} className={`liveops-row liveops-${event.status}`}>
            <span className="liveops-glyph" aria-hidden="true">{glyphs[event.kind]}</span>
            <span className="liveops-label">
              {event.label}
              {event.detail ? <span className="liveops-detail"> · {event.detail}</span> : null}
            </span>
            <span className="liveops-time">{elapsed(event, now)}</span>
            {/* The status mark is written from what the API reported. A running
                step gets a moving mark because it genuinely has not finished;
                it is not a progress bar, because nothing here knows how far
                along the work is. */}
            <span className={`liveops-mark liveops-mark-${event.status}`} aria-hidden="true">
              {event.status === "running" ? "" : event.status === "ok" ? "✓"
                : event.status === "failed" ? "✕" : "–"}
            </span>
            <span className="sr-only">{event.status}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
