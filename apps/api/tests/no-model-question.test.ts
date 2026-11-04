import test from "node:test";
import assert from "node:assert/strict";
import { runAssistantOrchestrator } from "../src/services/orchestrator.js";

// With no model, a plain question that nothing saved answers used to get "I don't have anything
// saved that answers that yet" - true, and not the reason. The reason is the missing model.

test("with no model, a question nothing saved answers says the model is missing, not that notes are", async () => {
  const result = await runAssistantOrchestrator({ mode: "general", userMessage: "What is the capital of France?" });
  assert.equal(result.strategy, "failed", result.assistantMessage);
  assert.match(result.assistantMessage, /^I couldn't answer that just now\. No local model/);
  assert.match(result.assistantMessage, /Nothing saved on this PC answers it either - tell me and I'll keep it\./);
  assert.doesNotMatch(result.assistantMessage, /anything saved that answers that yet/);
});

test("a greeting, and a question a saved fact answers, are not touched by it", async () => {
  const hello = await runAssistantOrchestrator({ mode: "general", userMessage: "hello" });
  assert.notEqual(hello.strategy, "failed", hello.assistantMessage);
  const fact = { id: "m1", title: "Server", body: "The server restarts at 4am every night", pinned: false, createdAt: "2026-11-04T00:00:00.000Z" };
  const answered = await runAssistantOrchestrator({ mode: "general", userMessage: "When does the server restart?", memoryContext: [fact] });
  assert.match(answered.assistantMessage, /4am/);
  assert.notEqual(answered.strategy, "failed", answered.assistantMessage);
});
