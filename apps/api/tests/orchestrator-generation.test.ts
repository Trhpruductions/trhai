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
  const received: Array<Record<string, unknown>> = [];

  return new Promise<{ server: Server; baseUrl: string; received: typeof received }>((resolve) => {
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk as Buffer));
      request.on("end", () => {
        response.writeHead(200, { "Content-Type": "application/json" });

        if (request.url?.startsWith("/api/tags")) {
          response.end(JSON.stringify({ models: [{ name: "llama3.2:latest" }] }));
          return;
        }

        if (chunks.length) {
          received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
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
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        received
      });
    });
  });
}

async function withFakeModel<T>(
  reply: string,
  run: (received: Array<Record<string, unknown>>) => Promise<T>
): Promise<T> {
  const { server, baseUrl, received } = await fakeOllama(reply);
  const previous = process.env.OLLAMA_BASE_URL;
  process.env.OLLAMA_BASE_URL = baseUrl;

  try {
    return await run(received);
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

test("a remember-then-ask turn reaches the model with the fact already known", async () => {
  // Caught live: "Remember that the server room door code is 4471. Then tell
  // me every door code I have saved." saved the fact and answered with a bare
  // "Saved." — the trailing request was never read. The fix routes this to
  // the agent and hands over what was just written, so the model does not
  // have to rediscover in its own search_memory call a fact that was written
  // in the very message it is answering.
  await withFakeModel("Saved, and it is the only door code you have on file.", async (received) => {
    const result = await runAssistantOrchestrator({
      mode: "general",
      userMessage: "Remember that the server room door code is 4471. Then tell me every door code I have saved.",
      memoryWrite: { available: true, saved: 1, savedBodies: ["the server room door code is 4471"] }
    });

    assert.equal(result.strategy, "generated");

    // The hand-over is stated in the user turn, not the system prompt — see
    // answerWithLocalModel's `question` construction.
    const firstRequest = received[0] as { messages: Array<{ role: string; content: string }> };
    const user = firstRequest.messages.find((message) => message.role === "user");
    assert.match(user?.content ?? "", /4471/, "the just-saved fact must reach the model");
    // "do not save it again" is load-bearing: without it, the model handed a
    // fact that was already saved sometimes called remember on it a second
    // time anyway, and reported a confusing failure when that redundant
    // write did not go through.
    assert.match(user?.content ?? "", /already.*saved memory/i);
    assert.match(user?.content ?? "", /do not save it again/i);
  });
});

test("an ordinary remember with nothing trailing stays the plain acknowledgement", async () => {
  // Must not regress into routing every remember statement to the model —
  // only ones that actually carry a second instruction.
  const result = await runAssistantOrchestrator({
    mode: "general",
    userMessage: "Remember that we standardized on Postgres",
    memoryWrite: { available: true, saved: 1, savedBodies: ["we standardized on Postgres"] }
  });

  assert.equal(result.strategy, "acknowledge");
  assert.match(result.assistantMessage, /Saved/i);
});

test("a build clarification merged across turns reaches the agent whole", async () => {
  // Caught live. "Build me something to help my business" got a clarifying
  // question, which is correct. The answer, "customers with email, phone and
  // company", was correctly merged by the composer into strategy "plan" with
  // buildRequest "Build me something to help my business. customers with
  // email, phone and company" — and the agent was then asked only
  // input.userMessage, the current turn alone, with no idea it was ever about
  // a build. It searched the user's documents for "customers" and reported
  // finding nothing. The merged buildRequest is what must reach the model,
  // not the bare current-turn message.
  await withFakeModel("Built it in the workspace.", async (received) => {
    const result = await runAssistantOrchestrator({
      mode: "general",
      userMessage: "customers with email, phone and company",
      history: [
        { role: "user", content: "Build me something to help my business." },
        {
          role: "assistant",
          content: "Before I build that: what should each record store?"
        }
      ]
    });

    assert.equal(result.strategy, "generated");

    const firstRequest = received[0] as { messages: Array<{ role: string; content: string }> };
    const user = firstRequest.messages.find((message) => message.role === "user");
    assert.match(user?.content ?? "", /Build me something to help my business/);
    assert.match(user?.content ?? "", /customers with email, phone and company/);
  });
});

test("an ordinary single-turn build request is unaffected by the merge path", async () => {
  // The fix above must not change anything when there is nothing to merge:
  // buildRequest and userMessage are the same string outside a refinement.
  await withFakeModel("Built it in the workspace.", async (received) => {
    await runAssistantOrchestrator({
      mode: "general",
      userMessage: "Build me an app to track invoices with a client name, amount, and due date."
    });

    const firstRequest = received[0] as { messages: Array<{ role: string; content: string }> };
    const user = firstRequest.messages.find((message) => message.role === "user");
    assert.match(user?.content ?? "", /^Build me an app to track invoices/);
  });
});

test("a create plan is told to call build_app, not plan_app", async () => {
  // Caught live, one step further than the merge fix above: understanding the
  // request correctly was not enough. Handed "Build me something to help my
  // business. customers with email, phone and company" with no further
  // instruction, the model chose plan_app — worked out what the app would
  // contain, correctly — then invented a description of a "Build screen"
  // with a "Plan" selector that does not exist, instead of building anything.
  // Told more politely which tool to use was not going to fix a model that
  // already had a correct tool available and picked a different one; naming
  // it outright removes the choice that goes wrong.
  await withFakeModel("Built it in the workspace.", async (received) => {
    await runAssistantOrchestrator({
      mode: "general",
      userMessage: "Build me an app to track invoices with a client name, amount, and due date."
    });

    const firstRequest = received[0] as { messages: Array<{ role: string; content: string }> };
    const user = firstRequest.messages.find((message) => message.role === "user");
    assert.match(user?.content ?? "", /Call build_app with this/);
    assert.match(user?.content ?? "", /[Nn]ot plan_app/);
  });
});

test("the build_app instruction is not stapled onto unrelated turns", async () => {
  // Scoped to isPlan && planTaskType === "create" specifically. A no-answer
  // turn reaches this same branch by a different door and must not carry an
  // instruction about a tool that has nothing to do with what was asked.
  await withFakeModel("Paris.", async (received) => {
    await runAssistantOrchestrator({ mode: "general", userMessage: "What is the capital of France?" });

    const firstRequest = received[0] as { messages: Array<{ role: string; content: string }> };
    const user = firstRequest.messages.find((message) => message.role === "user");
    assert.doesNotMatch(user?.content ?? "", /build_app/);
  });
});
