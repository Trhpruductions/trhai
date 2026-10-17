// The installed app updating itself: electron-updater against this repo's
// GitHub releases (the "publish" entry in electron-builder.json). No key and no
// account - the same public release page the API's update check reads.
//
// Nothing downloads or installs without being asked: the window shows the
// update (its notes come from the API, services/updates.ts), the person
// chooses to download it, and then to restart into it. A downloaded update
// that is not installed then is installed the next time the app quits.
//
// Status goes to the window as it changes ("ascend:update-status"); the
// window asks through four handlers registered with the same trusted-window
// check every other bridge call has.

import { spawn } from "node:child_process";
import path from "node:path";
import { app, BrowserWindow } from "electron";
import updaterPackage from "electron-updater";
import { encodedCommand, helperPowerShell, plainUpdateError, relaunchScript, updateSupport, type DesktopUpdateStatus } from "./updateState.js";

const { autoUpdater } = updaterPackage;

const statusChannel = "ascend:update-status";
const recheckMs = 6 * 60 * 60 * 1000;

let status: DesktopUpdateStatus = { state: "idle" };
/** The version last seen as available, for progress lines that need it. */
let offered: string | null = null;

function publish(next: DesktopUpdateStatus): void {
  status = next;
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(statusChannel, status);
  }
}

async function check(): Promise<void> {
  if (status.state === "unsupported" || status.state === "downloading" || status.state === "downloaded" || status.state === "checking") return;
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    publish({ state: "error", message: plainUpdateError(error) });
  }
}

async function download(): Promise<void> {
  if (status.state === "unsupported" || status.state === "downloading" || status.state === "downloaded") return;
  if (status.state !== "available") await check();
  if ((status as DesktopUpdateStatus).state !== "available") return;
  publish({ state: "downloading", version: offered ?? "", percent: 0, bytesPerSecond: 0 });
  // Not awaited: the window follows the progress through the status events.
  autoUpdater.downloadUpdate().catch((error: unknown) => publish({ state: "error", message: plainUpdateError(error) }));
}

/**
 * Started detached, so it outlives this process: an ordinary child is put in
 * a job that Windows ends when this process does. PowerShell started detached
 * has no console and exits before running a line, so it is given one that
 * has no window - Windows' own console host, headless - with `cmd /c start`,
 * minimised, as the fallback. Both were tried from outside any job: the
 * helper outlived its launcher, waited for the installer and started the app.
 * Failing to start it only means the person opens the app again themselves.
 */
function startRelaunchHelper(): void {
  const powershell = helperPowerShell(encodedCommand(relaunchScript(process.execPath, process.pid, {
    logPath: path.join(app.getPath("userData"), "logs", "update-restart.log")
  })));
  const launch = (file: string, args: string[]) => {
    const helper = spawn(file, args, { detached: true, stdio: "ignore", windowsHide: true });
    helper.unref();
    return helper;
  };
  try {
    launch("conhost.exe", ["--headless", ...powershell]).on("error", () => {
      try {
        launch("cmd.exe", ["/d", "/c", "start", "\"\"", "/min", ...powershell]);
      } catch (error) {
        console.warn(`[updater] could not arrange the restart after the update: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  } catch (error) {
    console.warn(`[updater] could not arrange the restart after the update: ${error instanceof Error ? error.message : String(error)}`);
  }
}

type Register = (channel: string, listener: () => unknown) => void;

export function startUpdater(register: Register): void {
  const support = updateSupport({ isPackaged: app.isPackaged, platform: process.platform, env: process.env });
  if (!support.supported) status = { state: "unsupported", reason: support.reason };

  register("ascend:update-get", () => status);
  register("ascend:update-check", async () => { await check(); return status; });
  register("ascend:update-download", async () => { await download(); return status; });
  register("ascend:update-install", () => {
    if (status.state !== "downloaded") return status;
    // Quits - which stops the API and the web app, as any quit does - and
    // runs the installer without its pages. The helper started first brings
    // the new version up once the installer has finished (see relaunchScript).
    setImmediate(() => {
      startRelaunchHelper();
      autoUpdater.quitAndInstall(true, true);
    });
    return status;
  });

  if (!support.supported) return;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  // For trying an update without publishing a release: a folder holding
  // latest.yml and the installer, served over http.
  const feed = process.env.TRHAI_DESKTOP_UPDATE_URL?.trim();
  if (feed) autoUpdater.setFeedURL({ provider: "generic", url: feed });

  autoUpdater.on("checking-for-update", () => publish({ state: "checking" }));
  autoUpdater.on("update-available", (info) => {
    offered = info.version;
    publish({ state: "available", version: info.version });
  });
  autoUpdater.on("update-not-available", (info) => publish({ state: "not-available", version: info?.version ?? null }));
  autoUpdater.on("download-progress", (progress) => publish({
    state: "downloading", version: offered ?? "", percent: Math.floor(progress.percent), bytesPerSecond: Math.round(progress.bytesPerSecond)
  }));
  autoUpdater.on("update-downloaded", (info) => publish({ state: "downloaded", version: info.version }));
  autoUpdater.on("error", (error) => publish({ state: "error", message: plainUpdateError(error) }));

  // A little after start, when the window and the services are up, then every
  // few hours for a window left open.
  setTimeout(() => void check(), 20_000);
  setInterval(() => void check(), recheckMs);
}
