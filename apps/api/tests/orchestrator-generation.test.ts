import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import {
  runAssistantOrchestrator, parseSaveDocumentRequest, isListDocumentsRequest, parsePlanAppRequest,
  parseAppendDocumentRequest, parseSearchDocumentsRequest, parseDeleteDocumentRequest, parseDeleteAppRequest, parseClearAppsRequest
} from "../src/services/orchestrator.js";
import { resetPendingConfirmations } from "../src/services/pendingConfirmation.js";

/**
 * A stand-in Ollama that answers everything.
 *
 * These tests are about what the orchestrator does with a generated reply, not
 * about inference, so the model always succeeds and always says the same thing.
 */
function fakeOllama(reply: string) {
  const received: Array<Record<string, unknown>> = [];

  return new Promise<{ server: Server; baseUrl: string; received: typeof received }>((resolve) => {
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk as Buffer));
      request.on("end", () => {
        response.writeHead(200, { "Content-Type": "application/json" });

        if (request.url?.startsWith("/api/tags")) {
          response.end(JSON.stringify({ models: [{ name: "llama3.2:latest" }] }));
          return;
        }

        if (chunks.length) {
          received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        }

        // The orchestrator drives the agent loop, which speaks /api/chat. The
        // older /api/generate shape is kept for anything still calling it.
        response.end(JSON.stringify(
          request.url?.startsWith("/api/chat")
            ? { model: "llama3.2:latest", message: { content: reply } }
            : { model: "llama3.2:latest", response: reply }
        ));
      });
    });

    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        received
      });
    });
  });
}

async function withFakeModel<T>(
  reply: string,
  run: (received: Array<Record<string, unknown>>) => Promise<T>
): Promise<T> {
  const { server, baseUrl, received } = await fakeOllama(reply);
  const previous = process.env.OLLAMA_BASE_URL;
  process.env.OLLAMA_BASE_URL = baseUrl;

  try {
    return await run(received);
  } finally {
    if (previous === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = previous;
    server.close();
  }
}

test("parseSaveDocumentRequest pulls the title and body from a save-a-document request", () => {
  assert.deepEqual(
    parseSaveDocumentRequest("save a document called Launch Plan with the text: pick a date, invite the team"),
    { title: "Launch Plan", body: "pick a date, invite the team" }
  );
  assert.deepEqual(
    parseSaveDocumentRequest("create a document titled Notes containing hello world"),
    { title: "Notes", body: "hello world" }
  );
  // Not a document-save request, or missing a body: left to the rest of the pipeline.
  assert.equal(parseSaveDocumentRequest("what does my Roadmap document say?"), null);
  assert.equal(parseSaveDocumentRequest("save a document called Roadmap"), null);
});

test("a request opening with an unlisted verb reaches the model instead of \"Got it.\"", async () => {
  // Live, verbatim: answered "Got it." (strategy acknowledge) without the
  // model ever being asked.
  await withFakeModel("Here are three tips: say what failed, why, and what to do next.", async (received) => {
    const result = await runAssistantOrchestrator({
      mode: "general",
      userMessage: "Give me three tips for writing readable error messages."
    });
    assert.notEqual(result.strategy, "acknowledge");
    assert.match(result.assistantMessage, /three tips/);
    assert.ok(received.length > 0, "the model was asked");
  });
});

test("a unit conversion is answered exactly, without asking the model", async () => {
  await withFakeModel("The result of 12.5 * 3 + 7 is 44.5.", async (received) => {
    const result = await runAssistantOrchestrator({ mode: "general", userMessage: "convert 5 miles to kilometers" });
    assert.equal(result.strategy, "conversion");
    assert.equal(result.assistantMessage, "5 miles is 8.047 kilometers.");
    assert.equal(received.length, 0, "the model was not asked");
  });
});

test("saving a document goes straight to the store, off the model", async () => {
  const saved: Array<{ title: string; body: string }> = [];
  const result = await runAssistantOrchestrator({
    mode: "general",
    sessionId: "s-doc",
    userMessage: "save a document called Launch Plan with the text: pick a date, invite the team",
    documents: [],
    saveDocument: (title, body) => { saved.push({ title, body }); return true; }
  });
  assert.equal(result.strategy, "document");
  assert.match(result.assistantMessage, /Saved the document "Launch Plan"/);
  assert.deepEqual(saved, [{ title: "Launch Plan", body: "pick a date, invite the team" }]);
});

test("saving a document refuses a duplicate title rather than overwriting", async () => {
  let calls = 0;
  const result = await runAssistantOrchestrator({
    mode: "general",
    sessionId: "s-doc",
    userMessage: "create a document called Notes with hello",
    documents: [{ id: "d1", title: "Notes", body: "existing content" }],
    saveDocument: () => { calls += 1; return true; }
  });
  assert.match(result.assistantMessage, /already exists/);
  assert.equal(calls, 0, "the store is not touched when the title is taken");
});

test("isListDocumentsRequest matches a list request but not a specific-document question", () => {
  assert.equal(isListDocumentsRequest("list my documents"), true);
  assert.equal(isListDocumentsRequest("what documents do I have?"), true);
  assert.equal(isListDocumentsRequest("show me all my documents"), true);
  assert.equal(isListDocumentsRequest("what does my Sprint Goals document say?"), false);
  assert.equal(isListDocumentsRequest("save a document called Notes with hello"), false);
});

test("listing documents comes from the store, off the model", async () => {
  const result = await runAssistantOrchestrator({
    mode: "general",
    sessionId: "s-doc",
    userMessage: "list my documents",
    documents: [{ id: "d1", title: "Sprint Goals", body: "x" }, { id: "d2", title: "Roadmap", body: "y" }]
  });
  assert.equal(result.strategy, "list");
  assert.match(result.assistantMessage, /Sprint Goals/);
  assert.match(result.assistantMessage, /Roadmap/);
});

test("listing apps comes from the workspace, off the model", async () => {
  const result = await runAssistantOrchestrator({
    mode: "general",
    sessionId: "s-apps",
    userMessage: "what apps have I built?",
    listApps: () => [
      { name: "todo-list-app", running: true, url: "http://localhost:5123" },
      { name: "recipe-box", running: false, url: null }
    ]
  });
  assert.equal(result.strategy, "list", result.assistantMessage);
  assert.match(result.assistantMessage, /todo-list-app/);
  assert.match(result.assistantMessage, /running at http:\/\/localhost:5123/);
  assert.match(result.assistantMessage, /recipe-box/);
  assert.match(result.assistantMessage, /1 running now/);
});

test("listing apps with none built says so, not an empty list", async () => {
  const result = await runAssistantOrchestrator({
    mode: "general", sessionId: "s-apps2", userMessage: "list my apps", listApps: () => []
  });
  assert.equal(result.strategy, "list");
  assert.match(result.assistantMessage, /haven't built any apps yet/);
});

test("listing many apps caps the display, running-first, with a remainder note", async () => {
  const many = Array.from({ length: 50 }, (_, i) => ({
    name: `app-${String(i).padStart(2, "0")}`, running: i === 7, url: i === 7 ? "http://localhost:6000" : null
  }));
  const result = await runAssistantOrchestrator({
    mode: "general", sessionId: "s-apps3", userMessage: "list my apps", listApps: () => many
  });
  assert.match(result.assistantMessage, /Your apps \(50\)/);
  assert.match(result.assistantMessage, /and 10 more/); // 50 total - 40 cap
  assert.match(result.assistantMessage, /app-07 \(running at http:\/\/localhost:6000\)/);
  const idx07 = result.assistantMessage.indexOf("app-07");
  const idx00 = result.assistantMessage.indexOf("app-00");
  assert.ok(idx07 >= 0 && idx07 < idx00, "the running app is listed before the alphabetical first");
});

test("parseDeleteAppRequest reads the app name and rejects non-requests", () => {
  assert.equal(parseDeleteAppRequest("delete my recipe box app"), "recipe box");
  assert.equal(parseDeleteAppRequest("remove the app called Calculator"), "Calculator");
  assert.equal(parseDeleteAppRequest("get rid of the todo app please"), "todo");
  assert.equal(parseDeleteAppRequest("what apps do I have?"), null);
  assert.equal(parseDeleteAppRequest("delete my Notes document"), null); // a document, not an app
});

test("deleting an app offers a confirmation and only deletes on yes", async () => {
  resetPendingConfirmations();
  const deleted: string[] = [];
  const apps = [
    { name: "recipe-box", running: false, url: null },
    { name: "calculator", running: false, url: null }
  ];
  const input = {
    mode: "general" as const, sessionId: "s-del-app",
    userMessage: "delete my recipe box app",
    listApps: () => apps,
    deleteApp: (name: string) => { deleted.push(name); return true; }
  };
  const offer = await runAssistantOrchestrator(input);
  assert.equal(offer.strategy, "confirm", offer.assistantMessage);
  assert.match(offer.assistantMessage, /permanently delete the app "recipe-box"/);
  assert.deepEqual(deleted, [], "nothing deleted before the user says yes");
  const confirmed = await runAssistantOrchestrator({ ...input, userMessage: "yes" });
  assert.match(confirmed.assistantMessage, /Deleted the app "recipe-box"/);
  assert.deepEqual(deleted, ["recipe-box"], "only the confirmed app is deleted");
});

test("declining an app delete keeps it", async () => {
  resetPendingConfirmations();
  let calls = 0;
  const input = {
    mode: "general" as const, sessionId: "s-del-app-no",
    userMessage: "delete the calculator app",
    listApps: () => [{ name: "calculator", running: false, url: null }],
    deleteApp: () => { calls += 1; return true; }
  };
  const offer = await runAssistantOrchestrator(input);
  assert.equal(offer.strategy, "confirm");
  const declined = await runAssistantOrchestrator({ ...input, userMessage: "no" });
  assert.match(declined.assistantMessage, /Kept\. Nothing was deleted\./);
  assert.equal(calls, 0);
});

test("deleting a running app is refused until it is stopped", async () => {
  resetPendingConfirmations();
  let calls = 0;
  const result = await runAssistantOrchestrator({
    mode: "general", sessionId: "s-del-app-run",
    userMessage: "delete the recipe box app",
    listApps: () => [{ name: "recipe-box", running: true, url: "http://localhost:7000" }],
    deleteApp: () => { calls += 1; return true; }
  });
  assert.match(result.assistantMessage, /is running/);
  assert.match(result.assistantMessage, /stop the recipe-box app/);
  assert.equal(calls, 0, "a running app is never deleted");
});

test("parseClearAppsRequest matches a whole-workspace clear, not a single-app delete", () => {
  assert.equal(parseClearAppsRequest("delete all my apps"), true);
  assert.equal(parseClearAppsRequest("clear the stopped apps"), true);
  assert.equal(parseClearAppsRequest("clean up the workspace"), true);
  assert.equal(parseClearAppsRequest("delete all the junk apps"), true);
  assert.equal(parseClearAppsRequest("delete my recipe box app"), false); // single, names one
  assert.equal(parseClearAppsRequest("what apps do I have"), false);
});

test("clearing apps offers a confirmation and deletes only the stopped ones", async () => {
  resetPendingConfirmations();
  const deleted: string[] = [];
  const apps = [
    { name: "junk-one", running: false, url: null },
    { name: "junk-two", running: false, url: null },
    { name: "live-app", running: true, url: "http://localhost:7001" }
  ];
  const input = {
    mode: "general" as const, sessionId: "s-clear",
    userMessage: "delete all my apps",
    listApps: () => apps,
    deleteApp: (name: string) => { deleted.push(name); return true; }
  };
  const offer = await runAssistantOrchestrator(input);
  assert.equal(offer.strategy, "confirm", offer.assistantMessage);
  assert.match(offer.assistantMessage, /all 2 stopped apps/);
  assert.match(offer.assistantMessage, /1 running app.*kept/);
  assert.deepEqual(deleted, [], "nothing deleted before yes");
  const confirmed = await runAssistantOrchestrator({ ...input, userMessage: "yes" });
  assert.match(confirmed.assistantMessage, /Deleted 2 stopped apps/);
  assert.deepEqual([...deleted].sort(), ["junk-one", "junk-two"], "only stopped apps deleted; running one kept");
});

test("clearing apps when all are running clears nothing", async () => {
  resetPendingConfirmations();
  let calls = 0;
  const result = await runAssistantOrchestrator({
    mode: "general", sessionId: "s-clear-run",
    userMessage: "clear all stopped apps",
    listApps: () => [{ name: "live", running: true, url: "http://localhost:1" }],
    deleteApp: () => { calls += 1; return true; }
  });
  assert.match(result.assistantMessage, /all 1 apps are running/i);
  assert.equal(calls, 0);
});

test("parseDeleteDocumentRequest pulls the title from a delete-a-document request", () => {
  assert.equal(parseDeleteDocumentRequest("delete my Scratch document"), "Scratch");
  assert.equal(parseDeleteDocumentRequest("remove the document called Launch Plan"), "Launch Plan");
  assert.equal(parseDeleteDocumentRequest("get rid of my Notes document please"), "Notes");
  assert.equal(parseDeleteDocumentRequest("trash the Old Ideas document"), "Old Ideas");
  // Not a delete-a-document request: left to the rest of the pipeline.
  assert.equal(parseDeleteDocumentRequest("what does my Roadmap document say?"), null);
  assert.equal(parseDeleteDocumentRequest("delete the file src/index.ts"), null);
});

test("deleting a document offers a confirmation and only deletes on yes", async () => {
  resetPendingConfirmations();
  const deleted: string[] = [];
  const input = {
    mode: "general" as const,
    sessionId: "s-del",
    userMessage: "delete my Scratch document",
    documents: [{ id: "d1", title: "Scratch", body: "throwaway" }, { id: "d2", title: "Keep", body: "important" }],
    deleteDocument: (id: string) => { deleted.push(id); return true; }
  };

  // First turn: an offer, nothing deleted yet.
  const offer = await runAssistantOrchestrator(input);
  assert.equal(offer.strategy, "confirm");
  assert.match(offer.assistantMessage, /would delete the document "Scratch"/);
  assert.deepEqual(deleted, [], "nothing is deleted before the user says yes");

  // Second turn: "yes" resolves the standing offer and deletes the right doc.
  const confirmed = await runAssistantOrchestrator({ ...input, userMessage: "yes" });
  assert.match(confirmed.assistantMessage, /Deleted the document "Scratch"/);
  assert.deepEqual(deleted, ["d1"], "the confirmed document is the one that gets removed");
});

test("declining a delete offer keeps the document", async () => {
  resetPendingConfirmations();
  let calls = 0;
  const input = {
    mode: "general" as const,
    sessionId: "s-del-no",
    userMessage: "delete my Scratch document",
    documents: [{ id: "d1", title: "Scratch", body: "throwaway" }],
    deleteDocument: () => { calls += 1; return true; }
  };

  const offer = await runAssistantOrchestrator(input);
  assert.equal(offer.strategy, "confirm");

  const declined = await runAssistantOrchestrator({ ...input, userMessage: "no" });
  assert.match(declined.assistantMessage, /Kept\. Nothing was deleted\./);
  assert.equal(calls, 0, "the store is never touched when the user declines");
});

test("deleting a document that does not exist deletes nothing and lists what is there", async () => {
  resetPendingConfirmations();
  let calls = 0;
  const result = await runAssistantOrchestrator({
    mode: "general",
    sessionId: "s-del-missing",
    userMessage: "delete my Nonexistent document",
    documents: [{ id: "d1", title: "Roadmap", body: "ship v2" }],
    deleteDocument: () => { calls += 1; return true; }
  });
  assert.match(result.assistantMessage, /no document called "Nonexistent"/);
  assert.match(result.assistantMessage, /Roadmap/);
  assert.equal(calls, 0);
});

test("parsePlanAppRequest extracts a plan-only app description, not a build", () => {
  assert.equal(parsePlanAppRequest("plan an app for tracking daily workouts"), "tracking daily workouts");
  // The "do not build it yet" clause is stripped so planProject does not make
  // "Not" and "Yet" records out of it.
  assert.equal(parsePlanAppRequest("plan an app for tracking daily workouts, do not build it yet"), "tracking daily workouts");
  assert.equal(parsePlanAppRequest("outline a tool to manage invoices"), "manage invoices");
  assert.equal(parsePlanAppRequest("build an app for tracking workouts"), null);
  assert.equal(parsePlanAppRequest("plan my week"), null);
});

test("planning an app comes from planProject, off the model, and does not build", async () => {
  const result = await runAssistantOrchestrator({
    mode: "general",
    sessionId: "s-plan",
    userMessage: "plan an app for tracking daily workouts, do not build it yet"
  });
  assert.equal(result.strategy, "plan");
  assert.match(result.assistantMessage, /nothing built yet/i);
});

test("parseAppendDocumentRequest and parseSearchDocumentsRequest read the request", () => {
  assert.deepEqual(parseAppendDocumentRequest("add to my Roadmap document: hire two engineers"), { title: "Roadmap", addition: "hire two engineers" });
  assert.deepEqual(parseAppendDocumentRequest("append ship faster to my Roadmap document"), { title: "Roadmap", addition: "ship faster" });
  assert.equal(parseSearchDocumentsRequest("search my documents for engineers"), "engineers");
  assert.equal(parseSearchDocumentsRequest("find auth in my documents"), "auth");
});

test("appending to a document updates it deterministically, off the model", async () => {
  let updated: { id: string; body: string } | null = null;
  const result = await runAssistantOrchestrator({
    mode: "general", sessionId: "s-doc",
    userMessage: "add to my Roadmap document: hire two engineers",
    documents: [{ id: "d1", title: "Roadmap", body: "ship v2" }],
    updateDocument: (id, body) => { updated = { id, body }; return true; }
  });
  assert.equal(result.strategy, "document");
  assert.match(result.assistantMessage, /Added to "Roadmap"/);
  assert.deepEqual(updated, { id: "d1", body: "ship v2\nhire two engineers" });
});

test("searching documents comes from the store, off the model", async () => {
  const result = await runAssistantOrchestrator({
    mode: "general", sessionId: "s-doc",
    userMessage: "search my documents for engineers",
    documents: [{ id: "d1", title: "Roadmap", body: "ship v2 and hire engineers" }, { id: "d2", title: "Notes", body: "buy milk" }]
  });
  assert.equal(result.strategy, "list");
  assert.match(result.assistantMessage, /Roadmap/);
  assert.doesNotMatch(result.assistantMessage, /Notes/);
});

test("an explanation answered by the model offers no build", async () => {
  // The deterministic path answers a plain question with a generic plan, which
  // the orchestrator discards in favour of the model. The discarded plan's
  // build request must go with it: "Explain what a mutex is" put a "Build this"
  // button under a two-sentence definition.
  await withFakeModel("A mutex lets one thread at a time touch a shared resource.", async () => {
    const result = await runAssistantOrchestrator({
      mode: "general",
      userMessage: "Explain what a mutex is in two sentences."
    });

    assert.equal(result.strategy, "generated");
    assert.equal(result.buildRequest, undefined);
  });
});

test("a generated reply is labelled as generated, with its model", async () => {
  await withFakeModel("Paris.", async () => {
    const result = await runAssistantOrchestrator({
      mode: "general",
      userMessage: "Explain what a REST API is."
    });

    assert.equal(result.strategy, "generated");
    assert.match(result.model, /llama3\.2/);
    // Nothing was quoted, so nothing may claim to be grounded.
    assert.deepEqual(result.groundedOn, []);
    assert.equal(result.groundedOnHistory, 0);
  });
});

test("a build request reaches the model so it can build", async () => {
  // This asserted "plan" and no longer should. A create request used to keep
  // the deterministic four-step plan, which made sense while a plan was the
  // best the app could do — and stopped making sense the moment build_app
  // existed, because keeping it meant "build me an app" returned a plan and
  // never called the tool that would have built the app.
  //
  // Driven by a fake model, not whichever Ollama happens to be running. This
  // test previously called the real one: it passed when nothing was listening
  // and took 97 seconds and failed when something was, which makes it a
  // measurement of the machine rather than of the code.
  await withFakeModel("Built it in the workspace.", async () => {
    const result = await runAssistantOrchestrator({
      mode: "general",
      userMessage: "Build me an app to track invoices with a client name, amount, and due date."
    });

    assert.equal(result.strategy, "generated");
    assert.match(result.model, /llama3\.2/);
  });
});

test("a build request still carries what to build when there is no model", async () => {
  // With nothing to generate an answer, the deterministic plan is still the
  // right reply, and the "Build this" control still needs its request text.
  const previous = process.env.OLLAMA_BASE_URL;
  // A port nothing is listening on, so availability fails fast and the
  // orchestrator falls back exactly as it would on a machine with no Ollama.
  process.env.OLLAMA_BASE_URL = "http://127.0.0.1:9";

  try {
    const result = await runAssistantOrchestrator({
      mode: "general",
      userMessage: "Build me an app to track invoices with a client name, amount, and due date."
    });

    assert.equal(result.strategy, "plan");
    assert.ok(result.buildRequest, "a create request must still carry a build request");
  } finally {
    if (previous === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = previous;
  }
});

test("a web lookup with no model says so, instead of a canned deploy plan", async () => {
  // Caught live: "search the web for the official Node.js release schedule"
  // came back as a four-step deploy checklist, because "release" reads as a
  // deploy task and the plan is the composer's model-unavailable fallback. A
  // web search needs the model to drive it, so with no model the honest answer
  // is that it could not run - not a plan for something the user never asked.
  const previous = process.env.OLLAMA_BASE_URL;
  process.env.OLLAMA_BASE_URL = "http://127.0.0.1:9";

  try {
    const result = await runAssistantOrchestrator({
      mode: "general",
      userMessage: "search the web for the official Node.js release schedule"
    });

    assert.equal(result.strategy, "failed", result.assistantMessage);
    assert.doesNotMatch(result.assistantMessage, /deploy|rollback|flag/i);
    assert.match(result.assistantMessage, /web search|model/i);
  } finally {
    if (previous === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = previous;
  }
});

test("a remember-then-ask turn reaches the model with the fact already known", async () => {
  // Caught live: "Remember that the server room door code is 4471. Then tell
  // me every door code I have saved." saved the fact and answered with a bare
  // "Saved." — the trailing request was never read. The fix routes this to
  // the agent and hands over what was just written, so the model does not
  // have to rediscover in its own search_memory call a fact that was written
  // in the very message it is answering.
  await withFakeModel("Saved, and it is the only door code you have on file.", async (received) => {
    const result = await runAssistantOrchestrator({
      mode: "general",
      userMessage: "Remember that the server room door code is 4471. Then tell me every door code I have saved.",
      memoryWrite: { available: true, saved: 1, savedBodies: ["the server room door code is 4471"] }
    });

    assert.equal(result.strategy, "generated");

    // The hand-over is stated in the user turn, not the system prompt — see
    // answerWithLocalModel's `question` construction.
    const firstRequest = received[0] as { messages: Array<{ role: string; content: string }> };
    const user = firstRequest.messages.find((message) => message.role === "user");
    assert.match(user?.content ?? "", /4471/, "the just-saved fact must reach the model");
    // "do not save it again" is load-bearing: without it, the model handed a
    // fact that was already saved sometimes called remember on it a second
    // time anyway, and reported a confusing failure when that redundant
    // write did not go through.
    assert.match(user?.content ?? "", /already.*saved memory/i);
    assert.match(user?.content ?? "", /do not save it again/i);
  });
});

test("an ordinary remember with nothing trailing stays the plain acknowledgement", async () => {
  // Must not regress into routing every remember statement to the model —
  // only ones that actually carry a second instruction.
  const result = await runAssistantOrchestrator({
    mode: "general",
    userMessage: "Remember that we standardized on Postgres",
    memoryWrite: { available: true, saved: 1, savedBodies: ["we standardized on Postgres"] }
  });

  assert.equal(result.strategy, "acknowledge");
  assert.match(result.assistantMessage, /Saved/i);
});

test("a build clarification merged across turns reaches the agent whole", async () => {
  // Caught live. "Build me something to help my business" got a clarifying
  // question, which is correct. The answer, "customers with email, phone and
  // company", was correctly merged by the composer into strategy "plan" with
  // buildRequest "Build me something to help my business. customers with
  // email, phone and company" — and the agent was then asked only
  // input.userMessage, the current turn alone, with no idea it was ever about
  // a build. It searched the user's documents for "customers" and reported
  // finding nothing. The merged buildRequest is what must reach the model,
  // not the bare current-turn message.
  await withFakeModel("Built it in the workspace.", async (received) => {
    const result = await runAssistantOrchestrator({
      mode: "general",
      userMessage: "customers with email, phone and company",
      history: [
        { role: "user", content: "Build me something to help my business." },
        {
          role: "assistant",
          content: "Before I build that: what should each record store?"
        }
      ]
    });

    assert.equal(result.strategy, "generated");

    // The last user message is the question; the turns before it are the
    // conversation, which the model now sees as well.
    const firstRequest = received[0] as { messages: Array<{ role: string; content: string }> };
    const user = firstRequest.messages.filter((message) => message.role === "user").at(-1);
    assert.match(user?.content ?? "", /Build me something to help my business/);
    assert.match(user?.content ?? "", /customers with email, phone and company/);
  });
});

test("an ordinary single-turn build request is unaffected by the merge path", async () => {
  // The fix above must not change anything when there is nothing to merge:
  // buildRequest and userMessage are the same string outside a refinement.
  await withFakeModel("Built it in the workspace.", async (received) => {
    await runAssistantOrchestrator({
      mode: "general",
      userMessage: "Build me an app to track invoices with a client name, amount, and due date."
    });

    const firstRequest = received[0] as { messages: Array<{ role: string; content: string }> };
    const user = firstRequest.messages.find((message) => message.role === "user");
    assert.match(user?.content ?? "", /^Build me an app to track invoices/);
  });
});

test("a create plan is told to call build_app, not plan_app", async () => {
  // Caught live, one step further than the merge fix above: understanding the
  // request correctly was not enough. Handed "Build me something to help my
  // business. customers with email, phone and company" with no further
  // instruction, the model chose plan_app — worked out what the app would
  // contain, correctly — then invented a description of a "Build screen"
  // with a "Plan" selector that does not exist, instead of building anything.
  // Told more politely which tool to use was not going to fix a model that
  // already had a correct tool available and picked a different one; naming
  // it outright removes the choice that goes wrong.
  await withFakeModel("Built it in the workspace.", async (received) => {
    await runAssistantOrchestrator({
      mode: "general",
      userMessage: "Build me an app to track invoices with a client name, amount, and due date."
    });

    const firstRequest = received[0] as { messages: Array<{ role: string; content: string }> };
    const user = firstRequest.messages.find((message) => message.role === "user");
    assert.match(user?.content ?? "", /Call build_app with this/);
    assert.match(user?.content ?? "", /[Nn]ot plan_app/);
  });
});

test("the build_app instruction is not stapled onto unrelated turns", async () => {
  // Scoped to isPlan && planTaskType === "create" specifically. A no-answer
  // turn reaches this same branch by a different door and must not carry an
  // instruction about a tool that has nothing to do with what was asked.
  await withFakeModel("Paris.", async (received) => {
    await runAssistantOrchestrator({ mode: "general", userMessage: "What is the capital of France?" });

    const firstRequest = received[0] as { messages: Array<{ role: string; content: string }> };
    const user = firstRequest.messages.find((message) => message.role === "user");
    assert.doesNotMatch(user?.content ?? "", /build_app/);
  });
});
