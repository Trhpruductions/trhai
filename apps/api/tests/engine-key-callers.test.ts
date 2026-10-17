import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";

// Every route that reads the engine carries its key. The model list used
// Node's own fetch after the key came in: the engine refused every list, the
// conversation's model picker came back empty, and the engine's log filled
// with refusals. This engine refuses anything without the key, as llama.cpp
// started with --api-key does.

const { setEngineKey } = await import("../src/services/engineKey.js");
const { listChatModels } = await import("../src/services/modelCatalog.js");
const { readLocalModelConfig } = await import("../src/services/localModel.js");
const { modelsBody } = await import("./helpers/fakeEngine.js");

test("the chat model list reaches an engine that wants its key", async () => {
  const refused: string[] = [];
  const engine = createServer((request, response) => {
    if (request.headers.authorization !== "Bearer the-key") {
      refused.push(String(request.url));
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Invalid API Key" } }));
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(modelsBody(["qwen3-4b-instruct-2507"])));
  });
  engine.listen(0, "127.0.0.1");
  await once(engine, "listening");
  const { port } = engine.address() as AddressInfo;
  setEngineKey("the-key");
  try {
    const listed = await listChatModels({ ...readLocalModelConfig(), baseUrl: `http://127.0.0.1:${port}` });
    assert.deepEqual(refused, [], "nothing was sent without the key");
    assert.deepEqual(listed.models.map((model) => model.name), ["qwen3-4b-instruct-2507"]);
  } finally {
    setEngineKey(null);
    engine.close();
  }
});
