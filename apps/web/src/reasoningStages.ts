// E13-S1: public reasoning-stage model.
//
// The assistant pipeline emits execution events at real checkpoints. This module
// gives those checkpoints a typed identity plus duration telemetry, so the UI can
// show *what stage the system is actually in* without exposing private reasoning.

export type ReasoningStage =
  | "understanding"
  | "context"
  | "planning"
  | "building"
  | "verifying";

export type ReasoningStageLevel = "info" | "ok" | "warn" | "error";

export type ReasoningStageStatus = "pending" | "active" | "done" | "warn" | "error";

export type ReasoningStageEvent = {
  stage: ReasoningStage;
  level: ReasoningStageLevel;
  createdAt: number;
};

export type ReasoningStageStat = {
  stage: ReasoningStage;
  label: string;
  status: ReasoningStageStatus;
  events: number;
  durationMs: number;
  lastAt: number | null;
};

export type ReasoningStageSummary = {
  stages: ReasoningStageStat[];
  activeStage: ReasoningStage | null;
  totalMs: number;
};

/** Canonical pipeline order. The UI renders the stage strip in this order. */
export const reasoningStageOrder: ReasoningStage[] = [
  "understanding",
  "context",
  "planning",
  "building",
  "verifying"
];

/** Display copy. Kept in one place so stage labels can never drift between call sites. */
export const reasoningStageLabels: Record<ReasoningStage, string> = {
  understanding: "Understanding request",
  context: "Gathering context",
  planning: "Planning solution",
  building: "Building response",
  verifying: "Verifying output"
};

/** Short copy for the compact stage strip. */
export const reasoningStageShortLabels: Record<ReasoningStage, string> = {
  understanding: "Understand",
  context: "Context",
  planning: "Plan",
  building: "Build",
  verifying: "Verify"
};

export function reasoningStageLabel(stage: ReasoningStage): string {
  return reasoningStageLabels[stage];
}

function statusFromLevel(level: ReasoningStageLevel): ReasoningStageStatus {
  if (level === "error") {
    return "error";
  }
  if (level === "warn") {
    return "warn";
  }
  return "done";
}

/**
 * Summarize a stage timeline.
 *
 * `events` are expected newest-first, the order App state stores them in. Two
 * checkpoints can land in the same millisecond, so ties are broken by position:
 * an event earlier in the array is treated as the more recent one.
 *
 * Duration is attributed by walking the timeline forward: a stage owns the
 * wall-clock time from its checkpoint until the next checkpoint. The most recent
 * stage accrues time up to `now`, which is what makes the strip feel live.
 */
export function summarizeReasoningStages(
  events: ReasoningStageEvent[],
  now: number = Date.now()
): ReasoningStageSummary {
  const stats = new Map<ReasoningStage, ReasoningStageStat>();
  for (const stage of reasoningStageOrder) {
    stats.set(stage, {
      stage,
      label: reasoningStageLabels[stage],
      status: "pending",
      events: 0,
      durationMs: 0,
      lastAt: null
    });
  }

  const ordered = events
    .filter((event) => stats.has(event.stage))
    .map((event, index) => ({ event, index }))
    .sort((left, right) => {
      if (left.event.createdAt !== right.event.createdAt) {
        return left.event.createdAt - right.event.createdAt;
      }
      // Same millisecond: the later array position is the older event.
      return right.index - left.index;
    })
    .map((entry) => entry.event);

  if (ordered.length === 0) {
    return { stages: reasoningStageOrder.map((stage) => stats.get(stage)!), activeStage: null, totalMs: 0 };
  }

  for (const event of ordered) {
    const stat = stats.get(event.stage)!;
    stat.events += 1;
    stat.lastAt = Math.max(stat.lastAt ?? 0, event.createdAt);
    // Later events win, so a stage that recovers stops reporting a stale failure.
    stat.status = statusFromLevel(event.level);
  }

  // Attribute elapsed time to whichever stage was in effect during each span.
  for (let index = 0; index < ordered.length; index += 1) {
    const current = ordered[index];
    const next = ordered[index + 1];
    const endsAt = next ? next.createdAt : now;
    const span = endsAt - current.createdAt;
    if (span > 0) {
      stats.get(current.stage)!.durationMs += span;
    }
  }

  const activeStage = ordered[ordered.length - 1].stage;
  const activeStat = stats.get(activeStage)!;
  if (activeStat.status === "done") {
    // Only a clean stage is shown as still running; warn/error stay visible.
    activeStat.status = "active";
  }

  const totalMs = Math.max(0, now - ordered[0].createdAt);

  return {
    stages: reasoningStageOrder.map((stage) => stats.get(stage)!),
    activeStage,
    totalMs
  };
}

/** Compact human-readable duration for stage chips. */
export function formatStageDuration(durationMs: number): string {
  if (durationMs <= 0) {
    return "—";
  }
  if (durationMs < 1000) {
    return `${Math.round(durationMs)}ms`;
  }
  if (durationMs < 60000) {
    return `${(durationMs / 1000).toFixed(1)}s`;
  }
  const minutes = Math.floor(durationMs / 60000);
  const seconds = Math.round((durationMs % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}
