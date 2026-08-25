import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// A workspace of its own. Without this the build tools write into the repo:
// an earlier run of these tests left apps/api/workspace/it-nice behind, which
// is a test quietly modifying the project it is testing.
const testWorkspace = mkdtempSync(path.join(tmpdir(), "ascend-agent-"));
process.env.ASCEND_WORKSPACE = testWorkspace;
import { maxToolRounds, runAgent, systemPrompt } from "../src/services/agentLoop.js";
import { runTool, toolDefinitions, type ToolContext } from "../src/services/agentTools.js";
import { looksLikeRawToolCalls, parseTextToolCalls } from "../src/services/agentLoop.js";
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

// Two calls the model asked for in the same response, neither having seen
// the other's result yet — the shape a single `toolCall` cannot express, and
// the shape the live fetch_url-then-build_app bug actually was.
const multiToolCall = (...entries: Array<[string, Record<string, unknown>]>) => ({
  message: {
    content: "",
    tool_calls: entries.map(([name, args]) => ({ function: { name, arguments: args } }))
  }
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

    assert.deepEqual(result.toolsUsed, [{ name: "search_memory", ok: true }]);
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
    assert.deepEqual(result.toolsUsed, [
      { name: "search_memory", ok: true },
      { name: "search_documents", ok: true }
    ]);
  } finally {
    server.close();
  }
});

test("a model that never concludes is stopped rather than left running", async () => {
  // Without the bound this is a hang: the request runs until it times out and
  // the app looks like it stopped responding.
  //
  // This script also happens to be the exact shape the anti-repeat guard
  // exists for — the same call, unchanged, every round — so the cheaper stop
  // now fires first: two real attempts, then two refused repeats, then the
  // round limit withholds tools on the final round and forces the same
  // "kept searching" verdict this test has always checked for. The round
  // limit is still real and still the backstop; it is just no longer what
  // ends this particular scenario.
  const { server, baseUrl, received } = await fakeModel([toolCall("search_memory", { query: "again" })]);

  try {
    const result = await runAgent(configFor(baseUrl), "Loop forever", context);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /without reaching an answer/);
    assert.equal(result.toolsUsed.length, 2);
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

test("an empty reply marks the model unusable so another is tried", async () => {
  // Found live. "Write a Python function that adds two numbers" got an empty
  // reply from the default model in about a second; the caller treated that
  // as a considered failure, stopped, and showed a generic four-step
  // planning template as though it were the answer. A coder model already
  // installed on the same machine answered it correctly. An empty reply is
  // the model producing nothing at all, not a judgement about the question,
  // so the next candidate deserves a turn.
  const { server, baseUrl } = await fakeModel([answer("")]);

  try {
    const result = await runAgent(configFor(baseUrl), "anything", context);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.modelUnusable, true);
  } finally {
    server.close();
  }
});

test("a model that keeps calling tools is not marked unusable", async () => {
  // The opposite case, and the reason this is not just "any failure retries".
  // A model that loaded and worked but never concluded will do the same on
  // the next question; cycling every installed model against it only makes
  // the user wait longer for the same outcome.
  const { server, baseUrl } = await fakeModel([
    { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "current_datetime", arguments: {} } }] } },
    { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "current_datetime", arguments: {} } }] } },
    { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "current_datetime", arguments: {} } }] } },
    { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "current_datetime", arguments: {} } }] } },
    { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "current_datetime", arguments: {} } }] } },
    { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "current_datetime", arguments: {} } }] } }
  ]);

  try {
    const result = await runAgent(configFor(baseUrl), "what time is it", context);
    assert.equal(result.ok, false);
    assert.ok(!(result.ok === false && result.modelUnusable), "swapping models will not help here");
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

test("every advertised tool is actually implemented", async () => {
  // A tool the model can see but cannot call is a promise the app breaks.
  for (const definition of toolDefinitions) {
    const result = await runTool({ name: definition.function.name, arguments: {} }, context);
    assert.ok(
      !/There is no tool called/.test(result.content),
      `${definition.function.name} is advertised but not implemented`
    );
  }
});

test("an unregistered tool name is refused with what is actually callable", async () => {
  // A name this app never advertised still reaches runTool unfiltered from
  // the native tool_calls path — parseToolCalls does not gate on known
  // names, only parseTextToolCalls does. Refusing here has to say what does
  // exist, not just that this one does not, or the model has nothing to
  // correct toward on the next round.
  const result = await runTool({ name: "update_file", arguments: {} }, context);

  assert.equal(result.ok, false);
  assert.match(result.content, /no tool called "update_file"/);
  assert.match(result.content, /write_file/);
  assert.match(result.content, /read_file/);
});

test("a save with nowhere to write reports that nothing was stored", async () => {
  const result = await runTool({ name: "remember", arguments: { fact: "I like tea." } }, context);

  assert.equal(result.ok, false);
  assert.match(result.content, /nothing was saved/);
});

test("a successful save says what was saved", async () => {
  const saved: string[] = [];
  const result = await runTool(
    { name: "remember", arguments: { fact: "I like tea." } },
    { ...context, saveMemory: (fact) => { saved.push(fact); return "saved"; } }
  );

  assert.equal(result.ok, true);
  assert.deepEqual(saved, ["I like tea."]);
});

test("saving a fact already in memory is a success, not a reported failure", async () => {
  // Caught live: told a fact was already saved and told explicitly not to
  // save it again, the model called remember on it anyway. The store's own
  // duplicate check correctly suppressed the redundant write, and the tool
  // then reported "the save did not go through, so nothing was stored" for
  // it — which reads as a real failure to whoever is reading the reply, when
  // nothing was actually wrong. The store is the one place that genuinely
  // knows whether a fact is new; its answer is trusted rather than guessed at
  // with a second, less reliable check in this file.
  const attempts: string[] = [];
  const result = await runTool(
    { name: "remember", arguments: { fact: "The billing database is Postgres 16." } },
    { ...context, saveMemory: (fact) => { attempts.push(fact); return "duplicate"; } }
  );

  assert.equal(result.ok, true);
  assert.match(result.content, /Already saved/);
  // The call does reach the store — that is what makes the "duplicate"
  // answer authoritative rather than a guess made without asking it.
  assert.deepEqual(attempts, ["The billing database is Postgres 16."]);
});

test("a save that extracted nothing is reported as the real failure it is", async () => {
  const result = await runTool(
    { name: "remember", arguments: { fact: "I like tea." } },
    { ...context, saveMemory: () => "empty" }
  );

  assert.equal(result.ok, false);
  assert.match(result.content, /did not go through/);
});

test("a document result carries the document it came from", async () => {
  const result = await runTool({ name: "search_documents", arguments: { query: "rollback procedure" } }, context);

  assert.equal(result.ok, true);
  assert.match(result.content, /Runbook/);
});

test("the clock is the real one on this machine", async () => {
  const result = await runTool({ name: "current_datetime", arguments: {} }, context);

  assert.equal(result.ok, true);
  assert.match(result.content, /2026/);
});

// fetch_url's own SSRF, size and timeout defences are covered directly in
// web-fetch.test.ts; these check runTool's dispatch around it — argument
// validation, and how a real result gets formatted into what the model
// reads — using the injected fetchPage so no network call happens here.

test("fetch_url needs a url argument", async () => {
  const result = await runTool({ name: "fetch_url", arguments: {} }, context);
  assert.equal(result.ok, false);
  assert.match(result.content, /needs a url/);
});

test("a fetched page is handed back with its title and address", async () => {
  const withFetch: ToolContext = {
    ...context,
    fetchPage: async () => ({
      ok: true,
      url: "https://example.com/",
      title: "Example Domain",
      text: "This domain is for use in illustrative examples.",
      truncated: false
    })
  };

  const result = await runTool({ name: "fetch_url", arguments: { url: "https://example.com/" } }, withFetch);
  assert.equal(result.ok, true);
  assert.match(result.content, /Example Domain/);
  assert.match(result.content, /https:\/\/example\.com\//);
  assert.match(result.content, /illustrative examples/);
});

test("a truncated page says so, so the model does not treat a partial read as the whole page", async () => {
  const withFetch: ToolContext = {
    ...context,
    fetchPage: async () => ({
      ok: true,
      url: "https://example.com/long",
      title: "A Long Page",
      text: "the first part…",
      truncated: true
    })
  };

  const result = await runTool({ name: "fetch_url", arguments: { url: "https://example.com/long" } }, withFetch);
  assert.equal(result.ok, true);
  assert.match(result.content, /showing the first part/i);
});

test("a refused fetch passes its real reason back, not a generic failure", async () => {
  const withFetch: ToolContext = {
    ...context,
    fetchPage: async () => ({ ok: false, reason: "That page is too large to read." })
  };

  const result = await runTool({ name: "fetch_url", arguments: { url: "https://example.com/huge" } }, withFetch);
  assert.equal(result.ok, false);
  assert.match(result.content, /too large to read/);
});

test("fetch_url runs without confirmation, the same as any other read-only tool", async () => {
  // Reading a page changes nothing on this machine, so it belongs at the
  // same level as search_memory or list_files, not gated like forget.
  const withFetch: ToolContext = {
    ...context,
    fetchPage: async () => ({ ok: true, url: "https://example.com/", title: "x", text: "x", truncated: false })
  };

  const result = await runTool({ name: "fetch_url", arguments: { url: "https://example.com/" } }, withFetch);
  assert.equal(result.needsConfirmation, undefined);
});

// ---- The tools added after the first four -------------------------------

const richContext: ToolContext = {
  ...context,
  documents: [
    { id: "d1", title: "Runbook", body: "Rollback procedure: run scripts/rollback.sh." },
    { id: "d2", title: "Onboarding", body: "New starters get a laptop on day one." }
  ]
};

test("listing memories returns what is actually stored", async () => {
  const result = await runTool({ name: "list_memories", arguments: {} }, richContext);

  assert.equal(result.ok, true);
  assert.match(result.content, /Postgres 16/);
});

test("listing memories on an empty store says it is empty", async () => {
  const result = await runTool({ name: "list_memories", arguments: {} }, { ...richContext, memories: [] });

  assert.equal(result.ok, false);
  assert.match(result.content, /nothing saved in memory/);
});

test("forget matches the stored wording rather than trusting an id", async () => {
  // The model repeats text back; an id it invented would delete the wrong thing.
  const removed: string[] = [];
  const result = await runTool(
    { name: "forget", arguments: { fact: "The billing database is Postgres 16." } },
    { ...richContext, forgetMemory: (id) => { removed.push(id); return true; }, confirmedActions: new Set(["forget"]) }
  );

  assert.equal(result.ok, true);
  assert.deepEqual(removed, ["m1"]);
});

test("forget deletes nothing when nothing matches", async () => {
  const removed: string[] = [];
  const result = await runTool(
    { name: "forget", arguments: { fact: "my shoe size" } },
    { ...richContext, forgetMemory: (id) => { removed.push(id); return true; }, confirmedActions: new Set(["forget"]) }
  );

  assert.equal(result.ok, false);
  assert.match(result.content, /nothing was deleted/);
  assert.deepEqual(removed, [], "nothing may be deleted on a miss");
});

test("documents can be listed and read", async () => {
  const listed = await runTool({ name: "list_documents", arguments: {} }, richContext);
  assert.equal(listed.ok, true);
  assert.match(listed.content, /Runbook/);

  const read = await runTool({ name: "read_document", arguments: { title: "Runbook" } }, richContext);
  assert.equal(read.ok, true);
  assert.match(read.content, /rollback\.sh/);
});

test("a missing document is refused with the titles that do exist", async () => {
  // So the model can correct itself next round instead of guessing again.
  const result = await runTool({ name: "read_document", arguments: { title: "Payroll" } }, richContext);

  assert.equal(result.ok, false);
  assert.match(result.content, /Runbook/);
  assert.match(result.content, /Onboarding/);
});

test("a long document is truncated and says so", async () => {
  const result = await runTool(
    { name: "read_document", arguments: { title: "Long" } },
    { ...richContext, documents: [{ id: "d3", title: "Long", body: "x".repeat(9000) }] }
  );

  assert.equal(result.ok, true);
  assert.match(result.content, /truncated/);
});

test("writing a document reports what was actually written", async () => {
  const written: Array<[string, string]> = [];
  const result = await runTool(
    { name: "write_document", arguments: { title: "Notes", content: "Some notes." } },
    { ...richContext, saveDocument: (title, body) => { written.push([title, body]); return true; } }
  );

  assert.equal(result.ok, true);
  assert.deepEqual(written, [["Notes", "Some notes."]]);
});

test("writing with nowhere to save reports that nothing was written", async () => {
  const result = await runTool(
    { name: "write_document", arguments: { title: "Notes", content: "Some notes." } },
    richContext
  );

  assert.equal(result.ok, false);
  assert.match(result.content, /nothing was written/);
});

test("the calculator is exact where the model is not", async () => {
  const result = await runTool({ name: "calculate", arguments: { expression: "(12.5 * 3) + 7" } }, richContext);

  assert.equal(result.ok, true);
  assert.match(result.content, /44\.5/);
});

test("the calculator refuses code rather than running it", async () => {
  const result = await runTool({ name: "calculate", arguments: { expression: "process.exit(1)" } }, richContext);

  assert.equal(result.ok, false);
});

test("a real tool called with a missing required argument fails honestly, not by crashing", async () => {
  // The parsing-layer tests above cover a call that is malformed, unknown, or
  // to a tool that does not exist. This is the other half of "invalid tool
  // calls": a genuine, advertised tool, reached correctly, given nothing (or
  // the wrong type) for a required argument — the shape a model produces
  // when it decides to call a tool before it has actually worked out what to
  // put in it. Every handler already guards this with requireString; this is
  // what stops that guard from being able to silently regress.
  const noExpression = await runTool({ name: "calculate", arguments: {} }, richContext);
  assert.equal(noExpression.ok, false);
  assert.match(noExpression.content, /expression/i);

  const wrongTypeExpression = await runTool(
    { name: "calculate", arguments: { expression: 47 } },
    richContext
  );
  assert.equal(wrongTypeExpression.ok, false);

  const noContent = await runTool({ name: "write_file", arguments: { path: "notes.txt" } }, richContext);
  assert.equal(noContent.ok, false);
  assert.match(noContent.content, /path and content/i);

  const noPath = await runTool({ name: "write_file", arguments: { content: "hello" } }, richContext);
  assert.equal(noPath.ok, false);

  const emptyFact = await runTool({ name: "remember", arguments: { fact: "" } }, richContext);
  assert.equal(emptyFact.ok, false);
  assert.match(emptyFact.content, /fact to save/i);

  const noQuery = await runTool({ name: "search_memory", arguments: {} }, richContext);
  assert.equal(noQuery.ok, false);
  assert.match(noQuery.content, /query/i);
});

test("plan_app describes what would be built", async () => {
  const result = await runTool(
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

test("updating a document replaces the one that exists", async () => {
  const updates: Array<[string, string]> = [];
  const result = await runTool(
    { name: "update_document", arguments: { title: "Runbook", content: "New procedure." } },
    { ...editContext, updateDocument: (id, body) => { updates.push([id, body]); return true; } }
  );

  assert.equal(result.ok, true);
  assert.deepEqual(updates, [["d1", "New procedure."]]);
});

test("updating a document that does not exist creates nothing", async () => {
  // A model that misremembers a title would otherwise silently make a second
  // document instead of editing the one the user meant.
  const updates: string[] = [];
  const result = await runTool(
    { name: "update_document", arguments: { title: "Payroll", content: "x" } },
    { ...editContext, updateDocument: (id) => { updates.push(id); return true; } }
  );

  assert.equal(result.ok, false);
  assert.deepEqual(updates, []);
  assert.match(result.content, /Runbook/);
});

test("a missing-document refusal points at write_file when the name is really a file", async () => {
  // Caught live: "Update test.txt to say X" led the model to update_document,
  // which correctly found no document by that name — but test.txt was a real
  // workspace file the whole time, and the plain "no such document" refusal
  // gave the model nothing to correct toward, so it reached for
  // write_document next instead of write_file.
  writeFileSync(path.join(testWorkspace, "real-file.txt"), "hello", "utf8");

  const result = await runTool(
    { name: "update_document", arguments: { title: "real-file.txt", content: "x" } },
    { ...editContext, updateDocument: () => true }
  );

  assert.equal(result.ok, false);
  assert.match(result.content, /real-file\.txt.*workspace/);
  assert.match(result.content, /write_file/);
});

test("write_document refuses when the name is actually a workspace file", async () => {
  // The other half of the same live failure: update_document's miss was
  // recoverable, but the model's actual next move was write_document, which
  // has no existing-document check to fail against — it just created a
  // stray document named "test.txt", left the real file untouched, and the
  // assistant reported the file itself as changed. This is the one place
  // left that can still catch it.
  writeFileSync(path.join(testWorkspace, "test.txt"), "VEXORA WORKS", "utf8");

  const written: Array<[string, string]> = [];
  const result = await runTool(
    { name: "write_document", arguments: { title: "test.txt", content: "VEXORA CONFIRMED" } },
    { ...editContext, saveDocument: (title, body) => { written.push([title, body]); return true; } }
  );

  assert.equal(result.ok, false);
  assert.deepEqual(written, []);
  assert.match(result.content, /write_file/);
  assert.equal(readFileSync(path.join(testWorkspace, "test.txt"), "utf8"), "VEXORA WORKS");
});

test("deleting a document reports what was deleted", async () => {
  const deleted: string[] = [];
  const result = await runTool(
    { name: "delete_document", arguments: { title: "Onboarding" } },
    { ...editContext, deleteDocument: (id) => { deleted.push(id); return true; }, confirmedActions: new Set(["delete_document"]) }
  );

  assert.equal(result.ok, true);
  assert.deepEqual(deleted, ["d2"]);
});

test("deleting a document that does not exist deletes nothing", async () => {
  const deleted: string[] = [];
  const result = await runTool(
    { name: "delete_document", arguments: { title: "Nonsense" } },
    { ...editContext, deleteDocument: (id) => { deleted.push(id); return true; }, confirmedActions: new Set(["delete_document"]) }
  );

  assert.equal(result.ok, false);
  assert.deepEqual(deleted, []);
});

test("pinning marks the matching memory", async () => {
  const pins: Array<[string, boolean]> = [];
  const result = await runTool(
    { name: "pin_memory", arguments: { fact: "The billing database is Postgres 16." } },
    { ...editContext, pinMemory: (id, pinned) => { pins.push([id, pinned]); return true; } }
  );

  assert.equal(result.ok, true);
  assert.deepEqual(pins, [["m1", true]]);
});

test("pinning defaults to pinning, and unpins only when asked", async () => {
  const pins: boolean[] = [];
  const pinMemory = (_id: string, pinned: boolean) => { pins.push(pinned); return true; };

  await runTool({ name: "pin_memory", arguments: { fact: "Postgres 16" } }, { ...editContext, pinMemory });
  await runTool(
    { name: "pin_memory", arguments: { fact: "Postgres 16", pinned: false } },
    { ...editContext, pinMemory }
  );

  assert.deepEqual(pins, [true, false]);
});

test("pinning something that is not saved marks nothing", async () => {
  const pins: string[] = [];
  const result = await runTool(
    { name: "pin_memory", arguments: { fact: "my shoe size" } },
    { ...editContext, pinMemory: (id) => { pins.push(id); return true; } }
  );

  assert.equal(result.ok, false);
  assert.deepEqual(pins, []);
});

test("the conversation can be searched for something never saved", async () => {
  // "halifax" was said, not remembered. Without this the assistant cannot
  // answer about it once it falls out of the context window.
  const result = await runTool(
    { name: "search_conversation", arguments: { query: "staging server name" } },
    editContext
  );

  assert.equal(result.ok, true);
  assert.match(result.content, /halifax/);
});

test("a conversation search says plainly when nothing matches", async () => {
  const result = await runTool(
    { name: "search_conversation", arguments: { query: "pension scheme" } },
    editContext
  );

  assert.equal(result.ok, false);
  assert.match(result.content, /Nothing earlier in this conversation matches/);
});

test("an empty conversation says so rather than looking like a miss", async () => {
  const result = await runTool(
    { name: "search_conversation", arguments: { query: "anything" } },
    { ...editContext, conversation: [] }
  );

  assert.equal(result.ok, false);
  assert.match(result.content, /Nothing has been said/);
});

test("days between two dates is exact", async () => {
  const result = await runTool(
    { name: "days_between", arguments: { from: "2026-08-17", to: "2026-08-24" } },
    editContext
  );

  assert.equal(result.ok, true);
  assert.match(result.content, /7 days after/);
});

test("days between resolves 'today' against the machine clock", async () => {
  // The fixed clock in this context is 17 August 2026.
  const result = await runTool(
    { name: "days_between", arguments: { from: "today", to: "2026-08-27" } },
    editContext
  );

  assert.equal(result.ok, true);
  assert.match(result.content, /10 days after/);
});

test("shifting a date forwards", async () => {
  const result = await runTool(
    { name: "shift_date", arguments: { from: "2026-08-17", days: 90 } },
    editContext
  );

  assert.equal(result.ok, true);
  assert.match(result.content, /November/);
});

test("a date the tool cannot read is refused, not guessed", async () => {
  const result = await runTool(
    { name: "days_between", arguments: { from: "sometime", to: "2026-08-17" } },
    editContext
  );

  assert.equal(result.ok, false);
  assert.match(result.content, /sometime/);
});


// ---- Building, and files on disk ----------------------------------------

test("every advertised tool is still implemented", async () => {
  // Re-asserted after each batch: a tool the model can see but cannot call is
  // a promise the app breaks.
  for (const definition of toolDefinitions) {
    const result = await runTool({ name: definition.function.name, arguments: {} }, editContext);
    assert.ok(
      !/There is no tool called/.test(result.content),
      `${definition.function.name} is advertised but not implemented`
    );
  }
});

test("build_app writes a real, runnable project to disk, and verifies it runs", async () => {
  // The whole point of this tool: not a description of an app, an app — and
  // not just written, but actually run and checked before being reported as
  // done. Every generated project ships its own smoke test with zero
  // dependencies, and build_app now runs it rather than trusting the write.
  const result = await runTool(
    {
      name: "build_app",
      arguments: { description: "an app to track invoices with a client name, amount and due date" }
    },
    editContext
  );

  assert.equal(result.ok, true, result.content);
  assert.match(result.content, /verified it/);
  assert.match(result.content, /\d+\/\d+ checks passed/);
  assert.match(result.content, /npm install/);

  // Read one back off disk rather than trusting the report. A tool that says
  // it built something and did not is exactly the failure this codebase keeps
  // being written against.
  const folder = /workspace at ([^/]+)\//.exec(result.content)?.[1];
  assert.ok(folder, `no folder named in: ${result.content}`);

  const server = readFileSync(path.join(testWorkspace, folder!, "server.js"), "utf8");
  assert.match(server, /createServer|listen/);
});


test("build_app actually builds a calculator instead of refusing it", async () => {
  // Caught live: the model's own real description — "a simple calculator
  // application that takes in two numbers and an operator (+, -, *, /) and
  // returns the result" — genuinely names a calculator, and planProject
  // correctly returned kind: "calculator" with entities: [] by design,
  // because a calculator has nothing to store. This exact check predates
  // that archetype and only knew "empty entities" as "nothing was
  // understood", so it refused every calculator with "does not name
  // anything to store" — on exactly the condition that is normal for one.
  const result = await runTool(
    {
      name: "build_app",
      arguments: {
        description: "a simple calculator application that takes in two numbers and an "
          + "operator (+, -, *, /) and returns the result"
      }
    },
    editContext
  );

  assert.equal(result.ok, true, result.content);
  assert.doesNotMatch(result.content, /does not name anything to store/);
  assert.match(result.content, /verified it/);
  assert.match(result.content, /\d+\/\d+ checks passed/);
});

test("a build reports nothing when there is nothing to build", async () => {
  const result = await runTool({ name: "build_app", arguments: { description: "" } }, editContext);

  assert.equal(result.ok, false);
  assert.match(result.content, /needs a description/);
});

test("read_file refuses a path outside the workspace", async () => {
  // The tool layer must not be a way around the containment check.
  const result = await runTool({ name: "read_file", arguments: { path: "../../etc/passwd" } }, editContext);

  assert.equal(result.ok, false);
  assert.match(result.content, /outside the workspace/);
});

test("reading a file that genuinely is not there says so, not a fabricated success", async () => {
  // A valid, in-workspace path that simply does not exist — the ordinary
  // case, not the traversal attack above. The one behavior that must never
  // happen here is ok: true with invented content.
  const result = await runTool(
    { name: "read_file", arguments: { path: "this-file-was-never-created.txt" } },
    editContext
  );

  assert.equal(result.ok, false);
  assert.match(result.content, /this-file-was-never-created\.txt/);
});

test("write_file refuses a path outside the workspace and writes nothing", async () => {
  const result = await runTool(
    { name: "write_file", arguments: { path: "../escape.txt", content: "x" } },
    editContext
  );

  assert.equal(result.ok, false);
  assert.match(result.content, /Nothing was written/);
});

test("list_files refuses to list outside the workspace", async () => {
  const result = await runTool({ name: "list_files", arguments: { directory: ".." } }, editContext);

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

test("tool calls written as text are run, not shown and not ignored", async () => {
  // This used to be refused, which left the only model this machine can load
  // unable to use a tool at all. The model names a tool this app advertises
  // and passes arguments matching the schema it was given — the same request
  // in a different encoding.
  const { server, baseUrl } = await fakeModel([
    answer('{"name": "current_datetime", "parameters": {}}'),
    answer("It is August 2026.")
  ]);

  try {
    const result = await runAgent(configFor(baseUrl), "what is the date?", context);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.toolsUsed, [{ name: "current_datetime", ok: true }]);
    assert.match(result.text, /August 2026/);
  } finally {
    server.close();
  }
});

test("a tool the app does not advertise is dropped, never invoked", () => {
  // The name check is what makes reading the model's prose safe — not the
  // shape it happened to be written in.
  assert.deepEqual(
    parseTextToolCalls('{"name": "delete_everything", "parameters": {"path": "/"}}'),
    []
  );
  assert.deepEqual(
    parseTextToolCalls('{"name": "exec", "arguments": {"cmd": "rm -rf /"}}'),
    []
  );
});

test("a JSON array of calls is understood too", () => {
  const calls = parseTextToolCalls(
    '[{"name": "current_datetime", "parameters": {}}, {"name": "search_memory", "parameters": {"query": "x"}}]'
  );

  assert.deepEqual(calls.map((call) => call.name), ["current_datetime", "search_memory"]);
});

test("one malformed line does not discard the rest", () => {
  const calls = parseTextToolCalls(
    '{"name": "current_datetime", "parameters": {}}\n{ broken\n{"name": "list_memories", "parameters": {}}'
  );

  assert.deepEqual(calls.map((call) => call.name), ["current_datetime", "list_memories"]);
});

test("a call wrapped in commentary is recognised, not shown as the answer", () => {
  // Caught live: asked to write test.txt, the reply was "Sure, I'll write
  // that:" followed by the correct JSON call and then more text. Valid JSON,
  // but not as the whole message and not as a whole line either — the old
  // parser only ever tried those two shapes, so prose on either side of the
  // call made it invisible and the literal JSON reached the user as text
  // instead of ever running.
  const calls = parseTextToolCalls(
    'Sure, I\'ll write that:\n\n{"name": "write_file", "parameters": {"path": "test.txt", "content": "VEXORA TEST"}}\n\nDone.'
  );

  assert.deepEqual(calls, [{ name: "write_file", arguments: { path: "test.txt", content: "VEXORA TEST" } }]);
});

test("a call fenced in a ```json block is recognised", () => {
  const calls = parseTextToolCalls('```json\n{"name": "current_datetime", "parameters": {}}\n```');
  assert.deepEqual(calls, [{ name: "current_datetime", arguments: {} }]);
});

test("a brace inside the call's own content does not break the scan", () => {
  // The content being written can itself contain braces — source code, say —
  // and the scan has to tell those apart from the ones that close the call.
  const calls = parseTextToolCalls(
    'Here you go: {"name": "write_file", "parameters": '
    + '{"path": "a.js", "content": "function f() { return 1; }"}} — saved.'
  );

  assert.deepEqual(calls, [
    { name: "write_file", arguments: { path: "a.js", content: "function f() { return 1; }" } }
  ]);
});

test("a call written as name(key=\"value\") is recognised, not just JSON", () => {
  // Caught live: asked to build a calculator, the entire reply was the single
  // line build_app(description="..."). Not JSON, so the JSON branch found
  // nothing, looksLikeRawToolCalls (defined in terms of it) agreed nothing
  // looked like a call, and that literal line reached the user as their
  // answer — the tool never ran.
  assert.equal(looksLikeRawToolCalls('build_app(description="a calculator app")'), true);

  const calls = parseTextToolCalls('build_app(description="a calculator app")');
  assert.deepEqual(calls, [{ name: "build_app", arguments: { description: "a calculator app" } }]);
});

test("bare-call arguments keep their real type, not just strings", () => {
  const calls = parseTextToolCalls("shift_date(days=7, from_today=true, label='next week')");
  assert.deepEqual(calls, [
    { name: "shift_date", arguments: { days: 7, from_today: true, label: "next week" } }
  ]);
});

test("a bare call to an unadvertised tool is dropped, never invoked", () => {
  // The same gate as the JSON path, applied to the other shape.
  assert.deepEqual(parseTextToolCalls('delete_everything(path="/")'), []);
});

test("prose with parentheses is never mistaken for a bare call", () => {
  for (const text of [
    "Call me at (555) 123-4567.",
    "This is one option (see below).",
    "You could call build_app(description) to do this yourself.",
    "The function signature is roughly build_app(description: string)."
  ]) {
    assert.equal(looksLikeRawToolCalls(text), false, text);
  }
});

test("a bare call is actually run, not shown and not ignored", async () => {
  // The end-to-end version of the caught-live case above: the model's whole
  // reply is the bare call, and running it means a real tool actually
  // executes and the real result is what the user sees — not the literal
  // text of the call itself.
  const { server, baseUrl } = await fakeModel([
    answer('current_datetime()'),
    answer("Recorded.")
  ]);

  try {
    const result = await runAgent(configFor(baseUrl), "what time is it?", context);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.toolsUsed, [{ name: "current_datetime", ok: true }]);
    // The bare-call text itself must never reach the user as the answer.
    assert.ok(!result.text.includes("current_datetime("), `leaked call syntax: ${result.text}`);
  } finally {
    server.close();
  }
});

test("tool-call JSON is never shown as the answer", async () => {
  // Even on the last round, where the calls are not acted on, the JSON must
  // not be handed to the user as prose — it is the model's working.
  const { server, baseUrl } = await fakeModel([
    answer('{"name": "current_datetime", "parameters": {}}')
  ]);

  try {
    const result = await runAgent(configFor(baseUrl), "loop", context);
    if (result.ok) {
      assert.ok(!result.text.includes('"parameters"'), `leaked JSON: ${result.text}`);
    }
  } finally {
    server.close();
  }
});


test("the current date is stated to the model, not left to a tool call", async () => {
  // Asked "which database, and what is today's date?", it called search_memory
  // alone and answered "the current date is not recorded" — with the clock
  // available and the prompt telling it to use current_datetime. A model
  // cannot fail to call a tool it does not need.
  const { server, baseUrl, received } = await fakeModel([answer("Understood.")]);

  try {
    await runAgent(configFor(baseUrl), "hello", context);

    const request = received[0] as { messages: Array<{ role: string; content: string }> };
    const system = request.messages.find((message) => message.role === "system");

    // The fixed clock in this context is 17 August 2026.
    assert.match(system?.content ?? "", /2026/);
    assert.match(system?.content ?? "", /never say the date is unknown/);
  } finally {
    server.close();
  }
});

// Anti-repeat protection.
//
// Caught live: asked a capability question with nothing to search for, the
// model called search_memory, search_documents and list_documents — each one
// told it plainly there was nothing to find — and kept calling them anyway,
// sixteen calls in total before the round limit cut it off, three of them
// writes. These tests hold the earlier, cheaper stop: the third identical
// attempt at the same call never reaches the tool at all.

test("the same call with the same arguments is refused on its third attempt", async () => {
  const emptyMemoryContext: ToolContext = { ...context, memories: [] };

  // Four identical requests, then a plain answer once tools are withheld on
  // the final round — offerTools is false there regardless of what the
  // script returns, so the loop cannot end any other way.
  const { server, baseUrl, received } = await fakeModel([
    toolCall("search_memory", { query: "billing" }),
    toolCall("search_memory", { query: "billing" }),
    toolCall("search_memory", { query: "billing" }),
    toolCall("search_memory", { query: "billing" }),
    answer("I don't have anything saved about that.")
  ]);

  try {
    const result = await runAgent(configFor(baseUrl), "what is my billing setup", emptyMemoryContext);
    assert.equal(result.ok, true);

    // The tool itself only ever ran twice — toolsUsed is the record of real
    // attempts, and a refused repeat is not one of them, the same way a
    // permission refusal is not.
    const realAttempts = result.ok ? result.toolsUsed.filter((used) => used.name === "search_memory") : [];
    assert.equal(realAttempts.length, 2);

    // The final round's request carries the whole conversation so far, which
    // is where the refusal the model actually saw has to show up.
    const finalRequest = received[received.length - 1] as { messages: Array<{ role: string; content: string }> };
    const toolMessages = finalRequest.messages.filter((message) => message.role === "tool");

    const refused = toolMessages.filter((message) => message.content.includes("did not produce"));
    const ran = toolMessages.filter((message) => message.content.includes("Nothing in the user's saved memory"));

    assert.equal(ran.length, 2, "expected exactly two real tool results");
    assert.equal(refused.length, 2, "expected exactly two refused repeats");
  } finally {
    server.close();
  }
});

test("a refused repeat is never counted as a real tool use", async () => {
  const emptyMemoryContext: ToolContext = { ...context, memories: [] };
  const { server, baseUrl } = await fakeModel([
    toolCall("search_memory", { query: "billing" }),
    toolCall("search_memory", { query: "billing" }),
    toolCall("search_memory", { query: "billing" }),
    answer("Nothing is recorded about that.")
  ]);

  try {
    const result = await runAgent(configFor(baseUrl), "what is my billing setup", emptyMemoryContext);
    assert.equal(result.ok, true);
    // Not three — a label built from toolsUsed must describe what actually
    // ran, and the third attempt did not.
    if (result.ok) assert.equal(result.toolsUsed.length, 2);
  } finally {
    server.close();
  }
});

test("the same tool with genuinely different arguments is never treated as a repeat", async () => {
  // Two real questions, not one question asked twice — search_memory("billing")
  // and search_memory("shipping") must each get their own real attempts.
  const { server, baseUrl } = await fakeModel([
    toolCall("search_memory", { query: "billing" }),
    toolCall("search_memory", { query: "shipping" }),
    answer("Your billing database is Postgres 16; nothing is recorded about shipping.")
  ]);

  try {
    const result = await runAgent(configFor(baseUrl), "tell me about billing and shipping", context);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.toolsUsed.length, 2);
      assert.ok(result.toolsUsed.every((used) => used.name === "search_memory"));
    }
  } finally {
    server.close();
  }
});

test("argument order alone does not make two calls look different", async () => {
  // {from, to} and {to, from} name the same call. If the signature were
  // sensitive to key order, this would never trigger the guard at all, and
  // all three attempts below would run for real.
  const { server, baseUrl } = await fakeModel([
    toolCall("days_between", { from: "2026-01-01", to: "2026-01-10" }),
    toolCall("days_between", { to: "2026-01-10", from: "2026-01-01" }),
    toolCall("days_between", { to: "2026-01-10", from: "2026-01-01" }),
    answer("That's 9 days.")
  ]);

  try {
    const result = await runAgent(configFor(baseUrl), "how many days between those dates", context);
    assert.equal(result.ok, true);
    // Two real attempts despite the keys being reordered on the second and
    // third calls; the third is refused as a repeat of the second, not run
    // as though it were a different question.
    if (result.ok) assert.equal(result.toolsUsed.length, 2);
  } finally {
    server.close();
  }
});

// fetch_url failing withholds tools on the next round.
//
// Caught live, twice, even with an explicit system-prompt rule telling the
// model not to do this: fetch_url was refused for reaching this machine's
// own address, and the very next round called build_app instead — a real,
// entirely unrelated app, written to disk, that nobody asked for. Prompt
// language did not hold, so tools are withheld outright the round after a
// fetch_url failure, the same way the final round already withholds them.

test("a well-behaved model explaining a fetch_url failure is unaffected", async () => {
  const emptyMemoryContext: ToolContext = { ...context, memories: [], fetchPage: async () => ({ ok: false, reason: "refused" }) };
  const { server, baseUrl, received } = await fakeModel([
    toolCall("fetch_url", { url: "http://127.0.0.1/" }),
    answer("I can't fetch that — it points at this machine's own address.")
  ]);

  try {
    const result = await runAgent(configFor(baseUrl), "fetch http://127.0.0.1/", emptyMemoryContext);
    assert.equal(result.ok, true);
    if (result.ok) assert.match(result.text, /own address/);

    // The round after the failure must not have offered tools at all.
    const secondRequest = received[1] as { tools?: unknown };
    assert.equal(secondRequest.tools, undefined);
  } finally {
    server.close();
  }
});

test("a model that tries to wander to an unrelated tool after a fetch_url failure cannot actually run it", async () => {
  const emptyMemoryContext: ToolContext = { ...context, memories: [], fetchPage: async () => ({ ok: false, reason: "refused" }) };
  // Round 2 asks for build_app anyway, simulating a model that ignores the
  // prompt instruction — the same shape as what was caught live.
  const { server, baseUrl } = await fakeModel([
    toolCall("fetch_url", { url: "http://127.0.0.1/" }),
    toolCall("build_app", { description: "something unrelated" })
  ]);

  try {
    const result = await runAgent(configFor(baseUrl), "fetch http://127.0.0.1/", emptyMemoryContext);
    // Not a success that quietly did the wrong thing — an honest failure,
    // with build_app never having actually run.
    assert.equal(result.ok, false);
    assert.equal(result.toolsUsed.some((used) => used.name === "build_app"), false);
  } finally {
    server.close();
  }
});

test("a model that asks for fetch_url and an unrelated tool in the SAME response cannot run the second one", async () => {
  // This is the shape the live bug actually was, not the shape the two tests
  // above cover: both calls arrived in one response, before either had a
  // result, rather than build_app appearing on a later round. Withholding
  // tools starting next round never got a chance to matter here — there was
  // nothing left to withhold from by the time fetch_url's failure was known.
  const emptyMemoryContext: ToolContext = { ...context, memories: [], fetchPage: async () => ({ ok: false, reason: "refused" }) };
  const { server, baseUrl } = await fakeModel([
    multiToolCall(
      ["fetch_url", { url: "http://127.0.0.1:4000/v1/build-info" }],
      ["build_app", { description: "something unrelated" }]
    )
  ]);

  try {
    const result = await runAgent(configFor(baseUrl), "fetch http://127.0.0.1:4000/v1/build-info", emptyMemoryContext);
    assert.equal(result.ok, false);
    assert.equal(result.toolsUsed.some((used) => used.name === "build_app"), false);
  } finally {
    server.close();
  }
});

test("the same-batch skip holds even when the model lists the unrelated tool BEFORE fetch_url", async () => {
  // The two calls in one response have no ordering guarantee — the model
  // chose it, not this code. If build_app happened to be listed first, it
  // must still not run once its neighbour turns out to be a failed fetch_url.
  const emptyMemoryContext: ToolContext = { ...context, memories: [], fetchPage: async () => ({ ok: false, reason: "refused" }) };
  const { server, baseUrl } = await fakeModel([
    multiToolCall(
      ["build_app", { description: "something unrelated" }],
      ["fetch_url", { url: "http://127.0.0.1:4000/v1/build-info" }]
    )
  ]);

  try {
    const result = await runAgent(configFor(baseUrl), "fetch http://127.0.0.1:4000/v1/build-info", emptyMemoryContext);
    assert.equal(result.ok, false);
    assert.equal(result.toolsUsed.some((used) => used.name === "build_app"), false);
  } finally {
    server.close();
  }
});

test("two unrelated calls in the same batch both run when neither is fetch_url", async () => {
  // The fetch_url-first sort must not change anything for a batch that never
  // involves it — both calls here should run exactly as before.
  const emptyMemoryContext: ToolContext = { ...context, memories: [] };
  const { server, baseUrl } = await fakeModel([
    multiToolCall(
      ["search_memory", { query: "billing" }],
      ["current_datetime", {}]
    ),
    answer("Here is what I found.")
  ]);

  try {
    const result = await runAgent(configFor(baseUrl), "what is my billing setup and what time is it", emptyMemoryContext);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.toolsUsed.length, 2);
      assert.ok(result.toolsUsed.some((used) => used.name === "search_memory"));
      assert.ok(result.toolsUsed.some((used) => used.name === "current_datetime"));
    }
  } finally {
    server.close();
  }
});

test("an ordinary tool finding nothing does not withhold the next round — only fetch_url failing does", async () => {
  // search_memory coming back empty and then trying search_documents is the
  // normal, reasonable fallback chain this fix must not break.
  const emptyMemoryContext: ToolContext = { ...context, memories: [] };
  const { server, baseUrl } = await fakeModel([
    toolCall("search_memory", { query: "billing" }),
    toolCall("search_documents", { query: "billing" }),
    answer("Nothing is recorded about that.")
  ]);

  try {
    const result = await runAgent(configFor(baseUrl), "what is my billing setup", emptyMemoryContext);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.toolsUsed.length, 2);
      assert.ok(result.toolsUsed.some((used) => used.name === "search_documents"));
    }
  } finally {
    server.close();
  }
});

test("a successful fetch_url does not withhold anything — only a failure does", async () => {
  const withFetch: ToolContext = {
    ...context,
    fetchPage: async () => ({ ok: true, url: "https://example.com/", title: "Example", text: "hello", truncated: false })
  };
  const { server, baseUrl, received } = await fakeModel([
    toolCall("fetch_url", { url: "https://example.com/" }),
    answer("The page says hello.")
  ]);

  try {
    const result = await runAgent(configFor(baseUrl), "fetch https://example.com/", withFetch);
    assert.equal(result.ok, true);

    // Tools were still offered on the round after a real success.
    const secondRequest = received[1] as { tools?: unknown };
    assert.notEqual(secondRequest.tools, undefined);
  } finally {
    server.close();
  }
});

test("two attempts at the same call are both allowed to actually run", async () => {
  // The guard only refuses the third attempt onward — a single rephrased
  // retry, which is ordinary and reasonable, must never be blocked.
  const emptyMemoryContext: ToolContext = { ...context, memories: [] };
  const { server, baseUrl } = await fakeModel([
    toolCall("search_memory", { query: "billing" }),
    toolCall("search_memory", { query: "billing" }),
    answer("Nothing is recorded about that.")
  ]);

  try {
    const result = await runAgent(configFor(baseUrl), "what is my billing setup", emptyMemoryContext);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.toolsUsed.length, 2);
  } finally {
    server.close();
  }
});
