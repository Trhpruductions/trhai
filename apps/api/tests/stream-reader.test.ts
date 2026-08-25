import test from "node:test";
import assert from "node:assert/strict";
import { openDepth, readStream, safePrefix, toLines } from "../src/services/streamReader.js";

// Streaming is easy; streaming without showing the user things they should
// never see is the actual problem. This model encodes some tool calls as
// text, anywhere in a message, so these tests care most about what does NOT
// reach the screen — and equally that ordinary prose is not held up by the
// machinery that protects against it.

async function* fromLines(lines: string[]): AsyncGenerator<string> {
  for (const line of lines) yield line;
}

function frame(content: string, done = false): string {
  return JSON.stringify({ model: "test", message: { role: "assistant", content }, done });
}

test("brace depth ignores braces inside strings", () => {
  // A reply saying 'use {} for an empty object' has not opened anything.
  assert.equal(openDepth('say "{" to me'), 0);
  assert.equal(openDepth('a "}" here'), 0);
  assert.equal(openDepth("{"), 1);
  assert.equal(openDepth("{}"), 0);
  assert.equal(openDepth('{"a": "{"}'), 0, "an escaped-looking brace inside a value");
});

test("an escaped quote does not flip the string state", () => {
  assert.equal(openDepth('{"a": "he said \\"hi\\""}'), 0);
});

test("plain prose streams with no delay at all", () => {
  // The ordinary case must not pay for the protection.
  assert.equal(safePrefix("Hello, how are you?"), "Hello, how are you?");
});

test("text is held from the point an object opens", () => {
  assert.equal(safePrefix('Sure, here you go: {"name":'), "Sure, here you go: ");
});

test("once the object closes, everything is released again", () => {
  const full = 'Sure: {"name": "x"} and then more.';
  assert.equal(safePrefix(full), full);
});

test("tokens arrive in order and are never repeated", async () => {
  const seen: string[] = [];
  const result = await readStream(
    fromLines([frame("Hello"), frame(", "), frame("world"), frame("", true)]),
    (text) => seen.push(text)
  );

  assert.equal(seen.join(""), "Hello, world");
  assert.equal(result.content, "Hello, world");
  // Each callback carries only what is new, so a caller can append blindly.
  assert.deepEqual(seen, ["Hello", ", ", "world"]);
});

test("a text-encoded tool call is never shown to the user", async () => {
  // The failure this exists to prevent: JSON printed a character at a time
  // before anything recognised it as a call.
  const seen: string[] = [];
  const call = '{"name": "write_file", "arguments": {"path": "a.txt"}}';
  const result = await readStream(
    fromLines(call.split("").map((character) => frame(character))),
    (text) => seen.push(text),
    (text) => text.includes("write_file")
  );

  assert.equal(seen.join(""), "", "nothing reached the screen");
  // But the caller still gets it, so the loop can run the call.
  assert.equal(result.content, call);
});

test("a call written after a sentence does not leak its opening prose... or its JSON", async () => {
  // Caught live in agentLoop: "Sure, I'll write that:" followed by a real
  // call. The prose is fine to show; the JSON is not.
  const seen: string[] = [];
  const message = 'Sure: {"name": "write_file", "arguments": {}}';
  await readStream(
    fromLines(message.split("").map((character) => frame(character))),
    (text) => seen.push(text),
    (text) => text.includes("write_file")
  );

  const shown = seen.join("");
  assert.ok(!shown.includes("write_file"), `leaked a tool name: ${shown}`);
  assert.ok(!shown.includes("{"), `leaked JSON: ${shown}`);
});

test("json the model wrote as part of a real answer is still shown", async () => {
  // The guard must not swallow legitimate content. Asked to show a config,
  // the braces are the answer.
  const seen: string[] = [];
  const message = 'Here is the config: {"port": 4000} — copy that in.';
  const result = await readStream(
    fromLines(message.split("").map((character) => frame(character))),
    (text) => seen.push(text)
  );

  assert.equal(seen.join(""), message);
  assert.equal(result.content, message);
});

test("text held back at the end is released rather than lost", async () => {
  // A reply that genuinely ends mid-object must not be truncated on screen.
  const seen: string[] = [];
  await readStream(fromLines([frame('almost {"a": 1')]), (text) => seen.push(text));

  assert.equal(seen.join(""), 'almost {"a": 1');
});

test("tool calls sent through the interface are carried out", async () => {
  const withCall = JSON.stringify({
    model: "test",
    message: { role: "assistant", content: "", tool_calls: [{ function: { name: "current_datetime" } }] },
    done: true
  });

  const result = await readStream(fromLines([withCall]));
  assert.ok(Array.isArray(result.toolCalls));
  assert.equal(result.model, "test");
});

test("a malformed line is skipped rather than losing the reply", async () => {
  // One unreadable frame is not a reason to drop everything still arriving.
  const result = await readStream(fromLines([frame("good "), "{not json", frame("parts")]));
  assert.equal(result.content, "good parts");
});

test("an empty stream produces empty content, not an error", async () => {
  const result = await readStream(fromLines([]));
  assert.equal(result.content, "");
  assert.equal(result.model, null);
});

test("lines are split across chunk boundaries correctly", async () => {
  async function* bytes(): AsyncGenerator<Uint8Array> {
    const encoder = new TextEncoder();
    yield encoder.encode('{"a":1}\n{"b"');
    yield encoder.encode(':2}\n');
  }

  const lines: string[] = [];
  for await (const line of toLines(bytes())) lines.push(line);
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
});

test("a multi-byte character split across chunks is not corrupted", async () => {
  const encoded = new TextEncoder().encode('{"t":"日本語"}\n');
  async function* bytes(): AsyncGenerator<Uint8Array> {
    // Split in the middle of a three-byte character.
    yield encoded.slice(0, 9);
    yield encoded.slice(9);
  }

  const lines: string[] = [];
  for await (const line of toLines(bytes())) lines.push(line);
  assert.equal(lines.join(""), '{"t":"日本語"}');
});

test("a trailing line with no newline is still yielded", async () => {
  async function* bytes(): AsyncGenerator<Uint8Array> {
    yield new TextEncoder().encode('{"a":1}');
  }

  const lines: string[] = [];
  for await (const line of toLines(bytes())) lines.push(line);
  assert.deepEqual(lines, ['{"a":1}']);
});

// The loop itself, streamed. The point of these is that turning streaming on
// changes when you see the answer, never what the answer is.

test("a streamed turn produces the same result as an unstreamed one", async () => {
  const { runAgent } = await import("../src/services/agentLoop.js");
  const reply = "The answer is forty-two.";

  // One fake model, two shapes: NDJSON frames when stream is true, a single
  // object when it is false. Whatever the loop asks for, it gets.
  const fakeFetch = (async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (!body.stream) {
      return new Response(JSON.stringify({ model: "fake", message: { role: "assistant", content: reply } }));
    }
    const frames = reply.split(" ").map((word, index) => JSON.stringify({
      model: "fake",
      message: { role: "assistant", content: index === 0 ? word : ` ${word}` },
      done: false
    })).join("\n") + "\n";
    return new Response(frames);
  }) as unknown as typeof fetch;

  const config = { baseUrl: "http://fake", model: "fake", timeoutMs: 5000 } as never;
  const context = { memories: [], knowledge: [] };

  const plain = await runAgent(config, "anything", context, fakeFetch);
  const tokens: string[] = [];
  const streamed = await runAgent(config, "anything", context, fakeFetch, undefined, (t) => tokens.push(t));

  assert.equal(plain.ok, true);
  assert.equal(streamed.ok, true);
  assert.equal(
    streamed.ok === true && streamed.text,
    plain.ok === true && plain.text,
    "streaming must not change the answer"
  );
  assert.equal(tokens.join(""), reply, "and the tokens must add up to it");
});

test("without a token callback the request is not streamed at all", async () => {
  const { runAgent } = await import("../src/services/agentLoop.js");
  let askedForStream: unknown = "never called";

  const fakeFetch = (async (_url: string, init?: { body?: string }) => {
    askedForStream = JSON.parse(String(init?.body ?? "{}")).stream;
    return new Response(JSON.stringify({ model: "fake", message: { role: "assistant", content: "hi" } }));
  }) as unknown as typeof fetch;

  await runAgent({ baseUrl: "http://fake", model: "fake", timeoutMs: 5000 } as never,
    "anything", { memories: [], knowledge: [] }, fakeFetch);

  // Existing callers must keep the exact request they had before.
  assert.equal(askedForStream, false);
});
