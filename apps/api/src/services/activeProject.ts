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
import { statSync } from "node:fs";
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
  if (rest.length > 0 && first) return first;
  // A bare folder name is the project itself when the folder exists. build_app
  // records the folder it just wrote, and with no file part that was read as
  // a loose file and dropped - so a build never became the current project,
  // and "add a notes field to the plants" right after one had nothing to
  // refer to.
  if (first && !rest.length) {
    try {
      if (statSync(path.join(root, first)).isDirectory()) return first;
    } catch {
      return null;
    }
  }
  return null;
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

/**
 * The file each session last read, wrote or edited.
 *
 * Same reasoning as the project above, one level down. "read notes.txt",
 * then "now add a line saying omega to the end of it" - "it" names nothing
 * the classifier can see, so the request was not a write, build_app was
 * still on offer, and the model built an app called "Now Add A Line
 * Saying". The file the previous turn touched is what "it" means, and
 * resolving that is mechanical.
 */
const lastFile = new Map<string, string>();

export function noteFileTouched(sessionId: string | undefined, candidate: string): void {
  if (!sessionId || !candidate?.trim()) return;
  lastFile.delete(sessionId);
  lastFile.set(sessionId, candidate.trim());
  while (lastFile.size > maxTrackedProjects) {
    const oldest = lastFile.keys().next();
    if (oldest.done) break;
    lastFile.delete(oldest.value);
  }
}

/** The file this session last touched, or null. */
export function lastFileTouched(sessionId: string | undefined): string | null {
  return sessionId ? lastFile.get(sessionId) ?? null : null;
}

/** Test seam. */
export function resetTouchedFiles(): void {
  lastFile.clear();
}

/** A file verb with a pronoun where its object should be, and no file named. */
const filePronoun =
  /\b(?:to|in|into|of|from|at|on|inside)\s+(?:it|that|this|the\s+(?:same\s+)?(?:file|one))\b|\b(?:edit|change|update|fix|append\s+to|read|open|delete|remove|rewrite|save|overwrite|rename|show|print|cat)\s+(?:it|that|this)\b|\bthe\s+end\s+of\s+it\b|\bthe\s+top\s+of\s+it\b/i;
const namesAPath = /[a-z]:[\\/]|(?:^|\s)\/[^\s]+\.[a-z0-9]{1,6}\b|\b[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|txt|css|html|py|ps1|bat|sh|yml|yaml|toml)\b/i;

/**
 * The request with "it" spelled out, or null when there is nothing to spell.
 *
 * Appended rather than substituted: the user's sentence stays as typed, and
 * the classifier sees a named file in the same text.
 */
export function resolveFilePronoun(
  request: string,
  sessionId: string | undefined
): { request: string; file: string } | null {
  const file = lastFileTouched(sessionId);
  if (!file) return null;
  if (namesAPath.test(request)) return null;
  if (!filePronoun.test(request)) return null;
  return { request: `${request}\n\n("it" is ${file}, the file from the previous turn.)`, file };
}

/**
 * The path a file tool should actually use, when the turn is about one file.
 *
 * Telling the model the path was not enough: handed "C:/.../iq4/notes.txt" it
 * called read_file on "D:\\Vexora\\notes.txt", then on "D:\\Vexora\\workspace
 * \\notes.txt" - the right name in the wrong place, twice. Same name, same
 * file: a call naming the implied file's basename, anywhere, means that file.
 */
export function impliedFileFor(implied: string | undefined, candidate: string): string {
  if (!implied || !candidate?.trim()) return candidate;
  const wanted = path.basename(implied).toLowerCase();
  const given = path.basename(candidate.trim().replace(/[\\/]+$/, "")).toLowerCase();
  return wanted === given ? implied : candidate;
}

/** Words that name the app the session is working on without naming it. */
const projectReference =
  /\b(?:the|this|that|my)\s+(?:app|application|project|program|site|tracker|tool|thing)\b|\bits\b|\b(?:to|in|into|on|from|of|for|with)\s+(?:it|that|this)\b|\bthat (?:create|created|made|built|do|did)\b/i;

/** A request for a second app, which is never a change to the current one. */
const asksForAnotherApp =
  /\b(?:build|create|make|generate|scaffold)\s+(?:me\s+)?(?:a|an|another|a new|one more)\b|\bnew app\b|\banother app\b/i;

/** A change to what the app stores or shows: change_app's business. */
const changesTheApp =
  /^(?:now\s+|then\s+|also\s+|please\s+|can you\s+|could you\s+)*(?:add|include|remove|delete|drop|rename|change|give it|put)\b/i;

/**
 * The request with the current project spelled out, or null.
 *
 * "add a 'notes' text field to the plants", said right after building a
 * houseplant tracker, named no project, so the classifier saw no target and
 * build_app stayed on offer: the model built a second app called "Notes
 * Text Field". "run its smoke test" was asked which project. "what files
 * did that create?" listed the whole workspace. The project the session is
 * in is what all three meant, and saying so is mechanical.
 *
 * Only when the request refers to the app without naming a path, and does
 * not ask for another app. A change to what the app stores or shows names
 * change_app outright, because the model reaches for build_app otherwise.
 */
export function resolveProjectReference(
  request: string,
  sessionId: string | undefined
): { request: string; project: string } | null {
  const project = activeProject(sessionId);
  if (!project) return null;
  if (namesAPath.test(request)) return null;
  if (asksForAnotherApp.test(request)) return null;

  const refersToIt = projectReference.test(request);
  const changesIt = changesTheApp.test(request.trim());
  if (!refersToIt && !changesIt) return null;

  const folder = path.join(path.resolve(workspaceRoot()), project);
  const how = changesIt
    ? " To add or remove a field or add a feature, call change_app with the change; to change specific code, edit its files with edit_file. Do not call build_app."
    : "";
  return {
    request: `${request}\n\n(The app in question is "${project}", built in this session, at ${folder}.${how})`,
    project
  };
}
