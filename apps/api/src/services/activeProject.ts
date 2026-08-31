// Which project the conversation is currently in.
//
// The prompt already lists what is in the workspace, so the model can find
// "the calculator app" when it is named. What it could not do is answer "fix
// the router" - the spec's own example - because nothing tracked which project
// "the" refers to. Every request had to name its project again, which is
// exactly the friction the spec asks to remove:
//
//   "It should not force me to repeatedly explain the same project."
//
// Derived from what actually happened rather than declared. A project becomes
// current because a tool touched a file inside it or built it, not because
// anyone said so - there is no "open project" command to forget to use, and
// the record cannot claim a project the session never worked in.
//
// Per session and in memory only. This is context for a conversation, not a
// setting: it should follow what you are doing now and be gone when the
// conversation is.

import path from "node:path";
import { workspaceRoot } from "./workspace.js";

/** Sessions tracked before the oldest is dropped. Bounded like every store here. */
export const maxTrackedProjects = 200;

const current = new Map<string, string>();

/**
 * The project a path belongs to, or null.
 *
 * The first segment of the path relative to the workspace. A file directly in
 * the workspace root belongs to no project - it is loose, and calling the
 * workspace itself "the project" would make every stray file change the
 * answer.
 */
export function projectForPath(candidate: string): string | null {
  if (!candidate?.trim()) return null;

  const root = path.resolve(workspaceRoot());
  const resolved = path.resolve(root, candidate);
  const relative = path.relative(root, resolved);

  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;

  const [first, ...rest] = relative.split(path.sep);
  return rest.length > 0 && first ? first : null;
}

/** Record that this session just worked inside `candidate`, if it names a project. */
export function noteProjectTouched(sessionId: string | undefined, candidate: string): void {
  if (!sessionId) return;

  const project = projectForPath(candidate);
  if (!project) return;

  // Re-inserted so the most recently used sits at the end, which is what the
  // eviction below relies on.
  current.delete(sessionId);
  current.set(sessionId, project);

  while (current.size > maxTrackedProjects) {
    const oldest = current.keys().next();
    if (oldest.done) break;
    current.delete(oldest.value);
  }
}

/** The project this session is working in, or null if it has not touched one. */
export function activeProject(sessionId: string | undefined): string | null {
  return sessionId ? current.get(sessionId) ?? null : null;
}

/** Test seam. Production never needs to forget a session except by eviction. */
export function resetActiveProjects(): void {
  current.clear();
}

/**
 * A bare filename, resolved inside the project this session is working in.
 *
 * The prompt says which project is current, and the model does not reliably
 * act on it - asked to read the smoke test right after reading
 * calculator/server.js, it called read_file on a name of its own invention.
 * Telling it more firmly is not a fix; a model that ignores one sentence will
 * ignore two.
 *
 * So the resolution is mechanical. "smoke.js" with calculator current becomes
 * "calculator/smoke.js", which is what the user meant and what the model was
 * told. Only for names with no directory in them: a path that already says
 * where it lives is never second-guessed.
 */
export function withinActiveProject(sessionId: string | undefined, candidate: string): string | null {
  if (!candidate?.trim()) return null;
  if (candidate.includes("/") || candidate.includes("\\")) return null;

  const project = activeProject(sessionId);
  return project ? `${project}/${candidate}` : null;
}
