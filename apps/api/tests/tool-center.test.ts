import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { once } from "node:events";
import { fakeEngine } from "./helpers/fakeEngine.js";

// The Tool center: every tool described for a person, whether it can run on
// this PC now and why not, and a count of every call that went through.

const dataDir = mkdtempSync(path.join(tmpdir(), "ascend-tool-center-"));
process.env.ASSIST_TOOL_USAGE_FILE = path.join(dataDir, "tool-usage.json");
process.env.ASSIST_MEMORY_FILE = path.join(dataDir, "memory.json");
process.env.ASSIST_CONVERSATION_FILE = path.join(dataDir, "conversations.json");
process.env.ASSIST_ACCOUNTS_FILE = path.join(dataDir, "accounts.json");
process.env.ASSIST_KNOWLEDGE_FILE = path.join(dataDir, "knowledge.json");
process.env.ASCEND_PREFERENCES_FILE = path.join(dataDir, "preferences.json");

const { createApp } = await import("../src/server.js");
const { runTool, toolDefinitions } = await import("../src/services/agentTools.js");
const { describeTools, toolCatalogue } = await import("../src/services/toolCenter.js");
const { reloadToolUsageFromDisk, resetToolUsage, toolUsage } = await import("../src/services/toolUsage.js");

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

type Probe = Parameters<typeof describeTools>[0];
const probe = (overrides: Partial<Probe> = {}): Probe => ({
  machineAccess: { armed: false, until: null },
  model: { available: true, name: "qwen2.5-coder:7b", reason: null },
  visionModel: "qwen2.5vl:3b",
  ffmpeg: true,
  piper: true,
  phoneLink: "linked",
  emailAccount: null,
  ...overrides
});
const tool = (name: string, overrides: Partial<Probe> = {}) => {
  const found = describeTools(probe(overrides)).find((entry) => entry.name === name);
  assert.ok(found, `${name} is described`);
  return found;
};

test("every registered tool says what it is for, in words a person reads, and nothing else is listed", () => {
  const registered = toolDefinitions.map((definition) => definition.function.name).sort();
  assert.deepEqual(Object.keys(toolCatalogue).sort(), registered, "the catalogue and the registry hold the same tools");
  for (const [name, entry] of Object.entries(toolCatalogue)) {
    assert.match(entry.summary, /^[A-Z].*\.$/, `${name}'s summary is a sentence`);
    assert.doesNotMatch(entry.summary, /\buse this\b|\bthe user\b/i, `${name}'s summary speaks to the person, not to the model`);
    assert.ok(entry.title.length > 0 && entry.title.length <= 30, `${name} has a short title`);
  }
});

test("every tool is listed, a switched-off one included, with the model's own instructions kept word for word", () => {
  const listed = describeTools(probe());
  assert.equal(listed.length, toolDefinitions.length);
  const command = listed.find((entry) => entry.name === "run_command");
  assert.equal(command?.readiness.state, "off", "machine access off: listed as off, not hidden");
  assert.match(command?.readiness.note ?? "", /Machine access is off/);
  const instructions = toolDefinitions.find((definition) => definition.function.name === "search_memory")?.function.description;
  assert.equal(tool("search_memory").instructions, instructions);
});

test("readiness comes from the checks: machine access, the vision model, ffmpeg and Piper, Phone Link, an email account", () => {
  assert.equal(tool("run_command", { machineAccess: { armed: true, until: "2026-10-02T12:00:00.000Z" } }).readiness.state, "ready");
  assert.match(tool("read_file").readiness.note ?? "", /workspace/);
  assert.match(tool("read_file", { machineAccess: { armed: true, until: null } }).readiness.note ?? "", /anywhere on this PC/);

  assert.equal(tool("look_at_image", { visionModel: null }).readiness.state, "needs-setup");
  assert.match(tool("look_at_image").readiness.note ?? "", /qwen2\.5vl:3b/);

  assert.match(tool("make_video", { ffmpeg: false }).readiness.note ?? "", /ffmpeg/);
  assert.match(tool("make_video", { piper: false }).readiness.note ?? "", /Piper/);
  assert.equal(tool("make_video").readiness.state, "ready");

  assert.equal(tool("send_text").readiness.state, "ready");
  assert.match(tool("send_text", { phoneLink: "not-linked" }).readiness.note ?? "", /Link your phone/);
  assert.match(tool("send_text", { phoneLink: "missing" }).readiness.note ?? "", /Microsoft Store/);

  assert.match(tool("send_email").readiness.note ?? "", /mail app/);
  assert.match(tool("send_email", { emailAccount: "me@example.com" }).readiness.note ?? "", /me@example\.com/);
  assert.equal(tool("calculate").readiness.state, "ready");
  assert.equal(tool("calculate").readiness.note, null, "no prerequisite, nothing to say");
});

test("asking first is the deletes and the sends; machine access is run_command's permission instead", () => {
  const asking = describeTools(probe()).filter((entry) => entry.asksFirst).map((entry) => entry.name).sort();
  assert.deepEqual(asking, ["delete_document", "forget", "send_email", "send_text"]);
  assert.equal(tool("run_command").asksFirst, false);
});

test("every call through runTool is counted: a result, no result, held for approval - and an invented tool is not", async () => {
  resetToolUsage();
  const context = { memories: [], knowledge: [] };

  const sum = await runTool({ name: "calculate", arguments: { expression: "6*7" } }, context);
  assert.equal(sum.ok, true);
  const counted = toolUsage("calculate");
  assert.equal(counted.uses, 1);
  assert.equal(counted.lastOk, true);
  assert.equal(typeof counted.lastDurationMs, "number");
  assert.ok(counted.lastUsedAt);

  // Nothing remembered, so nothing matches: not a failure, and not called one.
  const searched = await runTool({ name: "search_memory", arguments: { query: "printer" } }, context);
  assert.equal(searched.ok, false);
  assert.deepEqual([toolUsage("search_memory").uses, toolUsage("search_memory").noResult, toolUsage("search_memory").lastOk], [1, 1, false]);

  const held = await runTool({ name: "forget", arguments: { fact: "the printer is upstairs" } }, context);
  assert.equal(held.needsConfirmation, true);
  assert.deepEqual([toolUsage("forget").held, toolUsage("forget").uses, toolUsage("forget").lastUsedAt], [1, 0, null], "held is not a use");

  await runTool({ name: "made_up_tool", arguments: {} }, context);
  assert.equal(toolUsage("made_up_tool").uses, 0);

  reloadToolUsageFromDisk();
  assert.equal(toolUsage("calculate").uses, 1, "the counts survive a restart");
  assert.equal(describeTools(probe()).find((entry) => entry.name === "calculate")?.usage.uses, 1, "and reach the description");
});

/** A stand-in engine with a chat model and a vision model. */
function standInModels() {
  return fakeEngine({ models: ["llama3.2:latest", "qwen2.5-vl-3b"], vision: ["qwen2.5-vl-3b"] });
}

test("GET /v1/tools describes every tool, with the model's state and the machine-access switch", async () => {
  const model = await standInModels();
  const previous = process.env.TRHAI_ENGINE_URL;
  process.env.TRHAI_ENGINE_URL = model.baseUrl;
  const app = createApp().listen(0);
  await once(app, "listening");
  try {
    const response = await fetch(`http://127.0.0.1:${(app.address() as AddressInfo).port}/v1/tools`);
    assert.equal(response.status, 200);
    const { data } = await response.json() as any;
    assert.equal(data.tools.length, toolDefinitions.length);
    assert.equal(data.model.available, true);
    assert.equal(typeof data.machineAccess.armed, "boolean");
    const image = data.tools.find((entry: { name: string }) => entry.name === "look_at_image");
    assert.equal(image.readiness.state, "ready", "the vision model the stand-in lists is found");
    for (const entry of data.tools) {
      assert.ok(entry.title && entry.summary && entry.area && entry.levelLabel, `${entry.name} is fully described`);
      assert.equal(typeof entry.usage.uses, "number");
    }
  } finally {
    if (previous === undefined) delete process.env.TRHAI_ENGINE_URL;
    else process.env.TRHAI_ENGINE_URL = previous;
    await new Promise<void>((resolve) => app.close(() => resolve()));
    model.server.close();
  }
});
