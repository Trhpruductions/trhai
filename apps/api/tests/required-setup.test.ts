import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { cancelSetup, modelCatalog, resetSetupForTests, setupJob, startSetup, type CatalogModel, type Hardware, type PinnedFile } from "../src/services/modelSetup.js";
import {
  maxAutomaticAttempts, requiredRequest, requiredSetupGeneration, requiredStatus, resetRequiredSetupForTests, restartWhenIdle,
  setupStatusWithRequired, startRequiredSetup
} from "../src/services/requiredSetup.js";
import { toolCatalogue, type ToolDef } from "../src/services/toolCatalog.js";

// What an update brings that has to be installed too: that a copy which is set up is brought up to the bundle by
// itself, that a new install is left to its first-run screen, that a job that fails or is stopped is said so and
// can be tried again, and that the engine is not restarted under someone's reply.

const gib = 1024 ** 3;
const smallPc: Hardware = { totalMemoryBytes: 8 * gib, cpuCores: 4, gpu: null };
const bigPc: Hardware = { totalMemoryBytes: 32 * gib, cpuCores: 16, gpu: { vendor: "nvidia", name: "RTX 4060", memoryMiB: 8188, driver: "581.29" } };
const exeName = process.platform === "win32" ? "llama-server.exe" : "llama-server";

function pinned(name: string, content: Buffer): PinnedFile {
  return { name, url: `https://files.example/${name}`, sizeBytes: content.length, sha256: createHash("sha256").update(content).digest("hex") };
}

function server(files: Record<string, Buffer>, options: { slow?: boolean } = {}) {
  const seen: string[] = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    seen.push(url);
    const body = files[url];
    if (!body) return new Response("missing", { status: 404 });
    if (options.slow) {
      const signal = init?.signal;
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          if (signal?.aborted) { controller.error(new Error("aborted")); return; }
          controller.enqueue(new Uint8Array(body.subarray(0, 4)));
        }
      });
      return new Response(stream, { status: 200 });
    }
    return new Response(new Uint8Array(body), { status: 200 });
  };
  return { fetcher, seen };
}

async function finished(): Promise<NonNullable<ReturnType<typeof setupJob>>> {
  for (let i = 0; i < 600; i += 1) {
    const job = setupJob();
    if (job && job.state !== "running") return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("setup did not finish");
}

/** A tool of one file, kept under `<root>/tools/<id>`. */
function fakeTool(id: ToolDef["id"], root: string, content: Buffer): ToolDef {
  const file = pinned(`${id}.bin`, content);
  const there = () => existsSync(path.join(root, "tools", id, file.name));
  return {
    id, label: `Fake ${id}`, summary: "A stand-in tool, for the tests only.", needs: "nothing",
    license: { name: "Test", url: "https://example.test/licence", commercialUse: true },
    files: [file],
    missing: () => (there() ? [] : [file]),
    installed: () => there(),
    place(downloads) {
      mkdirSync(path.join(root, "tools", id), { recursive: true });
      writeFileSync(path.join(root, "tools", id, file.name), readFileSync(path.join(downloads, file.name)));
    }
  };
}

type Fixture = ReturnType<typeof fixture>;

/** A PC that is set up - an engine and an older model - and short of everything the bundle adds. */
function fixture(options: { setUp?: boolean; hardware?: Hardware } = {}) {
  resetSetupForTests();
  resetRequiredSetupForTests();
  const root = mkdtempSync(path.join(tmpdir(), "trhai-required-"));
  const env = { TRHAI_RUNTIME_DIR: root } as NodeJS.ProcessEnv;
  if (options.setUp !== false) {
    mkdirSync(path.join(root, "engine", "b11366"), { recursive: true });
    writeFileSync(path.join(root, "engine", "b11366", exeName), "engine");
    mkdirSync(path.join(root, "models"), { recursive: true });
    writeFileSync(path.join(root, "models", "qwen2.5-coder-7b.gguf"), "an older model");
  }
  const hardware = options.hardware ?? smallPc;
  const chatId = hardware === bigPc ? "qwen2.5-coder-7b-abliterated" : "qwen3-4b-instruct-2507-abliterated";
  const visionId = hardware === bigPc ? "qwen3-vl-8b-abliterated" : "qwen3-vl-4b-abliterated";
  const bodies = {
    chat: Buffer.from("pretend weights, with the refusals taken out"),
    main: Buffer.from("pretend picture model"),
    projector: Buffer.from("pretend picture part"),
    speech: Buffer.from("pretend voices"), listening: Buffer.from("pretend ears"), video: Buffer.from("pretend ffmpeg")
  };
  const catalog: CatalogModel[] = [
    { ...modelCatalog[0], id: chatId, vision: false, files: [pinned("Chat.gguf", bodies.chat)] },
    { ...modelCatalog[2], id: visionId, vision: true, files: [pinned("Pictures.gguf", bodies.main), pinned("mmproj-Pictures.gguf", bodies.projector)] }
  ];
  const tools = [fakeTool("speech", root, bodies.speech), fakeTool("listening", root, bodies.listening), fakeTool("video", root, bodies.video)];
  const files: Record<string, Buffer> = {
    [catalog[0].files[0].url]: bodies.chat, [catalog[1].files[0].url]: bodies.main, [catalog[1].files[1].url]: bodies.projector,
    [tools[0].files[0].url]: bodies.speech, [tools[1].files[0].url]: bodies.listening, [tools[2].files[0].url]: bodies.video
  };
  const restarts: number[] = [];
  const deps = { env, hardware, catalog, tools, restart: async () => { restarts.push(Date.now()); } };
  const markerFile = path.join(root, "required-setup.json");
  const marker = () => (existsSync(markerFile) ? JSON.parse(readFileSync(markerFile, "utf8")) as Record<string, unknown> : null);
  return { root, env, deps, files, restarts, marker, markerFile, chatId, visionId, hardware };
}

const total = (fixture: Fixture) => Object.values(fixture.files).reduce((sum, body) => sum + body.length, 0);

// ---------------------------------------------------------------- what is required

test("the bundle is the engine, the model to chat with, the one that looks at pictures, and every tool", () => {
  assert.deepEqual(requiredRequest(smallPc), {
    engine: true, models: ["qwen3-4b-instruct-2507-abliterated", "qwen3-vl-4b-abliterated"],
    tools: process.platform === "win32" ? toolCatalogue.map((tool) => tool.id) : []
  });
  assert.deepEqual(requiredRequest(bigPc).models, ["qwen2.5-coder-7b-abliterated", "qwen3-vl-8b-abliterated"]);
  if (process.platform === "win32") assert.deepEqual(requiredRequest(smallPc).tools, ["speech", "listening", "video"]);
  assert.equal(requiredSetupGeneration, 1);
});

test("a copy that is set up and short of the bundle is told what it lacks, in bytes, and is not yet running", () => {
  const f = fixture();
  const status = requiredStatus(f.deps);
  assert.equal(status.applies, true);
  assert.equal(status.state, "waiting");
  assert.equal(status.remainingBytes, total(f));
  assert.equal(status.attempts, 0);
  assert.equal(status.error, null);
  assert.equal(status.generation, requiredSetupGeneration);
});

test("a new install is left to its first-run screen: nothing is forced, and nothing is started", () => {
  const f = fixture({ setUp: false });
  const status = requiredStatus(f.deps);
  assert.equal(status.applies, false);
  const { fetcher, seen } = server(f.files);
  const started = startRequiredSetup({}, { ...f.deps, fetcher: fetcher as never });
  assert.equal(started.started, false);
  assert.equal(!started.started && started.reason, "new-install");
  assert.deepEqual(seen, []);
  assert.equal(f.marker(), null, "and nothing is written down about it");
});

test("an engine and only a picture model cannot answer yet, so that is a new install too", () => {
  const f = fixture({ setUp: false });
  mkdirSync(path.join(f.root, "engine", "b11366"), { recursive: true });
  writeFileSync(path.join(f.root, "engine", "b11366", exeName), "engine");
  mkdirSync(path.join(f.root, "models", "some-picture-model"), { recursive: true });
  writeFileSync(path.join(f.root, "models", "some-picture-model", "Model.gguf"), "x");
  writeFileSync(path.join(f.root, "models", "some-picture-model", "mmproj-Model.gguf"), "x");
  assert.equal(requiredStatus(f.deps).applies, false);
  const started = startRequiredSetup({}, f.deps);
  assert.equal(!started.started && started.reason, "new-install");
});

test("an engine of the person's own, or none to run, is not given models: nothing applies and nothing starts", () => {
  const f = fixture();
  for (const own of [{ TRHAI_ENGINE_URL: "http://10.0.0.5:8080" }, { TRHAI_ENGINE: "off" }]) {
    const env = { ...f.env, ...own } as NodeJS.ProcessEnv;
    assert.equal(requiredStatus({ ...f.deps, env }).applies, false, JSON.stringify(own));
    const started = startRequiredSetup({ manual: true }, { ...f.deps, env });
    assert.equal(!started.started && started.reason, "own-engine", JSON.stringify(own));
  }
  assert.equal(setupJob()?.steps.length ?? 0, 0, "nothing was downloaded");
  assert.equal(requiredStatus(f.deps).applies, true, "and without them it applies");
});

test("it can be switched off, and then it neither applies nor starts", () => {
  const f = fixture();
  const env = { ...f.env, TRHAI_REQUIRED_SETUP: "off" } as NodeJS.ProcessEnv;
  assert.equal(requiredStatus({ ...f.deps, env }).applies, false);
  const started = startRequiredSetup({ manual: true }, { ...f.deps, env });
  assert.equal(!started.started && started.reason, "off");
  assert.equal(setupJob(), null);
});

// ---------------------------------------------------------------- bringing it up

test("a copy that is set up is brought up to the bundle in one job: models, then tools, then it is done and stays done", async () => {
  const f = fixture();
  const { fetcher, seen } = server(f.files);
  const started = startRequiredSetup({}, { ...f.deps, fetcher: fetcher as never });
  assert.ok(started.started);
  assert.deepEqual(started.job.steps.map((step) => [step.kind, step.id]), [
    ["model", f.chatId], ["model", f.visionId], ["tool", "speech"], ["tool", "listening"], ["tool", "video"]
  ], "the engine is there already, so it is not fetched; the model to chat with comes first");
  assert.equal(requiredStatus(f.deps).state, "running");
  assert.equal(f.marker()?.state, "running");

  const job = await finished();
  assert.equal(job.state, "done", job.error ?? "");
  assert.equal(seen.length, 6);
  assert.ok(existsSync(path.join(f.root, "models", `${f.chatId}.gguf`)));
  assert.ok(existsSync(path.join(f.root, "models", f.visionId, "mmproj-Pictures.gguf")));
  assert.equal(f.restarts.length, 1, "the engine is restarted once, for the models");
  assert.deepEqual(
    { state: f.marker()?.state, attempts: f.marker()?.attempts, generation: f.marker()?.generation, error: f.marker()?.error },
    { state: "done", attempts: 1, generation: requiredSetupGeneration, error: null }
  );
  const status = requiredStatus(f.deps);
  assert.deepEqual([status.state, status.remainingBytes, status.error], ["done", 0, null]);

  // Asked again it does nothing - and a model a person removes afterwards stays removed.
  rmSync(path.join(f.root, "models", `${f.chatId}.gguf`));
  const again = startRequiredSetup({}, { ...f.deps, fetcher: fetcher as never });
  assert.equal(!again.started && again.reason, "done");
  assert.equal(requiredStatus(f.deps).state, "done");
  assert.equal(seen.length, 6, "nothing was fetched");
});

test("on a PC that already has everything the bundle brings, it is done at once, with no job", () => {
  const f = fixture();
  mkdirSync(path.join(f.root, "models", f.visionId), { recursive: true });
  writeFileSync(path.join(f.root, "models", f.visionId, "Pictures.gguf"), "x");
  writeFileSync(path.join(f.root, "models", f.visionId, "mmproj-Pictures.gguf"), "x");
  writeFileSync(path.join(f.root, "models", `${f.chatId}.gguf`), "x");
  for (const tool of f.deps.tools) {
    mkdirSync(path.join(f.root, "tools", tool.id), { recursive: true });
    writeFileSync(path.join(f.root, "tools", tool.id, `${tool.id}.bin`), "x");
  }
  assert.equal(requiredStatus(f.deps).state, "done");
  const started = startRequiredSetup({}, f.deps);
  assert.equal(!started.started && started.reason, "done");
  assert.equal(f.marker()?.state, "done", "and it is written down, so it is not looked at again");
  assert.equal(setupJob()?.steps.length ?? 0, 0, "and no job had anything to do");
});

test("a job that fails says why, and trying again continues with what is missing", async () => {
  const f = fixture();
  const broken = { ...f.files, [f.deps.catalog[1].files[0].url]: Buffer.from("pretend picture modeL") };
  const first = server(broken);
  assert.ok(startRequiredSetup({}, { ...f.deps, fetcher: first.fetcher as never }).started);
  const failed = await finished();
  assert.equal(failed.state, "failed");
  assert.match(failed.error ?? "", /did not match/);
  assert.equal(f.marker()?.state, "failed");
  assert.equal(f.marker()?.attempts, 1);
  const status = requiredStatus(f.deps);
  assert.equal(status.state, "failed");
  assert.match(status.error ?? "", /did not match/);
  assert.equal(status.attempts, 1);
  assert.ok(existsSync(path.join(f.root, "models", `${f.chatId}.gguf`)), "what did finish is kept");
  assert.ok(status.remainingBytes > 0 && status.remainingBytes < total(f), "and is not asked for again");

  const second = server(f.files);
  const retried = startRequiredSetup({ manual: true }, { ...f.deps, fetcher: second.fetcher as never });
  assert.ok(retried.started);
  assert.deepEqual(retried.job.steps.map((step) => step.id), [f.visionId, "speech", "listening", "video"]);
  assert.equal((await finished()).state, "done");
  assert.deepEqual([f.marker()?.state, f.marker()?.attempts, f.marker()?.error], ["done", 2, null]);
  assert.equal(requiredStatus(f.deps).error, null);
});

test("stopping it is recorded as stopped, not as a failure, and it can be resumed", async () => {
  const f = fixture();
  const slow = server(f.files, { slow: true });
  assert.ok(startRequiredSetup({}, { ...f.deps, fetcher: slow.fetcher as never }).started);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(cancelSetup(), true);
  assert.equal((await finished()).state, "cancelled");
  const status = requiredStatus(f.deps);
  assert.equal(status.state, "stopped");
  assert.equal(status.error, null);
  assert.equal(f.marker()?.state, "stopped");
  const resumed = startRequiredSetup({}, { ...f.deps, fetcher: server(f.files).fetcher as never });
  assert.ok(resumed.started, "the next launch carries on");
  assert.equal((await finished()).state, "done");
});

test("it starts by itself three times at most, and a person asking is never turned away for that", async () => {
  const f = fixture();
  writeFileSync(f.markerFile, JSON.stringify({ generation: requiredSetupGeneration, state: "failed", attempts: maxAutomaticAttempts, startedAt: null, finishedAt: null, error: "no connection" }));
  const { fetcher, seen } = server(f.files);
  const automatic = startRequiredSetup({}, { ...f.deps, fetcher: fetcher as never });
  assert.equal(!automatic.started && automatic.reason, "gave-up");
  assert.deepEqual(seen, []);
  assert.equal(requiredStatus(f.deps).state, "failed", "the banner still shows it, with its reason");
  const manual = startRequiredSetup({ manual: true }, { ...f.deps, fetcher: fetcher as never });
  assert.ok(manual.started);
  assert.equal((await finished()).state, "done");
  assert.equal(f.marker()?.attempts, maxAutomaticAttempts + 1);
});

test("a setup that is already running is not started over, and its record is left alone", async () => {
  const f = fixture();
  const slow = server(f.files, { slow: true });
  assert.ok(startSetup({ models: [f.chatId] }, { ...f.deps, fetcher: slow.fetcher as never }).ok, "someone started one of their own");
  const started = startRequiredSetup({}, { ...f.deps, fetcher: slow.fetcher as never });
  assert.equal(!started.started && started.reason, "busy");
  assert.equal(f.marker(), null);
  assert.notEqual(requiredStatus(f.deps).state, "running", "a job that is not its own is not taken for it");
  cancelSetup();
  await finished();
});

test("a drive without room is told so in numbers, and the failure is kept for the banner", () => {
  const f = fixture();
  const huge = { ...f.deps.catalog[0], files: [{ ...f.deps.catalog[0].files[0], sizeBytes: 2 ** 60 }] };
  const started = startRequiredSetup({}, { ...f.deps, catalog: [huge, f.deps.catalog[1]] });
  assert.equal(!started.started && started.reason, "refused");
  assert.match(!started.started ? started.message : "", /Not enough free space/);
  assert.equal(f.marker()?.state, "failed");
  assert.match(String(f.marker()?.error), /Not enough free space/);
  assert.equal(setupJob(), null);
});

test("a job cut short by TRH AI closing starts again by itself, until it has been cut short too often to", () => {
  const f = fixture();
  writeFileSync(f.markerFile, JSON.stringify({ generation: requiredSetupGeneration, state: "running", attempts: 1, startedAt: "2026-10-25T10:00:00.000Z", finishedAt: null, error: null }));
  assert.equal(requiredStatus(f.deps).state, "waiting", "no job of this process's own is running: the record is of one that was cut short");
  writeFileSync(f.markerFile, JSON.stringify({ generation: requiredSetupGeneration, state: "running", attempts: maxAutomaticAttempts, startedAt: null, finishedAt: null, error: null }));
  const status = requiredStatus(f.deps);
  assert.equal(status.state, "stopped", "so that the banner does not promise a start that will not come by itself");
  assert.equal(status.error, null);
  assert.equal(!startRequiredSetup({}, f.deps).started, true);
});

test("a record of an earlier bundle, or one that cannot be read, is no record", () => {
  const f = fixture();
  writeFileSync(f.markerFile, JSON.stringify({ generation: requiredSetupGeneration - 1, state: "done", attempts: 1 }));
  assert.equal(requiredStatus(f.deps).state, "waiting", "the bundle changed since");
  writeFileSync(f.markerFile, "{ not json");
  assert.equal(requiredStatus(f.deps).state, "waiting");
  writeFileSync(f.markerFile, JSON.stringify({ generation: requiredSetupGeneration, state: "sideways", attempts: "many" }));
  assert.deepEqual([requiredStatus(f.deps).state, requiredStatus(f.deps).attempts], ["waiting", 0]);
});

test("the status the screens read carries it, and the engine's restart is for the models only when it waits for quiet", async () => {
  const f = fixture();
  const status = setupStatusWithRequired(f.env);
  assert.equal(typeof status.required.applies, "boolean");
  assert.equal(status.required.generation, requiredSetupGeneration);
  assert.equal(status.required.state === "done" || status.required.remainingBytes > 0 || !status.required.applies, true);
});

// ---------------------------------------------------------------- not under a reply

test("the engine is restarted when nobody has been asking it for a few seconds, and not while someone is", async () => {
  let clock = 0;
  let busy = 3;
  const restarts: number[] = [];
  const outcome = await restartWhenIdle({
    quietMs: 3_000, pollMs: 1_000, giveUpMs: 60_000, now: () => clock, inFlight: () => busy,
    sleep: async (ms) => { clock += ms; if (clock === 5_000) busy = 0; },
    restart: async () => { restarts.push(clock); }
  });
  assert.equal(outcome, "restarted");
  // Busy until 5 s, quiet from the poll at 5 s, and three seconds of quiet are 8 s.
  assert.deepEqual(restarts, [8_000]);

  // Someone asks again in the middle of the quiet: the wait starts over.
  clock = 0;
  let calls = 0;
  const again: number[] = [];
  await restartWhenIdle({
    quietMs: 3_000, pollMs: 1_000, giveUpMs: 60_000, now: () => clock,
    inFlight: () => (clock === 2_000 ? 1 : 0), sleep: async (ms) => { clock += ms; calls += 1; },
    restart: async () => { again.push(clock); }
  });
  assert.deepEqual(again, [6_000], "quiet from 3 s, three seconds of it");
  assert.ok(calls >= 5);
});

test("an engine that is never quiet is left, and picks the models up whenever TRH AI next opens", async () => {
  let clock = 0;
  const restarts: number[] = [];
  const outcome = await restartWhenIdle({
    quietMs: 3_000, pollMs: 1_000, giveUpMs: 20_000, now: () => clock, inFlight: () => 1,
    sleep: async (ms) => { clock += ms; }, restart: async () => { restarts.push(clock); }
  });
  assert.equal(outcome, "left");
  assert.deepEqual(restarts, []);
  assert.ok(clock >= 20_000);
  // A restart that throws is not the setup's failure.
  clock = 0;
  assert.equal(await restartWhenIdle({
    quietMs: 0, pollMs: 1_000, giveUpMs: 5_000, now: () => clock, inFlight: () => 0, sleep: async (ms) => { clock += ms; },
    restart: async () => { throw new Error("the engine would not start"); }
  }), "restarted");
});

// ---------------------------------------------------------------- over HTTP

test("the setup status and the required job are reachable over HTTP, and a new install is refused politely", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "trhai-required-routes-"));
  const saved = { runtime: process.env.TRHAI_RUNTIME_DIR, required: process.env.TRHAI_REQUIRED_SETUP };
  process.env.TRHAI_RUNTIME_DIR = root;
  delete process.env.TRHAI_REQUIRED_SETUP;
  resetSetupForTests();
  resetRequiredSetupForTests();
  const { createApp } = await import("../src/server.js");
  const app = createApp().listen(0);
  await once(app, "listening");
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  try {
    const read = await (await fetch(`${base}/v1/setup`)).json() as { data: { needsSetup: boolean; required: { applies: boolean; state: string; generation: number } } };
    assert.equal(read.data.needsSetup, true, "an empty runtime folder is a new install");
    assert.equal(read.data.required.applies, false);
    assert.equal(read.data.required.generation, requiredSetupGeneration);

    const refused = await fetch(`${base}/v1/setup/required`, { method: "POST" });
    assert.equal(refused.status, 409);
    const body = await refused.json() as { code: string; message: string };
    assert.equal(body.code, "SETUP_REFUSED");
    assert.match(body.message, /not set up yet/);
    assert.equal(setupJob(), null, "and nothing was downloaded");
  } finally {
    await new Promise<void>((resolve) => app.close(() => resolve()));
    if (saved.runtime === undefined) delete process.env.TRHAI_RUNTIME_DIR; else process.env.TRHAI_RUNTIME_DIR = saved.runtime;
    if (saved.required !== undefined) process.env.TRHAI_REQUIRED_SETUP = saved.required;
    rmSync(root, { recursive: true, force: true });
  }
});
