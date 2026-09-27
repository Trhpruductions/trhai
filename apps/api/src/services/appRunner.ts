// Running the apps that build_app writes, so a built app is something on
// screen rather than a folder and an instruction.
//
// "make sure I'm seeing the app being built." The build was watchable - the
// files appear, the steps tick past - and then the reply said "You can now
// access it", which was false: nothing was running. The model was rightly
// stopped from `npm start`-ing it through run_command, because a server
// never exits and would have held the turn until the timeout. This is the
// place that starts one properly: on a free port, in the background, tracked,
// stopped when the API stops, one instance per app, a handful at most.

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, statSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { workspaceRoot } from "./workspace.js";

export type RunningApp = {
  project: string;
  port: number;
  url: string;
  pid: number;
  startedAt: string;
  /** The last lines the server printed, newest last. */
  output: string[];
};

/** More than this and the machine is running a small data centre. The oldest is stopped first. */
export const maxRunningApps = 4;
/** How long a server gets to answer /health before the start is called failed. */
const readyTimeoutMs = 8000;
const outputLines = 40;

type Tracked = RunningApp & { child: ChildProcess; exited: boolean };

const running = new Map<string, Tracked>();
let cleanupInstalled = false;

/** Every app running right now, oldest first. */
export function listRunningApps(): RunningApp[] {
  return [...running.values()].map(({ child: _child, exited: _exited, ...app }) => app);
}

export function runningApp(project: string): RunningApp | null {
  const found = running.get(project);
  if (!found) return null;
  const { child: _child, exited: _exited, ...app } = found;
  return app;
}

export type BuiltApp = { name: string; running: boolean; url: string | null };

/**
 * Every app build_app has written to the workspace - a folder with a runnable
 * server entry - and whether it is running right now. Read fresh from disk, so
 * an app built in an earlier session, or one that has since stopped, is still
 * listed. This is what makes "what apps have I built" answerable and lets a
 * stopped app be run by name; listRunningApps only knows the live ones.
 */
export function listBuiltApps(): BuiltApp[] {
  const root = path.resolve(workspaceRoot());
  let names: string[];
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const live = new Map(listRunningApps().map((app) => [app.project, app] as const));
  return names
    .filter((name) => serverEntry(name) !== null)
    .map((name) => {
      const app = live.get(name);
      return { name, running: Boolean(app), url: app ? app.url : null };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Delete a built app's folder from the workspace. Refuses a RUNNING app: a live
 * server holds its files locked on Windows and a force-kill returns before the
 * OS has released them, so the caller stops it first. Retries the removal to
 * ride out any brief lock a recently-stopped server still holds. Guarded by
 * projectFolderName: it can only ever delete a folder inside the workspace,
 * never an absolute path or one that escapes it.
 */
export function removeBuiltApp(name: string): boolean {
  const folder = projectFolderName(name);
  if (!folder) return false;
  if (running.has(folder)) return false; // caller must stop it first
  const dir = path.join(path.resolve(workspaceRoot()), folder);
  if (!existsSync(dir)) return false;
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    return !existsSync(dir);
  } catch {
    return false;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

async function waitUntilReady(url: string, child: ChildProcess): Promise<{ ok: true } | { ok: false; reason: string }> {
  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return { ok: false, reason: `the server exited with code ${child.exitCode} before it was ready` };
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return { ok: true };
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return { ok: false, reason: `the server did not answer /health within ${readyTimeoutMs / 1000}s` };
}

function killTree(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
        .on("error", () => child.kill());
    } catch {
      child.kill();
    }
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

function installCleanup(): void {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  // The API going down takes its apps with it. A `node server.js` that
  // outlived the process that started it held a workspace folder open for
  // hours once; see buildVerification.ts.
  process.on("exit", () => stopAllApps());
}

/** The server file a project is started from, or null when it has none. */
/**
 * The workspace folder a project refers to, whatever shape the caller passed.
 *
 * The model routinely hands over the full path it was given - change_app echoes
 * "D:\\Vexora\\workspace\\track-my-house-plants" as the project, run_app joined
 * that onto the workspace root, landed nowhere, and the model then tried to run
 * `build_app` as a shell command and gave up. An absolute path inside the
 * workspace is reduced to the folder under it; a plain name is kept; anything
 * with ".." or outside the workspace is refused ("").
 */
export function projectFolderName(project: string): string {
  const trimmed = (project ?? "").trim().replace(/[\\/]+$/, "");
  if (!trimmed) return "";
  const root = path.resolve(workspaceRoot());
  const abs = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(root, trimmed);
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return "";
  return rel.split(/[\\/]/)[0];
}

function serverEntry(project: string): { dir: string; entry: string } | null {
  const clean = projectFolderName(project);
  if (!clean) return null;
  const dir = path.join(path.resolve(workspaceRoot()), clean);
  let stat;
  try {
    stat = statSync(dir);
  } catch {
    return null;
  }
  if (!stat.isDirectory()) return null;
  for (const entry of ["server.js", "index.js", "app.js"]) {
    if (existsSync(path.join(dir, entry))) return { dir, entry };
  }
  return null;
}

export type StartResult =
  | { ok: true; app: RunningApp; alreadyRunning: boolean }
  | { ok: false; reason: string };

/**
 * Start an app in the workspace and wait for it to answer.
 *
 * `project` is the folder name under the workspace. One instance per app: a
 * second start of an app already up returns the one that is up. Over the cap,
 * the app that has been running longest is stopped to make room. The server
 * is told its port through the environment, exactly as the smoke test tells
 * it (PORT), and is confirmed live by its own /health before this returns -
 * a URL that does not answer is worse than an honest failure.
 */
export async function startApp(project: string): Promise<StartResult> {
  const clean = projectFolderName(project);
  const existing = running.get(clean);
  if (existing && !existing.exited && existing.child.exitCode === null) {
    const { child: _child, exited: _exited, ...app } = existing;
    return { ok: true, app, alreadyRunning: true };
  }

  const found = serverEntry(clean);
  if (!found) {
    return { ok: false, reason: `${project} has no server.js to run. build_app writes one; a plain folder cannot be launched.` };
  }

  installCleanup();

  // Make room. The longest-running is stopped first; insertion order in the
  // Map is start order, so the first live entry is the oldest.
  for (const [name, tracked] of running) {
    if (running.size < maxRunningApps) break;
    if (!tracked.exited) stopApp(name);
  }

  let port: number;
  try {
    port = await freePort();
  } catch {
    return { ok: false, reason: "no free port was available to start the app on" };
  }
  const url = `http://localhost:${port}`;

  const child = spawn(process.execPath, [found.entry], {
    cwd: found.dir,
    env: { ...process.env, PORT: String(port), SMOKE_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
    // Its own process group off Windows, so killTree reaches anything it
    // spawns; windowsHide keeps a console from flashing up.
    detached: process.platform !== "win32",
    windowsHide: true
  });

  if (!child.pid) {
    return { ok: false, reason: "the app process could not be started" };
  }

  const output: string[] = [];
  const record = (chunk: Buffer): void => {
    for (const line of chunk.toString("utf8").split(/\r?\n/)) {
      if (line.trim()) output.push(line);
    }
    while (output.length > outputLines) output.shift();
  };
  child.stdout?.on("data", record);
  child.stderr?.on("data", record);

  const tracked: Tracked = {
    project: clean, port, url, pid: child.pid,
    startedAt: new Date().toISOString(), output, child, exited: false
  };
  running.set(clean, tracked);

  child.on("exit", () => {
    tracked.exited = true;
    // Left in the map only if it is still the current entry, so a restart
    // that replaced it is not clobbered by the old process's exit.
    if (running.get(clean) === tracked) running.delete(clean);
  });

  const ready = await waitUntilReady(url, child);
  if (!ready.ok) {
    killTree(child);
    running.delete(clean);
    const tail = output.length > 0 ? ` Last output: ${output.slice(-3).join(" / ")}` : "";
    return { ok: false, reason: `${project} started but ${ready.reason}.${tail}` };
  }

  const { child: _child, exited: _exited, ...app } = tracked;
  return { ok: true, app, alreadyRunning: false };
}

/** Stop one app. Returns whether it was running. */
export function stopApp(project: string): boolean {
  const clean = projectFolderName(project);
  const tracked = running.get(clean);
  if (!tracked) return false;
  killTree(tracked.child);
  running.delete(clean);
  return true;
}

/** Stop every running app. Called on API shutdown. */
export function stopAllApps(): void {
  for (const tracked of running.values()) killTree(tracked.child);
  running.clear();
}

/** Test seam. */
export function resetRunningApps(): void {
  stopAllApps();
}
