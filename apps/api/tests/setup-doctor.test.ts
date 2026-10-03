import test from "node:test";
import assert from "node:assert/strict";
import { checkModelEngine, checkNodeVersion, checkOptionalTool, formatSetupReport } from "../src/services/setupDoctor.js";

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

test("checkModelEngine: installed with a model is ok; each thing missing warns with what to do", () => {
  const where = { engineDir: "C:\\runtime\\engine", modelsDir: "C:\\runtime\\models" };

  const ready = checkModelEngine({ ...where, build: "b11366", models: ["qwen2.5-coder-7b", "qwen3-8b"] });
  assert.equal(ready.status, "ok");
  assert.match(ready.detail, /b11366/);
  assert.match(ready.detail, /qwen2\.5-coder-7b, qwen3-8b/);

  const noEngine = checkModelEngine({ ...where, build: null, models: ["qwen3-8b"] });
  assert.equal(noEngine.status, "warn", "the app runs without it, so not missing");
  assert.match(noEngine.detail, /npm run setup:engine/);
  assert.match(noEngine.detail, /C:\\runtime\\engine/);
  assert.match(noEngine.detail, /runs without it/);

  const noModel = checkModelEngine({ ...where, build: "b11366", models: [] });
  assert.equal(noModel.status, "warn");
  assert.match(noModel.detail, /no model in C:\\runtime\\models/);
  assert.match(noModel.detail, /\.gguf/);
  assert.doesNotMatch(noModel.detail, /setup:engine/, "the engine is there; only a model is not");
});

test("formatSetupReport summarises the count and lists every check with its mark", () => {
  const allOk = formatSetupReport([
    { name: "Node.js", status: "ok", detail: "v24" },
    { name: "Model engine", status: "ok", detail: "ready" }
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
