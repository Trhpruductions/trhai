import test from "node:test";
import assert from "node:assert/strict";
import {
  countByLevel, countTools, filterTools, groupByArea, lastCallWords, levels, usageLine, type ToolEntry, type ToolUsage
} from "../src/lib/toolCenter.js";

// The Tool center's wording, filtering and grouping.

const unused: ToolUsage = { uses: 0, noResult: 0, held: 0, lastUsedAt: null, lastOk: null, lastDurationMs: null };

const tool = (name: string, area: ToolEntry["area"], overrides: Partial<ToolEntry> = {}): ToolEntry => ({
  name, area, title: name.replace(/_/g, " "), summary: `Does ${name}.`, instructions: "", level: 1, levelLabel: "safe",
  asksFirst: false, readiness: { state: "ready", note: null }, usage: unused, ...overrides
});

const list = [
  tool("search_memory", "Memory", { usage: { ...unused, uses: 3, lastUsedAt: "2026-10-02T09:00:00.000Z", lastOk: true, lastDurationMs: 12 } }),
  tool("forget", "Memory", { level: 3, asksFirst: true, usage: { ...unused, held: 2 } }),
  tool("run_command", "This PC", { level: 3, readiness: { state: "off", note: "Machine access is off." } }),
  tool("send_text", "Messages", { level: 4, asksFirst: true, readiness: { state: "needs-setup", note: "Link your phone." } }),
  tool("calculate", "Time and maths", { summary: "Works out arithmetic exactly." })
];

test("usage reads as a count and a time, and held calls are not uses", () => {
  const ago = () => "5m ago";
  assert.equal(usageLine(unused, ago), "Not used yet");
  assert.equal(usageLine({ ...unused, uses: 1, lastUsedAt: "x" }, ago), "Used 1 time · last 5m ago");
  assert.equal(usageLine({ ...unused, uses: 12, lastUsedAt: "x" }, ago), "Used 12 times · last 5m ago");
  assert.equal(usageLine({ ...unused, held: 2 }, ago), "Not used yet · held for you 2 times");
});

test("the last call is described by what came back, never called a failure", () => {
  assert.equal(lastCallWords(unused), null);
  assert.equal(lastCallWords({ ...unused, lastOk: true }), "Last call came back with a result");
  const without = lastCallWords({ ...unused, lastOk: false }) ?? "";
  assert.equal(without, "Last call came back without a result");
  assert.doesNotMatch(without, /fail/i);
});

test("search matches every word in the title, name, summary or area; filters keep what they say", () => {
  assert.deepEqual(filterTools(list, "arithmetic", "all").map((entry) => entry.name), ["calculate"]);
  assert.deepEqual(filterTools(list, "memory", "all").map((entry) => entry.name), ["search_memory", "forget"]);
  assert.deepEqual(filterTools(list, "", "used").map((entry) => entry.name), ["search_memory"], "held is not used");
  assert.deepEqual(filterTools(list, "", "asks-first").map((entry) => entry.name), ["forget", "send_text"]);
  assert.deepEqual(filterTools(list, "", "attention").map((entry) => entry.name), ["run_command", "send_text"]);
  assert.deepEqual(countTools(list), { all: 5, used: 1, "asks-first": 2, attention: 2 });
});

test("tools are grouped by area in a fixed order, with empty areas left out", () => {
  assert.deepEqual(groupByArea(list).map((group) => group.area), ["Memory", "Time and maths", "Messages", "This PC"]);
  assert.deepEqual(groupByArea(list)[0].tools.map((entry) => entry.name), ["search_memory", "forget"]);
});

test("the ladder says what each rung may do, and the top one always asks", () => {
  assert.deepEqual(countByLevel(list), { 1: 2, 2: 0, 3: 2, 4: 1 });
  for (const rung of [1, 2, 3, 4] as const) assert.ok(levels[rung].label && /\.$/.test(levels[rung].meaning));
  assert.match(levels[4].meaning, /Always asks you first/);
  assert.match(levels[3].meaning, /machine access/, "run_command's exception is stated where the rule is");
});
