import test from "node:test";
import assert from "node:assert/strict";
import { getSystemCapabilities, toolsByLevel } from "../src/services/systemCapabilities.js";
import { availableTools, toolDefinitions } from "../src/services/agentTools.js";
import { armCommands, commandsArmed, disarmCommands } from "../src/services/commandRunner.js";
import { toolPermissions } from "../src/services/toolPermissions.js";


// The capability report has to be a description of the real registry, not a
// second, hand-maintained list that can drift from it. Every assertion here
// is checked against toolDefinitions/toolPermissions directly rather than
// against a copy of their contents, so a future tool addition or removal
// cannot make these tests pass while the report itself goes stale.

test("every tool actually on offer is reported, and nothing else is", () => {
  // Against what is offered rather than everything that exists: run_command
  // is withheld while machine control is off, and a report that listed it
  // anyway would describe a capability the loop refuses — the exact drift
  // this module exists to prevent.
  const capabilities = getSystemCapabilities("ollama/test-model");
  const reported = capabilities.tools.map((tool) => tool.name).sort();
  const offered = availableTools(commandsArmed()).map((definition) => definition.function.name).sort();

  assert.deepEqual(reported, offered);
});

test("machine control is reported as off until it is switched on", () => {
  disarmCommands();
  const off = getSystemCapabilities(null);
  assert.equal(off.codeExecution, false);
  assert.ok(!off.tools.some((tool) => tool.name === "run_command"),
    "a disarmed build must not advertise it");

  armCommands();
  try {
    const on = getSystemCapabilities(null);
    assert.equal(on.codeExecution, true, "and it must not deny it once switched on");
    assert.ok(on.tools.some((tool) => tool.name === "run_command"));
  } finally {
    disarmCommands();
  }
});

test("every tool that exists is still classified, offered or not", () => {
  // The offered set narrows; the ladder must not. A tool that is withheld
  // today still needs a level for the day it is offered.
  for (const definition of toolDefinitions) {
    assert.ok(toolPermissions[definition.function.name] !== undefined,
      `${definition.function.name} has no permission level`);
  }
});

test("each tool's permission level matches the real registry, not a guess", () => {
  const capabilities = getSystemCapabilities(null);
  for (const tool of capabilities.tools) {
    assert.equal(tool.level, toolPermissions[tool.name], `${tool.name} reported the wrong level`);
  }
});

test("confirmation is required for exactly the destructive and external tools", () => {
  const capabilities = getSystemCapabilities(null);
  for (const tool of capabilities.tools) {
    assert.equal(tool.requiresConfirmation, tool.level >= 3, `${tool.name} disagreed with its own level`);
  }
});

test("the model is reported exactly as given, including absence", () => {
  assert.equal(getSystemCapabilities("ollama/llama3.2:latest").model, "ollama/llama3.2:latest");
  assert.equal(getSystemCapabilities(null).model, null);
});

test("filesystem, memory, documents and app-building are true because the tools for them exist", () => {
  const capabilities = getSystemCapabilities(null);
  assert.equal(capabilities.filesystem, true);
  assert.equal(capabilities.memory, true);
  assert.equal(capabilities.documents, true);
  assert.equal(capabilities.applicationBuilding, true);
});

test("web access is reported available, because fetch_url is genuinely registered", () => {
  const capabilities = getSystemCapabilities(null);
  assert.equal(capabilities.web, true);
});

test("code execution is reported unavailable while machine control is off", () => {
  // This used to hold because no such tool existed. One exists now, so the
  // reason has changed even though the answer has not: it is false because
  // the capability is switched off, not because it is absent. Asserting the
  // old reason would leave a test passing for something that stopped being
  // true — which is the drift this whole module guards against.
  disarmCommands();
  assert.equal(getSystemCapabilities(null).codeExecution, false);
});

test("integrations are reported as none, honestly, rather than omitted", () => {
  assert.deepEqual(getSystemCapabilities(null).integrations, []);
});

test("grouping by level covers every tool exactly once", () => {
  const capabilities = getSystemCapabilities(null);
  const grouped = toolsByLevel(capabilities);
  const total = grouped.reduce((sum, group) => sum + group.tools.length, 0);

  assert.equal(total, capabilities.tools.length);
});

test("groups are labelled and ordered by the real permission ladder", () => {
  const grouped = toolsByLevel(getSystemCapabilities(null));
  const labels = grouped.map((group) => group.label);

  // safe (1) before development (2) before destructive (3) before external
  // (4) — whichever of these actually have a tool in them today.
  const expectedOrder = ["safe", "development", "destructive", "external"];
  const filteredExpected = expectedOrder.filter((label) => labels.includes(label));
  assert.deepEqual(labels, filteredExpected);
});

test("a tool with an empty group is not reported as a group", () => {
  // Nothing is registered at "external" today; the report should not show an
  // empty external category as though something belonged there.
  const grouped = toolsByLevel(getSystemCapabilities(null));
  for (const group of grouped) {
    assert.ok(group.tools.length > 0, `${group.label} was reported with no tools`);
  }
});
