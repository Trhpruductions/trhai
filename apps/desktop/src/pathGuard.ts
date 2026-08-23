import path from "node:path";

// Containment for paths the renderer supplies.
//
// The desktop bridge takes paths from page content and turns them into real
// filesystem work. `ascend:run-check` already confined its working directory
// this way; `ascend:create-scaffold` did not, so a spec path of "../.." or an
// absolute path resolved cleanly outside the workspace and the handler then
// created directories and wrote a file there.
//
// The rule lives here rather than inline so both handlers use the same one and
// it can be tested without launching Electron.

export type ContainedPath =
  | { ok: true; path: string }
  | { ok: false; reason: string };

/**
 * Resolve `segments` under `root` and confirm the result is still inside it.
 *
 * `path.resolve` is the trap: it honours an absolute segment by discarding
 * everything before it, so resolve("/workspace", "C:\\Windows") is
 * "C:\Windows" — no traversal sequence required. The check is therefore on the
 * *resolved* path, not on the input string, which is also why looking for ".."
 * in the input is not enough.
 */
export function containPath(root: string, ...segments: string[]): ContainedPath {
  if (segments.some((segment) => typeof segment !== "string" || segment.length === 0)) {
    return { ok: false, reason: "Path segment missing." };
  }

  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, ...segments);
  const relative = path.relative(resolvedRoot, candidate);

  // Empty means the candidate *is* the root, which is inside it.
  if (relative === "") return { ok: true, path: candidate };

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return { ok: false, reason: "Path must stay inside the workspace." };
  }

  return { ok: true, path: candidate };
}

/**
 * Schemes that may be handed to the OS via shell.openExternal.
 *
 * Anything else — file:, javascript:, or a custom protocol registered by some
 * other installed application — is refused. openExternal asks the operating
 * system to act on the string, so the set of things it can start is much wider
 * than "open a web page".
 */
const openableSchemes = new Set(["http:", "https:", "mailto:"]);

export function isSafeExternalUrl(value: string): boolean {
  try {
    return openableSchemes.has(new URL(value).protocol);
  } catch {
    return false;
  }
}

/**
 * Origins the main window is allowed to sit on.
 *
 * The window holds a preload bridge that can run shell commands, so wherever it
 * navigates inherits that. Without a guard, a redirect or an injected
 * `location.href` would hand arbitrary command execution to remote content.
 */
export function isTrustedAppUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "file:") return true;
    if (url.protocol !== "http:") return false;
    return url.hostname === "127.0.0.1" || url.hostname === "localhost";
  } catch {
    return false;
  }
}
