import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fakeEngine } from "./helpers/fakeEngine.js";

// One model for talking and for pictures, the owner's choice of 2026-11-05 to keep the
// download down. A picture model talks when it is the only one here, which is on now. New
// copies being recommended only that model is built and off, until a run on the graphics
// card shows it does the work.

process.env.ASCEND_WORKSPACE = mkdtempSync(path.join(tmpdir(), "trhai-one-model-"));
const { modelsThatTalk } = await import("../src/services/modelEngine.js");
const { chatModelsFrom } = await import("../src/services/modelCatalog.js");
const { checkAvailability } = await import("../src/services/localModel.js");
const { runAgent } = await import("../src/services/agentLoop.js");
const { lookAtImages } = await import("../src/services/vision.js");
const {
  canAnswer, hardwareDefaults, modelSize, modelCatalog, oneModel, oneModelByDefault, planSetup, recommendedModel, recommendedVisionModel
} = await import("../src/services/modelSetup.js");
const { requiredRequest } = await import("../src/services/requiredSetup.js");
type Hardware = import("../src/services/modelSetup.js").Hardware;
type EngineModel = import("../src/services/modelEngine.js").EngineModel;

const gib = 1024 ** 3;
const bigPc: Hardware = { totalMemoryBytes: 32 * gib, cpuCores: 12, gpu: { vendor: "nvidia", name: "A card", memoryMiB: 8192, driver: "581.0" } };
const smallPc: Hardware = { totalMemoryBytes: 8 * gib, cpuCores: 4, gpu: null };
const on = { TRHAI_ONE_MODEL: "on" } as NodeJS.ProcessEnv;
const entry = (id: string, vision: boolean): EngineModel => ({ id, status: "unloaded", windowTokens: null, sizeBytes: 1, vision, failed: false });
const picture = "qwen3-vl-8b-abliterated";
const coder = "qwen2.5-coder-7b-abliterated";
const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex");
const configFor = (baseUrl: string) => ({ baseUrl, model: "qwen2.5-coder", modelFromEnv: false, timeoutMs: 5000 });

// ---------------------------------------------------------------- a picture model alone talks

test("the talking models talk; with none of them, the picture models do", () => {
  const both = [entry(coder, false), entry(picture, true)];
  assert.deepEqual(modelsThatTalk(both).map((model) => model.id), [coder]);
  assert.deepEqual(modelsThatTalk([entry(picture, true)]).map((model) => model.id), [picture]);
  assert.deepEqual(modelsThatTalk([]), []);
});

test("the model picker lists a picture model only when it is the one that talks, and never an embedding model", () => {
  assert.deepEqual(chatModelsFrom([entry(coder, false), entry(picture, true)]).map((model) => model.name), [coder]);
  assert.deepEqual(chatModelsFrom([entry(picture, true)]).map((model) => model.name), [picture]);
  assert.deepEqual(chatModelsFrom([entry("nomic-embed-text", false), entry(picture, true)]).map((model) => model.name), [picture]);
  assert.deepEqual(chatModelsFrom([entry("nomic-embed-text", false)]), []);
});

test("a PC with only a picture model has a model to answer with", async () => {
  const engine = await fakeEngine({ models: [picture], vision: [picture] });
  try {
    const availability = await checkAvailability(configFor(engine.baseUrl));
    assert.equal(availability.available, true);
    if (availability.available) assert.equal(availability.model, picture);
  } finally {
    await engine.close();
  }
});

test("a PC with both talks with the talking model, as it always has", async () => {
  const engine = await fakeEngine({ models: [coder, picture], vision: [picture] });
  try {
    const availability = await checkAvailability(configFor(engine.baseUrl));
    assert.equal(availability.available, true);
    if (availability.available) assert.equal(availability.model, coder);
  } finally {
    await engine.close();
  }
});

test("alone, it answers a question with the assistant's tools on offer, and a picture goes to the same model", async () => {
  const engine = await fakeEngine({ models: [picture], vision: [picture], reply: { message: { content: "Four." } } });
  try {
    // As the orchestrator does it: ask which model answers, then run the turn on that one.
    const config = configFor(engine.baseUrl);
    const availability = await checkAvailability(config);
    assert.ok(availability.available);
    const result = await runAgent({ ...config, model: availability.model }, "what is two plus two, and why?", { memories: [], knowledge: [] });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (result.ok) assert.equal(result.model, picture);
    assert.ok((engine.chats[0]?.tools ?? []).length > 0, "the tools were offered to it");

    const looked = await lookAtImages([{ name: "shot.png", data: png }], "what is this?", configFor(engine.baseUrl), { model: picture });
    assert.equal(looked.ok, true, JSON.stringify(looked));
    if (looked.ok) assert.equal(looked.model, picture);
  } finally {
    await engine.close();
  }
});

test("a PC with an engine and only a picture model is set up, and one with no model is not", () => {
  const root = mkdtempSync(path.join(tmpdir(), "trhai-one-model-runtime-"));
  const env = { TRHAI_RUNTIME_DIR: root } as NodeJS.ProcessEnv;
  const program = process.platform === "win32" ? "llama-server.exe" : "llama-server";
  try {
    mkdirSync(path.join(root, "engine", "b1"), { recursive: true });
    writeFileSync(path.join(root, "engine", "b1", program), "");
    mkdirSync(path.join(root, "models"), { recursive: true });
    assert.equal(canAnswer(env), false, "an engine and no model");
    mkdirSync(path.join(root, "models", picture), { recursive: true });
    writeFileSync(path.join(root, "models", picture, "weights.gguf"), "w");
    writeFileSync(path.join(root, "models", picture, "mmproj-x.gguf"), "p");
    assert.equal(canAnswer(env), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- new copies, when it goes on

test("it is off until it has been shown to work, and the setting decides it for one copy", () => {
  // Turning this on is a decision that follows a run on the graphics card, not a default to drift into.
  assert.equal(oneModelByDefault, false);
  assert.equal(oneModel({} as NodeJS.ProcessEnv), false);
  assert.equal(oneModel(on), true);
  assert.equal(oneModel({ TRHAI_ONE_MODEL: " ON " } as NodeJS.ProcessEnv), true);
  assert.equal(oneModel({ TRHAI_ONE_MODEL: "off" } as NodeJS.ProcessEnv), false);
  assert.equal(oneModel({ TRHAI_ONE_MODEL: "maybe" } as NodeJS.ProcessEnv), oneModelByDefault);
});

test("off, a new copy is recommended the pair, as before", () => {
  const off = { TRHAI_ONE_MODEL: "off" } as NodeJS.ProcessEnv;
  assert.equal(recommendedModel(bigPc, off), coder);
  assert.equal(recommendedVisionModel(bigPc), picture);
  assert.deepEqual(requiredRequest(bigPc, [], off).models, [coder, picture]);
});

test("on, a new copy is recommended one model, the one that suits the PC, named once", () => {
  assert.equal(recommendedModel(bigPc, on), picture);
  assert.equal(recommendedModel(smallPc, on), "qwen3-vl-4b-abliterated");
  assert.deepEqual(requiredRequest(bigPc, [], on).models, [picture]);
  assert.deepEqual(requiredRequest(smallPc, [], on).models, ["qwen3-vl-4b-abliterated"]);
});

test("on, the download is what the owner was told: the models 5.8 GB instead of 10.5 GB on a PC with an 8 GB card", () => {
  const size = (id: string) => modelSize(modelCatalog.find((model) => model.id === id) as (typeof modelCatalog)[number]);
  const pair = size(coder) + size(picture);
  assert.ok(Math.abs(pair / 1e9 - 10.46) < 0.01, `the pair is ${pair / 1e9} GB`);
  assert.ok(Math.abs(size(picture) / 1e9 - 5.78) < 0.01, `the one model is ${size(picture) / 1e9} GB`);

  // And that is what would really be planned. A step for each model, once.
  const empty = mkdtempSync(path.join(tmpdir(), "trhai-one-model-plan-"));
  try {
    const planned = planSetup(requiredRequest(bigPc, [], on), { env: { TRHAI_RUNTIME_DIR: empty } as NodeJS.ProcessEnv, hardware: bigPc, tools: [] });
    assert.equal(planned.ok, true);
    if (planned.ok) {
      assert.deepEqual(planned.plan.steps.filter((step) => step.kind === "model").map((step) => step.id), [picture]);
    }
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("on, a small PC is pointed at the one model it has", () => {
  const suited = hardwareDefaults(smallPc, on);
  assert.equal(suited.TRHAI_MODEL, "qwen3-vl-4b-abliterated");
  assert.equal(suited.TRHAI_VISION_MODEL, "qwen3-vl-4b-abliterated");
});
