// E13-S2 / E13-S3: response provenance and degraded-state labeling.
//
// The assistant silently falls back to a locally generated reply when /v1/assist
// cannot be reached. Without a label, a template is indistinguishable from a model
// answer, which is exactly the trust failure these stories exist to prevent.
//
// Source classes are deliberately limited to things this app can actually prove.
// `submitChatBuildRequest` sends only { mode, message } to the API — it does not
// ship workspace files or memory — so those are NOT claimed as sources here even
// though surrounding status copy mentions them. Adding a source class requires
// adding the real plumbing first.

export type ResponseOrigin = "model" | "local-fallback";

export type ResponseSourceClass = "model" | "memory" | "conversation" | "blueprint" | "local-heuristic";

export type ResponseConfidence = "high" | "reduced";

export type ResponseProvenance = {
  origin: ResponseOrigin;
  sources: ResponseSourceClass[];
  model: string | null;
  /** How many API attempts were made, including the successful one. */
  attempts: number;
  confidence: ResponseConfidence;
  note: string;
};

export type ProvenanceInput = {
  /** Model id reported by the API. Null/absent means the API never produced text. */
  apiModel?: string | null;
  attempts: number;
  /** True when a locally generated build blueprint was merged into the reply. */
  usedBlueprint?: boolean;
  /**
   * History turns the API reported actually using. This is the server's own count,
   * not what the client hoped to send — a request that was capped or rejected must
   * not earn a "Chat history" badge.
   */
  usedHistoryTurns?: number;
  /** Memory entries the API reported actually using, on the same trust basis. */
  usedMemoryEntries?: number;
};

export const sourceClassLabels: Record<ResponseSourceClass, string> = {
  model: "Model",
  memory: "Memory",
  conversation: "Chat history",
  blueprint: "Blueprint",
  "local-heuristic": "Local template"
};

export const sourceClassDescriptions: Record<ResponseSourceClass, string> = {
  model: "Text produced by the assistant API.",
  memory: "Saved memories from this session were used as context.",
  conversation: "Earlier turns from this conversation were sent as context.",
  blueprint: "Locally generated build blueprint merged into the reply.",
  "local-heuristic": "Offline template generated on this device — no model was reached."
};

const maxTrackedAttempts = 99;

function normalizeAttempts(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 1;
  }
  return Math.min(maxTrackedAttempts, Math.max(1, Math.round(value)));
}

export function buildResponseProvenance(input: ProvenanceInput): ResponseProvenance {
  const attempts = normalizeAttempts(input.attempts);
  const model = typeof input.apiModel === "string" && input.apiModel.trim() ? input.apiModel.trim() : null;
  const origin: ResponseOrigin = model ? "model" : "local-fallback";

  const sources: ResponseSourceClass[] = [];
  if (origin === "model") {
    sources.push("model");
  } else {
    sources.push("local-heuristic");
  }
  // A local fallback never reached the API, so it cannot have used server context.
  const serverCount = (value: number | undefined) => (
    origin === "model" && typeof value === "number" && Number.isFinite(value)
      ? Math.max(0, Math.trunc(value))
      : 0
  );

  if (serverCount(input.usedMemoryEntries) > 0) {
    sources.push("memory");
  }
  if (serverCount(input.usedHistoryTurns) > 0) {
    sources.push("conversation");
  }
  if (input.usedBlueprint) {
    sources.push("blueprint");
  }

  let note: string;
  if (origin === "local-fallback") {
    note = `Assistant API unreachable after ${attempts} attempt${attempts === 1 ? "" : "s"}. This reply was generated locally.`;
  } else if (attempts > 1) {
    note = `Recovered after ${attempts} attempts.`;
  } else {
    note = "Delivered by the assistant API.";
  }

  return {
    origin,
    sources,
    model,
    attempts,
    confidence: origin === "model" ? "high" : "reduced",
    note
  };
}

const validSourceClasses = new Set<string>(["model", "memory", "conversation", "blueprint", "local-heuristic"]);

/** Provenance round-trips through localStorage, so treat stored values as untrusted. */
export function sanitizeResponseProvenance(value: unknown): ResponseProvenance | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<ResponseProvenance>;
  if (candidate.origin !== "model" && candidate.origin !== "local-fallback") {
    return null;
  }

  const sources = Array.isArray(candidate.sources)
    ? candidate.sources.filter((source): source is ResponseSourceClass => (
      typeof source === "string" && validSourceClasses.has(source)
    ))
    : [];

  if (sources.length === 0) {
    sources.push(candidate.origin === "model" ? "model" : "local-heuristic");
  }

  return {
    origin: candidate.origin,
    sources,
    model: typeof candidate.model === "string" && candidate.model.trim() ? candidate.model.trim() : null,
    attempts: normalizeAttempts(candidate.attempts),
    confidence: candidate.confidence === "high" ? "high" : "reduced",
    note: typeof candidate.note === "string" ? candidate.note : ""
  };
}

export type DegradedState = {
  degraded: boolean;
  /** Fallback replies at the tail of the conversation, newest-run backwards. */
  consecutiveFallbacks: number;
  /** True when the latest reply came from the model but a recent one did not. */
  recovered: boolean;
  label: string;
};

const recoveryLookback = 5;

/**
 * Derive the degraded banner state from the provenance of assistant replies.
 * `history` is oldest-first, matching chat message order.
 */
export function summarizeDegradedState(history: ResponseProvenance[]): DegradedState {
  if (history.length === 0) {
    return { degraded: false, consecutiveFallbacks: 0, recovered: false, label: "" };
  }

  let consecutiveFallbacks = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index].origin !== "local-fallback") {
      break;
    }
    consecutiveFallbacks += 1;
  }

  if (consecutiveFallbacks > 0) {
    return {
      degraded: true,
      consecutiveFallbacks,
      recovered: false,
      label: consecutiveFallbacks === 1
        ? "Assistant API unreachable — last reply was generated locally."
        : `Assistant API unreachable — last ${consecutiveFallbacks} replies were generated locally.`
    };
  }

  // Latest reply is from the model. Surface a recovery note if the run just before
  // it was degraded, so the state change is visible rather than silent.
  const recentWindow = history.slice(-recoveryLookback, -1);
  const recovered = recentWindow.some((entry) => entry.origin === "local-fallback");

  return {
    degraded: false,
    consecutiveFallbacks: 0,
    recovered,
    label: recovered ? "Assistant API recovered — replies are model-backed again." : ""
  };
}
