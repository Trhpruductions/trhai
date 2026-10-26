import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fakeEngine, type ScriptedReply } from "./helpers/fakeEngine.js";

// The assistant can make a PowerPoint file. What is tested here is when it is offered the tool, what the tool does with what it
// passes, where the files go and where they may not, that what it reports is what is on disk - and that a deck it made can be
// read again by the same assistant, speaker's notes and all.

const workspace = mkdtempSync(path.join(tmpdir(), "trhai-make-presentation-"));
process.env.ASCEND_WORKSPACE = workspace;
const outside = mkdtempSync(path.join(tmpdir(), "trhai-make-presentation-outside-"));
const fakeRenderer = path.join(path.dirname(fileURLToPath(import.meta.url)), "helpers", "fakeRenderer.mjs");

const { availableTools, runTool, toolDefinitions } = await import("../src/services/agentTools.js");
const { wantsAFileMade, wantsAPresentationMade, wantsASpreadsheetMade } = await import("../src/services/actionIntent.js");
const { runAgent } = await import("../src/services/agentLoop.js");
const { armCommandsFor, disarmCommands } = await import("../src/services/commandRunner.js");
const { describeTools } = await import("../src/services/toolCenter.js");
const { permissionLevelOf } = await import("../src/services/toolPermissions.js");
const { takeMadeFiles } = await import("../src/services/madeFiles.js");
const { readSlides } = await import("../src/services/documentText.js");

test.after(() => {
  disarmCommands();
  rmSync(workspace, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});
test.beforeEach(() => { disarmCommands(); });

const names = (tools: Array<{ function: { name: string } }>) => tools.map((tool) => tool.function.name);
const context = (request = "make me a powerpoint presentation", extra: Record<string, unknown> = {}) => ({ memories: [], knowledge: [], request, ...extra }) as never;
const tool = (args: Record<string, unknown>, request?: string, extra?: Record<string, unknown>) => runTool({ name: "make_presentation", arguments: args }, context(request, extra));
const inWorkspace = (...parts: string[]) => path.join(workspace, ...parts);

const deck = [
  "# Composting at Home", "A short guide", "",
  "## Why compost", "- Less waste", "- Better soil", "", "Notes: mention the council scheme", "",
  "## What goes in", "| Green | Brown |", "|---|---|", "| Peelings | Cardboard |", "| Grass | Leaves |"
].join("\n");

/** Runs `body` with a stand-in for the window that prints PDFs, one that writes a real PDF with a page for each slide. */
async function withPrinter<T>(body: () => Promise<T>, mode = "slides"): Promise<T> {
  const saved = { electron: process.env.TRHAI_ELECTRON_PATH, script: process.env.TRHAI_RENDERER_SCRIPT, mode: process.env.FAKE_RENDER };
  process.env.TRHAI_ELECTRON_PATH = process.execPath;
  process.env.TRHAI_RENDERER_SCRIPT = fakeRenderer;
  process.env.FAKE_RENDER = mode;
  try {
    return await body();
  } finally {
    for (const [name, value] of [["TRHAI_ELECTRON_PATH", saved.electron], ["TRHAI_RENDERER_SCRIPT", saved.script], ["FAKE_RENDER", saved.mode]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
}

// ---------------------------------------------------------------- when it is offered

test("a request for slides is told from a question about them, from one for another kind of file, and from a deck of cards", () => {
  for (const asked of [
    "make me a PowerPoint about our trip",
    "create a presentation on solar energy",
    "build a slide deck for the board meeting",
    "make slides for my talk on Friday",
    "generate a pptx of the plan",
    "I need a pitch deck for investors",
    "draft a sales deck",
    "can you put together a presentation for tomorrow?",
    "write a keynote about our year",
    "turn these notes into a slideshow",
    "Make me a Power Point of the results"
  ]) assert.equal(wantsAPresentationMade(asked), true, asked);
  for (const asked of [
    "how do I open a pptx file",
    "what is a presentation?",
    "summarize deck.pptx",
    "read my slides",
    "the slide deck was good",
    "build a deck in the backyard",
    "shuffle the deck of cards",
    "make a Word document",
    "create a spreadsheet of my expenses",
    "write a report on the quarter",
    "slide the file over",
    "what did the presentation say about churn?"
  ]) assert.equal(wantsAPresentationMade(asked), false, asked);
  // The tools for the other kinds of file are not offered by a request for slides, nor this one by theirs.
  assert.equal(wantsAFileMade("make me a PowerPoint about our trip"), false);
  assert.equal(wantsASpreadsheetMade("make me a PowerPoint about our trip"), false);
  assert.equal(wantsAPresentationMade("make me a Word document of my notes"), false);
  assert.equal(wantsAPresentationMade("make me an Excel spreadsheet"), false);
});

test("the tool is offered when slides are asked for, and not to a question, a read, or any other request", () => {
  assert.ok(names(availableTools(true, { presentations: true })).includes("make_presentation"));
  assert.ok(!names(availableTools(true, { presentations: false })).includes("make_presentation"), "not asked for");
  assert.ok(!names(availableTools(true, { presentations: true, writes: false })).includes("make_presentation"), "a question writes nothing");
  assert.ok(!names(availableTools(true, { presentations: true, changes: false })).includes("make_presentation"), "a request to look changes nothing");
  // Each kind of file is asked for apart.
  assert.ok(names(availableTools(true, { presentations: true, fileMaking: false, spreadsheets: false })).includes("make_presentation"));
  assert.ok(!names(availableTools(true, { presentations: false, fileMaking: true, spreadsheets: true })).includes("make_presentation"));
  assert.ok(names(availableTools(true, { presentations: false, fileMaking: true })).includes("make_document"));
  assert.ok(!names(availableTools(true, { presentations: true, fileMaking: false })).includes("make_document"));
});

test("what the model is told says what to write, how notes go, and what to say afterwards", () => {
  const definition = toolDefinitions.find((entry) => entry.function.name === "make_presentation");
  assert.ok(definition);
  const description = definition.function.description;
  assert.match(description, /PRESENTATION FILE/);
  assert.match(description, /a \.pptx, and\/or a PDF of the slides/);
  assert.match(description, /Write the WHOLE deck yourself/);
  assert.match(description, /# for the deck's title/);
  assert.match(description, /a ## heading for each slide/);
  assert.match(description, /About six bullets to a slide/);
  assert.match(description, /paragraph that begins Notes:/);
  assert.match(description, /never replaces one/);
  assert.deepEqual(definition.function.parameters.required, ["content"]);
  assert.deepEqual(Object.keys(definition.function.parameters.properties).sort(), ["content", "folder", "format", "title"]);
  assert.equal(permissionLevelOf("make_presentation"), 2);
  const probe = { machineAccess: { armed: false, until: null }, model: { available: true, name: "m", reason: null }, visionModel: null, ffmpeg: true, piper: true, phoneLink: "linked" as const, emailAccount: null };
  const entry = describeTools(probe).find((found) => found.name === "make_presentation")!;
  assert.equal(entry.readiness.state, "ready");
  assert.equal(entry.asksFirst, false);
  assert.equal(entry.title, "Make a PowerPoint file");
  assert.match(entry.readiness.note ?? "", /Makes PowerPoint files, and PDFs of their slides, on this PC, with no account\./);
  const noPrinter = describeTools({ ...probe, pdfPrinter: false } as typeof probe).find((found) => found.name === "make_presentation")!;
  assert.equal(noPrinter.readiness.state, "ready", "the PowerPoint file does not need the printer");
  assert.match(noPrinter.readiness.note ?? "", /A PDF of the slides needs TRH AI's own window to print it, and it is not here\./);
});

// ---------------------------------------------------------------- making files

test("a PowerPoint file is made in the documents folder, and the reply says where it is and that every slide was checked", async () => {
  const result = await tool({ content: deck });
  assert.equal(result.ok, true, result.content);
  assert.equal(result.path, "documents/Composting at Home.pptx");
  assert.equal(result.content, [
    'Made "Composting at Home", 3 slides, 1 slide with speaker notes, and read each file back to check every slide:',
    "- documents/Composting at Home.pptx (PowerPoint presentation, 3 slides)"
  ].join("\n"));
  const slides = readSlides(readFileSync(inWorkspace("documents", "Composting at Home.pptx")));
  assert.deepEqual(slides.map((slide) => slide.text.split("\n")[0]), ["Composting at Home", "Why compost", "What goes in"]);
  assert.equal(slides[1].notes, "mention the council scheme");
});

test("a PDF of the slides is made with it, a page for each slide, and the same name is never given twice", async () => {
  await withPrinter(async () => {
    const first = await tool({ content: deck, title: "Guide", format: "PowerPoint and PDF" });
    assert.equal(first.ok, true, first.content);
    assert.match(first.content, /^Made "Guide", 3 slides, 1 slide with speaker notes, and read each file back to check every slide:\n- documents\/Guide\.pptx \(PowerPoint presentation, 3 slides\)\n- documents\/Guide\.pdf \(PDF, 3 pages\)$/);
    const second = await tool({ content: deck, title: "Guide", format: ["pptx", "pdf"] });
    assert.equal(second.path, "documents/Guide (2).pptx");
    assert.ok(existsSync(inWorkspace("documents", "Guide (2).pdf")));
  });
});

test("a PDF that does not have a page for every slide is said to be wrong, in the reply", async () => {
  await withPrinter(async () => {
    const result = await tool({ content: deck, title: "One Page", format: "pdf" });
    assert.equal(result.ok, true, result.content);
    assert.match(result.content, /Note: The PDF One Page\.pdf: it has 1 page for 3 slides; open it and look before sending it on\./);
    assert.doesNotMatch(result.content, /read each file back to check every slide/);
  }, "readable");
});

test("a PDF cannot be made without the window that prints it, and the reply says so rather than pretending", async () => {
  const saved = { electron: process.env.TRHAI_ELECTRON_PATH, desktop: process.env.TRHAI_DESKTOP_DIR };
  process.env.TRHAI_ELECTRON_PATH = path.join(outside, "no-such-electron.exe");
  delete process.env.TRHAI_DESKTOP_DIR;
  try {
    const result = await tool({ content: deck, title: "No Printer", format: "pptx, pdf" });
    assert.equal(result.ok, true, result.content);
    assert.match(result.content, /- documents\/No Printer\.pptx/);
    assert.doesNotMatch(result.content, /No Printer\.pdf \(/);
    assert.match(result.content, /Note: The PDF could not be made: /);
    assert.equal(existsSync(inWorkspace("documents", "No Printer.pdf")), false, "no empty PDF is left behind");
  } finally {
    for (const [name, value] of [["TRHAI_ELECTRON_PATH", saved.electron], ["TRHAI_DESKTOP_DIR", saved.desktop]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test("a file's whole path is understood as folder, title and format, as for documents", async () => {
  await withPrinter(async () => {
    const asFile = await tool({ content: deck, folder: "talks/Compost Talk.pdf" });
    assert.equal(asFile.ok, true, asFile.content);
    assert.equal(asFile.path, "talks/Compost Talk.pdf");
    assert.equal(existsSync(inWorkspace("talks", "Compost Talk.pptx")), false, "the ending chose the format");
    const wins = await tool({ content: deck, folder: "talks/Plan.pdf", format: "pptx" });
    assert.equal(wins.path, "talks/Plan.pptx", "a format that was asked for is not overruled by a file name");
    const pptx = await tool({ content: deck, folder: "talks/Third.pptx" });
    assert.equal(pptx.path, "talks/Third.pptx");
  });
});

test("outside the workspace is refused without machine access, and with it a full path is written to", async () => {
  for (const folder of [path.join(outside, "elsewhere"), "Desktop", "~/Documents/Talks"]) {
    const result = await tool({ content: deck, folder });
    assert.equal(result.ok, false, folder);
    assert.match(result.content, /outside my workspace\. Turn on machine access/, folder);
    assert.match(result.content, /Nothing was made\.$/);
  }
  assert.deepEqual(readdirSync(outside), []);
  armCommandsFor(60_000);
  const target = path.join(outside, "Decks");
  const result = await tool({ content: deck, title: "Out There", folder: target });
  assert.equal(result.ok, true, result.content);
  assert.equal(result.path, path.join(target, "Out There.pptx"));
  const unattended = await tool({ content: deck, folder: path.join(outside, "Unattended") }, undefined, { unattended: true });
  assert.equal(unattended.ok, false);
  assert.equal(existsSync(path.join(outside, "Unattended")), false);
});

test("the screen is offered the files made in the workspace to open, and not those made anywhere else", async () => {
  takeMadeFiles("offered-decks");
  await withPrinter(async () => {
    const inside = await tool({ content: deck, title: "Inside", format: "pptx, pdf" }, undefined, { sessionId: "offered-decks" });
    assert.equal(inside.ok, true, inside.content);
  });
  assert.deepEqual(takeMadeFiles("offered-decks"), ["documents/Inside.pptx", "documents/Inside.pdf"]);
  armCommandsFor(60_000);
  await tool({ content: deck, title: "Away", folder: path.join(outside, "Away") }, undefined, { sessionId: "offered-decks" });
  assert.deepEqual(takeMadeFiles("offered-decks"), []);
});

test("what is not an outline, or not all of it, or in a format that does not exist, is refused before anything is written", async () => {
  const before = readdirSync(inWorkspace("documents")).length;
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{}, /needs the whole outline/],
    [{ content: "  \n " }, /needs the whole outline/],
    [{ content: "<content>" }, /placeholder/],
    [{ content: "## A\n- x\n[Lines 1-40 of 400]\n- y" }, /heading of a partial read.*not the whole deck/],
    [{ content: deck, format: "odp" }, /"odp" is not a format I can make a presentation in/],
    [{ content: "---" }, /There were no slides in that outline/]
  ];
  for (const [args, pattern] of cases) {
    const result = await tool(args);
    assert.equal(result.ok, false, JSON.stringify(args).slice(0, 50));
    assert.match(result.content, pattern);
    assert.match(result.content, /Nothing was made\.$/);
  }
  assert.equal(readdirSync(inWorkspace("documents")).length, before, "nothing new was written");
});

test("the file tools do not write a PowerPoint file that nothing can open, and say what to use instead", async () => {
  for (const [name, args] of [
    ["write_file", { path: "slides.pptx", content: "# Slides" }],
    ["edit_file", { path: "slides.pptx", append: "more" }]
  ] as const) {
    const result = await runTool({ name, arguments: args }, context("write slides.pptx"));
    assert.equal(result.ok, false, name);
    assert.match(result.content, /use make_presentation with an outline of the slides; or write the text to a \.txt or \.md file instead/, name);
  }
  assert.equal(existsSync(inWorkspace("slides.pptx")), false);
});

test("a deck the assistant made can be read again by the assistant, slide by slide, with its speaker's notes", async () => {
  await tool({ content: deck, title: "Readable" });
  const read = await runTool({ name: "read_file", arguments: { path: "documents/Readable.pptx" } }, context("read documents/Readable.pptx"));
  assert.equal(read.ok, true, read.content);
  assert.match(read.content, /Slide 1\nComposting at Home\nA short guide/);
  assert.match(read.content, /Slide 2\nWhy compost\nLess waste\nBetter soil\nSpeaker notes:\nmention the council scheme/);
  assert.match(read.content, /Slide 3\nWhat goes in\nGreen\nBrown\nPeelings\nCardboard\nGrass\nLeaves/);
});

// ---------------------------------------------------------------- through the loop

async function run(question: string, replies: ScriptedReply[]) {
  const engine = await fakeEngine({ models: ["llama3.1-8b"], reply: replies });
  const config = { baseUrl: engine.baseUrl, model: "llama3.1:8b", modelFromEnv: true, timeoutMs: 5000 };
  try {
    return await runAgent(config, question, { memories: [], knowledge: [] });
  } finally {
    engine.server.close();
  }
}

test("asked for a presentation, the assistant makes it and the user is told where it is, whatever the model goes on to say", async () => {
  const result = await run("Make me a PowerPoint presentation about composting: why, what goes in.", [
    { message: { content: "", tool_calls: [{ function: { name: "make_presentation", arguments: { title: "Composting Talk", content: deck } } }] } },
    { message: { content: "Done! I saved it as talk.pptx on your Desktop." } }
  ]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.toolsUsed.map((used) => used.name), ["make_presentation"]);
  assert.match(result.text, /documents\/Composting Talk\.pptx \(PowerPoint presentation, 3 slides\)/, "the real place is in the answer");
  assert.equal(existsSync(inWorkspace("documents", "Composting Talk.pptx")), true);
});

test("asked for no slides, the tool is out of reach: no file is made", async () => {
  const result = await run("list three facts about composting", [
    { message: { content: "", tool_calls: [{ function: { name: "make_presentation", arguments: { title: "Facts", content: deck } } }] } },
    { message: { content: "1. It reduces waste.\n2. It enriches soil.\n3. It needs air." } }
  ]);
  assert.equal(existsSync(inWorkspace("documents", "Facts.pptx")), false);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.toolsUsed.filter((used) => used.name === "make_presentation"), []);
    assert.match(result.text, /reduces waste/);
  }
});
