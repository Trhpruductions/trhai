import test from "node:test";
import assert from "node:assert/strict";
import { ModelRouter } from "../src/services/modelRouter.js";

// modelRouter.ts is a thin layer over replyComposer.ts, which is thoroughly
// tested elsewhere — this covers the router's own logic instead of
// re-testing composeReply: which model label each mode reports, and how it
// normalizes memory context before scoring. Found during an audit pass: the
// file had no direct test at all, only indirect exercise through whichever
// other test happened to route through a given mode.

test("coding-family modes report the coding model", async () => {
  const router = new ModelRouter();

  for (const mode of ["build", "code", "debug", "research", "plan", "coding"] as const) {
    const reply = await router.generate({ mode, userMessage: "hello" });
    assert.equal(reply.model, "coding-core-v1", `mode "${mode}" should route to the coding model`);
  }
});

test("business and creator modes report their own models, general is the default", async () => {
  const router = new ModelRouter();

  assert.equal((await router.generate({ mode: "business", userMessage: "hello" })).model, "business-core-v1");
  assert.equal((await router.generate({ mode: "creator", userMessage: "hello" })).model, "creator-core-v1");
  assert.equal((await router.generate({ mode: "general", userMessage: "hello" })).model, "general-core-v1");
});

test("token counts are estimated from the real message and reply lengths", async () => {
  const router = new ModelRouter();
  const reply = await router.generate({ mode: "general", userMessage: "a".repeat(40) });

  // ceil(length / 4): a 40-char message is exactly 10, not a rough guess.
  assert.equal(reply.inputTokens, 10);
  assert.ok(reply.outputTokens >= 0);
});

test("an empty message costs zero input tokens, not a division artifact", async () => {
  const router = new ModelRouter();
  const reply = await router.generate({ mode: "general", userMessage: "" });

  assert.equal(reply.inputTokens, 0);
});

test("memory context missing id, pinned, or createdAt still reaches the composer", async () => {
  const router = new ModelRouter();

  // No id/pinned/createdAt on either entry — toComposerMemories must default
  // all three rather than pass through undefined and let scoring break.
  const reply = await router.generate({
    mode: "general",
    userMessage: "What does the deploy note say?",
    memoryContext: [{ title: "Deploy note", body: "Deploys go out on Fridays." }]
  });

  assert.equal(typeof reply.strategy, "string");
  assert.ok(reply.strategy.length > 0);
});
