export type ConversationTurn = {
  role: "user" | "assistant";
  content: string;
};

/**
 * `/v1/assist` is registered ahead of the auth middleware, so its body is fully
 * untrusted. History is capped on both axes to keep an anonymous caller from
 * pushing a 1MB prompt through the orchestrator.
 */
export const maxAssistHistoryTurns = 12;
export const maxAssistHistoryContentLength = 2000;

export function normalizeAssistHistory(value: unknown): ConversationTurn[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const turns: ConversationTurn[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const candidate = entry as { role?: unknown; content?: unknown };
    if (candidate.role !== "user" && candidate.role !== "assistant") {
      continue;
    }

    if (typeof candidate.content !== "string") {
      continue;
    }

    const content = candidate.content.trim();
    if (!content) {
      continue;
    }

    turns.push({
      role: candidate.role,
      content: content.length > maxAssistHistoryContentLength
        ? content.slice(0, maxAssistHistoryContentLength)
        : content
    });
  }

  // Keep the most recent turns; they carry the most relevant context.
  return turns.slice(-maxAssistHistoryTurns);
}
