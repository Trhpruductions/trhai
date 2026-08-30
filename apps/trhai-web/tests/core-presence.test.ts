import test from "node:test";
import assert from "node:assert/strict";
import {
  activeStage, coreStateForTool, presence, stageReplyVisible, stages, workingStates
} from "../src/components/corePresence.js";
import type { AssistantStatus } from "../src/hooks/useAssistant.js";

// presence() decides what the whole screen shows. Every case here is about the
// same question: can the interface end up claiming something that is not
// happening?

const idle: AssistantStatus = { state: "idle" };

// --- unreachable ----------------------------------------------------------

test("an unreachable API drains the core, whatever else is going on", () => {
  // The bug this pins down: "offline" was defined and styled and could never
  // be reached, so a dead API showed OFFLINE in the top bar while the core
  // carried on breathing in full colour — the most prominent thing on screen
  // contradicting the smallest.
  assert.equal(presence(idle, false, false, false).core, "offline");
  assert.equal(presence(idle, true, false, false).core, "offline");
  assert.equal(presence(idle, false, true, false).core, "offline");
  assert.equal(
    presence({ state: "executing", tool: "write_file" }, false, false, false).core,
    "offline"
  );
});

test("an unchecked connection is not treated as a broken one", () => {
  // null means the first check has not come back. Draining the core then would
  // make every page load open on a dead-looking machine.
  assert.equal(presence(idle, false, false, null).core, "idle");
  assert.equal(presence(idle, false, false, true).core, "idle");
});

test("nothing on the bottom rail is lit while unreachable", () => {
  // Including "engaged": a conversation that existed a minute ago is not one
  // now if the machine answering it has gone.
  assert.equal(activeStage("offline", true), null);
  assert.equal(activeStage("offline", false), null);
});

// --- ordering -------------------------------------------------------------

test("a genuinely open microphone outranks the request states", () => {
  // Listening describes the device rather than the request, and an open
  // microphone is the most important true thing on the screen.
  assert.equal(presence({ state: "thinking" }, true, false, true).core, "listening");
  assert.equal(presence({ state: "success" }, true, false, true).core, "listening");
});

test("speaking only shows when nothing more specific is true", () => {
  assert.equal(presence(idle, false, true, true).core, "speaking");
  // A running tool outranks the voice still finishing a sentence.
  assert.equal(
    presence({ state: "executing", tool: "run_command" }, false, true, true).core,
    "executing"
  );
});

// --- what the label says --------------------------------------------------

test("a running tool is named, not summarised as busy", () => {
  const p = presence({ state: "executing", tool: "write_file", stage: "building" }, false, false, true);
  assert.equal(p.core, "writing");
  assert.equal(p.label, "BUILDING · WRITE FILE");
});

test("a tool with no stage still names the tool", () => {
  assert.equal(
    presence({ state: "executing", tool: "list_files" }, false, false, true).label,
    "LIST FILES"
  );
});

test("thinking reports the real stage when there is one", () => {
  // "THINKING" for thirty seconds is true and says almost nothing.
  assert.equal(presence({ state: "thinking", stage: "gathering" }, false, false, true).label, "GATHERING");
  assert.equal(presence({ state: "thinking" }, false, false, true).label, "THINKING");
});

// --- tool mapping ---------------------------------------------------------

test("the kind of work shows, so searching does not look like writing", () => {
  // Every name here is a tool this app actually has, checked against
  // /v1/capabilities rather than assumed.
  assert.equal(coreStateForTool("fetch_url"), "searching");
  assert.equal(coreStateForTool("search_memory"), "searching");
  assert.equal(coreStateForTool("search_documents"), "searching");
  assert.equal(coreStateForTool("read_file"), "reading");
  assert.equal(coreStateForTool("list_files"), "reading");
  assert.equal(coreStateForTool("list_memories"), "reading");
  assert.equal(coreStateForTool("write_file"), "writing");
  assert.equal(coreStateForTool("write_document"), "writing");
  assert.equal(coreStateForTool("update_document"), "writing");
  assert.equal(coreStateForTool("build_app"), "writing");
  assert.equal(coreStateForTool("plan_app"), "analysing");
  assert.equal(coreStateForTool("run_command"), "executing");
});

test("an unknown tool reads as executing rather than guessing a kind", () => {
  // Every tool call is an execution, so the general answer is always true —
  // better than a specific wrong one for a tool added later.
  assert.equal(coreStateForTool("some_future_tool"), "executing");
});

test("every work state maps onto the rail's EXECUTING light", () => {
  for (const state of workingStates) {
    assert.equal(activeStage(state, false), "EXECUTING", `${state} did not light EXECUTING`);
  }
});

// --- the rail -------------------------------------------------------------

test("the rail lights nothing until something has actually happened", () => {
  // Otherwise it would be lit from the moment the app opened and mean nothing.
  assert.equal(activeStage("idle", false), null);
  assert.equal(activeStage("idle", true), "ENGAGED");
});

test("every rail word a state can produce is one the rail actually shows", () => {
  const produced = new Set(
    (["idle", "listening", "thinking", "speaking", "success", "error", "offline", ...workingStates] as const)
      .map((state) => activeStage(state, true))
      .filter((word): word is string => word !== null)
  );
  for (const word of produced) {
    assert.ok(
      (stages as readonly string[]).includes(word),
      `activeStage produced "${word}", which the rail has no light for`
    );
  }
});

// Where the current answer is drawn. The transcript rail starts closed, so
// without a copy on the stage a fresh app answers into a panel nobody can see.

test("the reply is on the stage while the console rail is closed", () => {
  assert.equal(stageReplyVisible(false, true, true), true);
});

test("the stage copy goes once the rail is open", () => {
  // The rail lists the same turn; both at once is the duplication.
  assert.equal(stageReplyVisible(true, true, true), false);
});

test("nothing is drawn before anything has been asked", () => {
  assert.equal(stageReplyVisible(false, false, false), false);
  assert.equal(stageReplyVisible(true, false, false), false);
});

test("a restored conversation is not presented as the current answer", () => {
  // Opening the app loads the stored transcript. The newest reply in it can be
  // days old, and the stage is where the answer to a question just asked goes.
  assert.equal(stageReplyVisible(false, true, false), false);
});

test("the answer is never rendered in both places at once", () => {
  for (const railOpen of [true, false]) {
    for (const fromThisRun of [true, false]) {
      const onStage = stageReplyVisible(railOpen, true, fromThisRun);
      assert.ok(!(onStage && railOpen), `both visible: rail=${railOpen} run=${fromThisRun}`);
    }
  }
});
