// Optional local model backend (Ollama).
//
// Everything else in this API is deterministic, and that was a hard ceiling:
// the assistant could only ever repeat what someone had told it or quote a
// document. This lets it answer a question it was never given the answer to —
// without a third-party API key, a cost, or anything leaving the machine.
//
// Three rules keep it from undoing the honesty the rest of the code is built on.
//
// Grounding stays first. If saved memory or a knowledge document answers the
// question, that answer is used, quoted exactly and attributed. The model is
// only consulted where the deterministic path would otherwise say it has
// nothing — so a model can add answers but can never overwrite a sourced one.
//
// A generated answer is labelled generated. It is not a quote and must never be
// presented as one; the caller reports a different strategy and model name so
// provenance stays truthful.
//
// Absence is normal, not an error. No Ollama means today's behaviour exactly,
// with the capability reply saying so plainly rather than the app looking broken.

export type LocalModelConfig = {
  /** Where the Ollama server is listening. */
  baseUrl: string;
  /** Which pulled model to ask. */
  model: string;
  /**
   * Whether `model` came from OLLAMA_MODEL or is just the built-in default.
   *
   * Without this the two are indistinguishable, and the preference list below
   * never runs: the default is itself an installed model, so it always looked
   * like a deliberate choice and a better model sitting alongside it was never
   * picked up.
   */
  modelFromEnv: boolean;
  /** How long to wait before giving up on a reply. */
  timeoutMs: number;
};

export function readLocalModelConfig(env: NodeJS.ProcessEnv = process.env): LocalModelConfig {
  return {
    baseUrl: (env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(/\/+$/, ""),
    model: env.OLLAMA_MODEL ?? "llama3.2",
    modelFromEnv: Boolean(env.OLLAMA_MODEL),
    // Local inference on CPU is slow, and the first request after a launch is
    // slower still: the model has to be read into memory before it can answer
    // anything, which for an 8B model is several gigabytes off disk.
    //
    // This was 45s, and that is comfortably enough once the model is warm and
    // not enough for the cold start. The first question asked after opening the
    // app was abandoned mid-load and fell back to "I don't have anything saved
    // that answers that" — which reads as the feature being broken rather than
    // as it still starting up. Measured: the same question failed on the first
    // ask and answered in about a second on the second.
    timeoutMs: Number(env.OLLAMA_TIMEOUT_MS ?? 180000)
  };
}

export type ModelAvailability =
  | { available: true; model: string; installedModels: string[] }
  | { available: false; reason: string };

type FetchLike = typeof fetch;

async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask the server what it has.
 *
 * Distinguishes "no server" from "server but the model is not pulled", because
 * the two need different things from the user and a single "unavailable" would
 * send them looking in the wrong place.
 */
/**
 * Models this app prefers, best first.
 *
 * The tools raised the ceiling on what the assistant can do, and the model
 * became the limit instead: a 3B model picks tools well on a direct request
 * but answers from its own knowledge on a vague one, when it should have
 * reached for a lookup. A larger model follows the tool instructions more
 * reliably, so if one is installed it should be used.
 *
 * Only consulted when the configured model is not itself installed, so an
 * explicit OLLAMA_MODEL always wins — this picks a good default, it does not
 * overrule a choice.
 */
export const preferredModels = [
  "llama3.1:8b",
  "llama3.1",
  "llama3.2",
  "mistral",
  "qwen2.5"
];

/**
 * Which installed model to use.
 *
 * The configured one if it is there, otherwise the best from the preference
 * list, otherwise whatever is installed — an assistant with some model is more
 * use than one that refuses because it did not find its first choice.
 */
/**
 * Every installed model worth trying, best first.
 *
 * A model that is listed is not necessarily a model that will load: asked to
 * run, Ollama can answer 500 with "cudaMalloc failed: out of memory" or a
 * failed CPU buffer allocation, and which models fit depends on what else the
 * machine is doing at that moment. So the caller gets an order to work down
 * rather than a single answer to fail on.
 */
export function orderedCandidates(
  configured: string,
  installed: string[],
  fromEnv = true
): string[] {
  const matches = (candidate: string, name: string) =>
    name === candidate || name.split(":")[0] === candidate;

  const ordered: string[] = [];
  const take = (name: string | undefined) => {
    if (name && !ordered.includes(name)) ordered.push(name);
  };

  // A model the user actually named goes first, always.
  if (fromEnv) take(installed.find((name) => matches(configured, name)));

  for (const preference of preferredModels) {
    take(installed.find((name) => matches(preference, name)));
  }

  // Then anything else installed: a model nobody ranked still beats no answer.
  for (const name of installed) take(name);

  return ordered;
}

export function pickModel(
  configured: string,
  installed: string[],
  /** False when `configured` is the built-in default rather than a real choice. */
  fromEnv = true
): string | null {
  const matches = (candidate: string, name: string) =>
    name === candidate || name.split(":")[0] === candidate;

  // Only a model the user actually named short-circuits the preference list.
  if (fromEnv) {
    const exact = installed.find((name) => matches(configured, name));
    if (exact) return exact;
  }

  for (const preference of preferredModels) {
    const found = installed.find((name) => matches(preference, name));
    if (found) return found;
  }

  return installed[0] ?? null;
}

export async function checkAvailability(
  config: LocalModelConfig,
  fetchImpl: FetchLike = fetch
): Promise<ModelAvailability> {
  try {
    const response = await withTimeout(Math.min(config.timeoutMs, 4000), (signal) =>
      fetchImpl(`${config.baseUrl}/api/tags`, { signal }));

    if (!response.ok) {
      return { available: false, reason: `Ollama answered ${response.status} at ${config.baseUrl}.` };
    }

    const payload = await response.json() as { models?: Array<{ name?: string }> };
    const installed = (payload.models ?? [])
      .map((entry) => entry.name)
      .filter((name): name is string => typeof name === "string");

    // Ollama reports "llama3.2:latest" for a model pulled as "llama3.2".
    const match = pickModel(config.model, installed, config.modelFromEnv ?? true);
    if (!match) {
      return {
        available: false,
        reason: installed.length === 0
          ? `Ollama is running at ${config.baseUrl} but has no models pulled. Run: ollama pull ${config.model}`
          : `Ollama is running but "${config.model}" is not pulled. Available: ${installed.join(", ")}`
      };
    }

    return { available: true, model: match, installedModels: installed };
  } catch (error) {
    const detail = error instanceof Error && error.name === "AbortError"
      ? "it did not respond in time"
      : "nothing is listening";
    return { available: false, reason: `No local model: ${detail} at ${config.baseUrl}.` };
  }
}

export type GenerationRequest = {
  question: string;
  /** Facts already known, offered as context. May be empty. */
  context: string[];
};

export type GenerationResult =
  | { ok: true; text: string; model: string }
  | { ok: false; reason: string };

/**
 * The instruction given to the model.
 *
 * It is told to say when it does not know. A local model will confabulate
 * happily, and the rest of this app is careful never to present a guess as a
 * fact — an answer that invents a policy the user never wrote would undo that
 * in one turn.
 */
export function buildPrompt(request: GenerationRequest): string {
  const parts = [
    "You are a concise assistant running locally on the user's machine.",
    "Answer in a few sentences. If you do not know, say so plainly rather than guessing.",
    "Do not invent specifics about the user, their files, or their organisation."
  ];

  if (request.context.length > 0) {
    parts.push(
      "",
      "Things the user has told you previously:",
      ...request.context.map((entry) => `- ${entry}`),
      "",
      "Use those only if they are relevant to the question."
    );
  }

  parts.push("", `Question: ${request.question}`);
  return parts.join("\n");
}

export async function generate(
  config: LocalModelConfig,
  request: GenerationRequest,
  fetchImpl: FetchLike = fetch
): Promise<GenerationResult> {
  try {
    const response = await withTimeout(config.timeoutMs, (signal) =>
      fetchImpl(`${config.baseUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Streaming would let the UI show tokens as they arrive, but this API
        // returns one JSON reply per request, so a single response is simpler
        // and the client is not built for a stream yet.
        body: JSON.stringify({ model: config.model, prompt: buildPrompt(request), stream: false }),
        signal
      }));

    if (!response.ok) {
      return { ok: false, reason: `Ollama answered ${response.status}.` };
    }

    const payload = await response.json() as { response?: unknown; model?: unknown };
    const text = typeof payload.response === "string" ? payload.response.trim() : "";
    if (!text) {
      return { ok: false, reason: "The local model returned an empty reply." };
    }

    return {
      ok: true,
      text,
      model: typeof payload.model === "string" ? payload.model : config.model
    };
  } catch (error) {
    const detail = error instanceof Error && error.name === "AbortError"
      ? `it did not reply within ${Math.round(config.timeoutMs / 1000)}s`
      : "the request failed";
    return { ok: false, reason: `Local model unavailable: ${detail}.` };
  }
}
