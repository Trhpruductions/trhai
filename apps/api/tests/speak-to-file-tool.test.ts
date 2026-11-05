import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fakeEngine, type ScriptedReply } from "./helpers/fakeEngine.js";

// The assistant can read text into an audio file. What is tested here is when it is offered the tool, what the tool does with
// what it passes, where the file goes and where it may not, and that what the reply says is what is on disk. The refusals run
// anywhere; making a file needs the voice that is installed on this PC, and is skipped where there is none.

const workspace = mkdtempSync(path.join(tmpdir(), "trhai-speak-to-file-"));
process.env.ASCEND_WORKSPACE = workspace;
const outside = mkdtempSync(path.join(tmpdir(), "trhai-speak-to-file-outside-"));

const { availableTools, runTool, toolDefinitions } = await import("../src/services/agentTools.js");
const { runAgent } = await import("../src/services/agentLoop.js");
const { armCommandsFor, disarmCommands } = await import("../src/services/commandRunner.js");
const { describeTools } = await import("../src/services/toolCenter.js");
const { permissionLevelOf } = await import("../src/services/toolPermissions.js");
const { takeMadeFiles } = await import("../src/services/madeFiles.js");
const { piperStatus } = await import("../src/services/piperSpeech.js");
const { parseWav, peakOf, secondsOf } = await import("../src/services/speechFileMaker.js");

test.after(() => {
  disarmCommands();
  rmSync(workspace, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});
test.beforeEach(() => { disarmCommands(); });

const skip = piperStatus().available ? false : "there is no voice here";
const names = (tools: Array<{ function: { name: string } }>) => tools.map((entry) => entry.function.name);
const context = (request = "read this to a wav file", extra: Record<string, unknown> = {}) => ({ memories: [], knowledge: [], request, ...extra }) as never;
const tool = (args: Record<string, unknown>, request?: string, extra?: Record<string, unknown>) => runTool({ name: "speak_to_file", arguments: args }, context(request, extra));
const inWorkspace = (...parts: string[]) => path.join(workspace, ...parts);
const sentence = "Hello from TRH AI. This is a test of the voice, read into a file.";

// ---------------------------------------------------------------- when it is offered

test("the tool is offered when text is to be read into a file, and withheld otherwise", () => {
  assert.ok(names(availableTools(true)).includes("speak_to_file"));
  assert.equal(names(availableTools(true, { speech: false })).includes("speak_to_file"), false);
  assert.ok(names(availableTools(true, { speech: true })).includes("speak_to_file"));
  const without = names(availableTools(true, { speech: false })).filter((name) => name !== "speak_to_file");
  const withIt = names(availableTools(true, { speech: true })).filter((name) => name !== "speak_to_file");
  assert.deepEqual(without, withIt, "it is the only thing that changes");
});

test("what the model is told says what to write, what is made, and what to say afterwards", () => {
  const definition = toolDefinitions.find((entry) => entry.function.name === "speak_to_file")!;
  assert.ok(definition);
  const text = definition.function.description;
  assert.match(text, /WHOLE text to be heard/);
  assert.match(text, /nothing in \[brackets\]/);
  assert.match(text, /never replaces one/);
  assert.match(text, /says where the file is/);
  assert.match(text, /convert_media/, "an existing recording is another tool's");
  assert.match(text, /replies are already read aloud on screen/, "reading aloud now is not this");
  assert.deepEqual((definition.function.parameters as { required: string[] }).required, ["text"]);
  assert.deepEqual(Object.keys((definition.function.parameters as { properties: object }).properties).sort(), ["folder", "format", "rate", "text", "title", "voice"]);
});

test("it is a level-two tool that is ready with a voice, says what is missing without one, and says what ffmpeg adds", () => {
  assert.equal(permissionLevelOf("speak_to_file"), 2);
  const probe = { machineAccess: { armed: false, until: null }, model: { available: true, name: "m", reason: null }, visionModel: null, ffmpeg: true, piper: true, phoneLink: "linked" as const, emailAccount: null };
  const ready = describeTools(probe).find((entry) => entry.name === "speak_to_file")!;
  assert.equal(ready.readiness.state, "ready");
  assert.equal(ready.asksFirst, false);
  assert.equal(ready.title, "Read text into an audio file");
  assert.match(ready.readiness.note ?? "", /as MP3, WAV, M4A, FLAC, Ogg or Opus/);
  const noFfmpeg = describeTools({ ...probe, ffmpeg: false }).find((entry) => entry.name === "speak_to_file")!;
  assert.equal(noFfmpeg.readiness.state, "ready");
  assert.match(noFfmpeg.readiness.note ?? "", /WAV works as it is; the other formats need ffmpeg/);
  const noVoice = describeTools({ ...probe, piper: false }).find((entry) => entry.name === "speak_to_file")!;
  assert.equal(noVoice.readiness.state, "needs-setup");
  assert.match(noVoice.readiness.note ?? "", /Needs a Piper voice installed/);
});

// ---------------------------------------------------------------- what it refuses (no voice needed)

test("what is missing, or is not the whole text, or cannot be made is refused in words, and nothing is made", async () => {
  const before = readdirSync(workspace);
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{}, /needs the whole text to be read out/],
    [{ text: "   \n " }, /needs the whole text to be read out/],
    [{ text: "Hello. [insert the rest of the story here]" }, /This has \[insert the rest of the story here\] in it, which would be spoken aloud as words/],
    [{ text: "Dear [add your name], welcome." }, /This has \[add your name\] in it/],
    [{ text: "Once upon a time.\n[truncated - this file is longer than shown]" }, /is not the whole text\. Write every word out\./],
    [{ text: "Hello there.", format: "mp4" }, /Speech can be made as wav, mp3, m4a, flac, ogg, opus\./],
    [{ text: "Hello there.", format: "docx" }, /Speech can be made as wav, mp3, m4a, flac, ogg, opus\./],
    [{ text: "Hello there.", rate: 5 }, /rate must be from 0\.5 to 2/],
    [{ text: "Hello there.", rate: "fast" }, /rate must be from 0\.5 to 2/],
    [{ text: "Hello there.", rate: 0.1 }, /rate must be from 0\.5 to 2/]
  ];
  for (const [args, message] of cases) {
    const result = await tool(args);
    assert.equal(result.ok, false, JSON.stringify(args));
    assert.match(result.content, message, JSON.stringify(args));
    assert.match(result.content, /Nothing was made\.$/);
  }
  assert.deepEqual(readdirSync(workspace), before);
});

test("outside the workspace is refused without machine access, and an unattended run stays inside even with it", async () => {
  for (const folder of [path.join(outside, "Out"), "Desktop", "~/Documents/Audio"]) {
    const result = await tool({ text: "Hello there.", folder });
    assert.equal(result.ok, false, folder);
    assert.match(result.content, /outside my workspace\. Turn on machine access/, folder);
  }
  assert.deepEqual(readdirSync(outside), []);
  armCommandsFor(60_000);
  const unattended = await tool({ text: "Hello there.", folder: path.join(outside, "Unattended") }, undefined, { unattended: true });
  assert.equal(unattended.ok, false);
  assert.equal(existsSync(path.join(outside, "Unattended")), false);
});

// ---------------------------------------------------------------- making files (the real voice)

test("text is read into a WAV in the documents folder, the reply says where it is, and the file is what it says", { skip }, async () => {
  takeMadeFiles("speak-docs");
  const result = await tool({ text: sentence, format: "wav" }, undefined, { sessionId: "speak-docs" });
  assert.equal(result.ok, true, result.content);
  assert.equal(result.path, "documents/Hello from TRH AI This is.wav", "named for its first six words");
  assert.match(result.content, /^Made WAV audio of the text \(\d+ letters, read in the \w+ voice\), read back and checked \(\d+ KB\)\. It is saved here:\n- documents\/Hello from TRH AI This is\.wav \(WAV audio, 0:\d\d\)$/);
  const wav = parseWav(readFileSync(inWorkspace("documents", "Hello from TRH AI This is.wav")));
  assert.ok(wav && secondsOf(wav) > 2 && peakOf(wav) > 1000, "a real WAV with real speech in it");
  assert.deepEqual(takeMadeFiles("speak-docs"), ["documents/Hello from TRH AI This is.wav"], "the screen is offered it to open");
  const again = await tool({ text: sentence, format: "wav" });
  assert.equal(again.path, "documents/Hello from TRH AI This is (2).wav", "never the same file twice");
});

test("a voice, a name, a folder and a speed are what the user said", { skip }, async () => {
  const result = await tool({ text: "The quick brown fox jumps over the lazy dog.", voice: "Jarvis", format: "wav", title: "Fox", folder: "audio", rate: 1.1 });
  assert.equal(result.ok, true, result.content);
  assert.equal(result.path, "audio/Fox.wav");
  assert.match(result.content, /read in the Jarvis voice/);
  // The folder given as a whole path names the file and the format too.
  const named = await tool({ text: "Another line to read.", folder: "audio/Line Two.wav" });
  assert.equal(named.ok, true, named.content);
  assert.equal(named.path, "audio/Line Two.wav");
  // A voice that is not here is said, with the ones that are.
  const nobody = await tool({ text: "Hello.", voice: "Morgan", format: "wav" });
  assert.equal(nobody.ok, false);
  assert.match(nobody.content, /There is no voice called "Morgan" here\. The voices are .*Jarvis/);
  assert.equal(existsSync(inWorkspace("audio", "Hello.wav")), false);
});

test("with machine access a file is written where the user said, away from the workspace chips", { skip }, async () => {
  armCommandsFor(60_000);
  takeMadeFiles("speak-away");
  const target = path.join(outside, "Audio");
  const result = await tool({ text: "Hello there, away from home.", format: "wav", title: "Away", folder: target }, undefined, { sessionId: "speak-away" });
  assert.equal(result.ok, true, result.content);
  assert.equal(result.path, path.join(target, "Away.wav"));
  assert.deepEqual(takeMadeFiles("speak-away"), []);
});

// ---------------------------------------------------------------- through the loop

async function run(question: string, replies: ScriptedReply[]) {
  const engine = await fakeEngine({ models: ["llama3.1-8b"], reply: replies });
  const config = { baseUrl: engine.baseUrl, model: "llama3.1:8b", modelFromEnv: true, timeoutMs: 5000 };
  try {
    return { result: await runAgent(config, question, { memories: [], knowledge: [] }), engine };
  } finally {
    engine.server.close();
  }
}

test("asked to read text into an audio file, the assistant does, and the user is told where it is, whatever the model goes on to say", { skip }, async () => {
  const { result } = await run("Read this to a wav file: Hello from TRH AI, this is a loop test.", [
    { message: { content: "", tool_calls: [{ function: { name: "speak_to_file", arguments: { text: "Hello from TRH AI, this is a loop test.", format: "wav", title: "Loop Test" } } }] } },
    { message: { content: "Done! I saved it on your Desktop as loop.mp3." } }
  ]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.toolsUsed.map((used) => used.name), ["speak_to_file"]);
  assert.match(result.text, /documents\/Loop Test\.wav \(WAV audio, 0:\d\d\)/, "the real place is in the answer");
  assert.equal(existsSync(inWorkspace("documents", "Loop Test.wav")), true);
});

test("asked for anything else, the tool is out of reach: no file is made", async () => {
  const { result } = await run("list three facts about the moon", [
    { message: { content: "", tool_calls: [{ function: { name: "speak_to_file", arguments: { text: "The moon has no air.", format: "wav", title: "Nope" } } }] } },
    { message: { content: "1. It has no air.\n2. It has craters.\n3. It pulls the tides." } }
  ]);
  assert.equal(existsSync(inWorkspace("documents", "Nope.wav")), false);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.toolsUsed.filter((used) => used.name === "speak_to_file"), []);
});

test("a request to convert a recording that exists offers the converter and not the voice", async () => {
  const { engine } = await run("convert song.wav to mp3", [{ message: { content: "Sure." } }]);
  const offered = (engine.chats[0]?.tools ?? []).map((entry) => entry.function.name);
  assert.ok(offered.includes("convert_media"));
  assert.equal(offered.includes("speak_to_file"), false);
  const second = await run("make an audio file of this story: Once there was a fox.", [{ message: { content: "Sure." } }]);
  const offeredSecond = (second.engine.chats[0]?.tools ?? []).map((entry) => entry.function.name);
  assert.ok(offeredSecond.includes("speak_to_file"));
  assert.equal(offeredSecond.includes("convert_media"), false);
});
