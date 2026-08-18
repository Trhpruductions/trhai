import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// A workspace of its own. Without this the build tools write into the repo:
// an earlier run of these tests left apps/api/workspace/it-nice behind, which
// is a test quietly modifying the project it is testing.
const testWorkspace = mkdtempSync(path.join(tmpdir(), "ascend-agent-"));
process.env.ASCEND_WORKSPACE = testWorkspace;
import { maxToolRounds, runAgent, systemPrompt } from "../src/services/agentLoop.js";
import { runTool, toolDefinitions, type ToolContext } from "../src/services/agentTools.js";
import { looksLikeRawToolCalls } from "../src/services/agentLoop.js";
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

const configFor = (baseUrl: string): LocalModelConfig =>
  ({ baseUrl, model: "llama3.2", modelFromEnv: true, timeoutMs: 4000 });

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
  assert.match(systemPrompt, /An empty tool result means the USER has not recorded that/);
  assert.match(systemPrompt, /Never claim you saved, found or did something/);
});

test("the system prompt tells it to answer every part of a question", () => {
  // A two-part question was answered with the first half and stopped. Sending
  // it to the agent only helps if the agent is told to cover both.
  assert.match(systemPrompt, /asks for more than one thing, answer every part/);
});

test("the system prompt forbids hunting for the date in the user's notes", () => {
  // Asked the database and the date, it searched memory and documents for the
  // date, found nothing, and said "the current date is not recorded" — with
  // the clock available the whole time.
  assert.match(systemPrompt, /date is never in their notes or documents/);
});

test("the system prompt separates the user's facts from general knowledge", () => {
  // Asked "what is a semaphore?", llama3.1:8b searched the user's documents,
  // found nothing, and concluded it did not know what a semaphore is. The
  // smaller model had answered it correctly. A model that follows instructions
  // more literally exposed that the prompt never drew this distinction.
  assert.match(systemPrompt, /Questions about the WORLD/);
  assert.match(systemPrompt, /Do not search the user's private notes/);
  assert.match(systemPrompt, /topic is unknowable/);
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

// ---- The tools added after the first four -------------------------------

const richContext: ToolContext = {
  ...context,
  documents: [
    { id: "d1", title: "Runbook", body: "Rollback procedure: run scripts/rollback.sh." },
    { id: "d2", title: "Onboarding", body: "New starters get a laptop on day one." }
  ]
};

test("listing memories returns what is actually stored", () => {
  const result = runTool({ name: "list_memories", arguments: {} }, richContext);

  assert.equal(result.ok, true);
  assert.match(result.content, /Postgres 16/);
});

test("listing memories on an empty store says it is empty", () => {
  const result = runTool({ name: "list_memories", arguments: {} }, { ...richContext, memories: [] });

  assert.equal(result.ok, false);
  assert.match(result.content, /nothing saved in memory/);
});

test("forget matches the stored wording rather than trusting an id", () => {
  // The model repeats text back; an id it invented would delete the wrong thing.
  const removed: string[] = [];
  const result = runTool(
    { name: "forget", arguments: { fact: "The billing database is Postgres 16." } },
    { ...richContext, forgetMemory: (id) => { removed.push(id); return true; } }
  );

  assert.equal(result.ok, true);
  assert.deepEqual(removed, ["m1"]);
});

test("forget deletes nothing when nothing matches", () => {
  const removed: string[] = [];
  const result = runTool(
    { name: "forget", arguments: { fact: "my shoe size" } },
    { ...richContext, forgetMemory: (id) => { removed.push(id); return true; } }
  );

  assert.equal(result.ok, false);
  assert.match(result.content, /nothing was deleted/);
  assert.deepEqual(removed, [], "nothing may be deleted on a miss");
});

test("documents can be listed and read", () => {
  const listed = runTool({ name: "list_documents", arguments: {} }, richContext);
  assert.equal(listed.ok, true);
  assert.match(listed.content, /Runbook/);

  const read = runTool({ name: "read_document", arguments: { title: "Runbook" } }, richContext);
  assert.equal(read.ok, true);
  assert.match(read.content, /rollback\.sh/);
});

test("a missing document is refused with the titles that do exist", () => {
  // So the model can correct itself next round instead of guessing again.
  const result = runTool({ name: "read_document", arguments: { title: "Payroll" } }, richContext);

  assert.equal(result.ok, false);
  assert.match(result.content, /Runbook/);
  assert.match(result.content, /Onboarding/);
});

test("a long document is truncated and says so", () => {
  const result = runTool(
    { name: "read_document", arguments: { title: "Long" } },
    { ...richContext, documents: [{ id: "d3", title: "Long", body: "x".repeat(9000) }] }
  );

  assert.equal(result.ok, true);
  assert.match(result.content, /truncated/);
});

test("writing a document reports what was actually written", () => {
  const written: Array<[string, string]> = [];
  const result = runTool(
    { name: "write_document", arguments: { title: "Notes", content: "Some notes." } },
    { ...richContext, saveDocument: (title, body) => { written.push([title, body]); return true; } }
  );

  assert.equal(result.ok, true);
  assert.deepEqual(written, [["Notes", "Some notes."]]);
});

test("writing with nowhere to save reports that nothing was written", () => {
  const result = runTool(
    { name: "write_document", arguments: { title: "Notes", content: "Some notes." } },
    richContext
  );

  assert.equal(result.ok, false);
  assert.match(result.content, /nothing was written/);
});

test("the calculator is exact where the model is not", () => {
  const result = runTool({ name: "calculate", arguments: { expression: "(12.5 * 3) + 7" } }, richContext);

  assert.equal(result.ok, true);
  assert.match(result.content, /44\.5/);
});

test("the calculator refuses code rather than running it", () => {
  const result = runTool({ name: "calculate", arguments: { expression: "process.exit(1)" } }, richContext);

  assert.equal(result.ok, false);
});

test("plan_app describes what would be built", () => {
  const result = runTool(
    { name: "plan_app", arguments: { description: "an app to track invoices with a client name, amount and due date" } },
    richContext
  );

  assert.equal(result.ok, true);
  assert.match(result.content, /invoice/i);
});

// ---- Editing, pinning, conversation search, and dates --------------------

const editContext: ToolContext = {
  ...context,
  documents: [
    { id: "d1", title: "Runbook", body: "Rollback procedure: run scripts/rollback.sh." },
    { id: "d2", title: "Onboarding", body: "New starters get a laptop on day one." }
  ],
  conversation: [
    { role: "user", content: "The staging server is called halifax." },
    { role: "assistant", content: "Noted." },
    { role: "user", content: "We deploy on Fridays after the standup." }
  ]
};

test("updating a document replaces the one that exists", () => {
  const updates: Array<[string, string]> = [];
  const result = runTool(
    { name: "update_document", arguments: { title: "Runbook", content: "New procedure." } },
    { ...editContext, updateDocument: (id, body) => { updates.push([id, body]); return true; } }
  );

  assert.equal(result.ok, true);
  assert.deepEqual(updates, [["d1", "New procedure."]]);
});

test("updating a document that does not exist creates nothing", () => {
  // A model that misremembers a title would otherwise silently make a second
  // document instead of editing the one the user meant.
  const updates: string[] = [];
  const result = runTool(
    { name: "update_document", arguments: { title: "Payroll", content: "x" } },
    { ...editContext, updateDocument: (id) => { updates.push(id); return true; } }
  );

  assert.equal(result.ok, false);
  assert.deepEqual(updates, []);
  assert.match(result.content, /Runbook/);
});

test("deleting a document reports what was deleted", () => {
  const deleted: string[] = [];
  const result = runTool(
    { name: "delete_document", arguments: { title: "Onboarding" } },
    { ...editContext, deleteDocument: (id) => { deleted.push(id); return true; } }
  );

  assert.equal(result.ok, true);
  assert.deepEqual(deleted, ["d2"]);
});

test("deleting a document that does not exist deletes nothing", () => {
  const deleted: string[] = [];
  const result = runTool(
    { name: "delete_document", arguments: { title: "Nonsense" } },
    { ...editContext, deleteDocument: (id) => { deleted.push(id); return true; } }
  );

  assert.equal(result.ok, false);
  assert.deepEqual(deleted, []);
});

test("pinning marks the matching memory", () => {
  const pins: Array<[string, boolean]> = [];
  const result = runTool(
    { name: "pin_memory", arguments: { fact: "The billing database is Postgres 16." } },
    { ...editContext, pinMemory: (id, pinned) => { pins.push([id, pinned]); return true; } }
  );

  assert.equal(result.ok, true);
  assert.deepEqual(pins, [["m1", true]]);
});

test("pinning defaults to pinning, and unpins only when asked", () => {
  const pins: boolean[] = [];
  const pinMemory = (_id: string, pinned: boolean) => { pins.push(pinned); return true; };

  runTool({ name: "pin_memory", arguments: { fact: "Postgres 16" } }, { ...editContext, pinMemory });
  runTool(
    { name: "pin_memory", arguments: { fact: "Postgres 16", pinned: false } },
    { ...editContext, pinMemory }
  );

  assert.deepEqual(pins, [true, false]);
});

test("pinning something that is not saved marks nothing", () => {
  const pins: string[] = [];
  const result = runTool(
    { name: "pin_memory", arguments: { fact: "my shoe size" } },
    { ...editContext, pinMemory: (id) => { pins.push(id); return true; } }
  );

  assert.equal(result.ok, false);
  assert.deepEqual(pins, []);
});

test("the conversation can be searched for something never saved", () => {
  // "halifax" was said, not remembered. Without this the assistant cannot
  // answer about it once it falls out of the context window.
  const result = runTool(
    { name: "search_conversation", arguments: { query: "staging server name" } },
    editContext
  );

  assert.equal(result.ok, true);
  assert.match(result.content, /halifax/);
});

test("a conversation search says plainly when nothing matches", () => {
  const result = runTool(
    { name: "search_conversation", arguments: { query: "pension scheme" } },
    editContext
  );

  assert.equal(result.ok, false);
  assert.match(result.content, /Nothing earlier in this conversation matches/);
});

test("an empty conversation says so rather than looking like a miss", () => {
  const result = runTool(
    { name: "search_conversation", arguments: { query: "anything" } },
    { ...editContext, conversation: [] }
  );

  assert.equal(result.ok, false);
  assert.match(result.content, /Nothing has been said/);
});

test("days between two dates is exact", () => {
  const result = runTool(
    { name: "days_between", arguments: { from: "2026-08-17", to: "2026-08-24" } },
    editContext
  );

  assert.equal(result.ok, true);
  assert.match(result.content, /7 days after/);
});

test("days between resolves 'today' against the machine clock", () => {
  // The fixed clock in this context is 17 August 2026.
  const result = runTool(
    { name: "days_between", arguments: { from: "today", to: "2026-08-27" } },
    editContext
  );

  assert.equal(result.ok, true);
  assert.match(result.content, /10 days after/);
});

test("shifting a date forwards", () => {
  const result = runTool(
    { name: "shift_date", arguments: { from: "2026-08-17", days: 90 } },
    editContext
  );

  assert.equal(result.ok, true);
  assert.match(result.content, /November/);
});

test("a date the tool cannot read is refused, not guessed", () => {
  const result = runTool(
    { name: "days_between", arguments: { from: "sometime", to: "2026-08-17" } },
    editContext
  );

  assert.equal(result.ok, false);
  assert.match(result.content, /sometime/);
});


// ---- Building, and files on disk ----------------------------------------

test("every advertised tool is still implemented", () => {
  // Re-asserted after each batch: a tool the model can see but cannot call is
  // a promise the app breaks.
  for (const definition of toolDefinitions) {
    const result = runTool({ name: definition.function.name, arguments: {} }, editContext);
    assert.ok(
      !/There is no tool called/.test(result.content),
      `${definition.function.name} is advertised but not implemented`
    );
  }
});

test("build_app writes a real, runnable project to disk", () => {
  // The whole point of this tool: not a description of an app, an app.
  const result = runTool(
    {
      name: "build_app",
      arguments: { description: "an app to track invoices with a client name, amount and due date" }
    },
    editContext
  );

  assert.equal(result.ok, true, result.content);
  assert.match(result.content, /package\.json/);
  assert.match(result.content, /server\.js/);
  assert.match(result.content, /npm install/);

  // Read one back off disk rather than trusting the report. A tool that says
  // it built something and did not is exactly the failure this codebase keeps
  // being written against.
  const folder = /workspace at ([^/]+)\//.exec(result.content)?.[1];
  assert.ok(folder, `no folder named in: ${result.content}`);

  const server = readFileSync(path.join(testWorkspace, folder!, "server.js"), "utf8");
  assert.match(server, /createServer|listen/);
});

test("a build reports nothing when there is nothing to build", () => {
  const result = runTool({ name: "build_app", arguments: { description: "" } }, editContext);

  assert.equal(result.ok, false);
  assert.match(result.content, /needs a description/);
});

test("read_file refuses a path outside the workspace", () => {
  // The tool layer must not be a way around the containment check.
  const result = runTool({ name: "read_file", arguments: { path: "../../etc/passwd" } }, editContext);

  assert.equal(result.ok, false);
  assert.match(result.content, /outside the workspace/);
});

test("write_file refuses a path outside the workspace and writes nothing", () => {
  const result = runTool(
    { name: "write_file", arguments: { path: "../escape.txt", content: "x" } },
    editContext
  );

  assert.equal(result.ok, false);
  assert.match(result.content, /Nothing was written/);
});

test("list_files refuses to list outside the workspace", () => {
  const result = runTool({ name: "list_files", arguments: { directory: ".." } }, editContext);

  assert.equal(result.ok, false);
  assert.match(result.content, /outside the workspace/);
});

test("a model that cannot be loaded is reported as unusable, not just failed", async () => {
  // Ollama answers 500 with "cudaMalloc failed: out of memory" when a model
  // does not fit. The caller can act on that by trying a smaller one — but
  // only if the difference is reported.
  const server = createServer((_request, response) => {
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      error: "llama-server process has terminated: exit status 1: cudaMalloc failed: out of memory"
    }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const result = await runAgent(configFor(baseUrl), "anything", context);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.modelUnusable, true);
    assert.match(result.reason, /could not be loaded/);
    assert.match(result.reason, /out of memory/);
  } finally {
    server.close();
  }
});

test("an ordinary failure is not mistaken for an unusable model", async () => {
  // A 400 means the request was wrong, and trying every other installed model
  // against it would just make the user wait.
  const server = createServer((_request, response) => {
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "bad request" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const result = await runAgent(configFor(baseUrl), "anything", context);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.notEqual(result.modelUnusable, true);
  } finally {
    server.close();
  }
});


test("tool calls written as text are recognised, not shown as an answer", () => {
  // Seen from llama3.2 in the running app: it ignored the tool interface and
  // wrote the calls it wanted into the message body, and that JSON reached the
  // user as their answer.
  assert.equal(looksLikeRawToolCalls(
    '{"name": "search_document", "parameters": {"query": "billing"}}\n'
    + '{"name": "current_datetime", "parameters": {}}'
  ), true);

  assert.equal(looksLikeRawToolCalls('{"name": "current_datetime", "parameters": {}}'), true);
});

test("ordinary prose is never mistaken for tool calls", () => {
  for (const text of [
    "Your billing database is Postgres 16.",
    "The date is Tuesday, August 18, 2026.",
    'A JSON object looks like {"a": 1} in most languages.',
    "",
    "{ this is not json at all }"
  ]) {
    assert.equal(looksLikeRawToolCalls(text), false, text);
  }
});

test("a reply that is only tool-call JSON is refused", async () => {
  const { server, baseUrl } = await fakeModel([
    answer('{"name": "current_datetime", "parameters": {}}')
  ]);

  try {
    const result = await runAgent(configFor(baseUrl), "what is the date?", context);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /tool calls as text/);
  } finally {
    server.close();
  }
});
