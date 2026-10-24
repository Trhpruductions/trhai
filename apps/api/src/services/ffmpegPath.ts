// Which ffmpeg the app runs.
//
// Making a video needs ffmpeg, and most PCs do not have it. The app installs
// its own (Settings, Engine and models; see toolCatalog.ts) into its runtime
// folder and runs that one when it is there. Otherwise it runs whichever
// ffmpeg is on the PC's PATH, as it always did. TRHAI_FFMPEG_PATH names one
// outright, for someone who wants a particular build.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { runtimeDir } from "./modelEngine.js";

const program = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";

/** Where the app keeps the ffmpeg it installs: bin/ffmpeg.exe under this folder. */
export function ffmpegHome(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(runtimeDir(env), "tools", "ffmpeg");
}

export type FfmpegSource = "named" | "installed" | "path";

/** Where the ffmpeg that would run comes from. "path" means the PC's own, found by name. */
export function ffmpegSource(env: NodeJS.ProcessEnv = process.env): FfmpegSource {
  const named = env.TRHAI_FFMPEG_PATH?.trim();
  if (named && existsSync(named)) return "named";
  return existsSync(path.join(ffmpegHome(env), "bin", program)) ? "installed" : "path";
}

/** What to run: the named file, the app's own copy, or plain "ffmpeg" for the PATH to find. */
export function ffmpegProgram(env: NodeJS.ProcessEnv = process.env): string {
  const source = ffmpegSource(env);
  if (source === "named") return (env.TRHAI_FFMPEG_PATH as string).trim();
  return source === "installed" ? path.join(ffmpegHome(env), "bin", program) : "ffmpeg";
}

let remembered: { at: number; program: string; runs: boolean } | null = null;
let probeRunner: typeof spawnSync = spawnSync;

/** Test seam: what asks ffmpeg whether it runs. Called with nothing, it puts the real one back. */
export function useFfmpegProbe(run?: typeof spawnSync): void {
  probeRunner = run ?? spawnSync;
  remembered = null;
}

/** Whether ffmpeg runs, whichever one it is. Remembered for 30 seconds, because the screens ask often. */
export function ffmpegAvailable(env: NodeJS.ProcessEnv = process.env, now: number = Date.now(), run: typeof spawnSync = probeRunner): boolean {
  const chosen = ffmpegProgram(env);
  if (remembered && remembered.program === chosen && now - remembered.at < 30_000) return remembered.runs;
  const probe = run(chosen, ["-version"], { stdio: "ignore", timeout: 5000, windowsHide: true });
  const runs = !probe.error && probe.status === 0;
  remembered = { at: now, program: chosen, runs };
  return runs;
}

/** Called after ffmpeg is installed, so the next question is asked of the new one. */
export function forgetFfmpegCheck(): void {
  remembered = null;
}
