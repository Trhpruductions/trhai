import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect, type AddressInfo } from "node:net";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

// A workspace of its own; appRunner resolves projects under it.
const workspace = mkdtempSync(path.join(tmpdir(), "ascend-run-"));
process.env.ASCEND_WORKSPACE = workspace;

const { startApp, stopApp, listRunningApps, listBuiltApps, removeBuiltApp, resetRunningApps, projectFolderName, loopbackPreload } = await import("../src/services/appRunner.js");
const { runTool } = await import("../src/services/agentTools.js");

/**
 * A zero-dependency server that answers /health on the port it is told, like a
 * generated app. `host: null` listens the way every generated app did before
 * the generator named an address: on none, which Node takes as every address.
 */
function writeApp(name: string, opts: { health?: boolean; host?: string | null } = {}): string {
  const dir = path.join(workspace, name);
  mkdirSync(dir, { recursive: true });
  const health = opts.health === false
    ? 'res.writeHead(404); res.end("no");'
    : 'if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; } res.writeHead(200); res.end("hello from ' + name + '");';
  const host = opts.host === undefined ? "127.0.0.1" : opts.host;
  writeFileSync(path.join(dir, "server.js"),
    'const http = require("node:http");\n'
    + 'const port = Number(process.env.PORT ?? 4400);\n'
    + 'http.createServer((req, res) => { ' + health + ' }).listen(' + (host === null ? "port" : `port, ${JSON.stringify(host)}`) + ');\n',
    "utf8");
  return name;
}

/** This PC's address on its network - what another device would connect to - or null on a machine with none. */
function networkAddress(): string | null {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal && !entry.address.startsWith("169.254.")) return entry.address;
    }
  }
  return null;
}

/** Whether a TCP connection to host:port is accepted. */
function connects(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    socket.setTimeout(5000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

test.afterEach(() => resetRunningApps());

test("projectFolderName reduces a full workspace path to the folder, and refuses escapes", () => {
  assert.equal(projectFolderName("plant-tracker"), "plant-tracker");
  assert.equal(projectFolderName("plant-tracker/"), "plant-tracker");
  assert.equal(projectFolderName(path.join(workspace, "plant-tracker")), "plant-tracker");
  assert.equal(projectFolderName(path.join(workspace, "plant-tracker", "src")), "plant-tracker");
  assert.equal(projectFolderName("../escape"), "");
  assert.equal(projectFolderName(""), "");
});

test("an app can be started and stopped by its full workspace path, not only its folder name", async () => {
  // The model routinely passes the full path (change_app echoes it). run_app
  // joined that onto the workspace root and found nothing; now it resolves.
  writeApp("by-path");
  const fullPath = path.join(workspace, "by-path");
  const started = await startApp(fullPath);
  assert.equal(started.ok, true, started.ok ? "" : started.reason);
  if (!started.ok) return;
  assert.equal(started.app.project, "by-path");
  assert.equal(stopApp(fullPath), true);
});

test("a built app is started on a free port and answers over its URL", async () => {
  writeApp("plant-tracker");
  const started = await startApp("plant-tracker");
  assert.equal(started.ok, true, started.ok ? "" : started.reason);
  if (!started.ok) return;

  assert.match(started.app.url, /^http:\/\/127\.0\.0\.1:\d+$/);
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
  assert.match(result.content, /tool-app.*running.*http:\/\/127\.0\.0\.1:\d+/);
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

test("stop_app resolves a loose app reference to the running app's folder", async () => {
  // "stop the todo app" never matches the folder "simple-todo-list-app"
  // verbatim; it used to miss silently and leave the app running.
  writeApp("simple-todo-list-app");
  await startApp("simple-todo-list-app");
  const result = await runTool(
    { name: "stop_app", arguments: { project: "the todo app" } },
    { memories: [], knowledge: [], stopApp: (p) => stopApp(p), runningApps: () => listRunningApps() }
  );
  assert.equal(result.ok, true, result.content);
  assert.match(result.content, /Stopped "simple-todo-list-app"/);
  assert.equal(listRunningApps().length, 0, "the app is actually stopped");
});

test("stop_app that matches nothing running says so and lists what is running", async () => {
  writeApp("invoice-tracker");
  await startApp("invoice-tracker");
  const result = await runTool(
    { name: "stop_app", arguments: { project: "the weather app" } },
    { memories: [], knowledge: [], stopApp: (p) => stopApp(p), runningApps: () => listRunningApps() }
  );
  assert.equal(result.ok, false, result.content);
  assert.match(result.content, /invoice-tracker/, "the real running app is named so the model can retry");
});

test("run_app reopens a running app referred to loosely, rather than failing to find a folder", async () => {
  writeApp("simple-todo-list-app");
  await startApp("simple-todo-list-app");
  const result = await runTool(
    { name: "run_app", arguments: { project: "the todo app" } },
    { memories: [], knowledge: [], launchApp: (p) => startApp(p), stopApp: (p) => stopApp(p), runningApps: () => listRunningApps() }
  );
  assert.equal(result.ok, true, result.content);
  assert.match(result.content, /simple-todo-list-app.*running.*http:\/\/127\.0\.0\.1:\d+/);
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
  assert.match(result.content, /running live at http:\/\/127\.0\.0\.1:\d+/);
});

test("listBuiltApps enumerates workspace apps and marks which are running", async () => {
  writeApp("alpha-tracker");
  writeApp("beta-notes");
  writeApp("gamma-dash");
  await startApp("beta-notes"); // one running, two built-but-stopped
  const apps = listBuiltApps();
  const names = apps.map((a) => a.name);
  // Other tests leave app folders in the shared workspace, so assert presence,
  // not an exact set. All three of ours must be listed.
  for (const n of ["alpha-tracker", "beta-notes", "gamma-dash"]) {
    assert.ok(names.includes(n), `${n} should be listed`);
  }
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)), "the list is sorted");
  const beta = apps.find((a) => a.name === "beta-notes");
  assert.equal(beta?.running, true, "the running one is marked running");
  assert.match(beta?.url ?? "", /http:\/\/127\.0\.0\.1:\d+/, "running app carries its url");
  const alpha = apps.find((a) => a.name === "alpha-tracker");
  assert.equal(alpha?.running, false, "a built-but-stopped app is listed and not running");
  assert.equal(alpha?.url, null);
});

test("listBuiltApps ignores plain folders that are not runnable apps", async () => {
  writeApp("real-app");
  // a folder with no server entry is not an app
  mkdirSync(path.join(workspace, "just-a-folder", "sub"), { recursive: true });
  writeFileSync(path.join(workspace, "just-a-folder", "readme.txt"), "not an app", "utf8");
  const names = listBuiltApps().map((a) => a.name);
  assert.ok(names.includes("real-app"), "the real app is listed");
  assert.ok(!names.includes("just-a-folder"), "a folder with no server entry is not listed as an app");
});

test("run_app starts a built-but-stopped app referred to loosely", async () => {
  // Built earlier, never started this run. Without built-app resolution,
  // "the kanban board" would miss (it only matched RUNNING apps) and fail to launch.
  writeApp("kanban-board-xyz");
  const result = await runTool(
    { name: "run_app", arguments: { project: "the kanban board" } },
    {
      memories: [], knowledge: [],
      launchApp: (p) => startApp(p), stopApp: (p) => stopApp(p),
      runningApps: () => listRunningApps(), listApps: () => listBuiltApps()
    }
  );
  assert.equal(result.ok, true, result.content);
  assert.match(result.content, /kanban-board-xyz.*running.*http:\/\/127\.0\.0\.1:\d+/);
});

// ---------------------------------------------------------------------------
// Keeping a running app on this PC.

test("an app that names no address is kept on this PC, and opened at 127.0.0.1", async () => {
  // How every generated server.js listened before the generator named an
  // address - and most of the workspace still does.
  writeApp("old-style-app", { host: null });
  const started = await startApp("old-style-app");
  assert.equal(started.ok, true, started.ok ? "" : started.reason);
  if (!started.ok) return;
  assert.match(started.app.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal((await fetch(`${started.app.url}/health`)).ok, true);
  const outside = networkAddress();
  if (!outside) return;
  // The control: a server on every address answers there, so the refusal
  // below is the app's binding, not a network path that never worked.
  const control = createServer();
  control.listen(0);
  await once(control, "listening");
  try {
    assert.equal(await connects(outside, (control.address() as AddressInfo).port), true, "the control connects");
  } finally {
    control.close();
  }
  assert.equal(await connects(outside, started.app.port), false, `${outside}:${started.app.port} must refuse`);
});

test("the preload gives 127.0.0.1 to every listen() that names no address of its own", async () => {
  const script = path.join(workspace, "listen-forms.cjs");
  const outside = networkAddress();
  writeFileSync(script, [
    'const http = require("node:http");',
    "const forms = [",
    "  (server, done) => server.listen(0, done),",
    '  (server, done) => server.listen(0, "0.0.0.0", done),',
    '  (server, done) => server.listen(0, "::", done),',
    '  (server, done) => server.listen(0, "localhost", done),',
    "  (server, done) => server.listen({ port: 0 }, done),",
    '  (server, done) => server.listen({ port: 0, host: "::" }, done),',
    "  (server, done) => server.listen(done),",
    "  (server, done) => server.listen(0, 511, done),",
    ...(outside ? [`  (server, done) => server.listen(0, ${JSON.stringify(outside)}, done),`] : []),
    "];",
    "(async () => {",
    "  const bound = [];",
    "  for (const form of forms) {",
    "    const server = http.createServer();",
    "    await new Promise((resolve) => form(server, resolve));",
    "    bound.push(server.address().address);",
    "    server.close();",
    "  }",
    "  console.log(JSON.stringify(bound));",
    "})();"
  ].join("\n"), "utf8");

  const { stdout } = await promisify(execFile)(process.execPath, ["--require", loopbackPreload, script], { encoding: "utf8" });
  const bound = JSON.parse(stdout) as string[];
  assert.deepEqual(bound.slice(0, 8), Array(8).fill("127.0.0.1"));
  // An address named outright is the app's own choice, and is left alone.
  if (outside) assert.equal(bound[8], outside);
});

test("removeBuiltApp deletes a built app's folder and refuses to escape the workspace", async () => {
  writeApp("throwaway-app");
  assert.ok(listBuiltApps().some((a) => a.name === "throwaway-app"), "the app exists first");
  assert.equal(removeBuiltApp("throwaway-app"), true);
  assert.ok(!listBuiltApps().some((a) => a.name === "throwaway-app"), "the app folder is gone");
  assert.equal(removeBuiltApp("throwaway-app"), false, "deleting a missing app returns false");
  // Path guard: an escaping or empty name resolves to nothing inside the workspace.
  assert.equal(removeBuiltApp("../.."), false);
  assert.equal(removeBuiltApp(""), false);
});

test("removeBuiltApp refuses to delete a running app; its folder stays", async () => {
  writeApp("live-app-keep");
  await startApp("live-app-keep");
  assert.equal(removeBuiltApp("live-app-keep"), false, "a running app is not deleted");
  assert.ok(listBuiltApps().some((a) => a.name === "live-app-keep"), "the app folder is still there");
});
