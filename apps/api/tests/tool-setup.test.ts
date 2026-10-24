import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ffmpegAvailable, ffmpegHome, ffmpegProgram, ffmpegSource, forgetFfmpegCheck, useFfmpegProbe } from "../src/services/ffmpegPath.js";
import { resetSetupForTests, setupJob, setupStatus, startSetup, type Hardware, type PinnedFile } from "../src/services/modelSetup.js";
import {
  catalogueTool, ffmpegArchive, piperArchive, piperVoiceFiles, toolCatalogue, toolStatuses, whisperArchive, whisperModel,
  type ToolDef
} from "../src/services/toolCatalog.js";

// The voice, listening and video tools: that each is pinned to what its makers
// published, that it puts itself where the app already looks, that a tool
// already there is left alone, and that nothing is installed unless it checks out.

const gib = 1024 ** 3;
const smallPc: Hardware = { totalMemoryBytes: 8 * gib, cpuCores: 4, gpu: null };
const windows = process.platform === "win32";
const piperProgram = windows ? "piper.exe" : "piper";
const whisperProgram = windows ? "whisper-cli.exe" : "whisper-cli";
const ffmpegName = windows ? "ffmpeg.exe" : "ffmpeg";

type Roots = { piper: string; whisper: string; runtime: string; base: string };

const watched = ["VEXORA_PIPER_DIR", "VEXORA_WHISPER_DIR", "TRHAI_RUNTIME_DIR", "TRHAI_FFMPEG_PATH", "PATH"] as const;

/**
 * Runs with the three places the tools live pointed at a fresh folder, and with
 * a PATH that has no ffmpeg in it, so what a test sees does not depend on what
 * this PC has installed. Everything is put back afterwards.
 */
async function inFreshPlaces<T>(run: (roots: Roots) => T | Promise<T>): Promise<T> {
  const base = mkdtempSync(path.join(tmpdir(), "trhai-tools-"));
  const roots: Roots = { base, piper: path.join(base, "piper"), whisper: path.join(base, "whisper"), runtime: path.join(base, "runtime") };
  const emptyBin = path.join(base, "emptybin");
  mkdirSync(emptyBin);
  const saved = Object.fromEntries(watched.map((key) => [key, process.env[key]]));
  process.env.VEXORA_PIPER_DIR = roots.piper;
  process.env.VEXORA_WHISPER_DIR = roots.whisper;
  process.env.TRHAI_RUNTIME_DIR = roots.runtime;
  process.env.PATH = emptyBin;
  delete process.env.TRHAI_FFMPEG_PATH;
  forgetFfmpegCheck();
  try {
    return await run(roots);
  } finally {
    for (const key of watched) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    forgetFfmpegCheck();
  }
}

function put(file: string, content = "x"): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** Runs with the platform set to another one, for the lines only a PC that is not Windows reaches. */
function onPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const real = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
  Object.defineProperty(process, "platform", { ...real, value: platform });
  try {
    return run();
  } finally {
    Object.defineProperty(process, "platform", real);
  }
}

/** Answers whether ffmpeg runs without starting one, whatever this PC has installed. */
const ffmpegAnswering = (status: number) => (() => ({ status, error: undefined })) as never;

const sum = (files: PinnedFile[]) => files.reduce((total, file) => total + file.sizeBytes, 0);

// ---------------------------------------------------------------- what is pinned

test("every tool download is pinned: https, a fixed release or commit, a size and a SHA-256", () => {
  const files = toolCatalogue.flatMap((tool) => tool.files);
  assert.equal(files.length, 6);
  for (const file of files) {
    assert.match(file.sha256, /^[0-9a-f]{64}$/, file.name);
    assert.ok(file.sizeBytes > 1_000, file.name);
    assert.match(
      file.url,
      /^https:\/\/(github\.com\/(rhasspy\/piper|ggml-org\/whisper\.cpp|GyanD\/codexffmpeg)\/releases\/download\/[^/]+\/|huggingface\.co\/(rhasspy\/piper-voices|ggerganov\/whisper\.cpp)\/resolve\/[0-9a-f]{40}\/)/,
      file.name
    );
    assert.ok(file.url.endsWith(`/${file.name}`), file.name);
  }
  assert.equal(new Set(files.map((file) => file.sha256)).size, files.length, "no two files share a fingerprint");
  assert.deepEqual(toolCatalogue.map((tool) => tool.id), ["speech", "listening", "video"]);
});

test("everything offered may be used commercially, and the voice is not one that may not", () => {
  for (const tool of toolCatalogue) assert.equal(tool.license.commercialUse, true, tool.id);
  // Ryan, the best-known Piper voice, is CC BY-NC-SA; so are hfc and semaine.
  for (const file of piperVoiceFiles) assert.doesNotMatch(file.name, /ryan|hfc_|semaine|l2arctic/i, file.name);
  assert.match(piperVoiceFiles[0].name, /^en_GB-cori-high\.onnx$/);
  assert.match(piperVoiceFiles[1].name, /^en_GB-cori-high\.onnx\.json$/, "a voice is two files, and Piper cannot load one without the other");
});

test("the tools say what they are for, what they need, and what they cost to download", () => {
  for (const tool of toolCatalogue) {
    assert.ok(tool.label.length > 3 && tool.summary.length > 40 && tool.needs.length > 3, tool.id);
  }
  const total = sum(toolCatalogue.flatMap((tool) => tool.files));
  assert.ok(total > 300 * 1024 ** 2 && total < 500 * 1024 ** 2, `about 400 MB in all, not ${total} bytes`);
});

// ---------------------------------------------------------------- what is on this PC

test("on a PC with none of them, each tool reports everything it would download", async () => {
  await inFreshPlaces(({ runtime }) => {
    const status = toolStatuses({ TRHAI_RUNTIME_DIR: runtime } as NodeJS.ProcessEnv);
    assert.deepEqual(status.map((tool) => [tool.id, tool.installed]), [["speech", false], ["listening", false], ["video", false]]);
    assert.equal(status[0].sizeBytes, sum([piperArchive, ...piperVoiceFiles]));
    assert.equal(status[1].sizeBytes, sum([whisperArchive, whisperModel]));
    assert.equal(status[2].sizeBytes, ffmpegArchive.sizeBytes);
    assert.ok(status.every((tool) => tool.supported === windows));
  });
});

test("Piper without a voice needs only the voice, and with both needs nothing", async () => {
  await inFreshPlaces(({ piper, runtime }) => {
    const env = { TRHAI_RUNTIME_DIR: runtime } as NodeJS.ProcessEnv;
    const speech = catalogueTool("speech") as ToolDef;
    put(path.join(piper, piperProgram));
    assert.deepEqual(speech.missing(env).map((file) => file.name), piperVoiceFiles.map((file) => file.name));
    assert.equal(speech.installed(env), false);
    // A voice's model without its companion json is not a voice Piper can load.
    put(path.join(piper, "en_US-john-medium.onnx"));
    assert.equal(speech.installed(env), false);
    put(path.join(piper, "en_US-john-medium.onnx.json"), "{}");
    assert.equal(speech.installed(env), true);
    assert.deepEqual(speech.missing(env), [], "a voice the person put there themselves is a voice");
    assert.equal(toolStatuses(env)[0].sizeBytes, 0);
  });
});

test("whisper.cpp without a model needs only the model, wherever the zip put its program", async () => {
  await inFreshPlaces(({ whisper, runtime }) => {
    const env = { TRHAI_RUNTIME_DIR: runtime } as NodeJS.ProcessEnv;
    const listening = catalogueTool("listening") as ToolDef;
    put(path.join(whisper, "Release", whisperProgram));
    assert.deepEqual(listening.missing(env).map((file) => file.name), [whisperModel.name]);
    put(path.join(whisper, "ggml-small.en.bin"));
    assert.equal(listening.installed(env), true, "any model it can use counts");
    assert.deepEqual(listening.missing(env), []);
  });
});

// ---------------------------------------------------------------- putting each in place

/** Stands in for unpacking an archive: writes the files the real one holds. */
function unpackingTo(files: Record<string, string>) {
  return (_archive: string, into: string) => {
    for (const [name, content] of Object.entries(files)) put(path.join(into, name), content);
  };
}

test("speech: Piper goes where the app looks for it, with its data, and the voice beside it", async () => {
  await inFreshPlaces(({ piper, base }) => {
    const downloads = path.join(base, "downloads", "tool-speech");
    put(path.join(downloads, piperArchive.name), "zip");
    for (const file of piperVoiceFiles) put(path.join(downloads, file.name), `voice ${file.name}`);
    const speech = catalogueTool("speech") as ToolDef;
    speech.place(downloads, process.env, unpackingTo({
      [`piper/${piperProgram}`]: "exe", "piper/espeak-ng-data/voices/en": "data", "piper/espeak-ng.dll": "dll"
    }));
    assert.ok(existsSync(path.join(piper, piperProgram)), "the program, not a piper folder inside piper");
    assert.ok(existsSync(path.join(piper, "espeak-ng-data", "voices", "en")), "its data files come with it");
    assert.equal(readFileSync(path.join(piper, "en_GB-cori-high.onnx"), "utf8"), "voice en_GB-cori-high.onnx");
    assert.ok(existsSync(path.join(piper, "en_GB-cori-high.onnx.json")));
    assert.equal(existsSync(path.join(downloads, "piper-unpacked")), false, "no unpacked copy is left behind");
    assert.equal(speech.installed(process.env), true);
  });
});

test("speech: when Piper is already there, only the voice is added and Piper is not touched", async () => {
  await inFreshPlaces(({ piper, base }) => {
    put(path.join(piper, piperProgram), "the person's own piper");
    const downloads = path.join(base, "downloads", "tool-speech");
    for (const file of piperVoiceFiles) put(path.join(downloads, file.name), "v");
    (catalogueTool("speech") as ToolDef).place(downloads, process.env, () => { throw new Error("nothing should be unpacked"); });
    assert.equal(readFileSync(path.join(piper, piperProgram), "utf8"), "the person's own piper");
    assert.ok(existsSync(path.join(piper, "en_GB-cori-high.onnx")));
  });
});

test("speech: an archive with no Piper in it is refused with the reason", async () => {
  await inFreshPlaces(({ base }) => {
    const downloads = path.join(base, "downloads", "tool-speech");
    put(path.join(downloads, piperArchive.name), "zip");
    assert.throws(
      () => (catalogueTool("speech") as ToolDef).place(downloads, process.env, unpackingTo({ "readme.txt": "nothing useful" })),
      new RegExp(`no ${piperProgram.replace(".", "\\.")} in it`)
    );
  });
});

test("listening: whisper.cpp keeps the zip's own layout and the model sits beside it", async () => {
  await inFreshPlaces(({ whisper, base }) => {
    const downloads = path.join(base, "downloads", "tool-listening");
    put(path.join(downloads, whisperArchive.name), "zip");
    put(path.join(downloads, whisperModel.name), "model");
    const listening = catalogueTool("listening") as ToolDef;
    listening.place(downloads, process.env, unpackingTo({ [`Release/${whisperProgram}`]: "exe", "Release/whisper.dll": "dll" }));
    assert.ok(existsSync(path.join(whisper, "Release", whisperProgram)));
    assert.ok(existsSync(path.join(whisper, "Release", "whisper.dll")));
    assert.equal(readFileSync(path.join(whisper, "ggml-base.en.bin"), "utf8"), "model");
    assert.equal(listening.installed(process.env), true);
  });
});

test("video: only ffmpeg and its licence are kept, and the app then runs that ffmpeg", async () => {
  await inFreshPlaces(({ runtime, base }) => {
    const env = process.env;
    assert.equal(ffmpegSource(env), "path");
    assert.equal(ffmpegProgram(env), "ffmpeg");
    const downloads = path.join(base, "downloads", "tool-video");
    put(path.join(downloads, ffmpegArchive.name), "zip");
    (catalogueTool("video") as ToolDef).place(downloads, env, unpackingTo({
      [`ffmpeg-9.0.2-essentials_build/bin/${ffmpegName}`]: "ffmpeg",
      [`ffmpeg-9.0.2-essentials_build/bin/ffplay.exe`]: "not needed",
      [`ffmpeg-9.0.2-essentials_build/bin/ffprobe.exe`]: "not needed",
      "ffmpeg-9.0.2-essentials_build/LICENSE": "GPL",
      "ffmpeg-9.0.2-essentials_build/README.txt": "readme",
      "ffmpeg-9.0.2-essentials_build/doc/ffmpeg.html": "docs"
    }));
    const home = ffmpegHome(env);
    assert.equal(home, path.join(runtime, "tools", "ffmpeg"));
    assert.equal(readFileSync(path.join(home, "bin", ffmpegName), "utf8"), "ffmpeg");
    assert.ok(existsSync(path.join(home, "LICENSE")), "its licence travels with it");
    for (const unwanted of ["bin/ffplay.exe", "bin/ffprobe.exe", "doc"]) assert.equal(existsSync(path.join(home, unwanted)), false, unwanted);
    assert.equal(ffmpegSource(env), "installed");
    assert.equal(ffmpegProgram(env), path.join(home, "bin", ffmpegName));
  });
});

test("video: a file TRHAI_FFMPEG_PATH names wins, and one that does not exist is ignored", async () => {
  await inFreshPlaces(({ base, runtime }) => {
    const mine = path.join(base, "mine", ffmpegName);
    put(mine);
    put(path.join(runtime, "tools", "ffmpeg", "bin", ffmpegName));
    const env = { ...process.env, TRHAI_FFMPEG_PATH: mine } as NodeJS.ProcessEnv;
    assert.equal(ffmpegSource(env), "named");
    assert.equal(ffmpegProgram(env), mine);
    const gone = { ...process.env, TRHAI_FFMPEG_PATH: path.join(base, "not-there.exe") } as NodeJS.ProcessEnv;
    assert.equal(ffmpegSource(gone), "installed", "falls back to the app's own");
  });
});

test("whether ffmpeg runs is asked of the program that would run, and remembered for 30 seconds", () => {
  forgetFfmpegCheck();
  let asked = 0;
  const run = ((_program: string, args: string[]) => { asked += 1; return { status: 0, error: undefined, args }; }) as never;
  assert.equal(ffmpegAvailable({} as NodeJS.ProcessEnv, 1_000, run), true);
  assert.equal(ffmpegAvailable({} as NodeJS.ProcessEnv, 20_000, run), true);
  assert.equal(asked, 1, "the second question is answered from memory");
  assert.equal(ffmpegAvailable({} as NodeJS.ProcessEnv, 40_000, run), true);
  assert.equal(asked, 2, "after 30 seconds it is asked again");
  const failing = (() => ({ status: 1, error: undefined })) as never;
  forgetFfmpegCheck();
  assert.equal(ffmpegAvailable({} as NodeJS.ProcessEnv, 1_000, failing), false);
  const missing = (() => ({ status: null, error: new Error("ENOENT") })) as never;
  forgetFfmpegCheck();
  assert.equal(ffmpegAvailable({} as NodeJS.ProcessEnv, 1_000, missing), false);
  forgetFfmpegCheck();
});

test("a remembered answer belongs to the ffmpeg that gave it, so one installed afterwards is asked afresh", async () => {
  await inFreshPlaces(({ runtime }) => {
    const env = { ...process.env, TRHAI_RUNTIME_DIR: runtime } as NodeJS.ProcessEnv;
    const installed = path.join(ffmpegHome(env), "bin", ffmpegName);
    const asked: string[] = [];
    const run = ((program: string) => { asked.push(program); return { status: program === "ffmpeg" ? 1 : 0, error: undefined }; }) as never;
    assert.equal(ffmpegAvailable(env, 1_000, run), false, "nothing on the PATH runs");
    put(installed);
    assert.equal(ffmpegAvailable(env, 2_000, run), true, "the new one is asked, not told the old one's answer");
    assert.deepEqual(asked, ["ffmpeg", installed]);
  });
});

test("video: an ffmpeg that already runs counts as installed, and nothing is downloaded for it", async () => {
  await inFreshPlaces(() => {
    const video = catalogueTool("video") as ToolDef;
    try {
      useFfmpegProbe(ffmpegAnswering(0));
      assert.equal(video.installed(process.env), true);
      assert.deepEqual(video.missing(process.env), []);
      assert.equal(toolStatuses(process.env)[2].sizeBytes, 0);
      useFfmpegProbe(ffmpegAnswering(1));
      assert.equal(video.installed(process.env), false);
      assert.deepEqual(video.missing(process.env), [ffmpegArchive]);
    } finally {
      useFfmpegProbe();
    }
  });
});

test("video: placing ffmpeg makes the app ask again about the same file, not trust a 'no' it remembered", async () => {
  await inFreshPlaces(({ base }) => {
    const env = process.env;
    put(path.join(ffmpegHome(env), "bin", ffmpegName), "broken");
    let works = false;
    useFfmpegProbe((() => ({ status: works ? 0 : 1, error: undefined })) as never);
    try {
      const video = catalogueTool("video") as ToolDef;
      assert.equal(video.installed(env), false, "a broken copy is not installed, and the 'no' is remembered");
      const downloads = path.join(base, "downloads", "tool-video");
      put(path.join(downloads, ffmpegArchive.name), "zip");
      works = true;
      video.place(downloads, env, unpackingTo({ [`build/bin/${ffmpegName}`]: "good" }));
      assert.equal(video.installed(env), true, "the same path, asked again");
    } finally {
      useFfmpegProbe();
    }
  });
});

// ---------------------------------------------------------------- the job

function pinned(name: string, content: Buffer): PinnedFile {
  return { name, url: `https://files.example/${name}`, sizeBytes: content.length, sha256: createHash("sha256").update(content).digest("hex") };
}

function server(files: Record<string, Buffer>) {
  return async (url: string) => {
    const body = files[url];
    return body ? new Response(new Uint8Array(body), { status: 200 }) : new Response("missing", { status: 404 });
  };
}

async function finished(): Promise<NonNullable<ReturnType<typeof setupJob>>> {
  for (let i = 0; i < 400; i += 1) {
    const job = setupJob();
    if (job && job.state !== "running") return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("setup did not finish");
}

/** A two-part tool whose parts land in `root`, standing in for the real ones. */
function twoPartTool(root: string, parts: Array<[string, Buffer]>, options: { placeFails?: boolean; neverUsable?: boolean } = {}): ToolDef {
  const files = parts.map(([name, content]) => pinned(name, content));
  const there = (file: PinnedFile) => existsSync(path.join(root, file.name));
  return {
    id: "speech", label: "Test voice", summary: "A stand-in for the voice, used only by the tests.", needs: "nothing",
    license: { name: "Test", url: "https://example.test/licence", commercialUse: true },
    files,
    missing: () => files.filter((file) => !there(file)),
    installed: () => !options.neverUsable && files.every(there),
    place(downloads) {
      if (options.placeFails) throw new Error("the archive had nothing in it");
      for (const file of files) {
        const from = path.join(downloads, file.name);
        if (existsSync(from)) put(path.join(root, file.name), readFileSync(from, "utf8"));
      }
    }
  };
}

const bodies = { a: Buffer.from("part A, exactly as published"), b: Buffer.from("part B, exactly as published") };
const served = { "https://files.example/a.bin": bodies.a, "https://files.example/b.bin": bodies.b };

test("setup installs a tool's files, checks each, places them, and does not restart the engine", async () => {
  resetSetupForTests();
  const base = mkdtempSync(path.join(tmpdir(), "trhai-toolsjob-"));
  const root = path.join(base, "tool");
  const tool = twoPartTool(root, [["a.bin", bodies.a], ["b.bin", bodies.b]]);
  const restarts: number[] = [];
  const env = { TRHAI_RUNTIME_DIR: path.join(base, "runtime") } as NodeJS.ProcessEnv;
  const started = startSetup({ tools: ["speech"] }, { env, hardware: smallPc, tools: [tool], fetcher: server(served) as never, restart: async () => { restarts.push(1); } });
  assert.ok(started.ok);
  assert.deepEqual(started.job.steps.map((step) => [step.kind, step.id, step.totalBytes]), [["tool", "speech", bodies.a.length + bodies.b.length]]);
  const job = await finished();
  assert.equal(job.state, "done", job.error ?? "");
  assert.equal(job.steps[0].state, "done");
  assert.equal(job.steps[0].doneBytes, job.steps[0].totalBytes);
  assert.equal(readFileSync(path.join(root, "a.bin"), "utf8"), "part A, exactly as published");
  assert.equal(existsSync(path.join(base, "runtime", "downloads", "tool-speech")), false, "the downloads are cleared away");
  assert.equal(restarts.length, 0, "a voice is no reason to restart the model engine");

  const again = startSetup({ tools: ["speech"] }, { env, hardware: smallPc, tools: [tool], fetcher: server(served) as never });
  assert.ok(again.ok);
  assert.equal(again.job.steps.length, 0, "a tool that is all there is left alone");
});

test("a tool with one part missing downloads only that part", async () => {
  resetSetupForTests();
  const base = mkdtempSync(path.join(tmpdir(), "trhai-toolsjob-"));
  const root = path.join(base, "tool");
  put(path.join(root, "a.bin"), "already here");
  const tool = twoPartTool(root, [["a.bin", bodies.a], ["b.bin", bodies.b]]);
  const asked: string[] = [];
  const fetcher = async (url: string) => { asked.push(url); return new Response(new Uint8Array(served[url as keyof typeof served]), { status: 200 }); };
  const started = startSetup({ tools: ["speech"] }, { env: { TRHAI_RUNTIME_DIR: path.join(base, "runtime") } as NodeJS.ProcessEnv, hardware: smallPc, tools: [tool], fetcher: fetcher as never });
  assert.ok(started.ok);
  assert.equal(started.job.steps[0].totalBytes, bodies.b.length);
  const job = await finished();
  assert.equal(job.state, "done", job.error ?? "");
  assert.deepEqual(asked, ["https://files.example/b.bin"]);
  assert.equal(readFileSync(path.join(root, "a.bin"), "utf8"), "already here", "what was there is not replaced");
});

test("a file that is not what its makers published stops the tool, and nothing is put in place", async () => {
  resetSetupForTests();
  const base = mkdtempSync(path.join(tmpdir(), "trhai-toolsjob-"));
  const root = path.join(base, "tool");
  const tool = twoPartTool(root, [["a.bin", bodies.a], ["b.bin", bodies.b]]);
  // The same length, one letter changed: only the fingerprint can tell it is not what was published.
  const tampered = { ...served, "https://files.example/b.bin": Buffer.from(bodies.b.toString().replace("published", "pubIished")) };
  assert.equal(tampered["https://files.example/b.bin"].length, bodies.b.length);
  assert.ok(startSetup({ tools: ["speech"] }, { env: { TRHAI_RUNTIME_DIR: path.join(base, "runtime") } as NodeJS.ProcessEnv, hardware: smallPc, tools: [tool], fetcher: server(tampered) as never }).ok);
  const job = await finished();
  assert.equal(job.state, "failed");
  assert.match(job.error ?? "", /b\.bin did not match/);
  assert.equal(job.steps[0].state, "failed");
  assert.equal(existsSync(path.join(root, "a.bin")), false);
  assert.equal(existsSync(path.join(root, "b.bin")), false);
});

test("an archive that cannot be placed, or that placed something TRH AI cannot use, says so", async () => {
  for (const [options, expected] of [
    [{ placeFails: true }, /had nothing in it/],
    [{ neverUsable: true }, /still cannot use it/]
  ] as const) {
    resetSetupForTests();
    const base = mkdtempSync(path.join(tmpdir(), "trhai-toolsjob-"));
    const tool = twoPartTool(path.join(base, "tool"), [["a.bin", bodies.a], ["b.bin", bodies.b]], options);
    assert.ok(startSetup({ tools: ["speech"] }, { env: { TRHAI_RUNTIME_DIR: path.join(base, "runtime") } as NodeJS.ProcessEnv, hardware: smallPc, tools: [tool], fetcher: server(served) as never }).ok);
    const job = await finished();
    assert.equal(job.state, "failed");
    assert.match(job.error ?? "", expected);
  }
});

test("only tools it knows, and the engine and the tools can be installed in one setup", async () => {
  resetSetupForTests();
  const base = mkdtempSync(path.join(tmpdir(), "trhai-toolsjob-"));
  const env = { TRHAI_RUNTIME_DIR: path.join(base, "runtime") } as NodeJS.ProcessEnv;
  const refused = startSetup({ tools: ["telepathy"] }, { env, hardware: smallPc });
  assert.equal(refused.ok, false);
  assert.match((refused as { error: string }).error, /Not a tool TRH AI can install: telepathy/);
  assert.equal(startSetup({ tools: ["speech"] }, { env, hardware: smallPc, tools: [] }).ok, false, "a tool the catalogue does not hold is refused");

  const engineZip = Buffer.from("engine zip");
  const engineFile = pinned("engine.zip", engineZip);
  const tool = twoPartTool(path.join(base, "tool"), [["a.bin", bodies.a], ["b.bin", bodies.b]]);
  const restarts: number[] = [];
  const started = startSetup({ engine: true, tools: ["speech"] }, {
    env, hardware: smallPc, tools: [tool],
    engineFiles: { cpu: [engineFile], "cuda-12.4": [engineFile], "cuda-13.4": [engineFile] },
    fetcher: server({ ...served, [engineFile.url]: engineZip }) as never,
    unzip: (_archive: string, into: string) => put(path.join(into, windows ? "llama-server.exe" : "llama-server"), "engine"),
    restart: async () => { restarts.push(1); }
  });
  assert.ok(started.ok);
  assert.deepEqual(started.job.steps.map((step) => step.kind), ["engine", "tool"]);
  const job = await finished();
  assert.equal(job.state, "done", job.error ?? "");
  assert.equal(restarts.length, 1, "the engine was restarted once, for the engine, not again for the tool");
});

test("the status shows nothing left to download for a tool that is installed, whatever files it lists", () => {
  const odd: ToolDef = { ...twoPartTool("unused", [["a.bin", bodies.a]]), installed: () => true, missing: () => [pinned("a.bin", bodies.a)] };
  assert.equal(toolStatuses({} as NodeJS.ProcessEnv, [odd])[0].sizeBytes, 0);
});

test("off Windows the tools are listed as not built for this PC, and a request to install one is refused", () => {
  resetSetupForTests();
  const runtime = mkdtempSync(path.join(tmpdir(), "trhai-toolsjob-"));
  // If the refusal ever failed, this must not reach the internet.
  const nowhere = (async () => new Response("no", { status: 404 })) as never;
  try {
    useFfmpegProbe(ffmpegAnswering(1));
    onPlatform("linux", () => {
      assert.ok(toolStatuses({ TRHAI_RUNTIME_DIR: runtime } as NodeJS.ProcessEnv).every((tool) => tool.supported === false));
      const refused = startSetup({ tools: ["speech"] }, { env: { TRHAI_RUNTIME_DIR: runtime } as NodeJS.ProcessEnv, hardware: smallPc, fetcher: nowhere });
      assert.equal(refused.ok, false);
      assert.match((refused as { error: string }).error, /built for Windows/);
    });
  } finally {
    useFfmpegProbe();
  }
});

test("the status the screens read lists the three tools beside the models", () => {
  resetSetupForTests();
  const status = setupStatus({ TRHAI_RUNTIME_DIR: path.join(tmpdir(), "trhai-nothing-here") } as NodeJS.ProcessEnv);
  assert.deepEqual(status.tools.map((tool) => tool.id), ["speech", "listening", "video"]);
  for (const tool of status.tools) {
    assert.equal(typeof tool.installed, "boolean");
    assert.ok(tool.license.url.startsWith("https://"));
  }
  assert.equal(status.needsSetup, true, "tools are optional: only the engine and a model decide whether setup is needed");
});
