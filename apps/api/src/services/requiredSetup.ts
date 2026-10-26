// Bringing an updated copy up to what its version needs.
//
// An update replaces the program and nothing else. What a version needs
// beside it - the models, the voices, the other tools - would be left for each
// person to find in Settings and tick, which is how one voice of five and a
// model that answers without refusing reached the person who built the app
// and nobody else. So a copy that is already set up is brought up to the
// bundle by the update itself: the same installer as the first-run screen,
// with the same checks, started by the service a little after it opens, its
// progress shown on every screen with a way to stop it and to try again.
//
// What the bundle is - the engine, the recommended model to chat with and the
// one that looks at pictures, and every tool - is `requiredRequest`. A copy
// that has finished one is left alone until the bundle changes
// (`requiredSetupGeneration`): a model or a voice that a person removes
// afterwards stays removed.
//
// Not for a new install, whose first-run screen asks what to install with the
// bundle ticked; and not where TRHAI_REQUIRED_SETUP=off.
//
// What a person's connection and drive allow is theirs: a job that fails, or
// is stopped, is tried again the next time TRH AI opens (up to three times by
// itself), and always from Try again on the banner; a drive without room is
// told so in numbers, and Settings, Engine and models, lets them install less.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { engineRequestsInFlight } from "./engineFetch.js";
import { enginePaths, restartEngine } from "./modelEngine.js";
import {
  canAnswer, planSetup, readHardware, recommendedModel, recommendedVisionModel, setupJob, setupStatus, startSetup,
  type Hardware, type SetupDeps, type SetupJob, type SetupRequest, type SetupStatus
} from "./modelSetup.js";
import { toolCatalogue, type ToolDef } from "./toolCatalog.js";

/**
 * Bumped when the bundle changes, so that a copy which finished an earlier one
 * is brought up to this one. 1 is 0.1.8's: the models with their refusals taken
 * out, and all five voices.
 */
export const requiredSetupGeneration = 1;

/** How many times it starts by itself, one a launch, before it waits to be asked. */
export const maxAutomaticAttempts = 3;

export type RequiredState = "waiting" | "running" | "done" | "failed" | "stopped";

export type RequiredStatus = {
  generation: number;
  /** False where nothing is forced: a new install (its first-run screen asks), a PC that cannot have it, or TRHAI_REQUIRED_SETUP=off. */
  applies: boolean;
  state: RequiredState;
  /** Why the last try did not finish, in a sentence; null otherwise. */
  error: string | null;
  /** How many times it has been started for this generation. */
  attempts: number;
  /** Bytes still to download for the bundle, running or not. */
  remainingBytes: number;
};

type Marker = {
  generation: number;
  state: "running" | "done" | "failed" | "stopped";
  attempts: number;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
};

export type RequiredDeps = Omit<SetupDeps, "onFinish"> & {
  /** Heard when a job this module started ends, after it has written down how. */
  onFinish?: (job: SetupJob) => void;
};

// ---------------------------------------------------------------- the record

function markerPath(env: NodeJS.ProcessEnv): string {
  return path.join(enginePaths(env).runtimeDir, "required-setup.json");
}

/** The record of this generation, or null: none was written, it is of an earlier bundle, or it cannot be read. */
function readMarker(env: NodeJS.ProcessEnv): Marker | null {
  try {
    const parsed = JSON.parse(readFileSync(markerPath(env), "utf8")) as Partial<Marker> | null;
    if (!parsed || parsed.generation !== requiredSetupGeneration) return null;
    if (parsed.state !== "running" && parsed.state !== "done" && parsed.state !== "failed" && parsed.state !== "stopped") return null;
    return {
      generation: requiredSetupGeneration, state: parsed.state,
      attempts: Number.isFinite(parsed.attempts) ? Math.max(0, Math.trunc(parsed.attempts as number)) : 0,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : null,
      finishedAt: typeof parsed.finishedAt === "string" ? parsed.finishedAt : null,
      error: typeof parsed.error === "string" ? parsed.error : null
    };
  } catch {
    return null;
  }
}

/** Written whole and renamed into place, so a record is never half of one. A record that cannot be written costs only a retry. */
function writeMarker(env: NodeJS.ProcessEnv, marker: Marker): void {
  try {
    const file = markerPath(env);
    mkdirSync(path.dirname(file), { recursive: true });
    const staging = `${file}.writing`;
    writeFileSync(staging, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
    renameSync(staging, file);
  } catch { /* the next start looks again */ }
}

// ---------------------------------------------------------------- what is required

/** The bundle, for this PC: its engine, the model to chat with and the one that looks at pictures, and every tool. */
export function requiredRequest(hardware: Hardware, tools: ToolDef[] = toolCatalogue): SetupRequest {
  return {
    engine: true,
    models: [recommendedModel(hardware), recommendedVisionModel(hardware)],
    // The tools are built for Windows; a PC that is not one is asked for none.
    tools: process.platform === "win32" ? tools.map((tool) => tool.id) : []
  };
}

/** The job this module started, so that a job someone else started is not taken for it. */
let activeRun: string | null = null;

export function resetRequiredSetupForTests(): void {
  activeRun = null;
}

type StatusOptions = RequiredDeps & {
  /** Whether the PC cannot answer yet, when the caller already knows. */
  needsSetup?: boolean;
};

export function requiredStatus(options: StatusOptions = {}): RequiredStatus {
  const env = options.env ?? process.env;
  const hardware = options.hardware ?? readHardware();
  const marker = readMarker(env);
  const planned = planSetup(requiredRequest(hardware, options.tools), { ...options, env, hardware });
  const remainingBytes = planned.ok ? planned.plan.steps.reduce((sum, step) => sum + step.totalBytes, 0) : 0;
  const needsSetup = options.needsSetup ?? !canAnswer(env);
  const applies = env.TRHAI_REQUIRED_SETUP !== "off" && !needsSetup && planned.ok;

  const job = setupJob();
  let state: RequiredState;
  if (activeRun !== null && job?.id === activeRun && job.state === "running") state = "running";
  else if (marker?.state === "done" || (planned.ok && remainingBytes === 0)) state = "done";
  else if (marker?.state === "failed") state = "failed";
  else if (marker?.state === "stopped") state = "stopped";
  // Started, and cut short by TRH AI closing, too many times to start by itself again.
  else if (marker && marker.attempts >= maxAutomaticAttempts) state = "stopped";
  else state = "waiting";

  return {
    generation: requiredSetupGeneration,
    applies,
    state,
    error: state === "failed" ? marker?.error ?? null : null,
    attempts: marker?.attempts ?? 0,
    remainingBytes
  };
}

/** The setup status the screens read, with what the update requires beside it. */
export function setupStatusWithRequired(env: NodeJS.ProcessEnv = process.env): SetupStatus & { required: RequiredStatus } {
  const status = setupStatus(env);
  return { ...status, required: requiredStatus({ env, hardware: status.hardware, needsSetup: status.needsSetup }) };
}

// ---------------------------------------------------------------- starting it

export type RequiredStart =
  | { started: true; job: SetupJob }
  | { started: false; reason: "off" | "new-install" | "done" | "busy" | "gave-up" | "refused"; message: string };

/**
 * Restarts the engine, which it has to for the models that were just installed
 * to be there, but not under a reply: a restart ends every open request, and a
 * setup that has run for half an hour in the background should not end the
 * answer someone is reading. Waits for the engine to have nobody asking for a
 * few seconds; if that does not happen in half an hour, leaves it - the engine
 * reads its models whenever TRH AI next opens.
 */
export async function restartWhenIdle(options: {
  quietMs?: number; giveUpMs?: number; pollMs?: number;
  inFlight?: () => number; restart?: () => Promise<unknown>; now?: () => number; sleep?: (ms: number) => Promise<void>;
} = {}): Promise<"restarted" | "left"> {
  const quietMs = options.quietMs ?? 3_000;
  const giveUpMs = options.giveUpMs ?? 30 * 60_000;
  const pollMs = options.pollMs ?? 1_000;
  const inFlight = options.inFlight ?? engineRequestsInFlight;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + giveUpMs;
  let quietSince: number | null = null;
  while (now() < deadline) {
    if (inFlight() === 0) {
      quietSince ??= now();
      if (now() - quietSince >= quietMs) {
        await (options.restart ?? (() => restartEngine()))().catch(() => undefined);
        return "restarted";
      }
    } else {
      quietSince = null;
    }
    await sleep(pollMs);
  }
  return "left";
}

/**
 * Starts bringing this copy up to the bundle. `manual` is a person asking (the
 * banner's button): it ignores how many times it has started by itself. A copy
 * that is not set up yet, or has finished this bundle, is left as it is.
 */
export function startRequiredSetup(options: { manual?: boolean } = {}, deps: RequiredDeps = {}): RequiredStart {
  const env = deps.env ?? process.env;
  if (env.TRHAI_REQUIRED_SETUP === "off") return { started: false, reason: "off", message: "Switched off (TRHAI_REQUIRED_SETUP=off)." };
  if (!canAnswer(env)) return { started: false, reason: "new-install", message: "This PC is not set up yet: the first-run screen offers the install." };
  const hardware = deps.hardware ?? readHardware();
  const marker = readMarker(env);
  if (marker?.state === "done") return { started: false, reason: "done", message: "Everything this version brings is already installed." };
  if (!options.manual && (marker?.attempts ?? 0) >= maxAutomaticAttempts) {
    return { started: false, reason: "gave-up", message: `It has been started ${marker?.attempts} times without finishing; it waits to be asked now (Settings, Engine and models).` };
  }

  const attempts = (marker?.attempts ?? 0) + 1;
  const startedAt = new Date().toISOString();
  const record = (state: Marker["state"], finishedAt: string | null, error: string | null) =>
    writeMarker(env, { generation: requiredSetupGeneration, state, attempts, startedAt, finishedAt, error });

  const started = startSetup(requiredRequest(hardware, deps.tools), {
    ...deps, env, hardware,
    restart: deps.restart ?? (() => restartWhenIdle()),
    onFinish: (job) => {
      record(job.state === "done" ? "done" : job.state === "cancelled" ? "stopped" : "failed", job.finishedAt, job.state === "failed" ? job.error : null);
      deps.onFinish?.(job);
    }
  });
  if (!started.ok) {
    if (/already running/i.test(started.error)) return { started: false, reason: "busy", message: started.error };
    record("failed", new Date().toISOString(), started.error);
    return { started: false, reason: "refused", message: started.error };
  }
  if (started.job.steps.length === 0) {
    record("done", startedAt, null);
    return { started: false, reason: "done", message: "Everything this version brings is already installed." };
  }
  activeRun = started.job.id;
  record("running", null, null);
  return { started: true, job: started.job };
}
