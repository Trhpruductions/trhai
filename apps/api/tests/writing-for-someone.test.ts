import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Something written for someone is words for the reply.
//
// Found live on 4 October, on the 7B, four runs of each:
//
//   "Draft a two-line thank-you note to a neighbour who watered my plants."
//   Saved as a document twice and as a file once - outside the workspace -
//   with "You're welcome!" for a reply and none of the note in it. The word
//   "note" alone had put the tools that keep things on offer.
//
//   "Write a short welcome message for new members of a running club."
//   Reached the model with "Call build_app with this" added to it. Three runs
//   of four built, or said they could not build, a "Welcome Message App".

const dataDir = mkdtempSync(path.join(tmpdir(), "trhai-writing-"));
const workspace = mkdtempSync(path.join(tmpdir(), "trhai-writing-ws-"));
process.env.ASCEND_WORKSPACE = workspace;
for (const [name, file] of [["MEMORY", "memory"], ["CONVERSATION", "conversations"], ["ACCOUNTS", "accounts"], ["KNOWLEDGE", "knowledge"], ["TASKS", "tasks"], ["SCHEDULE", "schedules"]]) {
  process.env[`ASSIST_${name}_FILE`] = path.join(dataDir, `${file}.json`);
}
process.env.ASCEND_PREFERENCES_FILE = path.join(dataDir, "preferences.json");

const { asksForWordsInTheReply } = await import("../src/services/actionIntent.js");
const { runAgent, wordsCarriedBy } = await import("../src/services/agentLoop.js");
const { runAssistantOrchestrator } = await import("../src/services/orchestrator.js");
const { fakeEngine } = await import("./helpers/fakeEngine.js");

test.after(() => {
  for (const dir of [dataDir, workspace]) rmSync(dir, { recursive: true, force: true });
});

const thankYou = "Draft a two-line thank-you note to a neighbour who watered my plants.";
const welcome = "Write a short welcome message for new members of a running club.";

test("a note, a text or a card written for someone is a piece of writing", () => {
  for (const request of [
    thankYou,
    welcome,
    "Write a note to my landlord about the broken heater",
    "Write a note to Priya about Friday's meeting",
    "Can you draft a note for the team about the outage?",
    "Draft a text to my friend apologising for being late",
    "Write an announcement for the club newsletter",
    "Write a birthday card for my mum",
    "Write an apology to a customer whose order was late",
    "Write a short message to my team saying the release is delayed"
  ]) {
    assert.equal(asksForWordsInTheReply(request), true, request);
  }
});

test("a note that is to be kept is still kept", () => {
  for (const request of [
    "Take a note: the door code is 4412",
    "Add a note to my notes: call the plumber",
    "Write a note to self: buy milk",
    // A note to do something is a reminder, not a letter.
    "Write a note to call the plumber tomorrow",
    "write a note for my documents about the door code",
    "Write a note saying buy milk and save it to my documents",
    "Write a thank-you note to my neighbour and save it as a note"
  ]) {
    assert.equal(asksForWordsInTheReply(request), false, request);
  }
});

const config = (baseUrl: string) => ({ baseUrl, model: "llama3.2", modelFromEnv: true, timeoutMs: 4000 });

test("a thank-you note is not offered the tools that keep things, and one kept anyway is not kept", async () => {
  const note = "Thank you so much for watering my plants while I was away.\nYou are the best neighbour anyone could ask for.";
  // What the 7B did, scripted: the note in a write_document call first, and
  // then - told that tool was not available - its own note taken for thanks.
  const engine = await fakeEngine({
    reply: [
      { message: { content: "", tool_calls: [{ function: { name: "write_document", arguments: { title: "Thank-You Note", content: note } } }] } },
      { message: { content: "You're welcome! If you need anything else, feel free to ask." } }
    ]
  });
  const saved: string[] = [];
  const context = {
    memories: [],
    knowledge: [],
    saveDocument: (title: string) => { saved.push(title); return true; }
  };
  const offered = (index: number) => (engine.chats[index]?.tools ?? []).map((tool) => tool.function.name);
  try {
    const result = await runAgent(config(engine.baseUrl), thankYou, context);
    for (const keeper of ["write_document", "write_file", "edit_file"]) {
      assert.ok(!offered(0).includes(keeper), `${keeper} is not offered for a note written to someone`);
    }
    assert.equal(result.ok, true, result.ok ? "" : result.reason);
    if (!result.ok) return;
    assert.equal(result.text, note, "the note it wrote is what the user reads");
    assert.equal(engine.chats.length, 1, "it had written the note already, so it is not asked for it again");
    assert.deepEqual(saved, [], "and nothing was saved");
    assert.deepEqual(readdirSync(workspace), [], "nor written to the workspace");

    // The controls: notes that are to be kept still have the tool that keeps them.
    const from = engine.chats.length;
    await runAgent(config(engine.baseUrl), "Add a note to my notes: call the plumber", context);
    assert.ok(offered(from).includes("write_document"), "a note to keep is offered write_document");
    const next = engine.chats.length;
    await runAgent(config(engine.baseUrl), "Write a thank-you note to my neighbour and save it as a note", context);
    assert.ok(offered(next).includes("write_document"), "so is one that says to save it");
  } finally {
    await engine.close();
  }
});

test("a welcome message goes to the model as asked, with nothing about building an app", async () => {
  const engine = await fakeEngine({ reply: { message: { content: "Welcome to the club! We run on Tuesdays and Saturdays, at every pace." } } });
  const dead = process.env.TRHAI_ENGINE_URL;
  process.env.TRHAI_ENGINE_URL = engine.baseUrl;
  const asked = (index: number) => String(engine.chats[index]?.messages?.at(-1)?.content ?? "");
  const offered = (index: number) => (engine.chats[index]?.tools ?? []).map((tool) => tool.function.name);
  try {
    const result = await runAssistantOrchestrator({ mode: "general", sessionId: "writing-welcome", userMessage: welcome });
    assert.equal(asked(0), welcome, "the request, and only the request");
    assert.ok(!offered(0).includes("build_app"), "build_app is not on offer");
    assert.equal(result.assistantMessage, "Welcome to the club! We run on Tuesdays and Saturdays, at every pace.");
    assert.equal(result.strategy, "generated");

    // The control: a request for an app still carries the instruction to build it.
    const from = engine.chats.length;
    await runAssistantOrchestrator({ mode: "general", sessionId: "writing-app", userMessage: "Build me an app for tracking a running club's members" });
    assert.match(asked(from), /Call build_app with this\./);
    assert.ok(offered(from).includes("build_app"));
  } finally {
    process.env.TRHAI_ENGINE_URL = dead;
    await engine.close();
  }
});

test("words handed to a tool that would send or keep them are read out of the call", () => {
  const letter = "Dear Sam, thank you for the lift to the station on Tuesday.";
  assert.equal(wordsCarriedBy({ name: "write_file", arguments: { path: "note.txt", content: letter } }), letter);
  assert.equal(wordsCarriedBy({ name: "write_document", arguments: { title: "Note", content: `  ${letter}\n` } }), letter);
  assert.equal(wordsCarriedBy({ name: "send_text", arguments: { to: "Sam", message: letter } }), letter);
  assert.equal(wordsCarriedBy({ name: "send_text", arguments: { to: "Sam", text: letter } }), letter, "the 7B has used both names for it");
  assert.equal(wordsCarriedBy({ name: "send_email", arguments: { to: "sam@example.com", subject: "Thanks", body: letter } }), letter);
  assert.equal(wordsCarriedBy({ name: "edit_file", arguments: { path: "note.txt", append: letter } }), letter);
  // Nothing to read: a slot left unfilled, a word or two, a tool that takes no writing.
  assert.equal(wordsCarriedBy({ name: "write_file", arguments: { path: "note.txt", content: "<content>" } }), null);
  assert.equal(wordsCarriedBy({ name: "write_file", arguments: { path: "note.txt", content: "Thanks!" } }), null);
  assert.equal(wordsCarriedBy({ name: "build_app", arguments: { description: letter } }), null);
  assert.equal(wordsCarriedBy({ name: "write_file", arguments: {} }), null);
});

test("a call that carries no words is refused as before, and the model is asked again", async () => {
  const note = "Thank you for watering my plants! You are a wonderful neighbour.";
  const engine = await fakeEngine({
    reply: [
      { message: { content: "", tool_calls: [{ function: { name: "write_file", arguments: { path: "thank-you.txt", content: "<content>" } } }] } },
      { message: { content: note } }
    ]
  });
  try {
    const result = await runAgent(config(engine.baseUrl), thankYou, { memories: [], knowledge: [] });
    assert.equal(result.ok && result.text, note);
    assert.equal(engine.chats.length, 2);
    assert.match(String(engine.chats[1].messages?.at(-1)?.content), /write_file was not available for this request and was not run\./);

    // And an order to write a file is no request for words: the file is written, the reply is not its content.
    const from = engine.chats.length;
    const order = await runAgent(config(engine.baseUrl), "create thanks.txt saying thank you for watering my plants", { memories: [], knowledge: [] });
    assert.ok((engine.chats[from]?.tools ?? []).some((tool) => tool.function.name === "write_file"));
    assert.equal(order.ok, true);
  } finally {
    await engine.close();
  }
});

test("a letter that says \"I've written the note for you\" is not taken for a claim about a file", async () => {
  // The reply the 7B gave to "Write a note to my landlord about the broken
  // heater", in substance. It was answered with "You did not change anything.
  // No file was created...", and the reply the user got was "I'm sorry, but I
  // can't assist with that."
  const letter = "Dear [Landlord's Name],\n\nI am writing to bring to your attention an urgent issue with the heater in our apartment. "
    + "It stopped working three days ago.\n\nSincerely,\n[Your Name]\n\n---\n\nI've written the note for you above.";
  const engine = await fakeEngine({ reply: [{ message: { content: letter } }, { message: { content: "I'm sorry, but I can't assist with that." } }] });
  try {
    const result = await runAgent(config(engine.baseUrl), "Write a note to my landlord about the broken heater", { memories: [], knowledge: [] });
    assert.equal(result.ok && result.text, letter);
    assert.equal(engine.chats.length, 1, "nothing was said back to it");

  } finally {
    await engine.close();
  }

  // The control: the same reply to an order to write a file, where nothing wrote one, is not passed on.
  const claiming = await fakeEngine({ reply: { message: { content: letter } } });
  try {
    const claimed = await runAgent(config(claiming.baseUrl), "create landlord.txt with a note about the broken heater", { memories: [], knowledge: [] });
    assert.equal(claimed.ok, true);
    if (!claimed.ok) return;
    assert.doesNotMatch(claimed.text, /I've written the note for you/);
    assert.match(claimed.text, /No tool was executed/);
    assert.ok(claiming.chats.length > 1, "and the model was told it had written nothing");
  } finally {
    await claiming.close();
  }
});
