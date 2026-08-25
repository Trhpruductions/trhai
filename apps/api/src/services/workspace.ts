import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

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

/**
 * Where the assistant's files live. One directory, never anywhere else.
 *
 * Under the user's home folder rather than inside the repo. The default was
 * `<cwd>/workspace`, which put every app the assistant built inside the
 * project's own source tree: it needed gitignoring to stay out of commits, it
 * would be destroyed by a clean checkout, and someone looking for the app they
 * asked for had no reason to look there. Their own Ascend folder is somewhere
 * they can find it, back it up, and open in an editor.
 *
 * ASCEND_WORKSPACE still overrides, which is what the tests use.
 */
export function workspaceRoot(): string {
  const configured = process.env.ASCEND_WORKSPACE;
  if (configured) return configured;

  // homedir() is empty in some containerised environments; falling back to the
  // working directory is worse than nothing there, so it keeps the old
  // behaviour rather than writing to the filesystem root.
  const home = homedir();
  return home ? path.join(home, "Vexora", "workspace") : path.join(process.cwd(), "workspace");
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
/** Whether `candidate` is `root` or sits underneath it. Purely lexical. */
function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  if (relative === "") return true;
  // `startsWith(root)` alone is wrong: "/workspace-evil" starts with
  // "/workspace". The separator is what makes it a child, which is what
  // path.relative encodes.
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * The path the filesystem would actually use, with every symlink followed.
 *
 * `path.resolve` is lexical and does not read the disk, so it cannot see a
 * link. A path that has not been created yet cannot be resolved at all, so
 * this walks up to the nearest ancestor that does exist, resolves that, and
 * re-attaches the missing tail — which is what makes the check work for a
 * write to a file that is about to be created.
 */
function resolveRealPath(target: string): string {
  const absolute = path.resolve(target);
  const missing: string[] = [];
  let current = absolute;

  for (;;) {
    try {
      const real = realpathSync(current);
      return missing.length === 0 ? real : path.join(real, ...missing.slice().reverse());
    } catch {
      const parent = path.dirname(current);
      // Reached the filesystem root without finding anything that exists.
      if (parent === current) return absolute;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

export function resolveInWorkspace(relativePath: string): string | null {
  if (typeof relativePath !== "string" || !relativePath.trim()) return null;

  // A NUL byte truncates the path at the system call, so a name containing one
  // can resolve to somewhere other than what was checked.
  if (relativePath.includes("\0")) return null;

  const root = path.resolve(workspaceRoot());
  const resolved = path.resolve(root, relativePath);

  // Lexical containment: catches "..", an absolute path, a drive letter.
  if (!isInside(root, resolved)) return null;

  // Containment as the filesystem sees it.
  //
  // The lexical check above cannot see a symlink, and a link inside the
  // workspace pointing outside it resolves to a path that looks perfectly
  // contained. This file used to claim the opposite — that a link pointing
  // out was refused here — and that was simply wrong: nothing read the disk.
  // On Windows a junction is the same escape and needs no privileges to
  // create.
  //
  // The root is resolved too, not just the target: a workspace that itself
  // sits under a symlinked home directory would otherwise fail every check.
  const realRoot = resolveRealPath(root);
  const realTarget = resolveRealPath(resolved);
  if (!isInside(realRoot, realTarget)) return null;

  // The lexical path is what the caller asked for and what it will operate
  // on. The real path was only ever needed to answer whether that is allowed.
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
        // resolveInWorkspace refuses a link that points outside the
        // workspace, so a listing that walks into one cannot lead anywhere a
        // later read would be allowed to follow.
        //
        // That claim was false until the real-path check was added — this
        // said the same thing while nothing in the codebase read the disk to
        // check. A comment asserting a guarantee is worth exactly as much as
        // the code implementing it.
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

/**
 * Whether decoded text is really binary that was read as UTF-8.
 *
 * Decided from the content rather than the file name. The first version of
 * the Files page guessed from the extension and would have told you
 * ".git/config", "HEAD" and "COMMIT_EDITMSG" were not text — they have no
 * extension and are plainly readable. A name is a hint; the bytes are the
 * fact.
 *
 * A NUL byte is the classic signal, since text essentially never contains
 * one. Decoding binary as UTF-8 also produces replacement characters, so a
 * high proportion of those means the same thing — but a low proportion is
 * ordinary in text that has a couple of mangled characters in it, which is
 * why this is a ratio and not a presence check.
 */
export function looksBinary(content: string): boolean {
  if (content.length === 0) return false;
  if (content.includes("\u0000")) return true;

  // Sampled rather than counted in full: this runs on every read, and the
  // first few KB decide the question for any real file.
  const sample = content.slice(0, 4096);
  let replacements = 0;
  for (const character of sample) {
    if (character === "\uFFFD") replacements += 1;
  }
  return replacements / sample.length > 0.1;
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
