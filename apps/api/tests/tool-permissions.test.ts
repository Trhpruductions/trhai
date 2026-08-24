import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.ASCEND_WORKSPACE = mkdtempSync(path.join(tmpdir(), "ascend-permissions-"));

import type { ToolContext } from "../src/services/agentTools.js";

const { runTool, toolDefinitions } = await import("../src/services/agentTools.js");
const {
  permissionLevelOf,
  requiresConfirmation,
  toolPermissions
} = await import("../src/services/toolPermissions.js");
const {
  clearPendingConfirmation,
  confirmationWindowMs,
  consumePendingConfirmation,
  getPendingConfirmation,
  isAffirmative,
  recordPendingConfirmation,
  resetPendingConfirmations
} = await import("../src/services/pendingConfirmation.js");

const at = new Date("2026-08-17T12:00:00Z").toISOString();

const context: ToolContext = {
  memories: [
    { id: "m1", title: "Database", body: "The billing database is Postgres 16.", pinned: false, createdAt: at }
  ],
  knowledge: [],
  documents: [{ id: "d1", title: "Onboarding", body: "Day one: get accounts." }],
  forgetMemory: () => true,
  deleteDocument: () => true,
  saveMemory: () => "saved",
  now: () => new Date("2026-08-17T12:00:00Z")
};

test("every registered tool is classified, and nothing else is", () => {
  // The point of this test: a new tool cannot be added without deciding what
  // it is allowed to do. Without it, an unclassified tool would silently
  // inherit the fail-closed default and be refused in production instead of
  // here.
  const registered = toolDefinitions.map((definition) => definition.function.name).sort();
  const classified = Object.keys(toolPermissions).sort();

  assert.deepEqual(classified, registered);
});

test("levels are assigned the way the ladder describes", () => {
  // Reading and analysing.
  for (const safe of ["search_memory", "read_file", "list_files", "calculate", "plan_app"]) {
    assert.equal(permissionLevelOf(safe), 1, `${safe} should be safe`);
  }

  // Creating and modifying inside a bounded workspace.
  for (const development of ["remember", "write_file", "write_document", "build_app"]) {
    assert.equal(permissionLevelOf(development), 2, `${development} should be development`);
  }

  // Destroying the only copy of something the user chose to keep.
  for (const destructive of ["forget", "delete_document"]) {
    assert.equal(permissionLevelOf(destructive), 3, `${destructive} should be destructive`);
  }
});

test("an unclassified tool is treated as destructive, not as safe", () => {
  // Failing closed. The cost of forgetting to classify should be a refusal,
  // never silent permission.
  assert.equal(permissionLevelOf("some_tool_added_later"), 3);
  assert.equal(requiresConfirmation("some_tool_added_later"), true);
});

test("safe and development tools run without being asked", async () => {
  // The other half of the ladder. A permission system that stops ordinary
  // work is not safer, it is just unusable — so this must keep passing.
  const read = await runTool({ name: "search_memory", arguments: { query: "database" } }, context);
  assert.equal(read.ok, true);

  const write = await runTool({ name: "remember", arguments: { fact: "The API runs on port 4000." } }, context);
  assert.equal(write.ok, true);

  assert.equal(read.needsConfirmation, undefined);
  assert.equal(write.needsConfirmation, undefined);
});

test("a destructive tool is refused, and nothing is deleted", async () => {
  let deleted = 0;

  const result = await runTool(
    { name: "forget", arguments: { fact: "The billing database is Postgres 16." } },
    { ...context, forgetMemory: () => { deleted += 1; return true; } }
  );

  assert.equal(result.ok, false);
  assert.equal(result.needsConfirmation, true);
  assert.match(result.content, /needs the user's confirmation/);
  // The part that matters: refused *before* the handler ran.
  assert.equal(deleted, 0, "nothing may be deleted while waiting for confirmation");
});

test("the refusal tells the model to ask rather than to route around it", async () => {
  const result = await runTool({ name: "delete_document", arguments: { title: "Onboarding" } }, context);

  assert.match(result.content, /ask them to confirm/i);
  assert.match(result.content, /do not attempt it another way/i);
  // Says plainly that nothing happened, so the model cannot report a deletion.
  assert.match(result.content, /Nothing has been changed/i);
});

test("an authorised destructive tool runs", async () => {
  const removed: string[] = [];

  const result = await runTool(
    { name: "forget", arguments: { fact: "The billing database is Postgres 16." } },
    { ...context, forgetMemory: (id) => { removed.push(id); return true; }, confirmedActions: new Set(["forget"]) }
  );

  assert.equal(result.ok, true);
  assert.deepEqual(removed, ["m1"]);
});

test("authorising one destructive tool does not authorise another", async () => {
  let deleted = 0;

  const result = await runTool(
    { name: "delete_document", arguments: { title: "Onboarding" } },
    {
      ...context,
      deleteDocument: () => { deleted += 1; return true; },
      // The user confirmed forgetting a memory, not deleting a document.
      confirmedActions: new Set(["forget"])
    }
  );

  assert.equal(result.ok, false);
  assert.equal(result.needsConfirmation, true);
  assert.equal(deleted, 0);
});

test("an unknown tool is refused as unknown, not held for confirmation", async () => {
  // The fail-closed default must not swallow this. A name that is not a tool
  // is a mistake to correct, and telling the model to ask the user to confirm
  // a tool that does not exist teaches it exactly the wrong move.
  const result = await runTool({ name: "delete_everything", arguments: {} }, context);

  assert.equal(result.ok, false);
  assert.notEqual(result.needsConfirmation, true);
  assert.match(result.content, /no tool called "delete_everything"/);
});

test("a pending confirmation is held, then taken exactly once", () => {
  resetPendingConfirmations();

  recordPendingConfirmation("s1", {
    tool: "forget",
    arguments: { fact: "something" },
    request: "Forget what I said about the database"
  });

  assert.equal(getPendingConfirmation("s1")?.tool, "forget");

  const taken = consumePendingConfirmation("s1");
  assert.equal(taken?.request, "Forget what I said about the database");

  // Taken once. An approval must not be replayable against a second action.
  assert.equal(consumePendingConfirmation("s1"), null);
});

test("an expired offer cannot be answered", () => {
  resetPendingConfirmations();
  const askedAt = 1_000_000;

  recordPendingConfirmation("s2", { tool: "forget", arguments: {}, request: "x" }, askedAt);

  assert.ok(getPendingConfirmation("s2", askedAt + confirmationWindowMs - 1));
  assert.equal(getPendingConfirmation("s2", askedAt + confirmationWindowMs + 1), null);
});

test("offers are per session and clearable", () => {
  resetPendingConfirmations();
  recordPendingConfirmation("alice", { tool: "forget", arguments: {}, request: "a" });
  recordPendingConfirmation("bob", { tool: "delete_document", arguments: {}, request: "b" });

  assert.equal(getPendingConfirmation("alice")?.tool, "forget");
  assert.equal(getPendingConfirmation("bob")?.tool, "delete_document");

  clearPendingConfirmation("alice");
  assert.equal(getPendingConfirmation("alice"), null);
  assert.equal(getPendingConfirmation("bob")?.tool, "delete_document");
});

test("agreement is recognised the way people actually say it", () => {
  for (const yes of ["yes", "Yes.", "yep", "yeah", "ok", "okay", "sure", "confirm", "confirmed", "go ahead", "do it", "please do", "delete it"]) {
    assert.equal(isAffirmative(yes), true, `"${yes}" should read as agreement`);
  }
});

test("a sentence that merely contains yes is not agreement", () => {
  // This grants permission to destroy something, so the cost of reading
  // agreement into an ordinary sentence is much higher than asking twice.
  for (const notYes of [
    "yesterday I deleted the wrong file",
    "no, don't do that",
    "why would I confirm that?",
    "I'm not sure — what would it delete?",
    "does it delete it permanently?"
  ]) {
    assert.equal(isAffirmative(notYes), false, `"${notYes}" must not read as agreement`);
  }

  for (const value of [undefined, null, 42, {}]) {
    assert.equal(isAffirmative(value), false);
  }
});
