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

        response.end(JSON.stringify({ model: "llama3.2:latest", response: reply }));
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

test("a real build request still offers to build", async () => {
  // The fix above must not have removed the build offer everywhere: a "create"
  // plan is the one case where the deterministic path is kept.
  const result = await runAssistantOrchestrator({
    mode: "general",
    userMessage: "Build me an app to track invoices with a client name, amount, and due date."
  });

  assert.equal(result.strategy, "plan");
  assert.ok(result.buildRequest, "a create request should still carry a build request");
});
