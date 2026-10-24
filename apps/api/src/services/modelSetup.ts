// First-run setup: the model engine and the models, downloaded and verified
// by the app itself.
//
// Until this, a PC without an engine was told to run `npm run setup:engine`
// and to copy a .gguf file into a folder by hand - neither of which an
// installed copy, or the person using it, can do. This does both from inside
// the app, the same way the script did:
//
// - Everything comes from the people who made it: llama.cpp's own releases on
//   GitHub, and the model makers' own files on Hugging Face (one model, Qwen3
//   4B Instruct 2507, has no GGUF from Qwen itself and comes from unsloth).
// - Every file is pinned: a release tag or a repository commit, its exact
//   size, and its SHA-256, recorded here. A download that does not match is
//   thrown away, never installed.
// - A download that stops part-way resumes where it stopped, and nothing
//   reaches the engine's folders until it is whole and verified.
// - The engine reads its list of models when it starts, so it is restarted
//   once the models are in place.
//
// Nothing here needs a key or an account. The only requests are the
// downloads themselves.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statfsSync, statSync
} from "node:fs";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { discoverModels, enginePaths, engineState, restartEngine, sameModel } from "./modelEngine.js";
import { catalogueTool, toolCatalogue, toolStatuses, type ToolDef, type ToolStatus } from "./toolCatalog.js";

// ------------------------------------------------------------------ this PC

export type Gpu = { vendor: "nvidia"; name: string; memoryMiB: number; driver: string };

export type Hardware = {
  totalMemoryBytes: number;
  cpuCores: number;
  /** An NVIDIA card nvidia-smi answers for; null otherwise. Other cards run the CPU build. */
  gpu: Gpu | null;
};

type Run = typeof spawnSync;

let hardwareCache: Hardware | null = null;

/** What this PC has. Read once: nvidia-smi takes a moment, and none of it changes while the app runs. */
export function readHardware(run: Run = spawnSync): Hardware {
  if (hardwareCache && run === spawnSync) return hardwareCache;
  let gpu: Gpu | null = null;
  try {
    const answer = run("nvidia-smi", ["--query-gpu=name,memory.total,driver_version", "--format=csv,noheader,nounits"], {
      encoding: "utf8", timeout: 5000, windowsHide: true
    });
    const line = String(answer.stdout ?? "").split(/\r?\n/).find((row) => row.trim());
    if (answer.status === 0 && line) {
      const [name, memory, driver] = line.split(",").map((part) => part.trim());
      const memoryMiB = Number(memory);
      if (name && Number.isFinite(memoryMiB)) gpu = { vendor: "nvidia", name, memoryMiB, driver: driver ?? "" };
    }
  } catch {
    gpu = null;
  }
  const hardware = { totalMemoryBytes: os.totalmem(), cpuCores: os.cpus().length, gpu };
  if (run === spawnSync) hardwareCache = hardware;
  return hardware;
}

// ------------------------------------------------------------------ the engine

export const engineBuild = "b11366";
export type EngineVariant = "cpu" | "cuda-12.4" | "cuda-13.4";

export type PinnedFile = { name: string; sizeBytes: number; sha256: string; url: string };

const release = (name: string, sizeBytes: number, sha256: string): PinnedFile => ({
  name, sizeBytes, sha256, url: `https://github.com/ggml-org/llama.cpp/releases/download/${engineBuild}/${name}`
});

/**
 * The archives of each build, as the release publishes them (each asset's
 * "digest"). The CPU archive was also checked against the copy downloaded on
 * the PC this was written on. A CUDA build needs NVIDIA's runtime beside it,
 * which the release ships as a second archive.
 */
export const engineArchives: Record<EngineVariant, PinnedFile[]> = {
  cpu: [
    release(`llama-${engineBuild}-bin-win-cpu-x64.zip`, 19_328_326, "33dbed3c969e394e2977105e89f5c4b5dbbb5233d038d14b6954b3d32bbde9ec")
  ],
  "cuda-12.4": [
    release(`llama-${engineBuild}-bin-win-cuda-12.4-x64.zip`, 263_346_618, "76ab26e184910f956894f4527cd9be0398fa7a6ba1e172eec4f209d3210748dd"),
    release("cudart-llama-bin-win-cuda-12.4-x64.zip", 391_443_627, "8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6")
  ],
  "cuda-13.4": [
    release(`llama-${engineBuild}-bin-win-cuda-13.4-x64.zip`, 152_825_012, "894ad612d38db998c185e36665fc0945e1b17321af807f874ae334ea37e1c809"),
    release("cudart-llama-bin-win-cuda-13.4-x64.zip", 423_535_356, "738f8c251ac22b70c3ae6f83a10cf222725df0395246a2cf58f32bdb85fbe668")
  ]
};

/** CUDA 13 needs NVIDIA's 580 drivers or later; an older driver gets the CUDA 12 build. */
export function engineVariantFor(hardware: Pick<Hardware, "gpu">): EngineVariant {
  if (!hardware.gpu) return "cpu";
  const major = Number(/^(\d+)/.exec(hardware.gpu.driver)?.[1] ?? 0);
  return major >= 580 ? "cuda-13.4" : "cuda-12.4";
}

// ------------------------------------------------------------------ the models

export type ModelLicense = { name: string; url: string; commercialUse: boolean };

export type CatalogModel = {
  /** The name the engine and the rest of the app know it by. Also its file or folder name. */
  id: string;
  label: string;
  /** One sentence: what it is good for, in a person's words. */
  summary: string;
  /** What it needs to run at a usable speed. */
  needs: string;
  license: ModelLicense;
  /** True for a model that only answers about images. */
  vision: boolean;
  /** One file, saved as <id>.gguf; or several (a vision model and its projector), saved in a folder <id>. */
  files: PinnedFile[];
};

const hf = (repo: string, commit: string, name: string, sizeBytes: number, sha256: string): PinnedFile => ({
  name, sizeBytes, sha256, url: `https://huggingface.co/${repo}/resolve/${commit}/${name}`
});

const apache: ModelLicense = { name: "Apache 2.0", url: "https://www.apache.org/licenses/LICENSE-2.0", commercialUse: true };
const qwenResearch = (repo: string): ModelLicense => ({
  name: "Qwen Research License (non-commercial)", url: `https://huggingface.co/${repo}/blob/main/LICENSE`, commercialUse: false
});

/**
 * What can be installed from inside the app. Every model here is a Q4_K_M
 * quantisation: the size these were measured at, small enough for an 8 GB
 * card, and the one most people run.
 *
 * The licence shown is the original model's, not the download page's: the
 * GGUF repository for the 3B vision model says Apache 2.0, while the model it
 * was made from is under Qwen's research licence.
 */
export const modelCatalog: CatalogModel[] = [
  {
    id: "qwen3-4b-instruct-2507",
    label: "Qwen3 4B Instruct",
    summary: "The everyday model for a PC without a graphics card: quick to answer, good with TRH AI's tools.",
    needs: "8 GB of memory",
    license: apache,
    vision: false,
    files: [hf("unsloth/Qwen3-4B-Instruct-2507-GGUF", "a06e946bb6b655725eafa393f4a9745d460374c9", "Qwen3-4B-Instruct-2507-Q4_K_M.gguf", 2_497_281_120, "3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597")]
  },
  {
    id: "qwen2.5-coder-7b",
    label: "Qwen2.5 Coder 7B",
    summary: "The model TRH AI was tuned with: the best at using its tools and at writing code.",
    needs: "16 GB of memory, or a graphics card with 8 GB",
    license: apache,
    vision: false,
    files: [hf("Qwen/Qwen2.5-Coder-7B-Instruct-GGUF", "13fb94bfda8c8cf22497dc57b78f391a9acb426a", "qwen2.5-coder-7b-instruct-q4_k_m.gguf", 4_683_073_536, "509287f78cb4d4cf6b3843734733b914b2c158e43e22a7f4bf5e963800894d3c")]
  },
  {
    id: "qwen3-8b",
    label: "Qwen3 8B",
    summary: "Thinks before it answers: more careful on hard questions, and several times slower.",
    needs: "A graphics card with 8 GB",
    license: apache,
    vision: false,
    files: [hf("Qwen/Qwen3-8B-GGUF", "7c41481f57cb95916b40956ab2f0b139b296d974", "Qwen3-8B-Q4_K_M.gguf", 5_027_783_488, "d98cdcbd03e17ce47681435b5150e34c1417f50b5c0019dd560e4882c5745785")]
  },
  {
    id: "qwen2.5-vl-7b",
    label: "Qwen2.5 VL 7B (pictures)",
    summary: "Looks at pictures and screenshots you share, and reads the text in them.",
    needs: "16 GB of memory, or a graphics card with 8 GB",
    license: apache,
    vision: true,
    files: [
      hf("ggml-org/Qwen2.5-VL-7B-Instruct-GGUF", "508edd0afaa66bb9e9f40587acc2184f02daf1f6", "Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf", 4_683_072_032, "9258bf05b12686d097ff3b6b18d968ab393649780aa2b3cd67fec43d50554392"),
      hf("ggml-org/Qwen2.5-VL-7B-Instruct-GGUF", "508edd0afaa66bb9e9f40587acc2184f02daf1f6", "mmproj-Qwen2.5-VL-7B-Instruct-Q8_0.gguf", 853_119_712, "2ddb555391bae966e412deab9e07b58afa18bcc06930ba0f1c78a3695ab9e506")
    ]
  },
  {
    id: "qwen2.5-3b",
    label: "Qwen2.5 3B",
    summary: "The smallest and quickest. For personal use only: its licence does not allow commercial use.",
    needs: "8 GB of memory",
    license: qwenResearch("Qwen/Qwen2.5-3B-Instruct"),
    vision: false,
    files: [hf("Qwen/Qwen2.5-3B-Instruct-GGUF", "7dabda4d13d513e3e842b20f0d435c732f172cbe", "qwen2.5-3b-instruct-q4_k_m.gguf", 2_104_932_768, "626b4a6678b86442240e33df819e00132d3ba7dddfe1cdc4fbb18e0a9615c62d")]
  },
  {
    id: "qwen2.5-vl-3b",
    label: "Qwen2.5 VL 3B (pictures)",
    summary: "Looks at pictures on a smaller PC. For personal use only: its licence does not allow commercial use.",
    needs: "8 GB of memory",
    license: qwenResearch("Qwen/Qwen2.5-VL-3B-Instruct"),
    vision: true,
    files: [
      hf("ggml-org/Qwen2.5-VL-3B-Instruct-GGUF", "5037fcf163dd95d1e41d1974465f0898ed108ca2", "Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf", 1_929_901_056, "d02fe9b69ad8cadbbd228e387667af66612c44bed29ffc8eb1e7caf9ac486c12"),
      hf("ggml-org/Qwen2.5-VL-3B-Instruct-GGUF", "5037fcf163dd95d1e41d1974465f0898ed108ca2", "mmproj-Qwen2.5-VL-3B-Instruct-Q8_0.gguf", 844_757_728, "980c9b2f78c04e6cff93d277ada09e768394f112d75db3b4e9dea8a69f9fb904")
    ]
  }
];

export function catalogModel(id: string): CatalogModel | undefined {
  return modelCatalog.find((model) => model.id === id);
}

export function modelSize(model: CatalogModel): number {
  return model.files.reduce((sum, file) => sum + file.sizeBytes, 0);
}

const gib = 1024 ** 3;

/** A PC that can run the 7B models at a usable speed: a card with 8 GB, or 16 GB of memory. */
export function hasRoomForSevenB(hardware: Hardware): boolean {
  return (hardware.gpu !== null && hardware.gpu.memoryMiB >= 7500) || hardware.totalMemoryBytes >= 15 * gib;
}

/** The chat model to install first on this PC. */
export function recommendedModel(hardware: Hardware): string {
  return hasRoomForSevenB(hardware) ? "qwen2.5-coder-7b" : "qwen3-4b-instruct-2507";
}

/**
 * Settings that suit this PC, for whatever .env does not set.
 *
 * Written down on the 8 GB, no-graphics-card PC this app was finished on
 * (docs/21-handoff.md): the engine's `fit` sizes the context window for a
 * graphics card, and without one the window has to be capped or the model
 * pages; a cold reply there takes minutes, so the 180 s default gave up on
 * answers that were coming; and unloading after five idle minutes made every
 * pause cost another cold start. A PC with a card keeps the defaults.
 */
export function hardwareDefaults(hardware: Hardware, env: NodeJS.ProcessEnv): Record<string, string> {
  const defaults: Record<string, string> = {};
  const unset = (key: string) => !env[key]?.trim();
  if (!hardware.gpu) {
    if (unset("TRHAI_CONTEXT_TOKENS")) defaults.TRHAI_CONTEXT_TOKENS = "8192";
    if (unset("TRHAI_MODEL_TIMEOUT_MS")) defaults.TRHAI_MODEL_TIMEOUT_MS = "600000";
    if (unset("TRHAI_IDLE_UNLOAD_SECONDS")) defaults.TRHAI_IDLE_UNLOAD_SECONDS = "1800";
  }
  // On a small PC the small model answers even when a bigger one is also
  // installed; the bigger one stays a choice in Settings.
  if (!hasRoomForSevenB(hardware) && unset("TRHAI_MODEL") && unset("OLLAMA_MODEL")) {
    defaults.TRHAI_MODEL = recommendedModel(hardware);
  }
  return defaults;
}

// ------------------------------------------------------------------ status

export type StepState = "waiting" | "downloading" | "verifying" | "unpacking" | "done" | "failed" | "cancelled";

export type SetupStep = {
  kind: "engine" | "model" | "tool";
  id: string;
  label: string;
  totalBytes: number;
  doneBytes: number;
  state: StepState;
  error: string | null;
};

export type SetupJob = {
  id: string;
  state: "running" | "done" | "failed" | "cancelled";
  startedAt: string;
  finishedAt: string | null;
  steps: SetupStep[];
  error: string | null;
};

export type InstalledModel = { id: string; sizeBytes: number; vision: boolean; inCatalog: boolean };

export type SetupStatus = {
  hardware: Hardware;
  engine: {
    installed: boolean;
    build: string | null;
    running: boolean;
    reason: string | null;
    recommendedVariant: EngineVariant;
    downloadBytes: number;
  };
  catalog: Array<Omit<CatalogModel, "files"> & { sizeBytes: number; installed: boolean; recommended: boolean }>;
  installed: InstalledModel[];
  /** The voice, listening and video tools: optional for answering, needed for those screens. */
  tools: ToolStatus[];
  /** True when the app cannot answer yet: no engine, or no model that can hold a conversation. */
  needsSetup: boolean;
  recommendedModel: string;
  runtimeDir: string;
  freeBytes: number | null;
  job: SetupJob | null;
};

function freeSpace(dir: string): number | null {
  // The folder may not exist yet on a new PC; its drive does.
  let probe = dir;
  while (!existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
  try {
    const stats = statfsSync(probe);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

const visionName = /(^|[-_.])vl([-_.]|\d|$)|vision|llava|minicpm-v|moondream/i;

export function setupStatus(env: NodeJS.ProcessEnv = process.env): SetupStatus {
  const hardware = readHardware();
  const paths = enginePaths(env);
  const found = discoverModels(paths.modelsDir);
  const installed: InstalledModel[] = found.map((model) => {
    const known = modelCatalog.find((entry) => sameModel(entry.id, model.id));
    return { id: model.id, sizeBytes: model.sizeBytes, vision: known ? known.vision : Boolean(model.mmproj) || visionName.test(model.id), inCatalog: Boolean(known) };
  });
  const recommended = recommendedModel(hardware);
  const variant = engineVariantFor(hardware);
  const engine = engineState();
  return {
    hardware,
    engine: {
      installed: paths.exe !== null,
      build: paths.build,
      running: engine.status !== "off",
      reason: engine.status === "off" ? engine.reason : null,
      recommendedVariant: variant,
      downloadBytes: engineArchives[variant].reduce((sum, file) => sum + file.sizeBytes, 0)
    },
    catalog: modelCatalog.map(({ files, ...model }) => ({
      ...model,
      sizeBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
      installed: installed.some((entry) => sameModel(entry.id, model.id)),
      recommended: model.id === recommended
    })),
    installed,
    tools: toolStatuses(env),
    needsSetup: paths.exe === null || !installed.some((model) => !model.vision),
    recommendedModel: recommended,
    runtimeDir: paths.runtimeDir,
    freeBytes: freeSpace(paths.runtimeDir),
    job
  };
}

// ------------------------------------------------------------------ downloading

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export class SetupCancelled extends Error {
  constructor() {
    super("Stopped.");
  }
}

/**
 * Downloads one pinned file to `destination`, checking its size and SHA-256.
 *
 * It is written as `<destination>.part` and renamed only once it matches, so a
 * file at `destination` is always a whole, verified one. A `.part` left by a
 * download that stopped is hashed again and continued from where it ended,
 * when the server supports ranges (GitHub's and Hugging Face's both do); one
 * that does not is started over.
 */
export async function downloadVerified(
  file: PinnedFile,
  destination: string,
  options: { fetcher?: Fetcher; signal?: AbortSignal; onProgress?: (doneBytes: number) => void } = {}
): Promise<void> {
  const fetcher = options.fetcher ?? fetch;
  const part = `${destination}.part`;
  mkdirSync(path.dirname(destination), { recursive: true });

  let hash = createHash("sha256");
  let have = 0;
  if (existsSync(part)) {
    have = statSync(part).size;
    if (have > file.sizeBytes) {
      rmSync(part, { force: true });
      have = 0;
    } else {
      for await (const chunk of createReadStream(part)) {
        if (options.signal?.aborted) throw new SetupCancelled();
        hash.update(chunk as Buffer);
      }
    }
  }
  options.onProgress?.(have);

  if (have < file.sizeBytes) {
    let response: Response;
    try {
      response = await fetcher(file.url, {
        headers: { "User-Agent": "TRH-AI-setup", ...(have > 0 ? { Range: `bytes=${have}-` } : {}) },
        redirect: "follow",
        signal: options.signal
      });
    } catch (error) {
      if (options.signal?.aborted) throw new SetupCancelled();
      throw new Error(`${file.name} could not be downloaded: ${error instanceof Error ? error.message : String(error)}. Check the internet connection and try again; it carries on from where it stopped.`);
    }
    if (have > 0 && response.status === 200) {
      // The server sent the whole file instead of the rest: start over.
      hash = createHash("sha256");
      have = 0;
      rmSync(part, { force: true });
    } else if (!response.ok) {
      throw new Error(`${file.name} could not be downloaded: the server answered ${response.status}.`);
    }
    if (!response.body) throw new Error(`${file.name} could not be downloaded: the server sent nothing.`);

    const out = createWriteStream(part, { flags: have > 0 ? "a" : "w" });
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        if (options.signal?.aborted) throw new SetupCancelled();
        hash.update(chunk);
        have += chunk.byteLength;
        if (have > file.sizeBytes) throw new Error(`${file.name} is larger than it should be. It was not installed.`);
        if (!out.write(chunk)) await once(out, "drain");
        options.onProgress?.(have);
      }
    } catch (error) {
      if (options.signal?.aborted) throw new SetupCancelled();
      if (error instanceof SetupCancelled) throw error;
      throw error instanceof Error && /larger than it should be/.test(error.message)
        ? error
        : new Error(`${file.name} stopped downloading part-way: ${error instanceof Error ? error.message : String(error)}. Try again; it carries on from where it stopped.`);
    } finally {
      out.end();
      await once(out, "close").catch(() => undefined);
    }
  }

  const digest = hash.digest("hex");
  if (have !== file.sizeBytes || digest !== file.sha256) {
    rmSync(part, { force: true });
    throw new Error(`${file.name} did not match what its makers published (expected ${file.sha256.slice(0, 12)}…, got ${digest.slice(0, 12)}…, ${have} of ${file.sizeBytes} bytes). It was not installed, and the download was deleted.`);
  }
  rmSync(destination, { force: true });
  renameSync(part, destination);
}

/** Unpacks a zip with Windows' own tar, or PowerShell where tar is missing. */
export function unzip(archive: string, into: string, run: Run = spawnSync): void {
  mkdirSync(into, { recursive: true });
  const tar = process.env.SystemRoot ? path.join(process.env.SystemRoot, "System32", "tar.exe") : "tar";
  const viaTar = run(tar, ["-xf", archive, "-C", into], { windowsHide: true, encoding: "utf8", timeout: 10 * 60_000 });
  if (viaTar.status === 0) return;
  const viaPowerShell = run("powershell", [
    "-NoProfile", "-NonInteractive", "-Command",
    `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${into.replace(/'/g, "''")}' -Force`
  ], { windowsHide: true, encoding: "utf8", timeout: 10 * 60_000 });
  if (viaPowerShell.status !== 0) {
    throw new Error(`An archive could not be unpacked: ${String(viaPowerShell.stderr || viaTar.stderr || "unknown error").trim().slice(0, 300)}`);
  }
}

// ------------------------------------------------------------------ the job

let job: SetupJob | null = null;
let controller: AbortController | null = null;

export type SetupRequest = {
  /** Install the engine: true for the build this PC needs, or a build by name. */
  engine?: boolean | EngineVariant;
  /** Catalog ids of models to install. */
  models?: string[];
  /** Ids of the tools to install: "speech", "listening", "video" (toolCatalog.ts). */
  tools?: string[];
};

export type SetupDeps = {
  fetcher?: Fetcher;
  unzip?: (archive: string, into: string) => void;
  /** Stops the engine, runs `between` (if any) while it is stopped, and starts it again. */
  restart?: (between?: () => void) => Promise<unknown>;
  hardware?: Hardware;
  env?: NodeJS.ProcessEnv;
  /** What can be installed, when not the real lists: the tests use small files of their own. */
  catalog?: CatalogModel[];
  engineFiles?: Record<EngineVariant, PinnedFile[]>;
  /** The tools that can be installed, when not the real ones. */
  tools?: ToolDef[];
};

export type StartResult = { ok: true; job: SetupJob } | { ok: false; error: string };

const sizeText = (bytes: number) => (bytes >= gib ? `${(bytes / gib).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`);

/** Starts installing what was asked for, in the background. One setup at a time. */
export function startSetup(request: SetupRequest, deps: SetupDeps = {}): StartResult {
  if (job?.state === "running") return { ok: false, error: "Setup is already running." };
  const env = deps.env ?? process.env;
  const hardware = deps.hardware ?? readHardware();
  const paths = enginePaths(env);
  const catalog = deps.catalog ?? modelCatalog;
  const archives = deps.engineFiles ?? engineArchives;
  const lookup = (id: string) => catalog.find((model) => model.id === id);

  const unknown = (request.models ?? []).filter((id) => !lookup(id));
  if (unknown.length) return { ok: false, error: `Not a model TRH AI can install: ${unknown.join(", ")}.` };
  const tools = deps.tools ?? toolCatalogue;
  const unknownTools = (request.tools ?? []).filter((id) => !catalogueTool(id, tools));
  if (unknownTools.length) return { ok: false, error: `Not a tool TRH AI can install: ${unknownTools.join(", ")}.` };
  if ((request.tools ?? []).length > 0 && !deps.tools && process.platform !== "win32") {
    return { ok: false, error: "The voice, listening and video tools are built for Windows." };
  }

  const installed = discoverModels(paths.modelsDir).map((model) => model.id);
  const steps: SetupStep[] = [];
  const variant: EngineVariant | null = request.engine === true ? engineVariantFor(hardware)
    : typeof request.engine === "string" && request.engine in archives ? request.engine
      : null;
  if (request.engine && !variant) return { ok: false, error: `Not an engine build TRH AI can install: ${String(request.engine)}.` };
  if (variant && !paths.exe) {
    steps.push({
      kind: "engine", id: variant, label: `Model engine (llama.cpp ${engineBuild}, ${variant === "cpu" ? "for this PC's processor" : "for the NVIDIA card"})`,
      totalBytes: archives[variant].reduce((sum, file) => sum + file.sizeBytes, 0), doneBytes: 0, state: "waiting", error: null
    });
  }
  for (const id of [...new Set(request.models ?? [])]) {
    if (installed.some((name) => sameModel(name, id))) continue;
    const model = lookup(id) as CatalogModel;
    steps.push({ kind: "model", id, label: model.label, totalBytes: modelSize(model), doneBytes: 0, state: "waiting", error: null });
  }
  for (const id of [...new Set(request.tools ?? [])]) {
    const tool = catalogueTool(id, tools) as ToolDef;
    // Only what is missing: Piper without a voice gets the voice, and a tool that is all there gets nothing.
    const files = tool.missing(env);
    if (files.length === 0) continue;
    steps.push({ kind: "tool", id, label: tool.label, totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0), doneBytes: 0, state: "waiting", error: null });
  }

  const needed = steps.reduce((sum, step) => sum + step.totalBytes, 0);
  const free = freeSpace(paths.runtimeDir);
  // Room for the downloads and a gigabyte besides; the engine's archive also
  // unpacks to about twice its size.
  if (free !== null && needed > 0 && free < needed * 1.1 + gib) {
    return { ok: false, error: `Not enough free space: this needs about ${sizeText(needed * 1.1 + gib)} and the drive has ${sizeText(free)}. Free some space and try again.` };
  }

  const now = new Date().toISOString();
  job = { id: `setup-${Date.now()}`, state: steps.length ? "running" : "done", startedAt: now, finishedAt: steps.length ? null : now, steps, error: null };
  if (!steps.length) return { ok: true, job };
  controller = new AbortController();
  void runJob(job, controller.signal, variant, { ...deps, catalog, engineFiles: archives, tools }, env);
  return { ok: true, job };
}

async function runJob(current: SetupJob, signal: AbortSignal, variant: EngineVariant | null, deps: SetupDeps, env: NodeJS.ProcessEnv): Promise<void> {
  const paths = enginePaths(env);
  const downloads = path.join(paths.runtimeDir, "downloads");
  const unpack = deps.unzip ?? ((archive: string, into: string) => unzip(archive, into));
  let changed = false;
  try {
    for (const step of current.steps) {
      if (signal.aborted) throw new SetupCancelled();
      step.state = "downloading";
      if (step.kind === "engine" && variant) {
        const files = (deps.engineFiles ?? engineArchives)[variant];
        let before = 0;
        for (const file of files) {
          const start = before;
          await downloadVerified(file, path.join(downloads, file.name), { fetcher: deps.fetcher, signal, onProgress: (done) => { step.doneBytes = start + done; } });
          before += file.sizeBytes;
        }
        step.state = "unpacking";
        // Unpacked beside the engine folder, then renamed into it, so a half-unpacked
        // engine is never the one the app finds.
        const target = path.join(paths.runtimeDir, "engine", `${engineBuild}${variant === "cpu" ? "" : `-${variant}`}`);
        const staging = `${target}.unpacking`;
        rmSync(staging, { recursive: true, force: true });
        for (const file of files) unpack(path.join(downloads, file.name), staging);
        const program = process.platform === "win32" ? "llama-server.exe" : "llama-server";
        if (!existsSync(path.join(staging, program))) throw new Error(`The engine unpacked, but there is no ${program} in it.`);
        rmSync(target, { recursive: true, force: true });
        renameSync(staging, target);
        for (const file of files) rmSync(path.join(downloads, file.name), { force: true });
      } else if (step.kind === "tool") {
        const tool = catalogueTool(step.id, deps.tools ?? toolCatalogue) as ToolDef;
        const staging = path.join(downloads, `tool-${tool.id}`);
        let before = 0;
        for (const file of tool.missing(env)) {
          const start = before;
          await downloadVerified(file, path.join(staging, file.name), { fetcher: deps.fetcher, signal, onProgress: (done) => { step.doneBytes = start + done; } });
          before += file.sizeBytes;
        }
        step.state = "unpacking";
        tool.place(staging, env, unpack);
        // The check that matters is the app's own: can it find and use what was just put there.
        const usable = tool.usable ? await tool.usable(env) : tool.installed(env);
        if (!usable) throw new Error(`${tool.label} was unpacked, but TRH AI still cannot use it.`);
        rmSync(staging, { recursive: true, force: true });
      } else {
        const model = (deps.catalog ?? modelCatalog).find((entry) => entry.id === step.id) as CatalogModel;
        const staging = path.join(downloads, model.id);
        let before = 0;
        for (const file of model.files) {
          const start = before;
          await downloadVerified(file, path.join(staging, file.name), { fetcher: deps.fetcher, signal, onProgress: (done) => { step.doneBytes = start + done; } });
          before += file.sizeBytes;
        }
        step.state = "verifying";
        mkdirSync(paths.modelsDir, { recursive: true });
        if (model.files.length === 1) {
          const into = path.join(paths.modelsDir, `${model.id}.gguf`);
          rmSync(into, { force: true });
          renameSync(path.join(staging, model.files[0].name), into);
          rmSync(staging, { recursive: true, force: true });
        } else {
          const into = path.join(paths.modelsDir, model.id);
          rmSync(into, { recursive: true, force: true });
          renameSync(staging, into);
        }
      }
      step.doneBytes = step.totalBytes;
      step.state = "done";
      // The engine reads its models when it starts; a voice or ffmpeg is no reason to restart it.
      if (step.kind !== "tool") changed = true;
    }
    current.state = "done";
  } catch (error) {
    const cancelled = error instanceof SetupCancelled || signal.aborted;
    const failing = current.steps.find((step) => !["done", "waiting"].includes(step.state));
    if (failing) {
      failing.state = cancelled ? "cancelled" : "failed";
      failing.error = cancelled ? null : error instanceof Error ? error.message : String(error);
    }
    for (const step of current.steps) if (step.state === "waiting") step.state = "cancelled";
    current.state = cancelled ? "cancelled" : "failed";
    current.error = cancelled ? null : error instanceof Error ? error.message : String(error);
  } finally {
    current.finishedAt = new Date().toISOString();
    if (controller?.signal === signal) controller = null;
    // The engine reads its models when it starts: what was installed is
    // picked up by starting it again. Also after a failure, for whatever did
    // finish before it.
    if (changed) await (deps.restart ?? restartEngine)().catch(() => undefined);
  }
}

export function setupJob(): SetupJob | null {
  return job;
}

/** Stops the running setup. What finished stays; a half-downloaded file is kept to continue from. */
export function cancelSetup(): boolean {
  if (job?.state !== "running" || !controller) return false;
  controller.abort();
  return true;
}

export type RemoveResult = { ok: true } | { ok: false; error: string };

/** Deletes an installed model's file or folder, then restarts the engine without it. */
export async function removeModel(id: string, deps: Pick<SetupDeps, "restart" | "env"> = {}): Promise<RemoveResult> {
  if (job?.state === "running") return { ok: false, error: "Wait for setup to finish first." };
  const paths = enginePaths(deps.env ?? process.env);
  const model = discoverModels(paths.modelsDir).find((entry) => sameModel(entry.id, id));
  if (!model) return { ok: false, error: `${id} is not installed.` };
  // The model's own folder when it has one, else its file - and never
  // anything outside the models folder.
  const parent = path.dirname(model.file);
  const target = path.resolve(parent) === path.resolve(paths.modelsDir) ? model.file : parent;
  const relative = path.relative(path.resolve(paths.modelsDir), path.resolve(target));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return { ok: false, error: "That model is not in the models folder." };
  // The engine holds the file open while the model is loaded, so it is
  // deleted while the engine is stopped, and the engine starts again without it.
  let failure: string | null = null;
  await (deps.restart ?? restartEngine)(() => {
    try {
      rmSync(target, { recursive: true, force: true });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
  }).catch(() => undefined);
  return failure ? { ok: false, error: `${id} could not be removed: ${failure}` } : { ok: true };
}

/** Forget the job, so a test starts clean. */
export function resetSetupForTests(): void {
  controller?.abort();
  controller = null;
  job = null;
  hardwareCache = null;
}
