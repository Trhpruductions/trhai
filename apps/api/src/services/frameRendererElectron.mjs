// Runs as the Electron main process, spawned by frameRenderer.ts. Not part of
// any TypeScript build: it is loaded directly by the `electron` binary, which
// is why it takes a manifest file path as an argument instead of importing
// anything from this repo's own packages.
//
// One window for the whole batch, not one per scene or per frame — Electron
// startup dominates the runtime otherwise, and that was true the first time
// this was measured and has no reason to have changed since.

import { app, BrowserWindow } from "electron";
import { readFileSync, writeFileSync } from "node:fs";

const manifestPath = process.argv[process.argv.length - 1];

function fail(message) {
  try { process.stderr.write(`${message}\n`); } catch { /* nothing left to report to */ }
  app.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (error) {
  fail(`Could not read the render manifest: ${error && error.message ? error.message : error}`);
}

app.disableHardwareAcceleration?.(); // no-op guard for older Electron typings; real accel is left on by default

app.whenReady().then(async () => {
  const results = [];
  let win;

  try {
    win = new BrowserWindow({
      width: manifest.width,
      height: manifest.height,
      show: false,
      // Without this, capturePage() measures the window including its
      // (invisible, offscreen) chrome and returns the wrong resolution —
      // measured as 1920x1032 for a requested 1920x1080. See frameRenderer.ts.
      useContentSize: true,
      webPreferences: {
        offscreen: true,
        backgroundThrottling: false,
        contextIsolation: true,
        sandbox: true
      }
    });

    await win.loadURL("data:text/html,<!doctype html><html><body></body></html>");

    for (const frame of manifest.frames) {
      try {
        // The whole document is replaced per frame, then two animation
        // frames are awaited before capture so layout and paint have
        // actually happened — capturing immediately after write risks a
        // frame of the previous scene's content.
        await win.webContents.executeJavaScript(
          `(() => {
            document.open();
            document.write(${JSON.stringify(frame.html)});
            document.close();
            return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          })()`
        );

        const image = await win.webContents.capturePage();
        writeFileSync(frame.outputPath, image.toPNG());
        results.push({ index: frame.index, ok: true });
      } catch (error) {
        results.push({ index: frame.index, ok: false, reason: error && error.message ? error.message : String(error) });
      }
    }
  } catch (error) {
    results.push({ index: -1, ok: false, reason: `window setup failed: ${error && error.message ? error.message : error}` });
  } finally {
    try { win?.destroy(); } catch { /* already gone */ }
  }

  try { writeFileSync(manifest.resultsPath, JSON.stringify(results)); } catch { /* the caller verifies files directly */ }

  const failed = results.some((entry) => !entry.ok);
  app.exit(failed && results.length === 0 ? 1 : 0);
});

app.on("window-all-closed", () => { /* this app quits explicitly via app.exit above */ });
