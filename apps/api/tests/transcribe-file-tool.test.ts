import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fakeEngine, type ScriptedReply } from "./helpers/fakeEngine.js";

// The assistant can write out a recording. What is tested here is when it is offered the tool, what the
// tool does with what it passes, where the file goes and where it may not, and that what the reply says
// is what is on disk. ffmpeg and whisper.cpp are stood in for: their real behaviour together was checked
// by hand on a PC that has them (docs/27), and the CI has neither.

const workspace = mkdtempSync(path.join(tmpdir(), "trhai-transcribe-"));
process.env.ASCEND_WORKSPACE = workspace;
const outside = mkdtempSync(path.join(tmpdir(), "trhai-transcribe-outside-"));

const { availableTools, runTool, toolDefinitions } = await import("../src/services/agentTools.js");
const { runAgent } = await import("../src/services/agentLoop.js");
const { wantsTranscript } = await import("../src/services/actionIntent.js");
const { disarmCommands } = await import("../src/services/commandRunner.js");
const { describeTools } = await import("../src/services/toolCenter.js");
const { permissionLevelOf } = await import("../src/services/toolPermissions.js");
const {
  describeTranscript, parseTranscriptFormat, spokenWords, tidyTranscript, transcribeArgs, transcribeFile
} = await import("../src/services/fileTranscriber.js");
type WhisperRun = import("../src/services/lyricTranscribe.js").WhisperRun;
type RunFfmpeg = import("../src/services/mediaConverter.js").RunFfmpeg;
type WhisperStatus = import("../src/services/whisperTranscribe.js").WhisperStatus;
type TranscriptFormat = import("../src/services/fileTranscriber.js").TranscriptFormat;

test.after(() => {
  disarmCommands();
  rmSync(workspace, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});
test.beforeEach(() => { disarmCommands(); });

const names = (tools: Array<{ function: { name: string } }>) => tools.map((entry) => entry.function.name);

// ---------------------------------------------------------------- when it is offered

test("a request to write out a recording is recognised, in the words people use", () => {
  for (const request of [
    "transcribe meeting.mp3",
    "can you transcribe this recording?",
    "I need a transcript of the interview",
    "turn this recording into text",
    "convert voice-note.m4a to text",
    "write out what is said in interview.m4a",
    "what do they say in lecture.mp4?",
    "what was said in the recording?",
    "make subtitles for clip.mp4",
    "add captions to this video",
    "I need closed captions for the film",
    "type up this voice memo"
  ]) {
    assert.equal(wantsTranscript(request), true, request);
  }
});

test("a program that transcribes, what the word means, a music video and a picture's caption are not it", () => {
  for (const request of [
    "build me a transcription app",
    "write a script that transcribes audio",
    "what is a transcript?",
    "explain what a transcription is",
    "make a music video with the lyrics on screen for song.mp3",
    "write a caption for this photo",
    "convert song.wav to mp3",
    "read this story to an mp3",
    "write out the alphabet",
    "what did you say?",
    "hello"
  ]) {
    assert.equal(wantsTranscript(request), false, request);
  }
});

test("the tool is offered when a recording is to be written out, and withheld otherwise", () => {
  assert.ok(names(availableTools(true)).includes("transcribe_file"));
  assert.equal(names(availableTools(true, { transcripts: false })).includes("transcribe_file"), false);
  assert.equal(names(availableTools(false, { writes: false, transcripts: true })).includes("transcribe_file"), false, "a turn that may not write does not get it");
  const definition = toolDefinitions.find((entry) => entry.function.name === "transcribe_file");
  assert.deepEqual(definition?.function.parameters.required, ["source"]);
});

test("it asks nothing extra, it is a tool that makes a file, and the Tools screen says what it needs", () => {
  assert.equal(permissionLevelOf("transcribe_file"), 2);
  const probe = { machineAccess: { armed: false, until: null }, model: { available: true, name: "m", reason: null }, visionModel: null, ffmpeg: true, piper: true, whisper: true, phoneLink: "linked" as const, emailAccount: null, pdfPrinter: true };
  const listed = (changed: Partial<typeof probe>) => describeTools({ ...probe, ...changed } as never).find((entry) => entry.name === "transcribe_file")!;
  assert.equal(listed({}).readiness.state, "ready");
  assert.equal(listed({}).asksFirst, false);
  assert.equal(listed({}).area, "Files");
  assert.equal(listed({}).title, "Write out a recording");
  assert.match(listed({}).readiness.note ?? "", /nothing leaves the PC/);
  assert.equal(listed({ whisper: false }).readiness.state, "needs-setup");
  assert.match(listed({ whisper: false }).readiness.note ?? "", /Needs Listening/);
  assert.equal(listed({ ffmpeg: false }).readiness.state, "needs-setup");
  assert.match(listed({ ffmpeg: false }).readiness.note ?? "", /Needs ffmpeg/);
});

// ---------------------------------------------------------------- the formats

test("the format is one of three, by any of its usual names, and left out is a plain transcript", () => {
  assert.deepEqual(parseTranscriptFormat(undefined), { ok: true, format: "txt" });
  assert.deepEqual(parseTranscriptFormat(""), { ok: true, format: "txt" });
  assert.deepEqual(parseTranscriptFormat("TXT"), { ok: true, format: "txt" });
  assert.deepEqual(parseTranscriptFormat(".srt"), { ok: true, format: "srt" });
  assert.deepEqual(parseTranscriptFormat("subtitles"), { ok: true, format: "srt" });
  assert.deepEqual(parseTranscriptFormat("captions"), { ok: true, format: "srt" });
  assert.deepEqual(parseTranscriptFormat("webvtt"), { ok: true, format: "vtt" });
  const refused = parseTranscriptFormat("docx");
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.reason, /"docx" is not a format this writes\. It writes txt, srt, vtt/);
});

test("whisper is asked for the format, with times only on subtitles, and the language fixed only for an English-only model", () => {
  const base = { model: "m.bin", wav: "w.wav", prefix: "p" };
  assert.deepEqual(transcribeArgs({ ...base, format: "txt", english: true }), ["-m", "m.bin", "-f", "w.wav", "-otxt", "-of", "p", "-np", "-nt", "-l", "en"]);
  assert.deepEqual(transcribeArgs({ ...base, format: "srt", english: false }), ["-m", "m.bin", "-f", "w.wav", "-osrt", "-of", "p", "-np", "-l", "auto"]);
  assert.deepEqual(transcribeArgs({ ...base, format: "vtt", english: true }), ["-m", "m.bin", "-f", "w.wav", "-ovtt", "-of", "p", "-np", "-l", "en"]);
});

test("what is not speech is taken out, and a recording with nothing else in it has no words", () => {
  assert.equal(tidyTranscript(" Hello there.\n [BLANK_AUDIO]\n (music)\n  How are you?\n", "txt"), "Hello there.\nHow are you?\n");
  assert.equal(tidyTranscript(" [BLANK_AUDIO]\n", "txt"), "");

  const srt = "1\n00:00:00,000 --> 00:00:02,000\n Hello there.\n\n2\n00:00:02,000 --> 00:00:04,000\n [BLANK_AUDIO]\n\n3\n00:00:04,000 --> 00:00:06,000\n How are you?\n\n";
  assert.equal(tidyTranscript(srt, "srt"), "1\n00:00:00,000 --> 00:00:02,000\nHello there.\n\n2\n00:00:04,000 --> 00:00:06,000\nHow are you?\n");
  assert.equal(tidyTranscript("1\n00:00:00,000 --> 00:00:02,000\n [BLANK_AUDIO]\n\n", "srt"), "");

  const vtt = "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n Hello there.\n\n00:00:02.000 --> 00:00:04.000\n (music)\n\n";
  assert.equal(tidyTranscript(vtt, "vtt"), "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHello there.\n");

  assert.equal(spokenWords("Hello there.\nHow are you?\n", "txt"), "Hello there. How are you?");
  assert.equal(spokenWords(tidyTranscript(srt, "srt"), "srt"), "Hello there. How are you?");
  assert.equal(spokenWords(tidyTranscript(vtt, "vtt"), "vtt"), "Hello there.");
});

// ---------------------------------------------------------------- making one, with ffmpeg and whisper stood in for

const status: WhisperStatus = {
  available: true,
  model: { id: "ggml-base.en", size: "base", englishOnly: true, modelPath: "C:/tools/ggml-base.en.bin" },
  models: [],
  binaryPath: path.join("C:", "tools", "whisper-cli.exe")
};

const probeWith = (streams: string, duration = "00:01:05.00") => `Duration: ${duration}, start: 0\n  ${streams}\n`;

/** ffmpeg: asked what is in a file (no output named), it says; asked to make the copy, it does nothing and succeeds. */
function ffmpegThatSays(said = probeWith("Stream #0:0: Audio: mp3")): { run: RunFfmpeg; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: async (args) => {
      calls.push(args);
      return args.includes("-ar") ? { code: 0, stderr: "", timedOut: false } : { code: 1, stderr: said, timedOut: false };
    }
  };
}

/** whisper: writes what it was given to the file it was told to, by the format it was asked for. */
function whisperThatHears(heard: string, format: TranscriptFormat = "txt"): { run: WhisperRun; calls: Array<{ args: string[]; timeoutMs: number }> } {
  const calls: Array<{ args: string[]; timeoutMs: number }> = [];
  return {
    calls,
    run: async (_program, args, options) => {
      calls.push({ args, timeoutMs: options.timeoutMs });
      writeFileSync(`${args[args.indexOf("-of") + 1]}.${format}`, heard);
      return { code: 0, stderr: "", aborted: false, timedOut: false };
    }
  };
}

function recording(name = "meeting.mp3"): { source: string; directory: string } {
  const directory = mkdtempSync(path.join(outside, "made-"));
  const source = path.join(directory, name);
  writeFileSync(source, "pretend audio");
  return { source, directory };
}

const stoodIn = (ffmpeg = ffmpegThatSays(), whisper = whisperThatHears(" Hello there.\n How are you?\n")) => ({
  status, ffmpegIsHere: () => true, run: ffmpeg.run, whisper: whisper.run
});

test("a recording is written out, saved beside it under its own name, read back, and described", async () => {
  const { source, directory } = recording();
  const ffmpeg = ffmpegThatSays();
  const whisper = whisperThatHears(" Hello there.\n [BLANK_AUDIO]\n How are you?\n");
  const made = await transcribeFile({ source, format: "txt" }, directory, stoodIn(ffmpeg, whisper));
  assert.equal(made.ok, true, JSON.stringify(made));
  if (!made.ok) return;
  assert.equal(made.file.name, "meeting.txt");
  assert.equal(readFileSync(made.file.path, "utf8"), "Hello there.\nHow are you?\n");
  assert.equal(made.file.words, 5);
  assert.equal(made.from.seconds, 65);
  assert.equal(made.excerpt, "Hello there. How are you?");
  assert.equal(readFileSync(source, "utf8"), "pretend audio", "the recording is untouched");

  // ffmpeg reads local files only, and whisper is given the time the length of the recording earns: twice it, and a minute.
  const copy = ffmpeg.calls.find((args) => args.includes("-ar")) as string[];
  assert.deepEqual(copy.slice(copy.indexOf("-protocol_whitelist"), copy.indexOf("-protocol_whitelist") + 2), ["-protocol_whitelist", "file"]);
  assert.deepEqual(copy.slice(copy.indexOf("-ac"), copy.indexOf("-ac") + 4), ["-ac", "1", "-ar", "16000"]);
  assert.equal(whisper.calls[0].timeoutMs, 190_000);

  assert.equal(describeTranscript(made, (file) => path.basename(file)), [
    "Wrote down what is said in meeting.mp3 (1:05, about 5 words), read back and checked. It is saved here:",
    "- meeting.txt (text file)",
    "It begins: \"Hello there. How are you?\"",
    "The recording is untouched."
  ].join("\n"));
});

test("subtitles keep their times, and a long transcript is only begun in what is said", async () => {
  const { source, directory } = recording("clip.mp4");
  const srt = `1\n00:00:00,000 --> 00:00:02,000\n ${"word ".repeat(100)}\n\n`;
  const made = await transcribeFile({ source, format: "srt", title: "Clip subtitles" }, directory, {
    ...stoodIn(ffmpegThatSays(probeWith("Stream #0:0: Video: h264\n  Stream #0:1: Audio: aac")), whisperThatHears(srt, "srt"))
  });
  assert.equal(made.ok, true, JSON.stringify(made));
  if (!made.ok) return;
  assert.equal(made.file.name, "Clip subtitles.srt");
  assert.match(readFileSync(made.file.path, "utf8"), /^1\n00:00:00,000 --> 00:00:02,000\nword word/);
  assert.equal(made.file.words, 100);
  assert.ok(made.excerpt.length <= 203 && made.excerpt.endsWith("..."), made.excerpt);
  assert.match(describeTranscript(made), /\(SRT subtitles\)/);
});

test("a file that is there is never replaced", async () => {
  const { source, directory } = recording();
  writeFileSync(path.join(directory, "meeting.txt"), "mine");
  const made = await transcribeFile({ source, format: "txt" }, directory, stoodIn());
  assert.equal(made.ok, true);
  if (made.ok) assert.equal(made.file.name, "meeting (2).txt");
  assert.equal(readFileSync(path.join(directory, "meeting.txt"), "utf8"), "mine");
});

test("what stops it is said, and leaves nothing behind", async () => {
  const cases: Array<[string, Partial<Parameters<typeof transcribeFile>[2]>, RegExp]> = [
    ["no Listening", { status: { available: false, reason: "whisper.cpp is not installed on this machine." } }, /needs Listening\. whisper\.cpp is not installed/],
    ["no ffmpeg", { ffmpegIsHere: () => false }, /ffmpeg is not installed/],
    ["unreadable", { run: async () => ({ code: 1, stderr: "Invalid data found when processing input", timedOut: false }) }, /ffmpeg could not read meeting\.mp3 \(Invalid data/],
    ["no sound", { run: ffmpegThatSays(probeWith("Stream #0:0: Video: h264")).run }, /has no sound in it/],
    ["cover art only is no reason to refuse", { run: ffmpegThatSays(probeWith("Stream #0:0: Audio: mp3\n  Stream #0:1: Video: png (attached pic)")).run, whisper: whisperThatHears(" [BLANK_AUDIO]\n").run }, /No speech was heard in meeting\.mp3/],
    ["no speech", { whisper: whisperThatHears(" [BLANK_AUDIO]\n (silence)\n").run }, /No speech was heard in meeting\.mp3/],
    ["whisper failed", { whisper: async () => ({ code: 3, stderr: "error: failed to read\n", aborted: false, timedOut: false }) }, /whisper\.cpp could not write out meeting\.mp3: error: failed to read/],
    ["whisper took too long", { whisper: async () => ({ code: null, stderr: "", aborted: false, timedOut: true }) }, /Listening took too long/],
    ["whisper wrote nothing", { whisper: async () => ({ code: 0, stderr: "", aborted: false, timedOut: false }) }, /finished without writing anything/],
    ["stopped", { whisper: async () => ({ code: null, stderr: "", aborted: true, timedOut: false }) }, /stopped before it finished/]
  ];
  for (const [label, options, expected] of cases) {
    const { source, directory } = recording();
    const made = await transcribeFile({ source, format: "txt" }, directory, { ...stoodIn(), ...options });
    assert.equal(made.ok, false, label);
    if (!made.ok) assert.match(made.reason, expected, label);
    assert.deepEqual(readdirSync(directory), ["meeting.mp3"], `${label}: nothing was left behind`);
    assert.match(describeTranscript(made), /Nothing was made\.$/, label);
  }
});

test("a path that is not a recording is refused before anything runs", async () => {
  const { directory } = recording();
  let ran = false;
  const options = { ...stoodIn(), run: (async () => { ran = true; return { code: 0, stderr: "", timedOut: false }; }) as RunFfmpeg };
  const missing = await transcribeFile({ source: path.join(directory, "gone.mp3"), format: "txt" }, directory, options);
  assert.equal(!missing.ok && /There is no file at/.test(missing.reason), true);
  const folder = await transcribeFile({ source: directory, format: "txt" }, outside, options);
  assert.equal(!folder.ok && /is a folder, not a file/.test(folder.reason), true);
  writeFileSync(path.join(directory, "empty.mp3"), "");
  const empty = await transcribeFile({ source: path.join(directory, "empty.mp3"), format: "txt" }, directory, options);
  assert.equal(!empty.ok && /empty\.mp3 is empty/.test(empty.reason), true);
  writeFileSync(path.join(directory, "notes.docx"), "x");
  const wrongKind = await transcribeFile({ source: path.join(directory, "notes.docx"), format: "txt" }, directory, options);
  assert.equal(!wrongKind.ok && /is not an audio or video file/.test(wrongKind.reason), true);
  assert.equal(ran, false);
});

test("Stop before the listening starts ends it there", async () => {
  const { source, directory } = recording();
  const whisper = whisperThatHears(" Hello.\n");
  const stop = new AbortController();
  stop.abort();
  const made = await transcribeFile({ source, format: "txt" }, directory, { ...stoodIn(ffmpegThatSays(), whisper), signal: stop.signal });
  assert.equal(!made.ok && /stopped before it finished/.test(made.reason), true);
  assert.equal(whisper.calls.length, 0);
});

// ---------------------------------------------------------------- through the tool

const tool = (args: Record<string, unknown>) => runTool({ name: "transcribe_file", arguments: args }, { memories: [], knowledge: [] } as never);

test("the tool needs a recording, a format it knows, and a place it may reach", async () => {
  const nothing = await tool({});
  assert.equal(nothing.ok, false);
  assert.match(nothing.content, /needs the path of the recording/);

  const wrongFormat = await tool({ source: "meeting.mp3", format: "docx" });
  assert.equal(wrongFormat.ok, false);
  assert.match(wrongFormat.content, /is not a format this writes.*Nothing was made\./);

  const away = await tool({ source: path.join(outside, "meeting.mp3") });
  assert.equal(away.ok, false, "outside the workspace with machine access off");
  assert.match(away.content, /Nothing was made\./);
  assert.equal(existsSync(path.join(workspace, "documents")), false);
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

test("asked to write out a recording the model is offered the tool; asked for something else it is not", async () => {
  for (const question of ["transcribe meeting.mp3", "what do they say in lecture.mp4?", "turn this recording into text", "make subtitles for clip.mp4"]) {
    const asked = await run(question, [{ message: { content: "Sure." } }]);
    assert.ok((asked.engine.chats[0]?.tools ?? []).some((entry) => entry.function.name === "transcribe_file"), question);
  }
  const other = await run("list three facts about the moon", [{ message: { content: "It has no air." } }]);
  assert.equal((other.engine.chats[0]?.tools ?? []).some((entry) => entry.function.name === "transcribe_file"), false);
});

test("what the tool says about a failure reaches the person, whatever the model goes on to say", async () => {
  const { result } = await run("transcribe gone.mp3", [
    { message: { content: "", tool_calls: [{ function: { name: "transcribe_file", arguments: { source: "gone.mp3" } } }] } },
    { message: { content: "Done! I saved the transcript on your Desktop." } }
  ]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.toolsUsed.map((used) => used.name), ["transcribe_file"]);
  assert.match(result.text, /Nothing was made\./);
});
