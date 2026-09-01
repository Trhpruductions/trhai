// Orchestrating a whole video: narrate, render frames, encode, and only then
// say it worked. See docs/21-handoff.md for the design and the constraints —
// this is Task 1 from that handoff.
//
// Order matters here in one specific way: narration happens before frames are
// planned, because a scene's audio can run longer than the duration the
// script asked for, and a scene cut off mid-sentence is the most likely
// quality bug in a pipeline like this. The fix is cheap — extend the scene to
// fit its narration — but only if narration happens first.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  findScriptFault, frameCount, sceneHtml, type Scene, type VideoScript
} from "@ascend/shared";
import { synthesize, type SynthesisOptions, type SynthesisResult } from "./piperSpeech.js";
import { createRenderWorkDir, frameFileName, renderFrames, type RenderFramesResult } from "./frameRenderer.js";
import { resolveInWorkspace } from "./workspace.js";

export type NarrateFn = (text: string, options?: SynthesisOptions) => Promise<SynthesisResult>;
export type RenderFn = typeof renderFrames;

export type VideoRenderOptions = {
  /** Relative to the workspace. The folder this video and its parts are written under. */
  folder: string;
  voiceId?: string;
  onProgress?: (message: string) => void;
  /** Overridable for tests, so no real Piper/Electron/ffmpeg is required. */
  narrate?: NarrateFn;
  renderFramesFn?: RenderFn;
  /** Overridable so a test can assert the exact ffmpeg invocations without running one. */
  runFfmpeg?: (args: string[], timeoutMs: number) => Promise<FfmpegResult>;
};

export type FfmpegResult = { ok: boolean; code: number | null; stderr: string };

export type VideoRenderResult =
  | { ok: true; path: string; seconds: number; frames: number }
  | { ok: false; reason: string };

const ffmpegTimeoutMs = Number(process.env.TRHAI_FFMPEG_TIMEOUT_MS ?? 300_000);

/** Padding after a scene's narration ends, so speech never touches the cut. */
const narrationTailSeconds = 0.4;

function runFfmpegDefault(args: string[], timeoutMs: number): Promise<FfmpegResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("ffmpeg", ["-y", ...args], { shell: false, windowsHide: true });
    } catch (error) {
      resolve({ ok: false, code: null, stderr: error instanceof Error ? error.message : String(error) });
      return;
    }

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, code: null, stderr: `ffmpeg took longer than ${Math.round(timeoutMs / 1000)}s and was stopped.` });
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, stderr: error.message });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stderr });
    });
  });
}

/**
 * How long a WAV file plays for, read from its own header rather than assumed.
 *
 * Piper's output sample rate depends on the voice model, so this cannot be a
 * constant; it has to be read from the file it actually wrote.
 */
export function wavDurationSeconds(buffer: Buffer): number | null {
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    return null;
  }

  let offset = 12;
  let sampleRate: number | null = null;
  let blockAlign: number | null = null;
  let dataBytes: number | null = null;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (chunkId === "fmt " && body + 16 <= buffer.length) {
      sampleRate = buffer.readUInt32LE(body + 4);
      blockAlign = buffer.readUInt16LE(body + 12);
    } else if (chunkId === "data") {
      dataBytes = chunkSize;
    }

    offset = body + chunkSize + (chunkSize % 2);
  }

  if (!sampleRate || !blockAlign || dataBytes === null) return null;
  return dataBytes / (sampleRate * blockAlign);
}

type NarratedScene = {
  scene: Scene;
  /** Seconds this scene actually gets, at least its scripted duration. */
  seconds: number;
  /** Absolute path to this scene's own audio, silence when it had no narration. */
  audioPath: string;
  sampleRate: number;
  channels: number;
};

/** A silent WAV of an exact duration, matching a given format so ffmpeg can concatenate it. */
function writeSilence(outputPath: string, seconds: number, sampleRate: number, channels: number): void {
  const frames = Math.max(1, Math.round(seconds * sampleRate));
  const bytesPerFrame = channels * 2;
  const dataBytes = frames * bytesPerFrame;
  const buffer = Buffer.alloc(44 + dataBytes);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * bytesPerFrame, 28);
  buffer.writeUInt16LE(bytesPerFrame, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  // The rest is already zero from Buffer.alloc, which is silence in PCM16.

  writeFileSync(outputPath, buffer);
}

function wavFormat(buffer: Buffer): { sampleRate: number; channels: number } | null {
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF") return null;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (chunkId === "fmt " && body + 16 <= buffer.length) {
      return { channels: buffer.readUInt16LE(body + 2), sampleRate: buffer.readUInt32LE(body + 4) };
    }
    offset = body + chunkSize + (chunkSize % 2);
  }
  return null;
}

/**
 * Narrate every scene that has narration, and decide each scene's real
 * on-screen duration. A scene with no narration keeps its scripted length; one
 * with narration longer than its scripted length is extended to fit, plus a
 * short tail so speech never runs into the cut.
 */
async function narrateScenes(
  script: VideoScript,
  workDir: string,
  narrate: NarrateFn,
  voiceId: string | undefined,
  onProgress: (message: string) => void
): Promise<{ ok: true; scenes: NarratedScene[]; format: { sampleRate: number; channels: number } } | { ok: false; reason: string }> {
  // A fixed fallback format so a script with no narrated scenes at all still
  // produces silence ffmpeg can mux — 22.05kHz mono is Piper's most common
  // model rate, but the real value below always wins once any scene speaks.
  let format = { sampleRate: 22_050, channels: 1 };
  const narrated: NarratedScene[] = [];

  for (let index = 0; index < script.scenes.length; index += 1) {
    const scene = script.scenes[index];
    const audioPath = path.join(workDir, `narration-${String(index).padStart(4, "0")}.wav`);

    if (!scene.narration) {
      narrated.push({ scene, seconds: scene.seconds, audioPath: "", sampleRate: format.sampleRate, channels: format.channels });
      continue;
    }

    onProgress(`Narrating "${scene.id}"`);
    const speech = await narrate(scene.narration, { voiceId });
    if (!speech.ok) {
      return { ok: false, reason: `Could not narrate scene "${scene.id}": ${speech.reason}` };
    }

    writeFileSync(audioPath, speech.audio);
    const measured = wavFormat(speech.audio);
    if (measured) format = measured;

    const duration = wavDurationSeconds(speech.audio);
    if (duration === null) {
      return { ok: false, reason: `Scene "${scene.id}"'s narration could not be measured; Piper's own WAV header did not parse.` };
    }

    const seconds = Math.max(scene.seconds, duration + narrationTailSeconds);
    narrated.push({ scene, seconds, audioPath, sampleRate: measured?.sampleRate ?? format.sampleRate, channels: measured?.channels ?? format.channels });
  }

  // Now that the real format is known, fill in silence for every scene that
  // had none, at that format so concatenation works.
  for (const entry of narrated) {
    if (entry.audioPath) continue;
    const silencePath = path.join(workDir, `silence-${entry.scene.id}.wav`);
    writeSilence(silencePath, entry.seconds, format.sampleRate, format.channels);
    entry.audioPath = silencePath;
    entry.sampleRate = format.sampleRate;
    entry.channels = format.channels;
  }

  return { ok: true, scenes: narrated, format };
}

/**
 * Build, narrate, render and encode a video, and write it to the workspace.
 *
 * Every stage can fail on its own, and each failure says which stage it was
 * in and why — a "could not verify" outcome would be a third answer here too,
 * but there is nothing to distinguish it from failure for a video: unlike a
 * generated app there is no independent smoke test to run short of playing
 * it back, so the only claims made are "the file was written and is not
 * empty" and "it was not".
 */
export async function renderVideo(
  script: VideoScript,
  options: VideoRenderOptions
): Promise<VideoRenderResult> {
  const fault = findScriptFault(script);
  if (fault) return { ok: false, reason: `The script is not renderable: ${fault}.` };

  const folderPath = resolveInWorkspace(options.folder);
  if (!folderPath) return { ok: false, reason: "That destination is outside the workspace." };

  const onProgress = options.onProgress ?? (() => {});
  const narrate = options.narrate ?? synthesize;
  const renderFramesFn = options.renderFramesFn ?? renderFrames;
  const runFfmpeg = options.runFfmpeg ?? runFfmpegDefault;

  const workDir = createRenderWorkDir();
  try {
    const narrationResult = await narrateScenes(script, workDir, narrate, options.voiceId, onProgress);
    if (!narrationResult.ok) return narrationResult;

    onProgress("Planning frames");
    const framesDir = path.join(workDir, "frames");
    mkdirSync(framesDir, { recursive: true });

    const jobs: Array<{ index: number; html: string; outputPath: string }> = [];
    let globalIndex = 0;
    for (const entry of narrationResult.scenes) {
      const count = frameCount({ ...entry.scene, seconds: entry.seconds }, script.fps);
      for (let frame = 0; frame < count; frame += 1) {
        const t = count === 1 ? 1 : frame / (count - 1);
        jobs.push({
          index: globalIndex,
          html: sceneHtml(entry.scene, t),
          outputPath: path.join(framesDir, frameFileName(globalIndex))
        });
        globalIndex += 1;
      }
    }

    onProgress(`Rendering ${jobs.length} frames`);
    const rendered: RenderFramesResult = await renderFramesFn(jobs, { width: script.width, height: script.height });
    if (!rendered.ok) return { ok: false, reason: `Rendering failed: ${rendered.reason}` };

    onProgress("Combining narration");
    const listPath = path.join(workDir, "narration-list.txt");
    writeFileSync(
      listPath,
      narrationResult.scenes.map((entry) => `file '${entry.audioPath.replace(/'/g, "'\\''")}'`).join("\n")
    );
    const narrationPath = path.join(workDir, "narration.wav");
    const concat = await runFfmpeg(["-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", narrationPath], ffmpegTimeoutMs);
    if (!concat.ok || !existsSync(narrationPath)) {
      return { ok: false, reason: `Could not combine narration: ${concat.stderr.slice(-400)}` };
    }

    onProgress("Encoding video");
    const outputPath = path.join(workDir, "output.mp4");
    const framePattern = path.join(framesDir, "frame%06d.png");

    const encodeArgs = (videoCodec: string, preset: string) => [
      "-framerate", String(script.fps),
      "-i", framePattern,
      "-i", narrationPath,
      "-c:v", videoCodec,
      "-preset", preset,
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-shortest",
      // The output path must be the last argument — ffmpeg reads whatever
      // follows it as another input, not as an option.
      outputPath
    ];

    // h264_nvenc has a concurrent-session limit and can refuse for reasons
    // that have nothing to do with this render — something else already
    // encoding, most often. libx264 is the fallback precisely because it has
    // no such limit, not because it is otherwise preferred.
    let encode = await runFfmpeg(["-hide_banner", ...encodeArgs("h264_nvenc", "p5")], ffmpegTimeoutMs);
    if (!encode.ok || !existsSync(outputPath)) {
      onProgress("Hardware encoder unavailable, falling back to software");
      encode = await runFfmpeg(["-hide_banner", ...encodeArgs("libx264", "veryfast")], ffmpegTimeoutMs);
    }

    if (!encode.ok || !existsSync(outputPath) || statSync(outputPath).size === 0) {
      return { ok: false, reason: `ffmpeg could not encode the video: ${encode.stderr.slice(-400)}` };
    }

    mkdirSync(folderPath, { recursive: true });
    const finalPath = path.join(folderPath, "video.mp4");
    const data = readFileSync(outputPath);
    writeFileSync(finalPath, data);

    if (!existsSync(finalPath) || statSync(finalPath).size === 0) {
      return { ok: false, reason: "The encoded video could not be written to the workspace." };
    }

    const totalSeconds = narrationResult.scenes.reduce((sum, entry) => sum + entry.seconds, 0);
    return {
      ok: true,
      path: `${options.folder}/video.mp4`,
      seconds: Math.round(totalSeconds * 10) / 10,
      frames: jobs.length
    };
  } finally {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* scratch space, not worth failing over */ }
  }
}
