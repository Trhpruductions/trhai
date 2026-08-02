import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { AddressInfo } from "node:net";
import { once } from "node:events";
import { v1MemoryRouter } from "../src/routes/v1Memory.js";
import { ModelRouter } from "../src/services/modelRouter.js";

test("model router uses workspace memory and recent context in replies", async () => {
  const router = new ModelRouter();
  const reply = await router.generate({
    mode: "general",
    userMessage: "Help me prepare the launch",
    memoryContext: [
      { title: "Launch plan", body: "The launch happens next week and needs a checklist." }
    ],
    history: [
      { role: "user", content: "We need a launch checklist" },
      { role: "assistant", content: "I can help outline the plan." }
    ]
  });

  assert.match(reply.output, /Launch plan/i);
  assert.match(reply.output, /launch/i);
});

test("workspace memory endpoints persist context for the UI", async () => {
  const app = express();
  app.use(express.json());
  app.use("/v1", v1MemoryRouter);

  const server = app.listen(0);
  await once(server, "listening");

  try {
    const address = server.address() as AddressInfo;
    const workspaceResponse = await fetch(`http://127.0.0.1:${address.port}/v1/workspaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Memory Test Workspace" })
    });

    assert.equal(workspaceResponse.status, 201);
    const workspacePayload = (await workspaceResponse.json()) as { data: { id: string } };
    const workspaceId = workspacePayload.data.id;

    const memoryCreateResponse = await fetch(`http://127.0.0.1:${address.port}/v1/workspaces/${workspaceId}/memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Launch plan", body: "The agent should remember the launch plan for this workspace.", kind: "preference" })
    });

    assert.equal(memoryCreateResponse.status, 201);

    const memoryReadResponse = await fetch(`http://127.0.0.1:${address.port}/v1/workspaces/${workspaceId}/memory`);
    assert.equal(memoryReadResponse.status, 200);

    const memoryPayload = (await memoryReadResponse.json()) as { data: Array<{ title: string; body: string }> };
    assert.ok(memoryPayload.data.some((item) => item.title === "Launch plan"));
  } finally {
    server.close();
  }
});

test("workspace telemetry endpoint reports real activity counts", async () => {
  const app = express();
  app.use(express.json());
  app.use("/v1", v1MemoryRouter);

  const server = app.listen(0);
  await once(server, "listening");

  try {
    const address = server.address() as AddressInfo;
    const workspaceResponse = await fetch(`http://127.0.0.1:${address.port}/v1/workspaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Telemetry Workspace" })
    });
    assert.equal(workspaceResponse.status, 201);
    const workspacePayload = (await workspaceResponse.json()) as { data: { id: string } };
    const workspaceId = workspacePayload.data.id;

    const conversationResponse = await fetch(`http://127.0.0.1:${address.port}/v1/workspaces/${workspaceId}/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "general", title: "Telemetry" })
    });
    assert.equal(conversationResponse.status, 201);
    const conversationPayload = (await conversationResponse.json()) as { data: { id: string } };

    const messageResponse = await fetch(`http://127.0.0.1:${address.port}/v1/workspaces/${workspaceId}/conversations/${conversationPayload.data.id}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID()
      },
      body: JSON.stringify({ content: "Generate telemetry snapshot", stream: false })
    });
    assert.equal(messageResponse.status, 200);

    const telemetryResponse = await fetch(`http://127.0.0.1:${address.port}/v1/workspaces/${workspaceId}/telemetry`);
    assert.equal(telemetryResponse.status, 200);

    const telemetryPayload = (await telemetryResponse.json()) as {
      data: {
        counts: { conversations: number; messages: number };
        usage: { tokenUsage: number };
      };
    };

    assert.equal(telemetryPayload.data.counts.conversations, 1);
    assert.ok(telemetryPayload.data.counts.messages >= 2);
    assert.ok(telemetryPayload.data.usage.tokenUsage > 0);
  } finally {
    server.close();
  }
});

test("workspace telemetry stream emits telemetry events", async () => {
  const app = express();
  app.use(express.json());
  app.use("/v1", v1MemoryRouter);

  const server = app.listen(0);
  await once(server, "listening");

  try {
    const address = server.address() as AddressInfo;
    const workspaceResponse = await fetch(`http://127.0.0.1:${address.port}/v1/workspaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Telemetry Stream Workspace" })
    });
    assert.equal(workspaceResponse.status, 201);
    const workspacePayload = (await workspaceResponse.json()) as { data: { id: string } };
    const workspaceId = workspacePayload.data.id;

    const streamResponse = await fetch(`http://127.0.0.1:${address.port}/v1/workspaces/${workspaceId}/telemetry/stream`, {
      headers: { Accept: "text/event-stream" }
    });

    assert.equal(streamResponse.status, 200);
    assert.match(streamResponse.headers.get("content-type") ?? "", /text\/event-stream/i);
    assert.ok(streamResponse.body);

    const reader = streamResponse.body!.getReader();
    const firstFrame = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Timed out waiting for telemetry stream frame")), 2000);
      })
    ]);

    assert.equal(firstFrame.done, false);
    const chunk = new TextDecoder().decode(firstFrame.value);
    assert.match(chunk, /event: telemetry/i);
    await reader.cancel();
  } finally {
    server.close();
  }
});
