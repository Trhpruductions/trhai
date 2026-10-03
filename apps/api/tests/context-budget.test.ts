import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fakeEngine, type ScriptedReply } from "./helpers/fakeEngine.js";

// A workspace of its own, so the reads and writes below never touch a real one.
const testWorkspace = mkdtempSync(path.join(tmpdir(), "trhai-budget-"));
process.env.ASCEND_WORKSPACE = testWorkspace;

const {
  elisionIn, estimateTokens, fileView, fitPromptToWindow, fitToolResult, fitsOneRead, maxToolResultTokens,
  promptBudgetTokens, replyReserveTokens, requestTokens, shorten
} = await import("../src/services/contextBudget.js");
const { replacesMostOf } = await import("../src/services/fileEdit.js");
const { runTool } = await import("../src/services/agentTools.js");
const { runAgent } = await import("../src/services/agentLoop.js");

/** A numbered file, every line distinct, so a test can say exactly which lines it saw. */
function numberedLines(count: number, words = "keeps a little of the file's own text on it"): string {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}: ${words}`).join("\n") + "\n";
}

/** Deterministic bytes, so the dense-text checks do not depend on chance. */
function seededBytes(length: number): Buffer {
  let state = 0x2545f491;
  const bytes = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    bytes[index] = state & 0xff;
  }
  return bytes;
}

// ------------------------------------------------------------- the estimate

// The counts below were taken from qwen2.5-coder:7b's own tokenizer
// (prompt_eval_count) on 2026-10-01. The estimate has to land near them for
// ordinary text and never far under for dense text: an under-count is what
// lets a prompt past the window.
test("the token estimate tracks the model's own count for ordinary text", () => {
  const prose = "The quick brown fox jumps over the lazy dog while the committee deliberates on the budget. ".repeat(100);
  const json = JSON.stringify(Array.from({ length: 150 }, (_, i) => ({ id: i, name: `item-${i}`, price: i * 1.25, tags: ["a", "b"] })));
  for (const [name, text, measured] of [["prose", prose, 1800], ["json", json, 4042]] as const) {
    const ratio = estimateTokens(text) / measured;
    assert.ok(ratio >= 0.95 && ratio <= 1.3, `${name}: estimated ${estimateTokens(text)} for ${measured} measured`);
  }
});

test("dense text is counted as dense: digits one each, hex and base64 near one a character", () => {
  assert.equal(estimateTokens("1234567890"), 10, "the tokenizer splits every digit");
  const hex = seededBytes(4000).toString("hex");
  const base64 = seededBytes(6000).toString("base64");
  // Measured: hex 1.14 characters a token, base64 1.34.
  assert.ok(hex.length / estimateTokens(hex) <= 1.25, `hex at ${(hex.length / estimateTokens(hex)).toFixed(2)} chars a token`);
  assert.ok(base64.length / estimateTokens(base64) <= 1.5, `base64 at ${(base64.length / estimateTokens(base64)).toFixed(2)} chars a token`);
  // And text outside ASCII is never counted at less than a token a character.
  assert.ok(estimateTokens("这是一个测试句子") >= 8);
});

test("the budget is the window less what the reply needs", () => {
  assert.equal(promptBudgetTokens(16384), 16384 - replyReserveTokens);
  assert.ok(promptBudgetTokens(100) >= 1000, "never a budget too small to hold the rules");
});

// ------------------------------------------------------------- shortening

test("a shortened text keeps its start and its end, and says which lines went", () => {
  const text = numberedLines(2000);
  const short = shorten(text, 3000, "Ask for the lines you need");

  assert.ok(short.length <= 3000, `${short.length} characters for a 3,000 limit`);
  assert.ok(short.startsWith("line 1: "), "the start is kept");
  assert.ok(short.trimEnd().endsWith("line 2000: keeps a little of the file's own text on it"), "and the end");
  const note = /\(lines ([\d,]+)-([\d,]+) of 2,000\)/.exec(short);
  assert.ok(note, "the note names the lines left out");
  const [first, last] = [Number(note[1].replace(/,/g, "")), Number(note[2].replace(/,/g, ""))];
  // Exactly the lines that are not on show: the one before the first is the
  // last line of the head, the one after the last is the first of the tail.
  assert.ok(short.includes(`line ${first - 1}: `) && !short.includes(`line ${first}: `));
  assert.ok(short.includes(`line ${last + 1}: `) && !short.includes(`line ${last}: `));
  assert.match(short, /Ask for the lines you need/);
});

test("a text that fits is returned as it is", () => {
  assert.equal(shorten("short", 100, "hint"), "short");
  assert.equal(fitToolResult("run_command", "all of it"), "all of it");
});

test("line numbers in the note are the file's own when the text starts part-way in", () => {
  const part = numberedLines(1000).split("\n").slice(499, 999).join("\n");
  const short = shorten(part, 2000, "hint", 500);
  const note = /\(lines ([\d,]+)-([\d,]+) of ([\d,]+)\)/.exec(short);
  assert.ok(note);
  assert.equal(note[3], "999", "counted to the last line shown, in file numbers");
  assert.ok(Number(note[1].replace(/,/g, "")) > 500);
});

test("a long command output is cut to one result's share, keeping the error at the end", () => {
  const output = Array.from({ length: 3000 }, (_, i) => `  compiling module ${i} of 3000 ... ok`).join("\n")
    + "\nerror TS2304: Cannot find name 'widget'.";
  const fitted = fitToolResult("run_command", output);
  assert.ok(estimateTokens(fitted) <= maxToolResultTokens, `${estimateTokens(fitted)} tokens`);
  assert.match(fitted, /Cannot find name 'widget'/, "the end of a log is where the error is");
  assert.match(fitted, /Run a narrower command/);
});

// ------------------------------------------------------------- read_file

test("a file that fits is shown whole and unchanged", () => {
  const text = numberedLines(20);
  assert.deepEqual(fileView(text, {}, true), { ok: true, content: text });
});

test("a long file shows its start and end, and the lines left out can be read by number", () => {
  const text = numberedLines(3000);
  const view = fileView(text, {}, true);
  assert.equal(view.ok, true);
  assert.ok(estimateTokens(view.content) <= maxToolResultTokens);
  const note = /\(lines ([\d,]+)-([\d,]+) of 3,000\)/.exec(view.content);
  assert.ok(note, view.content.slice(0, 300));
  assert.match(view.content, /start_line and end_line/);

  const first = Number(note[1].replace(/,/g, ""));
  const range = fileView(text, { start: first, end: first + 2 }, true);
  assert.equal(range.ok, true);
  assert.equal(range.content, `[Lines ${first.toLocaleString("en-US")}-${(first + 2).toLocaleString("en-US")} of 3,000]\n`
    + [first, first + 1, first + 2].map((n) => `line ${n}: keeps a little of the file's own text on it`).join("\n"));
});

test("a range past the end says how long the file is, and a file bigger than was opened says so", () => {
  const text = numberedLines(30);
  const past = fileView(text, { start: 5000 }, true);
  assert.equal(past.ok, false);
  assert.match(past.content, /has 30 lines, so there is no line 5,000/);

  const partial = fileView(numberedLines(4000), {}, false);
  assert.match(partial.content, /Only the start of this file was opened/);
});

test("read_file takes line numbers, as numbers or as digits in a string", async () => {
  writeFileSync(path.join(testWorkspace, "long.txt"), numberedLines(2500));
  const whole = await runTool({ name: "read_file", arguments: { path: "long.txt" } }, { memories: [], knowledge: [] });
  assert.equal(whole.ok, true);
  assert.ok(estimateTokens(whole.content) <= maxToolResultTokens, "a long file no longer comes back whole");
  assert.match(whole.content, /of 2,500\)/);

  const part = await runTool({ name: "read_file", arguments: { path: "long.txt", start_line: "1200", end_line: 1201 } },
    { memories: [], knowledge: [] });
  assert.equal(part.ok, true);
  assert.equal(part.content, "[Lines 1,200-1,201 of 2,500]\n"
    + "line 1200: keeps a little of the file's own text on it\nline 1201: keeps a little of the file's own text on it");
});

// ------------------------------------------------------------- writing a view back

test("a shortened view is never written back over the file it came from", async () => {
  const target = path.join(testWorkspace, "server.txt");
  const original = numberedLines(2500);
  writeFileSync(target, original);
  const view = (await runTool({ name: "read_file", arguments: { path: "server.txt" } }, { memories: [], knowledge: [] })).content;

  const write = await runTool({ name: "write_file", arguments: { path: "server.txt", content: view.replace("line 1:", "line one:") } },
    { memories: [], knowledge: [], request: "fix the first line of server.txt" });
  assert.equal(write.ok, false);
  assert.match(write.content, /shortened view/);
  assert.match(write.content, /edit_file/);
  assert.equal(readFileSync(target, "utf8"), original, "nothing was written");

  const edit = await runTool({ name: "edit_file", arguments: { path: "server.txt", append: view } },
    { memories: [], knowledge: [], request: "add the lines to the end of server.txt" });
  assert.equal(edit.ok, false);
  assert.equal(readFileSync(target, "utf8"), original);
});

test("each kind of view marker is recognised, and ordinary text is not", () => {
  assert.ok(elisionIn(shorten(numberedLines(500), 2000, "hint")));
  assert.ok(elisionIn("[Lines 10-20 of 300]\nconst a = 1;"));
  assert.ok(elisionIn("abc\n\n[truncated - this file is longer than shown]"));
  assert.equal(elisionIn("const lines = [10, 20];\n// of 300\n"), null);
});

test("a file too long to be shown whole must keep nearly every line when rewritten", () => {
  const before = numberedLines(1000);
  const lines = before.trimEnd().split("\n");
  const fourFifths = lines.filter((_, i) => i % 5 !== 0).join("\n");
  // Seen whole, keeping four lines in five is an ordinary edit.
  assert.equal(replacesMostOf(before, fourFifths, "tidy server.txt", true), null);
  // Seen only in part, the fifth that went is most likely the part not shown.
  assert.deepEqual(replacesMostOf(before, fourFifths, "tidy server.txt", false), { before: 1000, kept: 800 });
  // A faithful copy with one line changed still goes through,
  const oneChanged = lines.map((line, i) => (i === 3 ? "line 4: changed" : line)).join("\n");
  assert.equal(replacesMostOf(before, oneChanged, "fix line 4", false), null);
  // and so does a rewrite someone asked for.
  assert.equal(replacesMostOf(before, "new", "rewrite server.txt from scratch", false), null);
  assert.equal(fitsOneRead(before), false);
  assert.equal(fitsOneRead(numberedLines(20)), true);
});

// ------------------------------------------------------------- the whole prompt

type Msg = { role: string; content: string; tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }> };

test("a prompt that fits is sent as it is", () => {
  const messages: Msg[] = [{ role: "system", content: "rules" }, { role: "user", content: "question" }];
  assert.equal(fitPromptToWindow(messages, 100, 10_000, [0, 1]), 0);
  assert.deepEqual(messages, [{ role: "system", content: "rules" }, { role: "user", content: "question" }]);
});

test("tool results give way first, largest first, and the rules and the question never do", () => {
  const rules = "Rule: always answer from the tools. ".repeat(400);
  const question = "What does the big file say? ".repeat(150);
  const bigResult = numberedLines(600);
  const smallResult = numberedLines(150);
  const messages: Msg[] = [
    { role: "system", content: rules },
    { role: "user", content: "earlier question" },
    { role: "assistant", content: "earlier answer" },
    { role: "user", content: question },
    { role: "assistant", content: "", tool_calls: [{ function: { name: "read_file", arguments: { path: "a.txt" } } }] },
    { role: "tool", content: bigResult },
    { role: "tool", content: smallResult }
  ];
  const budget = requestTokens(messages, 500) - 2000;

  const removed = fitPromptToWindow(messages, 500, budget, [0, 3]);
  assert.ok(removed >= 2000, `removed ${removed}`);
  assert.ok(requestTokens(messages, 500) <= budget, "it fits");
  assert.equal(messages[0].content, rules, "the rules are untouched");
  assert.equal(messages[3].content, question, "and so is the question");
  assert.notEqual(messages[5].content, bigResult, "the largest result gave way");
  assert.match(messages[5].content, /shortened to make room/);
  assert.equal(messages[6].content, smallResult, "and was enough on its own");
});

test("the question is protected by where it is, not by being the last user message", () => {
  const question = "Explain this. ".repeat(400);
  const messages: Msg[] = [
    { role: "system", content: "rules" },
    { role: "user", content: question },
    { role: "tool", content: numberedLines(300) },
    { role: "user", content: "That reply described a tool call instead of making it. ".repeat(60) }
  ];
  fitPromptToWindow(messages, 0, requestTokens(messages, 0) - 1500, [0, 1]);
  assert.equal(messages[1].content, question);
});

test("an earlier call's long arguments can be shortened, without touching the arguments it ran with", () => {
  const ranWith = { path: "app.js", content: numberedLines(800) };
  const messages: Msg[] = [
    { role: "system", content: "rules" },
    { role: "user", content: "write app.js" },
    { role: "assistant", content: "", tool_calls: [{ function: { name: "write_file", arguments: ranWith } }] },
    { role: "tool", content: "Wrote app.js." }
  ];
  const budget = requestTokens(messages, 0) - 3000;
  fitPromptToWindow(messages, 0, budget, [0, 1]);
  assert.ok(requestTokens(messages, 0) <= budget);
  const sent = messages[2].tool_calls?.[0].function.arguments.content as string;
  assert.match(sent, /the call itself went through in full/);
  assert.equal(ranWith.content, numberedLines(800), "a call held for confirmation still runs with what was asked");
});

// ------------------------------------------------------------- through the loop

/**
 * A stand-in engine answering each chat request with the next scripted turn.
 * `window` is the context window it says the model is loaded with - the
 * figure the loop cuts its prompt to.
 */
async function fakeModel(turns: ScriptedReply[], window?: number) {
  const engine = await fakeEngine({ models: ["qwen2.5-coder:7b"], reply: turns, window });
  return {
    server: engine.server,
    baseUrl: engine.baseUrl,
    received: engine.chats as Array<{ messages: Msg[]; tools?: unknown[]; max_tokens?: number }>
  };
}

const call = (name: string, args: Record<string, unknown>) => ({ message: { content: "", tool_calls: [{ function: { name, arguments: args } }] } });

test("reading two long files in one turn keeps every request inside the window, rules first", async () => {
  writeFileSync(path.join(testWorkspace, "big-a.txt"), numberedLines(4000, "alpha alpha alpha alpha"));
  writeFileSync(path.join(testWorkspace, "big-b.txt"), numberedLines(4000, "bravo bravo bravo bravo"));
  // The window is the engine's to give: it says 12,000 here, and the loop has
  // to cut every request to that, whatever its own default is.
  const contextTokens = 12_000;
  const { server, baseUrl, received } = await fakeModel([
    call("read_file", { path: "big-a.txt" }),
    call("read_file", { path: "big-b.txt" }),
    { message: { content: "Both files are numbered lines." } }
  ], contextTokens);
  try {
    const result = await runAgent({ baseUrl, model: "qwen2.5-coder:7b", modelFromEnv: true, timeoutMs: 4000 },
      "read big-a.txt and then big-b.txt and tell me what they contain", { memories: [], knowledge: [] });
    assert.equal(result.ok, true);
    assert.equal(received.length, 3);

    const budget = promptBudgetTokens(contextTokens);
    for (const [index, request] of received.entries()) {
      const toolsTokens = request.tools ? estimateTokens(JSON.stringify(request.tools)) : 0;
      assert.ok(requestTokens(request.messages, toolsTokens) <= budget,
        `request ${index + 1} is ~${requestTokens(request.messages, toolsTokens)} tokens for a ${budget}-token budget`);
      assert.equal(request.messages[0].content, received[0].messages[0].content, "the rules go out whole every time");
      assert.equal(request.max_tokens, contextTokens, "and a reply may be as long as that window, no longer");
    }
    const last = received[2].messages;
    assert.ok(last.some((message) => message.role === "user" && message.content.startsWith("read big-a.txt")), "the question too");
    const results = last.filter((message) => message.role === "tool").map((message) => message.content).join("\n");
    assert.match(results, /alpha/);
    assert.match(results, /bravo/);
    assert.match(results, /left out here to fit the model's working memory/);
  } finally {
    server.close();
  }
});
