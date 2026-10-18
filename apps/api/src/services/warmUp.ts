// Has the model engine read the front of the prompt before anyone asks.
//
// On a PC with no graphics card almost all of a first reply's wait is the
// model reading its prompt: on an i5-3570 with 8 GB, 3,751 tokens took the 3B
// 228 s and 3,695 took the 4B 557 s, before a word of the answer. The engine
// keeps what it has read and reuses whatever front the next prompt shares -
// the replies after the first read 46 to 168 new tokens. Every turn's prompt
// starts with the same system message and the same always-offered tools (see
// systemMessageFor and alwaysOfferedTools), so that front is read here, as
// soon as the model can be, and the first question reads only the rest.
//
// It never competes with real work. One runs at a time; any reply the engine
// is asked for stops it (loadEngineModel calls stopWarmUp), and the engine
// keeps what it had read by then. A model is only loaded for it when nothing
// else is loaded, so it never pushes out the model a conversation is using.
// TRHAI_WARM_UP=off switches it off.

import { engineFetch } from "./engineFetch.js";
import { checkAvailability, readLocalModelConfig, type LocalModelConfig } from "./localModel.js";
import { claimWarmUp, listEngineModels, loadEngineModel, releaseWarmUp, sameModel, stopWarmUp } from "./modelEngine.js";
import { alwaysOfferedTools, availableTools } from "./agentTools.js";
import { dateLine, systemMessageFor } from "./agentLoop.js";
import { toWireMessages } from "./engineChat.js";
import { commandsArmed } from "./commandRunner.js";

export type WarmUpState =
  | { state: "idle" }
  | { state: "warming"; model: string; since: string }
  | { state: "warm"; model: string; at: string; promptTokens: number | null; readTokens: number | null; ms: number }
  | { state: "skipped"; reason: string; at: string }
  | { state: "stopped"; reason: string; at: string }
  | { state: "failed"; reason: string; at: string };

let status: WarmUpState = { state: "idle" };
let running: Promise<WarmUpState> | null = null;
// What the engine was last seen to hold: the model, and the front it read.
let held: { model: string; front: string } | null = null;

/** Where the warm-up is, for the System view and the composer. */
export function warmUpStatus(): WarmUpState {
  return status;
}

export function warmUpEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TRHAI_WARM_UP?.trim().toLowerCase() !== "off";
}

/** The request that has the engine read the shared front: the rules, then the tools every turn is offered. */
export function warmUpRequest(model: string, now: Date = new Date()): { body: Record<string, unknown>; front: string } {
  const system = systemMessageFor({ today: dateLine(now) });
  const tools = availableTools(commandsArmed()).filter((definition) =>
    (alwaysOfferedTools as readonly string[]).includes(definition.function.name));
  return {
    // What has to match for the engine's copy to be reused: the model, the
    // system message and the tools, exactly.
    front: JSON.stringify([model, system, tools.map((definition) => definition.function.name)]),
    body: {
      model,
      messages: toWireMessages([{ role: "system", content: system }, { role: "user", content: "Ready?" }]),
      stream: false,
      // One token: reading the prompt is the point, not the answer.
      max_tokens: 1,
      tools
    }
  };
}

/**
 * Warms the model the next ordinary question would use. Resolves when it is
 * read, stopped, skipped or failed; a second call while one runs gets the same.
 */
export function warmUpEngine(options: {
  reason: "start" | "composer";
  config?: LocalModelConfig;
  fetchImpl?: typeof fetch;
  now?: () => Date;
} = { reason: "composer" }): Promise<WarmUpState> {
  if (running) return running;
  running = warm(options).then((result) => {
    status = result;
    return result;
  }).finally(() => {
    running = null;
  });
  return running;
}

async function warm(options: { reason: "start" | "composer"; config?: LocalModelConfig; fetchImpl?: typeof fetch; now?: () => Date }): Promise<WarmUpState> {
  const at = () => new Date().toISOString();
  if (!warmUpEnabled()) return { state: "skipped", reason: "The warm-up is switched off (TRHAI_WARM_UP=off).", at: at() };
  const config = options.config ?? readLocalModelConfig();
  const fetchImpl = options.fetchImpl ?? engineFetch;

  const availability = await checkAvailability(config, fetchImpl);
  if (!availability.available) return { state: "skipped", reason: availability.reason, at: at() };
  const model = availability.model;

  let models;
  try {
    models = await listEngineModels(config.baseUrl, fetchImpl);
  } catch (error) {
    return { state: "skipped", reason: error instanceof Error ? error.message : "The model engine did not answer.", at: at() };
  }
  const loaded = models.filter((entry) => entry.status === "loaded" || entry.status === "loading");
  // Another model is in memory - the coder, the vision model, or one a
  // conversation chose. Loading this one would push it out from under whoever
  // is using it.
  if (loaded.some((entry) => !sameModel(entry.id, model))) {
    return { state: "skipped", reason: "Another model is loaded, and it is left alone.", at: at() };
  }
  const { body, front } = warmUpRequest(model, (options.now ?? (() => new Date()))());
  // Still in memory, with this front read: nothing to do. A model the engine
  // let go when it sat idle shows as unloaded, and is read again.
  if (held && sameModel(held.model, model) && held.front === front && loaded.some((entry) => entry.status === "loaded")) {
    return { state: "warm", model, at: at(), promptTokens: null, readTokens: 0, ms: 0 };
  }

  const controller = new AbortController();
  claimWarmUp(controller);
  status = { state: "warming", model, since: at() };
  const started = Date.now();
  const stopped = (): WarmUpState => ({ state: "stopped", reason: "A request needed the model engine.", at: at() });
  try {
    const ready = await loadEngineModel(config.baseUrl, model, { fetchImpl, signal: controller.signal, timeoutMs: config.timeoutMs, forWarmUp: true });
    if (!ready.ok) return controller.signal.aborted ? stopped() : { state: "failed", reason: ready.reason, at: at() };
    const response = await fetchImpl(`${config.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, model: ready.id }),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(config.timeoutMs)])
    });
    if (!response.ok) {
      return { state: "failed", reason: `The model engine answered ${response.status} to the warm-up.`, at: at() };
    }
    const reply = await response.json().catch(() => ({})) as {
      usage?: { prompt_tokens?: unknown };
      timings?: { prompt_n?: unknown };
    };
    const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
    held = { model, front };
    return {
      state: "warm",
      model,
      at: at(),
      promptTokens: count(reply.usage?.prompt_tokens),
      // How much the engine actually read: less than the prompt when it
      // already held some of it.
      readTokens: count(reply.timings?.prompt_n),
      ms: Date.now() - started
    };
  } catch (error) {
    if (controller.signal.aborted) return stopped();
    return { state: "failed", reason: error instanceof Error ? error.message : String(error), at: at() };
  } finally {
    releaseWarmUp(controller);
  }
}

/** One line for the API's log. */
export function describeWarmUp(result: WarmUpState): string {
  switch (result.state) {
    case "warm":
      return result.ms === 0
        ? `model warm-up: ${result.model} already holds the start of the prompt`
        : `model warm-up: ${result.model} read the start of the prompt`
          + (result.readTokens !== null ? ` (${result.readTokens} tokens)` : "")
          + ` in ${Math.round(result.ms / 1000)} s`;
    case "skipped":
      return `model warm-up skipped: ${result.reason}`;
    case "stopped":
      return "model warm-up stopped: a request needed the model engine";
    case "failed":
      return `model warm-up failed: ${result.reason}`;
    default:
      return `model warm-up: ${result.state}`;
  }
}

/** For tests: forget what the engine was last seen to hold. */
export function resetWarmUpForTests(): void {
  status = { state: "idle" };
  running = null;
  held = null;
  stopWarmUp();
}
