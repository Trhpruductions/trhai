import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { runAssistantOrchestrator } from "../src/services/orchestrator.js";

/**
 * A stand-in Ollama that answers everything.
 *
 * These tests are about what the orchestrator does with a generated reply, not
 * about inference, so the model always succeeds and always says the same thing.
 */
function fakeOllama(reply: string) {
  return new Promise<{ server: Server; baseUrl: string }>((resolve) => {
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk as Buffer));
      request.on("end", () => {
        response.writeHead(200, { "Content-Type": "application/json" });

        if (request.url?.startsWith("/api/tags")) {
          response.end(JSON.stringify({ models: [{ name: "llama3.2:latest" }] }));
          return;
        }

        // The orchestrator drives the agent loop, which speaks /api/chat. The
        // older /api/generate shape is kept for anything still calling it.
        response.end(JSON.stringify(
          request.url?.startsWith("/api/chat")
            ? { model: "llama3.2:latest", message: { content: reply } }
            : { model: "llama3.2:latest", response: reply }
        ));
      });
    });

    server.listen(0, "127.0.0.1", () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    });
  });
}

async function withFakeModel<T>(reply: string, run: () => Promise<T>): Promise<T> {
  const { server, baseUrl } = await fakeOllama(reply);
  const previous = process.env.OLLAMA_BASE_URL;
  process.env.OLLAMA_BASE_URL = baseUrl;

  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = previous;
    server.close();
  }
}

test("an explanation answered by the model offers no build", async () => {
  // The deterministic path answers a plain question with a generic plan, which
  // the orchestrator discards in favour of the model. The discarded plan's
  // build request must go with it: "Explain what a mutex is" put a "Build this"
  // button under a two-sentence definition.
  await withFakeModel("A mutex lets one thread at a time touch a shared resource.", async () => {
    const result = await runAssistantOrchestrator({
      mode: "general",
      userMessage: "Explain what a mutex is in two sentences."
    });

    assert.equal(result.strategy, "generated");
    assert.equal(result.buildRequest, undefined);
  });
});

test("a generated reply is labelled as generated, with its model", async () => {
  await withFakeModel("Paris.", async () => {
    const result = await runAssistantOrchestrator({
      mode: "general",
      userMessage: "Explain what a REST API is."
    });

    assert.equal(result.strategy, "generated");
    assert.match(result.model, /llama3\.2/);
    // Nothing was quoted, so nothing may claim to be grounded.
    assert.deepEqual(result.groundedOn, []);
    assert.equal(result.groundedOnHistory, 0);
  });
});

test("a build request reaches the model so it can build", async () => {
  // This asserted "plan" and no longer should. A create request used to keep
  // the deterministic four-step plan, which made sense while a plan was the
  // best the app could do — and stopped making sense the moment build_app
  // existed, because keeping it meant "build me an app" returned a plan and
  // never called the tool that would have built the app.
  //
  // Driven by a fake model, not whichever Ollama happens to be running. This
  // test previously called the real one: it passed when nothing was listening
  // and took 97 seconds and failed when something was, which makes it a
  // measurement of the machine rather than of the code.
  await withFakeModel("Built it in the workspace.", async () => {
    const result = await runAssistantOrchestrator({
      mode: "general",
      userMessage: "Build me an app to track invoices with a client name, amount, and due date."
    });

    assert.equal(result.strategy, "generated");
    assert.match(result.model, /llama3\.2/);
  });
});

test("a build request still carries what to build when there is no model", async () => {
  // With nothing to generate an answer, the deterministic plan is still the
  // right reply, and the "Build this" control still needs its request text.
  const previous = process.env.OLLAMA_BASE_URL;
  // A port nothing is listening on, so availability fails fast and the
  // orchestrator falls back exactly as it would on a machine with no Ollama.
  process.env.OLLAMA_BASE_URL = "http://127.0.0.1:9";

  try {
    const result = await runAssistantOrchestrator({
      mode: "general",
      userMessage: "Build me an app to track invoices with a client name, amount, and due date."
    });

    assert.equal(result.strategy, "plan");
    assert.ok(result.buildRequest, "a create request must still carry a build request");
  } finally {
    if (previous === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = previous;
  }
});
