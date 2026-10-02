import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { once } from "node:events";

const dataDir = mkdtempSync(path.join(tmpdir(), "trhai-vision-"));
const workspace = mkdtempSync(path.join(tmpdir(), "trhai-vision-ws-"));
process.env.ASCEND_WORKSPACE = workspace;
for (const [name, file] of [["MEMORY", "memory"], ["CONVERSATION", "conversations"], ["ACCOUNTS", "accounts"], ["KNOWLEDGE", "knowledge"], ["TASKS", "tasks"]]) {
  process.env[`ASSIST_${name}_FILE`] = path.join(dataDir, `${file}.json`);
}
process.env.ASCEND_PREFERENCES_FILE = path.join(dataDir, "preferences.json");

const {
  defaultVisionModel, describeQuestion, findVisionModel, imageKind, lookAtImages, maxImagesPerTurn, parseImages,
  visionContextTokens, visionKeepAlive, warmVisionModel
} = await import("../src/services/vision.js");
const { runTool, availableTools } = await import("../src/services/agentTools.js");
const { mentionsAnImage } = await import("../src/services/actionIntent.js");
const { permissionLevelOf } = await import("../src/services/toolPermissions.js");
const { runAssistantOrchestrator } = await import("../src/services/orchestrator.js");
const { createApp } = await import("../src/server.js");

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201ffa5d6a40000000049454e44ae426082", "hex");
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);

/** A stand-in Ollama: /api/tags lists `models`; any other call is recorded, address and body, and answered with `reply`. */
function fakeOllama(models: string[], reply: { status?: number; content?: string } = {}) {
  const chats: Array<Record<string, unknown>> = [];
  const urls: string[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/api/tags")) {
      return new Response(JSON.stringify({ models: models.map((name) => ({ name })) }), { status: 200 });
    }
    urls.push(url);
    chats.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ message: { content: reply.content ?? "A screenshot of a settings page." } }), { status: reply.status ?? 200 });
  }) as unknown as typeof fetch;
  return { chats, urls, fetcher };
}

const config = { baseUrl: "http://ollama", timeoutMs: 1000 };

// ------------------------------------------------------------- reading images

test("an image is known by its bytes, whatever it is called", () => {
  assert.equal(imageKind(png), "png");
  assert.equal(imageKind(jpeg), "jpeg");
  assert.equal(imageKind(Buffer.from("GIF89a....")), "gif");
  assert.equal(imageKind(Buffer.from("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ")), "webp");
  assert.equal(imageKind(Buffer.from("BM......")), "bmp");
  assert.equal(imageKind(Buffer.from("%PDF-1.4")), null);
});

test("images in a chat turn are read from base64 or a data URL, and anything malformed is dropped", () => {
  const b64 = png.toString("base64");
  const parsed = parseImages([
    { name: "shot.png", data: b64 },
    { name: "pasted", data: `data:image/png;base64,${b64}` },
    { name: "broken", data: "not base64 at all!" },
    { data: 42 },
    "nonsense"
  ]);
  assert.deepEqual(parsed.map((image) => image.name), ["shot.png", "pasted"]);
  assert.deepEqual(parsed[1].data, png);
  assert.equal(parseImages(Array.from({ length: 9 }, () => ({ name: "x", data: b64 }))).length, maxImagesPerTurn);
  assert.deepEqual(parseImages(undefined), []);
});

// ------------------------------------------------------------- the vision model

test("the named vision model is used when it is installed, and any vision model otherwise", async () => {
  assert.deepEqual(await findVisionModel("http://ollama", "qwen2.5vl:3b", fakeOllama(["qwen2.5-coder:7b", "qwen2.5vl:3b"]).fetcher),
    { reachable: true, model: "qwen2.5vl:3b" });
  assert.deepEqual(await findVisionModel("http://ollama", "qwen2.5vl:3b", fakeOllama(["llava:7b"]).fetcher),
    { reachable: true, model: "llava:7b" });
  assert.deepEqual(await findVisionModel("http://ollama", "qwen2.5vl:3b", fakeOllama(["qwen2.5-coder:7b"]).fetcher),
    { reachable: true, model: null });
  const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
  assert.deepEqual(await findVisionModel("http://ollama", "qwen2.5vl:3b", down), { reachable: false, model: null });
});

test("the image and the question go to the vision model together", async () => {
  const ollama = fakeOllama([defaultVisionModel]);
  const seen = await lookAtImages([{ name: "shot.png", data: png }], "What setting is switched on?", config, { fetcher: ollama.fetcher });
  assert.deepEqual(seen, { ok: true, text: "A screenshot of a settings page.", model: defaultVisionModel });
  const body = ollama.chats[0] as {
    model: string; keep_alive: string; options: { num_ctx: number }; messages: Array<{ role: string; content: string; images?: string[] }>
  };
  assert.equal(body.model, defaultVisionModel);
  assert.ok(visionContextTokens >= 8192, "room for a large screenshot");
  assert.equal(body.options.num_ctx, visionContextTokens);
  assert.equal(body.keep_alive, visionKeepAlive, "stays loaded for the next image");
  assert.match(body.messages[0].content, /Read any text in an image exactly as written/);
  assert.equal(body.messages[1].content, "What setting is switched on?");
  assert.deepEqual(body.messages[1].images, [png.toString("base64")]);

  await lookAtImages([{ name: "shot.png", data: png }], "  ", config, { fetcher: ollama.fetcher });
  assert.equal((ollama.chats[1] as { messages: Array<{ content: string }> }).messages[1].content, describeQuestion, "no question means describe it");
});

test("what stops it from looking is said plainly", async () => {
  const none = await lookAtImages([{ name: "a.png", data: png }], "hi", config, { fetcher: fakeOllama(["qwen2.5-coder:7b"]).fetcher });
  assert.equal(none.ok, false);
  if (!none.ok) assert.match(none.reason, /needs a vision model.*ollama pull qwen2\.5vl:3b/);

  const down = await lookAtImages([{ name: "a.png", data: png }], "hi", config, { fetcher: (async () => { throw new TypeError("x"); }) as unknown as typeof fetch });
  assert.equal(down.ok, false);
  if (!down.ok) assert.match(down.reason, /not answering/);

  const refused = await lookAtImages([{ name: "a.png", data: png }], "hi", config, { fetcher: fakeOllama([defaultVisionModel], { status: 500 }).fetcher });
  assert.equal(refused.ok, false);

  const notAnImage = await lookAtImages([{ name: "notes.txt", data: Buffer.from("hello") }], "hi", config, { fetcher: fakeOllama([defaultVisionModel]).fetcher });
  assert.equal(notAnImage.ok, false);
  if (!notAnImage.ok) assert.match(notAnImage.reason, /not an image/);

  const tooMany = await lookAtImages(Array.from({ length: maxImagesPerTurn + 1 }, () => ({ name: "a.png", data: png })), "hi", config, { fetcher: fakeOllama([defaultVisionModel]).fetcher });
  assert.equal(tooMany.ok, false);
});

test("the vision model can be loaded before the question arrives, answering nothing", async () => {
  const ollama = fakeOllama([defaultVisionModel]);
  assert.equal(await warmVisionModel(config, { fetcher: ollama.fetcher }), true);
  assert.deepEqual(ollama.urls, ["http://ollama/api/generate"]);
  const body = ollama.chats[0] as { model: string; prompt?: string; keep_alive: string; options: { num_ctx: number } };
  assert.equal(body.model, defaultVisionModel);
  assert.equal(body.prompt, undefined, "no prompt: Ollama loads the model and generates nothing");
  assert.equal(body.keep_alive, visionKeepAlive);
  // Ollama reloads a model asked for with a different window, which would
  // throw the warm-up away and pay for the load twice.
  assert.equal(body.options.num_ctx, visionContextTokens, "the same window the question will ask for");

  assert.equal(await warmVisionModel(config, { fetcher: fakeOllama(["qwen2.5-coder:7b"]).fetcher }), false, "no vision model to load");
  const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
  assert.equal(await warmVisionModel(config, { fetcher: down }), false, "Ollama not answering");
});

// ------------------------------------------------------------- the tool

const recordingVision = () => {
  const calls: Array<{ names: string[]; question: string }> = [];
  return {
    calls,
    vision: async (images: Array<{ name: string; data: Buffer }>, question: string) => {
      calls.push({ names: images.map((image) => image.name), question });
      return { ok: true as const, text: "A cat on a keyboard.", model: "qwen2.5vl:3b" };
    }
  };
};

test("look_at_image shows a file to the vision model and passes its answer on", async () => {
  writeFileSync(path.join(workspace, "cat.png"), png);
  const vision = recordingVision();
  const result = await runTool({ name: "look_at_image", arguments: { path: "cat.png", question: "what animal is this?" } },
    { memories: [], knowledge: [], vision: vision.vision });
  assert.equal(result.ok, true);
  assert.match(result.content, /What cat\.png shows \(from the vision model, qwen2\.5vl:3b\):\nA cat on a keyboard\./);
  assert.deepEqual(vision.calls, [{ names: ["cat.png"], question: "what animal is this?" }]);

  writeFileSync(path.join(workspace, "notes.txt"), "just text");
  const notImage = await runTool({ name: "look_at_image", arguments: { path: "notes.txt" } }, { memories: [], knowledge: [], vision: vision.vision });
  assert.equal(notImage.ok, false);
  assert.match(notImage.content, /not an image/);

  const asText = await runTool({ name: "read_file", arguments: { path: "cat.png" } }, { memories: [], knowledge: [] });
  assert.equal(asText.ok, false);
  assert.match(asText.content, /is an image, not text\. Use look_at_image/);
});

test("look_at_image is offered for a request about an image, and only reads", () => {
  for (const asked of ["what's in screenshot.png", "describe this photo", "read the text in scan.jpg", "look at the picture on my desktop"]) {
    assert.equal(mentionsAnImage(asked), true, asked);
  }
  for (const asked of ["read notes.txt", "what's the weather", "summarize the report"]) {
    assert.equal(mentionsAnImage(asked), false, asked);
  }
  assert.ok(availableTools(false, { images: true }).some((tool) => tool.function.name === "look_at_image"));
  assert.ok(!availableTools(false, { images: false }).some((tool) => tool.function.name === "look_at_image"));
  assert.equal(permissionLevelOf("look_at_image"), 1);
});

// ------------------------------------------------------------- a message with images

test("a message with images is answered by the vision model, not by a model that cannot see", async () => {
  const vision = recordingVision();
  const answered = await runAssistantOrchestrator({
    mode: "general", sessionId: "vision-1", userMessage: "what is in this picture?",
    images: [{ name: "pasted.png", data: png }], vision: vision.vision
  });
  assert.equal(answered.assistantMessage, "A cat on a keyboard.");
  assert.equal(answered.strategy, "vision");
  assert.equal(answered.model, "ollama/qwen2.5vl:3b");
  assert.deepEqual(vision.calls, [{ names: ["pasted.png"], question: "what is in this picture?" }]);

  const blind = await runAssistantOrchestrator({
    mode: "general", sessionId: "vision-2", userMessage: "what is in this picture?",
    images: [{ name: "pasted.png", data: png }],
    vision: async () => ({ ok: false as const, reason: "Seeing images needs a vision model, and none is installed in Ollama." })
  });
  assert.match(blind.assistantMessage, /needs a vision model/, "said, not guessed");
});

test("the chat route takes a message with an image larger than other routes allow", async () => {
  const previous = process.env.OLLAMA_BASE_URL;
  // A dead port: the route must answer honestly without a model, not hang or 413.
  process.env.OLLAMA_BASE_URL = "http://127.0.0.1:9";
  const app = createApp();
  const server = app.listen(0);
  await once(server, "listening");
  try {
    const big = Buffer.concat([jpeg, Buffer.alloc(1_500_000, 7)]);
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/assist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "what is this?", sessionId: "vision-route", images: [{ name: "big.jpg", data: big.toString("base64") }] })
    });
    assert.equal(response.status, 200, "a 2 MB body is accepted on the chat route");
    const payload = await response.json() as { data: { assistantMessage: string } };
    assert.match(payload.data.assistantMessage, /not answering|needs a vision model/);

    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/vision/warm`;
    const warmed = await fetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(warmed.status, 200);
    assert.deepEqual((await warmed.json() as { data: unknown }).data, { loaded: false }, "nothing loaded, and said so");
    // The kind of request a page on another site can send without the
    // browser checking CORS first.
    const plain = await fetch(base, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" });
    assert.equal(plain.status, 415);
  } finally {
    if (previous === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = previous;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
