import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { once } from "node:events";

// The System and Network workspaces' readings: the service as it runs, the
// model the engine holds in memory, unloading it, this PC's addresses, and an
// internet check that measures once when asked.

const dataDir = mkdtempSync(path.join(tmpdir(), "ascend-system-network-"));
process.env.ASSIST_MEMORY_FILE = path.join(dataDir, "memory.json");
process.env.ASSIST_CONVERSATION_FILE = path.join(dataDir, "conversations.json");
process.env.ASSIST_ACCOUNTS_FILE = path.join(dataDir, "accounts.json");
process.env.ASSIST_KNOWLEDGE_FILE = path.join(dataDir, "knowledge.json");
process.env.ASCEND_PREFERENCES_FILE = path.join(dataDir, "preferences.json");

const { createApp } = await import("../src/server.js");
const {
  engineRuntime, internetCheck, networkInterfaces, noteListening, reachableFromNetwork, serviceStatus, unloadModel
} = await import("../src/services/runtimeStatus.js");

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

/**
 * A stand-in engine: two models, one of them loaded - which is all the engine
 * ever holds, and the only one it gives a size and a window for. It remembers
 * what it was asked.
 */
function standInEngine() {
  const asked: Array<{ url: string; body: string }> = [];
  return new Promise<{ server: Server; baseUrl: string; asked: typeof asked }>((resolve) => {
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk as Buffer));
      request.on("end", () => {
        asked.push({ url: request.url ?? "", body: Buffer.concat(chunks).toString("utf8") });
        response.writeHead(200, { "Content-Type": "application/json" });
        if (request.url === "/models") {
          response.end(JSON.stringify({
            data: [
              { id: "qwen2.5-3b", status: { value: "loaded" }, meta: { n_ctx: 32768, size: 1_900_000_000 }, architecture: { input_modalities: ["text"] } },
              { id: "qwen2.5-coder-7b", status: { value: "unloaded" }, architecture: { input_modalities: ["text"] } }
            ]
          }));
        } else if (request.url === "/props") {
          response.end(JSON.stringify({ build_info: "b11366-2923cf286" }));
        } else {
          response.end(JSON.stringify({ success: true }));
        }
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, asked }));
  });
}

test("an address that accepts other machines is told from one that does not", () => {
  assert.equal(reachableFromNetwork("::"), true);
  assert.equal(reachableFromNetwork("0.0.0.0"), true);
  assert.equal(reachableFromNetwork("192.168.1.5"), true);
  assert.equal(reachableFromNetwork("127.0.0.1"), false);
  assert.equal(reachableFromNetwork("::1"), false);
});

test("the service reports itself as it runs, and what it actually listens on", () => {
  noteListening([{ address: "127.0.0.1", family: "IPv4", port: 4123 }, { address: "::1", family: "IPv6", port: 4123 }]);
  const status = serviceStatus();
  assert.equal(status.pid, process.pid);
  assert.equal(status.node, process.version);
  assert.ok(status.rssBytes > 0 && status.uptimeSeconds >= 0);
  assert.deepEqual(status.listening, {
    port: 4123,
    addresses: [{ address: "127.0.0.1", family: "IPv4" }, { address: "::1", family: "IPv6" }],
    keyRequired: false,
    fromNetwork: false
  });

  // Let in from the network, it says so - and that the key is asked for.
  noteListening([{ address: "::", family: "IPv6", port: 4123 }], { keyRequired: true });
  assert.deepEqual(serviceStatus().listening, {
    port: 4123, addresses: [{ address: "::", family: "IPv6" }], keyRequired: true, fromNetwork: true
  });
});

test("what the engine holds in memory and has installed is read from the engine", async () => {
  const engine = await standInEngine();
  try {
    const runtime = await engineRuntime(engine.baseUrl);
    assert.equal(runtime.reachable, true);
    assert.equal(runtime.version, "b11366-2923cf286");
    // The loaded model, with the window the engine gave it on this card.
    assert.deepEqual(runtime.loaded, [{ name: "qwen2.5-3b", sizeBytes: 1_900_000_000, windowTokens: 32768 }]);
    assert.deepEqual(runtime.installed.map((model) => model.name), ["qwen2.5-3b", "qwen2.5-coder-7b"]);
    assert.equal(runtime.idleUnloadSeconds, 300, "how long a loaded model may sit unused");
  } finally {
    engine.server.close();
  }
  const away = await engineRuntime("http://127.0.0.1:1");
  assert.deepEqual(away, { reachable: false, version: null, loaded: [], installed: [], idleUnloadSeconds: 300, reason: null });
});

test("unloading asks the engine to let that model go, under the engine's own name for it", async () => {
  const engine = await standInEngine();
  try {
    // Named the way a conversation saved under Ollama names it.
    assert.deepEqual(await unloadModel(engine.baseUrl, "qwen2.5:3b"), { ok: true });
    const request = engine.asked.find((entry) => entry.url === "/models/unload");
    assert.deepEqual(JSON.parse(request?.body ?? "{}"), { model: "qwen2.5-3b" });
  } finally {
    engine.server.close();
  }
  assert.equal((await unloadModel("http://127.0.0.1:1", "qwen2.5-3b")).ok, false);
});

test("this PC's addresses are listed, loopback among them", () => {
  const addresses = networkInterfaces();
  assert.ok(addresses.some((entry) => entry.internal && (entry.address === "127.0.0.1" || entry.address === "::1")));
});

test("the internet check measures one request, and says plainly when nothing answered", async () => {
  let clock = 1000;
  const answered = await internetCheck((async () => { clock += 42; return new Response(null, { status: 200 }); }) as unknown as typeof fetch, () => clock);
  assert.equal(answered.reachable, true);
  assert.equal(answered.latencyMs, 42);
  const silent = await internetCheck((async () => { throw new Error("offline"); }) as unknown as typeof fetch);
  assert.deepEqual([silent.reachable, silent.latencyMs], [false, null]);
});

test("the routes: runtime and network read through, and an unload needs a model's name", async () => {
  const engine = await standInEngine();
  const previous = process.env.TRHAI_ENGINE_URL;
  process.env.TRHAI_ENGINE_URL = engine.baseUrl;
  const app = createApp().listen(0);
  await once(app, "listening");
  const baseUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  try {
    const runtime = await (await fetch(`${baseUrl}/v1/system/runtime`)).json() as any;
    assert.equal(runtime.data.engine.loaded[0].name, "qwen2.5-3b");
    assert.equal(runtime.data.engine.loaded[0].windowTokens, 32768);
    assert.ok(Array.isArray(runtime.data.stores.failing));
    const network = await (await fetch(`${baseUrl}/v1/network`)).json() as any;
    assert.ok(network.data.interfaces.length > 0);
    assert.equal(network.data.engine.reachable, true);
    const refused = await fetch(`${baseUrl}/v1/system/models/unload`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "" }) });
    assert.equal(refused.status, 400);
    const unloaded = await fetch(`${baseUrl}/v1/system/models/unload`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "qwen2.5-3b" }) });
    assert.equal(unloaded.status, 200);
  } finally {
    if (previous === undefined) delete process.env.TRHAI_ENGINE_URL;
    else process.env.TRHAI_ENGINE_URL = previous;
    await new Promise<void>((resolve) => app.close(() => resolve()));
    engine.server.close();
  }
});
