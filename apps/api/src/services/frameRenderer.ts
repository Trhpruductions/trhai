// Rendering video frames with a real GPU, using the desktop shell's own
// Electron build rather than adding a second one.
//
// Proven on this machine (see docs/21-handoff.md): a hidden, offscreen
// BrowserWindow reports webgl2-ok and capturePage().toPNG() returns real
// frames. Two things measured the hard way and encoded here rather than left
// for the next run to rediscover:
//
//   - BrowserWindow must be created with `useContentSize: true`. Without it,
//     capturePage() returns 1920x1032 for a "1920x1080" window, because the
//     window size otherwise includes its (invisible, offscreen) chrome.
//   - There is no SVG decoder in this ffmpeg build, so frames are always PNG,
//     never SVG piped through anything.
//
// This module owns the Electron child process. It never runs generated frame
// HTML on the API server's own process — this app writes plain HTML strings
// (see videoScript.ts's sceneHtml) and hands them to a window that exists for
// exactly this and nothing else.

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** One frame to render: the HTML to show and where the PNG should land. */
export type FrameJob = {
  index: number;
  html: string;
  outputPath: string;
};

export type RenderFramesOptions = {
  width: number;
  height: number;
  /** Milliseconds allowed for the whole batch, not per frame. */
  timeoutMs?: number;
};

export type RenderFramesResult =
  | { ok: true; rendered: number }
  | { ok: false; reason: string; rendered: number };

/**
 * Generous for a real batch: dozens of navigations plus a GPU that is also
 * sharing the machine with a loaded language model. TRHAI_RENDER_TIMEOUT_MS
 * overrides for a longer script.
 */
const defaultTimeoutMs = Number(process.env.TRHAI_RENDER_TIMEOUT_MS ?? 300_000);

/**
 * Where the desktop workspace's own Electron lives.
 *
 * Reads the same `path.txt` the `electron` npm package's own loader reads,
 * rather than trusting the `.bin/electron` shim to exist and to resolve the
 * same way on every platform. `TRHAI_DESKTOP_DIR` overrides the desktop
 * workspace's location, and `TRHAI_ELECTRON_PATH` overrides the binary
 * directly — both exist so a test can point this at a stub instead of a real
 * multi-hundred-megabyte Electron binary.
 */
export function resolveElectronBinary(): { ok: true; path: string } | { ok: false; reason: string } {
  const override = process.env.TRHAI_ELECTRON_PATH;
  if (override) {
    return existsSync(override)
      ? { ok: true, path: override }
      : { ok: false, reason: `TRHAI_ELECTRON_PATH is set to "${override}", which does not exist.` };
  }

  const desktopDir = process.env.TRHAI_DESKTOP_DIR ?? path.join(here, "..", "..", "..", "desktop");
  const electronDir = path.join(desktopDir, "node_modules", "electron");
  const pathFile = path.join(electronDir, "path.txt");

  if (!existsSync(pathFile)) {
    return {
      ok: false,
      reason: "Electron is not installed under the desktop workspace (apps/desktop/node_modules/electron). "
        + "Run npm install there first."
    };
  }

  const executableName = readFileSync(pathFile, "utf8").trim();
  const executablePath = path.join(electronDir, "dist", executableName);
  if (!existsSync(executablePath)) {
    return { ok: false, reason: `Electron's own binary is missing at ${executablePath}.` };
  }

  return { ok: true, path: executablePath };
}

/** The Electron main-process script this module spawns. Kept alongside it. */
const rendererScript = path.join(here, "frameRendererElectron.mjs");

/**
 * Render every job to a PNG at its `outputPath`.
 *
 * Verification is by file, not by trusting the child's self-report: after the
 * child exits — cleanly or by timeout — every expected output path is checked
 * for existing and being non-empty. A window that silently produced a black
 * frame would still write a file; that is a quality question this cannot
 * answer, but "a file exists" versus "nothing was written at all" is the
 * distinction that matters for not claiming a render that did not happen.
 */
export async function renderFrames(
  jobs: FrameJob[],
  options: RenderFramesOptions
): Promise<RenderFramesResult> {
  if (jobs.length === 0) return { ok: false, reason: "There were no frames to render.", rendered: 0 };

  const electron = resolveElectronBinary();
  if (!electron.ok) return { ok: false, reason: electron.reason, rendered: 0 };

  const workDir = mkdtempSync(path.join(tmpdir(), "trhai-render-"));
  const manifestPath = path.join(workDir, "manifest.json");
  const resultsPath = path.join(workDir, "results.json");

  writeFileSync(manifestPath, JSON.stringify({
    width: options.width,
    height: options.height,
    resultsPath,
    frames: jobs.map((job) => ({ index: job.index, html: job.html, outputPath: job.outputPath }))
  }));

  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;

  try {
    const failure = await new Promise<string | null>((resolve) => {
      const child = spawn(electron.path, [rendererScript, manifestPath], {
        shell: false,
        windowsHide: true,
        // Offscreen rendering does not need a display, but it does need the
        // GPU process; nothing here disables hardware acceleration.
        env: { ...process.env, ELECTRON_DISABLE_SANDBOX: "1" }
      });

      const timer = setTimeout(() => {
        child.kill();
        resolve(`Rendering took longer than ${Math.round(timeoutMs / 1000)}s and was stopped.`);
      }, timeoutMs);

      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.stdout?.on("data", () => { /* Electron/Chromium logging; not needed on success */ });

      child.on("error", (error) => {
        clearTimeout(timer);
        resolve(`Electron could not be started: ${error.message}`);
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(code === 0 ? null : `Electron exited with code ${code}. ${stderr.slice(-400)}`.trim());
      });
    });

    const rendered = jobs.filter((job) => {
      try {
        return existsSync(job.outputPath) && statSync(job.outputPath).size > 0;
      } catch {
        return false;
      }
    }).length;

    if (rendered < jobs.length) {
      const reason = failure
        ?? `only ${rendered} of ${jobs.length} frames were written`;
      return { ok: false, reason, rendered };
    }

    return { ok: true, rendered };
  } finally {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* a temp manifest is not worth failing over */ }
  }
}

/** A unique frame filename, zero-padded so ffmpeg's %06d pattern matches it. */
export function frameFileName(index: number): string {
  return `frame${String(index).padStart(6, "0")}.png`;
}

/** A workspace-independent scratch directory for one render's frames and audio. */
export function createRenderWorkDir(): string {
  return mkdtempSync(path.join(tmpdir(), `trhai-video-${randomUUID().slice(0, 8)}-`));
}
