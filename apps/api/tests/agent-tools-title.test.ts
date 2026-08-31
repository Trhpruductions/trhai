import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const workspace = mkdtempSync(path.join(tmpdir(), "trhai-title-"));
process.env.ASCEND_WORKSPACE = workspace;

const { runTool } = await import("../src/services/agentTools.js");

// An app is named after what was asked for, not the model's paraphrase.
//
// build_app's `description` is written by the model, and models describe an
// app by what it does. "build me a calculator" arrived as "performs basic
// arithmetic operations like addition", and the project was filed under
// performs-basic-arithmetic-operations-like - the folder, the browser tab and
// the page heading all at once.

test("the user's words name the app, not the model's description", async () => {
  // Driven through the records template so this needs no model: the point
  // under test is which string the name comes from, not who writes the code.
  const result = await runTool(
    { name: "build_app", arguments: { description: "a tracker for garden plants with species and last watered" } },
    { memories: [], knowledge: [], request: "build me a plant diary" }
  );

  assert.equal(result.ok, true, result.content);
  assert.match(result.content, /plant-diary/, "the folder should follow the request");
  assert.doesNotMatch(result.content, /stores-garden|garden-plants/, "not the model's wording");
});

test("a request that names nothing leaves the description to do the work", async () => {
  // "build me an app" derives "App", which distinguishes nothing - a folder of
  // them called app, app-2, app-3 is unusable. There the model's fuller
  // description really is the better name.
  const result = await runTool(
    { name: "build_app", arguments: { description: "a tracker for garden plants with species and last watered" } },
    { memories: [], knowledge: [], request: "build me an app" }
  );

  assert.equal(result.ok, true, result.content);
  assert.doesNotMatch(result.content, /workspace at app\//, "generic name should not win");
});
