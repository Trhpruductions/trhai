import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// A workspace of its own before anything reads it.
const testWorkspace = mkdtempSync(path.join(tmpdir(), "ascend-round8-"));
process.env.ASCEND_WORKSPACE = testWorkspace;

const { classifyIntent } = await import("../src/services/actionIntent.js");
const { isRunningAppsRequest } = await import("../src/services/memoryRequests.js");
const { runAssistantOrchestrator } = await import("../src/services/orchestrator.js");
const { saveRendering, listRenderings } = await import("../src/services/renderMockup.js");

// Eighth sweep: the bigger features, live, once the model could read its whole
// prompt - a web page, the app lifecycle, and mockups.

test("a request to summarize a named page or file is an order to read it", () => {
  // Live: "summarize https://example.com in one sentence" was filed as a
  // question, and "I'm sorry, but I cannot fetch a URL or access the
  // internet" - with fetch_url on offer - stood as the answer.
  const page = classifyIntent("summarize https://example.com in one sentence");
  assert.equal(page.action, true);
  assert.equal(page.kind, "read");
  assert.deepEqual(page.expects, ["fetch_url"]);

  const file = classifyIntent("explain server.js");
  assert.equal(file.action, true);
  assert.deepEqual(file.expects, ["read_file"]);
  assert.equal(classifyIntent("describe the file D:/notes/plan.md").action, true);

  // Naming a file while asking about the idea is still a question.
  assert.equal(classifyIntent("explain what a package.json is for").action, false);
  assert.equal(classifyIntent("explain how promises work in javascript").action, false);
});

test("'what apps are running?' is read from the runner, not recalled", async () => {
  // Live: the model named the app that was running and added "Welcome to
  // TRHAI at localhost:3000", which was not.
  for (const request of ["what apps are running?", "which apps are running right now", "is anything running?",
    "show me the running apps", "what's running?"]) {
    assert.equal(isRunningAppsRequest(request), true, request);
  }
  for (const request of ["what apps do I have?", "run the calculator app", "what is running water?"]) {
    assert.equal(isRunningAppsRequest(request), false, request);
  }

  const app = (project: string, port: number) => ({ project, port, url: `http://localhost:${port}`, pid: 1, startedAt: "", output: [] });
  const one = await runAssistantOrchestrator({
    mode: "general", userMessage: "what apps are running?", runningApps: () => [app("simple-habit-tracker", 50978)]
  });
  assert.equal(one.strategy, "list");
  assert.equal(one.assistantMessage, "Running now (1):\n- simple-habit-tracker at http://localhost:50978");

  const none = await runAssistantOrchestrator({ mode: "general", userMessage: "is anything running?", runningApps: () => [] });
  assert.match(none.assistantMessage, /^No apps are running right now\./);
});

test("a delete that fails says what to do next", async () => {
  // Live: stopped, then deleted a fraction of a second later - "could not be
  // deleted", and the same request a minute later went through.
  const session = "round8-delete";
  const shared = {
    mode: "general" as const, sessionId: session,
    listApps: () => [{ name: "simple-habit-tracker", running: false, url: null }],
    deleteApp: () => false
  };
  const offer = await runAssistantOrchestrator({ ...shared, userMessage: "delete the simple-habit-tracker app" });
  assert.equal(offer.strategy, "confirm", offer.assistantMessage);
  const failed = await runAssistantOrchestrator({ ...shared, userMessage: "yes" });
  assert.match(failed.assistantMessage, /could not be deleted, so nothing was changed\./);
  assert.match(failed.assistantMessage, /ask again in a few seconds/);
});

test("a second rendering with the same title is kept beside the first, not over it", () => {
  // Live: a second "mockup of a login screen" replaced the first one's file.
  const first = saveRendering("Login Screen", "mockup", "<p>first</p>");
  const second = saveRendering("Login Screen", "mockup", "<p>second</p>");
  const third = saveRendering("Login Screen", "mockup", "<p>third</p>");

  assert.deepEqual([first.name, second.name, third.name], ["login-screen", "login-screen-2", "login-screen-3"]);
  const dir = path.join(testWorkspace, "renderings");
  assert.match(readFileSync(path.join(dir, "login-screen.html"), "utf8"), /first/, "the first is untouched");
  assert.ok(existsSync(path.join(dir, "login-screen-3.html")));
  assert.equal(listRenderings().length, 3);
});
