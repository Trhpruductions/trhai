// Hearing the words in a song: runs whisper.cpp on it and returns the words
// with the times they were sung. The timing and alignment are lyricTiming.ts;
// this is only the program.
//
// Two things were found by trying it on a song, and both are easy to get wrong:
//
//   - whisper's ordinary word times are stretched across the quiet between
//     lines, so a line sung at 8 s came back as starting at 0 s. Its
//     attention-based times (-dtw) are the ones that land where the voice is.
//   - -dtw works only with flash attention off (-nfa); without it every time
//     comes back as -1 and nothing says why.
//
// If the model has no -dtw preset, or the run fails with it, it is run again
// without, so a song still gets words, with the coarser times.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { wordsFromWhisper, type Word } from "./lyricTiming.js";
import { whisperStatus, type WhisperStatus } from "./whisperTranscribe.js";

/** The models whisper.cpp knows the alignment heads of, by the names its -dtw option takes. */
const presets = new Set(["tiny", "tiny.en", "base", "base.en", "small", "small.en", "medium", "medium.en", "large.v1", "large.v2", "large.v3", "large.v3.turbo"]);

/** The -dtw preset for a model file's name ("ggml-base.en-q5_1" is "base.en"), or null when there is none. */
export function dtwPreset(modelId: string): string | null {
  const stem = modelId.replace(/^ggml-/, "").replace(/-q\d+_\d+$/, "").replace(/-/g, ".");
  return presets.has(stem) ? stem : null;
}

/** One word at a time with its own times (-ml 1, -sow), the whole transcript as JSON with each token's detail (-ojf). */
export function whisperArgs(options: { model: string; wav: string; prefix: string; preset: string | null; threads?: number; english?: boolean }): string[] {
  return [
    "-m", options.model,
    "-f", options.wav,
    "-ojf", "-of", options.prefix,
    "-ml", "1", "-sow",
    "-np", "-pp",
    ...(options.preset ? ["-dtw", options.preset, "-nfa"] : []),
    ...(options.english ? ["-l", "en"] : []),
    ...(options.threads ? ["-t", String(options.threads)] : [])
  ];
}

export type WhisperRunResult = { code: number | null; stderr: string; aborted: boolean; timedOut: boolean };
export type WhisperRun = (program: string, args: string[], options: { cwd: string; timeoutMs: number; signal?: AbortSignal; onStderr?: (text: string) => void }) => Promise<WhisperRunResult>;

export const runWhisper: WhisperRun = (program, args, options) =>
  new Promise((resolve) => {
    if (options.signal?.aborted) { resolve({ code: null, stderr: "", aborted: true, timedOut: false }); return; }
    let child: ReturnType<typeof spawn>;
    try {
      // The binary's own folder: the Windows build keeps its DLLs beside it.
      child = spawn(program, args, { cwd: options.cwd, shell: false, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    } catch (error) {
      resolve({ code: null, stderr: error instanceof Error ? error.message : String(error), aborted: false, timedOut: false });
      return;
    }
    let stderr = "";
    let aborted = false;
    let timedOut = false;
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr = (stderr + text).slice(-4000);
      options.onStderr?.(text);
    });
    const stop = () => { aborted = true; child.kill(); };
    options.signal?.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, options.timeoutMs);
    const finish = (code: number | null, extra = "") => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", stop);
      resolve({ code, stderr: `${stderr}${extra}`.slice(-4000), aborted, timedOut });
    };
    child.on("error", (error) => finish(null, error.message));
    child.on("close", (code) => finish(code));
  });

export type HearOptions = {
  /** 16 kHz mono WAV of the song, which is what whisper.cpp reads. */
  wav: string;
  /** Where the transcript files are written. */
  workDir: string;
  /** Seconds; the longest word time that can be right. */
  duration: number;
  signal?: AbortSignal;
  /** 0 to 1 as it listens. */
  onProgress?: (fraction: number) => void;
  threads?: number;
  /** Stand-ins for tests. */
  status?: WhisperStatus;
  run?: WhisperRun;
};

export type Heard =
  | { ok: true; words: Word[]; model: string; /** Whether the times are whisper's attention times, the exact ones. */ timed: boolean }
  | { ok: false; reason: string; cancelled?: boolean };

/** How long it is allowed, in milliseconds: twice the song and a minute over, so that a slow PC finishes and a stuck one is stopped. */
const allowedMs = (duration: number) => Math.max(120_000, (duration * 2 + 60) * 1000);

export async function hearWords(options: HearOptions): Promise<Heard> {
  const status = options.status ?? whisperStatus();
  if (!status.available) return { ok: false, reason: status.reason };
  const run = options.run ?? runWhisper;
  const cwd = path.dirname(status.binaryPath);

  const attempt = async (preset: string | null): Promise<{ json: unknown } | { failure: string; cancelled?: boolean; final?: boolean }> => {
    const prefix = path.join(options.workDir, preset ? "heard-timed" : "heard-plain");
    rmSync(`${prefix}.json`, { force: true });
    const result = await run(
      status.binaryPath,
      whisperArgs({ model: status.model.modelPath, wav: options.wav, prefix, preset, threads: options.threads, english: status.model.englishOnly }),
      {
        cwd,
        timeoutMs: allowedMs(options.duration),
        signal: options.signal,
        onStderr: (text) => {
          const percent = [...text.matchAll(/progress\s*=\s*(\d+)%/g)].pop();
          if (percent) options.onProgress?.(Math.min(1, Number(percent[1]) / 100));
        }
      }
    );
    if (result.aborted) return { failure: "Cancelled.", cancelled: true };
    // Running it again would only take as long again.
    if (result.timedOut) return { failure: "Listening to the song took too long and was stopped.", final: true };
    if (result.code !== 0) return { failure: `whisper.cpp stopped with code ${result.code}. ${result.stderr.slice(-200)}`.trim() };
    if (!existsSync(`${prefix}.json`)) return { failure: "whisper.cpp finished but wrote no transcript." };
    try {
      return { json: JSON.parse(readFileSync(`${prefix}.json`, "utf8")) as unknown };
    } catch {
      return { failure: "whisper.cpp wrote a transcript that could not be read." };
    }
  };

  const preset = dtwPreset(status.model.id);
  let outcome = await attempt(preset);
  if ("failure" in outcome && !outcome.cancelled && !outcome.final && preset) outcome = await attempt(null);
  if ("failure" in outcome) return { ok: false, reason: outcome.failure, cancelled: outcome.cancelled };
  options.onProgress?.(1);
  return { ok: true, words: wordsFromWhisper(outcome.json, options.duration), model: status.model.id, timed: hasAttentionTimes(outcome.json) };
}

/** Whether the transcript carries whisper's attention times, which are -1 when it could not work them out. */
export function hasAttentionTimes(json: unknown): boolean {
  const segments = (json as { transcription?: Array<{ tokens?: Array<{ t_dtw?: unknown }> }> } | null)?.transcription;
  return Array.isArray(segments) && segments.some((segment) => segment.tokens?.some((token) => typeof token.t_dtw === "number" && token.t_dtw >= 0));
}
