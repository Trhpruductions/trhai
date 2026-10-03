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
  defaultModel,
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
import { defaultEnginePort } from "../src/services/modelEngine.js";
import { completionBody, fakeWindow, modelsBody } from "./helpers/fakeEngine.js";

/**
 * A stand-in speaking the model engine's protocol, one answer per request.
 *
 * No engine has to be installed where this runs: the client is exercised
 * against a server that answers the same shapes. Everything but the inference
 * itself is real: a socket, HTTP, JSON, timeouts.
 */
function standIn(handler: (url: string, body: unknown) => { status: number; payload: unknown } | "hang") {
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

  // TRH AI's own engine, on this PC, on its own port.
  assert.equal(config.baseUrl, `http://127.0.0.1:${defaultEnginePort}`);
  // The head of preferredModels in localModel.ts: the model the assistant was
  // measured with.
  assert.equal(config.model, defaultModel);
  assert.equal(defaultModel, "qwen2.5-coder");
  assert.ok(config.timeoutMs >= 10000, "local inference is slow; a short timeout abandons live replies");
});

test("configuration is overridable and a trailing slash does not break the URL", () => {
  const config = readLocalModelConfig({
    TRHAI_ENGINE_URL: "http://192.168.1.5:8080/",
    TRHAI_MODEL: "mistral",
    TRHAI_MODEL_TIMEOUT_MS: "1234"
  } as NodeJS.ProcessEnv);

  assert.equal(config.baseUrl, "http://192.168.1.5:8080");
  assert.equal(config.model, "mistral");
  assert.equal(config.timeoutMs, 1234);
  assert.equal(readLocalModelConfig({ TRHAI_ENGINE_PORT: "4555" } as NodeJS.ProcessEnv).baseUrl, "http://127.0.0.1:4555");
});

test("a model named in a .env written when the models were Ollama's is still the one asked for", () => {
  // The setting was OLLAMA_MODEL, and its value "name:size". Both are still
  // read, so an existing .env keeps its model through the change of engine.
  const old = readLocalModelConfig({ OLLAMA_MODEL: "qwen2.5-coder:7b" } as NodeJS.ProcessEnv);
  assert.equal(old.model, "qwen2.5-coder:7b");
  assert.equal(old.modelFromEnv, true);
  assert.equal(pickModel(old.model, ["qwen2.5-3b", "qwen2.5-coder-7b", "qwen3-8b"], old.modelFromEnv), "qwen2.5-coder-7b");
  // The new name wins when both are set.
  assert.equal(readLocalModelConfig({ OLLAMA_MODEL: "qwen2.5:3b", TRHAI_MODEL: "qwen3-8b" } as NodeJS.ProcessEnv).model, "qwen3-8b");
});

test("the context window defaults to one the assistant's prompt fits in", () => {
  // Stands in until the engine says what it gave the model. Under Ollama the
  // default was 4,096 tokens, and the prompt is bigger than that:
  // it was cut from the front on nearly every turn, rules first.
  assert.equal(readLocalModelConfig({} as NodeJS.ProcessEnv).contextTokens, defaultContextTokens);
  assert.ok(defaultContextTokens >= 16384);
  assert.equal(contextWindow({}), defaultContextTokens, "a config built by hand gets it too");
});

test("the context window can be set, but never below what the prompt needs", () => {
  const read = (value: string) => readLocalModelConfig({ TRHAI_CONTEXT_TOKENS: value } as NodeJS.ProcessEnv).contextTokens;

  assert.equal(read("32768"), 32768);
  // Smaller than the prompt is never what was meant: raised, not obeyed.
  assert.equal(read("4096"), minimumContextTokens);
  // Not a number at all is ignored rather than sent to the model as NaN.
  assert.equal(read("lots"), defaultContextTokens);
  assert.equal(read("0"), defaultContextTokens);
  // What a request carries is the reply limit alone: the engine fixed the
  // window when it loaded the model.
  assert.deepEqual(modelOptions({ contextTokens: 20000.7 }), { max_tokens: 20000 });
});

test("a reply may be as long as the window, and no longer", () => {
  // Not below it: the app accepts a 64 KB file from the model, which is more
  // tokens than the window holds. Not above it: by then the question has been
  // pushed out of the model's view. See replyLimit.
  assert.equal(replyLimit({}), defaultContextTokens);
  assert.equal(replyLimit({ contextTokens: 32768 }), 32768, "a larger window allows a longer reply");
  assert.equal(replyLimit({ contextTokens: 4096 }), minimumContextTokens, "and follows the window's own floor");
  assert.equal(modelOptions({}).max_tokens, contextWindow({}));
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

test("a running engine with the model in it is available", async () => {
  const { server, baseUrl } = await standIn(() => ({
    status: 200,
    payload: modelsBody(["llama3.2:latest", "mistral:latest"])
  }));

  try {
    const result = await checkAvailability(configFor(baseUrl));
    assert.equal(result.available, true);
    if (!result.available) return;
    // Asked for as "llama3.2", listed as "llama3.2:latest": the same model.
    assert.equal(result.model, "llama3.2:latest");
  } finally {
    server.close();
  }
});

test("another installed model is used rather than refusing outright", async () => {
  // This used to report unavailable, and the assistant went dark whenever the
  // configured model was not the one that happened to be installed. A model the
  // user did not name is still a working assistant, and which model answered
  // is shown on every reply — so falling back is visible, not silent.
  const { server, baseUrl } = await standIn(() => ({
    status: 200,
    payload: modelsBody(["codellama:latest"])
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

test("an engine with no model in it says where to put one", async () => {
  const { server, baseUrl } = await standIn(() => ({ status: 200, payload: modelsBody([]) }));

  try {
    const result = await checkAvailability(configFor(baseUrl));
    assert.equal(result.available, false);
    if (result.available) return;
    assert.match(result.reason, /has no model to answer with/);
    assert.match(result.reason, /Put a \.gguf model file in .*models/);
    assert.doesNotMatch(result.reason, /ollama/i);
  } finally {
    server.close();
  }
});

test("the vision model is not one that answers a conversation", async () => {
  // It answers about images, on its own route. Listed alone, there is nothing
  // to chat with; listed beside a chat model, it is not among the candidates.
  const only = await standIn(() => ({ status: 200, payload: modelsBody(["qwen2.5-vl-3b"], { vision: ["qwen2.5-vl-3b"] }) }));
  const both = await standIn(() => ({ status: 200, payload: modelsBody(["qwen2.5-vl-3b", "qwen3-8b"], { vision: ["qwen2.5-vl-3b"] }) }));
  try {
    assert.equal((await checkAvailability(configFor(only.baseUrl))).available, false);
    const result = await checkAvailability(configFor(both.baseUrl));
    assert.deepEqual(result, { available: true, model: "qwen3-8b", installedModels: ["qwen3-8b"] });
  } finally {
    only.server.close();
    both.server.close();
  }
});

test("an engine that answers with an error is said to have, with its status", async () => {
  const { server, baseUrl } = await standIn(() => ({ status: 503, payload: { error: { message: "Loading" } } }));
  try {
    const result = await checkAvailability(configFor(baseUrl));
    assert.equal(result.available, false);
    if (!result.available) assert.equal(result.reason, `The model engine answered 503 at ${baseUrl}.`);
  } finally {
    server.close();
  }
});

/** A stand-in engine with one model, llama3.2:latest, loaded; each chat request is answered as `chat` says. */
const withModel = (chat: (body: unknown) => { status: number; payload: unknown } | "hang", window = fakeWindow) =>
  standIn((url, body) => (url === "/models" ? { status: 200, payload: modelsBody(["llama3.2:latest"], { window }) } : chat(body)));

test("a generated answer comes back with the model that produced it", async () => {
  const { server, baseUrl } = await standIn((url, body) => {
    if (url === "/models") return { status: 200, payload: modelsBody(["llama3.2:latest"]) };
    assert.equal(url, "/v1/chat/completions");
    const request = body as { model: string; stream: boolean; messages: Array<{ role: string; content: string }>; max_tokens?: number };
    // Asked for by the engine's own name for it, not the setting's.
    assert.equal(request.model, "llama3.2:latest");
    assert.equal(request.stream, false);
    // The prompt as one user turn; the engine wraps it in the model's own template.
    assert.equal(request.messages.length, 1);
    assert.equal(request.messages[0].role, "user");
    assert.match(request.messages[0].content, /Question: What is the capital of France\?/);
    // No reply limit of its own: the engine stops a reply when the model's
    // window is full, and a whole application is written through here.
    assert.equal(request.max_tokens, undefined);
    return { status: 200, payload: completionBody("llama3.2:latest", { message: { content: "  Paris.  " } }) };
  });

  try {
    const result = await generate(configFor(baseUrl), { question: "What is the capital of France?", context: [] });
    assert.deepEqual(result, { ok: true, text: "Paris.", model: "llama3.2:latest" });
  } finally {
    server.close();
  }
});

test("a whole reply is asked of the engine's name for the model, however the setting spells it", async () => {
  // Found before it shipped: a summary sent the name exactly as the .env had
  // it - "qwen2.5-coder:7b", from when the models were Ollama's - and the
  // engine, which knows the model as qwen2.5-coder-7b, answered that there is
  // no such model. Chat turns were fine: they asked the engine first.
  const asked: string[] = [];
  const { server, baseUrl } = await standIn((url, body) => {
    if (url === "/models") return { status: 200, payload: modelsBody(["qwen2.5-3b", "qwen2.5-coder-7b", "qwen3-8b"]) };
    const model = (body as { model: string }).model;
    asked.push(model);
    // As the engine answers a name it does not know.
    if (!["qwen2.5-3b", "qwen2.5-coder-7b", "qwen3-8b"].includes(model)) {
      return { status: 400, payload: { error: { code: 400, message: `model '${model}' not found`, type: "invalid_request_error" } } };
    }
    return { status: 200, payload: completionBody(model, { message: { content: "A summary." } }) };
  });

  try {
    for (const named of ["qwen2.5-coder:7b", "qwen2.5-coder", "QWEN2.5-CODER-7B"]) {
      const result = await generate(configFor(baseUrl, { model: named }), { question: "anything", context: [], rawPrompt: "summarize this" });
      assert.deepEqual(result, { ok: true, text: "A summary.", model: "qwen2.5-coder-7b" }, `asked for as ${named}`);
    }
    assert.deepEqual(asked, ["qwen2.5-coder-7b", "qwen2.5-coder-7b", "qwen2.5-coder-7b"]);

    // A model that is not there is said to be missing, by the name asked for, and nothing is sent.
    const missing = await generate(configFor(baseUrl, { model: "mistral:7b" }), { question: "anything", context: [] });
    assert.deepEqual(missing, { ok: false, reason: "mistral:7b is not one of the models in TRH AI's models folder." });
    assert.equal(asked.length, 3);
  } finally {
    server.close();
  }
});

test("an empty reply is a failure, not an empty answer", async () => {
  // Returning "" would render as the assistant saying nothing at all.
  const { server, baseUrl } = await withModel(() => ({ status: 200, payload: completionBody("llama3.2:latest", { message: { content: "   " } }) }));

  try {
    const result = await generate(configFor(baseUrl), { question: "anything", context: [] });
    assert.deepEqual(result, { ok: false, reason: "The local model returned an empty reply." });
  } finally {
    server.close();
  }
});

test("a reply cut off at the length limit is a failure that says so, not a shorter answer", async () => {
  // For app authoring a cut-off reply is worse than a short one: the last file
  // stops mid-line and can still pass for a whole one. The same words twice,
  // so what decides is the engine's finish reason.
  const words = "=== FILE: README.md\n# Snake\n\nUse the arrow keys to";
  let finish = "length";
  // 9,216 tokens is the window the engine has the model loaded with: the limit it ran past.
  const { server, baseUrl } = await withModel(
    () => ({ status: 200, payload: completionBody("llama3.2:latest", { message: { content: words }, done_reason: finish }) }), 9216
  );

  try {
    const cut = await generate(configFor(baseUrl), { question: "anything", context: [], rawPrompt: "write an app" });
    assert.deepEqual(cut, { ok: false, reason: "The reply from llama3.2:latest ran past the length limit (9,216 tokens) without finishing." });

    finish = "stop";
    const finished = await generate(configFor(baseUrl), { question: "anything", context: [], rawPrompt: "write an app" });
    assert.equal(finished.ok, true);
    if (finished.ok) assert.equal(finished.text, words);
  } finally {
    server.close();
  }
});

test("a model that never replies is given up on rather than hanging the request", async () => {
  const { server, baseUrl } = await withModel(() => "hang");

  try {
    const result = await generate(configFor(baseUrl, { timeoutMs: 300 }), { question: "anything", context: [] });
    // Said as what happened: the model was there and did not answer in time.
    assert.deepEqual(result, { ok: false, reason: "llama3.2:latest did not reply within 300 ms." });
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("an engine that does not answer is said as that, not as the model being slow", async () => {
  // Takes the connection and says nothing, even about which models it has.
  const silent = await standIn(() => "hang");
  try {
    const result = await generate(configFor(silent.baseUrl, { timeoutMs: 300 }), { question: "anything", context: [] });
    assert.deepEqual(result, { ok: false, reason: "llama3.2 was not loaded within 300 ms." });
  } finally {
    silent.server.closeAllConnections();
    silent.server.close();
  }

  // Nothing listening at all.
  const gone = await generate(configFor("http://127.0.0.1:1"), { question: "anything", context: [] });
  assert.deepEqual(gone, { ok: false, reason: "The model engine is not answering, so llama3.2 could not be loaded." });

  // Answering, with an error, when asked which models it has.
  const failing = await standIn(() => ({ status: 503, payload: { error: { code: 503, message: "Loading", type: "unavailable_error" } } }));
  try {
    const result = await generate(configFor(failing.baseUrl), { question: "anything", context: [] });
    assert.deepEqual(result, { ok: false, reason: "The model engine answered 503 while loading llama3.2." });
  } finally {
    failing.server.close();
  }
});

test("a request the turn stops is let go of at once, and said as stopped rather than as no reply", async () => {
  // App authoring and a long summary run during a turn, for minutes. Stop has
  // to end the request - the engine stops writing when its asker lets go - and
  // it is not the model failing to answer in time: the time had not run out.
  let asked = 0;
  let markArrived!: () => void;
  const arrived = new Promise<void>((resolve) => { markArrived = resolve; });
  let markLetGo!: () => void;
  const letGo = new Promise<void>((resolve) => { markLetGo = resolve; });
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      // Which models there are is answered; the reply itself never is.
      if (request.url === "/models") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(modelsBody(["llama3.2:latest"])));
        return;
      }
      asked += 1;
      response.on("close", () => {
        if (!response.writableEnded) markLetGo();
      });
      markArrived();
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
  // In the engine's own words, taken out of its error body.
  const { server, baseUrl } = await withModel(() => ({
    status: 500, payload: { error: { code: 500, message: "model name=llama3.2 failed to load", type: "server_error" } }
  }));

  try {
    const result = await generate(configFor(baseUrl), { question: "anything", context: [] });
    assert.deepEqual(result, { ok: false, reason: "The model engine answered 500: model name=llama3.2 failed to load." });
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

test("a bare name matches the tagged form, and an old spelling the new one", () => {
  assert.equal(pickModel("llama3.2", ["llama3.2:latest"]), "llama3.2:latest");
  // "name:size" is how a model was named under Ollama; "name-size" is its
  // file's name in TRH AI's models folder.
  assert.equal(pickModel("qwen2.5-coder:7b", ["qwen3-8b", "qwen2.5-coder-7b"]), "qwen2.5-coder-7b");
  assert.equal(pickModel("QWEN3:8B", ["qwen2.5-coder-7b", "qwen3-8b"]), "qwen3-8b", "whatever its capitals");
});

test("a name is a model or a size of it, never another model that starts the same way", () => {
  // "qwen2.5" is the general model. "qwen2.5-coder-7b" starts with the same
  // letters and is a different one.
  assert.equal(pickModel("qwen2.5", ["qwen2.5-coder-7b", "qwen2.5-3b"]), "qwen2.5-3b");
  assert.equal(pickModel("qwen2.5", ["qwen2.5-coder-7b", "phi3"], true), "qwen2.5-coder-7b", "not installed: the preference list, as for any absent name");
  assert.deepEqual(orderedCandidates("qwen2.5", ["qwen2.5-coder-7b", "qwen2.5-3b"], true), ["qwen2.5-3b", "qwen2.5-coder-7b"]);
});

test("with nothing named, the coding model answers, then the thinking one", () => {
  // The order the two were measured in on the same 54 tasks: the coder is the
  // default, and Qwen3 - better, and six times slower - comes next.
  assert.equal(pickModel(defaultModel, ["qwen2.5-3b", "qwen3-8b", "qwen2.5-coder-7b"], false), "qwen2.5-coder-7b");
  assert.equal(pickModel(defaultModel, ["qwen2.5-3b", "qwen3-8b"], false), "qwen3-8b");
  assert.deepEqual(orderedCandidates(defaultModel, ["qwen2.5-3b", "qwen3-8b", "qwen2.5-coder-7b"], false),
    ["qwen2.5-coder-7b", "qwen3-8b", "qwen2.5-3b"]);
});

test("the built-in default does not block a better model", () => {
  // The bug this exists to stop: with TRHAI_MODEL unset the config still
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
    readLocalModelConfig({ TRHAI_MODEL: "mistral" } as NodeJS.ProcessEnv).modelFromEnv,
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
  const config = readLocalModelConfig({ TRHAI_MODEL_TIMEOUT_MS: "5000" } as NodeJS.ProcessEnv);
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
