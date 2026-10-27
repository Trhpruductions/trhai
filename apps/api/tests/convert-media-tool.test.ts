import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fakeEngine, type ScriptedReply } from "./helpers/fakeEngine.js";

// The assistant can convert an audio or video file. What is tested here is when it is offered the tool, what the tool does
// with what it passes, where the new file goes and where it may not, and that what the reply says is what is on disk. The
// refusals run anywhere; making a file needs ffmpeg, and is skipped where there is none.

const workspace = mkdtempSync(path.join(tmpdir(), "trhai-convert-media-"));
process.env.ASCEND_WORKSPACE = workspace;
const outside = mkdtempSync(path.join(tmpdir(), "trhai-convert-media-outside-"));

const { availableTools, runTool, toolDefinitions } = await import("../src/services/agentTools.js");
const { runAgent } = await import("../src/services/agentLoop.js");
const { armCommandsFor, disarmCommands } = await import("../src/services/commandRunner.js");
const { describeTools } = await import("../src/services/toolCenter.js");
const { permissionLevelOf } = await import("../src/services/toolPermissions.js");
const { takeMadeFiles } = await import("../src/services/madeFiles.js");
const { ffmpegAvailable, ffmpegProgram } = await import("../src/services/ffmpegPath.js");

test.after(() => {
  disarmCommands();
  rmSync(workspace, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});
test.beforeEach(() => { disarmCommands(); });

const skip = ffmpegAvailable() ? false : "there is no ffmpeg here";
const names = (tools: Array<{ function: { name: string } }>) => tools.map((entry) => entry.function.name);
const context = (request = "convert songs/tone.wav to mp3", extra: Record<string, unknown> = {}) => ({ memories: [], knowledge: [], request, ...extra }) as never;
const tool = (args: Record<string, unknown>, request?: string, extra?: Record<string, unknown>) => runTool({ name: "convert_media", arguments: args }, context(request, extra));
const inWorkspace = (...parts: string[]) => path.join(workspace, ...parts);

/** A three-second tone, made by ffmpeg, where the assistant can reach it. */
function makeTone(file: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  execFileSync(ffmpegProgram(), ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-ar", "44100", "-ac", "2", file], { stdio: "pipe", timeout: 60_000 });
}

// ---------------------------------------------------------------- when it is offered

test("the tool is offered when a conversion is asked for, and withheld otherwise", () => {
  assert.ok(names(availableTools(true)).includes("convert_media"), "offered by default, as every tool is until the request says otherwise");
  assert.equal(names(availableTools(true, { media: false })).includes("convert_media"), false);
  assert.ok(names(availableTools(true, { media: true })).includes("convert_media"));
  // And it is the only thing about it that changes: the other tools stay as they were.
  const without = names(availableTools(true, { media: false })).filter((name) => name !== "convert_media");
  const withIt = names(availableTools(true, { media: true })).filter((name) => name !== "convert_media");
  assert.deepEqual(without, withIt);
});

test("what the model is told says what it does, what it never does, and what to say afterwards", () => {
  const definition = toolDefinitions.find((entry) => entry.function.name === "convert_media")!;
  assert.ok(definition);
  const text = definition.function.description;
  assert.match(text, /NEW file/);
  assert.match(text, /never replaces a file/);
  assert.match(text, /original as it was/);
  assert.match(text, /make_music_video/, "a music video is another tool's");
  assert.match(text, /say(?:s)? where the new file is/);
  for (const format of ["mp3", "wav", "m4a", "flac", "ogg", "opus", "mp4"]) assert.match(text, new RegExp(format), format);
  assert.deepEqual((definition.function.parameters as { required: string[] }).required, ["source", "to"]);
  const properties = Object.keys((definition.function.parameters as { properties: object }).properties);
  assert.deepEqual(properties.sort(), ["end", "folder", "quality", "source", "start", "title", "to"]);
});

test("it is a level-two tool that is ready with ffmpeg and says what is missing without it", () => {
  assert.equal(permissionLevelOf("convert_media"), 2);
  const probe = { machineAccess: { armed: false, until: null }, model: { available: true, name: "m", reason: null }, visionModel: null, ffmpeg: true, piper: true, phoneLink: "linked" as const, emailAccount: null };
  const ready = describeTools(probe).find((entry) => entry.name === "convert_media")!;
  assert.equal(ready.readiness.state, "ready");
  assert.equal(ready.asksFirst, false);
  assert.equal(ready.title, "Convert audio and video");
  assert.equal(ready.area, "Files");
  assert.match(ready.readiness.note ?? "", /Converted with ffmpeg on this PC, with no account/);
  const without = describeTools({ ...probe, ffmpeg: false }).find((entry) => entry.name === "convert_media")!;
  assert.equal(without.readiness.state, "needs-setup");
  assert.match(without.readiness.note ?? "", /Needs ffmpeg installed/);
});

// ---------------------------------------------------------------- what it refuses (no ffmpeg needed)

test("what is missing or cannot be read is refused in words, and nothing is made", async () => {
  const before = readdirSync(workspace);
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ to: "mp3" }, /needs the path of the audio or video file to convert, in source/],
    [{ source: "   ", to: "mp3" }, /needs the path of the audio or video file/],
    [{ source: "songs/a.wav" }, /Say what to make it into: mp3, wav, m4a, flac, ogg, opus, mp4/],
    [{ source: "songs/a.wav", to: "docx" }, /"docx" is not a format this can make/],
    [{ source: "songs/a.wav", to: "mp3", start: "soon" }, /"soon" is not a start this can read/],
    [{ source: "songs/a.wav", to: "mp3", end: "1:99" }, /is not a end this can read|is not a end/]
  ];
  for (const [args, message] of cases) {
    const result = await tool(args);
    assert.equal(result.ok, false, JSON.stringify(args));
    assert.match(result.content, message, JSON.stringify(args));
    assert.match(result.content, /Nothing was made\.$/);
  }
  assert.deepEqual(readdirSync(workspace), before);
});

test("outside the workspace is refused without machine access, for what is read and for where it is written", async () => {
  for (const source of [path.join(outside, "song.wav"), "Desktop/song.wav", "~/Music/song.wav"]) {
    const result = await tool({ source, to: "mp3" });
    assert.equal(result.ok, false, source);
    assert.match(result.content, /outside my workspace\. Turn on machine access/, source);
    assert.match(result.content, /Nothing was made\.$/);
  }
  const away = await tool({ source: "songs/never.wav", to: "mp3", folder: path.join(outside, "Out") });
  assert.equal(away.ok, false);
  assert.equal(existsSync(path.join(outside, "Out")), false);
  assert.deepEqual(readdirSync(outside), []);
});

test("an unattended run stays in the workspace even with machine access on", { skip }, async () => {
  const file = path.join(outside, "unattended.wav");
  makeTone(file);
  armCommandsFor(60_000);
  const refused = await tool({ source: file, to: "mp3" }, undefined, { unattended: true });
  assert.equal(refused.ok, false);
  assert.match(refused.content, /Turn on machine access|outside my workspace/);
  assert.deepEqual(readdirSync(outside).filter((name) => name.endsWith(".mp3")), []);
});

// ---------------------------------------------------------------- making files (real ffmpeg)

test("a song in the workspace is converted beside the original, and the reply says where, with its length", { skip }, async () => {
  makeTone(inWorkspace("songs", "tone.wav"));
  takeMadeFiles("convert-beside");
  const result = await tool({ source: "songs/tone.wav", to: "mp3" }, undefined, { sessionId: "convert-beside" });
  assert.equal(result.ok, true, result.content);
  assert.equal(result.path, "songs/tone.mp3");
  assert.match(result.content, /^Made MP3 audio from tone\.wav, read back and checked \(\d+ KB\)\. It is saved here:\n- songs\/tone\.mp3 \(MP3 audio, 0:03\)\nThe original is untouched\.$/);
  assert.equal(existsSync(inWorkspace("songs", "tone.mp3")), true);
  assert.equal(existsSync(inWorkspace("songs", "tone.wav")), true, "the original is still there");
  assert.deepEqual(takeMadeFiles("convert-beside"), ["songs/tone.mp3"], "the screen is offered the new file to open");
  // Again: a new file, never the same one.
  const again = await tool({ source: "songs/tone.wav", to: "mp3" });
  assert.equal(again.path, "songs/tone (2).mp3");
});

test("a folder in the workspace named like one of this PC's folders is the workspace's, not the PC's", { skip }, async () => {
  // "Music" is also the name of a Windows folder; a file that is where the user said it is must win.
  makeTone(inWorkspace("Music", "clash.wav"));
  const result = await tool({ source: "Music/clash.wav", to: "mp3" });
  assert.equal(result.ok, true, result.content);
  assert.equal(result.path, "Music/clash.mp3");
  assert.equal(existsSync(inWorkspace("Music", "clash.mp3")), true);
});

test("where it goes follows what the user said: a folder, a name, a part of the song, a quality", { skip }, async () => {
  makeTone(inWorkspace("songs", "part.wav"));
  const result = await tool({ source: "songs/part.wav", to: "ogg", folder: "converted", title: "Clip", start: "0:00.5", end: "2.5", quality: "small" });
  assert.equal(result.ok, true, result.content);
  assert.equal(result.path, "converted/Clip.ogg");
  assert.match(result.content, /the part from 0:01 for 0:02/);
  assert.match(result.content, /\(Ogg audio, 0:02\)/);
  // The folder given as a whole path names the file too.
  const named = await tool({ source: "songs/part.wav", to: "wav", folder: "converted/Take Two.wav" });
  assert.equal(named.ok, true, named.content);
  assert.equal(named.path, "converted/Take Two.wav");
});

test("with machine access a file anywhere is converted, and the new one lands beside it, away from the workspace chips", { skip }, async () => {
  const song = path.join(outside, "elsewhere.wav");
  makeTone(song);
  armCommandsFor(60_000);
  takeMadeFiles("convert-outside");
  const result = await tool({ source: song, to: "flac" }, undefined, { sessionId: "convert-outside" });
  assert.equal(result.ok, true, result.content);
  assert.equal(result.path, path.join(outside, "elsewhere.flac"));
  assert.deepEqual(takeMadeFiles("convert-outside"), [], "only what is in the workspace is offered to open");
});

test("what is not media, or is not there, is refused with ffmpeg's own words and leaves nothing behind", { skip }, async () => {
  const missing = await tool({ source: "songs/not-here.wav", to: "mp3" });
  assert.equal(missing.ok, false);
  assert.match(missing.content, /There is no file at .*not-here\.wav\. Nothing was made\.$/);
  mkdirSync(inWorkspace("notes"), { recursive: true });
  execFileSync(process.execPath, ["-e", "require('fs').writeFileSync(process.argv[1], 'this is a note')", inWorkspace("notes", "fake.mp3")]);
  const fake = await tool({ source: "notes/fake.mp3", to: "wav" });
  assert.equal(fake.ok, false);
  assert.match(fake.content, /ffmpeg could not read fake\.mp3/);
  assert.deepEqual(readdirSync(inWorkspace("notes")), ["fake.mp3"], "no half-made file");
  const document = await tool({ source: "notes/fake.mp3".replace("fake.mp3", "readme.docx"), to: "mp3" });
  assert.equal(document.ok, false);
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

test("asked to convert a song, the assistant converts it and the user is told where it is, whatever the model goes on to say", { skip }, async () => {
  makeTone(inWorkspace("music", "loop.wav"));
  const result = await run("Convert music/loop.wav to mp3 please", [
    { message: { content: "", tool_calls: [{ function: { name: "convert_media", arguments: { source: "music/loop.wav", to: "mp3" } } }] } },
    { message: { content: "Done! I saved it as loop.mp3 on your Desktop." } }
  ]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.toolsUsed.map((used) => used.name), ["convert_media"]);
  assert.match(result.text, /music\/loop\.mp3 \(MP3 audio, 0:03\)/, "the real place is in the answer");
  assert.equal(existsSync(inWorkspace("music", "loop.mp3")), true);
});

test("asked for anything else, the tool is out of reach: no file is made", async () => {
  const result = await run("list three facts about the moon", [
    { message: { content: "", tool_calls: [{ function: { name: "convert_media", arguments: { source: "music/loop.wav", to: "wav", title: "Nope" } } }] } },
    { message: { content: "1. It has no air.\n2. It has craters.\n3. It pulls the tides." } }
  ]);
  assert.equal(existsSync(inWorkspace("music", "Nope.wav")), false);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.toolsUsed.filter((used) => used.name === "convert_media"), []);
    assert.match(result.text, /no air/);
  }
});

test("a request to convert a film offers the converter, and neither of the tools that make a video", async () => {
  const engine = await fakeEngine({ models: ["llama3.1-8b"], reply: [{ message: { content: "Sure." } }] });
  const config = { baseUrl: engine.baseUrl, model: "llama3.1:8b", modelFromEnv: true, timeoutMs: 5000 };
  try {
    await runAgent(config, "extract the audio from clip.mp4 as an mp3", { memories: [], knowledge: [] });
  } finally {
    engine.server.close();
  }
  const offered = (engine.chats[0]?.tools ?? []).map((entry) => entry.function.name);
  assert.ok(offered.includes("convert_media"), "the converter is offered");
  assert.equal(offered.includes("make_video"), false, "not the narrated-slides video");
  assert.equal(offered.includes("make_music_video"), false, "nor the music video");
});

test("asked for a music video from a song, the converter is not the tool offered", async () => {
  const result = await run("make a music video from music/loop.wav", [
    { message: { content: "", tool_calls: [{ function: { name: "convert_media", arguments: { source: "music/loop.wav", to: "mp4", title: "Wrong" } } }] } },
    { message: { content: "I can start that for you." } }
  ]);
  assert.equal(existsSync(inWorkspace("music", "Wrong.mp4")), false);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.toolsUsed.filter((used) => used.name === "convert_media"), []);
});
