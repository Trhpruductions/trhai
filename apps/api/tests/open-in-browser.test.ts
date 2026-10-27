import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { isWebAddress, launchCommand, openInBrowser } from "../src/services/openInBrowser.js";

// Handing an address to the system's browser: what is started, with what, and when it is refused.
// Every call here gives the launcher a stand-in process; none of it opens a browser.

type Started = { file: string; args: string[] };

function standIn(outcome: "spawn" | "error" | "throw") {
  const started: Started[] = [];
  let unreffed = 0;
  const startProcess = (file: string, args: string[]) => {
    started.push({ file, args });
    if (outcome === "throw") throw new Error("spawn EPERM");
    const child = Object.assign(new EventEmitter(), { unref: () => { unreffed += 1; } });
    setImmediate(() => (outcome === "error" ? child.emit("error", new Error("spawn rundll32.exe ENOENT")) : child.emit("spawn")));
    return child;
  };
  return { started, startProcess, unreffed: () => unreffed };
}

const noSwitch = {} as NodeJS.ProcessEnv;

test("on Windows the address is one argument to the system's own URL handler, never a command line", async () => {
  const url = "https://open.spotify.com/search/Shadows%20of%20Ruin?a=1&b=2";
  const run = standIn("spawn");
  const result = await openInBrowser(url, { platform: "win32", env: noSwitch, startProcess: run.startProcess });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(run.started, [{ file: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] }]);
  assert.equal(run.unreffed(), 1, "the browser is left to outlive this process");
});

test("the other systems have their own way, with the address still one argument", () => {
  assert.deepEqual(launchCommand("https://example.com/", "darwin"), { file: "open", args: ["https://example.com/"] });
  assert.deepEqual(launchCommand("https://example.com/", "linux"), { file: "xdg-open", args: ["https://example.com/"] });
});

test("only a web address is handed over", async () => {
  for (const text of ["file:///C:/Windows/System32/cmd.exe", "javascript:alert(1)", "ms-settings:privacy", "calc.exe", "", "https://", "https://user:pass@example.com/", "ftp://example.com/"]) {
    const run = standIn("spawn");
    const result = await openInBrowser(text, { platform: "win32", env: noSwitch, startProcess: run.startProcess });
    assert.equal(result.ok, false, `refused: ${text}`);
    assert.deepEqual(run.started, [], `nothing was started for: ${text}`);
  }
  assert.equal(isWebAddress("http://localhost:3000/"), true);
  assert.equal(isWebAddress("https://example.com/a b"), true, "the URL parser escapes a space");
});

test("what is handed over is the parsed address, with a space or a quote escaped", async () => {
  const run = standIn("spawn");
  await openInBrowser('https://example.com/a b"c', { platform: "win32", env: noSwitch, startProcess: run.startProcess });
  assert.deepEqual(run.started[0]?.args, ["url.dll,FileProtocolHandler", "https://example.com/a%20b%22c"]);
});

test("with the switch off nothing is started, and the reply says why", async () => {
  const run = standIn("spawn");
  const result = await openInBrowser("https://example.com/", { platform: "win32", env: { TRHAI_OPEN_BROWSER: "off" }, startProcess: run.startProcess });
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /switched off/);
  assert.deepEqual(run.started, []);
});

test("a process that will not start, or a launcher that throws, is a reason and not a crash", async () => {
  const failed = await openInBrowser("https://example.com/", { platform: "win32", env: noSwitch, startProcess: standIn("error").startProcess });
  assert.equal(failed.ok, false);
  assert.match(failed.ok ? "" : failed.reason, /would not start the browser \(spawn rundll32\.exe ENOENT\)/);

  const thrown = await openInBrowser("https://example.com/", { platform: "win32", env: noSwitch, startProcess: standIn("throw").startProcess });
  assert.equal(thrown.ok, false);
  assert.match(thrown.ok ? "" : thrown.reason, /would not start the browser \(spawn EPERM\)/);
});

test("the test suite's own setting keeps the real launcher from opening anything", async () => {
  // isolate-state.ts sets it before any test loads. A test that forgot to hand over a stand-in gets this, not a window.
  assert.equal(process.env.TRHAI_OPEN_BROWSER, "off");
  const result = await openInBrowser("https://example.com/");
  assert.equal(result.ok, false);
});
