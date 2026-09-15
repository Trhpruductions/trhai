import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// A workspace of its own, so the write test cannot touch the repo.
const testWorkspace = mkdtempSync(path.join(tmpdir(), "ascend-caps-"));
process.env.ASCEND_WORKSPACE = testWorkspace;
import { maxCallsPerRound, runAgent } from "../src/services/agentLoop.js";
import type { ToolContext } from "../src/services/agentTools.js";
import type { LocalModelConfig } from "../src/services/localModel.js";

// How many tool calls one reply may carry, and how many of them may change
// something. Found live: told that forget needed its fact filled in, the
// model answered with a call to every one of the twenty tools on offer, and
// the loop ran them all - an app built, a video rendered, a global npm
// package installed, on a request to delete one memory.

const at = new Date("2026-08-17T12:00:00Z").toISOString();

const context: ToolContext = {
  memories: [
    { id: "m1", title: "Database", body: "The billing database is Postgres 16.", pinned: false, createdAt: at }
  ],
  knowledge: [],
  now: () => new Date("2026-08-17T12:00:00Z")
};

/** A stand-in Ollama driven by a script of replies; records what it was sent. */
function fakeModel(turns: Array<Record<string, unknown>>) {
  const received: Array<Record<string, unknown>> = [];

  return new Promise<{ server: Server; baseUrl: string; received: typeof received }>((resolve) => {
    let turn = 0;
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk as Buffer));
      request.on("end", () => {
        received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        const body = turns[Math.min(turn, turns.length - 1)];
        turn += 1;
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ model: "llama3.2:latest", ...body }));
      });
    });

    server.listen(0, "127.0.0.1", () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received });
    });
  });
}

const configFor = (baseUrl: string): LocalModelConfig =>
  ({ baseUrl, model: "llama3.2", modelFromEnv: true, timeoutMs: 4000 });

const calls = (...entries: Array<[string, Record<string, unknown>]>) => ({
  message: {
    content: "",
    tool_calls: entries.map(([name, args]) => ({ function: { name, arguments: args } }))
  }
});

const answer = (content: string) => ({ message: { content } });

/** Every tool message the fake model was sent on its second request. */
function toolMessagesOnSecondRequest(received: Array<Record<string, unknown>>): string {
  const messages = received[1]?.messages as Array<{ role: string; content: string }> | undefined;
  return (messages ?? []).filter((message) => message.role === "tool").map((message) => message.content).join("\n");
}

test("a reply asking for more tools than the cap runs none of them", async () => {
  const batch = Array.from({ length: maxCallsPerRound + 2 }, (): [string, Record<string, unknown>] =>
    ["search_memory", { query: "billing database" }]);
  const { server, baseUrl, received } = await fakeModel([
    calls(...batch),
    answer("Billing runs on Postgres 16.")
  ]);

  try {
    const result = await runAgent(configFor(baseUrl), "Which database does billing use?", context);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.toolsUsed, [], "not one of the batch may run");
    assert.match(toolMessagesOnSecondRequest(received), /none of them were run/);
  } finally {
    server.close();
  }
});

test("a reply within the cap runs as before", async () => {
  const { server, baseUrl } = await fakeModel([
    calls(["search_memory", { query: "billing database" }], ["current_datetime", {}]),
    answer("Billing runs on Postgres 16, as of today.")
  ]);

  try {
    const result = await runAgent(configFor(baseUrl), "Which database does billing use, and what is the date?", context);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.toolsUsed.map((used) => used.name), ["search_memory", "current_datetime"]);
  } finally {
    server.close();
  }
});

test("only the first change in a reply is made; the rest wait for its result", async () => {
  const { server, baseUrl, received } = await fakeModel([
    calls(
      ["write_file", { path: "first.txt", content: "one" }],
      ["write_file", { path: "second.txt", content: "two" }]
    ),
    answer("I wrote first.txt.")
  ]);

  try {
    const result = await runAgent(
      configFor(baseUrl),
      "Create first.txt containing one and second.txt containing two.",
      context
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.toolsUsed.map((used) => used.name), ["write_file"]);
    assert.equal(existsSync(path.join(testWorkspace, "first.txt")), true, "the first change is made");
    assert.equal(existsSync(path.join(testWorkspace, "second.txt")), false, "the second waits for the first's result");
    assert.match(toolMessagesOnSecondRequest(received), /one change per reply/);
  } finally {
    server.close();
  }
});

test("a change asked for twice with the same arguments runs once", async () => {
  // Asked for one daily check, the model called add_schedule in four
  // consecutive rounds. Here: the same write_file twice, two rounds.
  const { server, baseUrl, received } = await fakeModel([
    calls(["write_file", { path: "once.txt", content: "one" }]),
    calls(["write_file", { path: "once.txt", content: "one" }]),
    answer("Wrote once.txt.")
  ]);

  try {
    const result = await runAgent(configFor(baseUrl), "Create once.txt containing one.", context);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.toolsUsed.map((used) => used.name), ["write_file"], "the repeat is not run");
    const third = received[2]?.messages as Array<{ role: string; content: string }> | undefined;
    const toolMessages = (third ?? []).filter((message) => message.role === "tool").map((message) => message.content).join("\n");
    assert.match(toolMessages, /already called with these exact arguments/);
  } finally {
    server.close();
  }
});
