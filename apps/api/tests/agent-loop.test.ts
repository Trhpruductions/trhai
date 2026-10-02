import test from "node:test";
import { armCommands, commandsArmed, disarmCommands } from "../src/services/commandRunner.js";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// A workspace of its own. Without this the build tools write into the repo:
// an earlier run of these tests left apps/api/workspace/it-nice behind, which
// is a test quietly modifying the project it is testing.
const testWorkspace = mkdtempSync(path.join(tmpdir(), "ascend-agent-"));
process.env.ASCEND_WORKSPACE = testWorkspace;
import {
  describeAgentLens, describeToolCall, echoesAReport, echoesToolTemplate, executionKindForTool, explainGatedTool,
  gatedToolCall, isBareRefusal, looksLikeBareToolCall, looksLikeRawToolCalls, parseTextToolCalls, recentTurns, runAgent,
  systemPrompt, unwrapPseudoReply, wroteWhatWasAsked
} from "../src/services/agentLoop.js";
import { appTheUserNamed, availableTools, runTool, toolDefinitions, type ToolContext } from "../src/services/agentTools.js";
import { mentionsDocument, namesAFilePath } from "../src/services/actionIntent.js";
import { defaultContextTokens, minimumContextTokens, type LocalModelConfig } from "../src/services/localModel.js";

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
  const { server, baseUrl } = await fakeModel([toolCall("search_memory", { query: "again" })]);

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
  // send_email was the invented tool here until it became a real one; a fax
  // machine is still safely imaginary.
  const { server, baseUrl } = await fakeModel([
    toolCall("send_fax", { to: "someone" }),
    answer("I cannot send a fax.")
  ]);

  try {
    const result = await runAgent(configFor(baseUrl), "Fax someone", context);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.text, /cannot send a fax/);
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
  // Whole replacement has to be asked for by name; see the append and
  // passage tests in intelligence-round5.
  const updates: Array<[string, string]> = [];
  const result = await runTool(
    { name: "update_document", arguments: { title: "Runbook", content: "New procedure.", replace_everything: true } },
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

test("shift_date defaults to today when no start date is given", async () => {
  // "10 days from today" gives no start date; today is implied. Left to fail,
  // the model invented a date. Sept 20 + 10 = Sept 30.
  const result = await runTool(
    { name: "shift_date", arguments: { days: 10 } },
    { ...editContext, now: () => new Date(2026, 8, 20) }
  );
  assert.equal(result.ok, true, result.content);
  assert.match(result.content, /September 30, 2026/);
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
  // No install step, because there is nothing to install: the generated
  // package.json has no dependencies field at all. Telling the user to run
  // "npm install" implied the app needed to fetch something before starting,
  // and would fail confusingly on a machine that is offline.
  assert.match(result.content, /npm start/);
  assert.doesNotMatch(result.content, /npm install/);

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

test("read_file refuses a path outside the workspace when access is off", async () => {
  // The tool layer must not be a way around the containment check.
  //
  // Switched off explicitly: machine access is on by default now, so the
  // refusal being tested here is the one that applies when someone has turned
  // it off, not an assumption about how the app starts.
  disarmCommands();
  const result = await runTool({ name: "read_file", arguments: { path: "../../etc/passwd" } }, editContext);

  assert.equal(result.ok, false);
  assert.match(result.content, /outside my workspace/);
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

test("write_file refuses a path outside the workspace when access is off", async () => {
  disarmCommands();
  const result = await runTool(
    { name: "write_file", arguments: { path: "../escape.txt", content: "x" } },
    editContext
  );

  assert.equal(result.ok, false);
  assert.match(result.content, /Nothing was written/);
});

test("list_files refuses to list outside the workspace when access is off", async () => {
  disarmCommands();
  const result = await runTool({ name: "list_files", arguments: { directory: ".." } }, editContext);

  assert.equal(result.ok, false);
  assert.match(result.content, /outside my workspace/);
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

test("every request asks for a context window the whole prompt fits in", async () => {
  // Ollama ran the model at its 4,096-token default, and the prompt - rules
  // plus tool descriptions - is bigger than that. It was cut from the front on
  // nearly every turn ("truncating input prompt limit=2050 prompt=4443"), so
  // the model never saw its instructions.
  const { server, baseUrl, received } = await fakeModel([
    toolCall("current_datetime", {}),
    answer("It is Monday.")
  ]);

  try {
    await runAgent(configFor(baseUrl), "what day is it today?", context);

    assert.equal(received.length, 2);
    for (const request of received as Array<{ options?: { num_ctx?: number } }>) {
      assert.equal(request.options?.num_ctx, defaultContextTokens, "each round, not only the first");
    }
    // The prompt this window has to hold, measured rather than assumed.
    const firstRequest = received[0] as { messages: Array<{ content: string }>; tools?: unknown[] };
    const promptChars = JSON.stringify(firstRequest.messages).length + JSON.stringify(firstRequest.tools ?? []).length;
    assert.ok(promptChars / 3 < defaultContextTokens / 2,
      `${promptChars} characters of prompt should leave at least half the window for results and the reply`);
  } finally {
    server.close();
  }
});

test("a configured window is used, and one too small to hold the prompt is raised", async () => {
  const { server, baseUrl, received } = await fakeModel([answer("Hello."), answer("Hello.")]);

  try {
    await runAgent({ ...configFor(baseUrl), contextTokens: 32768 }, "hello", context);
    await runAgent({ ...configFor(baseUrl), contextTokens: 2048 }, "hello", context);

    const windows = (received as Array<{ options?: { num_ctx?: number } }>).map((request) => request.options?.num_ctx);
    assert.deepEqual(windows, [32768, minimumContextTokens]);
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
  //
  // search_memory rather than a date tool: days_between is pure now (see
  // pureTools), so its reordered repeat is answered from the first result and
  // never reaches this guard - covered by the test after this one.
  const { server, baseUrl } = await fakeModel([
    toolCall("search_memory", { query: "billing", limit: 3 }),
    toolCall("search_memory", { limit: 3, query: "billing" }),
    toolCall("search_memory", { limit: 3, query: "billing" }),
    answer("Your billing database is Postgres 16.")
  ]);

  try {
    const result = await runAgent(configFor(baseUrl), "what is my billing setup", context);
    assert.equal(result.ok, true);
    // Two real attempts despite the keys being reordered on the second and
    // third calls; the third is refused as a repeat of the second, not run
    // as though it were a different question.
    if (result.ok) assert.equal(result.toolsUsed.length, 2);
  } finally {
    server.close();
  }
});

test("a pure tool's repeat with its arguments reordered is answered, not run", async () => {
  const { server, baseUrl } = await fakeModel([
    toolCall("days_between", { from: "2026-01-01", to: "2026-01-10" }),
    toolCall("days_between", { to: "2026-01-10", from: "2026-01-01" }),
    answer("That's 9 days.")
  ]);

  try {
    const result = await runAgent(configFor(baseUrl), "how many days between those dates", context);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.toolsUsed.length, 1);
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

test("a document request is told apart from a file request", () => {
  assert.equal(mentionsDocument("save a document called Meeting Notes with the Q4 plan"), true);
  assert.equal(mentionsDocument("read my Roadmap document"), true);
  assert.equal(mentionsDocument("add it to the knowledge base"), true);
  // "document" as a verb, and plain file work, are not document requests.
  assert.equal(mentionsDocument("document what this function does"), false);
  assert.equal(mentionsDocument("write notes.txt with hello"), false);
  // File paths are recognised so a named file still routes to the file tools.
  assert.equal(namesAFilePath("write notes.txt with hello"), true);
  assert.equal(namesAFilePath("save a document called Meeting Notes"), false);
});

test("a document request withholds the workspace file writers so write_document is used", () => {
  const forDocument = availableTools(true, { files: false }).map((tool) => tool.function.name);
  assert.ok(!forDocument.includes("write_file"), "write_file is withheld for a document request");
  assert.ok(!forDocument.includes("edit_file"), "edit_file is withheld for a document request");
  assert.ok(forDocument.includes("write_document"), "write_document stays available");
  // The default (a file request) still offers the file writers.
  const forFile = availableTools(true).map((tool) => tool.function.name);
  assert.ok(forFile.includes("write_file"));
});

test("looksLikeBareToolCall spots a reply that is nothing but a tool-call object", () => {
  assert.equal(looksLikeBareToolCall('{"name": "open_url", "arguments": {"url": "http://localhost:49884"}}'), true);
  assert.equal(looksLikeBareToolCall("```json\n{\"name\": \"x\", \"arguments\": {\"count\": 3}}\n```"), true);
  assert.equal(looksLikeBareToolCall('{"name": "respond", "parameters": {"message": "hi"}}'), true);
  // Malformed - truncated or with a placeholder - but still plainly a tool call
  // the model emitted as text. These parse as nothing and used to leak verbatim.
  assert.equal(looksLikeBareToolCall('{"name": "web_search", "arguments": {"query": "<query>}}'), true);
  assert.equal(looksLikeBareToolCall('{"name": "fetch_url", "arguments": {"url": "http://example.com}}'), true);
  // Not tool calls: prose, plain data, a message, or malformed JSON that names
  // no real tool (so a genuine broken answer is not mistaken for one).
  assert.equal(looksLikeBareToolCall("Rendered the diagram — it is on screen now."), false);
  assert.equal(looksLikeBareToolCall('{"port": 4000}'), false);
  assert.equal(looksLikeBareToolCall('{"name": "notarealtool", "arguments": {"x": "<broken}}'), false);
  assert.equal(looksLikeBareToolCall('{"note": "<unfinished thought}'), false);
  assert.equal(looksLikeBareToolCall(""), false);
});

test("a bare invented tool-call reply after a successful change does not leak, the change's line stands", async () => {
  // Live: build_app finished, then the model answered {"name":"open_url", ...}
  // and the raw JSON rode on top of the real "Built ..." line. Reproduced with
  // render_mockup (also a mutating tool) for speed.
  const withAuthor: ToolContext = {
    ...context,
    authorApp: async () => ({
      ok: true,
      text: "<!-- TITLE: Login -->\n<!doctype html><html><head><style>body{background:#05070d}</style></head>"
        + "<body><h1>Login</h1><input><button>Go</button> a believable login screen mockup here</body></html>"
    })
  };
  const { server, baseUrl } = await fakeModel([
    toolCall("render_mockup", { description: "a login screen" }),
    answer('{"name": "open_url", "arguments": {"url": "http://localhost:49884"}}')
  ]);

  try {
    const result = await runAgent(configFor(baseUrl), "mock up a login screen", withAuthor);
    assert.equal(result.ok, true, result.ok ? "" : result.reason);
    if (!result.ok) return;
    assert.match(result.text, /Login|on screen/i);
    assert.doesNotMatch(result.text, /open_url|"arguments"/);
  } finally {
    server.close();
  }
});

test("isBareRefusal recognises a reply that is only an apology and a refusal", () => {
  assert.equal(isBareRefusal("I'm sorry, but I can't complete that request. Feel free to ask something else!"), true);
  assert.equal(isBareRefusal("Sorry, I cannot do that."), true);
  assert.equal(isBareRefusal("I'm unable to help with that."), true);
});

test("isBareRefusal leaves a real answer alone, even a long one that says can't", () => {
  assert.equal(isBareRefusal("Rendered the login flow diagram — it is on screen now."), false);
  assert.equal(isBareRefusal("The database can't be reached on that port, so the check failed. " + "Here is the log output. ".repeat(12)), false);
  assert.equal(isBareRefusal(""), false);
});

test("a false refusal after a successful render is replaced by the render's own success line", async () => {
  const withAuthor: ToolContext = {
    ...context,
    authorApp: async () => ({
      ok: true,
      text: "<!-- TITLE: Login Flow -->\n<!doctype html><html><head><style>body{background:#05070d}</style></head>"
        + "<body><svg viewBox='0 0 10 10'><rect width='4' height='2'/><text x='0' y='1'>User</text></svg>"
        + " a login flow diagram with real labels here</body></html>"
    })
  };
  const { server, baseUrl } = await fakeModel([
    toolCall("render_mockup", { description: "the login flow", kind: "diagram" }),
    answer("I'm sorry, but I can't complete that request. Feel free to ask for something else!")
  ]);

  try {
    const result = await runAgent(configFor(baseUrl), "draw a diagram of the login flow", withAuthor);
    assert.equal(result.ok, true, result.ok ? "" : result.reason);
    if (!result.ok) return;
    // The truth — the render succeeded — is what the user reads, not the refusal.
    assert.match(result.text, /Login Flow|on screen/i);
    assert.doesNotMatch(result.text, /can't complete|i'm sorry/i);
  } finally {
    server.close();
  }
});

test("after two web gathers no tools are offered, so the model answers instead of wandering", async () => {
  // Live: web_search (ok), fetch_url the page with the answer (ok), then — with
  // the web tools gone but the file tools still on offer — a stray read_file and
  // edit_file on an unrelated project, answering about the wrong thing. Once the
  // budget is spent, no tools at all: the model answers from what it gathered.
  let fetchCalls = 0;
  const webContext: ToolContext = {
    ...context,
    searchWeb: async () => ({
      ok: true,
      query: "prime minister of canada",
      results: [{ title: "PM of Canada - Wikipedia", url: "https://en.wikipedia.org/wiki/PM", snippet: "The current PM is ..." }]
    }),
    fetchPage: async () => {
      fetchCalls += 1;
      return { ok: true, url: "https://en.wikipedia.org/wiki/PM", title: "PM", text: "The Prime Minister of Canada is the head of government.", truncated: false };
    }
  };

  const { server, baseUrl, received } = await fakeModel([
    toolCall("web_search", { query: "prime minister of canada" }),
    toolCall("fetch_url", { url: "https://en.wikipedia.org/wiki/PM" }),
    answer("Canada's prime minister is its head of government.")
  ]);

  try {
    const result = await runAgent(configFor(baseUrl), "search the web for who the prime minister of canada is", webContext);
    assert.equal(result.ok, true, result.ok ? "" : result.reason);
    if (!result.ok) return;

    // Only the first, real page was read — the model did not keep fetching.
    assert.equal(fetchCalls, 1);

    // By the third round the budget is spent, so NO tools are offered — not the
    // web tools, and not the file tools it would otherwise wander into. It
    // answers from what it gathered.
    const thirdRequest = received[2] as { tools?: unknown };
    assert.equal(thirdRequest.tools, undefined, "no tools are offered after the budget — the model must answer");
    assert.match(result.text, /head of government|prime minister/i);

    // web_search and the one real fetch_url are the only web calls that ran.
    assert.equal(result.toolsUsed.filter((used) => used.name === "fetch_url").length, 1);
    assert.ok(result.toolsUsed.some((used) => used.name === "web_search"));
  } finally {
    server.close();
  }
});

test("a single successful fetch_url still withholds no web tools — only the second gather does", async () => {
  // The budget must not fire early: one search-and-read is the ordinary shape,
  // and after just one gather the next round is still free to reach the web.
  let searchCalls = 0;
  const webContext: ToolContext = {
    ...context,
    searchWeb: async () => {
      searchCalls += 1;
      return { ok: true, query: "typescript", results: [{ title: "TS", url: "https://ts.dev", snippet: "TypeScript" }] };
    }
  };

  const { server, baseUrl, received } = await fakeModel([
    toolCall("web_search", { query: "typescript latest" }),
    toolCall("web_search", { query: "typescript newest release" }),
    answer("The latest TypeScript is documented on the site.")
  ]);

  try {
    const result = await runAgent(configFor(baseUrl), "search the web for the latest typescript", webContext);
    assert.equal(result.ok, true);
    // The second web_search was still offered and ran: one gather does not close the door.
    assert.equal(searchCalls, 2);
    const secondRequest = received[1] as { tools?: Array<{ function: { name: string } }> };
    assert.ok((secondRequest.tools ?? []).some((tool) => tool.function.name === "web_search"));
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

// --- the activity log ------------------------------------------------------
//
// Every tool call is meant to land in the execution log. It used to be that
// only build_app and run_command wrote entries, so a turn that genuinely read
// the workspace produced an empty activity list — the work happened and the
// screen reported nothing. These pin the labelling down.

test("a tool call is described by its most identifying argument", () => {
  assert.equal(
    describeToolCall({ name: "read_file", arguments: { path: "src/index.ts" } }),
    "Read file: src/index.ts"
  );
  assert.equal(
    describeToolCall({ name: "web_search", arguments: { query: "tide times" } }),
    "Web search: tide times"
  );
});

test("a call with no arguments is described without inventing one", () => {
  assert.equal(describeToolCall({ name: "list_files", arguments: {} }), "List files");

  // The type says `arguments` is always an object; the model that produces it
  // is not bound by the type. A malformed call must still describe itself
  // rather than throw inside the logging path and take the turn down with it,
  // so the cast here represents what actually arrives, not what should.
  assert.equal(
    describeToolCall({ name: "list_files", arguments: undefined as unknown as Record<string, unknown> }),
    "List files"
  );
});

test("a long argument is truncated rather than pasted into the label", () => {
  const body = "x".repeat(400);
  const label = describeToolCall({ name: "write_document", arguments: { title: body } });

  assert.ok(label.length < 80, `label was ${label.length} chars`);
  assert.ok(label.endsWith("…"));
});

test("a path is preferred over a query when a call carries both", () => {
  assert.equal(
    describeToolCall({ name: "read_file", arguments: { query: "anything", path: "notes.md" } }),
    "Read file: notes.md"
  );
});

test("tools are filed under the kind of work they actually do", () => {
  assert.equal(executionKindForTool("write_file"), "write");
  assert.equal(executionKindForTool("plan_app"), "plan");
  assert.equal(executionKindForTool("test"), "test");
  // Looking something up is the general case, so an unknown tool reads as a
  // read rather than claiming to have written anything.
  assert.equal(executionKindForTool("list_files"), "read");
  assert.equal(executionKindForTool("some_future_tool"), "read");
});

// --- tools that exist but are switched off ---------------------------------

test("a call for a switched-off tool is explained, not printed as the answer", () => {
  // Machine control is off in this suite, so run_command is not advertised and
  // the parser does not recognise it — which is exactly how the raw JSON
  // reached the user. Asking TRHAI to run something with the switch off
  // replied with the literal line
  // {"name": "run_command", "arguments": {"command": "echo hello"}}.
  const raw = '{"name": "run_command", "arguments": {"command": "echo trhai-gate-test"}}';

  const call = gatedToolCall(raw);
  assert.ok(call, "a switched-off run_command was not recognised as a call at all");
  assert.equal(call.name, "run_command");

  const said = explainGatedTool(call);
  assert.match(said, /switched off/i);
  assert.ok(!said.includes('{"name"'), "the explanation still contains raw JSON");
  // It says what it would have done, which is the part the user can act on.
  assert.match(said, /echo trhai-gate-test/);

  // And it points somewhere that exists. This sentence used to read "under
  // Machine control on the dashboard; it stays on for 30 minutes" - both
  // halves false. There is no dashboard since the app became one screen, and
  // access stopped lapsing when it stopped being a timed grant. It is the
  // third broken signpost in this codebase, after the "Memory panel" and the
  // offer to add a task from a deleted Tasks screen, so it is worth a test.
  assert.doesNotMatch(said, /dashboard/i, "points at a screen that no longer exists");
  assert.doesNotMatch(said, /30 minutes/i, "access does not lapse any more");
  assert.match(said, /ACTIVITY rail/, "it must say where the switch actually is");
});

test("an ordinary answer is never mistaken for a switched-off call", () => {
  for (const text of [
    "I can run that once you switch machine control on.",
    "The workspace has 6 files.",
    "run_command is the tool that would do it, but it is not on."
  ]) {
    assert.equal(gatedToolCall(text), null, text);
  }
});

test("a call for a tool that is available is left alone", () => {
  // list_files is advertised, so it is a real call for the loop to dispatch —
  // not something to explain away.
  assert.equal(gatedToolCall('{"name": "list_files", "arguments": {}}'), null);
});

// A change the model says it made, and did not.
//
// Live failure: asked to read a file and edit it, the model called read_file,
// never called edit_file, and answered "The edited code is saved as greet.js".
// The file was untouched and the trace showed a single read.
//
// This slipped past all three existing guards. Action enforcement did not fire
// because a tool did run; fabricated-output did not match because there were no
// <toolresponse> tags; the contradiction check did not match because it looks
// for claims of failure, and this was a claim of success.

test("a claimed save with nothing written is corrected, then refused", async () => {
  const target = path.join(testWorkspace, "greet.js");
  const original = "function greet(name) {\n  return \"Hello \" + name;\n}\n";
  writeFileSync(target, original, "utf8");

  const { server, baseUrl } = await fakeModel([
    toolCall("read_file", { path: target }),
    answer("The edited code is saved as greet.js."),
    answer("I have updated the file for you.")   // told once, still claiming it
  ]);

  try {
    const result = await runAgent(configFor(baseUrl), `read ${target} and add a guard`, context);
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.match(result.text, /nothing was written/i);
    assert.doesNotMatch(result.text, /is saved as|have updated/i);
    // The claim was false in the first place: the file must be untouched.
    assert.equal(readFileSync(target, "utf8"), original);
  } finally {
    server.close();
  }
});

test("the correction is enough when the model then tells the truth", async () => {
  const target = path.join(testWorkspace, "greet-two.js");
  writeFileSync(target, "const a = 1;\n", "utf8");

  const { server, baseUrl, received } = await fakeModel([
    toolCall("read_file", { path: target }),
    answer("I've saved the change."),
    answer("I read the file but did not change it. Tell me what to add and I will.")
  ]);

  try {
    const result = await runAgent(configFor(baseUrl), `read ${target} and edit it`, context);
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.match(result.text, /did not change it/);
    // The correction reached the model rather than being applied behind it.
    const sent = JSON.stringify(received.at(-1));
    assert.match(sent, /You did not change anything/);
  } finally {
    server.close();
  }
});

test("a real successful write is never called a lie", async () => {
  // The false positive this check must not produce. write_file genuinely ran,
  // so "I've created the file" is true and must survive untouched.
  const { server, baseUrl } = await fakeModel([
    toolCall("write_file", { path: "notes.txt", content: "hello" }),
    answer("I have created notes.txt for you.")
  ]);

  try {
    const result = await runAgent(configFor(baseUrl), "create notes.txt saying hello", context);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.text, /created notes\.txt/);
    assert.doesNotMatch(result.text, /nothing was written/i);
  } finally {
    server.close();
  }
});

test("an edit_file write is not called a lie either", async () => {
  // The specific false positive that a first attempt at this check would have
  // produced. edit_file is absent from agentLoop's `mutatingTools` set - which
  // is correct for that set's actual job - so deriving "did anything change"
  // from it would have denied a real edit. The permission ladder is the record.
  const target = path.join(testWorkspace, "edited.js");
  writeFileSync(target, "const value = 1;\n", "utf8");

  const { server, baseUrl } = await fakeModel([
    toolCall("edit_file", { path: target, old_text: "const value = 1;", new_text: "const value = 2;" }),
    answer("I've updated the file - value is now 2.")
  ]);

  try {
    const result = await runAgent(configFor(baseUrl), `edit ${target} to set value to 2`, context);
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.doesNotMatch(result.text, /nothing was written/i);
    assert.match(readFileSync(target, "utf8"), /const value = 2;/);
  } finally {
    server.close();
  }
});

test("a claim made while a confirmation is pending keeps the offer open", async () => {
  // The second false positive this nearly shipped with. A held call writes
  // nothing, so it looks identical to "claimed a change and made none" - but the
  // offer is still open and awaitingConfirmation drives the control that accepts
  // it. Answering "nothing was written, ask me again" would throw away a
  // confirmation the user was one word from giving.
  const { server, baseUrl } = await fakeModel([
    toolCall("forget", { id: "m1" }),
    answer("I have deleted that memory for you.")
  ]);

  try {
    const result = await runAgent(configFor(baseUrl), "forget the database memory", context);
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.ok(result.awaitingConfirmation, "the pending offer must survive");
    assert.equal(result.awaitingConfirmation?.tool, "forget");
    assert.match(result.text, /needs your confirmation/);
    assert.doesNotMatch(result.text, /have deleted/);
  } finally {
    server.close();
  }
});

test("a write that ran and failed is not reported as a save", async () => {
  // Found by getting this test's own arguments wrong: edit_file was called with
  // text that was not in the file, returned ok:false, and the model still said
  // it had saved. The guard caught it. Worth keeping - a failed write is when a
  // false success does the most damage, because the user stops checking.
  const target = path.join(testWorkspace, "unchanged.js");
  const original = "const value = 1;\n";
  writeFileSync(target, original, "utf8");

  const { server, baseUrl } = await fakeModel([
    toolCall("edit_file", { path: target, old_text: "not in the file", new_text: "x" }),
    answer("Done - I've saved the change."),
    answer("Done - I've saved the change.")
  ]);

  try {
    const result = await runAgent(configFor(baseUrl), `edit ${target}`, context);
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.match(result.text, /nothing was written/i);
    assert.equal(readFileSync(target, "utf8"), original);
  } finally {
    server.close();
  }
});

test("being corrected does not cost the model the round it needs to act", async () => {
  // The regression that made this visible. The correction pushes a message and
  // goes round again, and it was spending the same budget as tool calls - so
  // the model was told what it got wrong and then had no round left to fix it.
  // The turn fell out of the loop and the user got "kept searching without
  // reaching an answer" instead of either the edit or the truth about it.
  //
  // Four tool rounds are used up first, deliberately, so the correction is only
  // affordable if it is charged somewhere else.
  const target = path.join(testWorkspace, "budget.js");
  writeFileSync(target, "const a = 1;\n", "utf8");

  const { server, baseUrl } = await fakeModel([
    toolCall("read_file", { path: target }),
    toolCall("read_file", { path: target }),
    answer("I will now write the file with the changes."),
    // The correction lands here, and this is the round that was being lost.
    toolCall("edit_file", { path: target, old_text: "const a = 1;", new_text: "const a = 2;" }),
    answer("Done - a is now 2.")
  ]);

  try {
    const result = await runAgent(configFor(baseUrl), `edit ${target} to set a to 2`, context);
    assert.equal(result.ok, true, "the turn must not be discarded");
    if (!result.ok) return;

    assert.doesNotMatch(result.text, /kept searching/);
    assert.match(readFileSync(target, "utf8"), /const a = 2;/, "the edit must actually land");
  } finally {
    server.close();
  }
});

test("a promise with no follow-through is replaced by the truth", async () => {
  const target = path.join(testWorkspace, "promised.js");
  const original = "const b = 1;\n";
  writeFileSync(target, original, "utf8");

  const { server, baseUrl } = await fakeModel([
    toolCall("read_file", { path: target }),
    answer("I will now write the file with the changes."),
    answer("I'll update it for you shortly.")   // corrected once, still promising
  ]);

  try {
    const result = await runAgent(configFor(baseUrl), `edit ${target}`, context);
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.match(result.text, /nothing was written/i);
    assert.doesNotMatch(result.text, /I will now write|I'll update/);
    assert.equal(readFileSync(target, "utf8"), original);
  } finally {
    server.close();
  }
});

test("a question is not offered the tools that scaffold a project", async () => {
  // The live failure this prevents. "explain how promises work in javascript"
  // reached build_app and wrote a five-file app into the workspace. Checked at
  // the request rather than at the reply, because a build has already written
  // its files by the time there is a reply to inspect.
  const { server, baseUrl, received } = await fakeModel([
    answer("A promise represents a value that is not available yet.")
  ]);

  try {
    const result = await runAgent(configFor(baseUrl), "explain how promises work in javascript", context);
    assert.equal(result.ok, true);

    const offered = (received[0]?.tools ?? []) as Array<{ function: { name: string } }>;
    const names = offered.map((tool) => tool.function.name);
    assert.ok(names.length > 0, "ordinary tools must still be offered");
    assert.ok(!names.includes("build_app"), "build_app must not be offered to a question");
    assert.ok(!names.includes("plan_app"), "plan_app must not be offered to a question");
    // Lookups still matter: a question may need to search memory to answer.
    assert.ok(names.includes("search_memory"), "search must survive");
  } finally {
    server.close();
  }
});

test("a request to build something still gets the build tools", async () => {
  const { server, baseUrl, received } = await fakeModel([
    answer("I can do that.")
  ]);

  try {
    await runAgent(configFor(baseUrl), "build me a task tracker app", context);
    const offered = (received[0]?.tools ?? []) as Array<{ function: { name: string } }>;
    const names = offered.map((tool) => tool.function.name);
    assert.ok(names.includes("build_app"), "build_app must stay available to a build request");
  } finally {
    server.close();
  }
});

test("a request naming the file to write is not offered the scaffolding tools", async () => {
  // Found by asking the app the plainest thing it offers. "create a file called
  // launch-check.txt containing the single line: it works" wrote the file
  // correctly and also called build_app, which refused for want of a
  // description. The reply then opened "Sorry, I can't build an app without a
  // description" and mentioned the file second: the work succeeded, and the
  // answer led with an apology for something nobody had asked for.
  const { server, baseUrl, received } = await fakeModel([
    answer("Done.")
  ]);

  try {
    await runAgent(
      configFor(baseUrl),
      "create a file called launch-check.txt containing the single line: it works",
      context
    );

    const offered = (received[0]?.tools ?? []) as Array<{ function: { name: string } }>;
    const names = offered.map((tool) => tool.function.name);
    assert.ok(!names.includes("build_app"), "build_app must not be offered for a named file write");
    assert.ok(!names.includes("plan_app"), "plan_app must not be offered for a named file write");
    // The tool that actually does the job has to survive the gate.
    assert.ok(names.includes("write_file"), "write_file must stay available");
  } finally {
    server.close();
  }
});

test("a retry that worked is not reported next to the attempt that failed", async () => {
  // Live: build_app failed, the model called it again, the second call worked,
  // and the reply carried both results - "I could not write that app...
  // Nothing was written." immediately followed by "Built \"Celsius\" in the
  // workspace". Both were true of their own call and together they are
  // unreadable, so the user is left guessing whether they have an app.
  //
  // Driven with write_file rather than build_app: the same code path, without
  // needing a model to author an application inside a unit test.
  const { server, baseUrl } = await fakeModel([
    toolCall("write_file", { path: "C:/outside-the-workspace/nope.txt", content: "x" }),
    toolCall("write_file", { path: "kept.txt", content: "hello" }),
    answer("Done.")
  ]);

  try {
    const result = await runAgent(configFor(baseUrl), "write hello into kept.txt", context);
    assert.equal(result.ok, true);
    if (!result.ok) return;

    const failed = result.toolsUsed.filter((used) => used.name === "write_file" && !used.ok);
    const worked = result.toolsUsed.filter((used) => used.name === "write_file" && used.ok);
    assert.equal(failed.length, 1, "the first write must really have failed");
    assert.equal(worked.length, 1, "the second must really have succeeded");

    assert.match(result.text, /kept\.txt/, "the successful result must be shown");
    assert.doesNotMatch(result.text, /outside-the-workspace/, "the failed one must not be");
  } finally {
    server.close();
  }
});

test("a mutation that only ever failed still says so", async () => {
  // The other half. Dropping failures wholesale would let a write that never
  // happened pass silently, which is the failure this codebase exists to stop.
  const { server, baseUrl } = await fakeModel([
    toolCall("write_file", { path: "C:/outside-the-workspace/nope.txt", content: "x" }),
    answer("All done!")
  ]);

  try {
    const result = await runAgent(configFor(baseUrl), "write x into that file", context);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.text, /workspace|refused|could not|nothing/i);
  } finally {
    server.close();
  }
});

test("a request to read is not given the tools that change things", async () => {
  // Asked to "read server.js from the calculator app", the model read it and
  // then made three write_file calls, reporting "app.js has been written to
  // the workspace". Nobody asked for a file. An earlier run did the same with
  // run_command, inventing a path for it.
  const { server, baseUrl, received } = await fakeModel([answer("Here is what it contains.")]);

  try {
    await runAgent(configFor(baseUrl), "read server.js from the calculator app", context);

    const offered = (received[0]?.tools ?? []) as Array<{ function: { name: string } }>;
    const names = offered.map((tool) => tool.function.name);

    assert.ok(names.includes("read_file"), "reading must still be possible");
    assert.ok(names.includes("list_files"));
    for (const changing of ["write_file", "edit_file", "build_app", "run_command"]) {
      assert.ok(!names.includes(changing), `${changing} must not be offered for a read`);
    }
    // Memory acts on the conversation, not the machine: "read notes.txt and
    // remember the port" is an ordinary thing to ask - and remember is
    // offered exactly when the request asks for something kept. This one
    // does not, so search_memory stands in for the point.
    assert.ok(names.includes("search_memory"), "memory must survive a read request");
    assert.ok(!names.includes("remember"), "remember is only offered when asked for");
  } finally {
    server.close();
  }
});

test("a read that also asks for a change keeps the write tools", async () => {
  // The line this must not cross. actionIntent checks write before read, so
  // this classifies as write and nothing is withheld.
  const { server, baseUrl, received } = await fakeModel([answer("Done.")]);

  try {
    await runAgent(configFor(baseUrl), "read config.json and update the port", context);

    const names = ((received[0]?.tools ?? []) as Array<{ function: { name: string } }>)
      .map((tool) => tool.function.name);
    assert.ok(names.includes("edit_file"), "an edit was explicitly asked for");
    assert.ok(names.includes("write_file"));
  } finally {
    server.close();
  }
});


test("a pattern question is not offered the calculator", async () => {
  // Offered unconditionally, calculate was grabbed for "2, 6, 12, 20, 30, ?"
  // and the reply was 80. The same model with no calculator in reach says 42.
  const { server, baseUrl, received } = await fakeModel([answer("42 - each is n times n+1.")]);
  try {
    await runAgent(configFor(baseUrl), "What comes next: 2, 6, 12, 20, 30, ?", context);
    const offered = ((received[0]?.tools ?? []) as Array<{ function: { name: string } }>).map((t) => t.function.name);
    assert.ok(offered.length > 0, "other tools must still be offered");
    assert.ok(!offered.includes("calculate"), "calculate must not be offered for a pattern question");
  } finally {
    server.close();
  }
});

test("a real sum still gets the calculator", async () => {
  const { server, baseUrl, received } = await fakeModel([answer("It is 44.5.")]);
  try {
    await runAgent(configFor(baseUrl), "what is 12.5 * 3 + 7", context);
    const offered = ((received[0]?.tools ?? []) as Array<{ function: { name: string } }>).map((t) => t.function.name);
    assert.ok(offered.includes("calculate"), "a genuine sum must keep the calculator");
  } finally {
    server.close();
  }
});

test("a pure web lookup is not offered the file writers", async () => {
  // "search the web for the release schedule" had edit_file in reach and the
  // model wandered into web_search -> edit_file -> edit_file, writing files
  // nobody asked for. A lookup with no file named gets web tools, not writers.
  const { server, baseUrl, received } = await fakeModel([answer("Here is what I found.")]);
  try {
    await runAgent(configFor(baseUrl), "search the web for the official Node.js release schedule", context);
    const offered = ((received[0]?.tools ?? []) as Array<{ function: { name: string } }>).map((t) => t.function.name);
    assert.ok(offered.includes("web_search"), "the web lookup must keep web_search");
    assert.ok(!offered.includes("edit_file"), "a pure web lookup must not offer edit_file");
    assert.ok(!offered.includes("write_file"), "a pure web lookup must not offer write_file");
  } finally {
    server.close();
  }
});

test("a web lookup that names a file to save to keeps the file writers", async () => {
  const { server, baseUrl, received } = await fakeModel([answer("Saved.")]);
  try {
    await runAgent(configFor(baseUrl), "search the web for the latest React version and save it to notes.txt", context);
    const offered = ((received[0]?.tools ?? []) as Array<{ function: { name: string } }>).map((t) => t.function.name);
    assert.ok(offered.includes("write_file") || offered.includes("edit_file"), "a named file keeps the writers");
  } finally {
    server.close();
  }
});

test("a stop-app request keeps stop_app but not run_app or build_app", async () => {
  // Live: "stop the notes app" ran stop_app then wandered into run_app twice,
  // answering with run_app's "no app has been built" failure. run_app is a
  // machine-changing tool and stop_app is not, so withholding those leaves the
  // stop in reach and takes the restart out of it.
  const { server, baseUrl, received } = await fakeModel([answer("Stopped it.")]);
  try {
    await runAgent(configFor(baseUrl), "stop the notes app", context);
    const offered = ((received[0]?.tools ?? []) as Array<{ function: { name: string } }>).map((t) => t.function.name);
    assert.ok(offered.includes("stop_app"), "stop_app must stay in reach");
    assert.ok(!offered.includes("run_app"), "run_app must not be offered for a stop request");
    assert.ok(!offered.includes("build_app"), "build_app must not be offered for a stop request");
  } finally {
    server.close();
  }
});

test("the build augmentation's 'Do not stop' does not trip the stop-app gate", async () => {
  // The orchestrator appends "Call build_app with this ... Do not stop at
  // explaining what it would contain" to a build turn. That "stop" beside the
  // word "app" wrongly read as a stop-app request and withheld build_app,
  // which broke building outright until the stop check was made precise.
  const augmented = "build a habit tracker app with a habit name and a streak count\n\n"
    + "Call build_app with this. Not plan_app - the user wants it actually built, not described. "
    + "Do not stop at explaining what it would contain.";
  const { server, baseUrl, received } = await fakeModel([answer("Built it.")]);
  try {
    await runAgent(configFor(baseUrl), augmented, context);
    const offered = ((received[0]?.tools ?? []) as Array<{ function: { name: string } }>).map((t) => t.function.name);
    assert.ok(offered.includes("build_app"), "a build turn must still offer build_app");
  } finally {
    server.close();
  }
});


test("a tool the turn did not offer is refused even when the model calls it", async () => {
  // The gate on the offer was not enough. With calculate withheld for a
  // pattern question, the model returned a calculate tool_call anyway - from
  // habit, not from the list - and the loop ran it and answered 36. The
  // dispatcher now checks the offer, and the model is told to answer without.
  const { server, baseUrl, received } = await fakeModel([
    toolCall("calculate", { expression: "30 + 6" }),
    answer("42 - each term is n times n plus one.")
  ]);
  try {
    const result = await runAgent(configFor(baseUrl), "What comes next: 2, 6, 12, 20, 30, ?", context);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.toolsUsed, [], "calculate must not have executed");
    assert.match(result.text, /42/, "the answer comes from reasoning, not the calculator");
    // The model was told why, as a tool message, rather than left hanging.
    const secondRequest = JSON.stringify(received[1] ?? {});
    assert.match(secondRequest, /was not available for this request/);
  } finally {
    server.close();
  }
});

test("an order answered with an un-offered tool is pointed at the right one and pushed once", async () => {
  // "now add a line saying omega to the end of it", with build_app withheld:
  // the model called build_app anyway, was told "not available", and
  // answered "I'm sorry, but I can't complete that request." - and the loop
  // returned that, because a blocked call was not counted as nothing having
  // run. Now: the refusal names the tool the order wants, and a reply with
  // still nothing run is pushed once more toward it.
  writeFileSync(path.join(testWorkspace, "omega.txt"), "alpha\nbeta\n", "utf8");
  const { server, baseUrl, received } = await fakeModel([
    toolCall("build_app", { description: "a line saying omega" }),
    answer("I'm sorry, but I can't complete that request."),
    toolCall("edit_file", { path: "omega.txt", append: "omega" }),
    answer("Added omega to the end of omega.txt.")
  ]);
  try {
    const result = await runAgent(configFor(baseUrl), "add a line saying omega to the end of omega.txt", context);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const refusal = JSON.stringify(received[1] ?? {});
    assert.match(refusal, /build_app was not available for this request/);
    assert.match(refusal, /Use edit_file or write_file or change_app instead/);
    const push = JSON.stringify(received[2] ?? {});
    assert.match(push, /You did not call a tool/);
    assert.deepEqual(result.toolsUsed.map((used) => used.name), ["edit_file"]);
    assert.equal(readFileSync(path.join(testWorkspace, "omega.txt"), "utf8"), "alpha\nbeta\nomega\n");
  } finally {
    server.close();
  }
});

test("an order to change a file that showed the result instead is pushed, then reported", async () => {
  // Asked to add a line to the end of a file it had just read, the model
  // read it again and answered "alpha\nbeta\nomega" - the contents plus the
  // line, as though showing the result were making it. Nothing was written
  // and nothing said so.
  const target = path.join(testWorkspace, "shown.txt");
  writeFileSync(target, "alpha\nbeta\n", "utf8");
  const { server, baseUrl, received } = await fakeModel([
    toolCall("read_file", { path: target }),
    answer("alpha\nbeta\nomega"),
    answer("alpha\nbeta\nomega")
  ]);
  try {
    const result = await runAgent(configFor(baseUrl), `add a line saying omega to the end of ${target}`, context);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const push = JSON.stringify(received.at(-1));
    assert.match(push, /You did not change the file/);
    assert.match(push, /Call edit_file now/);
    assert.match(result.text, /nothing was written/i);
    assert.equal(readFileSync(target, "utf8"), "alpha\nbeta\n", "the file is untouched and the reply says so");
  } finally {
    server.close();
  }
});

test("an honest failure to change a file is left alone", async () => {
  const target = path.join(testWorkspace, "honest.txt");
  const { server, baseUrl } = await fakeModel([
    toolCall("read_file", { path: target }),
    answer(`There is no file at ${target}, so nothing was changed.`)
  ]);
  try {
    const result = await runAgent(configFor(baseUrl), `add a line saying omega to the end of ${target}`, context);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.text, /no file at/);
  } finally {
    server.close();
  }
});

test("a pending confirmation is surfaced even when the model just chats", async () => {
  // "forget my api port" held forget for confirmation, and the reply was
  // "Understood. What can I assist you with today?" - no mention of anything
  // pending, so nothing for the user to say yes to. The earlier guard only
  // fired when the reply claimed the change had happened; this is the quieter
  // failure where it says nothing at all.
  const { server, baseUrl } = await fakeModel([
    toolCall("forget", { fact: "my api port is 8080" }),
    answer("Understood. What can I assist you with today?")
  ]);
  try {
    const result = await runAgent(configFor(baseUrl), "forget my api port", context);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.awaitingConfirmation, "the offer must still be pending");
    assert.match(result.text, /needs your confirmation|say yes/i, "the user must be told to confirm");
    assert.match(result.text, /Understood/, "the model's own words are kept, the notice is added");
  } finally {
    server.close();
  }
});

test("a refused first attempt does not leak under the confirmation it led to", async () => {
  // Live: the model tried forget with an empty fact, was told "nothing to act
  // on", tried again with the fact, and that second call was held. The reply
  // correctly asked for confirmation - and then printed the first refusal
  // underneath it, because failed mutation attempts are appended when nothing
  // succeeded. The refusal of the very tool now pending is stale, not news.
  const { server, baseUrl } = await fakeModel([
    toolCall("forget", { fact: "" }),
    toolCall("forget", { fact: "my api port is 8080" }),
    answer("Say yes and I will remove it.")
  ]);
  try {
    const result = await runAgent(configFor(baseUrl), "forget my api port", context);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.awaitingConfirmation, "the second call must be pending");
    assert.doesNotMatch(result.text, /nothing to act on/i, "the stale refusal must not be shown");
  } finally {
    server.close();
  }
});

// ---- Post-edit verification ---------------------------------------------------

/**
 * A built app with its own smoke check, the shape every generated app has:
 * smoke.js passes unless server.js contains "BROKEN". No server is started -
 * the check reads the file - so these tests stay fast and need no free port.
 */
function makeCheckedApp(name: string): string {
  const dir = path.join(testWorkspace, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "commonjs" }), "utf8");
  writeFileSync(path.join(dir, "server.js"), "// app server\n", "utf8");
  writeFileSync(
    path.join(dir, "smoke.js"),
    "const src = require('fs').readFileSync(__dirname + '/server.js', 'utf8');\n"
      // CRASH stands in for an app that dies on start: a real smoke.js then
      // fails on its own first request, which is what this throw imitates.
      + "if (src.includes('CRASH')) { throw new TypeError('fetch failed'); }\n"
      + "if (src.includes('BROKEN')) { console.log('FAIL server: contains BROKEN'); process.exitCode = 1; }\n"
      + "else { console.log('ok server'); }\n",
    "utf8"
  );
  return dir;
}

type Sent = { messages?: Array<{ role: string; content: string }> };

test("editing a built app re-runs its own checks and reports that they passed", async () => {
  makeCheckedApp("verify-pass-app");
  const { server, baseUrl } = await fakeModel([
    toolCall("edit_file", { path: "verify-pass-app/server.js", append: "// harmless comment" }),
    answer("I added the comment.")
  ]);
  try {
    const result = await runAgent(configFor(baseUrl), "add a comment line to verify-pass-app/server.js", context);
    assert.ok(result.ok, "the loop should answer");
    if (!result.ok) return;
    assert.match(result.text, /Re-verified verify-pass-app after editing server\.js: 1\/1 checks passed/);
  } finally {
    server.close();
  }
});

test("an edit that breaks a built app is reported as breaking it, and the model is told in time to react", async () => {
  makeCheckedApp("verify-fail-app");
  const { server, baseUrl, received } = await fakeModel([
    toolCall("edit_file", { path: "verify-fail-app/server.js", append: "// BROKEN" }),
    answer("Done.")
  ]);
  try {
    const result = await runAgent(configFor(baseUrl), "add a line to verify-fail-app/server.js", context);
    assert.ok(result.ok, "the loop should answer");
    if (!result.ok) return;
    // The user is not left believing the edit was fine.
    assert.match(result.text, /Editing server\.js broke verify-fail-app - it failed its own checks/);
    assert.match(result.text, /FAIL server: contains BROKEN/);
    // And the model saw the failure before writing its reply.
    const next = received[1] as Sent;
    assert.ok(
      (next.messages ?? []).some((m) => m.role === "tool" && /broke verify-fail-app/.test(m.content)),
      "the failed check must reach the model, not only the user"
    );
    // One call, one result: the check rides on the edit's own tool message. A
    // second tool message read to the model as a call it never made.
    const toolMessages = (next.messages ?? []).filter((m) => m.role === "tool");
    assert.equal(toolMessages.length, 1, "exactly one tool message for the one edit");
    assert.match(toolMessages[0].content, /Added 1 line[\s\S]*broke verify-fail-app/);
  } finally {
    server.close();
  }
});

test("an edit that crashes a built app on start is reported plainly, not as a stack trace", async () => {
  makeCheckedApp("verify-crash-app");
  const { server, baseUrl } = await fakeModel([
    toolCall("edit_file", { path: "verify-crash-app/server.js", append: "// CRASH" }),
    answer("Done.")
  ]);
  try {
    const result = await runAgent(configFor(baseUrl), "add a line to verify-crash-app/server.js", context);
    assert.ok(result.ok, "the loop should answer");
    if (!result.ok) return;
    assert.match(
      result.text,
      /Editing server\.js broke verify-crash-app - the app no longer starts, so its checks could not reach it \(TypeError: fetch failed\)\./
    );
    assert.doesNotMatch(result.text, /at Object\.<anonymous>|node:internal/, "no stack trace in the reply");
  } finally {
    server.close();
  }
});

test("editing a workspace folder that has no smoke check runs no verification", async () => {
  const dir = path.join(testWorkspace, "plain-notes-folder");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "notes.txt"), "alpha\n", "utf8");
  const { server, baseUrl } = await fakeModel([
    toolCall("edit_file", { path: "plain-notes-folder/notes.txt", append: "beta" }),
    answer("Added beta.")
  ]);
  try {
    const result = await runAgent(configFor(baseUrl), "add beta to plain-notes-folder/notes.txt", context);
    assert.ok(result.ok, "the loop should answer");
    if (!result.ok) return;
    assert.doesNotMatch(result.text, /Re-verified|failed its own checks|Could not re-verify/);
    assert.equal(readFileSync(path.join(dir, "notes.txt"), "utf8"), "alpha\nbeta\n", "the edit itself still happened");
  } finally {
    server.close();
  }
});

test("a later edit's check replaces the earlier one: broken then fixed reads as fixed", async () => {
  // One change runs per reply, so a second edit to the same app always lands in
  // a later round. Checking only after the first edit left this second one
  // unverified - the bug this replaced.
  makeCheckedApp("verify-fix-app");
  const { server, baseUrl, received } = await fakeModel([
    toolCall("edit_file", { path: "verify-fix-app/server.js", append: "// BROKEN" }),
    toolCall("edit_file", { path: "verify-fix-app/server.js", old_text: "// BROKEN", new_text: "// fixed" }),
    answer("Fixed it.")
  ]);
  try {
    const result = await runAgent(configFor(baseUrl), "edit verify-fix-app/server.js", context);
    assert.ok(result.ok, "the loop should answer");
    if (!result.ok) return;
    assert.match(result.text, /Re-verified verify-fix-app after editing server\.js: 1\/1 checks passed/);
    assert.doesNotMatch(result.text, /broke verify-fix-app/, "the stale failure from the first edit is gone");

    // Both checks ran: the model's final request holds the failure after the
    // first edit and the pass after the second.
    const last = received[received.length - 1] as Sent;
    const tools = (last.messages ?? []).filter((m) => m.role === "tool").map((m) => m.content).join("\n");
    assert.match(tools, /broke verify-fix-app/);
    assert.match(tools, /Re-verified verify-fix-app/);
  } finally {
    server.close();
  }
});

// ---- An order is done when its change is made -----------------------------------
//
// Live, "Append this exact line to the end of <app>/server.js: ..." made the
// edit and then kept going on every run - more appends nobody asked for, and
// twice a write_file that replaced the whole server.js. Same on master and
// with the post-edit check, so neither caused it; nothing told the loop the
// order was finished.

/** A plain workspace folder with one small notes file - no smoke check, so no verification. */
function makeNotes(name: string, content = "alpha\n"): string {
  const dir = path.join(testWorkspace, name);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "notes.txt");
  writeFileSync(file, content, "utf8");
  return file;
}

type Offered = Sent & { tools?: unknown[] };

test("a one-change order is done once the change is made: no tool is offered again", async () => {
  const file = makeNotes("one-change");
  const { server, baseUrl, received } = await fakeModel([
    toolCall("edit_file", { path: "one-change/notes.txt", append: "// harmless" }),
    // What the live model did next, every time: another edit nobody asked for.
    toolCall("edit_file", { path: "one-change/notes.txt", append: "// Additional line added by the assistant." }),
    answer("Done.")
  ]);
  try {
    const result = await runAgent(
      configFor(baseUrl), "Append this exact line to the end of one-change/notes.txt: // harmless", context
    );
    assert.ok(result.ok, "the loop should answer");
    if (!result.ok) return;
    assert.equal(readFileSync(file, "utf8"), "alpha\n// harmless\n", "only the line that was asked for");
    assert.deepEqual(result.toolsUsed, [{ name: "edit_file", ok: true }]);

    // The round after the change offered nothing, and was told why.
    const second = received[1] as Offered;
    assert.equal(second.tools, undefined, "no tools once the order is done");
    const lastTool = (second.messages ?? []).filter((m) => m.role === "tool").at(-1);
    assert.match(lastTool?.content ?? "", /That is everything this request asked for/);
    // It answered with a call it could no longer make, so the reply is what was done.
    assert.match(result.text, /Added 1 line to the end of/);
  } finally {
    server.close();
  }
});

test("an order for two changes gets both, and not a third", async () => {
  const file = makeNotes("two-changes");
  const { server, baseUrl, received } = await fakeModel([
    toolCall("edit_file", { path: "two-changes/notes.txt", append: "beta" }),
    toolCall("edit_file", { path: "two-changes/notes.txt", append: "gamma" }),
    toolCall("edit_file", { path: "two-changes/notes.txt", append: "delta" }),
    answer("Added beta and gamma.")
  ]);
  try {
    const result = await runAgent(
      configFor(baseUrl), "append beta to two-changes/notes.txt, then append gamma to two-changes/notes.txt", context
    );
    assert.ok(result.ok, "the loop should answer");
    assert.equal(readFileSync(file, "utf8"), "alpha\nbeta\ngamma\n");
    assert.ok((received[1] as Offered).tools, "the second change still had its tools");
    assert.equal((received[2] as Offered).tools, undefined, "none after the second");
  } finally {
    server.close();
  }
});

test("an edit that broke its app does not finish the order: the tools stay for the fix", async () => {
  makeCheckedApp("budget-fix-app");
  const { server, baseUrl, received } = await fakeModel([
    toolCall("edit_file", { path: "budget-fix-app/server.js", append: "// BROKEN" }),
    toolCall("edit_file", { path: "budget-fix-app/server.js", old_text: "// BROKEN", new_text: "// fixed" }),
    toolCall("edit_file", { path: "budget-fix-app/server.js", append: "// one more thing" }),
    answer("Fixed it.")
  ]);
  try {
    const result = await runAgent(configFor(baseUrl), "add a comment line to budget-fix-app/server.js", context);
    assert.ok(result.ok, "the loop should answer");
    if (!result.ok) return;
    assert.ok((received[1] as Offered).tools, "tools offered after the edit that broke the app");
    assert.equal((received[2] as Offered).tools, undefined, "none once the fix passed its checks");
    const source = readFileSync(path.join(testWorkspace, "budget-fix-app", "server.js"), "utf8");
    assert.match(source, /\/\/ fixed/);
    assert.doesNotMatch(source, /one more thing/);
    assert.match(result.text, /Re-verified budget-fix-app after editing server\.js: 1\/1 checks passed/);
  } finally {
    server.close();
  }
});

test("the count comes from the user's own words, not the facts added after them", async () => {
  // The caller appends saved facts to the question on their own lines, which
  // on its own would leave the count open.
  const file = makeNotes("own-words");
  const { server, baseUrl } = await fakeModel([
    toolCall("edit_file", { path: "own-words/notes.txt", append: "beta" }),
    toolCall("edit_file", { path: "own-words/notes.txt", append: "an improvement nobody asked for" }),
    answer("Added beta.")
  ]);
  const request = "append beta to own-words/notes.txt";
  try {
    const result = await runAgent(
      configFor(baseUrl),
      `${request}\n\nAlready in the user's saved memory — it is stored, do not save it again, just use it directly:\n`
        + "- notes for this project live in own-words",
      { ...context, request }
    );
    assert.ok(result.ok, "the loop should answer");
    assert.equal(readFileSync(file, "utf8"), "alpha\nbeta\n");
  } finally {
    server.close();
  }
});

test("a change followed by an invented reply reports the change instead of failing over", async () => {
  // Live: four appends, then a reply that was only a made-up <tool_response>.
  // It was judged unusable, two more models started the request over, and the
  // user read "no local model could be loaded" over a file changed four times.
  const file = makeNotes("invented-reply");
  const { server, baseUrl } = await fakeModel([
    toolCall("edit_file", { path: "invented-reply/notes.txt", append: "salt and pepper" }),
    answer("<tool_response>\nAdded 1 line to the end of invented-reply/notes.txt.\n</tool_response>")
  ]);
  try {
    // "and" leaves the count open, so no order budget applies: this must hold either way.
    const result = await runAgent(configFor(baseUrl), "add salt and pepper to invented-reply/notes.txt", context);
    assert.equal(result.ok, true, "a turn that changed something is never handed to another model");
    if (!result.ok) return;
    assert.match(result.text, /Added 1 line to the end of/);
    assert.doesNotMatch(result.text, /tool_response/);
    assert.equal(readFileSync(file, "utf8"), "alpha\nsalt and pepper\n");
  } finally {
    server.close();
  }
});

test("a model that fails after making a change still reports the change", async () => {
  // Out of memory mid-turn used to mean "try the next model" - which starts
  // the request from the beginning and makes the change a second time.
  const file = makeNotes("failed-after-change");
  let turn = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      turn += 1;
      if (turn === 1) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          model: "llama3.2:latest",
          ...toolCall("edit_file", { path: "failed-after-change/notes.txt", append: "beta" })
        }));
        return;
      }
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "cudaMalloc failed: out of memory" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const result = await runAgent(configFor(baseUrl), "add beta and gamma to failed-after-change/notes.txt", context);
    assert.equal(result.ok, true, "not modelUnusable: the caller must not start over");
    if (!result.ok) return;
    assert.match(result.text, /Added 1 line to the end of/);
    assert.match(result.text, /stopped responding before it wrote a reply/);
    assert.equal(readFileSync(file, "utf8"), "alpha\nbeta\n");
  } finally {
    server.close();
  }
});

test("a write that would copy an earlier step's report into the file is refused", async () => {
  // Live: "Wrote .../server.js to the workspace." written over server.js as
  // its entire content.
  const dir = path.join(testWorkspace, "echo-guard");
  mkdirSync(dir, { recursive: true });
  const { server, baseUrl, received } = await fakeModel([
    toolCall("write_file", { path: "echo-guard/a.txt", content: "hello" }),
    toolCall("write_file", { path: "echo-guard/a.txt", content: "Wrote echo-guard/a.txt to the workspace." }),
    answer("Wrote it.")
  ]);
  try {
    const result = await runAgent(configFor(baseUrl), "write hello and goodbye to echo-guard/a.txt", context);
    assert.ok(result.ok, "the loop should answer");
    assert.equal(readFileSync(path.join(dir, "a.txt"), "utf8"), "hello");
    const tools = ((received[2] as Sent).messages ?? []).filter((m) => m.role === "tool");
    assert.match(tools.at(-1)?.content ?? "", /report of an earlier step/);
  } finally {
    server.close();
  }
});

test("only an exact copy of a report counts as echoing it", () => {
  const reports = ["Added 1 line to the end of D:\\ws\\app\\server.js."];
  assert.equal(echoesAReport({ append: "// Added 1 line to the end of D:\\ws\\app\\server.js." }, reports), true);
  assert.equal(echoesAReport({ content: "Added 1 line to the end of D:\\ws\\app\\server.js." }, reports), true);
  // A log the user asked for may mention an edit; that is not a copy.
  assert.equal(echoesAReport({ append: "- 10:02 Added 1 line to the end of D:\\ws\\app\\server.js. (log)" }, reports), false);
  assert.equal(echoesAReport({ append: "beta" }, reports), false);
  assert.equal(echoesAReport({ append: "ok" }, ["ok"]), false, "too short to mean anything");
});

test("the same change asked twice under different spellings of its path runs once", async () => {
  // Live, one turn named one server.js three ways; each counted as new.
  const file = makeNotes("path-spellings");
  const { server, baseUrl } = await fakeModel([
    toolCall("edit_file", { path: "path-spellings/notes.txt", append: "beta" }),
    toolCall("edit_file", { path: file, append: "beta" }),
    answer("Added beta.")
  ]);
  try {
    // "and" leaves the count open, so only the duplicate check stands in the way.
    const result = await runAgent(configFor(baseUrl), "add beta and gamma to path-spellings/notes.txt", context);
    assert.ok(result.ok, "the loop should answer");
    assert.equal(readFileSync(file, "utf8"), "alpha\nbeta\n");
  } finally {
    server.close();
  }
});

test("write_file will not replace most of an existing file unless asked to", async () => {
  const dir = path.join(testWorkspace, "gut-guard");
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, "server.js");
  const original = Array.from({ length: 40 }, (_, index) => `line ${index};`).join("\n") + "\n";
  writeFileSync(target, original, "utf8");

  const refused = await runTool(
    { name: "write_file", arguments: { path: "gut-guard/server.js", content: "// Additional line added\n" } },
    { ...context, request: "Append this exact line to the end of gut-guard/server.js: // x" }
  );
  assert.equal(refused.ok, false);
  assert.match(refused.content, /server\.js has 40 lines, and this would keep 0 of them\./);
  assert.match(refused.content, /use edit_file/);
  assert.equal(readFileSync(target, "utf8"), original, "nothing was written");

  const asked = await runTool(
    { name: "write_file", arguments: { path: "gut-guard/server.js", content: "console.log('hi');\n" } },
    { ...context, request: "rewrite gut-guard/server.js to just log hi" }
  );
  assert.equal(asked.ok, true, "a rewrite asked for in so many words goes through");
  assert.equal(readFileSync(target, "utf8"), "console.log('hi');\n");
});

test("write_file refuses a template it was never meant to write", async () => {
  const dir = path.join(testWorkspace, "placeholder-guard");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "server.js"), "// app\n", "utf8");

  const content = await runTool(
    { name: "write_file", arguments: { path: "placeholder-guard/server.js", content: "<new_content>" } },
    context
  );
  assert.equal(content.ok, false);
  assert.match(content.content, /placeholder/);
  assert.equal(readFileSync(path.join(dir, "server.js"), "utf8"), "// app\n");

  const where = await runTool({ name: "write_file", arguments: { path: "path/to/file", content: "hello" } }, context);
  assert.equal(where.ok, false);
  assert.match(where.content, /not a real path/);
  assert.equal(existsSync(path.join(testWorkspace, "path")), false, "no path/to/file folder");
});

test("a break the user's own words caused is reported, not repaired", async () => {
  // Live: told to append a line that throws, the model did - then, with the
  // tools left in reach to fix the break, ran `node server.js` three times at
  // mangled paths. Repairing it would undo exactly what was asked.
  makeCheckedApp("exact-break-app");
  const { server, baseUrl, received } = await fakeModel([
    toolCall("edit_file", { path: "exact-break-app/server.js", append: "// BROKEN" }),
    toolCall("edit_file", { path: "exact-break-app/server.js", old_text: "// BROKEN", new_text: "// fixed" }),
    answer("Done.")
  ]);
  try {
    const result = await runAgent(
      configFor(baseUrl), "Append this exact line to the end of exact-break-app/server.js: // BROKEN", context
    );
    assert.ok(result.ok, "the loop should answer");
    if (!result.ok) return;
    assert.equal((received[1] as Offered).tools, undefined, "nothing left to do: this is what was asked");
    assert.match(readFileSync(path.join(testWorkspace, "exact-break-app", "server.js"), "utf8"), /\/\/ BROKEN/);
    assert.match(result.text, /Editing server\.js broke exact-break-app/);
  } finally {
    server.close();
  }
});

test("text the user gave word for word is recognised as theirs", () => {
  const request = "Append this exact line to the end of app/server.js: throw new Error('boom');";
  assert.equal(wroteWhatWasAsked({ path: "app/server.js", append: "throw new Error('boom');\n" }, request), true);
  assert.equal(wroteWhatWasAsked({ append: "// an idea of the model's own" }, request), false);
  assert.equal(wroteWhatWasAsked({ path: "app/server.js" }, request), false, "nothing written is nothing given");
});

test("after an edit's checks ran the app, starting its server by hand is refused", async () => {
  // A server that starts fine runs until the command times out; the checks
  // already started it and said what they found.
  makeCheckedApp("no-manual-start-app");
  const wasArmed = commandsArmed();
  armCommands();
  const { server, baseUrl, received } = await fakeModel([
    toolCall("edit_file", { path: "no-manual-start-app/server.js", append: "// BROKEN" }),
    toolCall("run_command", { command: "node no-manual-start-app/server.js" }),
    answer("The edit broke the app.")
  ]);
  try {
    const result = await runAgent(configFor(baseUrl), "add a comment line to no-manual-start-app/server.js", context);
    assert.ok(result.ok, "the loop should answer");
    if (!result.ok) return;
    assert.deepEqual(result.toolsUsed.map((used) => used.name), ["edit_file"], "the server was never started");
    const tools = ((received[2] as Sent).messages ?? []).filter((m) => m.role === "tool");
    assert.match(tools.at(-1)?.content ?? "", /checks already ran it after the edit/);
  } finally {
    if (!wasArmed) disarmCommands();
    server.close();
  }
});

// ---- The scheduler is offered for scheduling ----------------------------------------

/** The tool names a request was offered on its first round. */
async function offeredFor(request: string): Promise<string[]> {
  const { server, baseUrl, received } = await fakeModel([answer("Here you go.")]);
  try {
    await runAgent(configFor(baseUrl), request, context);
    const tools = (received[0] as { tools?: Array<{ function: { name: string } }> }).tools ?? [];
    return tools.map((tool) => tool.function.name);
  } finally {
    server.close();
  }
}

test("a request with nothing recurring in it is not offered add_schedule", async () => {
  // Live: "give me a name for my cat" reached the model with the scheduler in
  // reach, and the reply was "I've set up a daily reminder for 9:00 AM" - a
  // real schedule, saved, firing every morning.
  assert.ok(!(await offeredFor("give me a name for my cat")).includes("add_schedule"));
});

test("a request to schedule something still gets add_schedule", async () => {
  assert.ok((await offeredFor("set up a daily reminder at 8am to drink water")).includes("add_schedule"));
});

test("a request that is neither an order nor a statement gets nothing that writes", async () => {
  // Live, the same request on the next try rendered a nineteen-second video
  // into the workspace. It is asking for a name, the way a question would.
  const offered = await offeredFor("give me a name for my cat");
  for (const writer of ["make_video", "add_schedule", "build_app", "write_file", "edit_file", "write_document"]) {
    assert.ok(!offered.includes(writer), `${writer} was offered`);
  }
});

test("a request about a video still gets make_video", async () => {
  assert.ok((await offeredFor("make a short video about our product launch")).includes("make_video"));
  assert.ok(!(await offeredFor("make a todo list app")).includes("make_video"), "and a build does not");
});

// ---- Agents -----------------------------------------------------------------------

const ada = {
  name: "Ada",
  role: "Programmer",
  description: "Reads the workspace, proposes changes, and explains what a failure is actually telling you.",
  focus: "Files, failures, and the smallest change that fixes them."
};

test("an active agent reaches the model as the last paragraph of the system prompt", async () => {
  const { server, baseUrl, received } = await fakeModel([answer("Start from the failing assertion.")]);
  try {
    const result = await runAgent(configFor(baseUrl), "how should I approach a flaky test?", { ...context, agent: ada });
    assert.ok(result.ok, "the loop should answer");
    const system = ((received[0] as Sent).messages ?? [])[0];
    assert.equal(system?.role, "system");
    assert.ok(system?.content.endsWith(describeAgentLens(ada)), "the lens comes after everything else");
    // The rules it sits on top of are all still there.
    assert.match(system?.content ?? "", /Rules you do not break/);
  } finally {
    server.close();
  }
});

test("with no agent active, the system prompt carries no persona", async () => {
  const { server, baseUrl, received } = await fakeModel([answer("Start from the failing assertion.")]);
  try {
    await runAgent(configFor(baseUrl), "how should I approach a flaky test?", context);
    const system = ((received[0] as Sent).messages ?? [])[0];
    assert.doesNotMatch(system?.content ?? "", /work as|Keep in view/);
  } finally {
    server.close();
  }
});

test("an agent's lens names it, keeps its limits whole, and changes no rules", () => {
  const lens = describeAgentLens(ada);
  assert.match(lens, /work as Ada, a programmer\./);
  // Live, working as Reach: "Meet Reach, your local AI assistant" for a
  // pitch about something else entirely.
  assert.match(lens, /Ada is the name of that role, not of the user, their product or anything they ask you to write about\./);
  assert.match(lens, /explains what a failure is actually telling you\./);
  assert.match(lens, /Keep in view: Files, failures, and the smallest change that fixes them\./);
  assert.match(lens, /not a new set of rules/);
  // "an" before a vowel, whatever role a future catalogue entry has.
  assert.match(describeAgentLens({ ...ada, name: "Ed", role: "Engineer" }), /Ed, an engineer\./);
});

// ---- Everyday failures from a live battery ---------------------------------------

test("a call to a tool that does not exist is answered, not dropped as silence", async () => {
  // Verbatim: "convert 5 miles to kilometers" got only this call, was judged
  // an empty reply on every installed model, and ended as a planning template.
  const { server, baseUrl, received } = await fakeModel([
    answer('{"name": "convert_units", "arguments": {"value": 5, "from_unit": "miles", "to_unit": "kilometers"}}'),
    answer("5 miles is about 8.05 kilometers.")
  ]);
  try {
    const result = await runAgent(configFor(baseUrl), "convert 5 miles to kilometers", context);
    assert.equal(result.ok, true, "not handed on as an empty reply");
    if (!result.ok) return;
    assert.match(result.text, /8\.05 kilometers/);
    const told = ((received[1] as Sent).messages ?? []).at(-1)?.content ?? "";
    assert.match(told, /There is no tool called convert_units/);
  } finally {
    server.close();
  }
});

test("an invented call carrying only input is corrected, not shown as the answer", async () => {
  // Verbatim second round of "convert 70 fahrenheit to celsius": calculate had
  // already returned 21.11, and the reply shown was the bare expression.
  const { server, baseUrl } = await fakeModel([
    toolCall("calculate", { expression: "(70 - 32) * 5 / 9" }),
    answer('{"name": "calculate_expression", "arguments": {"expression": "((70 - 32) * 5) / 9"}}'),
    answer("70°F is about 21.1°C.")
  ]);
  try {
    const result = await runAgent(configFor(baseUrl), "convert 70 fahrenheit to celsius", context);
    assert.ok(result.ok, "the loop should answer");
    if (!result.ok) return;
    assert.match(result.text, /21\.1°C/);
    assert.doesNotMatch(result.text, /\(\(70 - 32\)/);
  } finally {
    server.close();
  }
});

test("a switched-off tool asked for as the whole reply is explained, not echoed", async () => {
  const wasArmed = commandsArmed();
  disarmCommands();
  const { server, baseUrl } = await fakeModel([
    answer('{"name": "run_command", "arguments": {"command": "echo hello"}}')
  ]);
  try {
    const result = await runAgent(configFor(baseUrl), "print hello from the shell", context);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.text, /Machine control is switched off, so nothing was run/);
    assert.notEqual(result.text.trim(), "echo hello", "the command is not the answer");
  } finally {
    if (wasArmed) armCommands();
    server.close();
  }
});

test("run_app with no project starts the app the request names", async () => {
  // Live: the model called run_app with no arguments, and with nothing worked
  // on this session the tool gave up while calculator sat in the workspace.
  const started: string[] = [];
  const appsContext: ToolContext = {
    ...context,
    listApps: () => [
      { name: "calculator", running: false, url: null },
      { name: "tip-calculator", running: false, url: null }
    ],
    launchApp: async (project) => {
      started.push(project);
      return {
        ok: true,
        alreadyRunning: false,
        app: { project, port: 4321, url: "http://localhost:4321", pid: 1, startedAt: at, output: [] }
      };
    }
  };
  const plain = await runTool({ name: "run_app", arguments: {} }, { ...appsContext, request: "run the calculator app" });
  assert.equal(plain.ok, true, plain.content);
  assert.match(plain.content, /"calculator" is now running at http:\/\/localhost:4321/);
  // The closer name wins, the same as for an explicit one.
  await runTool({ name: "run_app", arguments: {} }, { ...appsContext, request: "start the tip calculator" });
  assert.deepEqual(started, ["calculator", "tip-calculator"]);
});

test("stop_app with no project stops the running app the request names", async () => {
  const stopped: string[] = [];
  const result = await runTool({ name: "stop_app", arguments: {} }, {
    ...context,
    request: "stop the calculator app",
    runningApps: () => [{ project: "calculator", port: 4321, url: "http://localhost:4321", pid: 1, startedAt: at, output: [] }],
    stopApp: (project) => { stopped.push(project); return true; }
  });
  assert.equal(result.ok, true, result.content);
  assert.deepEqual(stopped, ["calculator"]);
});

test("a pure tool asked the same thing again hands back its answer instead of running", async () => {
  // Live: calculate("5 * 1.60934") three times over, and then - told to try a
  // different approach - an unrelated sum, answered as the conversion.
  const { server, baseUrl, received } = await fakeModel([
    toolCall("calculate", { expression: "5 * 1.60934" }),
    toolCall("calculate", { expression: "5 * 1.60934" }),
    answer("5 miles is about 8.05 kilometers.")
  ]);
  try {
    const result = await runAgent(configFor(baseUrl), "convert 5 miles to kilometers", context);
    assert.ok(result.ok, "the loop should answer");
    if (!result.ok) return;
    assert.equal(result.toolsUsed.length, 1, "the repeat did not run");
    const tools = ((received[2] as Sent).messages ?? []).filter((m) => m.role === "tool");
    assert.match(
      tools.at(-1)?.content ?? "",
      /calculate already answered exactly this: 5 \* 1\.60934 = 8\.0467\. Answer the user with it now/
    );
    assert.match(result.text, /8\.05 kilometers/);
  } finally {
    server.close();
  }
});

test("a sum is offered the calculator and not the shell", async () => {
  // Live: with both on offer, "convert 5 miles to kilometers" ran `bc` three
  // times on a machine that does not have it.
  const wasArmed = commandsArmed();
  armCommands();
  try {
    const offered = await offeredFor("convert 5 miles to kilometers");
    assert.ok(offered.includes("calculate"));
    assert.ok(!offered.includes("run_command"));
    // A question the shell answers keeps it...
    assert.ok((await offeredFor("is anything listening on port 4000?")).includes("run_command"));
    // ...and one the machine's own readings answer gets those instead: see the
    // system_status tests.
    const disk = await offeredFor("how much free space is on drive D?");
    assert.ok(disk.includes("system_status"));
    assert.ok(!disk.includes("run_command"));
  } finally {
    if (!wasArmed) disarmCommands();
  }
});

test("a request that only reads is not offered the document writers", async () => {
  // Live: "read ... and summarize it" read the file and then saved a summary
  // document nobody asked for.
  const reading = await offeredFor("read recipe-box/README.md and summarize it in two sentences");
  for (const writer of ["write_document", "update_document", "delete_document"]) {
    assert.ok(!reading.includes(writer), `${writer} was offered`);
  }
  // Asked to keep one, it still can.
  assert.ok((await offeredFor("read notes.txt and save a summary as a document called Notes Summary")).includes("write_document"));
});

// ---- Follow-ups: the model sees the conversation -----------------------------

test("the last few turns go to the model, before the question and without repeating it", () => {
  const conversation = [
    { role: "user" as const, content: "What's the capital of Australia?" },
    { role: "assistant" as const, content: "The capital of Australia is Canberra." },
    // The client sends the message being answered as the last turn of its history.
    { role: "user" as const, content: "And roughly how many people live there?" }
  ];

  assert.deepEqual(recentTurns(conversation, ["And roughly how many people live there?"]), [
    { role: "user", content: "What's the capital of Australia?" },
    { role: "assistant", content: "The capital of Australia is Canberra." }
  ]);
  assert.deepEqual(recentTurns(undefined, ["hello"]), []);
});

test("only the most recent turns go, each cut to a readable length", () => {
  const conversation = Array.from({ length: 10 }, (_, index) => ({
    role: (index % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: index === 9 ? "x".repeat(3000) : `turn ${index}`
  }));

  const sent = recentTurns(conversation, ["the next question"]);
  assert.equal(sent.length, 6);
  assert.equal(sent[0].content, "turn 4", "the oldest turns are the ones dropped");
  assert.ok(sent[5].content.length < 900, "a long turn is cut, not sent whole");
  assert.match(sent[5].content, /\[\.\.\.\]$/);
});

test("a follow-up reaches the model with the turn it follows", async () => {
  // Live: "And roughly how many people live there?" was answered "I don't have
  // access to current population data for any specific location" - the model
  // never saw that "there" was Canberra.
  const { server, baseUrl, received } = await fakeModel([answer("About 470,000 people live in Canberra.")]);

  try {
    const result = await runAgent(configFor(baseUrl), "And roughly how many people live there?", {
      ...context,
      conversation: [
        { role: "user", content: "What's the capital of Australia?" },
        { role: "assistant", content: "The capital of Australia is Canberra." }
      ]
    });

    assert.equal(result.ok, true);
    const sent = (received[0] as { messages: Array<{ role: string; content: string }> }).messages;
    assert.deepEqual(sent.map((message) => message.role), ["system", "user", "assistant", "user"]);
    assert.match(sent[2].content, /Canberra/);
    assert.equal(sent[3].content, "And roughly how many people live there?", "the question comes last");
  } finally {
    server.close();
  }
});

test("a request to reshape the last answer gets nothing that writes", async () => {
  // Live: "Make that answer one sentence." saved a document called
  // daily-log.txt reading "Today was a productive day."
  const offered = await offeredFor("Make that answer one sentence.");
  for (const writer of ["write_document", "write_file", "edit_file", "build_app", "remember", "add_schedule", "run_command"]) {
    assert.ok(!offered.includes(writer), `${writer} was offered`);
  }
  // Asking for a file is a different request.
  assert.ok((await offeredFor("make that into a file called summary.txt")).includes("write_file"));
});

test("a reply that is the tool-calling template is corrected, not shown", async () => {
  // Verbatim, the whole reply to "Make that answer one sentence."
  const template = "For each function call, return a json object with function name and arguments within {} "
    + "with NO other text. Do not include any backticks or ```json.";
  const { server, baseUrl, received } = await fakeModel([answer(template), answer("Canberra is the capital of Australia.")]);

  try {
    const result = await runAgent(configFor(baseUrl), "Make that answer one sentence.", context);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.text, "Canberra is the capital of Australia.");
    const told = ((received[1] as { messages: Array<{ content: string }> }).messages.at(-1)?.content) ?? "";
    assert.match(told, /not an answer/);
    assert.match(told, /Make that answer one sentence\./, "the question goes with the correction");
  } finally {
    server.close();
  }
});

test("a template echoed twice is a failure, never the reply", async () => {
  const template = "For each function call, return a json object with function name and arguments within <tool_call></tool_call> tags.";
  const { server, baseUrl } = await fakeModel([answer(template), answer(template)]);

  try {
    const result = await runAgent(configFor(baseUrl), "hello again", context);
    assert.equal(result.ok, false);
  } finally {
    server.close();
  }
});

test("echoesToolTemplate knows the template and nothing else", () => {
  assert.equal(echoesToolTemplate("For each function call, return a json object with function name and arguments"), true);
  assert.equal(echoesToolTemplate("You are provided with function signatures within <tools></tools> XML tags"), true);
  assert.equal(echoesToolTemplate("Each function returns a JSON object with the result."), false);
  assert.equal(echoesToolTemplate("Canberra is the capital."), false);
});

test("an invented tool's input is not passed off as its answer", async () => {
  // Live, the whole answer to "translate 'good morning' to Spanish" was "good
  // morning": the text the invented tool was meant to translate.
  const pseudo = '{"name": "translate", "arguments": {"text": "good morning", "to_language": "Spanish"}}';
  assert.equal(unwrapPseudoReply(pseudo, ["translate 'good morning' to Spanish"]), pseudo);
  // Words lifted from the request without quotes count the same.
  assert.equal(unwrapPseudoReply('{"name": "translate", "arguments": {"text": "thank you very much"}}',
    ["translate thank you very much into French"]), '{"name": "translate", "arguments": {"text": "thank you very much"}}');
  // An answer in costume is still unwrapped, including a one-word one the
  // question happens to contain.
  assert.equal(unwrapPseudoReply('{"name": "respond", "arguments": {"text": "Buenos días."}}',
    ["translate 'good morning' to Spanish"]), "Buenos días.");
  assert.equal(unwrapPseudoReply('{"name": "answer", "arguments": {"answer": "Canberra"}}',
    ["is the capital Canberra or Sydney?"]), "Canberra");

  const { server, baseUrl, received } = await fakeModel([answer(pseudo), answer("Buenos días.")]);
  try {
    const result = await runAgent(configFor(baseUrl), "translate 'good morning' to Spanish", context);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.text, "Buenos días.");
    const told = ((received[1] as { messages: Array<{ content: string }> }).messages.at(-1)?.content) ?? "";
    assert.match(told, /There is no tool called translate/);
  } finally {
    server.close();
  }
});

// ---- system_status: the machine's own readings -------------------------------

const readings = async () => ({
  cpu: { model: "Test CPU", cores: 16, speedMhz: 4200, fraction: 0.27, detail: "27% across 16 cores", unavailable: null },
  memory: { fraction: 0.57, detail: "18.2 / 31.9 GB", unavailable: null },
  gpu: {
    name: "NVIDIA GeForce RTX 4060 Ti", fraction: 0.12, detail: "12% busy", unavailable: null,
    vram: { fraction: 0.74, detail: "5.9 / 8.0 GB", unavailable: null },
    temperatureC: 48, clockMhz: 2535, powerWatts: null
  },
  cloud: { services: [], detail: "" },
  disk: { fraction: 0.5, detail: "1.82 / 3.64 TB", unavailable: null },
  network: { fraction: null, detail: "", unavailable: "Measuring…", receivedBytesPerSecond: null, sentBytesPerSecond: null },
  uptimeSeconds: 3 * 86400 + 4 * 3600 + 120,
  takenAt: new Date(0).toISOString()
});

test("system_status reports the readings it was given, and leaves out what was not read", async () => {
  const result = await runTool({ name: "system_status", arguments: {} }, { ...context, readTelemetry: readings });

  assert.equal(result.ok, true);
  assert.match(result.content, /Processor: 27% busy across 16 cores \(Test CPU\)\./);
  assert.match(result.content, /Memory: 18\.2 \/ 31\.9 GB in use \(57%\)\./);
  assert.match(result.content, /NVIDIA GeForce RTX 4060 Ti, 12% busy, video memory 5\.9 \/ 8\.0 GB \(74%\), 48°C\./);
  assert.match(result.content, /(?:Drive [A-Z]:|Disk [^:]*:) [\d.]+ (?:GB|TB) free of [\d.]+ (?:GB|TB)/, "the workspace's own drive, really measured");
  assert.match(result.content, /Up for: 3 days 4 hours\./);
  // No power reading and no network rate yet: neither is mentioned, let alone invented.
  assert.doesNotMatch(result.content, /\bW\b|Network/);
});

test("system_status is offered for questions about the machine, and only those", async () => {
  for (const question of ["what's my CPU usage right now?", "how much RAM am I using?", "how hot is my GPU?",
    "how much free space is on drive C?", "how long has my computer been on?"]) {
    assert.ok((await offeredFor(question)).includes("system_status"), question);
  }
  for (const question of ["what's in your memory?", "what's the temperature in Paris?", "write a haiku about autumn"]) {
    assert.ok(!(await offeredFor(question)).includes("system_status"), question);
  }
});

test("a question about the machine reaches the model with the real readings", async () => {
  const { server, baseUrl, received } = await fakeModel([answer("Your processor is 27% busy.")]);

  try {
    const result = await runAgent(configFor(baseUrl), "what's my CPU usage right now?", { ...context, readTelemetry: readings });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.text, "Your processor is 27% busy.", "a faithful answer is kept as written");
    const question = (received[0] as { messages: Array<{ role: string; content: string }> }).messages.at(-1)?.content ?? "";
    assert.match(question, /^what's my CPU usage right now\?/);
    assert.match(question, /Processor: 27% busy across 16 cores/);
  } finally {
    server.close();
  }
});

test("an invented reading is replaced by the real ones", async () => {
  // Verbatim from the live run, with system_status on offer and not called.
  const { server, baseUrl } = await fakeModel([answer("You are using 32 GB of your 64 GB RAM, which is 49%.")]);

  try {
    const result = await runAgent(configFor(baseUrl), "how much RAM am I using?", { ...context, readTelemetry: readings });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.text, /^This is what this machine reports right now:/);
    assert.match(result.text, /Memory: 18\.2 \/ 31\.9 GB in use \(57%\)\./);
    assert.doesNotMatch(result.text, /64 GB|49%/);
  } finally {
    server.close();
  }
});

test("advice about the machine may use numbers of its own", async () => {
  // Not a reading: a GPU's safe range is general knowledge, and replacing the
  // advice with the readings would lose the answer.
  const advice = "Most GPUs run safely up to about 83°C, so yours is fine.";
  const { server, baseUrl } = await fakeModel([answer(advice)]);

  try {
    const result = await runAgent(configFor(baseUrl), "is my GPU too hot?", { ...context, readTelemetry: readings });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.text, advice);
  } finally {
    server.close();
  }
});

test("the app the user named wins over a different one the model picked", () => {
  const apps = ["calculator", "tip-calculator", "todo-list-app", "snake-game"];
  // Live: "run the calculator app" arrived as run_app("tip-calculator").
  assert.equal(appTheUserNamed(apps, "tip-calculator", "run the calculator app"), "calculator");
  assert.equal(appTheUserNamed(apps, "calculator", "run the calculator app"), "calculator");
  assert.equal(appTheUserNamed(apps, "tip-calculator", "run the tip calculator"), "tip-calculator");
  // Nothing named in the request: the model's pick stands, or nothing.
  assert.equal(appTheUserNamed(apps, "todo-list-app", "run it again"), "todo-list-app");
  assert.equal(appTheUserNamed(apps, null, "run the calculator app"), "calculator");
  assert.equal(appTheUserNamed(apps, null, "run it"), null);
});

test("starting an app is offered only when something was asked to start", async () => {
  // Live: "Plan tonight's stream: two hours of a survival game" started snake-game.
  assert.ok(!(await offeredFor("Plan tonight's stream: two hours of a survival game")).includes("run_app"));
  assert.ok((await offeredFor("run the calculator app")).includes("run_app"));
  assert.ok((await offeredFor("open my todo app")).includes("run_app"));
});

test("a refused write followed by an append that worked reports only the append", async () => {
  // Live: "Added a line saying..." followed by "notes.txt has 1 line, and
  // this would keep 0 of it... Nothing was written."
  writeFileSync(path.join(testWorkspace, "gut-notes.txt"), "first note\n", "utf8");
  const { server, baseUrl } = await fakeModel([
    toolCall("write_file", { path: "gut-notes.txt", content: "\nsecond note\n" }),
    toolCall("edit_file", { path: "gut-notes.txt", append: "second note" }),
    answer("Added a line saying second note to the end of gut-notes.txt.")
  ]);

  try {
    const request = "add a line saying second note to the end of gut-notes.txt";
    const result = await runAgent(configFor(baseUrl), request, { ...context, request });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.toolsUsed.map((used) => [used.name, used.ok]), [["write_file", false], ["edit_file", true]]);
    assert.doesNotMatch(result.text, /Nothing was written/);
    assert.equal(readFileSync(path.join(testWorkspace, "gut-notes.txt"), "utf8").replace(/\r\n/g, "\n"), "first note\nsecond note\n");
  } finally {
    server.close();
  }
});

test("a request with nothing to do with the machine is not offered the shell", async () => {
  // Live, with machine access on: "Plan tonight's stream" ran `stream-cli`
  // three times on one run and `echo Starting a two-hour survival game
  // stream.` on another, and never gave a plan.
  const wasArmed = commandsArmed();
  armCommands();
  try {
    assert.ok(!(await offeredFor("Plan tonight's stream: two hours of a survival game")).includes("run_command"));
    assert.ok(!(await offeredFor("Give me three openings for a blog post about learning to code at 40")).includes("run_command"));
    assert.ok((await offeredFor("what version of node is installed?")).includes("run_command"));
    // An order to run something keeps it whatever it names.
    assert.ok((await offeredFor("run whoami")).includes("run_command"));
  } finally {
    if (!wasArmed) disarmCommands();
  }
});

test("a reading question does not get the shell, but a question about programs still does", async () => {
  // Live: "what's my CPU usage right now?" ran wmic, which this Windows no
  // longer has, and sent the user to Task Manager.
  const wasArmed = commandsArmed();
  armCommands();
  try {
    assert.ok(!(await offeredFor("what's my CPU usage right now?")).includes("run_command"));
    assert.ok((await offeredFor("which process is using the most RAM?")).includes("run_command"));
  } finally {
    if (!wasArmed) disarmCommands();
  }
});
