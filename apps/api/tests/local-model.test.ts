import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import {
  buildPrompt,
  checkAvailability,
  contextWindow,
  defaultContextTokens,
  generate,
  minimumContextTokens,
  modelOptions,
  noReplyWithin,
  pickModel,
  readLocalModelConfig,
  replyLimit,
  replyTooLong,
  unfinishedWithin,
  type LocalModelConfig, orderedCandidates } from "../src/services/localModel.js";

/**
 * A stand-in speaking Ollama's protocol.
 *
 * Ollama is not installed on the machine this was written on, so the client is
 * exercised against a server that answers the same shapes. Everything but the
 * inference itself is real: a socket, HTTP, JSON, timeouts.
 */
function fakeOllama(handler: (url: string, body: unknown) => { status: number; payload: unknown } | "hang") {
  return new Promise<{ server: Server; baseUrl: string }>((resolve) => {
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk as Buffer));
      request.on("end", () => {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
        const result = handler(request.url ?? "", body);
        if (result === "hang") return; // never answers, to exercise the timeout
        response.writeHead(result.status, { "Content-Type": "application/json" });
        response.end(JSON.stringify(result.payload));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function configFor(baseUrl: string, overrides: Partial<LocalModelConfig> = {}): LocalModelConfig {
  return { baseUrl, model: "llama3.2", modelFromEnv: true, timeoutMs: 2000, ...overrides };
}

test("configuration falls back to the usual local defaults", () => {
  const config = readLocalModelConfig({} as NodeJS.ProcessEnv);

  assert.equal(config.baseUrl, "http://127.0.0.1:11434");
  // Must match the head of preferredModels in localModel.ts. That list is
  // private, so this is coupled by hand: if the default is renamed again,
  // this is the assertion that says so.
  assert.equal(config.model, "vexora:latest");
  assert.ok(config.timeoutMs >= 10000, "local inference is slow; a short timeout abandons live replies");
});

test("configuration is overridable and a trailing slash does not break the URL", () => {
  const config = readLocalModelConfig({
    OLLAMA_BASE_URL: "http://192.168.1.5:11434/",
    OLLAMA_MODEL: "mistral",
    OLLAMA_TIMEOUT_MS: "1234"
  } as NodeJS.ProcessEnv);

  assert.equal(config.baseUrl, "http://192.168.1.5:11434");
  assert.equal(config.model, "mistral");
  assert.equal(config.timeoutMs, 1234);
});

test("the context window defaults to one the assistant's prompt fits in", () => {
  // Ollama's own default is 4,096 tokens, and the prompt is bigger than that:
  // it was cut from the front on nearly every turn, rules first.
  assert.equal(readLocalModelConfig({} as NodeJS.ProcessEnv).contextTokens, defaultContextTokens);
  assert.ok(defaultContextTokens >= 16384);
  assert.equal(contextWindow({}), defaultContextTokens, "a config built by hand gets it too");
});

test("the context window can be set, but never below what the prompt needs", () => {
  const read = (value: string) => readLocalModelConfig({ OLLAMA_NUM_CTX: value } as NodeJS.ProcessEnv).contextTokens;

  assert.equal(read("32768"), 32768);
  // Smaller than the prompt is never what was meant: raised, not obeyed.
  assert.equal(read("4096"), minimumContextTokens);
  // Not a number at all is ignored rather than sent to the model as NaN.
  assert.equal(read("lots"), defaultContextTokens);
  assert.equal(read("0"), defaultContextTokens);
  assert.deepEqual(modelOptions({ contextTokens: 20000.7 }), { num_ctx: 20000, num_predict: 20000 });
});

test("a reply may be as long as the window, and no longer", () => {
  // Not below it: the app accepts a 64 KB file from the model, which is more
  // tokens than the window holds. Not above it: by then the question has been
  // pushed out of the model's view. See replyLimit.
  assert.equal(replyLimit({}), defaultContextTokens);
  assert.equal(replyLimit({ contextTokens: 32768 }), 32768, "a larger window allows a longer reply");
  assert.equal(replyLimit({ contextTokens: 4096 }), minimumContextTokens, "and follows the window's own floor");
  assert.equal(modelOptions({}).num_predict, modelOptions({}).num_ctx);
});

test("a timeout and a cut-off reply are each said as what happened", () => {
  assert.equal(noReplyWithin({ model: "qwen2.5:3b", timeoutMs: 180000 }), "qwen2.5:3b did not reply within 180 s.");
  assert.equal(noReplyWithin({ model: "qwen2.5:3b", timeoutMs: 300 }), "qwen2.5:3b did not reply within 300 ms.");
  // A streamed reply that had begun: its words were on screen, so not "did not reply".
  assert.equal(unfinishedWithin({ model: "qwen2.5:3b", timeoutMs: 180000 }), "qwen2.5:3b did not finish its reply within 180 s.");
  assert.equal(replyTooLong({ model: "qwen2.5:3b" }),
    "The reply from qwen2.5:3b ran past the length limit (16,384 tokens) without finishing.");
});

test("no server at all is reported as unavailable, not as an error", async () => {
  // Absence is the normal case; it must never look like a fault.
  const result = await checkAvailability(configFor("http://127.0.0.1:1", { timeoutMs: 500 }));

  assert.equal(result.available, false);
  if (result.available) return;
  assert.match(result.reason, /nothing is listening/);
});

test("a running server with the model pulled is available", async () => {
  const { server, baseUrl } = await fakeOllama(() => ({
    status: 200,
    payload: { models: [{ name: "llama3.2:latest" }, { name: "mistral:latest" }] }
  }));

  try {
    const result = await checkAvailability(configFor(baseUrl));
    assert.equal(result.available, true);
    if (!result.available) return;
    // Pulled as "llama3.2", reported as "llama3.2:latest".
    assert.equal(result.model, "llama3.2:latest");
  } finally {
    server.close();
  }
});

test("another installed model is used rather than refusing outright", async () => {
  // This used to report unavailable, and the assistant went dark whenever the
  // configured model was not the one that happened to be pulled. A model the
  // user did not name is still a working assistant, and which model answered
  // is shown on every reply — so falling back is visible, not silent.
  const { server, baseUrl } = await fakeOllama(() => ({
    status: 200,
    payload: { models: [{ name: "codellama:latest" }] }
  }));

  try {
    const result = await checkAvailability(configFor(baseUrl));
    assert.equal(result.available, true);
    if (!result.available) return;
    assert.equal(result.model, "codellama:latest");
  } finally {
    server.close();
  }
});

test("a server with nothing pulled says how to pull it", async () => {
  const { server, baseUrl } = await fakeOllama(() => ({ status: 200, payload: { models: [] } }));

  try {
    const result = await checkAvailability(configFor(baseUrl));
    assert.equal(result.available, false);
    if (result.available) return;
    assert.match(result.reason, /ollama pull llama3\.2/);
  } finally {
    server.close();
  }
});

test("a generated answer comes back with the model that produced it", async () => {
  const { server, baseUrl } = await fakeOllama((url, body) => {
    assert.equal(url, "/api/generate");
    const request = body as { model: string; stream: boolean; prompt: string; options?: { num_ctx?: number; num_predict?: number } };
    assert.equal(request.stream, false);
    assert.match(request.prompt, /Question: What is the capital of France\?/);
    // The same window as the agent's requests, so switching between them does
    // not make Ollama reload the model.
    assert.equal(request.options?.num_ctx, defaultContextTokens);
    // And the same reply limit: authoring and summaries go this way too.
    assert.equal(request.options?.num_predict, defaultContextTokens);
    return { status: 200, payload: { model: "llama3.2:latest", response: "  Paris.  " } };
  });

  try {
    const result = await generate(configFor(baseUrl), { question: "What is the capital of France?", context: [] });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.text, "Paris.");
    assert.equal(result.model, "llama3.2:latest");
  } finally {
    server.close();
  }
});

test("an empty reply is a failure, not an empty answer", async () => {
  // Returning "" would render as the assistant saying nothing at all.
  const { server, baseUrl } = await fakeOllama(() => ({ status: 200, payload: { response: "   " } }));

  try {
    const result = await generate(configFor(baseUrl), { question: "anything", context: [] });
    assert.equal(result.ok, false);
  } finally {
    server.close();
  }
});

test("a reply cut off at the length limit is a failure that says so, not a shorter answer", async () => {
  // For app authoring a cut-off reply is worse than a short one: the last file
  // stops mid-line and can still pass for a whole one. The same words twice,
  // so what decides is Ollama's done_reason.
  const words = "=== FILE: README.md\n# Snake\n\nUse the arrow keys to";
  let doneReason = "length";
  const { server, baseUrl } = await fakeOllama(() => ({
    status: 200, payload: { model: "llama3.2:latest", response: words, done: true, done_reason: doneReason }
  }));

  try {
    const cut = await generate(configFor(baseUrl), { question: "anything", context: [], rawPrompt: "write an app" });
    assert.equal(cut.ok, false);
    if (cut.ok) return;
    assert.equal(cut.reason, "The reply from llama3.2 ran past the length limit (16,384 tokens) without finishing.");

    doneReason = "stop";
    const finished = await generate(configFor(baseUrl), { question: "anything", context: [], rawPrompt: "write an app" });
    assert.equal(finished.ok, true);
    if (finished.ok) assert.equal(finished.text, words);
  } finally {
    server.close();
  }
});

test("a server that never replies gives up rather than hanging the request", async () => {
  const { server, baseUrl } = await fakeOllama(() => "hang");

  try {
    const result = await generate(configFor(baseUrl, { timeoutMs: 300 }), { question: "anything", context: [] });
    assert.equal(result.ok, false);
    if (result.ok) return;
    // Said as what happened: the model was there and did not answer in time.
    assert.equal(result.reason, "llama3.2 did not reply within 300 ms.");
  } finally {
    server.close();
  }
});

test("a request the turn stops is let go of at once, and said as stopped rather than as no reply", async () => {
  // App authoring and a long summary run during a turn, for minutes. Stop has
  // to end the request - Ollama stops writing when its asker lets go - and it
  // is not the model failing to answer in time: the time had not run out.
  let asked = 0;
  let markArrived!: () => void;
  const arrived = new Promise<void>((resolve) => { markArrived = resolve; });
  let markLetGo!: () => void;
  const letGo = new Promise<void>((resolve) => { markLetGo = resolve; });
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      asked += 1;
      response.on("close", () => {
        if (!response.writableEnded) markLetGo();
      });
      markArrived();
      // ...and never answered.
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const stop = new AbortController();
    // Five seconds, so the time limit cannot be what ends it below.
    const answering = generate(configFor(baseUrl, { timeoutMs: 5000 }), { question: "anything", context: [] }, fetch, stop.signal);
    await arrived;
    const stoppedAt = Date.now();
    stop.abort();
    assert.deepEqual(await answering, { ok: false, reason: "Stopped before it finished." });
    assert.ok(Date.now() - stoppedAt < 1000, "ended by Stop, not by the time limit");
    assert.equal(await Promise.race([letGo.then(() => "let go"), delay(2000).then(() => "held")]), "let go",
      "the request was let go of, which is what stops the model");

    // A turn already stopped asks nothing at all.
    const again = await generate(configFor(baseUrl, { timeoutMs: 5000 }), { question: "anything", context: [] }, fetch, stop.signal);
    assert.deepEqual(again, { ok: false, reason: "Stopped before it finished." });
    assert.equal(asked, 1, "the model was not asked again");
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("an error status is reported rather than treated as an answer", async () => {
  const { server, baseUrl } = await fakeOllama(() => ({ status: 500, payload: { error: "boom" } }));

  try {
    const result = await generate(configFor(baseUrl), { question: "anything", context: [] });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /500/);
  } finally {
    server.close();
  }
});

test("the prompt tells the model to admit ignorance and not invent specifics", () => {
  // A local model confabulates readily, and the rest of this app never presents
  // a guess as a fact.
  const prompt = buildPrompt({ question: "What is our refund policy?", context: [] });

  assert.match(prompt, /say so plainly rather than guessing/i);
  assert.match(prompt, /Do not invent specifics/i);
});

test("known facts are offered as context, and only when there are some", () => {
  const withContext = buildPrompt({
    question: "Which database do we use?",
    context: ["we standardized on Postgres"]
  });
  assert.match(withContext, /- we standardized on Postgres/);
  assert.match(withContext, /Use those only if they are relevant/);

  const withoutContext = buildPrompt({ question: "Which database do we use?", context: [] });
  assert.doesNotMatch(withoutContext, /Things the user has told you/);
});

test("an explicitly configured model always wins", () => {
  // This picks a good default; it must never overrule a deliberate choice.
  assert.equal(pickModel("llama3.2", ["llama3.1:8b", "llama3.2:latest"]), "llama3.2:latest");
  assert.equal(pickModel("mistral", ["llama3.1:8b", "mistral:latest"]), "mistral:latest");
});

test("the most preferred installed model wins when the configured one is absent", () => {
  // The tools raised the ceiling on capability and the model became the limit:
  // a weaker model answers from its own knowledge where it should have looked
  // something up. The preference list is what expresses that ranking, so the
  // higher-ranked installed model must win even though both are available.
  // qwen2.5 outranks llama3.2 in preferredModels.
  assert.equal(pickModel("nonexistent", ["llama3.2:latest", "qwen2.5:latest"]), "qwen2.5:latest");
});

test("a model that is installed beats none at all", () => {
  // An assistant running on some model is more use than one that refuses
  // because it did not find its first choice.
  assert.equal(pickModel("nonexistent", ["phi3:latest"]), "phi3:latest");
});

test("nothing installed means nothing to pick", () => {
  assert.equal(pickModel("llama3.2", []), null);
});

test("a bare name matches the tagged form Ollama reports", () => {
  assert.equal(pickModel("llama3.2", ["llama3.2:latest"]), "llama3.2:latest");
});

test("the built-in default does not block a better model", () => {
  // The bug this exists to stop: with OLLAMA_MODEL unset the config still
  // carries a model name, and that name is often itself installed — so it
  // looked like a deliberate choice and a higher-ranked model sitting next to
  // it was never picked up. Pulling a better model changed nothing at all.
  //
  // Written with a default that is *not* the top preference, because that is
  // the only shape in which the bug can occur at all.
  assert.equal(
    pickModel("llama3.2", ["llama3.2:latest", "qwen2.5:latest"], false),
    "qwen2.5:latest"
  );
});

test("a model named in the environment still wins", () => {
  assert.equal(
    pickModel("llama3.2", ["llama3.2:latest", "qwen2.5:latest"], true),
    "llama3.2:latest"
  );
});

test("the config records whether the model was actually chosen", () => {
  assert.equal(readLocalModelConfig({} as NodeJS.ProcessEnv).modelFromEnv, false);
  assert.equal(
    readLocalModelConfig({ OLLAMA_MODEL: "mistral" } as NodeJS.ProcessEnv).modelFromEnv,
    true
  );
});

test("the default timeout allows for a cold model load", () => {
  // 45s was enough for a warm model and not for the first request after a
  // launch, where several gigabytes have to be read off disk first. That
  // request was abandoned mid-load and reported as having no answer, which
  // looks like a broken feature rather than a slow start.
  const config = readLocalModelConfig({} as NodeJS.ProcessEnv);
  assert.ok(config.timeoutMs >= 120000, `too short for a cold start: ${config.timeoutMs}ms`);
});

test("the timeout can still be set explicitly", () => {
  const config = readLocalModelConfig({ OLLAMA_TIMEOUT_MS: "5000" } as NodeJS.ProcessEnv);
  assert.equal(config.timeoutMs, 5000);
});

test("candidates are ordered best first, with the named model at the front", () => {
  // Named model first, then the preference list, then anything unranked.
  assert.deepEqual(
    orderedCandidates("llama3.2", ["phi3:latest", "qwen2.5:latest", "llama3.2:latest"], true),
    ["llama3.2:latest", "qwen2.5:latest", "phi3:latest"]
  );
});

test("without a named model the preference list leads", () => {
  // qwen2.5 outranks llama3.2, and phi3 is unranked so it goes last.
  assert.deepEqual(
    orderedCandidates("llama3.2", ["phi3:latest", "llama3.2:latest", "qwen2.5:latest"], false),
    ["qwen2.5:latest", "llama3.2:latest", "phi3:latest"]
  );
});

test("an unranked model is still a candidate", () => {
  // It beats no answer, so it goes last rather than being dropped.
  assert.deepEqual(orderedCandidates("missing", ["phi3:latest"], true), ["phi3:latest"]);
});

test("nothing installed yields no candidates", () => {
  assert.deepEqual(orderedCandidates("llama3.2", [], true), []);
});

test("the larger llama is preferred over the smaller one", () => {
  // The bug this list had: it named llama3.2 and never llama3.1, so on a
  // machine with both it chose the 3B over the 8B - the exact opposite of what
  // the note on the list says it is for. Found live, after the two preferred
  // models were no longer installed and the fallback became the real choice.
  assert.equal(pickModel("gone:latest", ["llama3.2:latest", "llama3.1:8b"], true), "llama3.1:8b");
  assert.equal(orderedCandidates("gone:latest", ["llama3.2:latest", "llama3.1:8b"], true)[0], "llama3.1:8b");
});

test("a coding model outranks both general ones", () => {
  assert.equal(
    pickModel("gone:latest", ["llama3.2:latest", "llama3.1:8b", "qwen2.5-coder:7b"], true),
    "qwen2.5-coder:7b"
  );
});

test("a model the user named still wins over the preference list", () => {
  // The list picks a good default; it must not overrule a real choice.
  assert.equal(pickModel("llama3.2:latest", ["llama3.2:latest", "llama3.1:8b"], true), "llama3.2:latest");
});

test("a configured model that is not installed falls through to the list", () => {
  // The live situation: .env pinned qwen2.5-coder:7b after it had been removed.
  assert.equal(pickModel("qwen2.5-coder:7b", ["llama3.2:latest", "llama3.1:8b"], true), "llama3.1:8b");
});
