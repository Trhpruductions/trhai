import { spawn } from "node:child_process";
import net from "node:net";
import { constants as fsConstants, existsSync } from "node:fs";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { access, mkdir, writeFile } from "node:fs/promises";
import { getDetachedSpawnConfig } from "./launcher.js";

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

ipcMain.handle("ascend:create-scaffold", async (_event, payload) => {
  try {
    const request = payload?.request as string | undefined;
    const spec = payload?.spec as { path?: string; fileName?: string; content?: string } | undefined;

    if (!request || !spec?.path || !spec?.fileName || typeof spec.content !== "string") {
      return { ok: false, created: false, error: "Invalid scaffold payload." };
    }

    const targetPath = path.resolve(workspaceRoot, spec.path, spec.fileName);
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

function spawnDetachedCommand(label: string, command: string, args: string[]) {
  const spawnConfig = getDetachedSpawnConfig(command, args);
  const child = spawn(spawnConfig.command, spawnConfig.args, {
    cwd: workspaceRoot,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });

  child.unref();
  return label;
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

async function ensureSelfHostedServices() {
  if (autoStartDisabled) return;
  if (!(await pathExists(path.resolve(workspaceRoot, "package.json")))) return;

  const apiPortReady = await waitForPort(4000, 1200);
  const webPortReady = await waitForPort(webPort, 1200);
  const apiReady = apiPortReady ? await waitForApiHealth(2500) : false;

  if (!apiReady) {
    spawnDetachedCommand("Ascend API", "npm.cmd", ["run", "dev:api"]);
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
    void shell.openExternal(url);
    return { action: "deny" };
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
});
