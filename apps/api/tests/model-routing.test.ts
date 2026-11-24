import test from "node:test";
import assert from "node:assert/strict";
import { anyModelWillDo, modelOrderFor, taskKindFor } from "../src/services/modelRouting.js";
import type { Hardware } from "../src/services/modelSetup.js";

// The right model for the task (the owner's brief of 2026-11-23): which kind of task a request is,
// and which of the installed models answers it, with a chosen model left alone and no room wasted.

const gib = 1024 ** 3;
const bigPc: Hardware = { totalMemoryBytes: 32 * gib, cpuCores: 12, gpu: { vendor: "nvidia", name: "A card", memoryMiB: 8192, driver: "581.0" } };
const smallPc: Hardware = { totalMemoryBytes: 8 * gib, cpuCores: 4, gpu: null };
const everything = [
  "qwen2.5-3b", "qwen2.5-coder-7b-abliterated", "qwen2.5-coder-7b", "qwen2.5-vl-3b",
  "qwen3-4b-instruct-2507-abliterated", "qwen3-8b", "qwen3-vl-4b-abliterated", "qwen3-vl-8b-abliterated"
];
const kind = (request: string) => taskKindFor(request).kind;

test("each kind of task is read from the words", () => {
  assert.equal(kind("hello, how are you?"), "quick");
  assert.equal(kind("what is the capital of Australia?"), "quick");
  assert.equal(kind("what is 4827 times 193?"), "quick");
  assert.equal(kind("fix the bug in src/index.ts where the login form submits twice"), "code");
  assert.equal(kind("build me an app to track invoices"), "code");
  assert.equal(kind("add buy milk to my to-do list"), "actions");
  assert.equal(kind("remind me tomorrow at 3 pm to call the bank"), "actions");
  assert.equal(kind("Make a Word document called Plan with a three point plan for painting a fence."), "actions");
  assert.equal(kind("look up the latest news on the Rhode Island housing bill and give me sources"), "research");
  assert.equal(kind("write me a poem about my dog Biscuit"), "creative");
  assert.equal(kind("brainstorm ten names for a coffee shop by the sea"), "creative");
  assert.equal(kind("compare renting and buying a house for someone who moves every three years, with the trade-offs"), "reasoning");
  assert.equal(kind("why does my sourdough collapse after the second rise? think it through step by step"), "reasoning");
  assert.equal(kind(`${"I have a long situation to explain. ".repeat(20)}What should I do?`), "reasoning", "a long request");
  assert.equal(kind("what's the difference between a stock and a bond and how do dividends work for each of them?"), "general");
  assert.equal(taskKindFor("what is in this?", { hasImage: true }).kind, "pictures");
  assert.equal(kind("what does this screenshot say?"), "pictures");
});

test("the reason is a few words a person can read", () => {
  for (const request of ["hello", "write me a poem", "compare the two", "add milk to my list", "look up the news"]) {
    const routing = taskKindFor(request);
    assert.ok(routing.reason.length > 0 && routing.reason.length < 40, `${request}: ${routing.reason}`);
  }
});

test("on a PC with room, each kind goes to the model that suits it, and every other model follows as a fallback", () => {
  const first = (k: Parameters<typeof modelOrderFor>[0]) => modelOrderFor(k, everything, { hardware: bigPc })[0];
  assert.equal(first("quick"), "qwen3-4b-instruct-2507-abliterated", "the small fast one");
  assert.equal(first("code"), "qwen2.5-coder-7b-abliterated");
  assert.equal(first("actions"), "qwen2.5-coder-7b-abliterated");
  assert.equal(first("research"), "qwen2.5-coder-7b-abliterated", "tool work");
  assert.equal(first("reasoning"), "qwen3-8b", "the one that thinks first");
  assert.equal(first("creative"), "qwen3-8b");
  assert.equal(first("pictures"), "qwen3-vl-8b-abliterated");
  assert.equal(first("general"), "qwen2.5-coder-7b-abliterated", "as before");
  const order = modelOrderFor("reasoning", everything, { hardware: bigPc });
  assert.equal(new Set(order).size, everything.length, "every installed model is in the order once");
  assert.equal(order.length, everything.length);
});

test("on a small PC the big models are not tried first, and a PC with one model gets that model", () => {
  const order = modelOrderFor("reasoning", everything, { hardware: smallPc });
  assert.equal(order[0], "qwen3-4b-instruct-2507-abliterated");
  assert.ok(order.indexOf("qwen3-8b") > order.indexOf("qwen3-vl-4b-abliterated"), "the 8B is a fallback at the end");
  assert.deepEqual(modelOrderFor("code", ["qwen3-vl-4b-abliterated"], { hardware: smallPc }), ["qwen3-vl-4b-abliterated"]);
  assert.deepEqual(modelOrderFor("creative", ["qwen3-vl-4b-abliterated"], { hardware: bigPc }), ["qwen3-vl-4b-abliterated"]);
});

test("a model already loaded is kept for a task any model does well, and swapped for one that wants a specialist", () => {
  const loaded = ["qwen2.5-coder-7b-abliterated"];
  assert.equal(modelOrderFor("quick", everything, { hardware: bigPc, loaded })[0], "qwen2.5-coder-7b-abliterated", "no swap for a quick one");
  assert.equal(modelOrderFor("general", everything, { hardware: bigPc, loaded: ["qwen3-4b-instruct-2507-abliterated"] })[0], "qwen3-4b-instruct-2507-abliterated");
  assert.equal(modelOrderFor("reasoning", everything, { hardware: bigPc, loaded })[0], "qwen3-8b", "a specialist task swaps");
  assert.equal(modelOrderFor("quick", everything, { hardware: bigPc, loaded: ["qwen2.5-vl-3b"] })[0], "qwen3-4b-instruct-2507-abliterated", "a loaded model that is not suited is not kept");
  assert.equal(anyModelWillDo("quick"), true);
  assert.equal(anyModelWillDo("code"), false);
});

test("a model the person chose goes first, whatever the task", () => {
  const pinned = "qwen3-4b-instruct-2507-abliterated";
  assert.equal(modelOrderFor("code", everything, { hardware: bigPc, pinned })[0], pinned);
  assert.equal(modelOrderFor("code", everything, { hardware: bigPc, pinned })[1], "qwen2.5-coder-7b-abliterated", "the suited one is next, in case the chosen one will not load");
  assert.equal(modelOrderFor("code", everything, { hardware: bigPc, pinned: "not-installed" })[0], "qwen2.5-coder-7b-abliterated");
});
