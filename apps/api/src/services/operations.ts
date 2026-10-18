// Everything TRH AI needs in order to run, checked now, with what to do about each thing that is not right.
//
// Two halves. gatherFacts() looks at this PC and does all the reading;
// operationsFrom() turns those facts into rows and does no I/O at all, so the
// judgement - what counts as good, what counts as a warning, what to tell
// someone to do - can be tested without a machine to test it on.
//
// Every row is a real reading. A thing that cannot be read is shown as such,
// never as ready; a thing the app can run without (voice, video) is a warning
// that says what stops working, not a failure.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readLocalModelConfig } from "./localModel.js";
import { discoverModels, enginePaths } from "./modelEngine.js";
import { persistenceFailures } from "./persistenceHealth.js";
import { piperRoot, piperStatus } from "./piperSpeech.js";
import { lockedProtectedFiles } from "./protectedJson.js";
import { engineRuntime } from "./runtimeStatus.js";
import { listSchedules } from "./scheduleStore.js";
import { whisperRoot, whisperStatus } from "./whisperTranscribe.js";
import { workspaceRoot } from "./workspace.js";
import { resolveElectronBinary } from "./frameRenderer.js";

export type OperationStatus = "ok" | "warn" | "fail";

export type OperationRow = {
  id: string;
  label: string;
  group: "Core" | "Model" | "Voice" | "Media" | "Data" | "This PC";
  status: OperationStatus;
  /** What was found, in plain words. */
  detail: string;
  /** What to do, when the status is not ok. */
  fix?: string;
};

export type OperationFacts = {
  api: { uptimeSeconds: number };
  web: { reachable: boolean; url: string };
  desktop: { applicable: boolean; installed: boolean };
  engine: { reachable: boolean; version: string | null; reason: string | null; loaded: string[]; installed: string[]; wanted: string };
  piper: { available: boolean; detail: string };
  whisper: { available: boolean; detail: string };
  ffmpeg: { found: boolean };
  workspace: { path: string; writable: boolean; error?: string; freeBytes: number | null };
  stores: { failing: string[]; locked: string[] };
  schedules: { count: number };
  memory: { freeBytes: number; totalBytes: number };
};

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

export function operationsFrom(facts: OperationFacts): OperationRow[] {
  const rows: OperationRow[] = [];

  rows.push({
    id: "api", label: "Local API", group: "Core", status: "ok",
    detail: `Answering, up ${Math.floor(facts.api.uptimeSeconds / 60)} min`
  });

  rows.push(facts.web.reachable
    ? { id: "web", label: "Web app", group: "Core", status: "ok", detail: `Serving at ${facts.web.url}` }
    : {
      id: "web", label: "Web app", group: "Core", status: "fail", detail: `Nothing answered at ${facts.web.url}`,
      fix: "Open TRH AI from its shortcut, or run Launch-TRHAI.bat. If it was just rebuilt, restart it."
    });

  if (facts.desktop.applicable) {
    rows.push(facts.desktop.installed
      ? { id: "desktop", label: "Desktop window", group: "Core", status: "ok", detail: "Installed" }
      : {
        id: "desktop", label: "Desktop window", group: "Core", status: "warn", detail: "The desktop shell is not installed",
        fix: "TRH AI still works in a browser. To get the window, run npm install, then node install.js inside node_modules/electron."
      });
  }

  if (!facts.engine.reachable) {
    rows.push({
      id: "engine", label: "Model engine", group: "Model", status: "fail",
      detail: facts.engine.reason ?? "The model engine is not answering",
      fix: "Open Settings, then Engine and models, to install it. If it is installed, start TRH AI again."
    });
  } else {
    rows.push({
      id: "engine", label: "Model engine", group: "Model", status: "ok",
      detail: `llama.cpp ${facts.engine.version ?? ""}`.trim()
    });
    const present = facts.engine.installed.some((name) => name === facts.engine.wanted || name.startsWith(facts.engine.wanted));
    rows.push(present || facts.engine.installed.length > 0
      ? {
        id: "model", label: "Chat model", group: "Model", status: present ? "ok" : "warn",
        detail: present
          ? `${facts.engine.wanted} is installed${facts.engine.loaded.length ? ` and loaded` : ", loads on the first question"}`
          : `${facts.engine.wanted} is not installed; ${facts.engine.installed[0]} will answer instead`,
        fix: present ? undefined : `Install ${facts.engine.wanted} in Settings, under Engine and models, or pick an installed model there.`
      }
      : {
        id: "model", label: "Chat model", group: "Model", status: "fail", detail: "No model is installed",
        fix: "Open Settings, then Engine and models, and install the model it recommends for this PC."
      });
  }

  rows.push(facts.piper.available
    ? { id: "piper", label: "Voice (Piper)", group: "Voice", status: "ok", detail: facts.piper.detail }
    : {
      id: "piper", label: "Voice (Piper)", group: "Voice", status: "warn", detail: facts.piper.detail,
      fix: `TRH AI cannot speak aloud until Piper and a voice are installed. It looks for them in ${piperRoot()}.`
    });
  rows.push(facts.whisper.available
    ? { id: "whisper", label: "Listening (Whisper)", group: "Voice", status: "ok", detail: facts.whisper.detail }
    : {
      id: "whisper", label: "Listening (Whisper)", group: "Voice", status: "warn", detail: facts.whisper.detail,
      fix: `TRH AI cannot transcribe speech until whisper.cpp and a model are installed. It looks for them in ${whisperRoot()}.`
    });

  rows.push(facts.ffmpeg.found
    ? { id: "ffmpeg", label: "ffmpeg", group: "Media", status: "ok", detail: "Found on PATH" }
    : {
      id: "ffmpeg", label: "ffmpeg", group: "Media", status: "warn", detail: "Not found on PATH",
      fix: "Video making is off until ffmpeg is installed: winget install Gyan.FFmpeg"
    });

  rows.push(facts.workspace.writable
    ? { id: "workspace", label: "Workspace", group: "Data", status: "ok", detail: `Writable: ${facts.workspace.path}` }
    : {
      id: "workspace", label: "Workspace", group: "Data", status: "fail",
      detail: `Cannot write to ${facts.workspace.path}${facts.workspace.error ? `: ${facts.workspace.error}` : ""}`,
      fix: "Check the folder exists and this account can write to it, or set the workspace folder to somewhere that does."
    });

  if (facts.stores.locked.length > 0) {
    rows.push({
      id: "stores", label: "Saved data", group: "Data", status: "fail",
      detail: `Locked and unreadable: ${facts.stores.locked.join(", ")}`,
      fix: "The data key does not match this data. Restore trhai-data.key from the original PC; do not delete the files."
    });
  } else if (facts.stores.failing.length > 0) {
    rows.push({
      id: "stores", label: "Saved data", group: "Data", status: "fail",
      detail: `Not saving: ${facts.stores.failing.join(", ")}`,
      fix: "Check free disk space and that the data folder is writable. Changes there are lost on a restart."
    });
  } else {
    rows.push({ id: "stores", label: "Saved data", group: "Data", status: "ok", detail: "Every store is readable and saving" });
  }

  rows.push({
    id: "schedules", label: "Schedules", group: "Data", status: "ok",
    detail: facts.schedules.count === 0 ? "None set" : `${facts.schedules.count} set`
  });

  const freeFraction = facts.memory.totalBytes > 0 ? facts.memory.freeBytes / facts.memory.totalBytes : 1;
  rows.push(facts.memory.freeBytes < 1024 ** 3 && freeFraction < 0.15
    ? {
      id: "memory", label: "Free memory", group: "This PC", status: "warn",
      detail: `${gb(facts.memory.freeBytes)} free of ${gb(facts.memory.totalBytes)}`,
      fix: "Replies will be slow or the model may be swapped out. Close programs you do not need, or use a smaller model."
    }
    : { id: "memory", label: "Free memory", group: "This PC", status: "ok", detail: `${gb(facts.memory.freeBytes)} free of ${gb(facts.memory.totalBytes)}` });

  if (facts.workspace.freeBytes !== null) {
    const low = facts.workspace.freeBytes < 5 * 1024 ** 3;
    rows.push({
      id: "disk", label: "Free disk", group: "This PC", status: low ? "warn" : "ok",
      detail: `${gb(facts.workspace.freeBytes)} free where the workspace is`,
      fix: low ? "Free some space: videos and built apps are written here." : undefined
    });
  }

  return rows;
}

export function summarise(rows: OperationRow[]): { ready: number; total: number; failing: number; warnings: number } {
  return {
    ready: rows.filter((row) => row.status === "ok").length,
    total: rows.length,
    failing: rows.filter((row) => row.status === "fail").length,
    warnings: rows.filter((row) => row.status === "warn").length
  };
}

// --- the reading half -------------------------------------------------------

let ffmpegCache: { at: number; found: boolean } | null = null;

function ffmpegFound(now = Date.now()): boolean {
  if (ffmpegCache && now - ffmpegCache.at < 30_000) return ffmpegCache.found;
  const probe = spawnSync("ffmpeg -version", { stdio: "ignore", shell: true, timeout: 5000 });
  const found = !probe.error && probe.status === 0;
  ffmpegCache = { at: now, found };
  return found;
}

async function webReachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
    return response.ok;
  } catch {
    return false;
  }
}

function desktopInstalled(): boolean {
  // An installed copy: the shell that started this API names its own
  // Electron, which is the desktop window.
  const shell = process.env.TRHAI_ELECTRON_PATH?.trim();
  if (shell && existsSync(shell)) return true;
  // A checkout: the desktop workspace's own Electron, wherever npm put it -
  // the same lookup video rendering uses.
  return resolveElectronBinary().ok;
}

function probeWorkspace(root: string): { writable: boolean; error?: string } {
  try {
    mkdirSync(root, { recursive: true });
    const probe = path.join(root, ".operations-write-probe");
    writeFileSync(probe, "ok");
    rmSync(probe);
    return { writable: true };
  } catch (error) {
    return { writable: false, error: (error as Error).message };
  }
}

function freeBytesAt(target: string): number | null {
  try {
    const stats = statfsSync(target);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

export async function gatherFacts(webUrl = process.env.TRHAI_WEB_URL ?? "http://127.0.0.1:3210"): Promise<OperationFacts> {
  const config = readLocalModelConfig();
  const [web, engine] = await Promise.all([webReachable(webUrl), engineRuntime(config.baseUrl)]);
  const piper = piperStatus();
  const whisper = whisperStatus();
  const root = workspaceRoot();
  const workspace = probeWorkspace(root);
  const installedFromDisk = discoverModels(enginePaths().modelsDir).map((model) => model.id);

  return {
    api: { uptimeSeconds: process.uptime() },
    web: { reachable: web, url: webUrl },
    desktop: { applicable: process.platform === "win32", installed: desktopInstalled() },
    engine: {
      reachable: engine.reachable,
      version: engine.version,
      reason: engine.reason,
      loaded: engine.loaded.map((model) => model.name),
      installed: engine.installed.length > 0 ? engine.installed.map((model) => model.name) : installedFromDisk,
      wanted: config.model
    },
    piper: piper.available
      ? { available: true, detail: `${piper.voices.length} voice${piper.voices.length === 1 ? "" : "s"}, speaking as ${piper.voice.name}` }
      : { available: false, detail: piper.reason },
    whisper: whisper.available
      ? { available: true, detail: `Model ${whisper.model.id}` }
      : { available: false, detail: whisper.reason },
    ffmpeg: { found: ffmpegFound() },
    workspace: { path: root, writable: workspace.writable, error: workspace.error, freeBytes: freeBytesAt(root) },
    stores: { failing: persistenceFailures().map((entry) => entry.store), locked: lockedProtectedFiles() },
    schedules: { count: listSchedules().length },
    memory: { freeBytes: os.freemem(), totalBytes: os.totalmem() }
  };
}

export async function readOperations(): Promise<{ rows: OperationRow[]; summary: ReturnType<typeof summarise> }> {
  const rows = operationsFrom(await gatherFacts());
  return { rows, summary: summarise(rows) };
}
