import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { once } from "node:events";

const dataDir = mkdtempSync(path.join(tmpdir(), "trhai-vision-"));
const workspace = mkdtempSync(path.join(tmpdir(), "trhai-vision-ws-"));
process.env.ASCEND_WORKSPACE = workspace;
for (const [name, file] of [["MEMORY", "memory"], ["CONVERSATION", "conversations"], ["ACCOUNTS", "accounts"], ["KNOWLEDGE", "knowledge"], ["TASKS", "tasks"]]) {
  process.env[`ASSIST_${name}_FILE`] = path.join(dataDir, `${file}.json`);
}
process.env.ASCEND_PREFERENCES_FILE = path.join(dataDir, "preferences.json");

const {
  defaultVisionModel, describeQuestion, findVisionModel, imageKind, imageSize, imageTokens, lookAtImages, maxImagesPerTurn,
  parseImages, visionKeepAlive, visionWindowFor, warmVisionModel
} = await import("../src/services/vision.js");
const { runTool, availableTools } = await import("../src/services/agentTools.js");
const { mentionsAnImage } = await import("../src/services/actionIntent.js");
const { permissionLevelOf } = await import("../src/services/toolPermissions.js");
const { runAssistantOrchestrator, screenNotShared } = await import("../src/services/orchestrator.js");
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

// Headers only: the size is all imageSize reads, and these carry just enough
// of each format to say it.
const pngOf = (width: number, height: number) => {
  const bytes = Buffer.from(png);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
};
const jpegOf = (width: number, height: number) => Buffer.from([
  0xff, 0xd8,
  // An APP0 segment first, as in nearly every real JPEG: the size is further in.
  0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00
]);
const webpOf = (chunk: "VP8X" | "VP8 " | "VP8L", width: number, height: number) => {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0);
  bytes.write("WEBP", 8);
  bytes.write(chunk, 12);
  if (chunk === "VP8X") {
    bytes.writeUIntLE(width - 1, 24, 3);
    bytes.writeUIntLE(height - 1, 27, 3);
  } else if (chunk === "VP8 ") {
    bytes.writeUInt16LE(width, 26);
    bytes.writeUInt16LE(height, 28);
  } else {
    bytes[20] = 0x2f;
    bytes.writeUInt32LE(((height - 1) << 14) | (width - 1), 21);
  }
  return bytes;
};

test("an image's size is read from its header, in every format it can arrive in", () => {
  assert.deepEqual(imageSize(pngOf(1920, 1080)), { width: 1920, height: 1080 });
  assert.deepEqual(imageSize(jpegOf(4032, 3024)), { width: 4032, height: 3024 }, "a phone photo");
  const gif = Buffer.from("GIF89a\u0000\u0000\u0000\u0000", "latin1");
  gif.writeUInt16LE(640, 6);
  gif.writeUInt16LE(480, 8);
  assert.deepEqual(imageSize(gif), { width: 640, height: 480 });
  const bmp = Buffer.alloc(26);
  bmp.write("BM", 0);
  bmp.writeInt32LE(800, 18);
  bmp.writeInt32LE(-600, 22);
  assert.deepEqual(imageSize(bmp), { width: 800, height: 600 }, "a top-down BMP stores its height negative");
  assert.deepEqual(imageSize(webpOf("VP8X", 2560, 1440)), { width: 2560, height: 1440 });
  assert.deepEqual(imageSize(webpOf("VP8 ", 1280, 720)), { width: 1280, height: 720 });
  assert.deepEqual(imageSize(webpOf("VP8L", 300, 200)), { width: 300, height: 200 });
  assert.equal(imageSize(jpeg), null, "a JPEG cut off before its frame header");
  assert.equal(imageSize(Buffer.from("%PDF-1.4")), null);
});

test("the window grows with the images, so several screenshots still leave room to answer", () => {
  // The token counts measured with qwen2.5vl, within a few percent.
  assert.equal(imageTokens({ width: 1280, height: 720 }), 1196);
  assert.equal(imageTokens({ width: 1920, height: 1080 }), 2691);
  assert.equal(imageTokens({ width: 3840, height: 2160 }), 4096, "the model shrinks anything larger");
  assert.equal(imageTokens(null), 4096, "a size that cannot be read counts as the most");

  const shot = { name: "shot.png", data: pngOf(1920, 1080) };
  assert.equal(visionWindowFor([]), 8192);
  assert.equal(visionWindowFor([shot]), 8192);
  assert.equal(visionWindowFor([{ name: "4k.png", data: pngOf(3840, 2160) }]), 8192, "any one image fits 8K");
  assert.equal(visionWindowFor([shot, shot]), 8192);
  assert.equal(visionWindowFor([shot, shot, shot]), 16384, "measured: three filled 8K to its last 81 tokens");
  assert.equal(visionWindowFor([shot, shot, shot, shot]), 16384, "measured: four were refused at 8K");
  const unreadable = { name: "odd.jpg", data: jpeg };
  assert.equal(visionWindowFor([unreadable, unreadable, unreadable, unreadable]), 32768, "the most images at the most each still fit");
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
  assert.equal(body.options.num_ctx, 8192, "one image fits the smallest window");
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

  // The body Ollama really sent when four screenshots overflowed an 8K window:
  // the runner's error, as a JSON string inside Ollama's own JSON.
  const overflow = JSON.stringify({ error: JSON.stringify({ error: {
    code: 400, message: "request (10804 tokens) exceeds the available context size (8192 tokens), try increasing it",
    type: "exceed_context_size_error", n_prompt_tokens: 10804, n_ctx: 8192
  } }) });
  const tooBig = await lookAtImages([{ name: "a.png", data: png }], "hi", config, {
    fetcher: (async (url: string) => url.endsWith("/api/tags")
      ? new Response(JSON.stringify({ models: [{ name: defaultVisionModel }] }), { status: 200 })
      : new Response(overflow, { status: 400 })) as unknown as typeof fetch
  });
  assert.equal(tooBig.ok, false);
  if (!tooBig.ok) {
    assert.match(tooBig.reason, /too large together.*fewer of them, or smaller ones/);
    assert.doesNotMatch(tooBig.reason, /[{}]/, "plain words, not the JSON it came in");
  }

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
  assert.equal(body.options.num_ctx, visionWindowFor([{ name: "shot.png", data: png }]), "the window a one-image question asks for");

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

test("a question about the screen with no picture of it says how to share it, and guesses nothing", async () => {
  const vision = recordingVision();
  const unseen = await runAssistantOrchestrator({
    mode: "general", sessionId: "screen-1", userMessage: "what's on my screen?", vision: vision.vision
  });
  assert.equal(unseen.assistantMessage, screenNotShared);
  assert.deepEqual(vision.calls, [], "nothing was looked at, because nothing was there to look at");

  const shown = await runAssistantOrchestrator({
    mode: "general", sessionId: "screen-2", userMessage: "what's on my screen?",
    images: [{ name: "screen.jpg", data: png }], vision: vision.vision
  });
  assert.equal(shown.assistantMessage, "A cat on a keyboard.");
  assert.deepEqual(vision.calls, [{ names: ["screen.jpg"], question: "what's on my screen?" }]);
});

/** A stand-in Ollama that answers each chat request with the next scripted reply. */
async function withScriptedModel<T>(replies: Array<Record<string, unknown>>, run: (chats: Array<Record<string, unknown>>) => Promise<T>): Promise<T> {
  const chats: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk as Buffer));
    request.on("end", () => {
      response.writeHead(200, { "Content-Type": "application/json" });
      if (request.url?.startsWith("/api/tags")) {
        response.end(JSON.stringify({ models: [{ name: "llama3.2:latest" }] }));
        return;
      }
      if (request.url?.startsWith("/api/chat")) {
        chats.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        response.end(JSON.stringify({ model: "llama3.2:latest", ...replies[Math.min(chats.length - 1, replies.length - 1)] }));
        return;
      }
      response.end(JSON.stringify({ model: "llama3.2:latest", response: "ok" }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const previous = process.env.OLLAMA_BASE_URL;
  process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    return await run(chats);
  } finally {
    if (previous === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = previous;
    server.close();
  }
}

test("look_at_image called by the model uses the same vision model as the images route", async () => {
  // Without this the loop's look_at_image ignored a stand-in and went to the
  // real Ollama - here, the scripted one, which would have answered as if it
  // had looked.
  writeFileSync(path.join(workspace, "cat.png"), png);
  const vision = recordingVision();
  const lookCall = { message: { content: "", tool_calls: [{ function: { name: "look_at_image", arguments: { path: "cat.png" } } }] } };
  await withScriptedModel([lookCall, { message: { content: "It shows a cat on a keyboard." } }], async () => {
    const answered = await runAssistantOrchestrator({
      mode: "general", sessionId: "vision-loop", userMessage: "what's in cat.png?", vision: vision.vision
    });
    assert.deepEqual(vision.calls, [{ names: ["cat.png"], question: "" }], "the stand-in looked, not the scripted model");
    assert.match(answered.assistantMessage, /cat on a keyboard/);
  });
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
