// What the agent is doing right now, per session.
//
// Purely transient — there is no meaning to "what was running" after a
// restart, so this is a plain Map, not another file to persist and isolate
// in tests. The point is narrow: a client polling mid-turn can ask "which
// tool is running right now" instead of staring at a generic spinner while
// the agent reads five files and runs a build.

const activeTool = new Map<string, { tool: string; startedAt: number }>();

export function setActivity(sessionId: string, tool: string): void {
  activeTool.set(sessionId, { tool, startedAt: Date.now() });
}

export function clearActivity(sessionId: string): void {
  activeTool.delete(sessionId);
}

export function getActivity(sessionId: string): { tool: string; startedAt: number } | null {
  return activeTool.get(sessionId) ?? null;
}

/** Test-only: guarantees one test's leftover state cannot leak into another. */
export function resetAgentActivity(): void {
  activeTool.clear();
}
