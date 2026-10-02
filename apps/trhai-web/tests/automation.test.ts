import test from "node:test";
import assert from "node:assert/strict";
import { describeFlow, executeFlow, validateFlow, type Flow } from "@ascend/shared";
import { depths, fieldsFor, maxLiveWaitSeconds, newFlow, newNode, sameFlow, stepTypes, totalWaitSeconds } from "../src/lib/automation.js";

// The Automation workspace's editing helpers, against the engine they feed.

const flow = (nodes: Flow["nodes"]): Flow => ({ id: "f", name: "Test", nodes });

test("every kind of step the engine knows can be added, and each says what it does", () => {
  const types = stepTypes.map((step) => step.type).sort();
  assert.deepEqual(types, ["call-api", "discord-message", "else", "email", "end-if", "generate-image", "if", "open-website", "run-script", "wait"]);
  for (const step of stepTypes) assert.match(step.summary, /\.$/);
});

test("new steps start with settings the engine accepts", () => {
  const built = flow([newNode("run-script", "1", [{ name: "tests" }]), newNode("if", "2"), newNode("wait", "3"), newNode("end-if", "4")]);
  assert.deepEqual(validateFlow(built), []);
  assert.deepEqual(describeFlow(built), ["RUN SCRIPT tests", "IF ok == true", "  WAIT 5s", "END IF"]);
});

test("steps sit inside their IF blocks, with ELSE and END IF lined up with the IF", () => {
  const nested = flow([
    newNode("run-script", "a"), newNode("if", "b"), newNode("wait", "c"), newNode("if", "d"), newNode("wait", "e"),
    newNode("end-if", "f"), newNode("else", "g"), newNode("wait", "h"), newNode("end-if", "i")
  ]);
  assert.deepEqual(depths(nested), [0, 0, 1, 1, 2, 1, 0, 1, 0]);
});

test("checks are offered by name when the desktop app lists them, and typed otherwise", () => {
  const offered = fieldsFor("run-script", [{ name: "tests", label: "Tests" }]);
  assert.equal(offered[0].kind, "select");
  assert.deepEqual(offered[0].options, [{ value: "tests", label: "Tests" }]);
  assert.equal(fieldsFor("run-script")[0].kind, "text");
  assert.deepEqual(fieldsFor("else"), []);
});

test("the time a run would spend waiting is counted, against the limit for a run here", () => {
  const waiting = flow([{ id: "1", type: "wait", config: { seconds: "30" } }, { id: "2", type: "wait", config: { seconds: "nonsense" } }, { id: "3", type: "wait", config: { seconds: "100" } }]);
  assert.equal(totalWaitSeconds(waiting), 130);
  assert.ok(totalWaitSeconds(waiting) > maxLiveWaitSeconds);
});

test("a dry run of a new flow says what each step would do, and runs nothing", async () => {
  const draft = flow([newNode("run-script", "1", [{ name: "tests" }]), newNode("email", "2")]);
  let ran = 0;
  const run = await executeFlow(draft, { dryRun: true, runScript: async () => { ran += 1; return { ok: true, exitCode: 0 }; } });
  assert.equal(ran, 0);
  assert.deepEqual(run.steps.map((step) => step.status), ["dry-run", "dry-run"]);
  assert.match(run.steps[1].message, /needs a connected mail account/i);
});

test("unsaved changes are any change at all", () => {
  const saved = newFlow("x");
  assert.equal(sameFlow(saved, { ...saved }), true);
  assert.equal(sameFlow(saved, { ...saved, name: "Renamed" }), false);
  assert.equal(sameFlow(null, saved), false);
});
