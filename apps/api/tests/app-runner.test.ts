import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// A workspace of its own; appRunner resolves projects under it.
const workspace = mkdtempSync(path.join(tmpdir(), "ascend-run-"));
process.env.ASCEND_WORKSPACE = workspace;

const { startApp, stopApp, listRunningApps, resetRunningApps } = await import("../src/services/appRunner.js");
const { runTool } = await import("../src/services/agentTools.js");

/** A zero-dependency server that answers /health on the port it is told, like a generated app. */
function writeApp(name: string, opts: { health?: boolean } = {}): string {
  const dir = path.join(workspace, name);
  mkdirSync(dir, { recursive: true });
  const health = opts.health === false
    ? 'res.writeHead(404); res.end("no");'
    : 'if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; } res.writeHead(200); res.end("hello from ' + name + '");';
  writeFileSync(path.join(dir, "server.js"),
    'const http = require("node:http");\n'
    + 'const port = Number(process.env.PORT ?? 4400);\n'
    + 'http.createServer((req, res) => { ' + health + ' }).listen(port, "127.0.0.1");\n',
    "utf8");
  return name;
}

test.afterEach(() => resetRunningApps());

test("a built app is started on a free port and answers over its URL", async () => {
  writeApp("plant-tracker");
  const started = await startApp("plant-tracker");
  assert.equal(started.ok, true, started.ok ? "" : started.reason);
  if (!started.ok) return;

  assert.match(started.app.url, /^http:\/\/localhost:\d+$/);
  assert.equal(started.app.project, "plant-tracker");
  assert.ok(started.app.port > 0);

  // It is genuinely serving, not merely spawned.
  const response = await fetch(`${started.app.url}/health`);
  assert.equal(response.ok, true);

  assert.equal(listRunningApps().length, 1);
});

test("starting an app twice returns the one already running", async () => {
  writeApp("twice");
  const first = await startApp("twice");
  const second = await startApp("twice");
  assert.equal(first.ok && second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(second.alreadyRunning, true);
  assert.equal(first.app.port, second.app.port, "same instance, same port");
  assert.equal(listRunningApps().length, 1);
});

test("stopApp stops it and it stops answering", async () => {
  writeApp("stoppable");
  const started = await startApp("stoppable");
  assert.ok(started.ok);
  if (!started.ok) return;
  const url = started.app.url;

  assert.equal(stopApp("stoppable"), true);
  assert.equal(listRunningApps().length, 0);
  // The process is killed asynchronously (taskkill /T on Windows), so poll
  // rather than assume a fixed delay - under a loaded suite the kill can take
  // a moment. Within the budget the port must stop answering.
  let stillAnswering = true;
  for (let attempt = 0; attempt < 20 && stillAnswering; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    try {
      await fetch(`${url}/health`, { signal: AbortSignal.timeout(400) });
    } catch {
      stillAnswering = false;
    }
  }
  assert.equal(stillAnswering, false, "the app stops answering once stopped");
});

test("a folder with no server.js cannot be launched", async () => {
  mkdirSync(path.join(workspace, "just-a-folder"), { recursive: true });
  const started = await startApp("just-a-folder");
  assert.equal(started.ok, false);
  if (started.ok) return;
  assert.match(started.reason, /no server\.js/);
});

test("a server that never answers /health is a reported failure, not a hang", async () => {
  writeApp("no-health", { health: false });
  const started = await startApp("no-health");
  assert.equal(started.ok, false);
  if (started.ok) return;
  assert.match(started.reason, /did not answer \/health/);
  assert.equal(listRunningApps().length, 0, "a start that never became ready is not left tracked");
});

test("no more than the cap run at once; the oldest is stopped for the newest", async () => {
  const { maxRunningApps } = await import("../src/services/appRunner.js");
  const names: string[] = [];
  for (let index = 0; index < maxRunningApps + 1; index += 1) {
    const name = writeApp(`capped-${index}`);
    names.push(name);
    const started = await startApp(name);
    assert.ok(started.ok, started.ok ? "" : started.reason);
  }
  const live = listRunningApps().map((app) => app.project);
  assert.equal(live.length, maxRunningApps);
  assert.ok(!live.includes("capped-0"), "the first started was stopped to make room");
  assert.ok(live.includes(`capped-${maxRunningApps}`), "the newest is running");
});

// ---------------------------------------------------------------------------
// The tools, with the launcher injected the way the server injects it.

test("run_app starts the named app and returns its URL", async () => {
  writeApp("tool-app");
  const result = await runTool(
    { name: "run_app", arguments: { project: "tool-app" } },
    { memories: [], knowledge: [], launchApp: (p) => startApp(p), stopApp: (p) => stopApp(p) }
  );
  assert.equal(result.ok, true, result.content);
  assert.match(result.content, /tool-app.*running.*http:\/\/localhost:\d+/);
});

test("run_app without a launcher says so instead of pretending", async () => {
  const result = await runTool(
    { name: "run_app", arguments: { project: "tool-app" } },
    { memories: [], knowledge: [] }
  );
  assert.equal(result.ok, false);
  assert.match(result.content, /cannot be launched here/);
});

test("stop_app stops a running app", async () => {
  writeApp("tool-stop");
  await startApp("tool-stop");
  const result = await runTool(
    { name: "stop_app", arguments: { project: "tool-stop" } },
    { memories: [], knowledge: [], stopApp: (p) => stopApp(p) }
  );
  assert.equal(result.ok, true, result.content);
  assert.match(result.content, /Stopped "tool-stop"/);
});

test("build_app launches what it builds when a launcher is wired", async () => {
  // The whole point: a build is something running, not a folder. With no
  // launcher (unit-test default) build_app does not spawn a server, which is
  // what keeps the rest of the suite from hanging.
  const result = await runTool(
    { name: "build_app", arguments: { description: "an app to track books with a title and author" } },
    {
      memories: [], knowledge: [],
      request: "build an app to track books with a title and author",
      launchApp: (project) => startApp(project),
      stopApp: (project) => stopApp(project)
    }
  );
  assert.equal(result.ok, true, result.content);
  assert.match(result.content, /running live at http:\/\/localhost:\d+/);
});
