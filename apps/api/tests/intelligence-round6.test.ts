import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// A workspace of its own, so the build tools write nowhere near the repo.
const testWorkspace = mkdtempSync(path.join(tmpdir(), "ascend-round6-"));
process.env.ASCEND_WORKSPACE = testWorkspace;

import { runTool } from "../src/services/agentTools.js";
import { classifyIntent } from "../src/services/actionIntent.js";
import { noteProjectTouched, resetActiveProjects, resolveProjectReference } from "../src/services/activeProject.js";

// Sixth intelligence sweep: changing an app after building it. Found live:
// "add a 'notes' text field to the plants", said right after building a
// houseplant tracker, built a second app called "Notes Text Field"; "run its
// smoke test" was asked which project; "what files did that create?" listed
// the whole workspace.

const session = "round6-session";
const context = { memories: [], knowledge: [], sessionId: session, request: "" };

test("build, then change: the app is rebuilt in place with the field added", async () => {
  resetActiveProjects();
  const built = await runTool(
    { name: "build_app", arguments: { description: "build a small app that tracks my houseplants with a name, species and last watered date" } },
    { ...context, request: "build a small app that tracks my houseplants with a name, species and last watered date" }
  );
  assert.equal(built.ok, true, built.content);
  const folder = built.content.match(/at ([\w-]+)\//)?.[1];
  assert.ok(folder, built.content);
  const html = () => readFileSync(path.join(testWorkspace, folder, "public", "index.html"), "utf8");
  assert.ok(!/notes/i.test(html()), "no notes field before the change");

  // The user's data is theirs: written between the build and the change,
  // it has to survive the rebuild.
  const dataDir = path.join(testWorkspace, folder, "data");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(dataDir, "data.json"), JSON.stringify({ houseplants: [{ id: "1", title: "Fern" }] }), "utf8");

  // The model rewrote the README with prose of its own the turn after a
  // build; the change must not depend on it.
  writeFileSync(path.join(testWorkspace, folder, "README.md"), "# Tracks My Houseplants\n\nTracks the health and growth of your houseplants.\n", "utf8");

  const changed = await runTool(
    { name: "change_app", arguments: { change: "add a 'notes' text field to the plants" } },
    { ...context, request: "add a 'notes' text field to the plants" }
  );
  assert.equal(changed.ok, true, changed.content);
  assert.match(changed.content, /added a text field "notes" to houseplant/);
  assert.match(changed.content, /Verified/);
  assert.ok(/notes/i.test(html()), "the form now has the notes field");
  assert.ok(/notes/i.test(readFileSync(path.join(testWorkspace, folder, "server.js"), "utf8")));
  // The app's own store normalises the file when it runs its checks; the
  // record is what has to survive.
  const data = JSON.parse(readFileSync(path.join(dataDir, "data.json"), "utf8")) as { houseplants: Array<{ title: string }> };
  assert.deepEqual(data.houseplants.map((row) => row.title), ["Fern"], "the user's records survive the rebuild");
  assert.ok(!existsSync(path.join(testWorkspace, "notes-text-field")), "no second app");

  // The README carries the change for people, and the manifest for the
  // next change_app.
  const readme = readFileSync(path.join(testWorkspace, folder, "README.md"), "utf8");
  assert.match(readme, /## Changes/);
  assert.match(readme, /- add a 'notes' text field to the plants/);
  const manifest = JSON.parse(readFileSync(path.join(testWorkspace, folder, ".vexora-app.json"), "utf8")) as { request: string; changes: string[] };
  assert.match(manifest.request, /houseplants with a name, species and last watered date/);
  assert.deepEqual(manifest.changes, ["add a 'notes' text field to the plants"]);

  const again = await runTool(
    { name: "change_app", arguments: { change: "add a dashboard" } },
    { ...context, request: "add a dashboard" }
  );
  assert.equal(again.ok, true, again.content);
  assert.ok(/notes/i.test(html()), "the earlier change survives the next one");
  assert.ok(/dashboard|summary/i.test(html()));
});

test("a change that maps onto nothing is refused with what would", async () => {
  const result = await runTool(
    { name: "change_app", arguments: { change: "make it prettier" } },
    context
  );
  assert.equal(result.ok, false);
  assert.match(result.content, /could not map/);
  assert.match(result.content, /edit_file/);
});

test("change_app with no app to change says so", async () => {
  resetActiveProjects();
  const result = await runTool({ name: "change_app", arguments: { change: "add a notes field" } }, { ...context, sessionId: "round6-empty" });
  assert.equal(result.ok, false);
  assert.match(result.content, /none has been built/);

  const missing = await runTool({ name: "change_app", arguments: { change: "add a notes field", project: "no-such-app" } }, context);
  assert.equal(missing.ok, false);
  assert.match(missing.content, /was not built by build_app/);
});

test("a request about the app the session is in is resolved to it", () => {
  resetActiveProjects();
  noteProjectTouched(session, "tracks-my-houseplants/server.js");

  const change = resolveProjectReference("add a 'notes' text field to the plants", session);
  assert.ok(change, "a change to the app is about the app");
  assert.equal(change.project, "tracks-my-houseplants");
  assert.match(change.request, /call change_app/);
  const intent = classifyIntent(change.request);
  assert.equal(intent.kind, "write", JSON.stringify(intent));
  assert.equal(intent.hasTarget, true);

  assert.ok(resolveProjectReference("run its smoke test", session), "its");
  assert.ok(resolveProjectReference("what files did that create?", session), "that");
  assert.match(resolveProjectReference("run its smoke test", session)?.request ?? "", /tracks-my-houseplants/);
  const check = classifyIntent(resolveProjectReference("run its smoke test", session)?.request ?? "");
  assert.equal(check.kind, "check");
  assert.equal(check.hasTarget, true, "the project path is the target");

  // A second app, a named path, or an unrelated sentence: not the project.
  assert.equal(resolveProjectReference("build me a new app for recipes", session), null);
  assert.equal(resolveProjectReference("add a line to D:/x/notes.txt", session), null);
  assert.equal(resolveProjectReference("what is 2 + 2", session), null);
  assert.equal(resolveProjectReference("add a notes field", "round6-nothing-active"), null);
  resetActiveProjects();
});

// ---------------------------------------------------------------------------
// Things said in passing that are worth keeping.

test("a favourite and a named relation are remembered", async () => {
  const { extractMemoryCandidates } = await import("../src/services/memoryExtraction.js");
  // Verbatim. "what's my favorite color and my dog's name?" got the colour
  // from the transcript and nothing about the dog.
  assert.equal(extractMemoryCandidates("my favorite color is green")[0]?.body, "my favorite color is green");
  assert.equal(extractMemoryCandidates("and my dog is called Rex")[0]?.body, "my dog is called Rex");
  assert.equal(extractMemoryCandidates("my wife's name is Ana")[0]?.body, "my wife's name is Ana");
  assert.deepEqual(extractMemoryCandidates("my day is going well"), []);
});

test("the nth thing said is answered from the transcript", async () => {
  const { parseNthThingRequest } = await import("../src/services/memoryRequests.js");
  const { runAssistantOrchestrator } = await import("../src/services/orchestrator.js");
  assert.equal(parseNthThingRequest("what was the second thing I told you?"), 2);
  assert.equal(parseNthThingRequest("What was the first thing I asked you"), 1);
  assert.equal(parseNthThingRequest("what was the last thing I said?"), -1);
  assert.equal(parseNthThingRequest("what was the second option?"), null);

  const history = [
    { role: "user" as const, content: "my favorite color is green" },
    { role: "assistant" as const, content: "Got it, saved." },
    { role: "user" as const, content: "and my dog is called Rex" },
    { role: "assistant" as const, content: "Got it, saved." }
  ];
  // Verbatim: answered "I don't have any saved memories of things you told me".
  const reply = await runAssistantOrchestrator({ mode: "general", userMessage: "what was the second thing I told you?", sessionId: "nth-flow", history });
  assert.equal(reply.strategy, "recap", reply.assistantMessage);
  assert.match(reply.assistantMessage, /my dog is called Rex/);
  const tooMany = await runAssistantOrchestrator({ mode: "general", userMessage: "what was the fifth thing I told you?", sessionId: "nth-flow", history });
  assert.match(tooMany.assistantMessage, /2 things so far/);
});

test("a two-part question answered from one transcript turn is marked partial", async () => {
  const { composeReply } = await import("../src/services/replyComposer.js");
  const reply = composeReply({
    mode: "general",
    message: "what's my favorite color and my dog's name?",
    memories: [],
    history: [
      { role: "user", content: "my favorite color is green, I use it everywhere" },
      { role: "assistant", content: "Got it." }
    ]
  });
  assert.equal(reply.strategy, "answer", reply.text);
  assert.equal(reply.partial, true, reply.text);
});

// ---------------------------------------------------------------------------
// A question is answered; it is not a licence to write.

test("a question with a path in it gets no tool that changes the machine", async () => {
  const { availableTools } = await import("../src/services/agentTools.js");
  const { analyzeRequest } = await import("../src/services/requestAnalysis.js");
  // Verbatim. read_file missed and write_file then CREATED classifyIntent.js
  // in the source tree, with placeholder code, three times.
  const question = "in D:/trhai/apps/api/src/services, which file defines the function classifyIntent?";
  const intent = classifyIntent(question);
  assert.equal(intent.action, false, JSON.stringify(intent));
  assert.equal(analyzeRequest(question).shape, "question");
  const offered = availableTools(true, { writes: false }).map((definition) => definition.function.name);
  for (const tool of ["write_file", "edit_file", "build_app", "change_app", "write_document", "update_document"]) {
    assert.ok(!offered.includes(tool), `${tool} offered to a question`);
  }
  // The machine still answers questions about itself.
  assert.ok(offered.includes("run_command"), "run_command answers 'is anything listening on port 4000?'");
  assert.ok(offered.includes("read_file"));
  assert.ok(offered.includes("list_files"));
});

// ---------------------------------------------------------------------------
// Commands, on Windows, from a question.

test("cd to another drive switches drive", async () => {
  const { crossDrive } = await import("../src/services/commandRunner.js");
  // `cd D:\app && npm test` from C: ran npm test in the home folder.
  assert.equal(crossDrive("cd D:\\Vexora\\workspace\\app && npm test"), "cd /d D:\\Vexora\\workspace\\app && npm test");
  assert.equal(crossDrive('cd "D:/Vexora/workspace/app" && npm start'), 'cd /d "D:/Vexora/workspace/app" && npm start');
  assert.equal(crossDrive("cd /d D:\\app && dir"), "cd /d D:\\app && dir", "already switching");
  assert.equal(crossDrive("cd app && npm test"), "cd app && npm test", "no drive, no change");
  assert.equal(crossDrive("echo hi && cd E:\\x && dir"), "echo hi && cd /d E:\\x && dir");
});

test("search_files finds the file that defines a function", async () => {
  // Verbatim: "which file defines the function classifyIntent?" went to
  // search_memory, then to findstr with forward slashes, which printed
  // nothing.
  const { armCommands, disarmCommands } = await import("../src/services/commandRunner.js");
  const dir = mkdtempSync(path.join(tmpdir(), "ascend-search-"));
  mkdirSync(path.join(dir, "services"));
  mkdirSync(path.join(dir, "node_modules", "dep"), { recursive: true });
  writeFileSync(path.join(dir, "services", "actionIntent.ts"), "export function classifyIntent(message: string) {\n  return message;\n}\n", "utf8");
  writeFileSync(path.join(dir, "services", "other.ts"), "import { classifyIntent } from './actionIntent.js';\n", "utf8");
  writeFileSync(path.join(dir, "node_modules", "dep", "index.js"), "classifyIntent", "utf8");
  armCommands();
  try {
    const result = await runTool({ name: "search_files", arguments: { directory: dir, pattern: "function classifyIntent" } }, { memories: [], knowledge: [] });
    assert.equal(result.ok, true, result.content);
    assert.match(result.content, /actionIntent\.ts:1: export function classifyIntent/);
    assert.doesNotMatch(result.content, /other\.ts/);
    assert.doesNotMatch(result.content, /node_modules/);

    const typed = await runTool({ name: "search_files", arguments: { directory: dir, pattern: "classifyintent", extension: "ts" } }, { memories: [], knowledge: [] });
    assert.equal(typed.ok, true);
    assert.match(typed.content, /other\.ts:1/);

    const none = await runTool({ name: "search_files", arguments: { directory: dir, pattern: "nothing-like-this" } }, { memories: [], knowledge: [] });
    assert.equal(none.ok, false);
    assert.match(none.content, /Nothing under/);
  } finally {
    disarmCommands();
  }
});

test("a narrated command is recognised, and a bare run_command line is a call", async () => {
  const { narratesACommand, parseTextToolCalls, asksToRemember } = await import("../src/services/agentLoop.js");
  assert.equal(narratesACommand("To check if anything is listening on port 4000, I'll run the following command:\n\n```\nnetstat -an | findstr :4000\n```\n\nThis will show you if any processes are currently using that port."), true);
  assert.equal(narratesACommand("Run this:\n```\ndir\n```"), true);
  assert.equal(narratesACommand("The port is in use by node."), false);
  // Telling the user how to start the app is not a command to run here.
  assert.equal(narratesACommand("The app is built. You can run it with:\n```\ncd tracks-my-houseplants && npm start\n```"), false);
  assert.equal(narratesACommand("Here is the function:\n```js\nfunction add(a, b) { return a + b }\n```"), false);

  // run_command is only advertised while access is on, and only an
  // advertised tool is parsed out of text.
  const { armCommands, disarmCommands } = await import("../src/services/commandRunner.js");
  armCommands();
  try {
    const calls = parseTextToolCalls('run_command powershell -Command "Get-PSDrive D"');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "run_command");
    assert.equal(calls[0].arguments.command, 'powershell -Command "Get-PSDrive D"');
    // Prose that happens to open with the tool's name is not a call.
    assert.equal(parseTextToolCalls("run_command is the tool that would do it, but it is not on.").length, 0);
  } finally {
    disarmCommands();
  }

  assert.equal(asksToRemember("remember that my port is 8080, then list what you have"), true);
  assert.equal(asksToRemember("run its smoke test"), false);
});

test("a PowerShell cmdlet runs in PowerShell", async () => {
  const { forShell } = await import("../src/services/commandRunner.js");
  // `Get-PSDrive D` arrived bare and cmd.exe printed the line back.
  assert.equal(forShell("Get-PSDrive D"), 'powershell -NoProfile -Command "Get-PSDrive D"');
  assert.equal(forShell('Get-ChildItem "D:\\x" | Measure-Object'), 'powershell -NoProfile -Command "Get-ChildItem \\"D:\\x\\" | Measure-Object"');
  assert.equal(forShell("dir D:\\x"), "dir D:\\x");
  assert.equal(forShell("cd D:\\x && npm test"), "cd /d D:\\x && npm test");
});

test("list_files shows a folder's own entries, folders first", async () => {
  const { armCommands, disarmCommands } = await import("../src/services/commandRunner.js");
  const dir = mkdtempSync(path.join(tmpdir(), "ascend-list-"));
  mkdirSync(path.join(dir, "apps", "api", "data"), { recursive: true });
  mkdirSync(path.join(dir, "packages"));
  writeFileSync(path.join(dir, "apps", "api", "data", "tasks.json"), "{}", "utf8");
  writeFileSync(path.join(dir, "README.md"), "# repo", "utf8");
  armCommands();
  try {
    // Asked for the top-level folders of a repository, the old listing
    // answered with two hundred deep files, newest first, and no folder.
    const result = await runTool({ name: "list_files", arguments: { directory: dir } }, { memories: [], knowledge: [] });
    assert.equal(result.ok, true, result.content);
    const lines = result.content.split("\n");
    assert.equal(lines[0], "- apps/ (3 entries)");
    assert.equal(lines[1], "- packages/");
    assert.match(lines[2], /^- README\.md \(6 bytes\)$/);
    assert.doesNotMatch(result.content, /tasks\.json/);
    assert.match(result.content, /top level only/);

    const deep = await runTool({ name: "list_files", arguments: { directory: dir, recursive: true } }, { memories: [], knowledge: [] });
    assert.match(deep.content, /tasks\.json/);
  } finally {
    disarmCommands();
  }
});

test("a workspace subfolder is listed relative to itself", async () => {
  // Workspace listings carry the folder's own name on every path, so the
  // top level was empty and the whole tree came back; and the entries came
  // newest first, which under load put packages/ above apps/.
  const { armCommands, disarmCommands } = await import("../src/services/commandRunner.js");
  mkdirSync(path.join(testWorkspace, "listed-app", "public"), { recursive: true });
  mkdirSync(path.join(testWorkspace, "listed-app", "data"), { recursive: true });
  writeFileSync(path.join(testWorkspace, "listed-app", "server.js"), "// server", "utf8");
  writeFileSync(path.join(testWorkspace, "listed-app", "public", "index.html"), "<html></html>", "utf8");
  armCommands();
  try {
    const result = await runTool({ name: "list_files", arguments: { directory: "listed-app" } }, { memories: [], knowledge: [] });
    assert.equal(result.ok, true, result.content);
    const lines = result.content.split("\n").filter((line) => line.startsWith("- "));
    assert.deepEqual(lines.slice(0, 3).map((line) => line.replace(/ \(\d+ (?:entries|bytes)\)$/, "")), [
      "- listed-app/data/", "- listed-app/public/", "- listed-app/server.js"
    ]);
    assert.doesNotMatch(result.content, /index\.html/);
  } finally {
    disarmCommands();
  }
});

test("a command is filed as an install, a test or a launch by its words", async () => {
  // The classifier carried literal backspace characters where \b was meant,
  // so no command was ever an install, a test or a launch in the trace.
  const { armCommands, disarmCommands } = await import("../src/services/commandRunner.js");
  const { listEvents } = await import("../src/services/executionLog.js");
  armCommands();
  try {
    const session = "kind-session";
    await runTool({ name: "run_command", arguments: { command: "npm test --help" } }, { memories: [], knowledge: [], sessionId: session });
    const kinds = listEvents(session).map((event) => event.kind);
    assert.ok(kinds.includes("test"), `expected a test event, got ${kinds.join(", ")}`);
  } finally {
    disarmCommands();
  }
});
