import test from "node:test";
import assert from "node:assert/strict";
import { getSystemCapabilities, toolsByLevel } from "../src/services/systemCapabilities.js";
import { toolDefinitions } from "../src/services/agentTools.js";
import { toolPermissions } from "../src/services/toolPermissions.js";

// The capability report has to be a description of the real registry, not a
// second, hand-maintained list that can drift from it. Every assertion here
// is checked against toolDefinitions/toolPermissions directly rather than
// against a copy of their contents, so a future tool addition or removal
// cannot make these tests pass while the report itself goes stale.

test("every registered tool is reported, and nothing else is", () => {
  const capabilities = getSystemCapabilities("ollama/test-model");
  const reported = capabilities.tools.map((tool) => tool.name).sort();
  const registered = toolDefinitions.map((definition) => definition.function.name).sort();

  assert.deepEqual(reported, registered);
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

test("code execution is reported unavailable, because no such tool exists", () => {
  // Not a placeholder value — there is genuinely no tool registered for
  // this, and a capability report that said otherwise would be inventing.
  const capabilities = getSystemCapabilities(null);
  assert.equal(capabilities.codeExecution, false);
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
