// What the assistant actually did, in order, as it happens.
//
// The interface could already say *that* it was working — the core moves, a
// tool name appears — but not what the work consisted of. Ask for an app and
// you watched a spinner for thirty seconds, then got a paragraph claiming a
// folder existed. The claim was true, but you had no way to see it become
// true, and no way to tell a build that wrote nine files from one that wrote
// two and gave up.
//
// Every event here is emitted at the moment the thing happens, by the code
// that does it. Nothing is narrated in advance and nothing is inferred
// afterwards: there is no "installing…" event unless an install actually
// started, and its outcome is written when the install actually returns. A
// trace that predicted the steps would be a plan wearing a progress bar.
//
// Deliberately not the same as taskStore. That records one request per
// session and whether it succeeded; this records the individual steps inside
// it, which is what makes a long build watchable rather than merely pending.

/** The stages the backlog names, plus the ones the work actually produces. */
export type ExecutionKind =
  | "plan" | "create" | "write" | "install" | "test" | "verify" | "launch" | "command" | "read";

export type ExecutionStatus = "running" | "ok" | "failed" | "skipped";

export type ExecutionEvent = {
  id: string;
  kind: ExecutionKind;
  /** What is happening, in plain words. Shown as-is. */
  label: string;
  status: ExecutionStatus;
  /** The real result: a path written, output produced, a reason it failed. */
  detail?: string;
  /** A file or folder this produced, when it produced one. */
  artifact?: string;
  startedAt: string;
  /** Absent while still running. */
  endedAt?: string;
  /** Milliseconds, once finished. Measured, never estimated. */
  durationMs?: number;
};

/** Per session, so one browser's trace is not another's. */
const logs = new Map<string, ExecutionEvent[]>();

/**
 * How many events a session keeps.
 *
 * A long session would otherwise grow without bound in a process that never
 * restarts. Old events are dropped from the front, so what you keep is what
 * just happened, which is what a live trace is for.
 */
export const maxEvents = 200;

let counter = 0;

function nextId(): string {
  counter += 1;
  return `x${counter}`;
}

/**
 * Record that something has started, and return its id.
 *
 * Two calls rather than one on purpose. A step that is still running is a
 * real state worth showing — it is the difference between "this is taking a
 * while" and "this has stopped" — and it cannot be shown by an API that only
 * reports finished work.
 */
export function beginEvent(
  sessionId: string | undefined,
  kind: ExecutionKind,
  label: string,
  now: Date = new Date()
): string | null {
  if (!sessionId) return null;

  const event: ExecutionEvent = {
    id: nextId(),
    kind,
    label,
    status: "running",
    startedAt: now.toISOString()
  };

  const existing = logs.get(sessionId) ?? [];
  existing.push(event);
  if (existing.length > maxEvents) existing.splice(0, existing.length - maxEvents);
  logs.set(sessionId, existing);
  return event.id;
}

/** Close an event with what actually happened. */
export function endEvent(
  sessionId: string | undefined,
  id: string | null,
  status: Exclude<ExecutionStatus, "running">,
  detail?: string,
  artifact?: string,
  now: Date = new Date()
): void {
  if (!sessionId || !id) return;

  const event = logs.get(sessionId)?.find((entry) => entry.id === id);
  if (!event) return;

  event.status = status;
  event.endedAt = now.toISOString();
  event.durationMs = Math.max(0, now.getTime() - new Date(event.startedAt).getTime());
  if (detail !== undefined) event.detail = detail;
  if (artifact !== undefined) event.artifact = artifact;
}

/** A step that began and finished in one go, with a real outcome. */
export function recordEvent(
  sessionId: string | undefined,
  kind: ExecutionKind,
  label: string,
  status: Exclude<ExecutionStatus, "running">,
  detail?: string,
  artifact?: string
): void {
  const id = beginEvent(sessionId, kind, label);
  endEvent(sessionId, id, status, detail, artifact);
}

export function listEvents(sessionId: string | undefined): ExecutionEvent[] {
  if (!sessionId) return [];
  // Copies, so a caller cannot rewrite the record of what happened.
  return (logs.get(sessionId) ?? []).map((event) => ({ ...event }));
}

/**
 * Clear a session's trace.
 *
 * Called when a new request starts, so the panel shows this piece of work
 * rather than everything since the browser opened. What came before is
 * genuinely finished; keeping it would make the newest step hard to find at
 * the moment it matters most.
 */
export function clearEvents(sessionId: string | undefined): void {
  if (sessionId) logs.delete(sessionId);
}

export function resetExecutionLog(): void {
  logs.clear();
  counter = 0;
}
