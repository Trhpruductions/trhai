import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// The model engine: llama.cpp's own server, started and stopped by TRH AI.
//
// Until October 2026 the models ran in Ollama, a separate application the
// user had to install, keep running and manage: a tray app, a model store
// that moved depending on how it was started, and one context window for
// every model. An 8B model at that window did not fit an 8 GB card and wrote
// 3 tokens a second; at the window that does fit, 40.
//
// llama.cpp is the engine Ollama runs underneath. Its server takes a list of
// model files and loads the one a request names ("router mode") - one at a
// time here - each with the largest context window that still leaves every
// layer on the graphics card (--fit). TRH AI owns the process: the API starts
// it, tells it where the models are, and stops it when the API stops. Nothing
// else has to be installed or kept running.
//
// Everything lives in one folder, on the fastest drive there is (a model read
// off a hard disk took 38 s to load; off an SSD, 3.5 s):
//
//   <runtime>/engine/<build>/llama-server.exe   the engine, as released
//   <runtime>/models/name.gguf                  a model: one file
//   <runtime>/models/name/*.gguf                a model with a vision part
//                                               (an mmproj*.gguf beside it)
//   <runtime>/presets.ini                       written here at every start
//   <runtime>/engine.pid                        the running engine, and the API
//                                               that started it
//
// Two copies of the app on one PC share the engine: the second finds the
// first's still in use and asks it too, rather than ending it (leftoverEngine).

/** The port the engine listens on, on this PC's own address only. */
export const defaultEnginePort = 4040;
/** A model nothing has used for this long is let go, to give the card back. */
export const defaultIdleUnloadSeconds = 300;
/**
 * Read when asked, not when this file loads: the .env is read after the imports
 * are, so a constant here would always see the default.
 */
export function idleUnloadSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const asked = Number(env.TRHAI_IDLE_UNLOAD_SECONDS);
  return asked > 0 ? asked : defaultIdleUnloadSeconds;
}
/** Memory kept free on the card when a model is fitted to it, in MiB. */
const fitMarginMiB = 1024;
/** The smallest window a model is ever given: the assistant's prompt needs it. */
const smallestWindow = 8192;

/** Where the engine and its models are kept. TRHAI_RUNTIME_DIR moves it. */
export function runtimeDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.TRHAI_RUNTIME_DIR?.trim()) return env.TRHAI_RUNTIME_DIR.trim();
  const base = env.LOCALAPPDATA?.trim() || path.join(os.homedir(), ".local", "share");
  return path.join(base, "TRHAI", "runtime");
}

export function enginePort(env: NodeJS.ProcessEnv = process.env): number {
  const port = Number(env.TRHAI_ENGINE_PORT);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : defaultEnginePort;
}

/**
 * Where model requests go. TRHAI_ENGINE_URL names an engine someone else runs
 * - any llama.cpp server in router mode - and then none is started here.
 */
export function engineUrl(env: NodeJS.ProcessEnv = process.env): string {
  const named = env.TRHAI_ENGINE_URL?.trim();
  if (named) return named.replace(/\/+$/, "");
  return `http://127.0.0.1:${enginePort(env)}`;
}

/**
 * A model's name with the differences between spellings taken out, so a
 * conversation that chose "qwen2.5-coder:7b" when the models were Ollama's
 * still finds "qwen2.5-coder-7b", and "llama3.2:latest" is "llama3.2".
 */
export function modelKey(name: string): string {
  return name.trim().toLowerCase().replace(/:latest$/, "").replace(/:/g, "-");
}

/** The same model, however each name spells it. */
export function sameModel(a: string, b: string): boolean {
  return modelKey(a) === modelKey(b);
}

/**
 * Whether `name` is `candidate` or one of its sizes: "qwen2.5" is
 * "qwen2.5-3b" and not "qwen2.5-coder-7b", which is a different model that
 * happens to start the same way.
 */
export function isModelOrSize(candidate: string, name: string): boolean {
  const wanted = modelKey(candidate);
  const key = modelKey(name);
  return key === wanted || (key.startsWith(`${wanted}-`) && /^\d/.test(key.slice(wanted.length + 1)));
}

export type EngineModelFile = {
  /** The name requests use: the file's name, or its folder's. */
  id: string;
  file: string;
  /** The vision part, when the model can look at images. */
  mmproj: string | null;
  sizeBytes: number;
};

/** A name the engine's preset file and this API's routes both accept. */
function modelId(raw: string): string {
  return raw.replace(/\.gguf$/i, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100);
}

const isGguf = (name: string) => /\.gguf$/i.test(name);
const isVisionPart = (name: string) => /^mmproj/i.test(name);

/**
 * The models in the models folder: every .gguf file, and every folder holding
 * one (a model with a vision part keeps the two files together in a folder).
 * Sorted by name, so the preset file is the same from one start to the next.
 */
export function discoverModels(modelsDir: string): EngineModelFile[] {
  let entries: string[];
  try {
    entries = readdirSync(modelsDir);
  } catch {
    return [];
  }
  const size = (file: string) => {
    try { return statSync(file).size; } catch { return 0; }
  };
  const found: EngineModelFile[] = [];
  for (const entry of entries.sort()) {
    const full = path.join(modelsDir, entry);
    let isDirectory = false;
    try { isDirectory = statSync(full).isDirectory(); } catch { continue; }
    if (!isDirectory) {
      if (isGguf(entry) && !isVisionPart(entry) && modelId(entry)) {
        found.push({ id: modelId(entry), file: full, mmproj: null, sizeBytes: size(full) });
      }
      continue;
    }
    let inside: string[];
    try { inside = readdirSync(full).filter(isGguf).sort(); } catch { continue; }
    const main = inside.find((name) => !isVisionPart(name));
    const vision = inside.find(isVisionPart);
    if (!main || !modelId(entry)) continue;
    found.push({
      id: modelId(entry),
      file: path.join(full, main),
      mmproj: vision ? path.join(full, vision) : null,
      sizeBytes: size(path.join(full, main)) + (vision ? size(path.join(full, vision)) : 0)
    });
  }
  return found;
}

/**
 * The preset file the engine is started with: what every model gets, then one
 * section per model.
 *
 * `fit` is the point of the whole arrangement. Each model is given the largest
 * context window that leaves all of it on the graphics card with
 * `fitMarginMiB` to spare - measured on an 8 GB card, 9,216 tokens for an 8B
 * model and 31,232 for a 7B one, both at about 40 tokens a second. A smaller
 * margin let the 8B model take 12,800 tokens, Windows moved the overflow into
 * system memory, and it wrote a few tokens a minute.
 */
/**
 * How a family of models is sampled, where its makers publish settings that
 * differ from the engine's own defaults.
 *
 * Ollama carried these with each model and applied them without a word, so a
 * model moved to this engine as a bare file would otherwise answer with
 * different settings from the ones it was measured with. Qwen3's are the ones
 * published for its thinking mode, and what it ran with when it scored 93% of
 * the 54 evaluation tasks. A model with no entry runs on the engine's
 * defaults: qwen2.5-coder was evaluated again on those, and passed 47 of the
 * 54 automatic checks against 45 under Ollama.
 */
const familySampling: Array<{ family: RegExp; settings: Record<string, string> }> = [
  { family: /^qwen3(?![\d.])/i, settings: { temp: "0.6", "top-k": "20", "top-p": "0.95", "min-p": "0" } }
];

/** The sampling lines a model's section of the preset file carries, if any. */
export function samplingFor(id: string): Record<string, string> {
  return familySampling.find((entry) => entry.family.test(id))?.settings ?? {};
}

export function presetsText(models: EngineModelFile[], options: { contextTokens?: number } = {}): string {
  const lines = [
    "version = 1",
    "",
    "; Written by TRH AI at every start, from the models folder. Edits here are lost;",
    "; add a model by putting its .gguf file in the models folder beside this file.",
    "[*]",
    "fit = on",
    `fit-target = ${fitMarginMiB}`,
    `fit-ctx = ${smallestWindow}`,
    "flash-attn = auto",
    "jinja = true",
    "; One conversation at a time on this PC: one slot, with the whole window.",
    "parallel = 1",
    "; A thinking model's thoughts go in reasoning_content, never into its answer.",
    "reasoning-format = deepseek",
    `sleep-idle-seconds = ${idleUnloadSeconds()}`
  ];
  if (options.contextTokens && Number.isFinite(options.contextTokens)) {
    lines.push(`ctx-size = ${Math.max(smallestWindow, Math.floor(options.contextTokens))}`);
  }
  for (const model of models) {
    lines.push("", `[${model.id}]`, `model = ${model.file}`);
    if (model.mmproj) lines.push(`mmproj = ${model.mmproj}`);
    for (const [setting, value] of Object.entries(samplingFor(model.id))) lines.push(`${setting} = ${value}`);
  }
  return `${lines.join("\n")}\n`;
}

export type EnginePaths = {
  runtimeDir: string;
  modelsDir: string;
  presetsFile: string;
  pidFile: string;
  logFile: string;
  /** The engine's program, or null when none is installed. */
  exe: string | null;
  /** The engine's release, from its folder name: "b11366". */
  build: string | null;
};

/** The newest engine release in the engine folder, by its build number. */
function findEngine(engineDir: string): { exe: string; build: string } | null {
  const program = process.platform === "win32" ? "llama-server.exe" : "llama-server";
  let builds: string[];
  try {
    builds = readdirSync(engineDir);
  } catch {
    return null;
  }
  const number = (name: string) => Number(/\d+/.exec(name)?.[0] ?? 0);
  for (const build of builds.sort((a, b) => number(b) - number(a))) {
    const exe = path.join(engineDir, build, program);
    if (existsSync(exe)) return { exe, build };
  }
  return null;
}

export function enginePaths(env: NodeJS.ProcessEnv = process.env): EnginePaths {
  const root = runtimeDir(env);
  const named = env.TRHAI_ENGINE_EXE?.trim();
  const engine = named && existsSync(named)
    ? { exe: named, build: path.basename(path.dirname(named)) }
    : findEngine(path.join(root, "engine"));
  // An engine on a port of its own - a second copy of the app, a test - keeps
  // files of its own, so neither it nor the usual one writes over the other's.
  const port = enginePort(env);
  const tag = port === defaultEnginePort ? "" : `-${port}`;
  return {
    runtimeDir: root,
    modelsDir: path.join(root, "models"),
    presetsFile: path.join(root, `presets${tag}.ini`),
    pidFile: path.join(root, `engine${tag}.pid`),
    logFile: path.join(path.dirname(root), `engine${tag}.log`),
    exe: engine?.exe ?? null,
    build: engine?.build ?? null
  };
}

export type EngineState =
  /** Started here, and answering. */
  | { status: "running"; url: string; pid: number; build: string | null; models: number }
  /**
   * Someone else's engine: one named by TRHAI_ENGINE_URL, or the one another
   * copy of the API on this PC started first. Used, and never stopped from here.
   */
  | { status: "external"; url: string }
  /** Not running, and why - in words a person can act on. */
  | { status: "off"; url: string; reason: string };

let child: ChildProcess | null = null;
/** Where the running engine's process id was written, to take it away again when it stops. */
let pidFileWritten: string | null = null;
let attempted = false;
let state: EngineState = { status: "off", url: engineUrl(), reason: "The model engine has not been started." };

/** What the engine is doing, for the System page and the doctor. */
export function engineState(): EngineState {
  return state;
}

/**
 * Why the engine this process tried to start is not running, or null: it is
 * running, it is someone else's, or nothing here ever tried to start one.
 */
export function engineOffReason(): string | null {
  return attempted && state.status === "off" ? state.reason : null;
}

/** Ends a process and everything it started. The engine runs each model as a child of its own. */
function killTree(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
}

/** The name of the program a process id belongs to, or null when no process has it. */
export function processName(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "win32") {
    const listed = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { windowsHide: true, encoding: "utf8" });
    // A row is "name","pid",...; with no such process it is a sentence instead.
    return /^"([^"]+)"/.exec((listed.stdout ?? "").trim())?.[1] ?? null;
  }
  const listed = spawnSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" });
  return (listed.stdout ?? "").trim() || null;
}

/**
 * The engine an earlier start left running, from the file its process id was
 * kept in, and whether the API that started it is still running too.
 *
 * The API is usually stopped by being killed - the launcher and the desktop
 * app both do - and a killed process cannot stop its children. The engine it
 * started would keep the port, the card's memory, and a preset file that no
 * longer matches the models folder: that one is ended (see startEngine).
 *
 * But an engine whose API is still running was not left behind. It belongs to
 * another copy of the app on this PC - a second window, a developer's own, a
 * test - and ending it would cut off a reply someone is reading.
 *
 * Null when the file names no engine. Process ids are reused, so one that now
 * belongs to some other program is not an engine and is never touched.
 */
export function leftoverEngine(pidFile: string): { pid: number; ownerRunning: boolean } | null {
  let recorded: string;
  try { recorded = readFileSync(pidFile, "utf8"); } catch { return null; }
  const [pid, owner] = recorded.trim().split(/\s+/).map(Number);
  if (!/llama-server/i.test(processName(pid) ?? "")) return null;
  return { pid, ownerRunning: owner !== process.pid && /^node/i.test(processName(owner) ?? "") };
}

/** Whether the engine answers within `withinMs`. Gives up early once `waitingFor` says there is nothing left to wait for. */
async function answersHealth(url: string, withinMs: number, waitingFor: () => boolean = () => true): Promise<boolean> {
  const until = Date.now() + withinMs;
  while (Date.now() < until && waitingFor()) {
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

/** A start that is under way, so a second caller waits for it instead of starting another. */
let starting: Promise<EngineState> | null = null;
/** When the last start began, and what it was started with: reviveEngine starts it the same way. */
let lastStartAt = 0;
let startedWith: NodeJS.ProcessEnv = process.env;
/** True once the engine has been stopped on purpose; it is not started again after that. */
let closing = false;
/** The least time between two tries at starting an engine that keeps stopping. */
const reviveEveryMs = 15_000;

/**
 * Starts the engine, unless one is named or none is installed. Never throws:
 * the app runs without a model and says so, as it did with no Ollama.
 */
export function startEngine(env: NodeJS.ProcessEnv = process.env): Promise<EngineState> {
  if (starting) return starting;
  closing = false;
  starting = launch(env).finally(() => { starting = null; });
  return starting;
}

/**
 * Starts the engine again when it has stopped: it crashed, or it was another
 * copy of the app's and that copy has closed. Resolves true when an engine is
 * answering again.
 *
 * Only in a process that runs the engine itself, never after it was stopped
 * on purpose, and not more often than every fifteen seconds - an engine that
 * will not start must not hold up every request that asks after it.
 */
export async function reviveEngine(): Promise<boolean> {
  if (!attempted || closing) return false;
  if (starting) return (await starting).status !== "off";
  if (child || Date.now() - lastStartAt < reviveEveryMs) return false;
  // Said where the API's log is read: a model that vanished and came back
  // would otherwise leave no trace of having done either.
  console.warn(`[engine] the model engine is not answering${state.status === "off" ? ` (${state.reason})` : ""}; starting it`);
  const revived = await startEngine(startedWith);
  console.warn(revived.status === "off" ? `[engine] it did not start: ${revived.reason}` : `[engine] the model engine is answering again at ${revived.url}`);
  return revived.status !== "off";
}

async function launch(env: NodeJS.ProcessEnv): Promise<EngineState> {
  const url = engineUrl(env);
  if (env.TRHAI_ENGINE_URL?.trim()) {
    state = { status: "external", url };
    return state;
  }
  attempted = true;
  lastStartAt = Date.now();
  startedWith = env;
  state = { status: "off", url, reason: "The model engine is starting. Try again in a few seconds." };
  const paths = enginePaths(env);
  if (!paths.exe) {
    state = {
      status: "off", url,
      reason: `The model engine (llama.cpp) is not installed in ${path.join(paths.runtimeDir, "engine")}. Run: npm run setup:engine`
    };
    return state;
  }
  try {
    mkdirSync(paths.modelsDir, { recursive: true });
    const models = discoverModels(paths.modelsDir);
    const forced = Number(env.TRHAI_CONTEXT_TOKENS);
    const leftover = leftoverEngine(paths.pidFile);
    if (leftover?.ownerRunning) {
      // Another copy of the API started the engine on this port and is still
      // running. Its engine is used as it is, and is its to stop.
      state = await answersHealth(url, 20_000)
        ? { status: "external", url }
        : {
          status: "off", url,
          reason: `Another copy of TRH AI is running the model engine on port ${enginePort(env)}, and it is not answering.`
        };
      return state;
    }
    if (leftover) killTree(leftover.pid);
    writeFileSync(paths.presetsFile, presetsText(models, { contextTokens: Number.isFinite(forced) && forced > 0 ? forced : undefined }));

    // The log of the engine that ran before is kept beside the new one: when
    // an engine is started again because it stopped, that log is the only
    // place that says why.
    try { renameSync(paths.logFile, `${paths.logFile}.prev`); } catch { /* there was none */ }
    const log = openSync(paths.logFile, "w");
    const started = spawn(paths.exe, [
      "--models-preset", paths.presetsFile,
      // One model in memory at a time: two do not fit an 8 GB card, and the
      // engine lets the idle one go when another is asked for.
      "--models-max", "1",
      // This PC only, like the API itself.
      "--host", "127.0.0.1",
      "--port", String(enginePort(env))
    ], { cwd: path.dirname(paths.exe), windowsHide: true, stdio: ["ignore", log, log] });
    child = started;
    // The engine's process id, and this one's: who to ask whether it is still in use.
    if (started.pid) {
      writeFileSync(paths.pidFile, `${started.pid} ${process.pid}`);
      pidFileWritten = paths.pidFile;
    }
    started.once("exit", (code) => {
      if (child !== started) return;
      child = null;
      state = { status: "off", url, reason: `The model engine stopped (exit code ${code ?? "unknown"}). Its log is ${paths.logFile}.` };
    });
    started.once("error", (error) => {
      if (child !== started) return;
      child = null;
      state = { status: "off", url, reason: `The model engine could not be started: ${error.message}` };
    });

    // Not waited for once it has exited: an engine that could not take its
    // port is gone in a second, and there is nothing left to answer.
    if (await answersHealth(url, 20_000, () => child === started) && child === started && started.pid) {
      state = { status: "running", url, pid: started.pid, build: paths.build, models: models.length };
    } else if (child === started) {
      endEngine();
      state = { status: "off", url, reason: `The model engine did not answer within 20 s of starting. Its log is ${paths.logFile}.` };
    }
  } catch (error) {
    state = { status: "off", url, reason: `The model engine could not be started: ${error instanceof Error ? error.message : String(error)}` };
  }
  return state;
}

/** Ends the engine this process started, and the model it has loaded. */
function endEngine(): void {
  const running = child;
  child = null;
  if (!running?.pid) return;
  killTree(running.pid);
  if (pidFileWritten) {
    try { rmSync(pidFileWritten, { force: true }); } catch { /* nothing to remove */ }
    pidFileWritten = null;
  }
  state = { status: "off", url: state.url, reason: "The model engine was stopped." };
}

/** Stops the engine for good: the API is closing. It is not started again by a request that finds it gone. */
export function stopEngine(): void {
  closing = true;
  endEngine();
}

// ---------------------------------------------------------------- asking it

export type EngineModel = {
  id: string;
  /** "loaded", "loading" or "unloaded", as the engine says it. */
  status: string;
  /** The context window it is loaded with; null while it is not loaded. */
  windowTokens: number | null;
  sizeBytes: number | null;
  /** Whether it takes images. */
  vision: boolean;
  /** Its last load ended in failure - a missing file, or no memory for it. */
  failed: boolean;
};

type FetchLike = typeof fetch;

/** The engine's models. Throws when the engine does not answer, or answers with an error. */
export async function listEngineModels(baseUrl: string, fetchImpl: FetchLike = fetch, signal?: AbortSignal): Promise<EngineModel[]> {
  const response = await fetchImpl(`${baseUrl}/models`, { signal: signal ?? AbortSignal.timeout(4000) });
  if (!response.ok) throw new Error(`The model engine answered ${response.status}.`);
  const payload = await response.json() as { data?: unknown };
  const entries = Array.isArray(payload.data) ? payload.data as Array<Record<string, unknown>> : [];
  const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null);
  return entries.flatMap((entry) => {
    if (typeof entry.id !== "string" || !entry.id) return [];
    const status = entry.status as { value?: unknown; failed?: unknown } | undefined;
    const meta = entry.meta as { n_ctx?: unknown; size?: unknown } | undefined;
    const takes = (entry.architecture as { input_modalities?: unknown } | undefined)?.input_modalities;
    return [{
      id: entry.id,
      status: typeof status?.value === "string" ? status.value : "unloaded",
      windowTokens: count(meta?.n_ctx),
      sizeBytes: count(meta?.size),
      vision: Array.isArray(takes) && takes.includes("image"),
      failed: status?.failed === true
    }];
  });
}

/** The engine's model for a name: that model, or failing that a size of it. */
export function findEngineModel<T extends { id: string }>(models: T[], name: string): T | undefined {
  return models.find((model) => sameModel(model.id, name)) ?? models.find((model) => isModelOrSize(name, model.id));
}

export type LoadedModel = { ok: true; id: string; windowTokens: number } | { ok: false; reason: string };

/**
 * Has the engine load a model, and says what window it was given.
 *
 * Asked before a request rather than left to the request itself, because the
 * window is only known once the model is loaded - the engine fits it to the
 * card at that moment - and the prompt has to be cut to that window before it
 * is sent. Loading takes a few seconds off an SSD, and another model that was
 * loaded is let go first.
 *
 * One that is in the middle of a reply is not let go: the engine refuses the
 * load with "try again later" until that reply ends, so the load is asked for
 * again until it is taken or the time runs out.
 */
export async function loadEngineModel(
  baseUrl: string,
  name: string,
  options: { fetchImpl?: FetchLike; signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<LoadedModel> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const allowed = options.timeoutMs ?? 120_000;
  const until = Date.now() + allowed;
  // The caller's Stop and the time allowed, on every request made here: an
  // engine that stops answering must not hold the turn open.
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(allowed)]) : AbortSignal.timeout(allowed);
  const stopped = { ok: false as const, reason: "Stopped before the model was loaded." };
  const missing = { ok: false as const, reason: `${name} is not one of the models in TRH AI's models folder.` };
  const outOfTime = { ok: false as const, reason: `${name} was not loaded within ${allowed >= 1000 ? `${Math.round(allowed / 1000)} s` : `${allowed} ms`}.` };
  const find = async () => findEngineModel(await listEngineModels(baseUrl, fetchImpl, signal), name);
  try {
    let model = await find();
    if (!model) return missing;
    let requested = false;
    let sawLoading = false;
    let failedPolls = 0;
    for (;;) {
      if (model.status === "loaded" && model.windowTokens) return { ok: true, id: model.id, windowTokens: model.windowTokens };
      if (options.signal?.aborted) return stopped;
      if (Date.now() >= until) return outOfTime;

      if (model.status === "loading") {
        sawLoading = true;
      } else {
        // The load was taken and ended in failure. Seen after it began, or
        // twice running, so a failure left from an earlier try is not this one's.
        if (requested && model.failed && (sawLoading || ++failedPolls >= 2)) {
          return { ok: false, reason: `${name} could not be loaded by the model engine. Its log is ${enginePaths().logFile}.` };
        }
        const response = await fetchImpl(`${baseUrl}/models/load`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: model.id }),
          signal
        });
        const body = await response.text().catch(() => "");
        requested = requested || response.ok;
        // 400 is "already running": the next look finds it loaded. "Try again
        // later" is another model in the middle of a reply. Anything else is a no.
        if (!response.ok && response.status !== 400 && !/try again|limit reached/i.test(body)) {
          return { ok: false, reason: `The model engine would not load ${name} (it answered ${response.status}).` };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
      model = await find();
      if (!model) return missing;
    }
  } catch (error) {
    if (options.signal?.aborted) return stopped;
    // The time allowed ran out in the middle of a request, rather than between two.
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return outOfTime;
    // It answered, with an error, when asked which models it has.
    if (error instanceof Error && /^The model engine answered \d+\.$/.test(error.message)) {
      return { ok: false, reason: `${error.message.slice(0, -1)} while loading ${name}.` };
    }
    return { ok: false, reason: `The model engine is not answering, so ${name} could not be loaded.` };
  }
}

/** Lets a model go now, rather than when it has sat idle. The next request that needs it loads it again. */
export async function unloadEngineModel(baseUrl: string, name: string, fetchImpl: FetchLike = fetch): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const models = await listEngineModels(baseUrl, fetchImpl);
    const id = models.find((model) => sameModel(model.id, name))?.id ?? name;
    const response = await fetchImpl(`${baseUrl}/models/unload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: id }),
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) return { ok: false, reason: `The model engine answered with ${response.status}.` };
    return { ok: true };
  } catch {
    return { ok: false, reason: "The model engine is not answering." };
  }
}
