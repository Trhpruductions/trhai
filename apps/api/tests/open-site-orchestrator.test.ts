import test from "node:test";
import assert from "node:assert/strict";
import { fakeEngine } from "./helpers/fakeEngine.js";
import { runAssistantOrchestrator } from "../src/services/orchestrator.js";
import type { OpenResult } from "../src/services/openInBrowser.js";

// "Open spotify.com, and stream all the songs from the band Shadows of Ruin" was answered, on a PC
// whose model did not take it, with four lines about clarifying an end state: the composer's generic
// plan, shown as the answer. The first half of this file is the request being done; the second is
// what is said when a request is one nothing could do.

const screenshot = "open spotify.com, and stream all the songs from the band Shadows of Ruin";

/** Stands in for the browser: records the addresses it is asked to open, and opens nothing. */
function browser(result: OpenResult = { ok: true }) {
  const opened: string[] = [];
  return { opened, openUrl: async (url: string) => { opened.push(url); return result; } };
}

async function withEngine<T>(reply: { message: { content: string } }, run: () => Promise<T>): Promise<T> {
  const engine = await fakeEngine({ reply });
  const previous = process.env.TRHAI_ENGINE_URL;
  process.env.TRHAI_ENGINE_URL = engine.baseUrl;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.TRHAI_ENGINE_URL;
    else process.env.TRHAI_ENGINE_URL = previous;
    await engine.close();
  }
}

test("the request from the screenshot opens Spotify's search for the band, with no model running", async () => {
  const stand = browser();
  const result = await runAssistantOrchestrator({ mode: "general", userMessage: screenshot, openUrl: stand.openUrl });
  assert.equal(result.strategy, "open", result.assistantMessage);
  assert.deepEqual(stand.opened, ["https://open.spotify.com/search/Shadows%20of%20Ruin"]);
  assert.match(result.assistantMessage, /Opened Spotify's search for "Shadows of Ruin" in your browser\./);
  assert.match(result.assistantMessage, /can't press play for you/);
  assert.doesNotMatch(result.assistantMessage, /Clarify the end state|highest-impact/);
});

test("a page named by its address is opened and said to be", async () => {
  const stand = browser();
  const result = await runAssistantOrchestrator({ mode: "general", userMessage: "go to github.com", openUrl: stand.openUrl });
  assert.equal(result.strategy, "open");
  assert.deepEqual(stand.opened, ["https://github.com/"]);
  assert.equal(result.assistantMessage, "Opened github.com in your browser.");
});

test("when the browser will not open, the reply says so and gives the address", async () => {
  const stand = browser({ ok: false, reason: "the system would not start the browser (spawn EPERM)." });
  const result = await runAssistantOrchestrator({ mode: "general", userMessage: screenshot, openUrl: stand.openUrl });
  assert.equal(result.strategy, "failed");
  assert.match(result.assistantMessage, /I couldn't open Spotify: the system would not start the browser \(spawn EPERM\)\./);
  assert.match(result.assistantMessage, /The address is https:\/\/open\.spotify\.com\/search\/Shadows%20of%20Ruin/);
});

test("a schedule firing on a timer opens no window", async () => {
  const stand = browser();
  const result = await runAssistantOrchestrator({ mode: "general", userMessage: "open github.com", unattended: true, openUrl: stand.openUrl });
  assert.deepEqual(stand.opened, [], "nobody is there to see it");
  assert.notEqual(result.strategy, "open");
});

test("a sentence that only mentions a site is not an order to open it", async () => {
  for (const message of ["what is spotify.com?", "how do I open spotify.com in a script?", "open notes.txt"]) {
    const stand = browser();
    const result = await runAssistantOrchestrator({ mode: "general", userMessage: message, openUrl: stand.openUrl });
    assert.deepEqual(stand.opened, [], message);
    assert.notEqual(result.strategy, "open", message);
  }
});

test("with no stand-in the real launcher is reached and refuses under the test setting, so no test can open a browser", async () => {
  const result = await runAssistantOrchestrator({ mode: "general", userMessage: "open github.com" });
  assert.equal(result.strategy, "failed");
  assert.match(result.assistantMessage, /switched off here \(TRHAI_OPEN_BROWSER=off\)/);
});

// ---- When nothing could take the request ---------------------------------------------------------

test("with no model, a request that is not for a plan is told so instead of being given one", async () => {
  const result = await runAssistantOrchestrator({ mode: "general", userMessage: "Explain what a REST API is." });
  assert.equal(result.strategy, "failed", result.assistantMessage);
  assert.doesNotMatch(result.assistantMessage, /Clarify the end state|highest-impact|smallest useful piece/);
  assert.match(result.assistantMessage, /^I couldn't answer that just now\. No local model/);
  assert.match(result.assistantMessage, /Nothing was changed, and I did not make a plan in its place\./);
  assert.match(result.assistantMessage, /Try again in a moment/);
});

test("the same goes for an order the app has no handler for, which is what the screenshot's sentence is once it is not opened", async () => {
  const result = await runAssistantOrchestrator({ mode: "general", userMessage: "reorganise my desk photos into albums by the person in them" });
  assert.equal(result.strategy, "failed", result.assistantMessage);
  assert.doesNotMatch(result.assistantMessage, /Clarify the end state/);
});

test("when every installed model comes back with nothing, that is said, with the reason", async () => {
  await withEngine({ message: { content: "" } }, async () => {
    const result = await runAssistantOrchestrator({ mode: "general", userMessage: "Explain what a mutex is in two sentences." });
    assert.equal(result.strategy, "failed", result.assistantMessage);
    assert.match(result.assistantMessage, /None of the installed models could take it \(tried llama3\.2:latest\)/);
    assert.doesNotMatch(result.assistantMessage, /Clarify the end state/);
  });
});

test("when the engine runs but has no model, the reply says to install one and does not say to try again", async () => {
  const engine = await fakeEngine({ models: [] });
  const previous = process.env.TRHAI_ENGINE_URL;
  process.env.TRHAI_ENGINE_URL = engine.baseUrl;
  try {
    const result = await runAssistantOrchestrator({ mode: "general", userMessage: "Explain what a mutex is in two sentences." });
    assert.equal(result.strategy, "failed", result.assistantMessage);
    assert.match(result.assistantMessage, /has no model to answer with\. Install one in Settings/);
    assert.doesNotMatch(result.assistantMessage, /Try again in a moment/, "waiting will not install a model");
  } finally {
    if (previous === undefined) delete process.env.TRHAI_ENGINE_URL;
    else process.env.TRHAI_ENGINE_URL = previous;
    await engine.close();
  }
});

test("a request for a plan is still given one when there is no model", async () => {
  const result = await runAssistantOrchestrator({ mode: "general", userMessage: "plan my week" });
  assert.equal(result.strategy, "plan", result.assistantMessage);
  assert.match(result.assistantMessage, /Clarify the end state/);
});

test("a request with its own kind of plan keeps it when there is no model", async () => {
  const result = await runAssistantOrchestrator({ mode: "general", userMessage: "fix the flaky login test" });
  assert.equal(result.strategy, "plan", result.assistantMessage);
  assert.match(result.assistantMessage, /Reproduce/);
});

test("a model that answers is still what answers", async () => {
  await withEngine({ message: { content: "A mutex lets one thread at a time touch a shared resource." } }, async () => {
    const result = await runAssistantOrchestrator({ mode: "general", userMessage: "Explain what a mutex is in two sentences." });
    assert.equal(result.strategy, "generated");
    assert.match(result.assistantMessage, /mutex lets one thread/);
  });
});
