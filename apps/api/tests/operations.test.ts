import test from "node:test";
import assert from "node:assert/strict";
import { operationsFrom, summarise, type OperationFacts } from "../src/services/operations.js";

const GB = 1024 ** 3;

function healthy(): OperationFacts {
  return {
    api: { uptimeSeconds: 600 },
    web: { reachable: true, url: "http://127.0.0.1:3210" },
    desktop: { applicable: true, installed: true },
    engine: { reachable: true, version: "b11366", reason: null, loaded: ["qwen2.5-3b"], installed: ["qwen2.5-3b", "qwen3-8b"], wanted: "qwen2.5-3b" },
    piper: { available: true, detail: "4 voices, speaking as Ryan" },
    whisper: { available: true, detail: "Model ggml-base.en" },
    ffmpeg: { found: true },
    workspace: { path: "C:/Vexora/workspace", writable: true, freeBytes: 200 * GB },
    stores: { failing: [], locked: [] },
    schedules: { count: 2 },
    memory: { freeBytes: 4 * GB, totalBytes: 8 * GB }
  };
}

const row = (facts: OperationFacts, id: string) => operationsFrom(facts).find((entry) => entry.id === id)!;

test("a healthy machine has every row ok and no fix to give", () => {
  const rows = operationsFrom(healthy());
  assert.ok(rows.every((entry) => entry.status === "ok"), JSON.stringify(rows.filter((r) => r.status !== "ok")));
  assert.ok(rows.every((entry) => entry.fix === undefined));
  assert.deepEqual(summarise(rows), { ready: rows.length, total: rows.length, failing: 0, warnings: 0 });
});

test("every row that is not ok says what to do about it", () => {
  const broken = healthy();
  broken.web.reachable = false;
  broken.engine = { reachable: false, version: null, reason: null, loaded: [], installed: [], wanted: "qwen2.5-3b" };
  broken.piper = { available: false, detail: "Piper is not installed on this machine." };
  broken.whisper = { available: false, detail: "whisper.cpp is not installed on this machine." };
  broken.ffmpeg = { found: false };
  broken.workspace.writable = false;
  broken.stores.locked = ["memory.json"];
  broken.memory = { freeBytes: 0.3 * GB, totalBytes: 8 * GB };
  broken.desktop.installed = false;
  for (const entry of operationsFrom(broken).filter((r) => r.status !== "ok")) {
    assert.ok(entry.fix && entry.fix.length > 10, `${entry.id} has no fix`);
  }
});

test("a missing web app or engine is a failure; missing voice, video or desktop only a warning", () => {
  const facts = healthy();
  facts.web.reachable = false;
  facts.engine = { reachable: false, version: null, reason: "not running", loaded: [], installed: [], wanted: "x" };
  assert.equal(row(facts, "web").status, "fail");
  assert.equal(row(facts, "engine").status, "fail");

  const optional = healthy();
  optional.piper = { available: false, detail: "no" };
  optional.whisper = { available: false, detail: "no" };
  optional.ffmpeg = { found: false };
  optional.desktop.installed = false;
  for (const id of ["piper", "whisper", "ffmpeg", "desktop"]) assert.equal(row(optional, id).status, "warn", id);
});

test("locked data outranks data that is merely not saving, and both are failures", () => {
  const locked = healthy();
  locked.stores = { failing: ["tasks.json"], locked: ["memory.json"] };
  assert.match(row(locked, "stores").detail, /Locked/);
  assert.equal(row(locked, "stores").status, "fail");
  const failing = healthy();
  failing.stores = { failing: ["tasks.json"], locked: [] };
  assert.match(row(failing, "stores").detail, /Not saving/);
  assert.equal(row(failing, "stores").status, "fail");
});

test("a different model answering is a warning, and no model at all is a failure", () => {
  const other = healthy();
  other.engine.wanted = "qwen2.5-coder-7b";
  other.engine.installed = ["qwen2.5-3b"];
  assert.equal(row(other, "model").status, "warn");
  assert.match(row(other, "model").detail, /qwen2.5-3b will answer instead/);
  const none = healthy();
  none.engine.installed = [];
  assert.equal(row(none, "model").status, "fail");
});

test("low free memory warns, plenty does not", () => {
  const low = healthy();
  low.memory = { freeBytes: 0.5 * GB, totalBytes: 8 * GB };
  assert.equal(row(low, "memory").status, "warn");
  const ok = healthy();
  ok.memory = { freeBytes: 1.2 * GB, totalBytes: 8 * GB };
  assert.equal(row(ok, "memory").status, "ok");
});

test("the desktop row is left out where there is no desktop shell to have", () => {
  const facts = healthy();
  facts.desktop = { applicable: false, installed: false };
  assert.equal(operationsFrom(facts).some((entry) => entry.id === "desktop"), false);
});

test("disk row only appears when free space could be read, and warns under 5 GB", () => {
  const unknown = healthy();
  unknown.workspace.freeBytes = null;
  assert.equal(operationsFrom(unknown).some((entry) => entry.id === "disk"), false);
  const low = healthy();
  low.workspace.freeBytes = 2 * GB;
  assert.equal(row(low, "disk").status, "warn");
});
