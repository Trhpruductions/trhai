// A real, end-to-end check of the video studio: real Piper, real Electron
// offscreen rendering, real ffmpeg. Deliberately not part of `npm test` — it
// needs a GPU and takes tens of seconds, the same reason `smoke:web-stack` is
// a script rather than a test. Run it after touching frameRenderer.ts,
// videoRender.ts, or the desktop workspace's Electron install.
//
// A fixed two-scene script, not a model call: this checks the render
// pipeline, not the local model, and should not fail because Ollama is not
// running.

import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { VideoScript } from "../packages/shared/src/videoScript.js";

async function main() {
  const workspace = mkdtempSync(path.join(tmpdir(), "trhai-video-smoke-"));
  process.env.ASCEND_WORKSPACE = workspace;

  const { renderVideo } = await import("../apps/api/src/services/videoRender.js");

  const script: VideoScript = {
    title: "Smoke Test",
    fps: 12,
    width: 960,
    height: 540,
    scenes: [
      { id: "intro", seconds: 2, narration: "Testing 1, 2, 3.", visual: { kind: "title", heading: "TRHAI Video Studio" } },
      { id: "status", seconds: 2, visual: { kind: "metric", label: "Status", value: "OK" } }
    ]
  };

  console.log("[smoke:video] rendering a 2-scene, 4s test video...");
  const started = Date.now();
  const result = await renderVideo(script, { folder: "smoke-video" });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  if (!result.ok) {
    console.error(`[smoke:video] FAILED after ${elapsed}s: ${result.reason}`);
    process.exitCode = 1;
    return;
  }

  const written = path.join(workspace, result.path);
  if (!existsSync(written) || statSync(written).size === 0) {
    console.error(`[smoke:video] FAILED: renderVideo reported success but ${written} is missing or empty.`);
    process.exitCode = 1;
    return;
  }

  console.log(`[smoke:video] OK in ${elapsed}s: ${result.frames} frames, ${result.seconds}s, ${statSync(written).size} bytes at ${written}`);
  rmSync(workspace, { recursive: true, force: true });
}

main().catch((error) => {
  console.error("[smoke:video] FAILED:", error);
  process.exitCode = 1;
});
