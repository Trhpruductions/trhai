import test from "node:test";
import assert from "node:assert/strict";
import { openDepth, readStream, safePrefix, toLines } from "../src/services/streamReader.js";
import { completionBody, modelsBody, streamEvent } from "./helpers/fakeEngine.js";

// Streaming is easy; streaming without showing the user things they should
// never see is the actual problem. This model encodes some tool calls as
// text, anywhere in a message, so these tests care most about what does NOT
// reach the screen — and equally that ordinary prose is not held up by the
// machinery that protects against it.

async function* fromLines(lines: string[]): AsyncGenerator<string> {
  for (const line of lines) yield line;
}

/** One event of the engine's stream, as a line: a piece of the reply, or with `finish` its last frame. */
function frame(content: string, finish: string | null = null): string {
  return `data: ${JSON.stringify({ model: "test", choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finish }] })}`;
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
    // As the engine sends it: blank lines between events, and [DONE] at the end.
    fromLines([frame("Hello"), "", frame(", "), "", frame("world"), "", frame("", "stop"), "", "data: [DONE]"]),
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

test("why the stream ended is kept, and a reply cut off at the limit keeps back what it held", async () => {
  // The test above, cut off by the reply limit instead of ending: what is
  // held is a tool call that never closed - a file, half written, as raw JSON.
  const seen: string[] = [];
  const cut = await readStream(fromLines([
    frame("Writing it now: "),
    frame('{"name": "write_file", "arguments": {"content": "line one'),
    frame("", "length")
  ]), (text) => seen.push(text));

  assert.equal(cut.doneReason, "length");
  assert.equal(seen.join(""), "Writing it now: ");
  assert.match(cut.content, /line one/, "the caller still gets all of it, to decide what to do with");

  const finished = await readStream(fromLines([frame("All done."), frame("", "stop")]));
  assert.equal(finished.doneReason, "stop");
  assert.equal(finished.content, "All done.");
});

test("a tool call sent through the interface is put together from its pieces", async () => {
  // The engine sends a call's name first, then its arguments a few characters
  // at a time, each piece saying which call it belongs to.
  const piece = (delta: Record<string, unknown>, finish: string | null = null) =>
    `data: ${JSON.stringify({ model: "test", choices: [{ index: 0, delta, finish_reason: finish }] })}`;
  const result = await readStream(fromLines([
    piece({ role: "assistant", content: null }),
    piece({ tool_calls: [{ index: 0, id: "abc", type: "function", function: { name: "calculate", arguments: "" } }] }),
    piece({ tool_calls: [{ index: 0, function: { arguments: '{"expression": ' } }] }),
    piece({ tool_calls: [{ index: 0, function: { arguments: '"1234 * 5678"}' } }] }),
    piece({ tool_calls: [{ index: 1, id: "def", type: "function", function: { name: "current_datetime", arguments: "{}" } }] }),
    piece({}, "tool_calls"),
    "data: [DONE]"
  ]));

  assert.deepEqual(result.toolCalls, [
    { function: { name: "calculate", arguments: '{"expression": "1234 * 5678"}' } },
    { function: { name: "current_datetime", arguments: "{}" } }
  ]);
  assert.equal(result.doneReason, "tool_calls");
  assert.equal(result.content, "");
  assert.equal(result.model, "test");

  // A reply with no call in it carries none, rather than an empty list.
  assert.equal((await readStream(fromLines([frame("Just words."), frame("", "stop")]))).toolCalls, undefined);
});

test("a thinking model's thoughts are not the reply, and never reach the screen", async () => {
  const seen: string[] = [];
  const thought = (text: string) =>
    `data: ${JSON.stringify({ model: "test", choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }] })}`;
  const result = await readStream(
    fromLines([thought("The user wants a sum. 17 + 25 is"), thought(" 42."), frame("42"), frame("", "stop")]),
    (text) => seen.push(text)
  );
  assert.equal(seen.join(""), "42");
  assert.equal(result.content, "42");
});

test("when the thoughts start, and when the reply begins after them, are each said once", async () => {
  const thought = (text: string) =>
    `data: ${JSON.stringify({ model: "test", choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }] })}`;
  const piece = (delta: Record<string, unknown>, finish: string | null = null) =>
    `data: ${JSON.stringify({ model: "test", choices: [{ index: 0, delta, finish_reason: finish }] })}`;
  const said = async (lines: string[]) => {
    const heard: boolean[] = [];
    await readStream(fromLines(lines), undefined, undefined, (thinking) => heard.push(thinking));
    return heard;
  };

  // Thinking, then words: said to have started, and to have given way to the reply.
  assert.deepEqual(await said([
    thought("The user wants a sum."), thought(" 17 + 25"), thought(" is 42."), frame("42"), frame(" exactly"), frame("", "stop")
  ]), [true, false]);

  // A reply with no thoughts says nothing at all: "has not answered yet" is not "is thinking".
  assert.deepEqual(await said([frame("Hello"), frame(" there"), frame("", "stop")]), []);
  // Nor does an empty thought, which some models send before a plain reply.
  assert.deepEqual(await said([thought(""), frame("Hello"), frame("", "stop")]), []);

  // Thinking that ends in a tool call rather than in words.
  assert.deepEqual(await said([
    thought("I should look that up."),
    piece({ tool_calls: [{ index: 0, id: "a", type: "function", function: { name: "search_memory", arguments: "{}" } }] }),
    piece({}, "tool_calls")
  ]), [true, false]);

  // Cut off while still thinking: the reply is never said to have begun.
  assert.deepEqual(await said([thought("Let me think"), thought(" some more")]), [true]);
});

test("an error the engine sends part way is a failed request, not a short reply", async () => {
  const failed = `data: ${JSON.stringify({ error: { code: 500, message: "the request exceeds the available context size", type: "exceed_context_size_error" } })}`;
  await assert.rejects(
    readStream(fromLines([frame("It began"), failed])),
    /exceeds the available context size/
  );
});

test("a malformed line is skipped rather than losing the reply", async () => {
  // One unreadable frame is not a reason to drop everything still arriving.
  const result = await readStream(fromLines([frame("good "), "data: {not json", ": a comment line", frame("parts")]));
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

  // One fake model, two shapes: an event stream when stream is true, a single
  // object when it is false. Whatever the loop asks for, it gets.
  const fakeFetch = (async (url: string, init?: { body?: string }) => {
    if (String(url).endsWith("/models")) return new Response(JSON.stringify(modelsBody(["fake"])));
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (!body.stream) {
      return new Response(JSON.stringify(completionBody("fake", { message: { content: reply } })));
    }
    const events = reply.split(" ").map((word, index) => streamEvent("fake", { content: index === 0 ? word : ` ${word}` }));
    return new Response([...events, streamEvent("fake", {}, "stop"), "data: [DONE]\n\n"].join(""));
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

  const fakeFetch = (async (url: string, init?: { body?: string }) => {
    if (String(url).endsWith("/models")) return new Response(JSON.stringify(modelsBody(["fake"])));
    askedForStream = JSON.parse(String(init?.body ?? "{}")).stream;
    return new Response(JSON.stringify(completionBody("fake", { message: { content: "hi" } })));
  }) as unknown as typeof fetch;

  await runAgent({ baseUrl: "http://fake", model: "fake", timeoutMs: 5000 } as never,
    "anything", { memories: [], knowledge: [] }, fakeFetch);

  // Existing callers must keep the exact request they had before.
  assert.equal(askedForStream, false);
});
