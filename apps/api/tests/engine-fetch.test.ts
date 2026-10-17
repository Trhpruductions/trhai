import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { engineFetch } from "../src/services/engineFetch.js";

// The engine's client: a standard Response, streamed, stopped by its signal,
// and with no wait limit of its own (the reason it exists - see engineFetch.ts).

async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("a JSON request is sent as given and answered with status, headers and body", async () => {
  let seen: { method?: string; type?: string; body?: string } = {};
  const engine = await serve((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      seen = { method: request.method, type: request.headers["content-type"], body };
      response.writeHead(201, { "Content-Type": "application/json", "X-Engine": "llama" });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  try {
    const answer = await engineFetch(`${engine.url}/v1/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "héllo" }] })
    });
    assert.equal(answer.status, 201);
    assert.equal(answer.ok, true);
    assert.equal(answer.headers.get("x-engine"), "llama");
    assert.deepEqual(await answer.json(), { ok: true });
    assert.equal(seen.method, "POST");
    assert.equal(seen.type, "application/json");
    assert.match(seen.body ?? "", /héllo/);
  } finally {
    await engine.close();
  }
});

test("a streamed reply arrives piece by piece, and an error status carries its body", async () => {
  const engine = await serve((request, response) => {
    if (request.url === "/fail") {
      response.writeHead(500, { "Content-Type": "text/plain" });
      response.end("cudaMalloc failed: out of memory");
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write("data: one\n\n");
    setTimeout(() => { response.write("data: two\n\n"); response.end(); }, 50);
  });
  try {
    const streamed = await engineFetch(`${engine.url}/stream`);
    const reader = (streamed.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    assert.equal(text, "data: one\n\ndata: two\n\n");
    const failed = await engineFetch(`${engine.url}/fail`);
    assert.equal(failed.ok, false);
    assert.equal(failed.status, 500);
    assert.match(await failed.text(), /out of memory/);
  } finally {
    await engine.close();
  }
});

test("stopping before the answer begins rejects; stopping during it ends the body", async () => {
  const engine = await serve((request, response) => {
    if (request.url === "/slow-start") return; // never answers
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write("data: first\n\n"); // then nothing more
  });
  try {
    const before = new AbortController();
    setTimeout(() => before.abort(), 50);
    await assert.rejects(engineFetch(`${engine.url}/slow-start`, { signal: before.signal }), { name: "AbortError" });

    const during = new AbortController();
    const answer = await engineFetch(`${engine.url}/stream`, { signal: during.signal });
    const reader = (answer.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    during.abort();
    await assert.rejects(reader.read(), { name: "AbortError" }, "stopped, not broken");

    const already = new AbortController();
    already.abort();
    await assert.rejects(engineFetch(`${engine.url}/stream`, { signal: already.signal }), { name: "AbortError" });
  } finally {
    await engine.close();
  }
});

test("each request has a connection of its own: the engine closes them after an answer", async () => {
  const connections: string[] = [];
  const engine = await serve((request, response) => {
    connections.push(String(request.headers.connection));
    response.writeHead(200, { "Content-Type": "application/json", "Transfer-Encoding": "chunked" });
    response.end(JSON.stringify({ turn: connections.length }));
    // As llama.cpp's server does: the connection is gone once the answer is.
    response.on("finish", () => setImmediate(() => response.socket?.destroy()));
  });
  try {
    for (let turn = 1; turn <= 3; turn += 1) {
      const answer = await engineFetch(`${engine.url}/v1/chat/completions`, { method: "POST", body: "{}" });
      assert.deepEqual(await answer.json(), { turn });
    }
    assert.deepEqual(connections, ["close", "close", "close"]);
  } finally {
    await engine.close();
  }
});

test("nothing listening is a TypeError, as it is from fetch", async () => {
  const engine = await serve(() => undefined);
  const { url } = engine;
  await engine.close();
  await assert.rejects(engineFetch(`${url}/health`), TypeError);
});

test("every engine request carries the engine's key, and an explicit one is left alone", async () => {
  const { setEngineKey } = await import("../src/services/engineKey.js");
  const seen: Array<string | undefined> = [];
  const engine = await serve((request, response) => {
    seen.push(request.headers.authorization);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end("{}");
  });
  try {
    setEngineKey("k-123");
    await (await engineFetch(`${engine.url}/v1/models`)).json();
    await (await engineFetch(`${engine.url}/v1/models`, { headers: { Authorization: "Bearer other" } })).json();
    setEngineKey(null);
    await (await engineFetch(`${engine.url}/v1/models`)).json();
    assert.deepEqual(seen, ["Bearer k-123", "Bearer other", undefined]);
  } finally {
    setEngineKey(null);
    await engine.close();
  }
});
