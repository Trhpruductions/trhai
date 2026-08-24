import type { LocalModelConfig } from "./localModel.js";
import { runTool, toolDefinitions, type ToolContext, type ToolCall } from "./agentTools.js";

// The agent loop.
//
// One-shot generation was the ceiling: the model got a question and whatever
// context happened to be attached, and answered in a single pass. It could not
// look something up, and it could not act on what it found.
//
// Here it can ask for a tool, read the real result, and decide what to do next —
// including asking for another. That chaining is where open-ended capability
// actually comes from: two tools that can be combined cover far more ground than
// two tools that cannot.
//
// The honesty rules do not relax because a model is driving. A tool that finds
// nothing reports that it found nothing, and that goes back to the model
// verbatim; the loop never quietly substitutes a better-sounding result. What
// the assistant says afterwards is still labelled as generated.

/** A message in the running exchange, in Ollama's chat shape. */
type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
};

export type AgentResult =
  | {
    ok: true;
    text: string;
    model: string;
    toolsUsed: string[];
    /**
     * A tool the permission gate refused for want of confirmation.
     *
     * Carried out so the caller can record what the user is being asked to
     * approve. Only the last one is kept: the model is told to ask rather
     * than to keep trying, so a turn proposing several destructive actions
     * is not a case worth designing for.
     */
    awaitingConfirmation?: { tool: string; arguments: Record<string, unknown> };
  }
  | {
    ok: false;
    reason: string;
    toolsUsed: string[];
    /**
     * True when this model could not be loaded at all, as opposed to loading
     * and then failing to answer. Ollama reports an out-of-memory or a failed
     * buffer allocation as a 500, and whether a given model fits depends on
     * what else the machine is doing — so the caller can usefully try a
     * smaller one instead of giving up.
     */
    modelUnusable?: boolean;
  };

/**
 * How many times the model may call tools before it has to answer.
 *
 * A loop with no bound is a hang: a model that keeps re-searching rather than
 * concluding would run until the request timed out, and the user would see the
 * app stop responding with no explanation. Four is enough to look something up,
 * follow it with a second lookup, and answer.
 */
export const maxToolRounds = 4;

/**
 * Who the assistant is, and what it is not allowed to do.
 *
 * The identity matters less than the constraints. A tool-using model that
 * cannot admit an empty result is worse than no tools at all — it will report
 * a confident answer built on a search that returned nothing, and the user has
 * no way to tell the difference.
 */
export const systemPrompt = [
  "You are Vexora, an assistant that runs entirely on this user's own machine.",
  "",
  "There are two kinds of question, and they are answered differently.",
  "",
  "Questions about THIS USER - their work, their decisions, their preferences, their",
  "documents, their schedule. You cannot know these. Use a tool:",
  "- search_memory for anything they have told you.",
  "- search_documents, list_documents, read_document for anything written down.",
  "- current_datetime for today, now, or how long ago. You cannot know the date otherwise.",
  "  The date is never in their notes or documents. Do not search for it there;",
  "  searching and finding nothing led to answering \"the current date is not recorded\",",
  "  when the clock was available the whole time.",
  "- calculate for any arithmetic. Do not do sums yourself; you will get them wrong.",
  "- remember, forget, write_document to change what is stored.",
  "- build_app when they want something built. It writes a working app to disk.",
  "  Do not describe what you would build and stop; build it, then say where it is.",
  "- list_files, read_file, write_file for the workspace where those apps live.",
  "- A name with a file extension - test.txt, notes.md, server.js - is a workspace FILE: use",
  "  list_files, read_file, write_file. write_document, update_document, read_document and",
  "  delete_document are only for the knowledge base, titled in plain language with no extension.",
  "  These are two different places; a file is never also a document under the same name.",
  "",
  "Questions about the WORLD - what a semaphore is, how TCP works, what a word means.",
  "Answer these yourself, from what you know. Do not search the user's private notes",
  "for general knowledge: their documents are about their work, and finding nothing",
  "there says nothing at all about whether you know the answer.",
  "",
  "Rules you do not break:",
  "- An empty tool result means the USER has not recorded that. It never means the",
  "  topic is unknowable. If you know the answer generally, give it and say the user",
  "  has nothing saved about it.",
  "- Never claim you saved, found or did something unless a tool result says you did.",
  "- Quote the user's own documents and memories accurately; do not reword them into",
  "  something they did not say. Name the document when you use one.",
  "- If you genuinely do not know, say so. That is a complete answer.",
  "",
  "When a message asks for more than one thing, answer every part of it. Gather what",
  "each part needs, then reply once covering all of them — do not answer the first",
  "and stop.",
  "",
  "Answer in plain prose. Be brief unless detail was asked for."
].join("\n");

/**
 * Tools that change something durable, as opposed to only looking something up.
 *
 * Their result text is forced into the final answer rather than trusted to
 * survive the model's retelling — see the note on mutationResults for why.
 */
const mutatingTools = new Set([
  "remember", "forget", "write_document", "update_document", "delete_document",
  "pin_memory", "write_file", "build_app"
]);

/**
 * Append what a mutating tool actually reported, unless the model's own text
 * already contains it.
 *
 * Deliberately not "smart" about detecting a mismatch — trying to judge
 * whether a paraphrase is faithful is exactly the kind of heuristic that is
 * confidently wrong sometimes, which is the failure mode this exists to
 * close. Always showing the real result costs an occasional repeated
 * sentence when the model already relayed it correctly; that is a small
 * price next to a build reported as something it was not.
 */
export function withMutationResults(text: string, mutationResults: string[]): string {
  // Two calls in one turn can report the identical sentence — the same path
  // written twice in the same round of the same test.txt, say — and showing
  // it twice reads as if two different things happened. Deduplicated here
  // rather than at the call site, so every caller gets the same guarantee.
  const distinct = [...new Set(mutationResults)];
  const missing = distinct.filter((result) => !text.includes(result));
  if (missing.length === 0) return text;

  const body = missing.join("\n\n");
  return text ? `${text}\n\n${body}` : body;
}

/**
 * build_app writes files and runs a one-off smoke test on a random port,
 * then stops — nothing is left listening. Caught live: build_app correctly
 * wrote and verified "Support Desk", 9/9 checks passed, and the model's own
 * sentence on top of that read "The Support Desk is now live at
 * http://localhost:3000" — a port nothing was listening on. build_app's own
 * result text already says how to run it; this only removes the invented
 * claim that it is running already.
 *
 * Scoped to present-tense claims ("is/'s [now] live/up/running ... http://")
 * so a genuine forward-looking "run it and it will be available at ..." is
 * left alone.
 */
export function withoutFabricatedLiveClaims(text: string): string {
  if (!text) return text;
  const falseLiveClaim =
    /\b(?:is|are|'s)\s+(?:now\s+|already\s+)?(?:live|up|running|deployed|accessible|available)\b[^.!?]*https?:\/\//i;
  const kept = text
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !falseLiveClaim.test(sentence));
  return kept.join(" ").trim();
}

/** Ollama's reply to a chat turn. */
type ChatResponse = {
  message?: {
    content?: unknown;
    tool_calls?: Array<{ function?: { name?: unknown; arguments?: unknown } }>;
  };
  model?: unknown;
};

/** The useful sentence out of an error body, without the stack of allocator noise. */
function firstLine(detail: string): string {
  try {
    const parsed = JSON.parse(detail) as { error?: unknown };
    const message = typeof parsed.error === "string" ? parsed.error : detail;
    return message.split("\n")[0].trim().slice(0, 160);
  } catch {
    return detail.split("\n")[0].trim().slice(0, 160);
  }
}

/**
 * Whether a reply is the model's working rather than its answer.
 *
 * True exactly when the text parses as calls this app advertises — the same
 * check that decides whether to run them, so the two can never disagree about
 * what a given reply is. Used to keep that JSON out of the answer even on the
 * final round, where the calls themselves are not acted on.
 */
export function looksLikeRawToolCalls(text: string): boolean {
  return parseTextToolCalls(text).length > 0;
}

/**
 * One line that is nothing but `tool_name(key="value", other=123)` — the
 * other shape a model reaches for instead of the JSON this interface asks
 * for. Caught live: asked to build a calculator, the reply was the single
 * line `build_app(description="...")` and nothing else. That is not JSON, so
 * parseTextToolCalls' JSON branch returned no calls, looksLikeRawToolCalls
 * (defined in terms of it) agreed nothing looked like a call, and the literal
 * text reached the user as their answer instead of ever running.
 *
 * Only recognised when the whole line is the call, the same discipline the
 * JSON branch applies — this reads a request the model made, not a mention of
 * a function's name in the middle of an explanation.
 */
function parseBareCall(line: string, known: string[]): ToolCall | null {
  const match = /^([a-zA-Z_][a-zA-Z0-9_]*)\(([^()]*)\)$/.exec(line.trim());
  if (!match) return null;

  const [, name, argsText] = match;
  if (!known.includes(name)) return null;

  const args: Record<string, unknown> = {};
  const pairs = argsText.match(
    /[a-zA-Z_][a-zA-Z0-9_]*\s*=\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^,]+)/g
  ) ?? [];

  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const key = pair.slice(0, eq).trim();
    const raw = pair.slice(eq + 1).trim();

    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      args[key] = raw.slice(1, -1).replace(/\\(.)/g, "$1");
    } else if (raw === "true") {
      args[key] = true;
    } else if (raw === "false") {
      args[key] = false;
    } else if (raw === "null") {
      args[key] = null;
    } else if (raw !== "" && !Number.isNaN(Number(raw))) {
      args[key] = Number(raw);
    } else {
      args[key] = raw;
    }
  }

  return { name, arguments: args };
}

/**
 * Tool calls a model wrote as text instead of calling.
 *
 * A smaller model sometimes ignores the tool interface and puts the calls it
 * wanted into the message body — as JSON, one object per line:
 *
 *   {"name": "search_memory", "parameters": {"query": "billing"}}
 *   {"name": "current_datetime", "parameters": {}}
 *
 * or as a bare call, see parseBareCall. Both reached the user as their
 * answer before this existed. The first fix was to refuse it, on the grounds
 * that acting on it meant guessing at an intention in a shape this code never
 * agreed to accept. That reasoning was wrong, and refusing it left the only
 * model this machine can actually load unable to use any tool.
 *
 * It is not a guess. The model names a tool this app advertises and passes
 * arguments matching the schema it was given; this is the same request in a
 * different encoding. What makes acting on it safe is not the encoding but the
 * checks that were always there — a name is only accepted if it is one of ours,
 * every tool validates its own arguments, and each reports what it actually
 * did. So it is parsed, and anything that does not name an advertised tool is
 * dropped rather than run.
 */
/** Turn one parsed JSON value into a ToolCall, or null if it does not name an advertised tool. */
function toToolCall(entry: unknown, known: string[]): ToolCall | null {
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;

  const name = typeof record.name === "string"
    ? record.name
    : typeof record.function === "string" ? record.function : null;

  // The gate. An unrecognised name is dropped, never invoked: this is the
  // check that makes reading the model's prose safe, not the shape it
  // happened to be written in.
  if (!name || !known.includes(name)) return null;

  const rawArguments = record.parameters ?? record.arguments ?? {};
  return {
    name,
    arguments: rawArguments && typeof rawArguments === "object"
      ? rawArguments as Record<string, unknown>
      : {}
  };
}

/**
 * The exact shapes seen from a model that mostly cooperates: the whole
 * message is one JSON object, a JSON array of calls, or one object per line.
 * Unchanged from the original parser — a model that gets this far into
 * parseTextToolCalls without this succeeding falls through to the wider scan
 * below, but this stays first because it is what "one malformed line does not
 * discard the rest" depends on: recovery per line, not per balanced brace.
 */
function parseDirectJson(trimmed: string, known: string[]): ToolCall[] {
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return [];

  const objects: unknown[] = [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) objects.push(...parsed);
    else objects.push(parsed);
  } catch {
    for (const line of trimmed.split("\n")) {
      const candidate = line.trim();
      if (!candidate.startsWith("{")) continue;
      try {
        objects.push(JSON.parse(candidate));
      } catch {
        // One malformed line does not discard the rest.
      }
    }
  }

  return objects.map((entry) => toToolCall(entry, known)).filter((call): call is ToolCall => call !== null);
}

/**
 * The first balanced {...} substring starting at or after `from`, respecting
 * quoted strings so a brace inside a write_file call's own content — source
 * code, say — cannot throw off the count. Retries past a span that balances
 * but does not parse (a stray brace in plain prose) rather than giving up on
 * the rest of the message. Returns null once nothing more closes.
 */
function nextJsonObject(text: string, from: number): { value: unknown; end: number } | null {
  const start = text.indexOf("{", from);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return { value: JSON.parse(text.slice(start, i + 1)), end: i + 1 };
        } catch {
          return nextJsonObject(text, start + 1);
        }
      }
    }
  }
  return null;
}

/** Every JSON object found anywhere in the text, in the order they appear. */
function extractJsonObjects(text: string): unknown[] {
  const found: unknown[] = [];
  let cursor = 0;
  for (;;) {
    const next = nextJsonObject(text, cursor);
    if (!next) break;
    found.push(next.value);
    cursor = next.end;
  }
  return found;
}

export function parseTextToolCalls(text: string, known = advertisedToolNames()): ToolCall[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const direct = parseDirectJson(trimmed, known);
  if (direct.length > 0) return direct;

  // A call the model wrote inside a sentence, or fenced in ```json, rather
  // than as the entire message. Caught live: asked to write test.txt, the
  // reply was "Sure, I'll write that:" followed by the correct JSON call and
  // then more prose — valid JSON, but not as the whole trimmed message and
  // not as a whole line either, so parseDirectJson found nothing and the
  // literal JSON reached the user as their answer instead of ever running.
  // This scans the whole message for a balanced {...} wherever it sits,
  // rather than trusting message or line boundaries.
  const embedded = extractJsonObjects(trimmed)
    .map((entry) => toToolCall(entry, known))
    .filter((call): call is ToolCall => call !== null);
  if (embedded.length > 0) return embedded;

  return trimmed.split("\n")
    .map((line) => parseBareCall(line, known))
    .filter((call): call is ToolCall => call !== null);
}

/** The tools this app offers, by name. */
function advertisedToolNames(): string[] {
  return toolDefinitions.map((definition) => definition.function.name);
}

function parseToolCalls(response: ChatResponse): ToolCall[] {
  const calls = response.message?.tool_calls;
  if (!Array.isArray(calls)) return [];

  return calls.flatMap((call) => {
    const name = call.function?.name;
    if (typeof name !== "string" || !name) return [];

    // Ollama sends an object; some builds send a JSON string. Both appear in
    // the wild, and a thrown parse error here would lose the whole reply.
    const raw = call.function?.arguments;
    let parsed: Record<string, unknown> = {};
    if (raw && typeof raw === "object") {
      parsed = raw as Record<string, unknown>;
    } else if (typeof raw === "string") {
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        parsed = {};
      }
    }

    return [{ name, arguments: parsed }];
  });
}

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
 * Answer a question, using tools as needed.
 *
 * Returns `ok: false` when there is no usable answer — a caller must not treat
 * that as an empty string and show the user a blank reply.
 */
export async function runAgent(
  config: LocalModelConfig,
  question: string,
  context: ToolContext,
  fetchImpl: typeof fetch = fetch,
  /** Fired right before each tool call, so a caller can report live progress. */
  onToolStart?: (toolName: string) => void
): Promise<AgentResult> {
  // The date is stated outright rather than left to a tool call.
  //
  // current_datetime exists and works, and the prompt tells the model to use
  // it — and asked "which database, and what is today's date?" it called
  // search_memory alone and answered "the current date is not recorded". A
  // model cannot fail to call a tool it does not need, and this costs one line
  // of prompt against a whole class of failure. It is still measured, from the
  // same clock the tool reads.
  const now = (context.now ?? (() => new Date()))();
  const today = now.toLocaleString(undefined, {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "2-digit", minute: "2-digit"
  });

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: `${systemPrompt}\n\nThe date and time on this machine right now is ${today}. `
        + "That is current and correct — use it directly and never say the date is unknown or unrecorded."
    },
    { role: "user", content: question }
  ];

  const toolsUsed: string[] = [];
  let awaitingConfirmation: { tool: string; arguments: Record<string, unknown> } | undefined;

  // Results from tools that changed something, kept so they can survive into
  // the final answer verbatim.
  //
  // Found live: asked to build a support-ticket tracker, build_app wrote a
  // real project and verified it — "9/9 checks passed" — and the model's
  // final answer described entirely different files that were never written
  // (db.js, app.js, ticket-form.js) and never mentioned the verification at
  // all. The build was correct; the report of it was invented. A model that
  // narrates instead of relaying cannot be fixed by asking it more firmly, so
  // the real result is now appended after whatever the model says, rather
  // than trusted to survive its retelling.
  const mutationResults: string[] = [];

  for (let round = 0; round <= maxToolRounds; round += 1) {
    // On the last round the tools are withheld, which forces an answer rather
    // than a fifth request for a search the model is not going to conclude on.
    const offerTools = round < maxToolRounds;

    let response: ChatResponse;
    try {
      const raw = await withTimeout(config.timeoutMs, (signal) =>
        fetchImpl(`${config.baseUrl}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: config.model,
            messages,
            stream: false,
            ...(offerTools ? { tools: toolDefinitions } : {})
          }),
          signal
        }));

      if (!raw.ok) {
        // The body carries why. "cudaMalloc failed: out of memory" and a
        // failed CPU buffer allocation both mean this model will not run here
        // however many times it is asked — a different model might.
        const detail = await raw.text().catch(() => "");
        const unusable = raw.status >= 500
          && /out of memory|failed to allocate|terminated|no space/i.test(detail);

        return {
          ok: false,
          reason: unusable
            ? `${config.model} could not be loaded: ${firstLine(detail)}`
            : `The local model answered ${raw.status}.`,
          toolsUsed,
          modelUnusable: unusable
        };
      }

      response = await raw.json() as ChatResponse;
    } catch (error) {
      const detail = error instanceof Error && error.name === "AbortError"
        ? `it did not reply within ${Math.round(config.timeoutMs / 1000)}s`
        : "the request failed";
      return { ok: false, reason: `Local model unavailable: ${detail}.`, toolsUsed };
    }

    // Tool calls are not honoured on the final round. A model can return them
    // even when none were offered, and acting on that would run one more round
    // than the bound allows — the bound has to hold whatever the model does.
    const rawText = typeof response.message?.content === "string"
      ? response.message.content.trim()
      : "";

    // Tool-call JSON is never shown as an answer, whether or not it was
    // understood: it is the model's working, not its reply.
    const text = parseTextToolCalls(rawText).length > 0 ? "" : rawText;

    // Both encodings. A model that used the interface and a model that wrote
    // the same calls into its prose are asking for the same thing, and after
    // the name check there is no reason to treat them differently.
    const requested = parseToolCalls(response);
    const written = requested.length === 0 && rawText ? parseTextToolCalls(rawText) : [];
    const calls = offerTools ? [...requested, ...written] : [];

    if (calls.length === 0) {
      if (!text) {
        // Two different failures, and they must not be confused. A model that
        // is still asking for tools on the final round has not gone quiet — it
        // has failed to conclude, and saying "empty reply" would send whoever
        // reads this looking at the wrong thing.
        return requested.length > 0
          ? { ok: false, reason: "The assistant kept searching without reaching an answer.", toolsUsed }
          : { ok: false, reason: "The local model returned an empty reply.", toolsUsed };
      }
      const cleanedText = toolsUsed.includes("build_app") ? withoutFabricatedLiveClaims(text) : text;
      return {
        ok: true,
        text: withMutationResults(cleanedText, mutationResults),
        model: typeof response.model === "string" ? response.model : config.model,
        toolsUsed,
        ...(awaitingConfirmation ? { awaitingConfirmation } : {})
      };
    }

    // Carry the model's own turn forward before the results, or the exchange
    // stops making sense to it on the next pass.
    messages.push({
      role: "assistant",
      content: text,
      tool_calls: calls.map((call) => ({ function: { name: call.name, arguments: call.arguments } }))
    });

    for (const call of calls) {
      onToolStart?.(call.name);

      // Awaited in sequence rather than run in parallel. Two calls in one
      // round are rare, and running them concurrently would let a build and a
      // write race for the same workspace file with no ordering guarantee.
      const result = await runTool(call, context);

      // Refused for permission, not failed. Recorded so the caller can hold
      // the offer open for a "yes"; the model still sees the refusal text and
      // is told to ask rather than to route around it.
      //
      // Deliberately not counted as a tool used. toolsUsed drives a label
      // saying what the assistant *did*, and a refused call did nothing — it
      // was rendering "deleted from memory" under a reply that had deleted
      // nothing. That a confirmation is outstanding is carried by
      // awaitingConfirmation instead, which is the honest place for it.
      if (result.needsConfirmation) {
        awaitingConfirmation = { tool: call.name, arguments: call.arguments };
      } else {
        toolsUsed.push(call.name);
      }
      // The failure text goes back unchanged. "Nothing matches X" is what stops
      // the model inventing an answer; softening it here would undo that.
      messages.push({ role: "tool", content: result.content });

      // A refusal is not a mutation result. Appending it printed an
      // instruction written for the model — "Tell the user plainly what it
      // would do and ask them to confirm" — verbatim underneath the reply,
      // where the user read internal plumbing addressed to someone else.
      if (mutatingTools.has(call.name) && !result.needsConfirmation) {
        mutationResults.push(result.content);
      }
    }
  }

  return { ok: false, reason: "The assistant kept searching without reaching an answer.", toolsUsed };
}
