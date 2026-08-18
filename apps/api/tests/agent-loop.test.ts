import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { maxToolRounds, runAgent, systemPrompt } from "../src/services/agentLoop.js";
import { runTool, toolDefinitions, type ToolContext } from "../src/services/agentTools.js";
import type { LocalModelConfig } from "../src/services/localModel.js";

const at = new Date("2026-08-17T12:00:00Z").toISOString();

const context: ToolContext = {
  memories: [
    { id: "m1", title: "Database", body: "The billing database is Postgres 16.", pinned: false, createdAt: at }
  ],
  knowledge: [
    {
      id: "k1", title: "Rollback", documentTitle: "Runbook",
      body: "Rollback procedure: run scripts/rollback.sh with the previous release tag.",
      pinned: false, createdAt: at
    }
  ],
  now: () => new Date("2026-08-17T12:00:00Z")
};

/**
 * A stand-in Ollama driven by a script of turns.
 *
 * Each entry is one reply. This exercises the real loop — HTTP, JSON, tool
 * dispatch, message threading — against a model whose behaviour is known.
 */
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

const configFor = (baseUrl: string): LocalModelConfig => ({ baseUrl, model: "llama3.2", timeoutMs: 4000 });

const toolCall = (name: string, args: Record<string, unknown>) => ({
  message: { content: "", tool_calls: [{ function: { name, arguments: args } }] }
});

const answer = (content: string) => ({ message: { content } });

test("a plain answer needs no tools", async () => {
  const { server, baseUrl } = await fakeModel([answer("Two plus two is four.")]);

  try {
    const result = await runAgent(configFor(baseUrl), "What is 2+2?", context);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.text, /four/);
    assert.deepEqual(result.toolsUsed, []);
  } finally {
    server.close();
  }
});

test("the model can look something up and answer from it", async () => {
  const { server, baseUrl, received } = await fakeModel([
    toolCall("search_memory", { query: "billing database" }),
    answer("Your billing database is Postgres 16.")
  ]);

  try {
    const result = await runAgent(configFor(baseUrl), "Which database does billing use?", context);
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.deepEqual(result.toolsUsed, ["search_memory"]);
    assert.match(result.text, /Postgres 16/);

    // The real memory reached the model, rather than the loop answering for it.
    const secondRequest = received[1] as { messages: Array<{ role: string; content: string }> };
    const toolTurn = secondRequest.messages.find((message) => message.role === "tool");
    assert.match(toolTurn?.content ?? "", /Postgres 16/);
  } finally {
    server.close();
  }
});

test("an empty search is reported to the model as empty", async () => {
  // The single most important behaviour here. Told nothing, a model invents;
  // told "nothing matches", it can say so.
  const { server, baseUrl, received } = await fakeModel([
    toolCall("search_memory", { query: "pension scheme" }),
    answer("I have nothing saved about that.")
  ]);

  try {
    const result = await runAgent(configFor(baseUrl), "What is my pension scheme?", context);
    assert.equal(result.ok, true);

    const secondRequest = received[1] as { messages: Array<{ role: string; content: string }> };
    const toolTurn = secondRequest.messages.find((message) => message.role === "tool");
    assert.match(toolTurn?.content ?? "", /Nothing in the user's saved memory matches/);
  } finally {
    server.close();
  }
});

test("tools can be chained across rounds", async () => {
  // Two lookups then an answer — the thing one-shot generation could not do.
  const { server, baseUrl } = await fakeModel([
    toolCall("search_memory", { query: "database" }),
    toolCall("search_documents", { query: "rollback" }),
    answer("Postgres 16, and rollback runs scripts/rollback.sh.")
  ]);

  try {
    const result = await runAgent(configFor(baseUrl), "Database and rollback?", context);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.toolsUsed, ["search_memory", "search_documents"]);
  } finally {
    server.close();
  }
});

test("a model that never concludes is stopped rather than left running", async () => {
  // Without the bound this is a hang: the request runs until it times out and
  // the app looks like it stopped responding.
  const { server, baseUrl, received } = await fakeModel([toolCall("search_memory", { query: "again" })]);

  try {
    const result = await runAgent(configFor(baseUrl), "Loop forever", context);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /without reaching an answer/);
    assert.equal(result.toolsUsed.length, maxToolRounds);
  } finally {
    server.close();
  }
});

test("the final round withholds tools so an answer is forced", async () => {
  const { server, baseUrl, received } = await fakeModel([toolCall("search_memory", { query: "x" })]);

  try {
    await runAgent(configFor(baseUrl), "anything", context);

    const lastRequest = received[received.length - 1] as { tools?: unknown };
    assert.equal(lastRequest.tools, undefined, "the last round must not offer tools");
    assert.ok((received[0] as { tools?: unknown }).tools, "earlier rounds must offer them");
  } finally {
    server.close();
  }
});

test("a tool the model invented is refused without ending the conversation", async () => {
  const { server, baseUrl } = await fakeModel([
    toolCall("send_email", { to: "someone" }),
    answer("I cannot send email.")
  ]);

  try {
    const result = await runAgent(configFor(baseUrl), "Email someone", context);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.text, /cannot send email/);
  } finally {
    server.close();
  }
});

test("arguments arriving as a JSON string are still understood", async () => {
  // Ollama builds differ on this; a parse failure here would lose the reply.
  const { server, baseUrl, received } = await fakeModel([
    { message: { content: "", tool_calls: [{ function: { name: "search_memory", arguments: '{"query":"billing database"}' } }] } },
    answer("Postgres 16.")
  ]);

  try {
    const result = await runAgent(configFor(baseUrl), "which database?", context);
    assert.equal(result.ok, true);

    const secondRequest = received[1] as { messages: Array<{ role: string; content: string }> };
    const toolTurn = secondRequest.messages.find((message) => message.role === "tool");
    assert.match(toolTurn?.content ?? "", /Postgres 16/);
  } finally {
    server.close();
  }
});

test("an empty reply is a failure, not a blank answer", async () => {
  const { server, baseUrl } = await fakeModel([answer("   ")]);

  try {
    const result = await runAgent(configFor(baseUrl), "anything", context);
    assert.equal(result.ok, false);
  } finally {
    server.close();
  }
});

test("the system prompt forbids inventing a result", () => {
  // The tools are only safe because of this instruction; it is worth a test.
  assert.match(systemPrompt, /returns nothing, say so plainly/);
  assert.match(systemPrompt, /Never claim you saved, found or did something/);
});

test("every advertised tool is actually implemented", () => {
  // A tool the model can see but cannot call is a promise the app breaks.
  for (const definition of toolDefinitions) {
    const result = runTool({ name: definition.function.name, arguments: {} }, context);
    assert.ok(
      !/There is no tool called/.test(result.content),
      `${definition.function.name} is advertised but not implemented`
    );
  }
});

test("a save with nowhere to write reports that nothing was stored", () => {
  const result = runTool({ name: "remember", arguments: { fact: "I like tea." } }, context);

  assert.equal(result.ok, false);
  assert.match(result.content, /nothing was saved/);
});

test("a successful save says what was saved", () => {
  const saved: string[] = [];
  const result = runTool(
    { name: "remember", arguments: { fact: "I like tea." } },
    { ...context, saveMemory: (fact) => { saved.push(fact); return true; } }
  );

  assert.equal(result.ok, true);
  assert.deepEqual(saved, ["I like tea."]);
});

test("a document result carries the document it came from", () => {
  const result = runTool({ name: "search_documents", arguments: { query: "rollback procedure" } }, context);

  assert.equal(result.ok, true);
  assert.match(result.content, /Runbook/);
});

test("the clock is the real one on this machine", () => {
  const result = runTool({ name: "current_datetime", arguments: {} }, context);

  assert.equal(result.ok, true);
  assert.match(result.content, /2026/);
});
