import test from "node:test";
import assert from "node:assert/strict";
import { checkNodeVersion, checkOptionalTool, checkOllama, formatSetupReport } from "../src/services/setupDoctor.js";

test("checkNodeVersion passes at or above the minimum and warns below it", () => {
  assert.equal(checkNodeVersion("v24.4.0").status, "ok");
  assert.equal(checkNodeVersion("v20.0.0").status, "ok");
  const old = checkNodeVersion("v18.19.0");
  assert.equal(old.status, "warn");
  assert.match(old.detail, /below Node 20/);
});

test("checkOptionalTool: present is ok, absent warns and names the feature it powers", () => {
  assert.equal(checkOptionalTool("ffmpeg", true, "make_video").status, "ok");
  const absent = checkOptionalTool("ffmpeg", false, "make_video");
  assert.equal(absent.status, "warn");
  assert.match(absent.detail, /make_video/);
  assert.match(absent.detail, /everything else works/);
});

test("checkOllama: available is ok; unavailable warns with the reason and reassurance", () => {
  assert.equal(checkOllama(true, "reachable, model ready.").status, "ok");
  const down = checkOllama(false, "Ollama is not reachable.");
  assert.equal(down.status, "warn");
  assert.match(down.detail, /not reachable/);
  assert.match(down.detail, /runs without it/);
});

test("formatSetupReport summarises the count and lists every check with its mark", () => {
  const allOk = formatSetupReport([
    { name: "Node.js", status: "ok", detail: "v24" },
    { name: "Ollama + model", status: "ok", detail: "ready" }
  ]);
  assert.match(allOk, /all good/);
  assert.match(allOk, /\[OK {2}\] Node\.js/);

  const withWarn = formatSetupReport([
    { name: "Node.js", status: "ok", detail: "v24" },
    { name: "ffmpeg", status: "warn", detail: "not found" }
  ]);
  assert.match(withWarn, /1 item\(s\) need attention/);
  assert.match(withWarn, /\[WARN\] ffmpeg/);
});
