import test from "node:test";
import assert from "node:assert/strict";
import { fakeEngine } from "./helpers/fakeEngine.js";
import { runAssistantOrchestrator } from "../src/services/orchestrator.js";
import { withoutForgotten } from "../src/services/factWording.js";

// Forgetting has to reach the model too. Live, from the battery on
// 2026-10-18: "forget that my favourite colour is teal" deleted the memory,
// and "what is my favourite colour?" went to the model, which answered "Based
// on what you've shared, your favourite colour is teal" - read straight out
// of the conversation history the model was handed.

const transcript = [
  { role: "user" as const, content: "remember that my favourite colour is teal" },
  { role: "assistant" as const, content: "Saved. I'll use that as context from here on." },
  { role: "user" as const, content: "what is my favourite colour?" },
  { role: "assistant" as const, content: "Based on what you've told me:  - my favourite colour is teal" },
  { role: "user" as const, content: "write a file called battery-note.txt containing alpha bravo charlie" },
  { role: "assistant" as const, content: "I have written battery-note.txt." },
  { role: "user" as const, content: "forget that my favourite colour is teal" },
  { role: "assistant" as const, content: "This would delete the saved memory \"my favourite colour is teal\". Say yes to delete it, or no to keep it." },
  { role: "user" as const, content: "yes" },
  { role: "assistant" as const, content: "Deleted from memory: my favourite colour is teal" }
];
const forgotten = ["my favourite colour is teal"];

test("a forgotten fact leaves the history the model reads, with the replies that went with it", () => {
  const kept = withoutForgotten(transcript, forgotten);
  assert.equal(kept.some((turn) => /teal/i.test(turn.content)), false, JSON.stringify(kept));
  // What had nothing to do with it stays, in order.
  assert.deepEqual(kept.map((turn) => turn.content), [
    "what is my favourite colour?",
    "write a file called battery-note.txt containing alpha bravo charlie",
    "I have written battery-note.txt.",
    "yes"
  ]);
  // An older value of the same thing is the same fact.
  assert.deepEqual(withoutForgotten([{ role: "user", content: "my favourite colour is blue" }], forgotten), []);
  // Nothing forgotten, nothing changed.
  assert.equal(withoutForgotten(transcript, []), transcript);
});

test("after a forget, the question that goes to the model carries no trace of the fact", async () => {
  const engine = await fakeEngine({ reply: { message: { content: "I don't have that saved." } } });
  const previous = process.env.TRHAI_ENGINE_URL;
  process.env.TRHAI_ENGINE_URL = engine.baseUrl;
  try {
    const result = await runAssistantOrchestrator({
      mode: "general",
      sessionId: `forgotten-history-${Math.random().toString(16).slice(2)}`,
      userMessage: "what is my favourite colour?",
      history: transcript,
      forgottenFacts: forgotten
    });
    assert.ok(engine.chats.length > 0, `the model was asked (${result.strategy}: ${result.assistantMessage})`);
    for (const chat of engine.chats) {
      const sent = JSON.stringify(chat.messages);
      assert.doesNotMatch(sent, /teal/i, sent);
    }
    assert.doesNotMatch(result.assistantMessage, /teal/i);
  } finally {
    if (previous === undefined) delete process.env.TRHAI_ENGINE_URL;
    else process.env.TRHAI_ENGINE_URL = previous;
    await engine.close();
  }
});
