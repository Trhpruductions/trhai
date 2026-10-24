import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { dtwPreset, hasAttentionTimes, hearWords, runWhisper, whisperArgs, type WhisperRun } from "../src/services/lyricTranscribe.js";
import type { WhisperStatus } from "../src/services/whisperTranscribe.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const timedJson = fixture("whisper-words-dtw.json");
const plainJson = fixture("whisper-words-plain.json");

const status = (id = "ggml-base.en", englishOnly = true): WhisperStatus => ({
  available: true,
  binaryPath: path.join("C:", "tools", "whisper", "Release", "whisper-cli.exe"),
  model: { id, size: "base", englishOnly, modelPath: path.join("C:", "tools", "whisper", `${id}.bin`) },
  models: []
});

type Call = { args: string[]; cwd: string };
/** A stand-in for whisper.cpp: writes the transcript where it was told to, as the real one does. */
function fakeWhisper(behave: (call: Call, index: number) => { code?: number; json?: string; aborted?: boolean; timedOut?: boolean; stderr?: string } | void) {
  const calls: Call[] = [];
  const run: WhisperRun = async (_program, args, options) => {
    const call = { args, cwd: options.cwd };
    calls.push(call);
    const outcome = behave(call, calls.length - 1) ?? {};
    // As the real one does: a line each time it has done another part.
    options.onStderr?.("whisper_print_progress_callback: progress =  25%\n");
    options.onStderr?.("whisper_print_progress_callback: progress =  80%\n");
    const prefix = args[args.indexOf("-of") + 1];
    if (outcome.json !== undefined) writeFileSync(`${prefix}.json`, outcome.json);
    return { code: outcome.code ?? 0, stderr: outcome.stderr ?? "", aborted: outcome.aborted ?? false, timedOut: outcome.timedOut ?? false };
  };
  return { run, calls };
}

function work(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "trhai-lyric-test-"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("the alignment preset is the model's own name, whatever its quantisation", () => {
  assert.equal(dtwPreset("ggml-base.en"), "base.en");
  assert.equal(dtwPreset("ggml-base.en-q5_1"), "base.en");
  assert.equal(dtwPreset("ggml-small"), "small");
  assert.equal(dtwPreset("ggml-large-v3"), "large.v3");
  assert.equal(dtwPreset("ggml-large-v3-turbo-q8_0"), "large.v3.turbo");
  assert.equal(dtwPreset("ggml-medium.en"), "medium.en");
  assert.equal(dtwPreset("ggml-mystery"), null);
  assert.equal(dtwPreset("ggml-large-v9"), null);
  assert.equal(dtwPreset(""), null);
});

test("whisper is asked for one word at a time with the attention times, and with flash attention off, which they need", () => {
  const args = whisperArgs({ model: "m.bin", wav: "s.wav", prefix: "out", preset: "base.en", threads: 3, english: true });
  assert.deepEqual(args, ["-m", "m.bin", "-f", "s.wav", "-ojf", "-of", "out", "-ml", "1", "-sow", "-np", "-pp", "-dtw", "base.en", "-nfa", "-l", "en", "-t", "3"]);
  const plain = whisperArgs({ model: "m.bin", wav: "s.wav", prefix: "out", preset: null });
  assert.ok(!plain.includes("-dtw") && !plain.includes("-nfa") && !plain.includes("-t") && !plain.includes("-l"), plain.join(" "));
});

test("it hears the words with their exact times, and says so", async () => {
  const dir = work();
  try {
    const { run, calls } = fakeWhisper(() => ({ json: timedJson }));
    const progress: number[] = [];
    const heard = await hearWords({ wav: "song.wav", workDir: dir, duration: 68, status: status(), run, onProgress: (f) => progress.push(f) });
    assert.ok(heard.ok);
    if (!heard.ok) return;
    assert.ok(heard.words.length >= 70, `${heard.words.length} words`);
    assert.equal(heard.timed, true);
    assert.equal(heard.model, "ggml-base.en");
    assert.equal(calls.length, 1);
    assert.ok(calls[0].args.includes("-dtw") && calls[0].args.includes("-nfa") && calls[0].args[calls[0].args.indexOf("-dtw") + 1] === "base.en");
    assert.equal(calls[0].cwd, path.dirname(status().available ? (status() as { binaryPath: string }).binaryPath : ""), "run from the program's own folder, where its libraries are");
    assert.deepEqual(progress, [0.25, 0.8, 1], "progress follows what it prints, and ends at one");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a model with no alignment preset is run without it, and its times are the coarse ones", async () => {
  const dir = work();
  try {
    const { run, calls } = fakeWhisper(() => ({ json: plainJson }));
    const heard = await hearWords({ wav: "song.wav", workDir: dir, duration: 68, status: status("ggml-mystery", false), run });
    assert.ok(heard.ok);
    if (!heard.ok) return;
    assert.equal(heard.timed, false);
    assert.equal(calls.length, 1);
    assert.ok(!calls[0].args.includes("-dtw") && !calls[0].args.includes("-l"), calls[0].args.join(" "));
    assert.ok(heard.words.length >= 70);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("if the run with attention times fails, it is run again without them rather than giving up", async () => {
  const dir = work();
  try {
    const { run, calls } = fakeWhisper((call) => (call.args.includes("-dtw") ? { code: 1, stderr: "dtw not supported" } : { json: plainJson }));
    const heard = await hearWords({ wav: "song.wav", workDir: dir, duration: 68, status: status(), run });
    assert.ok(heard.ok);
    if (!heard.ok) return;
    assert.equal(calls.length, 2);
    assert.ok(calls[0].args.includes("-dtw") && !calls[1].args.includes("-dtw"));
    assert.equal(heard.timed, false);
    assert.ok(heard.words.length >= 70);
    // The same when it succeeds but writes nothing readable.
    const bad = fakeWhisper((call) => ({ json: call.args.includes("-dtw") ? "{ not json" : plainJson }));
    const again = await hearWords({ wav: "song.wav", workDir: dir, duration: 68, status: status(), run: bad.run });
    assert.ok(again.ok && bad.calls.length === 2);
    const none = fakeWhisper((call) => (call.args.includes("-dtw") ? {} : { json: plainJson }));
    const missing = await hearWords({ wav: "song.wav", workDir: dir, duration: 68, status: status(), run: none.run });
    assert.ok(missing.ok && none.calls.length === 2, "no transcript file is also a failed run");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("when both runs fail it says why, and nothing is invented", async () => {
  const dir = work();
  try {
    const { run, calls } = fakeWhisper(() => ({ code: 3, stderr: "model is corrupt" }));
    const heard = await hearWords({ wav: "song.wav", workDir: dir, duration: 68, status: status(), run });
    assert.equal(heard.ok, false);
    if (heard.ok) return;
    assert.equal(calls.length, 2);
    assert.match(heard.reason, /code 3/);
    assert.match(heard.reason, /model is corrupt/);
    assert.ok(!heard.cancelled);
    const unreadable = fakeWhisper(() => ({ json: "{ no" }));
    const second = await hearWords({ wav: "song.wav", workDir: dir, duration: 68, status: status("ggml-mystery", false), run: unreadable.run });
    assert.equal(second.ok, false);
    if (!second.ok) assert.match(second.reason, /could not be read/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("cancelling stops it at once, and a run that timed out is not run a second time", async () => {
  const dir = work();
  try {
    const cancelled = fakeWhisper(() => ({ code: null as unknown as number, aborted: true }));
    const heard = await hearWords({ wav: "song.wav", workDir: dir, duration: 68, status: status(), run: cancelled.run });
    assert.deepEqual([heard.ok, heard.ok ? null : heard.cancelled], [false, true]);
    assert.equal(cancelled.calls.length, 1, "no second attempt after a cancel");
    const slow = fakeWhisper(() => ({ code: null as unknown as number, timedOut: true }));
    const timedOut = await hearWords({ wav: "song.wav", workDir: dir, duration: 68, status: status(), run: slow.run });
    assert.equal(timedOut.ok, false);
    if (!timedOut.ok) assert.match(timedOut.reason, /took too long/);
    assert.equal(slow.calls.length, 1, "nor after a timeout, which would only take as long again");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("without whisper installed, it says what to install, and runs nothing", async () => {
  const { run, calls } = fakeWhisper(() => ({ json: timedJson }));
  const heard = await hearWords({ wav: "song.wav", workDir: tmpdir(), duration: 68, status: { available: false, reason: "whisper.cpp is not installed on this machine." }, run });
  assert.deepEqual(heard, { ok: false, reason: "whisper.cpp is not installed on this machine." });
  assert.equal(calls.length, 0);
});

test("a stale transcript from an earlier run is never mistaken for this one's", async () => {
  const dir = work();
  try {
    writeFileSync(path.join(dir, "heard-timed.json"), timedJson);
    writeFileSync(path.join(dir, "heard-plain.json"), plainJson);
    const { run } = fakeWhisper(() => ({}));
    const heard = await hearWords({ wav: "song.wav", workDir: dir, duration: 68, status: status(), run });
    assert.equal(heard.ok, false, "the old files were cleared, so a run that wrote nothing found nothing");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the attention times are told apart from their absence", () => {
  assert.equal(hasAttentionTimes(JSON.parse(timedJson)), true);
  assert.equal(hasAttentionTimes(JSON.parse(plainJson)), false);
  assert.equal(hasAttentionTimes(null), false);
  assert.equal(hasAttentionTimes({ transcription: [{ tokens: [{ t_dtw: -1 }] }] }), false);
  assert.equal(hasAttentionTimes({ transcription: [{ tokens: [{ t_dtw: 0 }] }] }), true);
});

test("the real runner reports a program that cannot be started, and honours a cancel made before it starts", async () => {
  const missing = await runWhisper(path.join(tmpdir(), "no-such-program-here.exe"), [], { cwd: tmpdir(), timeoutMs: 5000 });
  assert.equal(missing.code, null);
  assert.ok(missing.stderr.length > 0, "it says why");
  assert.equal(missing.aborted, false);
  const controller = new AbortController();
  controller.abort();
  const stopped = await runWhisper(path.join(tmpdir(), "no-such-program-here.exe"), [], { cwd: tmpdir(), timeoutMs: 5000, signal: controller.signal });
  assert.equal(stopped.aborted, true);
});
