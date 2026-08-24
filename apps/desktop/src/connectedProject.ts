import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { containPath } from "./pathGuard.js";

// A project the user has explicitly connected, and may only read.
//
// Two properties matter more than anything this file does.
//
// The root is never supplied by the renderer. It comes from a native folder
// picker, which means the user chose it in an operating-system dialog that
// page content cannot drive or pre-fill. A renderer that asks to connect can
// only cause the dialog to open; it cannot name the directory. Every path
// afterwards is resolved relative to that root and contained against it.
//
// There is no write function here, and that is the whole enforcement. Not a
// flag that defaults to read-only, not a permission that could be granted by
// setting something — the capability simply does not exist in this module, so
// there is nothing to get wrong later. Adding one is a deliberate act, not an
// accident.

export type ConnectedProject = {
  /** Absolute, as the filesystem reports it. */
  root: string;
  /** The folder's own name, for display. */
  name: string;
  connectedAt: string;
};

export type ProjectEntry = { path: string; bytes: number; directory: boolean };

export type ConnectResult =
  | { ok: true; project: ConnectedProject }
  | { ok: false; error: string };

export type ReadResult =
  | { ok: true; content: string; truncated: boolean }
  | { ok: false; error: string };

/** Big enough to read a source file, small enough not to hang the renderer. */
export const maxReadBytes = 200_000;
/** A listing past this is not something anyone reads; it is something they search. */
export const maxListedEntries = 500;

/**
 * Never worth listing, and expensive to walk.
 *
 * node_modules alone can be tens of thousands of files, which would exhaust
 * the cap before reaching anything the user recognises.
 */
const ignoredNames = new Set([
  ".git", "node_modules", "dist", "build", "release", ".next", ".turbo",
  ".cache", "coverage", ".venv", "__pycache__"
]);

/**
 * Where the connection is remembered.
 *
 * Caught live: this defaulted to a path under process.cwd(), and a desktop
 * app's working directory depends entirely on how it was started —
 * D:\trhai via the launcher, apps\desktop when run directly, somewhere else
 * again when packaged. A connection made in one of those was invisible to
 * the next, silently, with nothing to indicate the record had simply been
 * looked for in the wrong place.
 *
 * main.ts calls configureConnectedProjectStore with a stable per-user path
 * before anything reads this. The env var still wins so tests can point it
 * at a scratch file, and the cwd default remains only as a last resort for
 * a caller that configures nothing.
 */
let storeFilePath = process.env.ASCEND_CONNECTED_PROJECT_FILE
  ?? path.join(process.cwd(), "data", "connected-project.json");

const persistenceEnabled = process.env.ASCEND_CONNECTED_PROJECT_PERSIST !== "off";

export function configureConnectedProjectStore(filePath: string): void {
  // An explicit environment override outranks the caller: that is what the
  // tests use, and a test that could be overridden by production wiring
  // would be testing the wrong file.
  if (process.env.ASCEND_CONNECTED_PROJECT_FILE) return;
  if (typeof filePath !== "string" || !filePath.trim()) return;

  storeFilePath = filePath;
  // Anything already loaded came from the old path and must not be trusted.
  loaded = false;
  connected = null;
}

let connected: ConnectedProject | null = null;
let loaded = false;

function loadFromDisk(): void {
  if (loaded) return;
  loaded = true;
  if (!persistenceEnabled || !existsSync(storeFilePath)) return;

  try {
    const parsed = JSON.parse(readFileSync(storeFilePath, "utf8")) as { project?: Partial<ConnectedProject> };
    const project = parsed.project;
    if (!project || typeof project.root !== "string") return;

    // Re-checked rather than trusted. The folder may have been moved, renamed
    // or deleted since it was connected, and a stored root that no longer
    // resolves must not come back as a live connection.
    if (!existsSync(project.root) || !statSync(project.root).isDirectory()) return;

    connected = {
      root: project.root,
      name: typeof project.name === "string" ? project.name : path.basename(project.root),
      connectedAt: typeof project.connectedAt === "string" ? project.connectedAt : new Date().toISOString()
    };
  } catch {
    // A corrupt file must not stop the app from starting.
  }
}

function saveToDisk(): void {
  if (!persistenceEnabled) return;
  try {
    mkdirSync(path.dirname(storeFilePath), { recursive: true });
    const tempPath = `${storeFilePath}.tmp`;
    writeFileSync(tempPath, JSON.stringify({ version: 1, project: connected }, null, 2), "utf8");
    renameSync(tempPath, storeFilePath);
  } catch {
    // Losing the memory of which project was connected is not worth failing a
    // request over; the user can connect it again.
  }
}

/**
 * Connect a directory the user picked.
 *
 * Takes an absolute path rather than opening the dialog itself, so this stays
 * testable without an Electron runtime. The caller in main.ts is the only
 * place that talks to the picker, and it has no other source for this value.
 */
export function connectProject(chosenPath: unknown): ConnectResult {
  if (typeof chosenPath !== "string" || !chosenPath.trim()) {
    return { ok: false, error: "No folder was chosen." };
  }

  const root = path.resolve(chosenPath);

  if (!existsSync(root)) {
    return { ok: false, error: "That folder does not exist." };
  }

  let info: ReturnType<typeof statSync>;
  try {
    info = statSync(root);
  } catch {
    return { ok: false, error: "That folder could not be read." };
  }

  if (!info.isDirectory()) {
    return { ok: false, error: "A project must be a folder, not a file." };
  }

  connected = { root, name: path.basename(root) || root, connectedAt: new Date().toISOString() };
  saveToDisk();

  return { ok: true, project: connected };
}

export function getConnectedProject(): ConnectedProject | null {
  loadFromDisk();
  return connected;
}

export function disconnectProject(): boolean {
  loadFromDisk();
  if (!connected) return false;

  connected = null;
  saveToDisk();
  return true;
}

/**
 * Resolve a path inside the connected project, or null.
 *
 * containPath carries the symlink check, so a link inside the project that
 * points outside it is refused here rather than followed.
 */
function resolveInProject(relativePath: string): string | null {
  const project = getConnectedProject();
  if (!project) return null;
  if (typeof relativePath !== "string" || relativePath.includes("\0")) return null;

  // "." means the project root, which containPath treats as inside.
  const contained = containPath(project.root, relativePath.trim() || ".");
  return contained.ok ? contained.path : null;
}

/** One level, not a recursive walk. A tree is navigated, not dumped. */
export function listProjectFiles(subdirectory = "."): ProjectEntry[] | null {
  const project = getConnectedProject();
  if (!project) return null;

  const target = resolveInProject(subdirectory);
  if (!target || !existsSync(target)) return null;

  let names: string[];
  try {
    names = readdirSync(target);
  } catch {
    return null;
  }

  const entries: ProjectEntry[] = [];

  for (const name of names) {
    if (entries.length >= maxListedEntries) break;
    if (ignoredNames.has(name)) continue;

    const full = path.join(target, name);
    try {
      const info = statSync(full);
      entries.push({
        path: path.relative(project.root, full).split(path.sep).join("/"),
        bytes: info.isDirectory() ? 0 : info.size,
        directory: info.isDirectory()
      });
    } catch {
      // A file that vanished between readdir and stat is simply not listed.
    }
  }

  // Folders first, then alphabetical: the order someone reading a tree expects.
  return entries.sort((left, right) => {
    if (left.directory !== right.directory) return left.directory ? -1 : 1;
    return left.path.localeCompare(right.path);
  });
}

export function readProjectFile(relativePath: string): ReadResult {
  const project = getConnectedProject();
  if (!project) return { ok: false, error: "No project is connected." };

  const target = resolveInProject(relativePath);
  if (!target) return { ok: false, error: "That path is outside the connected project." };
  if (!existsSync(target)) return { ok: false, error: `There is no file at "${relativePath}".` };

  let info: ReturnType<typeof statSync>;
  try {
    info = statSync(target);
  } catch {
    return { ok: false, error: `"${relativePath}" could not be read.` };
  }

  if (info.isDirectory()) return { ok: false, error: `"${relativePath}" is a folder, not a file.` };

  try {
    const raw = readFileSync(target);
    const truncated = raw.byteLength > maxReadBytes;
    return {
      ok: true,
      content: raw.subarray(0, maxReadBytes).toString("utf8"),
      truncated
    };
  } catch {
    return { ok: false, error: `"${relativePath}" could not be read.` };
  }
}

/** Test seam. */
export function resetConnectedProject(): void {
  loaded = true;
  connected = null;
  saveToDisk();
}

/** Test seam: drop in-process state and re-read the file, simulating a restart. */
export function reloadConnectedProjectFromDisk(): void {
  connected = null;
  loaded = false;
  loadFromDisk();
}
