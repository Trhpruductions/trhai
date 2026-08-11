// Decides whether a chat turn should trigger the scaffold pipeline.
//
// Auto-develop writes real files, so it must only fire for genuine build
// requests. Before this gate, every message scaffolded a project — including
// questions like "which database should we use?", which produced a spurious
// blueprint and a directory of files as a side effect of asking.

/** Question-shaped requests, used only when the API reports no strategy. */
export function looksLikeQuestion(request: string): boolean {
  const value = request.trim();
  return value.endsWith("?")
    || /^(what|which|how|why|when|who|where)\b/i.test(value)
    || /^(remind me|tell me|do you remember)\b/i.test(value);
}

/**
 * `strategy` is the server's classification of the request. "plan" is the only
 * one that represents work to build; answer/no-answer/clarify/acknowledge must
 * not produce files.
 */
export function shouldAutoDevelop(strategy: string | undefined, request: string): boolean {
  if (typeof strategy === "string" && strategy) {
    return strategy === "plan";
  }
  // Offline fallback: no server intent available, so use the local heuristic.
  return !looksLikeQuestion(request);
}
