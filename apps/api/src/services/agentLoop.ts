import { contextWindow, modelOptions, noReplyWithin, replyTooLong, type LocalModelConfig } from "./localModel.js";
import { recordContextUse } from "./contextUse.js";
import { estimateTokens, fitPromptToWindow, fitToolResult, promptBudgetTokens, requestTokens } from "./contextBudget.js";
import { sendingTools } from "./messaging.js";
import {
  availableTools, driveNamedIn, readMachineStatus, runTool, verifiedDetail, type AgentLens, type ToolContext, type ToolCall
} from "./agentTools.js";
import { commandsArmed } from "./commandRunner.js";
import { readStream, toLines } from "./streamReader.js";
import { enterStage, stageForTool } from "./reasoningStage.js";
import { beginEvent, endEvent, type ExecutionKind } from "./executionLog.js";
import { stripFabricatedToolOutput } from "./fabricatedOutput.js";
import {
  answerDirectly, claimsUnperformedMutation, claimsUnusedTool, contradictsToolRecord,
  correctionFor, inventsAReading, narratesRetrievalOnly, noChangeWasMade, pendingConfirmationNotice,
  promisesUnperformedMutation, stateTheResult
} from "./contradictedClaims.js";
import { asksAboutMachineState, asksForAReading, asksToStartSomething, mentionsTheMachine, wantsSomethingBuilt, wantsToSendAMessage, wantsASummary, mentionsAnImage, changesAskedFor, clarificationFor, classifyIntent, isExplanatoryQuestion, looksArithmetic, reshapesAnEarlierReply, looksLikeClockMath, looksLikeDateMath, mentionsScheduling, mentionsTime, mentionsVideo, mentionsWeb, wantsWebSearch, wantsRendering, wantsToStopAnApp, mentionsDocument, namesAFilePath, type ActionKind } from "./actionIntent.js";
import { analyzeRequest, looksDeclarative } from "./requestAnalysis.js";
import { createToolActivity, type ToolActivity } from "./toolActivity.js";
import { changesSomething } from "./toolPermissions.js";
import { describeWorkspace, summariseWorkspace } from "./projectContext.js";
import { activeProject, projectForPath, resolveFilePronoun, resolveProjectReference } from "./activeProject.js";
import { verifyBuiltProject } from "./buildVerification.js";
import { resolveInWorkspace } from "./workspace.js";
import { existsSync } from "node:fs";
import path from "node:path";

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
 * How many times a turn may reach the web before it must answer from what it
 * has.
 *
 * The intended shape of a lookup is small: web_search to find a page, then
 * fetch_url to read it — two reaches, then an answer. A weaker model does not
 * stop there. Watched live: asked who Canada's prime minister is, qwen ran
 * web_search (ok) and fetch_url on the right Wikipedia page (ok) — it already
 * had the answer — then echoed a sentence through run_command, invented
 * https://example.com/prime-minister-canada, fetched that (404), and gave up.
 * Once this many web gathers have succeeded, no tools are offered at all and the
 * model answers from what it gathered, which by then it has. Withholding only
 * the web tools was not enough: with the answer already in the page it had
 * fetched, the model reached for the file tools instead and wandered off into
 * reading and editing a stray project file. A single successful read withholds
 * nothing — only the second closes the door — so the ordinary search-then-read
 * still runs in full.
 */
export const maxWebGathers = 2;

/**
 * The most tool calls one reply may ask for.
 *
 * A model that asks for every tool at once is not planning, it is
 * enumerating. Caught live: told that forget needed its fact filled in, the
 * model answered with a call to each of the twenty tools on offer, in the
 * order they were listed - and the loop ran them. It built an app called
 * "Forget", rendered a video and installed a global npm package through
 * run_command, on a request to delete one memory. No round needs more than a
 * few calls; a batch bigger than this is refused whole, because which few
 * were first was an accident of the listing order, not a decision.
 */
export const maxCallsPerRound = 4;

/**
 * A reply that names a command to run, in a code block or as a bare
 * `run_command ...` line, rather than running it.
 */
export function narratesACommand(text: string): boolean {
  const trimmed = text.trim();
  // Starting a server is never something to run here; it is what the user
  // does with the result. Fenced or inline.
  if (/`[^`]*\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:start|dev|serve)\b|`[^`]*\bnode\s+(?:\S*[\\/])?(?:server|index|app)\.(?:m?js|cjs)\b/i.test(trimmed)) return false;
  if (/^run_command\s+\S/i.test(trimmed)) return true;
  // The code fence may sit a blank line below the sentence, so the span
  // between the verb and the fence allows newlines.
  return /\b(?:i(?:'ll| will| would| can| am going to)|let me|let's|we can|you can|to (?:check|see|find|get)[^.\n]{0,60})\b[^`\n]{0,80}\b(?:run|execute|use)\b[^`]{0,120}```[\s\S]*?```/i.test(trimmed)
    || /^(?:run|execute)(?: the following| this)?(?: command)?:?\s*```[\s\S]*?```/im.test(trimmed)
    // Inline, in a sentence. Asked "which process is using the most RAM?"
    // with run_command on offer: "You can identify it by using the Task
    // Manager or by running the command `tasklist /fi "MEMUSAGE gt 1024"` in
    // Command Prompt." Only a span with a space, a flag or a path in it is a
    // command; "the `calculate` tool" is a name.
    || /\b(?:run|running|execute|executing|type|typing)\s+(?:the\s+)?(?:following\s+)?(?:command\s+)?`(?=[^`\n]*[\s\\/-])[^`\n]{2,200}`/i.test(trimmed);
}

/** Whether the request asks for something to be kept in memory. */
export function asksToRemember(text: string): boolean {
  return /\b(?:remember|memori[sz]e|keep in mind|note that|make a note|save (?:this|that|it|the fact)|don'?t forget|store (?:this|that|it))\b/i
    .test(text);
}

/** A reply that says, in some words, that the change was not made. */
const admitsNothingChanged_ =
  /\b(?:could not|couldn't|cannot|can't|unable|not able|failed|no file|does not exist|doesn't exist|not found|nothing was (?:changed|written|edited)|was not (?:changed|written|edited)|did not (?:change|write|edit)|no such file|permission|not allowed|outside the workspace)\b/i;

export function admitsNothingChanged(text: string): boolean {
  return admitsNothingChanged_.test(text);
}

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
 * Tools whose answer depends only on their arguments, so asking again can
 * never tell the model anything new. current_datetime is not one - the clock
 * moves - and nor is anything that reads the disk or the web.
 */
const pureTools = new Set(["calculate", "days_between", "shift_date", "shift_time"]);

/** Whether a reply already asks the user to confirm something. */
function mentionsConfirmation(text: string): boolean {
  const lower = text.toLowerCase();
  return ["confirm", "say yes", "go ahead", "approve", "shall i", "do you want me to"]
    .some((phrase) => lower.includes(phrase));
}

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

/** One spelling per file, so the same change is recognised however its path was written. */
function samePath(candidate: string): string {
  const resolved = (resolveInWorkspace(candidate) ?? path.resolve(candidate)).split(path.sep).join("/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Whether a write or edit would put an earlier step's own report into a file.
 *
 * Exact, not "contains": the written text, less any comment marker in front,
 * is the first line of a report and nothing else. A note that merely mentions
 * an edit, or a log the user asked for, is left alone; only the copy-the-last-
 * result-into-the-next-call failure is refused.
 */
export function echoesAReport(args: Record<string, unknown> | undefined, reports: string[]): boolean {
  const written = ["content", "append", "new_text"]
    .map((key) => args?.[key])
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim().replace(/^(?:\/\/|#|--|\/\*|<!--)\s*/, "").replace(/\s*(?:\*\/|-->)$/, "").trim());
  if (written.length === 0) return false;
  return reports.some((report) => {
    const line = report.split("\n")[0].trim();
    return line.length >= 12 && written.includes(line);
  });
}

/**
 * Whether a write or edit put down only text the user gave word for word.
 *
 * Then an app it broke is what was asked for, not a mistake to repair. Told to
 * append "throw new Error('boom');" to a built app's server.js, the model did -
 * and, with the tools left in reach to fix the break, spent three rounds
 * running `node server.js` at ever more mangled paths. Repairing it would have
 * meant undoing the user's own instruction; the honest move is to do it and
 * say what it broke.
 */
export function wroteWhatWasAsked(args: Record<string, unknown> | undefined, request: string): boolean {
  const written = ["content", "append", "new_text"]
    .map((key) => args?.[key])
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
  return written.length > 0 && written.every((value) => request.includes(value));
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
  "You are TRHAI, an assistant that runs entirely on this user's own machine.",
  "Speak to the user as \"you\". Never refer to them as \"the user\".",
  "",
  "There are two kinds of question, and they are answered differently.",
  "",
  "Questions about THIS USER - their work, their decisions, their preferences, their",
  "documents, their schedule. You cannot know these. Use a tool:",
  "- search_memory for anything they have told you.",
  "- search_documents, list_documents, read_document for anything written down.",
  "- summarize_document to summarize a whole document or file, however long - it reads every part.",
  "- look_at_image to see an image file - a screenshot or photo. You cannot see images any other way.",
  "- system_status for how this computer is doing: processor load, memory in use, the graphics",
  "  card, free disk space, network speed, uptime. Those are real readings - report them as",
  "  given, and never run a command or guess to get them.",
  "- current_datetime for today, now, or how long ago. You cannot know the date otherwise.",
  "  The date is never in their notes or documents. Do not search for it there;",
  "  searching and finding nothing led to answering \"the current date is not recorded\",",
  "  when the clock was available the whole time.",
  "- calculate for any arithmetic. Do not do sums yourself; you will get them wrong.",
  "- remember, forget, write_document to change what is stored.",
  "- build_app when they want something built. It writes a working app to disk.",
  "  Do not describe what you would build and stop; build it, then say where it is.",
  "- change_app to add or remove a field, or add a feature, on an app built here. \"add a",
  "  notes field to the plants\" is change_app, never a second build_app.",
  "- run_app starts a built app on a local port and returns its URL, so the user can open",
  "  and use it. build_app already launches what it builds; use run_app to start an app",
  "  again, or when the user says run, open or launch it. Never `npm start` through run_command.",
  "- send_text and send_email when they ask you to text or email someone. Write the message",
  "  they asked for and call the tool - they see it and approve it before anything is sent.",
  "  You need the real number or address: search_memory for a person they name, or ask.",
  "- list_files, read_file, write_file for the workspace where those apps live.",
  "- run_command runs a real command on this machine and returns its real output. It only",
  "  appears when the user has switched command access on. Use it for anything outside the",
  "  workspace: installing, building, running tests, opening an app, inspecting the system.",
  "  Say what you are about to run. A non-zero exit code means it FAILED - report that, do",
  "  not describe a failed command as done.",
  `  This machine runs ${process.platform === "win32" ? "Windows: commands run in cmd.exe, so use dir, findstr, type, netstat, or"
    + " powershell -Command \"...\" for anything else (what is on a port: netstat -ano | findstr :4000)."
    + " Not ls, df, grep, cat or wmic." : "a POSIX shell: ls, grep, df and the rest work as usual."}`,
  "- search_files to find where something is defined or used in files on disk: it returns",
  "  file:line for every match. Never search_memory or search_documents for code: those hold",
  "  what the user told you and their notes, not the files on this machine.",
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
 * The paragraph an active agent adds to the system prompt.
 *
 * Agents existed only as suggestion chips: activating "Ada, Programmer" changed
 * three buttons under the input and nothing about a single answer, which is
 * the decorative card the catalogue's own design note says an agent must not
 * be. This is the part that reaches the model. Its description goes in whole,
 * because that is where the limits live - "Not a substitute for counsel",
 * "Does not recommend investments" - and an agent that dropped them would be
 * worse than none. Stated as emphasis on top of the rules above, never instead
 * of them: the tools, the permission gates and the honesty rules are the same
 * whichever agent is active.
 */
export function describeAgentLens(agent: AgentLens): string {
  const role = agent.role.toLowerCase();
  const article = /^[aeiou]/.test(role) ? "an" : "a";
  // The name is the role's, and said so. Working as Reach, the marketer was
  // asked for a one-line pitch for a local-first assistant and answered
  // "Meet Reach, your local AI assistant" - twice, on two runs.
  return `For this conversation the user has asked you to work as ${agent.name}, ${article} ${role}. `
    + `${agent.name} is the name of that role, not of the user, their product or anything they ask you to write about. `
    + `${agent.description} Keep in view: ${agent.focus} `
    + "This is an emphasis, not a new set of rules: everything above still holds, and the tools are the same.";
}

/** Whether a request names a document already saved - "add a line to the Roadmap". */
export function namesASavedDocument(question: string, documents: ToolContext["documents"]): boolean {
  const asked = question.toLowerCase();
  return (documents ?? []).some((document) => {
    const title = document.title.trim().toLowerCase();
    return title.length >= 3 && asked.includes(title);
  });
}

/**
 * The last few turns of the conversation, as messages the model can read.
 *
 * The model was sent the system prompt and the current message and nothing
 * else, so no follow-up could work. Live: "What's the capital of Australia?"
 * was answered, and the next message, "And roughly how many people live
 * there?", got "I don't have access to current population data for any
 * specific location" - "there" pointed at nothing it could see. "Make that
 * answer one sentence." had no "that" either; one reply was the tool-calling
 * template, another saved a document called daily-log.txt. search_conversation
 * finds something said earlier only when the model thinks to look, and a
 * pronoun gives it nothing to look for.
 *
 * Bounded both ways: the last six turns, each cut to 800 characters. A file
 * listing or build report from three turns back is context, not something to
 * read again in full on every round of every later turn.
 */
const recentTurnCount = 6;
const recentTurnChars = 800;

export function recentTurns(conversation: ToolContext["conversation"], asked: string[]): ChatMessage[] {
  const turns = [...(conversation ?? [])];
  // The client may send the message being answered as the last turn of its
  // history. It goes in once, as the question, not twice.
  const current = new Set(asked.map((entry) => entry.trim()).filter(Boolean));
  while (turns.length > 0 && turns[turns.length - 1].role === "user"
    && current.has(turns[turns.length - 1].content.trim())) {
    turns.pop();
  }
  return turns
    .filter((turn) => turn.content.trim().length > 0)
    .slice(-recentTurnCount)
    .map((turn) => ({
      role: turn.role,
      content: turn.content.length > recentTurnChars ? `${turn.content.slice(0, recentTurnChars)} [...]` : turn.content
    }));
}

/**
 * A reply that is the model's tool-calling instructions rather than an answer.
 *
 * Seen live as the whole reply to "Make that answer one sentence.": "For each
 * function call, return a json object with function name and arguments within
 * {} with NO other text. Do not include any backticks or ```json." That is the
 * chat template's own wording, which sits just before the question; with
 * nothing to answer, the model repeated the last instructions it had read.
 */
const toolTemplateEcho =
  /\bfor each function call,? return a json object\b|\bfunction signatures within\b|<\/?tools>|\bwith no other text\.? do not include any backticks\b/i;

export function echoesToolTemplate(text: string): boolean {
  return toolTemplateEcho.test(text);
}

/**
 * Tools that change something durable, as opposed to only looking something up.
 *
 * Their result text is forced into the final answer rather than trusted to
 * survive the model's retelling — see the note on mutationResults for why.
 */
const mutatingTools = new Set([
  "remember", "forget", "write_document", "update_document", "delete_document",
  "pin_memory", "write_file", "build_app", "change_app", "make_video",
  // "I added the schedule for you." said nothing about when. The tool's
  // own line - Scheduled "Build Check": Every weekday at 8:00 AM - is what
  // the user needs to check it against what they asked.
  "add_schedule",
  // The rendering succeeded and the model still answered "I'm sorry, I can't
  // complete that request." Its own line - Rendered "Login Flow" - is the truth
  // the user needs, and the contradictory refusal is dropped below.
  "render_mockup"
]);

/**
 * Re-run a built app's own smoke test after the assistant changed one of its
 * files, and say what happened.
 *
 * build_app proves a build works before reporting it. An edit to that same app
 * was reported on the strength of the write alone, so "Edited server.js" could
 * leave a broken app behind with no word of it - the one gap in a codebase
 * whose whole point is never claiming work that did not happen.
 *
 * Only for apps in the workspace that ship a smoke.js (every generated app
 * does; it is self-contained and takes seconds). An external project's test
 * suite is not this loop's to run. Three outcomes, three sentences - passed,
 * failed its checks, could not be run - and never one dressed as another.
 * Null means "nothing to verify here", not silence about a failure.
 *
 * Each sentence names the file. Seen live: the model wrote no closing text
 * after an edit, so this line was the whole reply - and "Re-verified X after
 * the edit" left the user to guess which edit. edit_file's own result is not
 * repeated in replies (see mutatingTools), so this line must stand alone.
 *
 * `broke` is carried beside the sentence rather than read back out of it: an
 * edit that broke its app has not finished the order it was made for, and the
 * loop keeps the tools in reach for the fix (see changesAskedFor) - unless the
 * user gave that exact text to write (see wroteWhatWasAsked).
 */
async function verifyAfterEdit(
  sessionId: string | undefined,
  project: string,
  editedPath: string
): Promise<{ report: string; broke: boolean } | null> {
  const dir = resolveInWorkspace(project);
  if (!dir || !existsSync(path.join(dir, "smoke.js"))) return null;

  // The file as it sits inside the app ("server.js", "public/app.js"), from
  // whatever form the model gave the path in - workspace-relative or absolute.
  const absolute = resolveInWorkspace(editedPath);
  const file = absolute ? path.relative(dir, absolute).split(path.sep).join("/") : path.basename(editedPath);

  const verifying = beginEvent(sessionId, "verify", `Re-running ${project}'s own checks after editing ${file}`);
  const verification = await verifyBuiltProject(project);
  endEvent(
    sessionId,
    verifying,
    !verification.ran ? "skipped" : verification.passed ? "ok" : "failed",
    verification.ran ? verification.output : verification.reason
  );

  if (!verification.ran) {
    return { report: `Could not re-verify ${project} after editing ${file}: ${verification.reason}`, broke: false };
  }
  if (!verification.passed) {
    return { report: describeBrokenEdit(project, file, verification.output), broke: true };
  }
  return { report: `Re-verified ${project} after editing ${file}: ${verifiedDetail(verification.output)}`, broke: false };
}

/**
 * The sentence for an edit that broke an app, in terms a person can act on.
 *
 * smoke.js normally prints ok/FAIL lines, which summarize() turns into
 * "17/19 checks passed; failed: ...". When the edit crashes the app before it
 * answers, smoke.js dies on its own first request instead and its output is a
 * stack trace - accurate, and unreadable as a reply. Seen live: a top-level
 * throw appended to server.js was reported as forty lines of undici internals.
 * That case is named for what it means, keeping the one line of the trace
 * that says anything.
 */
function describeBrokenEdit(project: string, file: string, output: string): string {
  if (/checks passed/.test(output)) {
    return `Editing ${file} broke ${project} - it failed its own checks: ${output}`;
  }
  const errorLine = output.split("\n").map((line) => line.trim()).find((line) => /^[A-Za-z]*Error: /.test(line));
  if (/fetch failed|ECONNREFUSED|ECONNRESET|socket hang up/i.test(output)) {
    return `Editing ${file} broke ${project} - the app no longer starts, so its checks could not reach it`
      + (errorLine ? ` (${errorLine})` : "") + ".";
  }
  return `Editing ${file} broke ${project} - it failed its own checks: `
    + (errorLine ?? output.split("\n").slice(0, 3).join(" ").trim());
}

/**
 * Tools that write their own execution events.
 *
 * build_app records a plan, a write and a verify step; run_command records the
 * command and its output. Both say more than a single generic row would, so
 * the loop stays out of their way rather than logging a second, vaguer entry
 * beside each one.
 */
const selfLoggingTools = new Set(["build_app", "change_app", "make_video", "run_command"]);

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
 * Whether a reply is nothing but a refusal.
 *
 * Caught live: "draw a diagram of the login flow" rendered a real diagram
 * (render_mockup succeeded, the SVG is on screen) and the model still answered
 * "I'm sorry, but I can't complete that request." A refusal that follows a
 * success is false, and printed on its own it tells the user the opposite of
 * what happened. When a change did succeed this turn, a reply that is only an
 * apology-and-refusal is dropped so the tool's own success line stands alone.
 *
 * Deliberately narrow: it matches a short reply that opens with an apology or
 * "I can't/cannot/unable", so a long reply that happens to contain the word
 * "can't" in a real answer is left untouched.
 */
export function isBareRefusal(text: string): boolean {
  const trimmed = (text ?? "").trim();
  if (!trimmed || trimmed.length > 240) return false;
  const lower = trimmed.toLowerCase();
  const opensWithRefusal =
    /^(?:sorry\b|unfortunately\b|apolog|i(?:'m| am)\s+sorry\b|i(?:'m| am)\s+(?:un|not\s+)?able\b|i\s+can(?:'|no)?t\b|i\s+cannot\b|i\s+won'?t\b)/.test(lower);
  const hasRefusalVerb = /\b(?:can(?:'|no)?t|cannot|unable|won'?t|not\s+able)\b/.test(lower);
  return opensWithRefusal && hasRefusalVerb;
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
  /** "stop" when the model finished; "length" when the reply limit cut it off. */
  done_reason?: unknown;
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
/**
 * Whether a line after "run_command" is a command and not a sentence.
 * "run_command is the tool that would do it, but it is not on." is prose.
 */
function looksLikeAShellCommand(rest: string): boolean {
  if (/[.!?]$/.test(rest)) return false;
  return /^(?:npm|npx|pnpm|yarn|node|git|python|py|pip|powershell|pwsh|cmd|dir|findstr|netstat|type|echo|cd|ls|cat|grep|curl|wget|docker|tsc|eslint|systeminfo|tasklist|taskkill|where|which|whoami|hostname|ipconfig|ping|del|mkdir|rmdir|copy|move|ren|set|start|explorer|code|dotnet|cargo|go|java|mvn|gradle|make|tree|wsl|bash|sh)\b/i.test(rest);
}

/** Whether a tool can be called with nothing at all. */
function takesNoRequiredArguments(name: string): boolean {
  const definition = availableTools(true).find((candidate) => candidate.function.name === name);
  const required = (definition?.function.parameters as { required?: unknown } | undefined)?.required;
  return Boolean(definition) && (!Array.isArray(required) || required.length === 0);
}

function parseBareCall(line: string, known: string[]): ToolCall | null {
  // `system_status` - the name and nothing else, as the whole reply. Seen
  // live for "which process is using the most RAM?", and shown to the user as
  // the answer. A tool that needs nothing is called with nothing; one that
  // needs arguments is not guessed at.
  const bareName = /^`?([a-zA-Z_][a-zA-Z0-9_]*)`?\.?$/.exec(line.trim());
  if (bareName && known.includes(bareName[1]) && takesNoRequiredArguments(bareName[1])) {
    return { name: bareName[1], arguments: {} };
  }

  // `fetch_url {"url":"https://news.ycombinator.com/"}}` - the name, a space,
  // and the arguments as JSON, with a stray brace. Seen live as the whole of
  // the user-facing reply. The name is the tool's own, the object its
  // arguments; one trailing brace too many is forgiven.
  // `run_command powershell -Command "Get-PSDrive D"` - the tool's name and
  // then the command itself, as one line. Seen live as the whole reply.
  const bareRun = /^run_command\s+([^{\s][^\n]*)$/i.exec(line.trim());
  if (bareRun && known.includes("run_command") && looksLikeAShellCommand(bareRun[1].trim())) {
    return { name: "run_command", arguments: { command: bareRun[1].trim() } };
  }

  const named = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*(\{[\s\S]*\})\s*$/.exec(line.trim());
  if (named && known.includes(named[1])) {
    for (const candidate of [named[2], named[2].replace(/\}\s*$/, "")]) {
      try {
        const parsed = JSON.parse(candidate) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return { name: named[1], arguments: parsed as Record<string, unknown> };
        }
      } catch {
        // Try the next candidate.
      }
    }
  }

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
function nextJsonObject(text: string, from: number): { value: unknown; start: number; end: number } | null {
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
          return { value: JSON.parse(text.slice(start, i + 1)), start, end: i + 1 };
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

/**
 * A reply the model wrapped in a tool call that does not exist.
 *
 * Seen live, as the whole of the user-facing reply:
 *
 *   {"name": "send_message", "arguments": {"text": "I've already created a
 *   schedule this turn. If you'd like to create another one, please let me
 *   know."}}
 *
 * The model had been refused a repeat and reached for a "respond" tool of
 * its own invention. There is no such tool, so the parser did not treat it as
 * a call, and the JSON went to the user verbatim. The sentence inside is the
 * reply; this takes it out.
 */
export function unwrapPseudoReply(text: string, asked: string[] = []): string {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return text;

  const whole = sentenceFromPseudoCall(trimmed, asked);
  if (whole) return whole;

  // Several, one per line. Asked for three tips on error messages, the whole
  // reply was three invented calls - write_clear_message, provide_context and
  // a third - each carrying one tip as its message. The single-object path
  // above cannot parse that, so the raw JSON was the answer the user saw.
  const lines = trimmed.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length > 1) {
    const sentences = lines.map((line) => sentenceFromPseudoCall(line, asked));
    if (sentences.every((sentence): sentence is string => sentence !== null)) return sentences.join("\n\n");
  }
  return text;
}

/** Lower case, quotes and punctuation gone, spaces collapsed: for comparing wording. */
function wording(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, " ").replace(/\s+/g, " ").trim();
}

/**
 * Whether an argument is the user's own words handed back, rather than an answer.
 *
 * {"name": "translate", "arguments": {"text": "good morning", "to_language":
 * "Spanish"}} was unwrapped to "good morning", and that was the whole answer to
 * "translate 'good morning' to Spanish". The text was what the invented tool
 * was meant to act on, not what it produced. Text the user quoted, or two or
 * more words lifted straight from the request, is input; a one-word answer
 * that happens to appear in the question ("Canberra or Sydney?") is not
 * treated as one.
 */
function repeatsTheRequest(value: string, asked: string[]): boolean {
  const said = wording(value);
  if (!said) return false;
  return asked.some((request) => {
    const quoted = [...request.matchAll(/["'‘’“”]([^"'‘’“”]{1,200})["'‘’“”]/g)]
      .map((match) => wording(match[1]));
    if (quoted.includes(said)) return true;
    return said.includes(" ") && ` ${wording(request)} `.includes(` ${said} `);
  });
}

/**
 * Argument names that carry something said to the user, as opposed to
 * something handed to a tool.
 *
 * {"name": "tell_fact", "arguments": {"fact": "Octopuses have three hearts"}}
 * is a fact, and was dropped as an empty reply. But "any lone string" was too
 * loose: {"name": "calculate_expression", "arguments": {"expression": "((70 -
 * 32) * 5) / 9"}} answered "convert 70 fahrenheit to celsius" with the
 * expression and no result. An expression, a path, a command or a name is
 * input, never the answer.
 */
const spokenArgumentKeys = [
  "text", "message", "content", "reply", "response", "answer", "output",
  "fact", "facts", "tip", "tips", "advice", "suggestion", "suggestions", "idea", "ideas",
  "summary", "explanation", "result", "note", "notes", "greeting", "joke", "story", "poem", "quote"
];

/** The sentence inside one pseudo-call, or null when it is not one; see spokenArgumentKeys. */
function sentenceFromPseudoCall(candidate: string, asked: string[] = []): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as { name?: unknown; arguments?: unknown; parameters?: unknown };
  if (typeof record.name !== "string") return null;
  // A call to one of this app's own tools is a call, not a reply in costume -
  // one that is switched off is explained by gatedToolCall instead. Read as a
  // reply, {"name":"run_command","arguments":{"command":"echo hello"}} with
  // machine control off answered "echo hello".
  if (allToolNames().includes(record.name)) return null;
  const args = (record.arguments ?? record.parameters) as Record<string, unknown> | undefined;
  if (!args || typeof args !== "object") return null;

  for (const key of spokenArgumentKeys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      // The thing to act on is not the answer; see repeatsTheRequest.
      return repeatsTheRequest(value, asked) ? null : value.trim();
    }
  }
  return null;
}

/**
 * Whether a reply is nothing but a tool-call object.
 *
 * unwrapPseudoReply pulls the sentence out of a pseudo-call that carries one
 * ({"name":"respond","arguments":{"message":"Done."}}), but a call with no
 * message to pull - {"name":"open_url","arguments":{"url":"..."}} - it hands
 * back verbatim. And parseTextToolCalls only recognises advertised tools, so an
 * invented one like open_url is never treated as a call at all. Either way the
 * raw JSON reached the user. Watched live: a finished build_app answered with
 * {"name":"open_url",...} on top of the real "Built ..." line. A bare tool call
 * is the model trying to act, not an answer; recognised here so it can be
 * dropped rather than shown.
 */
export function looksLikeBareToolCall(text: string): boolean {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false;
  try {
    const parsed = JSON.parse(trimmed) as { name?: unknown; arguments?: unknown; parameters?: unknown };
    if (!parsed || typeof parsed !== "object" || typeof parsed.name !== "string") return false;
    return parsed.arguments != null || parsed.parameters != null;
  } catch {
    // Malformed but unmistakably a tool call the model emitted as text - a
    // truncated or placeholder call such as
    //   {"name": "web_search", "arguments": {"query": "<query>}}
    // parses as nothing, so the check above misses it and it leaked verbatim
    // into a reply. Match the shape instead: an opening "name" naming a real
    // tool, with an "arguments"/"parameters" key. Kept strict (a known tool
    // name) so a genuine, if malformed, JSON answer is not mistaken for one.
    const nameMatch = trimmed.match(/^\{\s*"name"\s*:\s*"([a-z_]+)"/i);
    if (!nameMatch || !advertisedToolNames().includes(nameMatch[1])) return false;
    return /"(?:arguments|parameters)"\s*:/.test(trimmed);
  }
}

/** The name in a reply that is nothing but a call to a tool this app does not have, or null. */
export function inventedToolName(text: string): string | null {
  if (!looksLikeBareToolCall(text)) return null;
  const name = /^\s*(?:```(?:json)?\s*)?\{\s*"name"\s*:\s*"([^"]+)"/i.exec(text)?.[1];
  return name && !allToolNames().includes(name) ? name : null;
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

  const argumentsOnly = argumentsOnlyCall(trimmed, known);
  if (argumentsOnly) return [argumentsOnly];

  return trimmed.split("\n")
    .map((line) => parseBareCall(line, known))
    .filter((call): call is ToolCall => call !== null);
}

/**
 * A call written as its arguments alone, with the tool's name left out:
 *
 *   Saved the schedule: {"name": "drink-water-reminder", "prompt": "Drink
 *   water", "daily_at": "09:15", "every_minutes": null, "weekdays_only": false}
 *
 * That was the whole reply, live, to "every day at 9:15 am remind me to drink
 * water" a few turns into a conversation - and nothing had been saved. With no
 * tool name in it, nothing above saw a call, so the claim went to the user as
 * fact. The object is read as a call only when it can be nobody else's: its
 * keys are all that tool's own, every required one is there, at least one
 * belongs to no other tool on offer - and it is the reply, not an example
 * inside a longer answer.
 */
function argumentsOnlyCall(text: string, known: string[]): ToolCall | null {
  const found = nextJsonObject(text, 0);
  if (!found || nextJsonObject(text, found.end)) return null;
  if (!found.value || typeof found.value !== "object" || Array.isArray(found.value)) return null;
  const record = found.value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length < 2) return null;
  const around = `${text.slice(0, found.start)} ${text.slice(found.end)}`.replace(/```(?:json)?/gi, "").trim();
  if (around.length > 80) return null;

  type Definition = ReturnType<typeof availableTools>[number];
  const definitions = availableTools(true).filter((definition) => known.includes(definition.function.name));
  const parametersOf = (definition: Definition) =>
    Object.keys((definition.function.parameters as { properties?: Record<string, unknown> }).properties ?? {});
  const requiredOf = (definition: Definition) => {
    const required = (definition.function.parameters as { required?: unknown }).required;
    return Array.isArray(required) ? required.filter((key): key is string => typeof key === "string") : [];
  };
  const fits = definitions.filter((definition) => {
    const own = parametersOf(definition);
    const distinctive = own.filter((key) => definitions.every((other) => other === definition || !parametersOf(other).includes(key)));
    return keys.every((key) => own.includes(key))
      && requiredOf(definition).every((key) => keys.includes(key))
      && keys.some((key) => distinctive.includes(key));
  });
  return fits.length === 1 ? { name: fits[0].function.name, arguments: record } : null;
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
  // "it" spelled out before anything reads the request. "read notes.txt",
  // then "now add a line saying omega to the end of it": the classifier saw
  // no file, so this was not a write, build_app stayed on offer, and the
  // model built an app called "Now Add A Line Saying". See activeProject.ts.
  const spelledOut = resolveFilePronoun(question, context.sessionId);
  if (spelledOut) {
    question = spelledOut.request;
    context = { ...context, impliedFile: spelledOut.file };
  } else {
    const project = resolveProjectReference(question, context.sessionId);
    if (project) question = project.request;
  }

  const now = (context.now ?? (() => new Date()))();
  const today = now.toLocaleString(undefined, {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "2-digit", minute: "2-digit"
  });

  // Read before the model answers, not left for it to fetch. With
  // system_status on offer, "what's my CPU usage right now?" called nothing
  // and was answered "45%"; "how hot is my GPU?" got "82 degrees Celsius".
  // Every number was invented, in under a second. The real readings go in
  // with the question, and an answer that still gives others is replaced
  // below (see inventsAReading).
  // The readings name the programs holding the most memory, so "which
  // process is using the most RAM?" is answered from them too; processor use
  // per program they do not have, which is why a question about programs
  // keeps the shell (see readingOnly).
  const aboutPrograms = /\b(?:process|processes|program|programs|apps?|application|applications|task manager|which|what(?:'s| is) using|using (?:the )?most)\b/i
    .test(question);
  const machineReadings = asksAboutMachineState(question)
    ? await readMachineStatus(context, driveNamedIn(question))
    : null;

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
        // Said outright when it is true. With access on, the model still opened
        // every read of a path outside the workspace with "I can't read files
        // outside the workspace - switch command access on", and only the
        // forced retry got the file read. It was reasoning from the prompt's
        // description of the switch, not from its state.
        + (commandsArmed() && !unattended
          ? "\n\nMachine access is ON right now. read_file, write_file, edit_file and run_command "
            + "work on any path on this machine, not only the workspace. A full path like C:/Users/... "
            + "or D:/... is fine to pass as given - do not refuse it and do not ask for access."
          : "")
        // Last, so it reads as a lens on everything above rather than ahead of it.
        + (context.agent ? `\n\n${describeAgentLens(context.agent)}` : "")
    },
    // What was said just before, so a follow-up has something to follow.
    ...recentTurns(context.conversation, [question, context.request ?? ""]),
    {
      role: "user",
      content: machineReadings
        ? `${question}\n\nLive readings from this machine, taken just now. They are real: answer from them as `
          + `given, and do not give any other number for this machine.\n${machineReadings}`
        : question
    }
  ];
  // The rules and the question: the two messages that are never shortened to
  // fit the window. Corrections later in the turn are user messages too, so
  // the question is remembered by where it is, not found as the last one.
  const neverShortened = [0, messages.length - 1];

  const toolsUsed: ToolOutcome[] = [];
  let awaitingConfirmation: { tool: string; arguments: Record<string, unknown> } | undefined;

  // Whether this turn was an order or a question, decided before generating.
  //
  // Deterministic, so it can be regression-tested. Asking a model to classify
  // the request would put the same unreliability that causes the bug in charge
  // of detecting it.
  const intent = classifyIntent(question);
  if (process.env.ASSIST_DEBUG) {
    console.log(`[agent] question=${JSON.stringify(question.slice(0, 400))} intent=${JSON.stringify(intent)} impliedFile=${JSON.stringify(context.impliedFile ?? null)}`);
  }
  let forcedRetry = false;
  let correctedContradiction = false;
  let correctedMutationClaim = false;
  let correctedToolCredit = false;
  let correctedRetrieval = false;
  let correctedUnwrittenOrder = false;
  let correctedUnsentMessage = false;
  let correctedNarratedCommand = false;
  let correctedInventedTool = false;
  let correctedTemplateEcho = false;

  // Fixed for the turn: what was asked does not change as the loop runs.
  const askedAQuestion = isExplanatoryQuestion(question);
  // A question that names no action gets nothing that changes the machine.
  // "in D:/trhai/apps/api/src/services, which file defines the function
  // classifyIntent?" - a question with a path in it, so not "explanatory"
  // by the narrow test above - had read_file miss and then write_file CREATE
  // classifyIntent.js in the source tree, three times, with placeholder code.
  // "what's my favorite color and my dog's name?" called update_document.
  // A question is answered; it is not a licence to write.
  //
  // Nor is a request that is neither an order nor a statement of fact. "give
  // me a name for my cat" has no verb the analysis knows, so it is filed as a
  // "statement" - and as a statement it was offered every tool that writes.
  // Live, it was answered by saving a daily 9am reminder, and on the next try
  // by rendering a nineteen-second video called "Welcome, Whiskers!" into the
  // workspace. It is asking for something, the same as a question is.
  const shape = analyzeRequest(question).shape;
  // "Make that answer one sentence" asks for words, the same as a question
  // does; see reshapesAnEarlierReply.
  const onlyAsks = (!intent.action && (shape === "question" || (shape === "statement" && !looksDeclarative(question))))
    || reshapesAnEarlierReply(question);

  // A question about the machine's readings is answered from them, not from
  // the shell: see system_status. Asked "what's my CPU usage right now?" with
  // run_command in reach, the model ran wmic, which this Windows no longer
  // has, and sent the user to Task Manager. Which program is responsible still
  // needs the process list, and an order to run something keeps the shell.
  const readingOnly = asksAboutMachineState(question) && !intent.action && !aboutPrograms;

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

  // How many changes this order asks for, when its words say (see
  // changesAskedFor). Once that many have worked - and none broke the app it
  // touched - the order is done: no tool is offered again and the model's next
  // reply is the answer. Counted from the user's own words where the caller
  // passes them, since the question here can carry saved facts after it.
  //
  // The same move as maxWebGathers, for the same reason. Asked to append one
  // line to server.js, the model appended it and then, still holding edit_file
  // and write_file, kept "improving" the file every round until the round
  // limit; twice it replaced the whole file. Asking it to stop did not hold
  // for the web tools either. Removing the choice does.
  const changeBudget = intent.action && intent.kind === "write"
    ? changesAskedFor(context.request ?? question)
    : null;
  let settledChanges = 0;
  const orderComplete = () => changeBudget !== null && settledChanges >= changeBudget;
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
  // `verifiedProject` marks a post-edit check report (see verifyAfterEdit), so
  // a later check of the same app can replace it instead of sitting beside it.
  // `quiet` marks a change whose result is not repeated under a written reply
  // (edit_file, run_app, run_command - see mutatingTools), kept so that a reply
  // the model never wrote can still say what changed.
  const mutationAttempts: Array<{
    name: string; content: string; ok: boolean; verifiedProject?: string; quiet?: boolean;
  }> = [];
  // Every change that worked this turn, in the order it happened.
  //
  // The answer when the model wrote none. Before this, a turn that edited a
  // file and then produced an empty or invented reply was thrown away as "the
  // model returned nothing" - and the caller handed the request to the next
  // installed model, which started from the beginning and made the same
  // change again. Seen live: four appends by qwen2.5-coder, a reply that was
  // only a made-up <tool_response>, two more models tried from scratch, and
  // "no local model could be loaded" shown over a file that had been changed
  // four times.
  const doneSoFar = () => [...new Set(mutationAttempts.filter((attempt) => attempt.ok).map((attempt) => attempt.content))];
  // A turn that ends without a reply after changing something still says what
  // changed - as an answer, never as a failure, because a failure sends the
  // request on to the next model to start over (see doneSoFar). Null when
  // nothing changed, so the ordinary failure stands.
  const reportWhatWasDone = (model: string, coda?: string): AgentResult | null => {
    const done = doneSoFar();
    if (done.length === 0) return null;
    const base = coda ? `${done.join("\n\n")}\n\n${coda}` : done.join("\n\n");
    return {
      ok: true,
      text: awaitingConfirmation ? `${base}\n\n${pendingConfirmationNotice(awaitingConfirmation.tool)}` : base,
      model,
      toolsUsed,
      ...(awaitingConfirmation ? { awaitingConfirmation } : {}),
      actionAudit: auditFor("tool-called")
    };
  };
  const stoppedMidway = "The local model stopped responding before it wrote a reply. The lines above are what was actually done.";
  const ranPastTheLimit = "The local model's reply after that ran past the length limit without finishing. "
    + "The lines above are what was actually done.";
  // What each change this turn reported, so a call that would write one of
  // those reports into a file can be recognised. See echoesAReport.
  const changeReports: string[] = [];
  // Apps whose own checks ran this turn after an edit - which started them,
  // so there is nothing to learn from starting them again by hand.
  const checkedApps = new Set<string>();
  // Successful results of tools that only read, for the round-limit fallback
  // at the bottom of this function.
  const readResults: string[] = [];

  // Every change already asked for this turn, by tool and arguments. A
  // repeat with the same arguments is not run again: its result stands.
  // Asked for one daily build check, the model called add_schedule in four
  // consecutive rounds and four schedules were saved; a note was saved twice
  // the same way.
  const changesAsked = new Set<string>();
  // Tools that make one thing per request, whatever the arguments: a second
  // schedule, app or video in the same turn is never what was asked for.
  const oncePerTurn = new Set(["add_schedule", "build_app", "change_app", "make_video", "render_mockup"]);
  const madeThisTurn = new Set<string>();

  // How many times each exact call has actually been run, across every round
  // of this one request — not per round, since the failure this guards
  // against is the model retrying the same call in a *later* round after the
  // *earlier* round already told it there was nothing there.
  const attemptsBySignature = new Map<string, number>();
  // What each pure tool returned, by call signature; see pureTools.
  const pureResults = new Map<string, string>();

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

  // Successful reaches to the web this turn (web_search or fetch_url). Once it
  // hits maxWebGathers the web tools stop being offered, so a model that has
  // already found and read what it needs answers instead of fetching more or
  // inventing a URL to fetch. See maxWebGathers.
  let webGathersDone = 0;

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
  const spendCorrection = () => {
    correctionRounds += 1;
    if (process.env.ASSIST_DEBUG) console.log(`[agent]   correction ${correctionRounds} spent`);
  };

  for (let round = 0; round <= maxToolRounds + correctionRounds; round += 1) {
    // On the last round, or the round after fetch_url failed, tools are
    // withheld, which forces an answer rather than another attempt at
    // something the model was not going to conclude on.
    // Tools stop once the web-gather budget is spent, the same as after a
    // failed fetch. Watched live: asked for the latest Node.js version, the
    // model searched and fetched the page that had the answer, then - with the
    // web tools gone but the file tools still on offer - read a stray project
    // file and tried to edit it, answering about "Hello, Vercel!" instead of
    // the version it already had. After the budget, no tools: it answers from
    // what it gathered. And none once the order's changes are made: see
    // changeBudget.
    const offerTools = round < maxToolRounds + correctionRounds && !fetchUrlFailed
      && webGathersDone < maxWebGathers && !orderComplete();

    // What this turn actually offers, decided once and used twice: sent to
    // the model, and enforced when the model answers.
    //
    // Gating the offer alone was not enough. A model emits tool calls from
    // habit as much as from the list in front of it: with calculate withheld
    // for "what comes next: 2, 6, 12, 20, 30, ?", qwen still returned a
    // calculate tool_call, and the loop - which only ever checked that a tool
    // existed, not that it had been offered - ran it and answered 36. Every
    // other gate had the same hole: scaffolding, the read-only turn, the
    // unattended run. The dispatcher below now refuses anything not in this
    // set, which closes all of them at once.
    // Whether the request actually wants a file written. namesAFilePath alone
    // is not that signal: it matches "Node.js" in "search the web for the
    // Node.js release schedule" (the ".js" reads as a filename), which is how a
    // pure web lookup ended up with the file writers in reach. A real path, an
    // intent-classified write, or an explicit "save it to <file>" is.
    const wantsToWriteAFile = namedAFileToWrite
      || /[a-z]:[\\/][^\s]+/i.test(question)
      || /(?:^|\s)\.{0,2}\/[^\s]+\.[a-z0-9]{1,6}\b/i.test(question)
      || /\b(?:save|store|write|put|export|dump|record)\b.{0,40}\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|txt|css|html|py|ps1|bat|sh|yml|yaml|toml)\b/i.test(question);

    const offeredTools = offerTools
      // A sum is not a job for the shell. Asked to "convert 5 miles to
      // kilometers" with calculate on offer, the model ran `bc` three times -
      // a POSIX calculator this Windows machine does not have - and answered
      // with advice to install it. An order to run something keeps the shell.
      ? availableTools(commandsArmed() && !unattended && !(looksArithmetic(question) && !intent.action) && !readingOnly
        // And only for a request about the machine, or an order to run
        // something: see mentionsTheMachine.
        && (mentionsTheMachine(question) || intent.kind === "execute" || intent.kind === "check"), {
        // A request to look does not get the tools that change things. Asked
        // to read one file, the model read it and then wrote three - see
        // machineChangingTools in agentTools. A request to STOP an app loses
        // them too: stop_app is not among them, so it stays in reach while
        // run_app and build_app do not - which is what stops "stop the notes
        // app" from stopping it and then restarting it.
        changes: intent.kind !== "read" && !wantsToStopAnApp(question) && !reshapesAnEarlierReply(question),
        // A question keeps run_command - the machine answers "is anything
        // listening on port 4000?" - and loses everything that writes.
        writes: !onlyAsks,
        memory: asksToRemember(question),
        // A question does not get to scaffold a project. Decided from the
        // request rather than from the reply, because a build has already
        // written its files by the time a reply exists.
        //
        // And only for a request to make something, or one that names no
        // action at all ("I need a task tracker"). "now add a line saying
        // omega to the end of it" names an action - a write - and still had
        // build_app in reach: the model built an app called "Now Add A Line
        // Saying" instead of editing the file.
        // And a request with no verb the classifier knows only when it names
        // something to build: see wantsSomethingBuilt.
        scaffolding: !askedAQuestion && !namedAFileToWrite
          && (intent.kind === "generate" || (intent.kind === undefined && wantsSomethingBuilt(question))),
        // A calculator is only in reach when there is a sum to do.
        arithmetic: looksArithmetic(question),
        // And the date tools only when the request is about dates.
        dates: looksLikeDateMath(question),
        // And clock arithmetic only when a clock time is named.
        clock: looksLikeClockMath(question),
        // The web only when the request mentions it or asks for a lookup, and
        // only until the turn has gathered from the web enough times (see
        // maxWebGathers) — after that it answers from what it has rather than
        // fetching more. The clock only when the request is about time at all.
        web: (mentionsWeb(question) || wantsWebSearch(question)) && webGathersDone < maxWebGathers,
        time: mentionsTime(question),
        // A visual is offered only when the request asks to see one.
        render: wantsRendering(question),
        // And a schedule only when the request is about something recurring,
        // and a video only when it mentions one.
        schedules: mentionsScheduling(question),
        video: mentionsVideo(question),
        // The knowledge base is written only when keeping something is asked
        // for - "save", "note", "document" - or a saved document is named.
        // "Write a two-sentence product description for a water bottle" asks
        // for words in the reply: with write_document on offer, the model
        // saved them as a document called "Stainless Steel Water Bottle" and
        // the reply showed none of them.
        documents: /\b(?:save|store|keep|record)\b/i.test(question)
          || (intent.kind !== "read" && (/\b(?:documents?|docs?|notes?|knowledge)\b/i.test(question)
            || namesASavedDocument(question, context.documents))),
        // The machine's own readings, when the question is about them.
        status: asksAboutMachineState(question),
        // Starting an app, when something was asked to start.
        launch: asksToStartSomething(question),
        // Texting or emailing someone, when that is what was asked - and
        // never on a run with nobody there to approve the message.
        messaging: wantsToSendAMessage(question) && !unattended,
        // Summarizing a whole document, when a summary is what was asked for -
        // and then only that way: see readers in availableTools.
        summaries: wantsASummary(question),
        readers: !wantsASummary(question),
        // Looking at an image file, when the request is about one.
        images: mentionsAnImage(question),
        // A request about a knowledge document, with no file named, does not get
        // the workspace file writers — so "save a document called X" reaches
        // write_document instead of writing an X.txt file. Nor does a pure web
        // lookup that names no file to write: "search the web for the Node.js
        // release schedule" had edit_file in reach and the model wandered into
        // web_search → edit_file → edit_file, writing files nobody asked for.
        // An explicit save target ("save it to notes.txt") keeps them.
        files: (mentionsDocument(question) && !namesAFilePath(question))
          ? false
          : (mentionsWeb(question) || wantsWebSearch(question))
            ? wantsToWriteAFile
            : true
      })
      : [];
    const offeredNames = new Set(offeredTools.map((definition) => definition.function.name));

    // Measured before it is sent, and made to fit. Past the window Ollama
    // cuts from the front without a word, and the front is the rules - so
    // earlier results give way instead, saying what they left out.
    const toolsTokens = offerTools ? estimateTokens(JSON.stringify(offeredTools)) : 0;
    const budget = promptBudgetTokens(contextWindow(config));
    const shortenedBy = fitPromptToWindow(messages, toolsTokens, budget, neverShortened);
    const promptSize = requestTokens(messages, toolsTokens);
    // What the reply will report as its context use: this prompt, as sent.
    if (context.sessionId) recordContextUse(context.sessionId, { promptTokens: promptSize, windowTokens: contextWindow(config) });
    if (promptSize > budget) {
      // Everything that could give has given. Said where someone looking at
      // the log can see it, because what happens next is the silent cut.
      console.warn(`[agent] the prompt is still ~${promptSize} tokens for a ${budget}-token budget after shortening; `
        + "raise OLLAMA_NUM_CTX if replies start ignoring the rules");
    } else if (process.env.ASSIST_DEBUG) {
      console.log(`[agent] prompt ~${promptSize} of ${budget} tokens`
        + (shortenedBy ? `, earlier results shortened by ~${shortenedBy} tokens` : ""));
    }

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
            // The window the whole prompt fits in. Without it Ollama ran the
            // model at 4,096 tokens and cut every longer prompt from the front,
            // rules first - see defaultContextTokens.
            options: modelOptions(config),
            // Withheld while disarmed rather than offered and refused: a
            // model that can see run_command will reason about it and try to
            // talk its way into it; one that never sees it cannot.
            ...(offerTools ? { tools: offeredTools } : {})
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

        // Not handed to another model once something has changed: it would
        // start over and change it again.
        const early = reportWhatWasDone(config.model, stoppedMidway);
        if (early) return early;

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
          },
          ...(streamed.doneReason ? { done_reason: streamed.doneReason } : {})
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

      // A model that stalls after making a change has still made it.
      const early = reportWhatWasDone(config.model, stoppedMidway);
      if (early) return early;

      return {
        ok: false,
        reason: error instanceof Error && error.name === "AbortError"
          ? noReplyWithin(config)
          : "Local model unavailable: the request failed.",
        toolsUsed
      };
    }

    // Cut off at the reply limit, not finished (see replyLimit). None of it is
    // used: a tool call stopped mid-argument would write half a file, and
    // anything else is the start of an answer that never ended. Not handed to
    // another model either - this one already spent a whole window on it, and
    // the next would start over. A change made earlier in the turn still
    // stands as the answer, as it does when the model stalls.
    if (response.done_reason === "length") {
      const early = reportWhatWasDone(config.model, ranPastTheLimit);
      if (early) return early;
      return { ok: false, reason: replyTooLong(config), toolsUsed };
    }

    // Tool calls are not honoured on the final round. A model can return them
    // even when none were offered, and acting on that would run one more round
    // than the bound allows — the bound has to hold whatever the model does.
    const rawText = typeof response.message?.content === "string"
      ? response.message.content.trim()
      : "";

    // Tool-call JSON is never shown as an answer, whether or not it was
    // understood: it is the model's working, not its reply.
    const unwrapped = parseTextToolCalls(rawText).length > 0
      ? ""
      : unwrapPseudoReply(rawText, [question, context.request ?? ""]);
    // A reply that is still a bare tool-call object — even an invented tool like
    // open_url that parseTextToolCalls does not recognise — is the model trying
    // to act, not an answer. Drop it so the raw JSON never reaches the user; a
    // real change's own success line stands in its place.
    const text = looksLikeBareToolCall(unwrapped) ? "" : unwrapped;

    // Both encodings. A model that used the interface and a model that wrote
    // the same calls into its prose are asking for the same thing, and after
    // the name check there is no reason to treat them differently.
    const requested = parseToolCalls(response);
    const written = requested.length === 0 && rawText ? parseTextToolCalls(rawText) : [];
    const calls = offerTools ? [...requested, ...written] : [];
    // A trace of each round, on request. Reading a reply and guessing which
    // branch produced it is how the last three failures were misdiagnosed.
    if (process.env.ASSIST_DEBUG) {
      console.log(`[agent] round ${round} model=${config.model} calls=${JSON.stringify(calls.map((call) => ({ name: call.name, arguments: call.arguments })))} text=${JSON.stringify(rawText.slice(0, 300))}`);
    }
    if (firstTurnToolCalls === null) firstTurnToolCalls = calls.length;

    if (calls.length === 0) {
      // Its own instructions repeated back, instead of an answer: told once,
      // with the question, and then given up on rather than shown. A change
      // already made still stands as the answer (see reportWhatWasDone).
      if (text && echoesToolTemplate(text)) {
        const done = reportWhatWasDone(typeof response.model === "string" ? response.model : config.model);
        if (done) return done;
        if (!correctedTemplateEcho) {
          correctedTemplateEcho = true;
          spendCorrection();
          messages.push({ role: "assistant", content: rawText });
          messages.push({
            role: "user",
            content: "That is your tool instructions, not an answer. Answer this in plain sentences - "
              + `no tool call, no JSON: "${context.request ?? question}"`
          });
          continue;
        }
        return { ok: false, reason: "The local model repeated its tool instructions instead of answering.", toolsUsed };
      }

      if (!text) {
        // Two different failures, and they must not be confused. A model that
        // is still asking for tools on the final round has not gone quiet — it
        // has failed to conclude, and saying "empty reply" would send whoever
        // reads this looking at the wrong thing.
        // Either encoding counts. A call written into the text on the round
        // tools are withheld was read as an empty reply - "modelUnusable" -
        // and the caller moved on to the next installed model, which then
        // did the same work again: a second, differently-timed schedule for
        // one request.
        // A change succeeded this turn but the model added no words of its own
        // (or only a bare tool call, stripped above) — its own line is the
        // answer, not an empty reply. Found live: build_app finished, the model
        // answered {"name":"open_url",...}, that was stripped to nothing, and
        // the whole turn was thrown away as empty — losing the build.
        // An edit counts the same, though its line is not repeated under a
        // written reply: see doneSoFar.
        const done = reportWhatWasDone(typeof response.model === "string" ? response.model : config.model);
        if (done) return done;
        // A switched-off tool asked for as the whole reply: the reason it did
        // not run is the answer, the same as for one written inside prose.
        const gatedCall = gatedToolCall(rawText);
        if (gatedCall) {
          return {
            ok: true,
            text: explainGatedTool(gatedCall),
            model: typeof response.model === "string" ? response.model : config.model,
            toolsUsed
          };
        }
        // A call to a tool that does not exist is not an empty reply either.
        // Asked to "convert 5 miles to kilometers", the model answered with
        // nothing but {"name": "convert_units", ...}: stripped as a bare call,
        // that read as silence, every installed model was tried in turn, and
        // the user got the generic four-step planning template. Told once that
        // there is no such tool, the model answers the question itself.
        // The question and what the tools already said go with it: told only
        // "answer the question yourself", the model lost the thread and asked
        // which expression it should evaluate - with calculate's 21.11 for
        // "convert 70 fahrenheit to celsius" already in hand.
        const invented = inventedToolName(rawText);
        if (invented && !correctedInventedTool) {
          correctedInventedTool = true;
          spendCorrection();
          const found = readResults.slice(-2).map((result) => result.length > 300 ? `${result.slice(0, 300)}...` : result);
          messages.push({ role: "assistant", content: rawText });
          messages.push({
            role: "user",
            content: `There is no tool called ${invented}, so nothing ran. Answer this yourself, in plain `
              + `sentences - no tool call, no JSON: "${question}"`
              + (found.length > 0 ? ` What the tools already returned: ${found.join(" | ")}` : "")
          });
          continue;
        }
        return requested.length > 0 || written.length > 0
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
      // nothingRan rather than untouched: a call refused for not being on
      // offer is not the work being done either, and "I'm sorry, but I
      // can't complete that request" after one was still an order not acted
      // on. The terminal message below stays true - no tool was executed.
      if (intent.action && toolActivity.nothingRan) {
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

      // A command described instead of run. "is anything listening on port
      // 4000?" was answered "I'll run the following command: netstat -an |
      // findstr :4000 - this will show you..." with no tool called; "how much
      // free space is on drive D?" with the bare line `run_command powershell
      // -Command "Get-PSDrive D"`. Both had run_command in reach.
      // Not after a build or change: "You can run it with: cd app && npm
      // start" is the instruction the user needs, not a command the model
      // should have run - and pushed, the model ran `dir` instead.
      if (offeredNames.has("run_command") && !correctedNarratedCommand && narratesACommand(text)
        && !madeThisTurn.has("build_app") && !madeThisTurn.has("change_app")
        && !toolsUsed.some((used) => used.name === "run_command")) {
        correctedNarratedCommand = true;
        spendCorrection();
        messages.push({
          role: "user",
          content: "You described a command instead of running it. Call run_command with that exact command "
            + "now, then answer from its output. Do not show the command to the user as something for them to run."
        });
        continue;
      }

      // An order to change a file, answered without changing one.
      //
      // Not a claim, so the mutation guard below never fires. Asked to add a
      // line to the end of a file it had just read, the model read the file
      // again and answered with the contents plus the line - "alpha\nbeta\n
      // omega" - as though showing the result were making it; another time
      // just "omega". Nothing was written either time, and nothing said so.
      // A reply that admits the failure is left alone: replacing "there is no
      // file at that path" with a generic denial would lose the reason.
      // A claim of a change is left to the mutation guard below, whose
      // correction names the lie; this one is for a reply that merely does
      // not do the work.
      // A held confirmation is a decision waiting on the user, not a failure
      // to act, and is left to the notice below.
      if (intent.kind === "write" && intent.hasTarget && !awaitingConfirmation
        && !toolsUsed.some((used) => used.ok && changesSomething(used.name))
        && !admitsNothingChanged(text)
        && !claimsUnperformedMutation(text, false) && !promisesUnperformedMutation(text, false)) {
        if (!correctedUnwrittenOrder) {
          correctedUnwrittenOrder = true;
          spendCorrection();
          const target = context.impliedFile ? ` The file is ${context.impliedFile}.` : "";
          messages.push({
            role: "user",
            content: "You did not change the file - no tool that writes ran successfully. Showing the "
              + "result is not making it. Call edit_file now: pass append to add lines at the end, "
              + `or old_text and new_text to change a passage.${target} Do not read the file again.`
          });
          continue;
        }
        return {
          ok: true,
          text: noChangeWasMade(toolsUsed),
          model: typeof response.model === "string" ? response.model : config.model,
          toolsUsed,
          actionAudit: auditFor(toolsUsed.length > 0 ? "tool-called" : "prose")
        };
      }

      // A text or an email asked for, and nothing made ready to send.
      //
      // Live, "text 555-010-0123 that this is a TRH AI test" was answered
      // "Understood." with send_text on offer and nothing called - one run in
      // four. Left alone, the user is told nothing about why no message came.
      // A reply asking for what it needs ("What's her number?") is the right
      // move and is left alone, and so is a call that was tried and refused:
      // its reason is already in front of the model.
      if (offeredNames.has("send_text") && !awaitingConfirmation
        && !toolsUsed.some((used) => sendingTools.has(used.name))
        && !/\?\s*$/.test(text.trim())) {
        if (!correctedUnsentMessage) {
          correctedUnsentMessage = true;
          spendCorrection();
          messages.push({
            role: "user",
            content: "You did not call send_text or send_email, so no message is ready to send. Write the "
              + "message they asked for and call the tool now - they approve it before it goes. If the "
              + "number or address is missing, ask for it instead."
          });
          continue;
        }
        return {
          ok: true,
          text: "I didn't get a message ready to send, so nothing went anywhere. Try again with who it's for - "
            + "their number or email address - and what to say.",
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

      // The answer was fetched and then not given.
      //
      // "What's today's date?" ran current_datetime and answered "I have
      // retrieved the current date and time on the user's machine." The date
      // itself never appeared. Corrected once, like the credit case above:
      // the model has the value in its context and only needs telling to say
      // it, so there is nothing for the app to substitute.
      if (!correctedRetrieval && narratesRetrievalOnly(text, toolsUsed)) {
        correctedRetrieval = true;
        spendCorrection();
        messages.push({ role: "user", content: stateTheResult });
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
      // A failed attempt of a tool that is now awaiting confirmation is stale:
      // the model tried forget with nothing, was told so, and tried again
      // with the fact - and the second call is what is pending. Appending the
      // first refusal printed "forget was called with nothing to act on"
      // underneath a correct request for confirmation.
      // Quiet results are left out here: they are the fallback for a reply
      // the model did not write, not lines to add under one it did.
      const relevant = mutationAttempts.filter((attempt) => !attempt.quiet
        && !(awaitingConfirmation && attempt.name === awaitingConfirmation.tool && !attempt.ok));
      const succeeded = relevant.filter((attempt) => attempt.ok);
      // A change that worked, quiet or not, makes a refused attempt beside the
      // point. Live: write_file was refused for dropping the file's line, the
      // append then worked, and the reply read "Added a line..." followed by
      // "...Nothing was written."
      const anyChangeWorked = mutationAttempts.some((attempt) => attempt.ok);
      const mutationResults = (succeeded.length > 0 ? succeeded : anyChangeWorked ? [] : relevant)
        .map((attempt) => attempt.content);

      // A promise counts the same as a claim here. "I will now write the file"
      // at the end of a turn is not a plan, it is a change that is never going
      // to happen - there is no later for the model to do it in. Both get the
      // same treatment: pushed once to actually call the tool, and if it still
      // will not, the user is told plainly rather than left holding a promise.
      // A question is offered nothing that writes (see onlyAsks), so only a
      // claim that names a file can be a lie there; its answer describing
      // the world in the passive is not one.
      const claimedAChange = claimsUnperformedMutation(text, wroteSomething, !onlyAsks)
        || promisesUnperformedMutation(text, wroteSomething, !onlyAsks);

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
      // falls through to the next model, exactly as an empty one is — unless a
      // change succeeded this turn, in which case the change's own line (a
      // build, a render) is the answer, and an empty model text is fine.
      if (!withoutInvention.trim() && mutationResults.length === 0) {
        // Unless an edit, a launch or a command worked: then what it did is the
        // answer, and handing the request to another model would do it twice.
        const done = reportWhatWasDone(typeof response.model === "string" ? response.model : config.model);
        if (done) return done;
        return {
          ok: false,
          reason: "The local model replied with fabricated tool output and no actual answer.",
          toolsUsed,
          modelUnusable: true
        };
      }

      const builtAnApp = toolsUsed.some((used) => used.name === "build_app");
      const cleanedText = builtAnApp ? withoutFabricatedLiveClaims(withoutInvention) : withoutInvention;
      // A change succeeded this turn, yet the reply is only a refusal — false,
      // and the opposite of what happened. Drop it so the tool's own success
      // line (appended by withMutationResults) is what the user reads.
      const reportedText = mutationResults.length > 0 && isBareRefusal(cleanedText) ? "" : cleanedText;

      // A reading the machine did not give, on a question that only asked for
      // one: the readings themselves are the answer instead. See
      // inventsAReading; anything system_status returned counts as given.
      if (machineReadings && asksForAReading(question)
        && inventsAReading(reportedText, [machineReadings, ...readResults].join("\n"))) {
        return {
          ok: true,
          text: `This is what this machine reports right now:\n${machineReadings}`,
          model: typeof response.model === "string" ? response.model : config.model,
          toolsUsed,
          actionAudit: auditFor(toolsUsed.length > 0 ? "tool-called" : "prose")
        };
      }

      return {
        ok: true,
        // A held call the reply does not mention is a decision the user cannot
        // make. "forget my api port" held forget for confirmation and the
        // reply was "Understood. What can I assist you with today?" - nothing
        // about a confirmation, so nothing to say yes to. The notice is added
        // whenever a confirmation is pending and the reply has not asked.
        text: awaitingConfirmation && !mentionsConfirmation(reportedText)
          ? `${withMutationResults(reportedText, mutationResults)}\n\n${pendingConfirmationNotice(awaitingConfirmation.tool)}`
          : withMutationResults(reportedText, mutationResults),
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

    // See maxCallsPerRound. Refused whole, and told to the model as the one
    // tool result for the batch, so it answers the next round with a choice.
    if (orderedCalls.length > maxCallsPerRound) {
      toolActivity.markBlocked();
      messages.push({
        role: "tool",
        content: `You asked for ${orderedCalls.length} tools in one reply, and none of them were run. `
          + "Call one tool, read its result, then decide the next."
      });
      continue;
    }

    // One change per reply. The model cannot know a second change is right
    // before the first has a result - the same live turn that asked for
    // twenty tools asked for eight changes among them. Reads may batch;
    // changes queue, each behind the result of the one before.
    let changedThisRound = false;

    for (const call of orderedCalls) {
      if (process.env.ASSIST_DEBUG) console.log(`[agent]   consider ${call.name} offered=${offeredNames.has(call.name)}`);
      if (changesSomething(call.name) && offeredNames.has(call.name)) {
        // Without "reason": `npm run test` was run three times in a row, each
        // with a differently worded reason, and each counted as new.
        const { reason: _reason, ...argumentsThatMatter } = (call.arguments ?? {}) as Record<string, unknown>;
        // And one file however its path is spelled. Live, one turn named the
        // same server.js three ways - "app/server.js", "D:/ws/app/server.js"
        // and "D:\\ws\\app\\server.js" - and each would have counted as new.
        if (typeof argumentsThatMatter.path === "string") argumentsThatMatter.path = samePath(argumentsThatMatter.path);
        const signature = `${call.name}:${JSON.stringify(argumentsThatMatter)}`;
        if (changesAsked.has(signature)) {
          toolActivity.markBlocked();
          messages.push({
            role: "tool",
            content: `${call.name} was already called with these exact arguments this turn and was not run `
              + "again. Its earlier result stands. Answer the user with it."
          });
          continue;
        }
        if (oncePerTurn.has(call.name) && madeThisTurn.has(call.name)) {
          toolActivity.markBlocked();
          messages.push({
            role: "tool",
            content: `${call.name} already ran this turn and was not run again: one per request. `
              + "The work is done. Reply to the user now in plain sentences - no tool call, no JSON - "
              + "saying what was made."
          });
          continue;
        }
        changesAsked.add(signature);
        if (changedThisRound) {
          toolActivity.markBlocked();
          messages.push({
            role: "tool",
            content: `${call.name} was not run: one change per reply. Read the result of the change `
              + `already made, then call ${call.name} again if it is still needed.`
          });
          continue;
        }
        changedThisRound = true;
      }

      // An app built or changed this turn is complete; its files are not
      // rewritten in the same breath. After one build the model overwrote
      // the generated README three times with prose of its own, and the
      // record of what the app was built from went with it.
      if ((call.name === "write_file" || call.name === "edit_file")
        && (madeThisTurn.has("build_app") || madeThisTurn.has("change_app"))) {
        toolActivity.markBlocked();
        messages.push({
          role: "tool",
          content: `${call.name} was not run: the app was just generated and its files are complete. Do not `
            + "rewrite them. Tell the user it is built and where it is; changes come later, through change_app."
        });
        continue;
      }

      // A tool's own report is not file content. Seen live: "// Added 1 line to
      // the end of D:\...\server.js." appended to that same server.js, and
      // "Wrote .../server.js to the workspace." written over the whole file -
      // the model copying the last result it read into its next call.
      if ((call.name === "write_file" || call.name === "edit_file") && echoesAReport(call.arguments, changeReports)) {
        toolActivity.markBlocked();
        messages.push({
          role: "tool",
          content: `${call.name} was not run: what it would write is the report of an earlier step, not something `
            + "anyone asked to put in the file. Nothing was changed. Reply to the user now."
        });
        continue;
      }

      // An app built or changed this turn is not started here. After every
      // build the model ran `cd <app> && npm start`: from the wrong directory
      // it failed, and the model then ran `echo 'Command failed'` to "report"
      // it; from the right one it would have hung until the timeout, since a
      // server does not exit. The build's own checks already ran it.
      // Nor after an edit whose checks just ran the app: live, the model
      // followed an edit with `node D:\...\server.js` "to check it runs" - a
      // server that starts fine runs until the command times out.
      const builtThisTurn = madeThisTurn.has("build_app") || madeThisTurn.has("change_app");
      if (call.name === "run_command" && (builtThisTurn || checkedApps.size > 0)) {
        const command = typeof call.arguments?.command === "string" ? call.arguments.command : "";
        if (/\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:start|dev|serve)\b|\bnode\s+(?:\S*[\\/])?(?:server|index|app)\.(?:m?js|cjs)\b/i.test(command)) {
          toolActivity.markBlocked();
          messages.push({
            role: "tool",
            content: builtThisTurn
              ? "Not run: the app is built and its own checks already ran it, and starting its server here "
                + "would run until killed. Tell the user it is built and how to start it themselves."
              : "Not run: the app's own checks already ran it after the edit, and starting its server here "
                + "would run until killed. Tell the user what those checks found."
          });
          continue;
        }
      }

      // Not offered this turn, not run. See offeredNames above. Told to the
      // model as a tool message so it answers without the tool, rather than
      // silently dropped - a dropped call leaves it waiting for a result that
      // is never coming.
      if (!offeredNames.has(call.name)) {
        toolActivity.markBlocked();
        // Names what is available, and for an order, which tool the order
        // wants. Told only "not available", the model apologised - "I'm
        // sorry, but I can't complete that request" - with edit_file sitting
        // right there in the list.
        const wanted = intent.action
          ? intent.expects.filter((name) => offeredNames.has(name))
          : [];
        const instead = wanted.length > 0
          ? `Use ${wanted.join(" or ")} instead, with the path given.`
          : offeredNames.size > 0
            ? `The tools available for this request are: ${[...offeredNames].join(", ")}. Use one of them, or answer directly.`
            : "Answer the user directly, without it.";
        messages.push({
          role: "tool",
          content: `${call.name} was not available for this request and was not run. ${instead}`
        });
        continue;
      }

      if (process.env.ASSIST_DEBUG) console.log(`[agent]   dispatch ${call.name}`);
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

      // A pure tool asked the same thing twice has already answered it: the
      // same sum gives the same result. Watched live: calculate("5 * 1.60934")
      // returned 8.0467, the model asked again, and again - and, told to "try
      // a genuinely different approach", calculated an unrelated expression
      // and answered with that. For these, the earlier result is handed back
      // with the one instruction that fits.
      const earlier = pureResults.get(signature);
      if (earlier !== undefined) {
        toolActivity.markBlocked();
        messages.push({
          role: "tool",
          content: `${call.name} already answered exactly this: ${earlier.trim().replace(/\.*$/, "")}. `
            + "Answer the user with it now - no more tool calls."
        });
        continue;
      }

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
        // Counted only when it worked: a refused first attempt must not block
        // the corrected second one.
        if (result.ok && oncePerTurn.has(call.name)) madeThisTurn.add(call.name);
      }
      if (call.name === "fetch_url" && !result.ok) fetchUrlFailed = true;
      // A reach to the web that worked counts toward the gather budget; once it
      // is spent the web tools are no longer offered (see maxWebGathers).
      if ((call.name === "fetch_url" || call.name === "web_search") && result.ok) webGathersDone += 1;
      // The failure text goes back unchanged. "Nothing matches X" is what stops
      // the model inventing an answer; softening it here would undo that.
      // Only its length is bounded, keeping the start and the end: see
      // contextBudget.
      messages.push({ role: "tool", content: fitToolResult(call.name, result.content) });
      if (process.env.ASSIST_DEBUG) {
        console.log(`[agent]   ${call.name} -> ${result.ok ? "ok" : "failed"}: ${JSON.stringify(result.content.slice(0, 200))}`);
      }

      // A refusal is not a mutation result. Appending it printed an
      // instruction written for the model — "Tell the user plainly what it
      // would do and ask them to confirm" — verbatim underneath the reply,
      // where the user read internal plumbing addressed to someone else.
      const changed = result.ok && !result.needsConfirmation && changesSomething(call.name);
      if (mutatingTools.has(call.name) && !result.needsConfirmation) {
        mutationAttempts.push({ name: call.name, content: result.content, ok: result.ok });
      } else if (changed) {
        // See doneSoFar. A command's output is cut short: this is a record of
        // what happened, not the place to read the whole of it.
        const content = result.content.length > 600 ? `${result.content.slice(0, 600)}\n[...]` : result.content;
        mutationAttempts.push({ name: call.name, content, ok: true, quiet: true });
      }
      if (changesSomething(call.name) && !result.needsConfirmation) changeReports.push(result.content);
      // Whether this change counts toward the order being done: it worked,
      // and if it touched a built app, that app still passes its own checks.
      let settled = changed;
      // A change to a built app is followed by that app's own checks, so the
      // reply carries proof the app still works - or the news that it does not
      // - the way a build does.
      //
      // After every change, not once per turn. Only one change runs per reply
      // (changedThisRound), so a second edit to the same app always lands in a
      // later round - and checking only after the first left that second edit
      // unverified: the reply could say the app passed while the edit that
      // followed broke it. The cost is bounded by the round limit.
      if (result.ok && result.path && (call.name === "edit_file" || call.name === "write_file")) {
        const project = projectForPath(result.path);
        const check = project ? await verifyAfterEdit(context.sessionId, project, result.path) : null;
        if (project && check) {
          const { report } = check;
          changeReports.push(report);
          // The newest check of an app replaces the one before it. Round one
          // breaking the app and round two fixing it must read as fixed, not
          // as both - the model still has the earlier report in its history,
          // which is where it belongs.
          for (let i = mutationAttempts.length - 1; i >= 0; i -= 1) {
            if (mutationAttempts[i].verifiedProject === project) mutationAttempts.splice(i, 1);
          }
          // Marked ok because the report itself is sound: a failed check is
          // stated in its text and must never be dropped as "a failure beside
          // a success" - that filter is for retried attempts, and this is not one.
          mutationAttempts.push({ name: call.name, content: report, ok: true, verifiedProject: project });
          // Folded into the edit's own result - one call, one result. Sent as a
          // second tool message it read to the model as the result of a call it
          // never made, and it kept making calls: live, "append this line to
          // server.js" ended with an invented Express server.js written to the
          // workspace root, twice. The edit's result is the message just pushed.
          const last = messages[messages.length - 1];
          if (last && last.role === "tool") last.content = `${last.content}\n\n${report}`;
          else messages.push({ role: "tool", content: report });
          checkedApps.add(project);
          // An edit that broke its app has not finished anything: the fix is
          // still to come, and the tools stay in reach for it - unless what
          // broke it is exactly what the user said to write.
          if (check.broke && !wroteWhatWasAsked(call.arguments, context.request ?? question)) settled = false;
        }
      }
      if (settled) {
        settledChanges += 1;
        // Said where the model reads next - the result of the change that
        // finished the order - since its next round has no tools to reach for.
        if (orderComplete()) {
          const last = messages[messages.length - 1];
          if (last && last.role === "tool") {
            last.content = `${last.content}\n\nThat is everything this request asked for. Reply to the user `
              + "now in plain sentences saying what changed - no tool call, no JSON.";
          }
        }
      }
      if (result.ok && !changesSomething(call.name)) readResults.push(result.content);
      if (result.ok && pureTools.has(call.name)) pureResults.set(callSignature(call), result.content);
    }
  }

  // Out of rounds. With nothing in hand that is a failure; with results in
  // hand it is an answer the model did not get round to writing. Asked
  // whether anything was listening on port 4000, the model ran netstat, got
  // the answer, then wandered off reading invented paths until the rounds
  // ran out - and the user got the composer's "I don't have anything saved
  // that answers that". The netstat output was the answer.
  // A change made along the way comes first: what was done to the machine
  // matters more than what was read, and must never be reported as nothing.
  const done = reportWhatWasDone(config.model);
  if (done) return done;
  const useful = readResults.filter((result) => result.trim().length > 0);
  if (useful.length > 0) {
    const shown = useful.slice(-2).map((result) => result.length > 1500 ? `${result.slice(0, 1500)}\n[...]` : result);
    return {
      ok: true,
      text: `I did not get as far as a written answer, but this is what I found:\n\n${shown.join("\n\n")}`,
      model: config.model,
      toolsUsed,
      actionAudit: auditFor("tool-called")
    };
  }
  return { ok: false, reason: "The assistant kept searching without reaching an answer.", toolsUsed };
}
