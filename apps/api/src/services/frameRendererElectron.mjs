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

  // Pages to print as PDF: a document made from escaped text, written to a file by the caller. Printed in a window of its own with
  // JavaScript off and every request that is not for a local file refused: nothing a document says can run, or reach out.
  for (const pdf of manifest.pdfs ?? []) {
    let printer;
    try {
      printer = new BrowserWindow({ show: false, width: 1024, height: 1400, webPreferences: { sandbox: true, contextIsolation: true, javascript: false } });
      printer.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith("file:") }));
      await printer.loadFile(pdf.htmlPath);
      // The page's own @page rule gives the paper and the margins. Tagged, with the headings as the outline, so a screen reader and the
      // reader's side panel can follow the document.
      const data = await printer.webContents.printToPDF({ preferCSSPageSize: true, printBackground: true, generateTaggedPDF: true, generateDocumentOutline: true });
      writeFileSync(pdf.outputPath, data);
      results.push({ index: pdf.index, ok: true });
    } catch (error) {
      results.push({ index: pdf.index, ok: false, reason: error && error.message ? error.message : String(error) });
    } finally {
      try { printer?.destroy(); } catch { /* already gone */ }
    }
  }

  try {
    if ((manifest.frames ?? []).length === 0) throw new Error("no frames");
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

    for (const frame of manifest.frames ?? []) {
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
    // Nothing to capture is not a failure: a manifest of pages to print has no frames.
    if (!(error && error.message === "no frames")) results.push({ index: -1, ok: false, reason: `window setup failed: ${error && error.message ? error.message : error}` });
  } finally {
    try { win?.destroy(); } catch { /* already gone */ }
  }

  try { writeFileSync(manifest.resultsPath, JSON.stringify(results)); } catch { /* the caller verifies files directly */ }

  const failed = results.some((entry) => !entry.ok);
  app.exit(failed && results.length === 0 ? 1 : 0);
});

app.on("window-all-closed", () => { /* this app quits explicitly via app.exit above */ });
