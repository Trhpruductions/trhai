import type { LocalModelConfig } from "./localModel.js";
import { availableTools, runTool, type ToolContext, type ToolCall } from "./agentTools.js";
import { commandsArmed } from "./commandRunner.js";
import { readStream, toLines } from "./streamReader.js";
import { enterStage, stageForTool } from "./reasoningStage.js";
import { beginEvent, endEvent, type ExecutionKind } from "./executionLog.js";
import { stripFabricatedToolOutput } from "./fabricatedOutput.js";
import {
  answerDirectly, claimsUnperformedMutation, claimsUnusedTool, contradictsToolRecord,
  correctionFor, noChangeWasMade, pendingConfirmationNotice, promisesUnperformedMutation
} from "./contradictedClaims.js";
import {
  classifyIntent, clarificationFor, isExplanatoryQuestion, type ActionKind
} from "./actionIntent.js";
import { createToolActivity, type ToolActivity } from "./toolActivity.js";
import { changesSomething } from "./toolPermissions.js";
import { describeWorkspace, summariseWorkspace } from "./projectContext.js";
import { activeProject } from "./activeProject.js";

// Re-exported so nothing that already imports it from here has to move.
export type { ToolActivity };
import { increment, observe } from "./metrics.js";

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

/**
 * One tool call and whether it actually achieved anything.
 *
 * The name alone was never enough. The interface labels a turn from this, and
 * a label built from a name can only assert an intention — it rendered
 * "deleted from memory" for a forget that matched nothing and deleted
 * nothing. `ok` is the tool's own report of what happened, so the label can
 * describe the outcome instead of the attempt.
 */
export type ToolOutcome = { name: string; ok: boolean };

/**
 * What the loop decided about this turn, recorded rather than inferred.
 *
 * Exists so the enforcement below can be inspected after the fact: whether the
 * request was read as an order, how many tools the model actually asked for on
 * its first pass, and whether it had to be told to try again. Without this the
 * only evidence of a forced retry is that the turn took twice as long.
 */
export type ActionAudit = {
  kind: ActionKind | "none";
  actionIntent: boolean;
  /** What happened to tools this turn. See ToolActivity. */
  toolActivity: ToolActivity;
  /** Tool calls the model asked for on its first turn, before any prompting. */
  firstTurnToolCalls: number;
  forcedRetry: boolean;
  outcome: "tool-called" | "clarified" | "no-tool-failure" | "prose";
};

export type AgentResult =
  | {
    ok: true;
    text: string;
    model: string;
    toolsUsed: ToolOutcome[];
    /**
     * A tool the permission gate refused for want of confirmation.
     *
     * Carried out so the caller can record what the user is being asked to
     * approve. Only the last one is kept: the model is told to ask rather
     * than to keep trying, so a turn proposing several destructive actions
     * is not a case worth designing for.
     */
    awaitingConfirmation?: { tool: string; arguments: Record<string, unknown> };
    /** See ActionAudit. Present on every result, success or failure. */
    actionAudit?: ActionAudit;
  }
  | {
    ok: false;
    reason: string;
    toolsUsed: ToolOutcome[];
    /**
     * True when this model could not be loaded at all, as opposed to loading
     * and then failing to answer. Ollama reports an out-of-memory or a failed
     * buffer allocation as a 500, and whether a given model fits depends on
     * what else the machine is doing — so the caller can usefully try a
     * smaller one instead of giving up.
     */
    modelUnusable?: boolean;
    /**
     * True when the user stopped this turn, rather than it failing.
     *
     * Kept distinct because the difference matters to what is shown: a
     * cancellation is a decision someone made, and reporting it as "the local
     * model did not reply" would blame the machine for it.
     */
    stopped?: boolean;
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
 * How many times the exact same call — same tool, same arguments — may
 * actually run before the loop refuses to repeat it.
 *
 * Two is enough for a genuine retry: the first attempt at search_memory came
 * back empty and a rephrased second attempt is a reasonable thing to try.
 * A third identical attempt is not a retry, it is the failure this exists to
 * stop — the model re-running a call that already told it "no results"
 * unchanged, hoping for a different answer from the same question. Caught
 * live: asked a capability question with nothing to search for, the model
 * called search_memory, search_documents and list_documents, got told
 * exactly why each one had nothing to offer, and kept calling them anyway —
 * sixteen calls in total, three of them writes, before the round limit above
 * finally cut it off. This is the earlier, cheaper stop.
 */
const maxIdenticalAttempts = 2;

/**
 * A key that is the same for two calls that mean the same thing regardless
 * of argument order, so `{query:"x", limit:5}` and `{limit:5, query:"x"}`
 * collapse to one signature rather than being counted as different calls.
 */
function callSignature(call: ToolCall): string {
  const sortedArguments = Object.fromEntries(
    Object.entries(call.arguments).sort(([left], [right]) => left.localeCompare(right))
  );
  return `${call.name}:${JSON.stringify(sortedArguments)}`;
}

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
  "- run_command runs a real command on this machine and returns its real output. It only",
  "  appears when the user has switched command access on. Use it for anything outside the",
  "  workspace: installing, building, running tests, opening an app, inspecting the system.",
  "  Say what you are about to run. A non-zero exit code means it FAILED - report that, do",
  "  not describe a failed command as done.",
  "- A name with a file extension - test.txt, notes.md, server.js - is a workspace FILE: use",
  "  list_files, read_file, write_file. write_document, update_document, read_document and",
  "  delete_document are only for the knowledge base, titled in plain language with no extension.",
  "  These are two different places; a file is never also a document under the same name.",
  "",
  "A page on the live web - something the user linked you to, or asked about that needs",
  "today's version of a page rather than what you already know:",
  "- fetch_url reads exactly the one address you give it and returns its text.",
  "- It is not a search engine. There is no tool that finds a URL for you - fetch_url only",
  "  works when you already have one, from the user's own message or an earlier tool result.",
  "  Never invent a URL to try; a guessed address is not a real lookup.",
  "- If nothing in the conversation gives you a URL, you do not have a way to look this up.",
  "  Say so plainly rather than answering from general knowledge as if it were current, or",
  "  refusing the way an empty search result would.",
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
  "- A tool refused or failing is not an invitation to try something unrelated instead.",
  "  Caught live: fetch_url was refused for reaching an address on the user's own machine,",
  "  and the reply built and wrote an entirely unrelated app nobody asked for, as though",
  "  refusing one thing meant doing a different, unrequested thing instead. Explain the",
  "  refusal in plain words and stop there. Only continue toward a different tool when the",
  "  user's own message actually asked for more than the one thing that was refused.",
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
 * Tools that write their own execution events.
 *
 * build_app records a plan, a write and a verify step; run_command records the
 * command and its output. Both say more than a single generic row would, so
 * the loop stays out of their way rather than logging a second, vaguer entry
 * beside each one.
 */
const selfLoggingTools = new Set(["build_app", "run_command"]);

/** Which kind of work a tool represents, for the activity list's dot colour. */
export function executionKindForTool(tool: string): ExecutionKind {
  if (tool === "write_file" || tool === "write_document" || tool === "update_document") return "write";
  if (tool === "plan_app") return "plan";
  if (tool === "test") return "test";
  // Everything else is the assistant looking something up — a file, a memory,
  // a document, a page. "read" is the honest general case.
  return "read";
}

/**
 * One line describing a call, for the activity list.
 *
 * Names the tool and its most identifying argument, both taken from the call
 * that is actually about to run. No argument is invented when a call has none:
 * "Listed files" is the whole truth about `list_files()`.
 */
export function describeToolCall(call: ToolCall): string {
  const words = call.name.replace(/_/g, " ");
  const readable = words.charAt(0).toUpperCase() + words.slice(1);

  const args = call.arguments;
  if (!args || typeof args !== "object") return readable;

  // The first argument that names a thing. Ordered by how specific it is, so
  // a call carrying both a path and a query is described by its path.
  for (const key of ["path", "file", "title", "query", "url", "name", "command", "fact"]) {
    const value = (args as Record<string, unknown>)[key];
    if (typeof value !== "string" || !value.trim()) continue;
    const trimmed = value.trim();
    // Truncated because this is one line in a narrow panel, and a 2 kB
    // document body pasted into the label helps nobody.
    return `${readable}: ${trimmed.length > 60 ? `${trimmed.slice(0, 57)}…` : trimmed}`;
  }

  return readable;
}

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

/** The tools this app offers right now, by name. */
function advertisedToolNames(): string[] {
  return availableTools(commandsArmed()).map((definition) => definition.function.name);
}

/** Every tool this app has, including any currently switched off. */
function allToolNames(): string[] {
  return availableTools(true).map((definition) => definition.function.name);
}

/**
 * A call the model wrote for a tool that exists but is switched off.
 *
 * These fall through every other check. The parser only recognises tools that
 * are currently advertised, so a `run_command` call written while machine
 * control is off is not a call at all as far as this loop is concerned — it is
 * just text, and it went to the user as their answer. Asking TRHAI to run
 * something with the switch off replied with the literal line
 * `{"name": "run_command", "arguments": {"command": "echo hello"}}`, which is
 * internal plumbing presented as an answer.
 *
 * Parsing against the full set is what makes the difference visible: the model
 * asked for something real, and the honest reply is why it did not happen.
 */
export function gatedToolCall(text: string): ToolCall | null {
  const advertised = new Set(advertisedToolNames());
  const calls = parseTextToolCalls(text, allToolNames());
  return calls.find((call) => !advertised.has(call.name)) ?? null;
}

/** What to say instead of showing the user a tool call they cannot read. */
export function explainGatedTool(call: ToolCall): string {
  if (call.name === "run_command") {
    const command = typeof call.arguments?.command === "string" ? call.arguments.command.trim() : "";
    // Both halves of this sentence used to be wrong, which is the third time
    // this codebase has sent someone to a screen that no longer exists - after
    // the "Memory panel" and the offer to add a task from a deleted Tasks page.
    // There is no dashboard any more; machine control lives in the ACTIVITY
    // rail, behind the handle on the right edge. And access has not lapsed
    // after thirty minutes since it stopped being a timed grant: it stays as
    // you leave it, in both directions.
    return "Machine control is switched off, so nothing was run."
      + (command ? ` What I would have run is \`${command}\`.` : "")
      + " Open the ACTIVITY rail on the right to switch it back on; it stays on until you turn it off.";
  }

  const readable = call.name.replace(/_/g, " ");
  return `That needs ${readable}, which is not switched on right now, so nothing was done.`;
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

async function withTimeout<T>(
  ms: number,
  run: (signal: AbortSignal) => Promise<T>,
  /**
   * A caller's own reason to stop — the user pressing Stop, or their browser
   * going away mid-request.
   *
   * Combined with the timeout rather than replacing it: a request must still
   * give up on its own if the model stalls, whether or not anyone is watching.
   */
  external?: AbortSignal
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);

  // Already gone before we started. Firing immediately beats opening a request
  // that nothing is waiting for.
  if (external?.aborted) controller.abort();
  const relay = () => controller.abort();
  external?.addEventListener("abort", relay);

  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
    external?.removeEventListener("abort", relay);
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
  onToolStart?: (toolName: string) => void,
  /**
   * Fired with each new piece of the reply as it is generated.
   *
   * Opt-in: without it the request is made exactly as before, unstreamed, so
   * nothing that already works changes shape. A local model can take half a
   * minute to answer, and watching nothing happen for that long is the worst
   * part of using one — but it is not worth destabilising the loop for, so
   * the streaming path is only taken when a caller actually wants it.
   *
   * Only prose arrives here. streamReader withholds anything that might be a
   * text-encoded tool call, which this model does emit.
   */
  onToken?: (text: string) => void,
  /**
   * True when this turn runs with nobody watching — a schedule firing in the
   * background rather than someone sitting at the machine.
   *
   * Command access is withheld whatever the arming window says. Switching
   * machine control on is a grant for working at the machine; a scheduled run
   * must not inherit it merely because the thirty-minute window happens to
   * still be open when the timer fires.
   */
  unattended?: boolean,
  cancel?: AbortSignal
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
        // Where the work actually lives. Without this the model invents paths:
        // it called list_files on D:/projects/calculator, which has never
        // existed on this machine, then asked the user for a full path to a
        // project it could have found by name. See projectContext.ts.
        + `\n\n${describeWorkspace(summariseWorkspace(), activeProject(context.sessionId))}`
    },
    { role: "user", content: question }
  ];

  const toolsUsed: ToolOutcome[] = [];
  let awaitingConfirmation: { tool: string; arguments: Record<string, unknown> } | undefined;

  // Whether this turn was an order or a question, decided before generating.
  //
  // Deterministic, so it can be regression-tested. Asking a model to classify
  // the request would put the same unreliability that causes the bug in charge
  // of detecting it.
  const intent = classifyIntent(question);
  let forcedRetry = false;
  let correctedContradiction = false;
  let correctedMutationClaim = false;
  let correctedToolCredit = false;

  // Fixed for the turn: what was asked does not change as the loop runs.
  const askedAQuestion = isExplanatoryQuestion(question);

  // A request that names the file it wants written is not a request to
  // scaffold a project.
  //
  // Found by asking the app to do the plainest thing it offers: "create a file
  // called launch-check.txt containing the single line: it works". It wrote the
  // file correctly and also called build_app, which refused for want of a
  // description - so the answer opened "Sorry, I can't build an app without a
  // description", and only then mentioned the file. The work succeeded and the
  // reply led with an apology for something nobody asked for.
  //
  // Safe on the same argument machineChangingTools already makes from verb
  // order: generate is tested before write, so "build me a todo app", "create
  // an app that tracks tasks" and "write me an app for invoices" all classify
  // as generate and keep build_app. Only a write verb with a named file target
  // lands here. "create a todo app" names no file, so it is not caught either.
  const namedAFileToWrite = intent.kind === "write" && intent.hasTarget;
  let firstTurnToolCalls: number | null = null;

  // Stated at each path rather than inferred at the end, through named
  // transitions that cannot return it to "none". See toolActivity.ts.
  const toolActivity = createToolActivity();

  const auditFor = (outcome: ActionAudit["outcome"]): ActionAudit => ({
    kind: intent.kind ?? "none",
    actionIntent: intent.action,
    toolActivity: toolActivity.value,
    firstTurnToolCalls: firstTurnToolCalls ?? 0,
    forcedRetry,
    outcome
  });

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
  // Kept with their outcome, because a failed attempt's text is only worth
  // showing when nothing else succeeded.
  //
  // Live: build_app failed once and then succeeded on a retry, and the reply
  // carried both - "I could not write that app... Nothing was written."
  // immediately followed by "Built \"Celsius\" in the workspace". The user is
  // left to guess which half is true, and the app did in fact build.
  const mutationAttempts: Array<{ content: string; ok: boolean }> = [];

  // How many times each exact call has actually been run, across every round
  // of this one request — not per round, since the failure this guards
  // against is the model retrying the same call in a *later* round after the
  // *earlier* round already told it there was nothing there.
  const attemptsBySignature = new Map<string, number>();

  // Whether fetch_url has failed this turn. A telling-it-plainly rule in the
  // system prompt did not hold: refused for reaching this machine's own
  // address, the reply built and wrote a real, entirely unrelated app to
  // disk anyway — three times running, with three different invented names,
  // even with the prompt explicit that a refusal is not an invitation to try
  // something unrelated. A model that keeps doing this despite being told
  // not to is fixed by removing the choice, not by asking again: tools are
  // withheld outright the round after this happens, the same way the final
  // round already withholds them to force an answer instead of a fifth
  // search — and, below, anything queued alongside the failed call in its
  // own batch is skipped too, since a round boundary is not the only place
  // this needs to hold. Scoped to fetch_url specifically — a search tool
  // finding nothing is ordinary and a real reason to reasonably try a
  // different tool next; the network reaching outside the machine failing
  // has no such reasonable next step.
  let fetchUrlFailed = false;

  // Rounds spent being told the reply was wrong, rather than spent working.
  //
  // The three corrections below each push a message and go round again, and
  // they were doing that on the same budget as tool calls - so being corrected
  // cost the model a round it needed to act on the correction. Live consequence:
  // read_file, a failed edit_file, a re-read, then a reply promising to write
  // the file. The promise check fired, pushed its correction, and the loop ran
  // out on the way back in - so the turn was discarded and the user got the
  // generic "kept searching without reaching an answer" instead of either the
  // edit or the truth about it.
  //
  // Bounded without needing a limit of its own: each correction is guarded by a
  // one-shot flag, so this can rise by at most three over the whole turn.
  let correctionRounds = 0;
  const spendCorrection = () => { correctionRounds += 1; };

  for (let round = 0; round <= maxToolRounds + correctionRounds; round += 1) {
    // On the last round, or the round after fetch_url failed, tools are
    // withheld, which forces an answer rather than another attempt at
    // something the model was not going to conclude on.
    const offerTools = round < maxToolRounds + correctionRounds && !fetchUrlFailed;

    let response: ChatResponse;
    try {
      const raw = await withTimeout(config.timeoutMs, (signal) =>
        fetchImpl(`${config.baseUrl}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: config.model,
            messages,
            // Streamed only when someone is listening. Tokens are useless to
            // a caller that cannot show them, and the unstreamed path is the
            // one every existing test exercises.
            stream: Boolean(onToken),
            // Withheld while disarmed rather than offered and refused: a
            // model that can see run_command will reason about it and try to
            // talk its way into it; one that never sees it cannot.
            ...(offerTools
              ? {
                tools: availableTools(commandsArmed() && !unattended, {
                  // A request to look does not get the tools that change
                  // things. Asked to read one file, the model read it and then
                  // wrote three - see machineChangingTools in agentTools.
                  changes: intent.kind !== "read",
                  // A question does not get to scaffold a project. Decided from
                  // the request rather than from the reply, because a build has
                  // already written its files by the time a reply exists.
                  scaffolding: !askedAQuestion && !namedAFileToWrite
                })
              }
              : {})
          }),
          signal
        }), cancel);

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

      if (onToken && raw.body) {
        // The same shape the unstreamed path produces, assembled from frames.
        // Everything downstream — tool parsing, the text guard, the round
        // bound — then works identically whether or not this was streamed.
        const streamed = await readStream(
          toLines(raw.body as unknown as AsyncIterable<Uint8Array>),
          onToken,
          // What counts as "do not show this": the same parser that decides
          // whether the finished message was a call. Sharing it means the
          // screen and the loop can never disagree about what the reply was.
          (text) => parseTextToolCalls(text).length > 0
        );
        response = {
          model: streamed.model ?? config.model,
          message: {
            role: "assistant",
            content: streamed.content,
            ...(streamed.toolCalls ? { tool_calls: streamed.toolCalls } : {})
          }
        } as ChatResponse;
      } else {
        response = await raw.json() as ChatResponse;
      }
    } catch (error) {
      // Stopped on purpose is not a fault. Both arrive here as an AbortError,
      // and reporting a cancellation as "the model did not reply" would blame
      // the machine for a decision the user made — so the caller's own signal
      // is checked before the timeout is assumed.
      if (cancel?.aborted) {
        return { ok: false, reason: "Stopped.", toolsUsed, stopped: true };
      }

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
    if (firstTurnToolCalls === null) firstTurnToolCalls = calls.length;

    if (calls.length === 0) {
      if (!text) {
        // Two different failures, and they must not be confused. A model that
        // is still asking for tools on the final round has not gone quiet — it
        // has failed to conclude, and saying "empty reply" would send whoever
        // reads this looking at the wrong thing.
        return requested.length > 0
          ? { ok: false, reason: "The assistant kept searching without reaching an answer.", toolsUsed }
          // Marked unusable so the caller moves on to the next installed
          // model. An empty reply is not a considered refusal, it is the
          // model producing nothing at all — and unlike a model that answered
          // badly, a different one has every chance of answering fine. Found
          // live: "Write a Python function that adds two numbers" got an
          // empty reply from vexora:latest in a second, the caller gave up,
          // and the user was shown a generic four-step planning template
          // ("Clarify the end state ... Identify the highest-impact next
          // move") as though it were the answer. qwen2.5-coder, already
          // installed on the same machine, answered it correctly.
          : { ok: false, reason: "The local model returned an empty reply.", toolsUsed, modelUnusable: true };
      }
      // A call for a tool that is switched off is the model's working, not
      // its answer, and printing it verbatim tells the user nothing they can
      // act on. Answering with the reason does.
      const gated = gatedToolCall(text);
      if (gated) {
        return {
          ok: true,
          text: explainGatedTool(gated),
          model: typeof response.model === "string" ? response.model : config.model,
          toolsUsed
        };
      }

      // Tool results the model wrote itself, removed before anything else.
      //
      // Some models narrate in the tags of their training format, and one
      // reply carried "<toolresponse> greet.js edited successfully.
      // </toolresponse>" for an edit that had failed and changed nothing. A
      // real tool result never reaches the user this way - it goes back to the
      // model as a tool message, and what the user sees is the model's own
      // words plus the trace written by the code that did the work. So this
      // shape in a final reply is invention by definition.
      // An order answered with prose is not an answer.
      //
      // This branch used to return whatever the model said. So "edit greet.js
      // and add a guard" could come back as "Got it, I'll keep that in mind for
      // this conversation" and the app presented it as the reply — nothing
      // edited, nothing failed, and nothing saying so. The three outcomes below
      // are the only ones an action request may end in.
      //
      // Guarded on toolsUsed and awaitingConfirmation as well as calls, so a
      // turn that already ran a tool, or that is waiting on the user to approve
      // one, is left exactly as it was. A permission refusal is a decision, not
      // a failure to act, and must not be retried.
      // Gated on the stated activity, not on an inference from toolsUsed. The
      // terminal message below is an absolute claim that nothing ran, so it may
      // only be reached from "none" - a tool that executed, one awaiting
      // approval, and one refused before running are each a different thing
      // that did happen.
      if (intent.action && toolActivity.untouched) {
        // Nothing to act on. One specific question beats another generation
        // arriving at the same place - and the question is worded for the kind
        // of work, because asking "which file?" of someone running npm test
        // reads as not having understood them at all.
        if (!intent.hasTarget && intent.kind) {
          return {
            ok: true,
            text: clarificationFor(intent.kind),
            model: typeof response.model === "string" ? response.model : config.model,
            toolsUsed,
            actionAudit: auditFor("clarified")
          };
        }

        if (!forcedRetry) {
          forcedRetry = true;
          spendCorrection();
          messages.push({
            role: "user",
            content:
              "You did not call a tool. That was an instruction to act, not a message to "
              + `acknowledge. Call ${intent.expects.join(" or ")} now with the path given. `
              + "Do not acknowledge, explain, promise, or claim it is done without calling "
              + "the tool."
          });
          continue;
        }

        // Told once and still nothing. Said plainly, naming what was wanted and
        // what did not happen, because the one thing this must never do is imply
        // the work was done.
        return {
          ok: true,
          text: "I could not perform the requested action because no valid tool call was "
            + "produced. No tool was executed during this attempt.",
          model: typeof response.model === "string" ? response.model : config.model,
          toolsUsed,
          actionAudit: auditFor("no-tool-failure")
        };
      }

      // A reply that denies work the record says succeeded.
      //
      // Seen live: two read_file calls returned ok, and the model then said the
      // tool had refused because it lacked permission. The trace showed two
      // ticks. Telling someone the app cannot do a thing it has just done sends
      // them to fix a problem that does not exist.
      //
      // Corrected once, with the fact, rather than retried blindly - the model
      // already has the results, it just described them wrongly.
      if (!correctedContradiction && contradictsToolRecord(text, toolsUsed)) {
        correctedContradiction = true;
        spendCorrection();
        messages.push({ role: "user", content: correctionFor(toolsUsed) });
        continue;
      }

      // Credit given to a tool that never ran.
      //
      // Caught on the simplest question in the app. Asked "what is 2+2",
      // llama3.1:8b answered, in full: "I used the `calculate` tool to evaluate
      // the expression `2+2`." There is no calculate tool, no tool ran, and
      // there is no answer in there either - the user asked what two plus two
      // is and was told about a tool instead.
      //
      // Only corrected, never replaced. Unlike a false claim of saving, there
      // is nothing true the app can substitute here: it does not know what the
      // answer is, only that this is not it. So the model is told to answer
      // directly and gets one more go.
      if (!correctedToolCredit && claimsUnusedTool(text, toolsUsed)) {
        correctedToolCredit = true;
        spendCorrection();
        messages.push({ role: "user", content: answerDirectly });
        continue;
      }

      // A change the model says it made, and did not.
      //
      // Seen live: asked to read a file and edit it, it called read_file, never
      // called edit_file, and answered "The edited code is saved as greet.js".
      // The file was untouched. withMutationResults covers the opposite case -
      // a real change the model forgot to mention - but nothing checked a
      // change that was mentioned and never made.
      //
      // The record is toolsUsed filtered by the permission ladder, not
      // mutationResults. mutationResults is fed from the `mutatingTools` set
      // above, which exists to decide whose output is repeated verbatim and
      // does not contain edit_file - so a real, successful edit would have been
      // called a lie. changesSomething reads the ladder instead, where "creates
      // or changes something" is the definition of level 2.
      const wroteSomething = toolsUsed.some((used) => used.ok && changesSomething(used.name));

      // Successes if there were any, otherwise the failures - so a retry that
      // worked is not reported alongside the attempt that did not, and a build
      // that never worked still says so.
      const succeeded = mutationAttempts.filter((attempt) => attempt.ok);
      const mutationResults = (succeeded.length > 0 ? succeeded : mutationAttempts)
        .map((attempt) => attempt.content);

      // A promise counts the same as a claim here. "I will now write the file"
      // at the end of a turn is not a plan, it is a change that is never going
      // to happen - there is no later for the model to do it in. Both get the
      // same treatment: pushed once to actually call the tool, and if it still
      // will not, the user is told plainly rather than left holding a promise.
      const claimedAChange = claimsUnperformedMutation(text, wroteSomething)
        || promisesUnperformedMutation(text, wroteSomething);

      if (claimedAChange) {
        // A held confirmation looks identical from the mutation record - nothing
        // was written either way - but it is not the same situation. The offer
        // is still open, and awaitingConfirmation is what drives the control
        // that accepts it. Returning the "nothing was written, ask me again"
        // message here would discard a confirmation the user was one word from
        // giving, so the wording is corrected and the offer kept.
        if (awaitingConfirmation) {
          return {
            ok: true,
            text: pendingConfirmationNotice(awaitingConfirmation.tool),
            model: typeof response.model === "string" ? response.model : config.model,
            toolsUsed,
            awaitingConfirmation,
            actionAudit: auditFor("clarified")
          };
        }

        if (!correctedMutationClaim) {
          correctedMutationClaim = true;
          spendCorrection();
          messages.push({
            role: "user",
            content: "You did not change anything. No file was created, edited or deleted - you "
              + "never called a tool that writes. This is your last turn, so there is no later: "
              + "either call the tool now, or tell the user plainly that nothing was changed. Do "
              + "not say a file was saved when it was not, and do not say you are about to write "
              + "it - if you are going to write it, write it in this turn."
          });
          continue;
        }

        // Told once and still claiming it. The claim is replaced rather than
        // appended to: a reply that says "saved!" followed by "nothing was
        // changed" leaves the reader to guess which half is true.
        return {
          ok: true,
          text: noChangeWasMade(toolsUsed),
          model: typeof response.model === "string" ? response.model : config.model,
          toolsUsed,
          actionAudit: auditFor(toolsUsed.length > 0 ? "tool-called" : "prose")
        };
      }

      const withoutInvention = stripFabricatedToolOutput(text);

      // Nothing left once the invention is gone means there was no answer
      // under it, only the fiction. Treated as an unusable reply so the caller
      // falls through to the next model, exactly as an empty one is.
      if (!withoutInvention.trim()) {
        return {
          ok: false,
          reason: "The local model replied with fabricated tool output and no actual answer.",
          toolsUsed,
          modelUnusable: true
        };
      }

      const builtAnApp = toolsUsed.some((used) => used.name === "build_app");
      const cleanedText = builtAnApp ? withoutFabricatedLiveClaims(withoutInvention) : withoutInvention;
      return {
        ok: true,
        text: withMutationResults(cleanedText, mutationResults),
        model: typeof response.model === "string" ? response.model : config.model,
        toolsUsed,
        ...(awaitingConfirmation ? { awaitingConfirmation } : {}),
        actionAudit: auditFor(toolsUsed.length > 0 ? "tool-called" : "prose")
      };
    }

    // Carry the model's own turn forward before the results, or the exchange
    // stops making sense to it on the next pass. Kept in the order the model
    // actually asked for them — a transcript of its own turn, not of
    // execution order below.
    messages.push({
      role: "assistant",
      content: text,
      tool_calls: calls.map((call) => ({ function: { name: call.name, arguments: call.arguments } }))
    });

    // fetch_url runs before anything else offered in the same batch.
    //
    // Caught live: asked to fetch this machine's own address, the model
    // requested fetch_url and build_app together in one response, before
    // either had a result — the two calls could not have depended on each
    // other, since the model had seen neither's outcome yet. Running them in
    // request order meant build_app still executed and wrote a real,
    // unrelated app to disk in the very same round fetch_url was refused in;
    // withholding tools on the *next* round, below, never got a chance to
    // matter, because there was nothing left to withhold from. Sorting
    // fetch_url first — stably, so everything else keeps its relative order —
    // means a failure is always known before its neighbours in the batch run,
    // regardless of which order the model happened to list them in.
    const orderedCalls = [...calls].sort((left, right) => {
      if (left.name === "fetch_url" && right.name !== "fetch_url") return -1;
      if (right.name === "fetch_url" && left.name !== "fetch_url") return 1;
      return 0;
    });

    for (const call of orderedCalls) {
      onToolStart?.(call.name);
      // The stage follows the work: a search moves it to gathering, a build to
      // building. Set here, as the call begins, rather than predicted from the
      // request — which is what keeps a stalled turn showing the stage it
      // actually stopped in instead of marching on through the rest.
      enterStage(context.sessionId, stageForTool(call.name));

      // The same removal, not the same request for restraint, for the part a
      // round boundary cannot reach: once fetch_url has failed this turn,
      // nothing queued alongside it in this same batch gets to run either.
      if (fetchUrlFailed) {
        toolActivity.markBlocked();
        messages.push({
          role: "tool",
          content: `${call.name} was not run: fetch_url failed earlier in this same turn, and that is `
            + "not a reason to try something unrelated instead."
        });
        continue;
      }

      // Refused before it runs a third time, not after: a check that only
      // notices the repeat once the identical call has already executed is
      // not a guard against a mutating tool running twice, it is a log of it
      // having happened.
      const signature = callSignature(call);
      const attempts = attemptsBySignature.get(signature) ?? 0;

      if (attempts >= maxIdenticalAttempts) {
        // A valid call was produced and refused before running. Not "none":
        // the model did ask for a tool, and the terminal message says it did
        // not. markBlocked only moves from "none", so an earlier execution is
        // never masked.
        toolActivity.markBlocked();
        messages.push({
          role: "tool",
          content: `${call.name} was already called with these exact arguments and did not produce `
            + "new information. Do not call it again with the same arguments — either try a genuinely "
            + "different approach, or answer using what you already have."
        });
        continue;
      }

      attemptsBySignature.set(signature, attempts + 1);

      // Awaited in sequence rather than run in parallel. Two calls in one
      // round are rare, and running them concurrently would let a build and a
      // write race for the same workspace file with no ordering guarantee.
      // Timed around the real dispatch, so a slow tool shows up as a slow
      // tool rather than as a slow request with no explanation.
      // Logged here, at the one place every tool passes through, so a tool
      // added later is recorded without anyone remembering to wire it up.
      // Before this the log only held build and command steps, which is why
      // a turn that genuinely read the workspace left an empty activity list
      // — the work happened and the screen said nothing had.
      const logged = selfLoggingTools.has(call.name)
        ? null
        : beginEvent(context.sessionId, executionKindForTool(call.name), describeToolCall(call));

      const toolBegan = Date.now();

      // Marked before dispatch, not after.
      //
      // A tool that throws has still run, and may have written half a file
      // before it failed. Marking on the far side of the await left the turn
      // looking untouched in exactly that case, because the marking line was
      // never reached - and "no tool was executed" is the one thing the
      // terminal message must never say wrongly. A call that turns out to need
      // confirmation is corrected below; nothing reads the state in between.
      toolActivity.markExecuted();
      const result = await runTool(call, context);
      observe("trhai_tool_duration", Date.now() - toolBegan, { tool: call.name });

      if (logged) {
        // "skipped" for a refusal: nothing ran, and calling that a failure
        // would put a red mark on the permission system working correctly.
        endEvent(
          context.sessionId,
          logged,
          result.needsConfirmation ? "skipped" : result.ok ? "ok" : "failed",
          result.needsConfirmation ? "waiting for confirmation" : undefined
        );
      }

      increment("trhai_tool_calls_total", {
        tool: call.name,
        // Three outcomes, because a refusal is neither a success nor a
        // failure — nothing was attempted, and counting it as an error would
        // make the permission ladder look like a fault.
        outcome: result.needsConfirmation ? "refused" : result.ok ? "ok" : "failed"
      });

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
        // Corrects the pre-dispatch mark: nothing actually ran, the call is
        // being held. Set before the loop can continue or return.
        toolActivity.markAwaitingConfirmation();
      } else {
        // Already marked executed above. A tool that ran and failed still ran.
        toolsUsed.push({ name: call.name, ok: result.ok });
      }
      if (call.name === "fetch_url" && !result.ok) fetchUrlFailed = true;
      // The failure text goes back unchanged. "Nothing matches X" is what stops
      // the model inventing an answer; softening it here would undo that.
      messages.push({ role: "tool", content: result.content });

      // A refusal is not a mutation result. Appending it printed an
      // instruction written for the model — "Tell the user plainly what it
      // would do and ask them to confirm" — verbatim underneath the reply,
      // where the user read internal plumbing addressed to someone else.
      if (mutatingTools.has(call.name) && !result.needsConfirmation) {
        mutationAttempts.push({ content: result.content, ok: result.ok });
      }
    }
  }

  return { ok: false, reason: "The assistant kept searching without reaching an answer.", toolsUsed };
}
