import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderFrames, renderPdfs, resolveElectronBinary } from "../src/services/frameRenderer.js";
import { extractDocumentText } from "../src/services/documentText.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeRenderer = path.join(here, "helpers", "fakeRenderer.mjs");
const folder = mkdtempSync(path.join(tmpdir(), "trhai-pdf-render-"));
after(() => rmSync(folder, { recursive: true, force: true }));

const saved = { script: process.env.TRHAI_RENDERER_SCRIPT, electron: process.env.TRHAI_ELECTRON_PATH, mode: process.env.FAKE_RENDER, log: process.env.FAKE_RENDER_LOG };
const restore = (name: string, value: string | undefined) => { if (value === undefined) delete process.env[name]; else process.env[name] = value; };

/** Runs `body` with node standing in for Electron and the fake script standing in for the renderer. */
async function withFake<T>(mode: string, body: () => Promise<T>, log?: string): Promise<T> {
  process.env.TRHAI_ELECTRON_PATH = process.execPath;
  process.env.TRHAI_RENDERER_SCRIPT = fakeRenderer;
  process.env.FAKE_RENDER = mode;
  if (log) process.env.FAKE_RENDER_LOG = log; else delete process.env.FAKE_RENDER_LOG;
  try {
    return await body();
  } finally {
    restore("TRHAI_RENDERER_SCRIPT", saved.script);
    restore("TRHAI_ELECTRON_PATH", saved.electron);
    restore("FAKE_RENDER", saved.mode);
    restore("FAKE_RENDER_LOG", saved.log);
  }
}

const out = (name: string) => path.join(folder, name);

test("every page is printed, handed over as the HTML it was given, and copied where it was asked for", async () => {
  const log = out("seen.json");
  const result = await withFake("ok", () => renderPdfs([
    { index: 0, html: "<!doctype html><title>One</title><p>first</p>", outputPath: out("one.pdf") },
    { index: 1, html: "<!doctype html><title>Two</title><p>second</p>", outputPath: out("two.pdf") }
  ]), log);
  assert.deepEqual(result, { ok: true, rendered: 2 });
  assert.match(readFileSync(out("one.pdf"), "latin1"), /^%PDF-1\.4/);
  assert.match(readFileSync(out("two.pdf"), "latin1"), /a page 1/);
  const seen = JSON.parse(readFileSync(log, "utf8")) as Array<{ index: number; html: string }>;
  assert.deepEqual(seen.map((page) => page.html), ["<!doctype html><title>One</title><p>first</p>", "<!doctype html><title>Two</title><p>second</p>"]);
});

test("what is not a PDF is not delivered, whatever the renderer says", async () => {
  const result = await withFake("garbage", () => renderPdfs([{ index: 0, html: "<p>x</p>", outputPath: out("garbage.pdf") }]));
  assert.equal(result.ok, false);
  assert.equal(result.rendered, 0);
  assert.match((result as { reason: string }).reason, /only 0 of 1 pages were printed/);
  assert.equal(existsSync(out("garbage.pdf")), false);
});

test("a batch that is only partly printed says how much, and delivers only what is whole", async () => {
  const result = await withFake("partial", () => renderPdfs([
    { index: 0, html: "<p>a</p>", outputPath: out("partial-a.pdf") },
    { index: 1, html: "<p>b</p>", outputPath: out("partial-b.pdf") }
  ]));
  assert.equal(result.ok, false);
  assert.equal(result.rendered, 1);
  assert.match((result as { reason: string }).reason, /only 1 of 2 pages were printed/);
  assert.equal(existsSync(out("partial-a.pdf")), true);
  assert.equal(existsSync(out("partial-b.pdf")), false);
});

test("a renderer that crashes is reported with what it said, and a file from an earlier run is left as it was", async () => {
  writeFileSync(out("stale.pdf"), "%PDF-1.4 from yesterday");
  const result = await withFake("crash", () => renderPdfs([{ index: 0, html: "<p>x</p>", outputPath: out("stale.pdf") }]));
  assert.equal(result.ok, false);
  assert.equal(result.rendered, 0);
  assert.match((result as { reason: string }).reason, /exited with code 3/);
  assert.match((result as { reason: string }).reason, /the window process crashed/);
  assert.equal(readFileSync(out("stale.pdf"), "utf8"), "%PDF-1.4 from yesterday");
});

test("a renderer that never finishes is stopped at the time allowed", async () => {
  const started = Date.now();
  const result = await withFake("hang", () => renderPdfs([{ index: 0, html: "<p>x</p>", outputPath: out("hang.pdf") }], { timeoutMs: 1500 }));
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /took longer than 2s and was stopped/);
  assert.ok(Date.now() - started < 10_000, "it was stopped, not waited for");
  assert.equal(existsSync(out("hang.pdf")), false);
});

test("nothing to print, and no Electron to print with, are each said plainly", async () => {
  assert.deepEqual(await renderPdfs([]), { ok: false, reason: "There were no pages to print.", rendered: 0 });
  process.env.TRHAI_ELECTRON_PATH = out("no-such-electron.exe");
  try {
    const result = await renderPdfs([{ index: 0, html: "<p>x</p>", outputPath: out("never.pdf") }]);
    assert.equal(result.ok, false);
    assert.match((result as { reason: string }).reason, /TRHAI_ELECTRON_PATH/);
  } finally {
    restore("TRHAI_ELECTRON_PATH", saved.electron);
  }
});

test("the work folder is cleaned up whether the print worked or not", async () => {
  const workFolders = () => readdirSync(tmpdir()).filter((name) => name.startsWith("trhai-pdf-"));
  const already = new Set(workFolders());
  await withFake("ok", () => renderPdfs([{ index: 0, html: "<p>x</p>", outputPath: out("tidy-ok.pdf") }]));
  await withFake("crash", () => renderPdfs([{ index: 0, html: "<p>x</p>", outputPath: out("tidy-bad.pdf") }]));
  assert.deepEqual(workFolders().filter((name) => !already.has(name)), []);
});

test("drawing video frames still goes through the same spawning", async () => {
  const result = await withFake("ok", () => renderFrames([{ index: 0, html: "<p>x</p>", outputPath: out("frame0.png") }, { index: 1, html: "<p>y</p>", outputPath: out("frame1.png") }], { width: 64, height: 36 }));
  assert.deepEqual(result, { ok: true, rendered: 2 });
  assert.equal(readFileSync(out("frame1.png"), "utf8"), "a frame");
});

// ---------------------------------------------------------------- the real thing

// These print with the desktop's own Electron, which a test run does not
// assume is installed: they run when TRHAI_REAL_ELECTRON=1 and it can be found.
const real = process.env.TRHAI_REAL_ELECTRON === "1" && resolveElectronBinary().ok;
const why = real ? false : "needs TRHAI_REAL_ELECTRON=1 and an Electron to print with";

let beacon: Server;
let beaconHits: string[] = [];
let beaconPort = 0;
before(async () => {
  if (!real) return;
  beacon = createServer((request, response) => { beaconHits.push(request.url ?? ""); response.writeHead(200, { "content-type": "text/plain" }); response.end("x"); });
  await new Promise<void>((resolve) => beacon.listen(0, "127.0.0.1", resolve));
  beaconPort = (beacon.address() as { port: number }).port;
});
after(() => { beacon?.close(); });

test("a real print makes a PDF that reads back, on the paper the page asks for", { skip: why, timeout: 120_000 }, async () => {
  const rows = Array.from({ length: 60 }, (_, index) => `<tr><td>Row ${index + 1}</td><td>${"word ".repeat(12)}</td></tr>`).join("");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Printed</title><style>@page { size: A4; margin: 20mm; }</style></head>`
    + `<body><h1>Printed heading</h1><p>Opening line of the page.</p><table>${rows}</table><p>Closing line of the page.</p></body></html>`;
  const result = await renderPdfs([{ index: 0, html, outputPath: out("real.pdf") }]);
  assert.deepEqual(result, { ok: true, rendered: 1 });
  const bytes = readFileSync(out("real.pdf"));
  assert.equal(bytes.subarray(0, 5).toString("latin1"), "%PDF-");
  const read = await extractDocumentText(bytes, "real.pdf");
  assert.ok(read.ok, "the printed file reads back");
  if (read.ok) {
    assert.ok((read.pages ?? 0) >= 2, "sixty rows take more than one page");
    assert.match(read.text, /Printed heading/);
    assert.match(read.text, /Opening line of the page\./);
    assert.match(read.text, /Closing line of the page\./);
  }
  // A4 is 595 by 842 points: the page's own @page rule, not the printer's default, chose the paper.
  const box = /\/MediaBox\s*\[\s*0\s+0\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s*\]/.exec(bytes.toString("latin1"));
  assert.ok(box, "the page size is written in the file");
  assert.ok(Math.abs(Number(box![1]) - 595) < 2 && Math.abs(Number(box![2]) - 842) < 2, `A4, not ${box![1]} x ${box![2]}`);
});

test("a page that tries to run a script or reach the network can do neither while it is printed", { skip: why, timeout: 120_000 }, async () => {
  beaconHits = [];
  const address = `http://127.0.0.1:${beaconPort}`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Hostile</title>`
    + `<link rel="stylesheet" href="${address}/style.css"><script src="${address}/script.js"></script>`
    + `<script>fetch("${address}/fetch").catch(function () {}); new Image().src = "${address}/script-image.png"; window.addEventListener("DOMContentLoaded", function () { document.body.insertAdjacentHTML("beforeend", "<p>The script ran.</p>"); });</script></head>`
    + `<body><h1>Plain words</h1><img src="${address}/picture.png"><iframe src="${address}/frame.html"></iframe>`
    + `<p style="background-image:url(${address}/background.png)">Under it all.</p></body></html>`;
  const result = await renderPdfs([{ index: 0, html, outputPath: out("hostile.pdf") }]);
  assert.deepEqual(result, { ok: true, rendered: 1 });
  assert.deepEqual(beaconHits, [], "nothing reached out");
  const read = await extractDocumentText(readFileSync(out("hostile.pdf")), "hostile.pdf");
  assert.ok(read.ok);
  if (read.ok) {
    assert.match(read.text, /Plain words/);
    assert.doesNotMatch(read.text, /The script ran/, "scripts are off while a page is printed");
  }
});
