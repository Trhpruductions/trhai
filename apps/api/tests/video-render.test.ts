import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.ASCEND_WORKSPACE = mkdtempSync(path.join(tmpdir(), "video-render-workspace-"));

const { renderVideo, wavDurationSeconds } = await import("../src/services/videoRender.js");
const { resolveInWorkspace } = await import("../src/services/workspace.js");

// This suite never touches Electron, ffmpeg or Piper — every external step is
// injected, per docs/21-handoff.md's instruction not to require a GPU here.
// What it verifies instead is the thing this pipeline exists to get right:
// narration is measured before frames are planned, a failure at any stage is
// reported as a failure rather than a partial success, and nothing claims a
// file exists that was not actually written.

/** A minimal, real 16-bit PCM WAV of an exact duration, so header parsing has something true to read. */
function makeWav(seconds: number, sampleRate = 22_050, channels = 1): Buffer {
  const frames = Math.round(seconds * sampleRate);
  const bytesPerFrame = channels * 2;
  const dataBytes = frames * bytesPerFrame;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * bytesPerFrame, 28);
  buffer.writeUInt16LE(bytesPerFrame, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

function baseScript() {
  return {
    title: "Demo",
    fps: 4,
    width: 640,
    height: 480,
    scenes: [
      { id: "intro", seconds: 1, narration: "Hello there.", visual: { kind: "title" as const, heading: "Hi" } },
      { id: "outro", seconds: 1, visual: { kind: "title" as const, heading: "Bye" } }
    ]
  };
}

/** A renderFramesFn stub that actually writes a tiny file per job, like a real render would. */
function stubRenderFrames() {
  return async (jobs: Array<{ outputPath: string }>) => {
    for (const job of jobs) writeFileSync(job.outputPath, Buffer.from([1, 2, 3]));
    return { ok: true as const, rendered: jobs.length };
  };
}

/** An ffmpeg stub: writes whatever output file the real call would have produced. */
function stubFfmpeg() {
  return async (args: string[]) => {
    const output = args[args.length - 1];
    writeFileSync(output, Buffer.from("fake media"));
    return { ok: true, code: 0, stderr: "" };
  };
}

test("wavDurationSeconds reads a real header", () => {
  const seconds = wavDurationSeconds(makeWav(2.5));
  assert.ok(seconds !== null && Math.abs(seconds - 2.5) < 0.01);
});

test("wavDurationSeconds rejects something that is not a WAV", () => {
  assert.equal(wavDurationSeconds(Buffer.from("not audio")), null);
});

test("renders a script end to end with every external step stubbed", async () => {
  const result = await renderVideo(baseScript(), {
    folder: "videos/demo",
    narrate: async () => ({ ok: true, audio: makeWav(0.5), format: "wav", voice: "test" }),
    renderFramesFn: stubRenderFrames(),
    runFfmpeg: stubFfmpeg()
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.path, "videos/demo/video.mp4");
  assert.ok(result.frames > 0);

  const written = resolveInWorkspace("videos/demo/video.mp4");
  assert.ok(written && existsSync(written));
});

test("a scene's narration extends its on-screen duration", async () => {
  // Scripted for 1s but the narration itself is 3s; the scene must not be cut
  // off mid-sentence, so more frames must be rendered than 1s at 4fps implies.
  let framesRendered = 0;
  const result = await renderVideo(baseScript(), {
    folder: "videos/extended",
    narrate: async () => ({ ok: true, audio: makeWav(3), format: "wav", voice: "test" }),
    renderFramesFn: async (jobs: Array<{ outputPath: string }>) => {
      framesRendered = jobs.length;
      for (const job of jobs) writeFileSync(job.outputPath, Buffer.from([1]));
      return { ok: true as const, rendered: jobs.length };
    },
    runFfmpeg: stubFfmpeg()
  });

  assert.equal(result.ok, true);
  // 1s scene at 4fps is 4 frames; a 3s narration plus the 0.4s tail forces
  // at least (3.4 * 4) frames for that one scene alone.
  assert.ok(framesRendered > 4 + 4);
});

test("rejects a script that fails its own validation before doing anything", async () => {
  const script = baseScript();
  script.scenes[0].seconds = 0.01;
  const result = await renderVideo(script, { folder: "videos/bad" });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.reason.includes("not renderable"));
});

test("a failed narration is reported, not silently skipped", async () => {
  const result = await renderVideo(baseScript(), {
    folder: "videos/narration-fail",
    narrate: async () => ({ ok: false, reason: "Piper is not installed on this machine." })
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.reason.includes("Piper is not installed"));
});

test("a failed frame render is reported and no video is written", async () => {
  const result = await renderVideo(baseScript(), {
    folder: "videos/render-fail",
    narrate: async () => ({ ok: true, audio: makeWav(0.5), format: "wav", voice: "test" }),
    renderFramesFn: async () => ({ ok: false as const, reason: "Electron exited with code 1.", rendered: 0 })
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.reason.includes("Rendering failed"));
  assert.equal(existsSync(resolveInWorkspace("videos/render-fail/video.mp4") ?? ""), false);
});

test("a failed encode is reported and no partial file is claimed", async () => {
  const result = await renderVideo(baseScript(), {
    folder: "videos/encode-fail",
    narrate: async () => ({ ok: true, audio: makeWav(0.5), format: "wav", voice: "test" }),
    renderFramesFn: stubRenderFrames(),
    runFfmpeg: async (args: string[]) => {
      // Let narration concatenation succeed, but every encode attempt fails.
      const output = args[args.length - 1];
      if (output.endsWith("narration.wav")) {
        writeFileSync(output, Buffer.from("fake"));
        return { ok: true, code: 0, stderr: "" };
      }
      return { ok: false, code: 1, stderr: "nvenc not available" };
    }
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.reason.includes("ffmpeg could not encode"));
  assert.equal(existsSync(resolveInWorkspace("videos/encode-fail/video.mp4") ?? ""), false);
});

test("falls back to libx264 when the hardware encoder fails", async () => {
  let nvencAttempted = false;
  let softwareAttempted = false;

  const result = await renderVideo(baseScript(), {
    folder: "videos/fallback",
    narrate: async () => ({ ok: true, audio: makeWav(0.5), format: "wav", voice: "test" }),
    renderFramesFn: stubRenderFrames(),
    runFfmpeg: async (args: string[]) => {
      const output = args[args.length - 1];
      if (output.endsWith("narration.wav")) {
        writeFileSync(output, Buffer.from("fake"));
        return { ok: true, code: 0, stderr: "" };
      }
      if (args.includes("h264_nvenc")) {
        nvencAttempted = true;
        return { ok: false, code: 1, stderr: "no nvenc session available" };
      }
      if (args.includes("libx264")) {
        softwareAttempted = true;
        writeFileSync(output, Buffer.from("fake video"));
        return { ok: true, code: 0, stderr: "" };
      }
      return { ok: false, code: 1, stderr: "unexpected call" };
    }
  });

  assert.equal(nvencAttempted, true);
  assert.equal(softwareAttempted, true);
  assert.equal(result.ok, true);
});

test("rejects a destination outside the workspace", async () => {
  const result = await renderVideo(baseScript(), {
    folder: "../escape",
    narrate: async () => ({ ok: true, audio: makeWav(0.5), format: "wav", voice: "test" })
  });
  assert.equal(result.ok, false);
});
