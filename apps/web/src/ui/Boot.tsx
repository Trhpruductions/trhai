import { useEffect, useState } from "react";
import "./boot.css";

// The wake-up sequence.
//
// Every line here appears at the moment that check actually completes, and
// carries what it found. It is not a timed animation dressed up as one: a slow
// service genuinely takes longer to report, a missing model genuinely says so,
// and if something never comes up its line stays pending rather than ticking
// over to a reassuring green.
//
// That is the whole point. A staged sequence on a timer would look identical
// on a machine where nothing is running, which would make it a lie told once
// per launch.

export type CheckState = "pending" | "ok" | "absent" | "failed";

export type BootCheck = {
  label: string;
  state: CheckState;
  /** What the check actually found. Absent while pending. */
  detail?: string;
};

const marks: Record<CheckState, string> = {
  pending: "·",
  ok: "✓",
  absent: "—",
  failed: "×"
};

/**
 * Shown until every check has settled, then for a moment longer.
 *
 * It disappears on its own because it is a report on starting up, and a report
 * that stays on screen after the thing it describes is finished becomes
 * furniture.
 */
export function Boot({ checks, onDone }: { checks: BootCheck[]; onDone: () => void }) {
  const settled = checks.every((check) => check.state !== "pending");
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (!settled) return;

    // Long enough to read the last line that just landed, short enough that it
    // never feels like a splash screen being waited out.
    const hold = window.setTimeout(() => setLeaving(true), 700);
    const finish = window.setTimeout(onDone, 1100);

    return () => { window.clearTimeout(hold); window.clearTimeout(finish); };
  }, [settled, onDone]);

  return (
    <div className={`boot${leaving ? " boot-leaving" : ""}`} role="status" aria-live="polite">
      <span className="boot-title">Vexora</span>

      <ul className="boot-checks">
        {checks.map((check) => (
          <li key={check.label} className={`boot-check boot-${check.state}`}>
            <span className="boot-mark" aria-hidden="true">{marks[check.state]}</span>
            <span className="boot-label">{check.label}</span>
            <span className="boot-detail mono">
              {check.state === "pending" ? "…" : check.detail ?? ""}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
