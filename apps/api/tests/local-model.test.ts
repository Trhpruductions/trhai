import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import {
  buildPrompt,
  checkAvailability,
  generate,
  readLocalModelConfig,
  type LocalModelConfig
} from "../src/services/localModel.js";

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
  return { baseUrl, model: "llama3.2", timeoutMs: 2000, ...overrides };
}

test("configuration falls back to the usual local defaults", () => {
  const config = readLocalModelConfig({} as NodeJS.ProcessEnv);

  assert.equal(config.baseUrl, "http://127.0.0.1:11434");
  assert.equal(config.model, "llama3.2");
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

test("a running server without the model says which models it does have", async () => {
  // "Unavailable" alone would send the user looking for a server that is
  // already running.
  const { server, baseUrl } = await fakeOllama(() => ({
    status: 200,
    payload: { models: [{ name: "codellama:latest" }] }
  }));

  try {
    const result = await checkAvailability(configFor(baseUrl));
    assert.equal(result.available, false);
    if (result.available) return;
    assert.match(result.reason, /not pulled/);
    assert.match(result.reason, /codellama/);
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
    const request = body as { model: string; stream: boolean; prompt: string };
    assert.equal(request.stream, false);
    assert.match(request.prompt, /Question: What is the capital of France\?/);
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

test("a server that never replies gives up rather than hanging the request", async () => {
  const { server, baseUrl } = await fakeOllama(() => "hang");

  try {
    const result = await generate(configFor(baseUrl, { timeoutMs: 300 }), { question: "anything", context: [] });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /did not reply/);
  } finally {
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
