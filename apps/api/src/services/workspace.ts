import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

// The one place on disk the assistant may touch.
//
// Giving a language model file access is the point at which a helpful app
// becomes a dangerous one, so the rule here is not "validate the path" but
// "resolve it and check where it landed". Every string a model produces is
// treated as hostile: "../", an absolute path, a Windows drive letter, a
// symlink, a UNC share. None of them are special-cased, because a blocklist of
// bad patterns is a list you can always add one more entry to. Instead the
// path is resolved to what the filesystem would actually use and then required
// to sit inside the workspace root.
//
// Nothing outside this directory is reachable, including the app's own source.

/** Where the assistant's files live. One directory, never anywhere else. */
export function workspaceRoot(): string {
  return process.env.ASCEND_WORKSPACE ?? path.join(process.cwd(), "workspace");
}

/** Nothing bigger than this is read back; a model cannot use it and it crowds out the exchange. */
export const maxReadBytes = 100_000;
/** A cap on what a single write may produce. */
export const maxWriteBytes = 500_000;
/** Enough to be useful, small enough that a listing stays readable. */
export const maxListedFiles = 200;

/**
 * Turn a caller's path into an absolute one inside the workspace, or null.
 *
 * Null means refused. It is never an error to be logged and continued past —
 * the caller must stop.
 */
export function resolveInWorkspace(relativePath: string): string | null {
  if (typeof relativePath !== "string" || !relativePath.trim()) return null;

  // A NUL byte truncates the path at the system call, so a name containing one
  // can resolve to somewhere other than what was checked.
  if (relativePath.includes("\0")) return null;

  const root = path.resolve(workspaceRoot());
  const resolved = path.resolve(root, relativePath);

  // The containment check. `startsWith(root)` alone is wrong: "/workspace-evil"
  // starts with "/workspace". The separator is what makes it a child.
  const relative = path.relative(root, resolved);
  if (relative === "") return resolved;
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;

  return resolved;
}

function ensureRoot(): string {
  const root = path.resolve(workspaceRoot());
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  return root;
}

export type WorkspaceEntry = { path: string; bytes: number; directory: boolean };

/** Everything in the workspace, as paths relative to its root. */
export function listWorkspace(subdirectory = "."): WorkspaceEntry[] | null {
  const target = resolveInWorkspace(subdirectory);
  if (!target) return null;

  ensureRoot();
  if (!existsSync(target)) return [];

  const root = path.resolve(workspaceRoot());
  const found: WorkspaceEntry[] = [];

  const walk = (directory: string) => {
    if (found.length >= maxListedFiles) return;

    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (found.length >= maxListedFiles) return;

      const full = path.join(directory, entry);
      let info: ReturnType<typeof statSync>;
      try {
        // lstat would be needed to spot a symlink, but resolveInWorkspace is
        // applied on every read, so a link pointing outside is refused there.
        info = statSync(full);
      } catch {
        continue;
      }

      const relative = path.relative(root, full).split(path.sep).join("/");
      if (info.isDirectory()) {
        found.push({ path: relative, bytes: 0, directory: true });
        walk(full);
      } else {
        found.push({ path: relative, bytes: info.size, directory: false });
      }
    }
  };

  walk(target);
  return found;
}

export type ReadResult =
  | { ok: true; content: string; truncated: boolean }
  | { ok: false; reason: string };

export function readWorkspaceFile(relativePath: string): ReadResult {
  const target = resolveInWorkspace(relativePath);
  if (!target) return { ok: false, reason: "That path is outside the workspace." };

  if (!existsSync(target)) return { ok: false, reason: `There is no file at "${relativePath}".` };

  let info: ReturnType<typeof statSync>;
  try {
    info = statSync(target);
  } catch {
    return { ok: false, reason: `"${relativePath}" could not be read.` };
  }

  if (info.isDirectory()) return { ok: false, reason: `"${relativePath}" is a directory, not a file.` };

  try {
    const raw = readFileSync(target);
    const truncated = raw.byteLength > maxReadBytes;
    return {
      ok: true,
      content: raw.subarray(0, maxReadBytes).toString("utf8"),
      truncated
    };
  } catch {
    return { ok: false, reason: `"${relativePath}" could not be read.` };
  }
}

export type WriteResult = { ok: true; path: string } | { ok: false; reason: string };

export function writeWorkspaceFile(relativePath: string, content: string): WriteResult {
  const target = resolveInWorkspace(relativePath);
  if (!target) return { ok: false, reason: "That path is outside the workspace." };

  if (typeof content !== "string") return { ok: false, reason: "There is nothing to write." };
  if (Buffer.byteLength(content, "utf8") > maxWriteBytes) {
    return { ok: false, reason: "That file is too large to write." };
  }

  try {
    ensureRoot();
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");

    const root = path.resolve(workspaceRoot());
    return { ok: true, path: path.relative(root, target).split(path.sep).join("/") };
  } catch {
    return { ok: false, reason: `"${relativePath}" could not be written.` };
  }
}
