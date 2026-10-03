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
  /**
   * The context window to run the model with, in tokens. Optional so a config
   * built by hand still works; contextWindow() supplies the default.
   */
  contextTokens?: number;
};

/**
 * The context window every request asks for, unless OLLAMA_NUM_CTX says
 * otherwise.
 *
 * Ollama runs a model with a 4,096-token window unless the request names one,
 * and the assistant's own prompt is bigger than that: about 1,400 tokens of
 * instructions and up to 5,000 of tool descriptions, before the question. A
 * prompt that does not fit is not refused. It is cut, silently, keeping only
 * the last half of the window, which is the end of the tool list and the
 * question. Ollama's own log showed it on almost every turn ("truncating input
 * prompt limit=2050 prompt=4443"), so the model answered without the rules,
 * the date, the workspace or most of its tools. It invented a "translate" tool,
 * reached for run_command because it was one of the few tools it could still
 * see, and once echoed the tool-calling template back as its whole reply.
 *
 * 16,384 holds the prompt, a few rounds of tool results and the reply. On a
 * 7B model the larger window costs about 0.7 GB more than the default.
 */
export const defaultContextTokens = 16384;
/**
 * Below this the prompt alone does not fit, so a smaller setting is raised to
 * it: a window that cuts the instructions off is never what was meant.
 */
export const minimumContextTokens = 8192;

export function contextWindow(config: Pick<LocalModelConfig, "contextTokens">): number {
  const requested = config.contextTokens;
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) return defaultContextTokens;
  return Math.max(minimumContextTokens, Math.floor(requested));
}

/**
 * The longest a single reply may be, in tokens: one context window.
 *
 * Without a limit, a model that does not stop is stopped only by the timeout.
 * On 2 October qwen2.5:3b, asked for "a short checklist, eight items, for
 * reviewing a pull request", filled the 16,384-token window after about 12,900
 * tokens of reply, threw half of the window away to keep going ("slot context
 * shift" in Ollama's log), and was still writing - past 13,000 tokens - when
 * the request gave up at 180 s. The task was then recorded as having had no
 * model to run it.
 *
 * Not lower, because the app accepts replies far longer than it usually gets.
 * The longest reply to end on its own in Ollama's log on this PC, across 1,948
 * of them from 12 September to 2 October, was 1,198 tokens, and the largest
 * thing ever asked for in one reply is a whole application (see authorPrompt),
 * which qwen2.5-coder writes in about thirty seconds. But a tool call carries
 * a whole file in its arguments: appAuthor accepts a file of up to 64 KB,
 * which is 17,000 to 22,000 tokens of code by estimateTokens, and write_file
 * up to 500 KB. A cap below the window would cut off a file the app would
 * have written, so the window, not any of those limits, is the bound.
 *
 * Not higher, because a reply as long as the window has pushed everything
 * before it out of the model's view, the instructions and the question
 * included. What it writes after that continues its own text; it is no
 * longer answering anything.
 *
 * Taken from the window rather than fixed, so raising OLLAMA_NUM_CTX for
 * longer work raises this with it. A reply stopped here comes back with
 * done_reason "length" and is reported as one that ran too long (see
 * replyTooLong), never as an answer.
 */
export function replyLimit(config: Pick<LocalModelConfig, "contextTokens">): number {
  return contextWindow(config);
}

/**
 * The options sent with every request to the model.
 *
 * The same on every call, so the model is not reloaded between them: Ollama
 * restarts a model whose window changes, and a different window for the agent
 * and for app authoring would reload it on every switch. The reply limit would
 * not - measured, a request with a different num_predict found the model still
 * loaded, in 3 ms - but it is the same everywhere regardless.
 */
export function modelOptions(config: Pick<LocalModelConfig, "contextTokens">): { num_ctx: number; num_predict: number } {
  return { num_ctx: contextWindow(config), num_predict: replyLimit(config) };
}

/**
 * Why a request was given up on: no reply in the time it was allowed.
 *
 * Not "unavailable", which is what this used to say. The model was installed,
 * loaded and still writing when the time ran out, and "Local model
 * unavailable" sent anyone reading it looking for a model that was there.
 */
export function noReplyWithin(config: Pick<LocalModelConfig, "model" | "timeoutMs">): string {
  return `${config.model} did not reply within ${allowedTime(config)}.`;
}

/**
 * Why a streamed reply was given up on: it had begun, and the model was still
 * writing it when the time ran out.
 *
 * Not noReplyWithin. The reply's first words had been on screen the whole
 * time, and "did not reply" would contradict what the user had just watched.
 */
export function unfinishedWithin(config: Pick<LocalModelConfig, "model" | "timeoutMs">): string {
  return `${config.model} did not finish its reply within ${allowedTime(config)}.`;
}

function allowedTime(config: Pick<LocalModelConfig, "timeoutMs">): string {
  return config.timeoutMs >= 1000 ? `${Math.round(config.timeoutMs / 1000)} s` : `${config.timeoutMs} ms`;
}

/**
 * Why a request was given up on: the turn it was part of was stopped - the
 * user pressed Stop, or their browser went away.
 *
 * Not noReplyWithin. The time had not run out and the model was still
 * working, so "did not reply" would blame the machine for a decision the user
 * made.
 */
export const stoppedBeforeFinishing = "Stopped before it finished.";

/**
 * The signal one request to a model runs under: its own time limit, and the
 * turn's Stop when it has one.
 *
 * Both, not either. Stop has to reach the request at once - a model asked to
 * look at an image or write an app holds the GPU for minutes, and ending only
 * the browser's connection left it running. And a request nobody stops must
 * still give up on its own if the model stalls.
 *
 * Armed until the reply has been read, not just until fetch() resolves: the
 * gap requestDeadline in agentLoop.ts closes for a streamed reply. A time
 * limit that fires rejects with a TimeoutError rather than an AbortError, so a
 * caller that reports it checks for both.
 */
export function deadlineOrStop(ms: number, cancel?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(ms);
  return cancel ? AbortSignal.any([deadline, cancel]) : deadline;
}

/** Why a reply stopped by replyLimit is not used: it ran on and never finished. */
export function replyTooLong(config: Pick<LocalModelConfig, "model" | "contextTokens">): string {
  return `The reply from ${config.model} ran past the length limit `
    + `(${replyLimit(config).toLocaleString("en-US")} tokens) without finishing.`;
}

export function readLocalModelConfig(env: NodeJS.ProcessEnv = process.env): LocalModelConfig {
  return {
    baseUrl: (env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(/\/+$/, ""),
    model: env.OLLAMA_MODEL ?? "vexora:latest",
    modelFromEnv: Boolean(env.OLLAMA_MODEL),
    contextTokens: contextWindow({ contextTokens: env.OLLAMA_NUM_CTX ? Number(env.OLLAMA_NUM_CTX) : undefined }),
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
const preferredModels = [
  "vexora:latest",
  "vexora",
  // Tuned for code and the best tool-caller of these when it is installed.
  "qwen2.5-coder",
  "qwen2.5",
  // Ranked above llama3.2 because it is the 8B and llama3.2 is the 3B. The
  // note above is specifically about preferring the larger model, and this
  // list did not contain llama3.1 at all - so on a machine with 3.1 and 3.2
  // installed it picked the 3B and the reasoning above never took effect.
  //
  // Live consequence, which is what found this: asked to read a file and edit
  // it, llama3.2 invented a "Running command:" line, invented a "Result:"
  // block containing code that was nowhere in the real file, called edit_file
  // once with text that therefore did not match, and reported success.
  "llama3.1",
  "llama3.2"
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
  /**
   * Send this instead of the assistant prompt, verbatim.
   *
   * The default prompt tells the model to answer in a few sentences and not to
   * invent specifics - exactly right for a question, exactly wrong for asking
   * it to write the files of an application. Authoring supplies its own
   * instructions rather than fighting those.
   */
  rawPrompt?: string;
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
  fetchImpl: FetchLike = fetch,
  /**
   * The turn's Stop. App authoring and a long summary run during a turn and
   * can take minutes, so Stop ends this request too - see deadlineOrStop.
   */
  cancel?: AbortSignal
): Promise<GenerationResult> {
  try {
    const response = await fetchImpl(`${config.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Streaming would let the UI show tokens as they arrive, but this API
      // returns one JSON reply per request, so a single response is simpler
      // and the client is not built for a stream yet.
      body: JSON.stringify({
        model: config.model,
        prompt: request.rawPrompt ?? buildPrompt(request),
        stream: false,
        options: modelOptions(config)
      }),
      signal: deadlineOrStop(config.timeoutMs, cancel)
    });

    if (!response.ok) {
      return { ok: false, reason: `Ollama answered ${response.status}.` };
    }

    const payload = await response.json() as { response?: unknown; model?: unknown; done_reason?: unknown };
    // Cut off at replyLimit rather than finished. An answer that stops
    // mid-sentence is not an answer, and for app authoring it is worse: a file
    // cut off mid-line can still pass for a whole one.
    if (payload.done_reason === "length") {
      return { ok: false, reason: replyTooLong(config) };
    }
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
    // Stopped on purpose, not out of time: both end the request, and the
    // caller's own signal says which it was.
    if (cancel?.aborted) return { ok: false, reason: stoppedBeforeFinishing };
    return {
      ok: false,
      reason: error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
        ? noReplyWithin(config)
        : "Local model unavailable: the request failed."
    };
  }
}
