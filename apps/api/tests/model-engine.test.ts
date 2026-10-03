import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  defaultEnginePort, discoverModels, engineOffReason, enginePaths, enginePort, engineState, engineUrl, findEngineModel,
  isModelOrSize, leftoverEngine, listEngineModels, loadEngineModel, modelKey, presetsText, processName, reviveEngine,
  runtimeDir, sameModel, samplingFor, startEngine, stopEngine, unloadEngineModel
} from "../src/services/modelEngine.js";
import { engineError, readCompletion, toWireMessages } from "../src/services/engineChat.js";
import { checkAvailability } from "../src/services/localModel.js";
import { modelsBody } from "./helpers/fakeEngine.js";

// The model engine: where it and its models are kept, what it is started
// with, and how it is asked to load a model. The engine itself is not run
// here - a stand-in answers in the shapes the real one was recorded answering
// with (llama.cpp b11366, router mode).

const scratch = mkdtempSync(path.join(tmpdir(), "trhai-engine-"));
test.after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const env = (values: Record<string, string>) => values as unknown as NodeJS.ProcessEnv;
type Fetch = typeof fetch;

// ------------------------------------------------------------------- names

test("a model is the same model however its name is spelt", () => {
  // "name:size" is how a model was named when the models were Ollama's, and
  // conversations and .env files still carry it. "name-size" is its file.
  assert.equal(modelKey("qwen2.5-coder:7b"), "qwen2.5-coder-7b");
  assert.equal(modelKey("Qwen3:8B"), "qwen3-8b");
  assert.equal(modelKey("llama3.2:latest"), "llama3.2");
  assert.equal(modelKey("  vexora  "), "vexora");
  assert.equal(sameModel("qwen2.5-coder:7b", "qwen2.5-coder-7b"), true);
  assert.equal(sameModel("qwen2.5-coder-7b", "qwen2.5-3b"), false);
});

test("a name is that model or a size of it, not another model that starts the same way", () => {
  assert.equal(isModelOrSize("qwen2.5", "qwen2.5-3b"), true);
  assert.equal(isModelOrSize("qwen2.5", "qwen2.5:3b"), true);
  assert.equal(isModelOrSize("qwen2.5-coder", "qwen2.5-coder-7b"), true);
  assert.equal(isModelOrSize("llama3.2", "llama3.2:latest"), true);
  assert.equal(isModelOrSize("qwen3", "qwen3-8b"), true);
  // The same letters at the start, and a different model.
  assert.equal(isModelOrSize("qwen2.5", "qwen2.5-coder-7b"), false);
  assert.equal(isModelOrSize("qwen2.5", "qwen2.5-vl-3b"), false, "the vision model is not a size of the chat model");
  assert.equal(isModelOrSize("llama3", "llama3.2-3b"), false);
  assert.equal(isModelOrSize("qwen3-8b", "qwen3"), false, "the longer name is not the shorter one");

  const models = [{ id: "qwen2.5-coder-7b" }, { id: "qwen2.5-3b" }, { id: "qwen3-8b" }];
  assert.equal(findEngineModel(models, "qwen2.5:3b")?.id, "qwen2.5-3b");
  assert.equal(findEngineModel(models, "qwen3")?.id, "qwen3-8b", "a size of it, when the name has none");
  assert.equal(findEngineModel(models, "mistral"), undefined);
});

// ---------------------------------------------------------- where things are

test("the engine and its models live in one folder, and settings move it and its port", () => {
  assert.equal(runtimeDir(env({ LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" })), path.join("C:\\Users\\x\\AppData\\Local", "TRHAI", "runtime"));
  assert.equal(runtimeDir(env({ LOCALAPPDATA: "C:\\a", TRHAI_RUNTIME_DIR: "E:\\models-here" })), "E:\\models-here");

  assert.equal(enginePort(env({})), defaultEnginePort);
  assert.equal(enginePort(env({ TRHAI_ENGINE_PORT: "4555" })), 4555);
  assert.equal(enginePort(env({ TRHAI_ENGINE_PORT: "not a port" })), defaultEnginePort);
  assert.equal(enginePort(env({ TRHAI_ENGINE_PORT: "70000" })), defaultEnginePort);

  // This PC only, unless another engine is named.
  assert.equal(engineUrl(env({})), `http://127.0.0.1:${defaultEnginePort}`);
  assert.equal(engineUrl(env({ TRHAI_ENGINE_PORT: "4555" })), "http://127.0.0.1:4555");
  assert.equal(engineUrl(env({ TRHAI_ENGINE_URL: "http://10.0.0.2:8080//", TRHAI_ENGINE_PORT: "4555" })), "http://10.0.0.2:8080");
});

test("the models are the .gguf files in the folder, and the folders that hold one", () => {
  const dir = path.join(scratch, "models");
  mkdirSync(path.join(dir, "qwen2.5-vl-3b"), { recursive: true });
  mkdirSync(path.join(dir, "empty-folder"));
  writeFileSync(path.join(dir, "qwen3-8b.gguf"), "x".repeat(10));
  writeFileSync(path.join(dir, "Qwen2.5 Coder (7B).GGUF"), "x".repeat(20));
  writeFileSync(path.join(dir, "notes.txt"), "not a model");
  writeFileSync(path.join(dir, "mmproj-stray.gguf"), "x");
  writeFileSync(path.join(dir, "qwen2.5-vl-3b", "Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf"), "x".repeat(30));
  writeFileSync(path.join(dir, "qwen2.5-vl-3b", "mmproj-Qwen2.5-VL-3B-Instruct-Q8_0.gguf"), "x".repeat(5));

  assert.deepEqual(discoverModels(dir), [
    // A name requests and the preset file can both carry: no spaces or brackets.
    { id: "Qwen2.5-Coder-7B", file: path.join(dir, "Qwen2.5 Coder (7B).GGUF"), mmproj: null, sizeBytes: 20 },
    // A folder is one model: its main file, and the vision part beside it.
    {
      id: "qwen2.5-vl-3b",
      file: path.join(dir, "qwen2.5-vl-3b", "Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf"),
      mmproj: path.join(dir, "qwen2.5-vl-3b", "mmproj-Qwen2.5-VL-3B-Instruct-Q8_0.gguf"),
      sizeBytes: 35
    },
    { id: "qwen3-8b", file: path.join(dir, "qwen3-8b.gguf"), mmproj: null, sizeBytes: 10 }
  ], "not the text file, the empty folder, or a vision part with no model");

  assert.deepEqual(discoverModels(path.join(scratch, "no-such-folder")), []);
});

test("the preset file fits every model to the card, and gives each model its file", () => {
  const text = presetsText([
    { id: "qwen3-8b", file: "C:\\m\\qwen3-8b.gguf", mmproj: null, sizeBytes: 1 },
    { id: "qwen2.5-vl-3b", file: "C:\\m\\v\\main.gguf", mmproj: "C:\\m\\v\\mmproj.gguf", sizeBytes: 2 }
  ]);
  const lines = text.split("\n");
  // What every model gets. fit-target 1024 is the measured margin: at 512 an
  // 8B model took a window that spilled off an 8 GB card and crawled.
  const shared = lines.slice(lines.indexOf("[*]"), lines.indexOf("[qwen3-8b]"));
  for (const line of [
    "fit = on", "fit-target = 1024", "fit-ctx = 8192", "jinja = true", "parallel = 1",
    "reasoning-format = deepseek", "sleep-idle-seconds = 300"
  ]) {
    assert.ok(shared.includes(line), `every model gets "${line}"`);
  }
  assert.ok(!text.includes("ctx-size"), "no window is forced: each model gets the largest that fits");

  const first = lines.indexOf("[qwen3-8b]");
  assert.deepEqual(lines.slice(first, first + 2), ["[qwen3-8b]", "model = C:\\m\\qwen3-8b.gguf"]);
  const second = lines.indexOf("[qwen2.5-vl-3b]");
  assert.deepEqual(lines.slice(second, second + 3), ["[qwen2.5-vl-3b]", "model = C:\\m\\v\\main.gguf", "mmproj = C:\\m\\v\\mmproj.gguf"]);
  assert.ok(!lines.slice(first, second).some((line) => line.startsWith("mmproj")), "a model with no vision part is given none");

  // Qwen3 is sampled the way its makers publish for it - which is how it was
  // evaluated, and what Ollama applied to it without saying so. A model with
  // no published settings of its own runs on the engine's defaults.
  assert.deepEqual(lines.slice(first + 2, first + 6), ["temp = 0.6", "top-k = 20", "top-p = 0.95", "min-p = 0"]);
  assert.deepEqual(samplingFor("qwen3-8b"), { temp: "0.6", "top-k": "20", "top-p": "0.95", "min-p": "0" });
  assert.deepEqual(samplingFor("Qwen3-14B-Q4"), samplingFor("qwen3-8b"));
  assert.deepEqual(samplingFor("qwen2.5-coder-7b"), {});
  assert.deepEqual(samplingFor("qwen30-8b"), {}, "another model whose name starts the same way");
  assert.ok(!lines.slice(second).some((line) => line.startsWith("temp")), "the vision model's section has none");

  // TRHAI_CONTEXT_TOKENS forces one window on every model, never below what the prompt needs.
  assert.ok(presetsText([], { contextTokens: 16384 }).split("\n").includes("ctx-size = 16384"));
  assert.ok(presetsText([], { contextTokens: 2048 }).split("\n").includes("ctx-size = 8192"));
});

test("the newest engine in the engine folder is the one used", () => {
  const root = path.join(scratch, "runtime");
  const program = process.platform === "win32" ? "llama-server.exe" : "llama-server";
  for (const build of ["b9000", "b11366", "b10500"]) {
    mkdirSync(path.join(root, "engine", build), { recursive: true });
    writeFileSync(path.join(root, "engine", build, program), "");
  }
  // A newer folder with no program in it - a download that did not finish - is not an engine.
  mkdirSync(path.join(root, "engine", "b99999"));

  const paths = enginePaths(env({ TRHAI_RUNTIME_DIR: root }));
  assert.equal(paths.build, "b11366");
  assert.equal(paths.exe, path.join(root, "engine", "b11366", program));
  assert.equal(paths.modelsDir, path.join(root, "models"));
  assert.equal(paths.presetsFile, path.join(root, "presets.ini"));
  assert.equal(paths.logFile, path.join(path.dirname(root), "engine.log"));

  const named = path.join(root, "engine", "b9000", program);
  const chosen = enginePaths(env({ TRHAI_RUNTIME_DIR: root, TRHAI_ENGINE_EXE: named }));
  assert.deepEqual([chosen.exe, chosen.build], [named, "b9000"], "TRHAI_ENGINE_EXE names another");

  const none = enginePaths(env({ TRHAI_RUNTIME_DIR: path.join(scratch, "nothing-here") }));
  assert.deepEqual([none.exe, none.build], [null, null]);

  // An engine on a port of its own keeps its own files, so a second copy of
  // the app never writes over the first one's presets, log or process id.
  const usual = enginePaths(env({ TRHAI_RUNTIME_DIR: root }));
  const other = enginePaths(env({ TRHAI_RUNTIME_DIR: root, TRHAI_ENGINE_PORT: "4140" }));
  assert.equal(usual.pidFile, path.join(root, "engine.pid"));
  assert.deepEqual([other.presetsFile, other.pidFile, other.logFile],
    [path.join(root, "presets-4140.ini"), path.join(root, "engine-4140.pid"), path.join(path.dirname(root), "engine-4140.log")]);
  assert.equal(other.modelsDir, usual.modelsDir, "the models are the same ones");
});

test("only a process that is an engine is ever taken for one left running", () => {
  // The engine's process id is kept in a file so that one left behind by a
  // killed API can be ended at the next start. Process ids are reused: a file
  // naming a process that is now something else names no engine.
  assert.match(processName(process.pid) ?? "", /^node/i, "this test's own process is found, by name");
  assert.equal(processName(0), null);
  assert.equal(processName(2 ** 31 - 2), null, "no process has this id");

  const file = path.join(scratch, "engine.pid");
  assert.equal(leftoverEngine(file), null, "no file: nothing was left");
  writeFileSync(file, `${process.pid} 1`);
  assert.equal(leftoverEngine(file), null, "a running process that is not an engine is never touched");
  writeFileSync(file, "not a process id");
  assert.equal(leftoverEngine(file), null);
  writeFileSync(file, "");
  assert.equal(leftoverEngine(file), null);
});

// ---------------------------------------------------------- starting it

test("an engine is only ever started again by a process that runs one", async () => {
  // Nothing in this process has started an engine yet, so there is none to
  // start again: a test, or an API told to leave the engine to someone else,
  // must never launch one because a request found nothing listening.
  assert.equal(await reviveEngine(), false);
  assert.equal(engineOffReason(), null);
});

test("with no engine installed, nothing is started, and the reason says what to run", async () => {
  const root = path.join(scratch, "not-installed");
  const state = await startEngine(env({ TRHAI_RUNTIME_DIR: root, TRHAI_ENGINE_PORT: "4999" }));
  assert.equal(state.status, "off");
  assert.equal(state.url, "http://127.0.0.1:4999");
  if (state.status !== "off") return;
  assert.equal(state.reason, `The model engine (llama.cpp) is not installed in ${path.join(root, "engine")}. Run: npm run setup:engine`);
  assert.deepEqual(engineState(), state);
  assert.equal(engineOffReason(), state.reason);

  // And that reason is what the assistant gives for having no model, rather
  // than "nothing is listening" - which says nothing about what to do.
  const availability = await checkAvailability({ baseUrl: engineUrl(), model: "qwen3", modelFromEnv: false, timeoutMs: 1000 });
  assert.deepEqual(availability, { available: false, reason: `No local model: ${state.reason}` });
  // Another address is not this process's engine, so its own state is what is reported.
  const elsewhere = await checkAvailability({ baseUrl: "http://127.0.0.1:1", model: "qwen3", modelFromEnv: false, timeoutMs: 1000 });
  assert.deepEqual(elsewhere, { available: false, reason: "No local model: nothing is listening at http://127.0.0.1:1." });

  // An engine that would not start is not tried again by every request that
  // finds it missing: the answer above came at once, not after another try.
  assert.equal(await reviveEngine(), false, "not again within a few seconds of the last try");

  // Stopping what was never started is not an error - and once the engine has
  // been stopped on purpose, nothing starts it again.
  stopEngine();
  assert.equal(engineState().status, "off");
  assert.equal(await reviveEngine(), false);
});

test("an engine named by its address is used as it is, and none is started", async () => {
  const state = await startEngine(env({ TRHAI_ENGINE_URL: "http://10.0.0.2:8080/", TRHAI_RUNTIME_DIR: path.join(scratch, "runtime") }));
  assert.deepEqual(state, { status: "external", url: "http://10.0.0.2:8080" });
  assert.equal(engineOffReason(), null, "someone else's engine being down is not this process's to explain");
});

// ---------------------------------------------------------- asking it

test("the engine's list is read as it was recorded: status, window, size, images, a failed load", async () => {
  const recorded = { data: [
    {
      id: "qwen3-8b", status: { value: "loaded" }, architecture: { input_modalities: ["text"] },
      meta: { n_ctx: 9216, size: 5027783488, n_params: 8190735360 }
    },
    { id: "qwen2.5-vl-3b", status: { value: "unloaded" }, architecture: { input_modalities: ["text", "image"] } },
    { id: "broken", status: { value: "unloaded", failed: true, exit_code: 1 }, architecture: { input_modalities: ["text"] } },
    { id: "", status: { value: "loaded" } },
    { status: { value: "loaded" } }
  ] };
  const answers = (async () => new Response(JSON.stringify(recorded))) as unknown as Fetch;
  assert.deepEqual(await listEngineModels("http://engine", answers), [
    { id: "qwen3-8b", status: "loaded", windowTokens: 9216, sizeBytes: 5027783488, vision: false, failed: false },
    // Not loaded: the engine says no window and no size for it.
    { id: "qwen2.5-vl-3b", status: "unloaded", windowTokens: null, sizeBytes: null, vision: true, failed: false },
    { id: "broken", status: "unloaded", windowTokens: null, sizeBytes: null, vision: false, failed: true }
  ], "an entry with no name is not a model");

  assert.deepEqual(await listEngineModels("http://engine", (async () => new Response("{}")) as unknown as Fetch), []);
  const refused = (async () => new Response("{}", { status: 503 })) as unknown as Fetch;
  await assert.rejects(listEngineModels("http://engine", refused), /^Error: The model engine answered 503\.$/);
});

/**
 * A stand-in engine with one model, as a fetch. `listed` is what /models says
 * of it at that moment; `onLoad` answers a request to load it. Every request
 * is recorded.
 */
function oneModel(id: string, listed: () => Record<string, unknown>, onLoad: () => Response = () => new Response('{"success":true}')) {
  const asked: Array<{ url: string; body?: unknown }> = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    asked.push(init?.body ? { url, body: JSON.parse(String(init.body)) } : { url });
    if (url.endsWith("/models")) {
      return new Response(JSON.stringify({ data: [{ id, architecture: { input_modalities: ["text"] }, ...listed() }] }));
    }
    return onLoad();
  }) as unknown as Fetch;
  return { asked, fetcher, loads: () => asked.filter((entry) => entry.url.endsWith("/models/load")) };
}

const loadedWith = (window: number) => ({ status: { value: "loaded" }, meta: { n_ctx: window, size: 1 } });
const engineSays = (status: number, message: string) =>
  new Response(JSON.stringify({ error: { code: status, message, type: "server_error" } }), { status });

test("a model already loaded is not loaded again, and its window is the engine's", async () => {
  const engine = oneModel("qwen3-8b", () => loadedWith(9216));
  // Asked for by the name a saved conversation has for it.
  assert.deepEqual(await loadEngineModel("http://engine", "qwen3:8b", { fetchImpl: engine.fetcher }),
    { ok: true, id: "qwen3-8b", windowTokens: 9216 });
  assert.deepEqual(engine.asked, [{ url: "http://engine/models" }], "one look, and nothing asked for");
});

test("a model that is not loaded is asked for once, and waited for while it loads", async () => {
  let phase = "unloaded";
  let looksWhileLoading = 0;
  const engine = oneModel("qwen2.5-coder-7b", () => {
    if (phase === "loading" && ++looksWhileLoading >= 3) phase = "loaded";
    return phase === "loaded" ? loadedWith(31232) : { status: { value: phase } };
  }, () => {
    phase = "loading";
    return new Response('{"success":true}');
  });

  assert.deepEqual(await loadEngineModel("http://engine", "qwen2.5-coder-7b", { fetchImpl: engine.fetcher }),
    { ok: true, id: "qwen2.5-coder-7b", windowTokens: 31232 });
  assert.deepEqual(engine.loads(), [{ url: "http://engine/models/load", body: { model: "qwen2.5-coder-7b" } }],
    "asked once: a model that is loading is waited for, not asked for again");
  assert.ok(looksWhileLoading >= 3, "it looked again until the model was loaded");
});

test("a load the engine puts off - another model is mid-reply - is asked for again until it is taken", async () => {
  let loaded = false;
  let refusals = 2;
  const engine = oneModel("qwen3-8b", () => (loaded ? loadedWith(9216) : { status: { value: "unloaded" } }), () => {
    if (refusals-- > 0) return engineSays(500, "model limit reached, try again later");
    loaded = true;
    return new Response('{"success":true}');
  });

  assert.deepEqual(await loadEngineModel("http://engine", "qwen3-8b", { fetchImpl: engine.fetcher }),
    { ok: true, id: "qwen3-8b", windowTokens: 9216 });
  assert.equal(engine.loads().length, 3, "refused twice, taken the third time");
});

test("a load the engine has already begun is not an error", async () => {
  // Two requests for the same model close together: the second load is
  // answered 400 "already running", and the model turns up loaded.
  let looks = 0;
  const engine = oneModel("qwen3-8b", () => (++looks >= 2 ? loadedWith(9216) : { status: { value: "unloaded" } }),
    () => engineSays(400, "model is already running"));
  assert.deepEqual(await loadEngineModel("http://engine", "qwen3-8b", { fetchImpl: engine.fetcher }),
    { ok: true, id: "qwen3-8b", windowTokens: 9216 });
});

test("a load that fails is reported as that, with where the engine wrote why", async () => {
  // As recorded: the load is taken, the model is "loading", and then it is
  // unloaded again and marked failed.
  let phase = "unloaded";
  const engine = oneModel("broken", () => {
    if (phase === "loading") {
      phase = "failed";
      return { status: { value: "loading" } };
    }
    return phase === "failed" ? { status: { value: "unloaded", failed: true, exit_code: 1 } } : { status: { value: "unloaded" } };
  }, () => {
    phase = "loading";
    return new Response('{"success":true}');
  });

  const result = await loadEngineModel("http://engine", "broken", { fetchImpl: engine.fetcher });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, `broken could not be loaded by the model engine. Its log is ${enginePaths().logFile}.`);
  assert.equal(engine.loads().length, 1, "and it is not asked for over and over");
});

test("a failure left from an earlier try is not taken for this one's", async () => {
  // Listed as failed before anything was asked: the file was missing an hour
  // ago, say. It is asked for all the same, and this time it loads.
  let asked = false;
  let looksAfter = 0;
  const engine = oneModel("qwen3-8b", () => {
    if (!asked) return { status: { value: "unloaded", failed: true, exit_code: 1 } };
    return ++looksAfter >= 2 ? loadedWith(9216) : { status: { value: "loading" } };
  }, () => {
    asked = true;
    return new Response('{"success":true}');
  });
  assert.deepEqual(await loadEngineModel("http://engine", "qwen3-8b", { fetchImpl: engine.fetcher }),
    { ok: true, id: "qwen3-8b", windowTokens: 9216 });
});

test("a load the engine refuses outright is not asked for again", async () => {
  const engine = oneModel("qwen3-8b", () => ({ status: { value: "unloaded" } }), () => engineSays(500, "something else went wrong"));
  assert.deepEqual(await loadEngineModel("http://engine", "qwen3-8b", { fetchImpl: engine.fetcher }),
    { ok: false, reason: "The model engine would not load qwen3-8b (it answered 500)." });
  assert.equal(engine.loads().length, 1);
});

test("a model the engine does not have, and an engine that does not answer, are each said as that", async () => {
  const engine = oneModel("qwen3-8b", () => loadedWith(9216));
  assert.deepEqual(await loadEngineModel("http://engine", "mistral-7b", { fetchImpl: engine.fetcher }),
    { ok: false, reason: "mistral-7b is not one of the models in TRH AI's models folder." });

  const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as Fetch;
  assert.deepEqual(await loadEngineModel("http://engine", "qwen3-8b", { fetchImpl: down }),
    { ok: false, reason: "The model engine did not answer while loading qwen3-8b: fetch failed" });
});

test("Stop ends the wait for a model that is loading, and so does the time allowed", async () => {
  const stop = new AbortController();
  const engine = oneModel("qwen3-8b", () => ({ status: { value: "loading" } }));
  setTimeout(() => stop.abort(), 100);
  const started = Date.now();
  assert.deepEqual(await loadEngineModel("http://engine", "qwen3-8b", { fetchImpl: engine.fetcher, signal: stop.signal, timeoutMs: 60_000 }),
    { ok: false, reason: "Stopped before the model was loaded." });
  assert.ok(Date.now() - started < 5000, "it did not wait out the minute it was allowed");
  assert.deepEqual(engine.loads(), [], "a model already loading is not asked for");

  // The control: nobody stops it, and the time allowed is what ends it.
  const slow = oneModel("qwen3-8b", () => ({ status: { value: "loading" } }));
  assert.deepEqual(await loadEngineModel("http://engine", "qwen3-8b", { fetchImpl: slow.fetcher, timeoutMs: 1200 }),
    { ok: false, reason: "qwen3-8b was not loaded within 1 s." });
});

test("letting a model go asks the engine by its own name for it, and says when it could not", async () => {
  const engine = oneModel("qwen2.5-3b", () => loadedWith(32768));
  assert.deepEqual(await unloadEngineModel("http://engine", "qwen2.5:3b", engine.fetcher), { ok: true });
  assert.deepEqual(engine.asked.at(-1), { url: "http://engine/models/unload", body: { model: "qwen2.5-3b" } });

  const refusing = oneModel("qwen2.5-3b", () => loadedWith(32768), () => engineSays(400, "model is not running"));
  assert.deepEqual(await unloadEngineModel("http://engine", "qwen2.5-3b", refusing.fetcher),
    { ok: false, reason: "The model engine answered with 400." });
  const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as Fetch;
  assert.deepEqual(await unloadEngineModel("http://engine", "qwen2.5-3b", down), { ok: false, reason: "The model engine is not answering." });
});

test("the stand-in the other tests use lists models the way the engine does", async () => {
  // The other test files script a model through helpers/fakeEngine.ts. If its
  // list stopped being readable here, they would all be asking nothing.
  const listed = (async () => new Response(JSON.stringify(modelsBody(["a", "b"], { window: 9216, vision: ["b"] })))) as unknown as Fetch;
  assert.deepEqual(await listEngineModels("http://engine", listed), [
    { id: "a", status: "loaded", windowTokens: 9216, sizeBytes: 1_900_000_000, vision: false, failed: false },
    { id: "b", status: "loaded", windowTokens: 9216, sizeBytes: 1_900_000_000, vision: true, failed: false }
  ]);
  const unloaded = (async () => new Response(JSON.stringify(modelsBody(["a"], { loaded: false })))) as unknown as Fetch;
  assert.deepEqual(await listEngineModels("http://engine", unloaded),
    [{ id: "a", status: "unloaded", windowTokens: null, sizeBytes: null, vision: false, failed: false }]);
});

// ---------------------------------------------------------- the conversation's shape

test("the loop's messages are sent in the engine's format: an id and a type per call, arguments as text", () => {
  const wire = toWireMessages([
    { role: "system", content: "rules" },
    { role: "user", content: "what day is it, and what is 2+2?" },
    {
      role: "assistant", content: "", tool_calls: [
        { function: { name: "current_datetime", arguments: {} } },
        { function: { name: "calculate", arguments: { expression: "2+2" } } }
      ]
    },
    { role: "tool", content: "Monday" },
    { role: "tool", content: "4" },
    { role: "assistant", content: "", tool_calls: [{ function: { name: "search_memory", arguments: { query: "x" } } }] },
    { role: "tool", content: "nothing saved" },
    { role: "assistant", content: "It is Monday, and 4." },
    { role: "user", content: "thanks" }
  ]);

  assert.deepEqual(wire, [
    { role: "system", content: "rules" },
    { role: "user", content: "what day is it, and what is 2+2?" },
    {
      role: "assistant", content: "", tool_calls: [
        { id: "call_1", type: "function", function: { name: "current_datetime", arguments: "{}" } },
        { id: "call_2", type: "function", function: { name: "calculate", arguments: '{"expression":"2+2"}' } }
      ]
    },
    // Each result names the call it answers, in the order they were made.
    { role: "tool", tool_call_id: "call_1", content: "Monday" },
    { role: "tool", tool_call_id: "call_2", content: "4" },
    // Ids never repeat within a conversation.
    { role: "assistant", content: "", tool_calls: [{ id: "call_3", type: "function", function: { name: "search_memory", arguments: '{"query":"x"}' } }] },
    { role: "tool", tool_call_id: "call_3", content: "nothing saved" },
    { role: "assistant", content: "It is Monday, and 4." },
    { role: "user", content: "thanks" }
  ]);
});

test("a result with no call of its own takes the nearest one, or goes without", () => {
  // One result answering a whole batch ("none of these were run") takes the first.
  const batch = toWireMessages([
    { role: "assistant", content: "", tool_calls: [
      { function: { name: "write_file", arguments: { path: "a" } } },
      { function: { name: "write_file", arguments: { path: "b" } } }
    ] },
    { role: "tool", content: "None of these were run." }
  ]);
  assert.equal(batch[1].tool_call_id, "call_1");

  // More results than calls: the extra one takes the last call made.
  const extra = toWireMessages([
    { role: "assistant", content: "", tool_calls: [{ function: { name: "read_file", arguments: { path: "a" } } }] },
    { role: "tool", content: "the file" },
    { role: "tool", content: "a correction about it" }
  ]);
  assert.deepEqual(extra.slice(1).map((message) => message.tool_call_id), ["call_1", "call_1"]);

  // After anything else has been said, a result belongs to no call.
  const stray = toWireMessages([
    { role: "assistant", content: "", tool_calls: [{ function: { name: "read_file", arguments: { path: "a" } } }] },
    { role: "tool", content: "the file" },
    { role: "user", content: "and now?" },
    { role: "tool", content: "stray" }
  ]);
  assert.deepEqual(stray.at(-1), { role: "tool", content: "stray" });

  // Arguments that never arrived are sent as an empty object, not as "undefined".
  const bare = toWireMessages([
    { role: "assistant", content: "", tool_calls: [{ function: { name: "current_datetime" } } as never] }
  ]);
  assert.equal((bare[0].tool_calls as Array<{ function: { arguments: string } }>)[0].function.arguments, "{}");
});

test("a finished reply is read out of the engine's answer", () => {
  // As recorded from a model that called a tool.
  assert.deepEqual(readCompletion({
    model: "qwen2.5-coder-7b",
    choices: [{
      index: 0, finish_reason: "tool_calls",
      message: { role: "assistant", content: null, tool_calls: [{ id: "x1", type: "function", function: { name: "calculate", arguments: '{"expression":"1+1"}' } }] }
    }]
  }, "asked-for"), {
    model: "qwen2.5-coder-7b", content: "",
    toolCalls: [{ function: { name: "calculate", arguments: '{"expression":"1+1"}' } }],
    finishReason: "tool_calls"
  });

  // A thinking model's thoughts come beside its answer, and are not part of it.
  assert.deepEqual(readCompletion({
    model: "qwen3-8b",
    choices: [{ finish_reason: "stop", message: { role: "assistant", reasoning_content: "The user wants a sum.", content: "42" } }]
  }, "asked-for"), { model: "qwen3-8b", content: "42", finishReason: "stop" });

  // Cut off at the limit, and an answer with nothing usable in it.
  assert.deepEqual(readCompletion({ choices: [{ finish_reason: "length", message: { content: "It began" } }] }, "asked-for"),
    { model: "asked-for", content: "It began", finishReason: "length" });
  assert.deepEqual(readCompletion({}, "asked-for"), { model: "asked-for", content: "", finishReason: null });
  assert.deepEqual(readCompletion(null, "asked-for"), { model: "asked-for", content: "", finishReason: null });
});

test("an error from the engine is read down to its sentence", () => {
  // As recorded, for a model that is not there.
  assert.equal(engineError('{"error":{"code":400,"message":"model \'nope\' not found","type":"invalid_request_error"}}'), "model 'nope' not found");
  assert.equal(engineError('{"error":"plain words"}'), "plain words");
  // The message itself JSON again, as a runner's error comes wrapped.
  assert.equal(engineError(JSON.stringify({ error: JSON.stringify({ error: { message: "inner words" } }) })), "inner words");
  assert.equal(engineError("not JSON at all\nwith a second line"), "not JSON at all");
  assert.equal(engineError(""), "");
  assert.equal(engineError("x".repeat(500)).length, 200, "never a page of it");
});
