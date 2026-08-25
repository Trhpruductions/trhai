import test from "node:test";
import assert from "node:assert/strict";
import { AddressInfo } from "node:net";
import { once } from "node:events";
import { createApp } from "../src/server.js";
import { availableTools } from "../src/services/agentTools.js";
import { commandsArmed } from "../src/services/commandRunner.js";

// The route this file covers exists so a UI screen can render real tools and
// real permission levels as structured data, instead of parsing them back out
// of buildCapabilityReply's prose. Asserted against the live registry, not a
// copy of its contents, so a future tool addition or removal cannot make this
// pass while the route itself goes stale — the same discipline
// system-capabilities.test.ts already applies to the function this route
// wraps.

async function startTestServer() {
  const app = createApp();
  const server = app.listen(0);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

test("the capabilities route reports every tool on offer, and nothing else", async () => {
  const server = await startTestServer();
  try {
    const response = await fetch(`${server.baseUrl}/v1/capabilities`);
    const payload = await response.json() as {
      data?: { tools?: Array<{ name: string }>; filesystem?: boolean; web?: boolean; codeExecution?: boolean };
    };

    assert.equal(response.status, 200);
    // What is offered, not everything that exists: run_command is withheld
    // while machine control is off, and the route has to agree with that.
    const reported = (payload.data?.tools ?? []).map((tool) => tool.name).sort();
    const offered = availableTools(commandsArmed()).map((definition) => definition.function.name).sort();
    assert.deepEqual(reported, offered);
  } finally {
    await server.close();
  }
});

test("the capabilities route reports honestly: filesystem and web are true, code execution is not", async () => {
  const server = await startTestServer();
  try {
    const response = await fetch(`${server.baseUrl}/v1/capabilities`);
    const payload = await response.json() as {
      data?: { filesystem?: boolean; web?: boolean; codeExecution?: boolean; integrations?: string[] };
    };

    assert.equal(payload.data?.filesystem, true);
    assert.equal(payload.data?.web, true);
    // False because machine control is off, not because no such tool exists —
    // one does now. The answer is unchanged; the reason for it is not.
    assert.equal(payload.data?.codeExecution, false);
    assert.deepEqual(payload.data?.integrations, []);
  } finally {
    await server.close();
  }
});

test("the capabilities route groups tools by the real permission ladder", async () => {
  const server = await startTestServer();
  try {
    const response = await fetch(`${server.baseUrl}/v1/capabilities`);
    const payload = await response.json() as {
      data?: { tools?: unknown[]; groups?: Array<{ label: string; tools: unknown[] }> };
    };

    const groups = payload.data?.groups ?? [];
    const total = groups.reduce((sum, group) => sum + group.tools.length, 0);
    assert.equal(total, payload.data?.tools?.length);

    // safe before development before destructive before external, whichever
    // of these actually have a tool in them today — the same order the
    // permission ladder itself defines.
    const expectedOrder = ["safe", "development", "destructive", "external"];
    const labels = groups.map((group) => group.label);
    assert.deepEqual(labels, expectedOrder.filter((label) => labels.includes(label)));
  } finally {
    await server.close();
  }
});

test("the capabilities route reports the model as null rather than omitting it when none is running", async () => {
  const server = await startTestServer();
  try {
    const response = await fetch(`${server.baseUrl}/v1/capabilities`);
    const payload = await response.json() as { data?: { model?: unknown } };

    // Whichever this test environment's actual state is: either a real model
    // string, or explicitly null — never absent, and never a fabricated name.
    assert.ok(payload.data && "model" in payload.data);
    const model = payload.data!.model;
    assert.ok(model === null || typeof model === "string");
  } finally {
    await server.close();
  }
});
