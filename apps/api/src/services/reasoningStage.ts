// Which part of the pipeline a request is actually in.
//
// The interface could say THINKING for thirty seconds, which is true and
// tells you almost nothing — it looks the same whether the assistant is
// reading your notes, writing files, or waiting on a model that has stalled.
// A stage says which of those it is.
//
// The rule that makes this worth having: every transition is set by the code
// that reaches that point, not by a timer walking through a list. There is no
// "verifying" stage unless verification has genuinely started. A sequence
// that advanced on its own would be an animation with stage names written on
// it, and it would look identical to a real one right up until the moment it
// mattered — a request that hung would keep marching confidently through
// "building" and "verifying" while nothing happened at all.
//
// Durations are measured for the same reason. The spec asks for stage
// telemetry; a stage that reports how long it actually took is the only kind
// worth measuring.

export type Stage =
  | "understanding"
  | "gathering"
  | "planning"
  | "building"
  | "verifying"
  | "answering";

/** What each stage is called on screen. */
export const stageLabels: Record<Stage, string> = {
  understanding: "Understanding",
  gathering: "Gathering context",
  planning: "Planning",
  building: "Building",
  verifying: "Verifying",
  answering: "Answering"
};

export type StageRecord = {
  stage: Stage;
  startedAt: number;
  /** Stages already finished this turn, with how long each really took. */
  completed: Array<{ stage: Stage; durationMs: number }>;
};

const current = new Map<string, StageRecord>();

/**
 * Move a session into a stage, closing the previous one with its real
 * duration.
 *
 * Repeating the stage it is already in does nothing, so a tool that runs
 * three searches in a row does not produce three "gathering" entries each
 * timed from the last one — it is one stage that lasted as long as it lasted.
 */
export function enterStage(sessionId: string | undefined, stage: Stage, now = Date.now()): void {
  if (!sessionId) return;

  const existing = current.get(sessionId);
  if (existing?.stage === stage) return;

  const completed = existing
    ? [...existing.completed, { stage: existing.stage, durationMs: Math.max(0, now - existing.startedAt) }]
    : [];

  current.set(sessionId, { stage, startedAt: now, completed });
}

export function getStage(sessionId: string | undefined): StageRecord | null {
  if (!sessionId) return null;
  const record = current.get(sessionId);
  // A copy: a caller reading the stage must not be able to edit the record of
  // what actually happened.
  return record ? { ...record, completed: [...record.completed] } : null;
}

/**
 * End the turn, closing the final stage.
 *
 * Returns the full sequence with real durations — the telemetry the spec
 * asks for, and the only version of it that means anything.
 */
export function finishStages(
  sessionId: string | undefined,
  now = Date.now()
): Array<{ stage: Stage; durationMs: number }> {
  if (!sessionId) return [];

  const record = current.get(sessionId);
  if (!record) return [];

  const full = [
    ...record.completed,
    { stage: record.stage, durationMs: Math.max(0, now - record.startedAt) }
  ];
  current.delete(sessionId);
  return full;
}

export function clearStage(sessionId: string | undefined): void {
  if (sessionId) current.delete(sessionId);
}

export function resetStages(): void {
  current.clear();
}

/**
 * The stage a tool belongs to.
 *
 * Derived from what the tool actually does rather than declared separately,
 * so a new tool cannot be added and quietly report the wrong stage — the
 * mapping is about the work, and the work is what the name describes.
 */
export function stageForTool(tool: string): Stage {
  if (tool === "build_app" || tool === "write_file" || tool === "write_document") return "building";
  if (tool === "run_command") return "building";
  if (tool.startsWith("search_") || tool.startsWith("list_") || tool.startsWith("read_")
    || tool === "fetch_url") {
    return "gathering";
  }
  if (tool === "plan_app") return "planning";
  // Everything else changes something small or computes something: it is the
  // assistant getting on with the answer rather than a stage of its own.
  return "answering";
}
