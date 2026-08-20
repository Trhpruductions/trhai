import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAgent } from "../src/services/agentLoop.js";
import type { ToolContext } from "../src/services/agentTools.js";
import type { LocalModelConfig } from "../src/services/localModel.js";

// createApp() below starts a real server; the isolation reasoning is the same
// as assist-context.test.ts.
const dataDir = mkdtempSync(path.join(tmpdir(), "ascend-agent-activity-"));
process.env.ASSIST_MEMORY_FILE = path.join(dataDir, "memory.json");
process.env.ASSIST_ACCOUNTS_FILE = path.join(dataDir, "accounts.json");
process.env.ASSIST_CONVERSATION_FILE = path.join(dataDir, "conversations.json");
process.env.ASSIST_KNOWLEDGE_FILE = path.join(dataDir, "knowledge.json");
process.env.ASCEND_PREFERENCES_FILE = path.join(dataDir, "preferences.json");

const { createApp } = await import("../src/server.js");
const { getActivity, setActivity, clearActivity, resetAgentActivity } = await import("../src/services/agentActivity.js");

const context: ToolContext = { memories: [], knowledge: [] };

test("nothing is reported for a session that was never touched", () => {
  resetAgentActivity();
  assert.equal(getActivity("s1"), null);
});

test("set, read, and clear round-trip independently per session", () => {
  resetAgentActivity();
  setActivity("s1", "write_file");
  setActivity("s2", "search_documents");

  assert.equal(getActivity("s1")?.tool, "write_file");
  assert.equal(getActivity("s2")?.tool, "search_documents");

  clearActivity("s1");
  assert.equal(getActivity("s1"), null);
  // Clearing one session must not touch another's reading.
  assert.equal(getActivity("s2")?.tool, "search_documents");
});

test("a later call for the same session replaces, not appends", () => {
  resetAgentActivity();
  setActivity("s1", "read_file");
  setActivity("s1", "write_file");
  assert.equal(getActivity("s1")?.tool, "write_file");
});

/** A fake Ollama that calls two real, harmless tools in sequence, then answers. */
function fakeModelThatCallsTwoTools() {
  return new Promise<{ server: Server; baseUrl: string }>((resolve) => {
    let turn = 0;
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk as Buffer));
      request.on("end", () => {
        turn += 1;
        response.writeHead(200, { "Content-Type": "application/json" });

        if (turn === 1) {
          response.end(JSON.stringify({
            model: "llama3.1:8b",
            message: { content: "", tool_calls: [{ function: { name: "current_datetime", arguments: {} } }] }
          }));
          return;
        }
        if (turn === 2) {
          response.end(JSON.stringify({
            model: "llama3.1:8b",
            message: {
              content: "",
              tool_calls: [{ function: { name: "calculate", arguments: { expression: "2 + 2" } } }]
            }
          }));
          return;
        }

        response.end(JSON.stringify({ model: "llama3.1:8b", message: { content: "It's 4." } }));
      });
    });

    server.listen(0, "127.0.0.1", () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    });
  });
}

test("onToolStart fires for each tool call, in order, before the result is known", async () => {
  const { server, baseUrl } = await fakeModelThatCallsTwoTools();
  const config: LocalModelConfig = { baseUrl, model: "llama3.1:8b", modelFromEnv: true, timeoutMs: 5000 };
  const seen: string[] = [];

  try {
    const result = await runAgent(config, "what is 2 + 2", context, fetch, (tool) => seen.push(tool));

    assert.equal(result.ok, true);
    assert.deepEqual(seen, ["current_datetime", "calculate"]);
  } finally {
    server.close();
  }
});

test("GET /v1/assist/activity reports the real tool, then null once cleared", async () => {
  resetAgentActivity();
  const app = createApp();
  const httpServer = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => httpServer.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;

  try {
    setActivity("watch-me", "build_app");

    const midFlight = await fetch(`${baseUrl}/v1/assist/activity?sessionId=watch-me`);
    const midFlightBody = await midFlight.json() as { data: { tool: string | null } };
    assert.equal(midFlightBody.data.tool, "build_app");

    clearActivity("watch-me");

    const afterwards = await fetch(`${baseUrl}/v1/assist/activity?sessionId=watch-me`);
    const afterwardsBody = await afterwards.json() as { data: { tool: string | null } };
    assert.equal(afterwardsBody.data.tool, null);
  } finally {
    httpServer.close();
  }
});

test("a request with no sessionId is rejected the same way the other assist routes reject it", async () => {
  const app = createApp();
  const httpServer = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => httpServer.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;

  try {
    const response = await fetch(`${baseUrl}/v1/assist/activity`);
    assert.equal(response.status, 400);
  } finally {
    httpServer.close();
  }
});
