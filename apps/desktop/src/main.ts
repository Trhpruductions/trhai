import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { constants as fsConstants, existsSync, statfsSync } from "node:fs";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import { getDetachedSpawnConfig, getServiceSpawnOptions } from "./launcher.js";
import { containPath, isSafeExternalUrl, isTrustedAppUrl } from "./pathGuard.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveWorkspaceRoot(): string {
  const candidateRoots = [
    process.env.ASCEND_WORKSPACE_ROOT,
    path.resolve(__dirname, "../../.."),
    path.resolve(path.dirname(process.execPath), "../../.."),
    path.resolve(path.dirname(process.execPath), "../../../..")
  ].filter((entry): entry is string => Boolean(entry));

  for (const candidateRoot of candidateRoots) {
    if (requireFsExists(candidateRoot)) {
      return candidateRoot;
    }
  }

  return path.resolve(__dirname, "../../..");
}

function requireFsExists(candidatePath: string): boolean {
  try {
    const normalized = path.resolve(candidatePath);
    return !!normalized && existsSync(path.join(normalized, "package.json"));
  } catch {
    return false;
  }
}

const workspaceRoot = resolveWorkspaceRoot();
const webPort = Number(process.env.ASCEND_WEB_PORT ?? 5173);
const localWebBuildPath = path.resolve(workspaceRoot, "apps/web/dist/index.html");
const fallbackHtmlPath = path.resolve(__dirname, "../renderer/index.html");
const desktopHost = process.env.ASCEND_DESKTOP_HOST ?? "127.0.0.1";
const autoStartDisabled = process.env.ASCEND_DISABLE_AUTOSTART === "1";
const forceFallbackRenderer = process.env.ASCEND_FORCE_FALLBACK_RENDERER === "1";
const startupRetryDelayMs = Number(process.env.ASCEND_STARTUP_RETRY_DELAY_MS ?? 1500);
const logoPath = path.resolve(workspaceRoot, "apps/web/public/branding/ascend-logo.png");

type CpuSnapshot = {
  idle: number;
  total: number;
};

let lastCpuSnapshot: CpuSnapshot | null = null;

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function readCpuSnapshot(): CpuSnapshot {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;

  for (const cpu of cpus) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }

  return { idle, total };
}

function getCpuUsagePercent(): number {
  const current = readCpuSnapshot();
  if (!lastCpuSnapshot) {
    lastCpuSnapshot = current;
    return 0;
  }

  const idleDelta = current.idle - lastCpuSnapshot.idle;
  const totalDelta = current.total - lastCpuSnapshot.total;
  lastCpuSnapshot = current;

  if (totalDelta <= 0) {
    return 0;
  }

  return clampPercent((1 - idleDelta / totalDelta) * 100);
}

function getStorageUsagePercent(): number {
  try {
    const stats = statfsSync(workspaceRoot);
    const totalBlocks = Number(stats.blocks ?? 0);
    const availableBlocks = Number(stats.bavail ?? 0);
    if (totalBlocks <= 0) {
      return 0;
    }

    const usedRatio = 1 - availableBlocks / totalBlocks;
    return clampPercent(usedRatio * 100);
  } catch {
    return 0;
  }
}

function getNetworkSignal(): { type: string; qualityPercent: number } {
  const interfaces = os.networkInterfaces();
  const externalNames = Object.entries(interfaces)
    .filter(([, records]) => (records ?? []).some((record) => !record.internal))
    .map(([name]) => name);

  if (!externalNames.length) {
    return { type: "OFFLINE", qualityPercent: 0 };
  }

  const candidate = externalNames[0].toLowerCase();
  if (candidate.includes("wi-fi") || candidate.includes("wifi") || candidate.includes("wlan")) {
    return { type: "WIFI", qualityPercent: 76 };
  }

  if (candidate.includes("eth") || candidate.includes("ethernet")) {
    return { type: "ETHERNET", qualityPercent: 92 };
  }

  return { type: "ONLINE", qualityPercent: 70 };
}

type HostProject = {
  name: string;
  path: string;
  group: "workspace" | "app" | "package" | "generated";
};

type StorageDevice = {
  name: string;
  mountPath: string;
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  usedPercent: number;
};

const ignoredProjectFolders = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "release",
  ".next",
  ".ascend-temp",
  ".turbo"
]);

async function fileExists(candidatePath: string): Promise<boolean> {
  try {
    await access(candidatePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function collectProjectsFrom(baseDir: string, group: HostProject["group"]): Promise<HostProject[]> {
  const projects: HostProject[] = [];
  if (!(await fileExists(baseDir))) {
    return projects;
  }

  const entries = await readdir(baseDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (ignoredProjectFolders.has(entry.name)) continue;

    const projectRoot = path.join(baseDir, entry.name);
    const packageJsonPath = path.join(projectRoot, "package.json");
    if (await fileExists(packageJsonPath)) {
      projects.push({
        name: entry.name,
        path: path.resolve(projectRoot),
        group
      });
    }
  }

  return projects;
}

async function buildProjectInventory(): Promise<HostProject[]> {
  const rootPackageExists = await fileExists(path.join(workspaceRoot, "package.json"));
  const rootItem: HostProject[] = rootPackageExists
    ? [{ name: path.basename(workspaceRoot), path: path.resolve(workspaceRoot), group: "workspace" }]
    : [];

  const [apps, packages, generated] = await Promise.all([
    collectProjectsFrom(path.join(workspaceRoot, "apps"), "app"),
    collectProjectsFrom(path.join(workspaceRoot, "packages"), "package"),
    collectProjectsFrom(path.join(workspaceRoot, "generated-projects"), "generated")
  ]);

  const all = [...rootItem, ...apps, ...packages, ...generated];
  const seen = new Set<string>();
  return all.filter((project) => {
    if (seen.has(project.path)) return false;
    seen.add(project.path);
    return true;
  });
}

function enumerateStorageDevices(): StorageDevice[] {
  const devices: StorageDevice[] = [];
  for (let code = 67; code <= 90; code += 1) {
    const letter = String.fromCharCode(code);
    const mountPath = `${letter}:\\`;
    if (!existsSync(mountPath)) continue;

    try {
      const stats = statfsSync(mountPath);
      const blockSize = Number(stats.bsize || 4096);
      const totalBytes = Math.max(0, Number(stats.blocks ?? 0) * blockSize);
      const freeBytes = Math.max(0, Number(stats.bavail ?? stats.bfree ?? 0) * blockSize);
      const usedBytes = Math.max(0, totalBytes - freeBytes);
      const usedPercent = totalBytes > 0 ? clampPercent((usedBytes / totalBytes) * 100) : 0;

      devices.push({
        name: `${letter}:`,
        mountPath,
        totalBytes,
        freeBytes,
        usedBytes,
        usedPercent
      });
    } catch {
      // Skip inaccessible volumes.
    }
  }

  return devices;
}

ipcMain.handle("ascend:get-system-telemetry", async () => {
  try {
    const cpuPercent = getCpuUsagePercent();
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const usedMemoryPercent = totalMemory > 0 ? clampPercent(((totalMemory - freeMemory) / totalMemory) * 100) : 0;
    const storagePercent = getStorageUsagePercent();
    const network = getNetworkSignal();

    return {
      ok: true,
      source: "host",
      timestamp: Date.now(),
      cpuPercent,
      memoryPercent: usedMemoryPercent,
      storagePercent,
      networkPercent: network.qualityPercent,
      networkType: network.type
    };
  } catch (error) {
    return {
      ok: false,
      source: "host",
      timestamp: Date.now(),
      error: error instanceof Error ? error.message : "Failed to read host telemetry."
    };
  }
});

ipcMain.handle("ascend:list-project-inventory", async () => {
  try {
    const projects = await buildProjectInventory();
    return { ok: true, projects };
  } catch (error) {
    return {
      ok: false,
      projects: [],
      error: error instanceof Error ? error.message : "Failed to collect project inventory."
    };
  }
});

ipcMain.handle("ascend:list-storage-devices", async () => {
  try {
    const devices = enumerateStorageDevices();
    return { ok: true, devices };
  } catch (error) {
    return {
      ok: false,
      devices: [],
      error: error instanceof Error ? error.message : "Failed to collect storage devices."
    };
  }
});

ipcMain.handle("ascend:open-path", async (_event, targetPath) => {
  try {
    const candidate = typeof targetPath === "string" ? targetPath : "";
    if (!candidate) {
      return { ok: false, error: "Missing target path." };
    }

    const normalized = path.resolve(candidate);
    if (!existsSync(normalized)) {
      return { ok: false, error: "Target path does not exist." };
    }

    const openError = await shell.openPath(normalized);
    if (openError) {
      return { ok: false, error: openError };
    }

    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Failed to open path."
    };
  }
});

ipcMain.handle("ascend:create-scaffold", async (_event, payload) => {
  try {
    const request = payload?.request as string | undefined;
    const spec = payload?.spec as { path?: string; fileName?: string; content?: string } | undefined;

    if (!request || !spec?.path || !spec?.fileName || typeof spec.content !== "string") {
      return { ok: false, created: false, error: "Invalid scaffold payload." };
    }

    // Confined the same way run-command confines its working directory. Without
    // this a spec path of ".." or an absolute path wrote outside the workspace.
    const contained = containPath(workspaceRoot, spec.path, spec.fileName);
    if (!contained.ok) {
      return { ok: false, created: false, error: contained.reason };
    }

    const targetPath = contained.path;
    const targetDir = path.dirname(targetPath);

    await mkdir(targetDir, { recursive: true });
    await writeFile(targetPath, spec.content, "utf8");

    return {
      ok: true,
      created: true,
      path: path.relative(workspaceRoot, targetPath).split(path.sep).join("/"),
      message: `Created scaffold for ${request}`
    };
  } catch (error) {
    return {
      ok: false,
      created: false,
      error: error instanceof Error ? error.message : "Failed to create scaffold."
    };
  }
});

ipcMain.handle("ascend:run-command", async (event, payload) => {
  const command = typeof payload?.command === "string" ? payload.command.trim() : "";
  const requestedCwd = typeof payload?.cwd === "string" ? payload.cwd.trim() : "";
  const runId = randomUUID();

  if (!command) {
    return { ok: false, runId, exitCode: -1, error: "Missing command." };
  }

  const containedCwd = requestedCwd ? containPath(workspaceRoot, requestedCwd) : { ok: true as const, path: workspaceRoot };
  if (!containedCwd.ok) {
    return { ok: false, runId, exitCode: -1, error: "Command cwd must be inside workspace." };
  }
  const candidateCwd = containedCwd.path;

  if (!existsSync(candidateCwd)) {
    return { ok: false, runId, exitCode: -1, error: "Command cwd does not exist." };
  }

  const emitEvent = (kind: "start" | "stdout" | "stderr" | "exit", line: string, level: "info" | "ok" | "warn" | "error" = "info") => {
    event.sender.send("ascend:runtime-event", {
      runId,
      kind,
      line,
      level,
      timestamp: Date.now()
    });
  };

  return await new Promise<{ ok: boolean; runId: string; exitCode: number; error?: string }>((resolve) => {
    emitEvent("start", `[run:${runId}] ${command}`, "info");

    const child = spawn("cmd.exe", ["/d", "/s", "/c", command], {
      cwd: candidateCwd,
      windowsHide: true,
      env: process.env
    });

    let stdoutBuffer = "";
    let stderrBuffer = "";

    const flushLines = (buffer: string, kind: "stdout" | "stderr", level: "info" | "warn") => {
      const parts = buffer.split(/\r?\n/);
      const trailing = parts.pop() ?? "";
      for (const line of parts) {
        const trimmed = line.trimEnd();
        if (!trimmed) continue;
        emitEvent(kind, trimmed, level);
      }
      return trailing;
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdoutBuffer += chunk.toString();
      stdoutBuffer = flushLines(stdoutBuffer, "stdout", "info");
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrBuffer += chunk.toString();
      stderrBuffer = flushLines(stderrBuffer, "stderr", "warn");
    });

    child.on("error", (spawnError) => {
      const message = spawnError instanceof Error ? spawnError.message : "Failed to start command.";
      emitEvent("stderr", message, "error");
      emitEvent("exit", `[run:${runId}] failed`, "error");
      resolve({ ok: false, runId, exitCode: -1, error: message });
    });

    child.on("close", (code) => {
      const safeCode = typeof code === "number" ? code : -1;

      const trailingStdout = stdoutBuffer.trim();
      if (trailingStdout) {
        emitEvent("stdout", trailingStdout, "info");
      }

      const trailingStderr = stderrBuffer.trim();
      if (trailingStderr) {
        emitEvent("stderr", trailingStderr, "warn");
      }

      const ok = safeCode === 0;
      emitEvent("exit", `[run:${runId}] exit ${safeCode}`, ok ? "ok" : "error");
      resolve({ ok, runId, exitCode: safeCode, ...(ok ? {} : { error: `Command exited with code ${safeCode}` }) });
    });
  });
});

const singleInstanceLock = app.requestSingleInstanceLock();

if (!singleInstanceLock) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
let webRetryTimer: NodeJS.Timeout | null = null;
let webRetryInFlight = false;
let navigationAttemptCount = 0;
let desktopStartUrl = process.env.DESKTOP_START_URL ?? "";

async function pathExists(candidatePath: string): Promise<boolean> {
  try {
    await access(candidatePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Services this shell started, so it can stop them again on the way out. */
const startedServices: Array<{ label: string; pid: number }> = [];

function spawnDetachedCommand(label: string, command: string, args: string[], env?: NodeJS.ProcessEnv) {
  const spawnConfig = getDetachedSpawnConfig(command, args);

  // See getServiceSpawnOptions: on Windows this must not detach, or each
  // service opens its own console window on the way up.
  const options = getServiceSpawnOptions();

  const child = spawn(spawnConfig.command, spawnConfig.args, {
    cwd: workspaceRoot,
    ...options,
    env: env ? { ...process.env, ...env } : process.env
  });

  if (options.detached) child.unref();
  if (child.pid !== undefined) startedServices.push({ label, pid: child.pid });

  return label;
}

/**
 * Stop what this shell started.
 *
 * Only its own children, by pid, and only the ones it actually spawned — a
 * service that was already running when the app opened was never added to the
 * list, so closing the app does not take down something the user started.
 *
 * Without this, a session left a trail of orphaned node processes: closing the
 * window stopped the window, and the API kept running with its port held.
 */
function stopStartedServices(): void {
  while (startedServices.length > 0) {
    const service = startedServices.pop();
    if (!service) continue;

    try {
      if (process.platform === "win32") {
        // The child is a cmd.exe shim; killing it leaves npm and node behind,
        // so the whole tree goes. Hidden, or this would flash a console of its
        // own on the way out.
        spawn("taskkill", ["/pid", String(service.pid), "/t", "/f"], {
          stdio: "ignore",
          windowsHide: true
        });
      } else {
        process.kill(-service.pid, "SIGTERM");
      }
    } catch {
      // Already gone, or not ours any more. Quitting must not be blocked by it.
    }
  }
}

function clearWebRetryTimer() {
  if (!webRetryTimer) return;
  clearInterval(webRetryTimer);
  webRetryTimer = null;
}

async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  const hosts = ["127.0.0.1", "localhost"];

  while (Date.now() - start < timeoutMs) {
    const statuses = await Promise.all(
      hosts.map(
        (host) =>
          new Promise<boolean>((resolve) => {
            const socket = net.connect({ host, port }, () => {
              socket.destroy();
              resolve(true);
            });

            socket.setTimeout(400);
            socket.on("timeout", () => {
              socket.destroy();
              resolve(false);
            });
            socket.on("error", () => resolve(false));
          })
      )
    );

    if (statuses.some(Boolean)) {
      return true;
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 600));
  }

  return false;
}

function isNavigationAbort(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const maybeCode = "code" in error ? (error as { code?: unknown }).code : undefined;
  const maybeErrno = "errno" in error ? (error as { errno?: unknown }).errno : undefined;

  return maybeCode === "ERR_ABORTED" || maybeErrno === -3;
}

async function waitForApiHealth(timeoutMs: number): Promise<boolean> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch("http://127.0.0.1:4000/health", {
        method: "GET",
        cache: "no-store"
      });

      if (response.ok) {
        return true;
      }
    } catch {
      // Keep probing until timeout.
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 700));
  }

  return false;
}

/**
 * Where model weights live.
 *
 * Defaults beside the workspace rather than under the user profile: models are
 * gigabytes, and the system drive is usually the one without room for them —
 * on this machine C: was full while the workspace drive had terabytes free.
 * An explicit OLLAMA_MODELS still wins.
 */
function resolveModelStore(): string {
  const configured = process.env.OLLAMA_MODELS;
  if (configured) return configured;
  return path.join(path.parse(workspaceRoot).root, "Ollama", "models");
}

/** Where Ollama installs itself on Windows, per user. */
function localModelBinary(): string {
  const configured = process.env.OLLAMA_BINARY;
  if (configured) return configured;
  const localAppData = process.env.LOCALAPPDATA ?? "";
  return path.join(localAppData, "Programs", "Ollama", "ollama.exe");
}

/**
 * Start the local model server if it is installed but not listening.
 *
 * Absence stays fine: with no Ollama installed this does nothing and the
 * assistant behaves exactly as it did before, answering from memory and
 * documents and saying plainly when it has nothing. This only removes the need
 * to start a second application by hand.
 */
/** How many models a server on this port is actually offering, or null. */
async function countServedModels(port: number): Promise<number | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/tags`, {
      signal: AbortSignal.timeout(2500)
    });
    if (!response.ok) return null;

    const payload = await response.json() as { models?: unknown };
    return Array.isArray(payload.models) ? payload.models.length : null;
  } catch {
    return null;
  }
}

/** Whether the store this app is configured for actually holds a model. */
async function modelStoreHasModels(): Promise<boolean> {
  try {
    const manifests = path.join(resolveModelStore(), "manifests");
    await access(manifests, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Make sure a model server with actual models is reachable, and say where.
 *
 * Returns the base URL the API should talk to, or null when there is no usable
 * model server — in which case the assistant answers from memory and documents
 * and says plainly that it has no model, exactly as it did before.
 *
 * Absence stays fine: with no Ollama installed this does nothing at all.
 */
async function ensureLocalModelServer(): Promise<string | null> {
  const port = Number(process.env.OLLAMA_PORT ?? 11434);
  const defaultUrl = `http://127.0.0.1:${port}`;

  if (await waitForPort(port, 800)) {
    // A listening port is not the same as a usable model server.
    //
    // Ollama's tray autostart runs before this app and inherits whatever
    // environment it was launched with — which on this machine did not include
    // OLLAMA_MODELS. It then reads an empty default store, serves zero models,
    // and holds the port. This used to return here on the strength of the port
    // alone, so the assistant silently lost a model that was installed all
    // along.
    const served = await countServedModels(port);
    if (served === null || served > 0) return defaultUrl;
    if (!(await modelStoreHasModels())) return defaultUrl;

    // Deliberately not killing it. The tray app supervises that process and
    // respawns it within seconds, with the same empty environment — so killing
    // it destroys something the user started and fixes nothing. Standing up a
    // second server on a port of our own is both non-destructive and reliable.
    return startOwnModelServer(fallbackModelPort);
  }

  return startOwnModelServer(port);
}

/** A port of this app's own, used when the default one is already occupied. */
const fallbackModelPort = Number(process.env.OLLAMA_FALLBACK_PORT ?? 11435);

/**
 * Start a model server pointed at this app's own store.
 *
 * Told explicitly where the models are: a child inherits its parent's
 * environment block, not the registry, so an OLLAMA_MODELS set after this
 * shell's parent started is invisible here.
 */
async function startOwnModelServer(port: number): Promise<string | null> {
  const url = `http://127.0.0.1:${port}`;

  // Already running from a previous launch of this app.
  if (await waitForPort(port, 400)) {
    return (await countServedModels(port)) ? url : null;
  }

  const binary = localModelBinary();
  if (!(await pathExists(binary))) return null;

  spawnDetachedCommand("Ollama", binary, ["serve"], {
    OLLAMA_MODELS: resolveModelStore(),
    OLLAMA_HOST: `127.0.0.1:${port}`
  });

  // Loading is quick; the model itself is only read on the first question.
  if (!(await waitForPort(port, 15000))) return null;
  return url;
}

async function ensureSelfHostedServices() {
  if (autoStartDisabled) return;
  if (!(await pathExists(path.resolve(workspaceRoot, "package.json")))) return;

  const apiPortReady = await waitForPort(4000, 1200);
  const webPortReady = await waitForPort(webPort, 1200);
  const apiReady = apiPortReady ? await waitForApiHealth(2500) : false;

  // The local model server is started here for the same reason the API and web
  // client are: opening this app should be the only thing the user has to do.
  // Leaving it to them made Ollama a second app to remember, and the assistant
  // silently fell back to "I don't have anything saved" whenever it was not
  // already running.
  const modelUrl = await ensureLocalModelServer();

  if (!apiReady) {
    // The API is told where the model server actually is. When the default port
    // is held by a server with no models, ours is on a different one, and the
    // API would otherwise keep asking the empty one.
    spawnDetachedCommand("Ascend API", "npm.cmd", ["run", "dev:api"],
      modelUrl ? { OLLAMA_BASE_URL: modelUrl } : undefined);
  }

  if (!webPortReady) {
    spawnDetachedCommand("Ascend Web", "npm.cmd", ["run", "dev:web"]);
  }

  // First launch can require extra time while tsx/vite warm up.
  const apiHealthy = apiReady ? true : await waitForApiHealth(45000);
  const webReady = await waitForPort(webPort, 45000);

  if (!apiHealthy) {
    console.error("[desktop] API health endpoint did not become ready within timeout");
  }

  if (!webReady) {
    console.error("[desktop] Web client port did not become ready within timeout");
    await access(fallbackHtmlPath, fsConstants.F_OK);
  }
}

async function renderInlineShell(reason: string, details?: string) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const fallbackPath = path.resolve(workspaceRoot, ".ascend-temp", "desktop-shell.html");
  const html = `<!doctype html><html><head><meta charset="utf-8"/><title>Ascend AI Desktop</title><style>body{font-family:Segoe UI,sans-serif;background:#07111f;color:#f5f9ff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}div{max-width:640px;padding:24px;border:1px solid #2c4d74;border-radius:16px;background:rgba(3,12,24,.9)}h1{margin-top:0;font-size:28px}p{line-height:1.6}</style></head><body><div><h1>Ascend AI Desktop</h1><p>The desktop shell is running.</p><p>${reason}</p>${details ? `<p>${details}</p>` : ""}</div></body></html>`;

  try {
    await mkdir(path.dirname(fallbackPath), { recursive: true });
    await writeFile(fallbackPath, html, "utf8");
    await mainWindow.loadFile(fallbackPath);
  } catch (error) {
    console.error(`[desktop] Inline shell render issue (${reason})`, error);
  }
}

async function tryLoadDesktopStartUrl(): Promise<boolean> {
  if (!mainWindow || mainWindow.isDestroyed()) return false;

  const builtIndexPath = path.resolve(workspaceRoot, "apps/web/dist/index.html");
  const builtIndexExists = await pathExists(builtIndexPath);

  if (builtIndexExists) {
    try {
      await mainWindow.loadURL(`http://${desktopHost}:${webPort}`);
      return true;
    } catch (error) {
      if (isNavigationAbort(error)) {
        return false;
      }

      console.error("[desktop] Failed to load built web app", error);
    }
  }

  try {
    await mainWindow.loadURL(desktopStartUrl);
    return true;
  } catch (error) {
    if (isNavigationAbort(error)) {
      return false;
    }

    console.error("[desktop] Failed to load start URL", error);
    return false;
  }
}

function scheduleWebRetry() {
  if (webRetryTimer) return;

  webRetryTimer = setInterval(async () => {
    if (!mainWindow || mainWindow.isDestroyed() || webRetryInFlight) return;

    webRetryInFlight = true;
    try {
      const ready = await waitForPort(webPort, 1000);
      if (!ready || !mainWindow || mainWindow.isDestroyed()) {
        return;
      }

      navigationAttemptCount += 1;
      if (navigationAttemptCount > 15) {
        clearWebRetryTimer();
        await renderInlineShell("The local web app is still unreachable after repeated attempts.", `Try opening ${desktopStartUrl} directly in a browser.`);
        return;
      }

      clearWebRetryTimer();
      const loaded = await tryLoadDesktopStartUrl();
      if (!loaded) {
        await renderInlineShell("The local web app could not be loaded automatically.", `You can still open ${desktopStartUrl} manually.`);
      }
    } catch (error) {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (isNavigationAbort(error)) {
        return;
      }

      console.error("[desktop] Failed to load start URL; retrying", error);
    } finally {
      webRetryInFlight = false;
    }
  }, startupRetryDelayMs);
}

async function loadDesktopContent() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  navigationAttemptCount = 0;

  if (forceFallbackRenderer) {
    await renderInlineShell("The desktop shell is running in fallback mode.", "The local web app will be attempted automatically next.");
    return;
  }

  const resolvedStartUrl = process.env.DESKTOP_START_URL ?? `http://${desktopHost}:${webPort}`;
  desktopStartUrl = resolvedStartUrl;

  try {
    const builtIndexExists = await pathExists(path.resolve(workspaceRoot, "apps/web/dist/index.html"));
    if (builtIndexExists) {
      const portReady = await waitForPort(webPort, 4000);
      if (portReady) {
        const loaded = await tryLoadDesktopStartUrl();
        if (!loaded) {
          await renderInlineShell("The desktop shell is ready.", `Open the web app at ${desktopStartUrl} manually if it does not appear automatically.`);
        }
        console.log(`[desktop] Desktop shell targeting built app at ${desktopStartUrl}; port ready=${portReady}`);
      } else {
        await renderInlineShell("The desktop shell is ready.", `The web app should appear at ${desktopStartUrl} once it is available.`);
      }
    } else {
      const portReady = await waitForPort(webPort, 4000);
      if (portReady) {
        const loaded = await tryLoadDesktopStartUrl();
        if (!loaded) {
          await renderInlineShell("The desktop shell is ready.", `Open the web app at ${desktopStartUrl} manually if it does not appear automatically.`);
        }
        console.log(`[desktop] Desktop shell targeting ${desktopStartUrl}; port ready=${portReady}`);
      } else {
        await renderInlineShell("The desktop shell is ready.", `The web app should appear at ${desktopStartUrl} once it is available.`);
      }
    }
  } catch (error) {
    if (isNavigationAbort(error)) {
      return;
    }

    console.error("[desktop] Initial inline shell render failed", error);
  }

  scheduleWebRetry();
}

function attachWindowLifecycle() {
  if (!mainWindow) return;

  mainWindow.webContents.on("did-finish-load", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.webContents.getURL() === desktopStartUrl) {
      clearWebRetryTimer();
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    title: "Ascend AI Desktop",
    autoHideMenuBar: true,
    show: false,
    backgroundColor: "#07111f",
    icon: logoPath,
    webPreferences: {
      preload: path.resolve(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.once("ready-to-show", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // openExternal hands the string to the OS, which will start far more than a
    // web page — file:, javascript:, or any protocol another installed app has
    // registered. Only web-ish schemes leave the window.
    if (isSafeExternalUrl(url)) {
      void shell.openExternal(url);
    } else {
      console.warn(`[desktop] Refused to open external URL: ${url}`);
    }
    return { action: "deny" };
  });

  // The window carries a preload bridge that can run shell commands, so it must
  // never end up somewhere untrusted. Nothing navigated it away before, but
  // nothing stopped a redirect or an injected location change either.
  mainWindow.webContents.on("will-navigate", (navigationEvent, url) => {
    if (isTrustedAppUrl(url)) return;
    navigationEvent.preventDefault();
    console.warn(`[desktop] Blocked navigation to ${url}`);
  });

  mainWindow.webContents.on("will-redirect", (navigationEvent, url) => {
    if (isTrustedAppUrl(url)) return;
    navigationEvent.preventDefault();
    console.warn(`[desktop] Blocked redirect to ${url}`);
  });

  mainWindow.webContents.on("did-fail-load", (_event, _errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || !mainWindow) return;
    if (!validatedURL.startsWith("http://127.0.0.1:") && !validatedURL.startsWith("http://localhost:")) return;

    console.error(`[desktop] Web client load failed: ${validatedURL} (${errorDescription})`);
    void renderInlineShell("The app URL could not be loaded automatically.", `The desktop window remains available while you try ${desktopStartUrl}.`);
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    clearWebRetryTimer();
  });

  attachWindowLifecycle();
  void loadDesktopContent();
}

app.whenReady().then(() => {
  createWindow();
  void ensureSelfHostedServices();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.focus();
});

app.on("window-all-closed", () => {
  clearWebRetryTimer();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  clearWebRetryTimer();
  // Closing the app closes what the app started. Otherwise a session left
  // orphaned node processes holding port 4000, and the next launch found the
  // port busy with a server it could no longer talk to.
  stopStartedServices();
});
