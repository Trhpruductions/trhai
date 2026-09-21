import { ModelRouter, type ComposerKnowledge, type MemoryWriteOutcome } from "./modelRouter.js";
import { checkAvailability, orderedCandidates, readLocalModelConfig } from "./localModel.js";
import { isCodeWork } from "./machinePaths.js";
import { pickAuthorModel } from "./appAuthor.js";
import { buildCapabilityReply, trailingRequest } from "./replyComposer.js";
import { runAgent, type ToolOutcome } from "./agentLoop.js";
import type { RunningApp, StartResult } from "./appRunner.js";
import { setActivity } from "./agentActivity.js";
import { enterStage } from "./reasoningStage.js";
import { isContinuationRequest, looksLikeScheduleRequest } from "./requestAnalysis.js";
import { planProject } from "@ascend/shared";
import { classifyIntent } from "./actionIntent.js";
import { detectTaskType } from "./taskPlanning.js";
import { getResumableTask, recordTask, updateTask } from "./taskStore.js";
import {
  clearPendingConfirmation,
  consumePendingConfirmation,
  describePendingAction,
  getPendingConfirmation,
  isAffirmative,
  isDecline,
  recordPendingConfirmation,
  type PendingConfirmation
} from "./pendingConfirmation.js";
import {
  isLastAskRequest, isListMemoriesRequest, isListSchedulesRequest, parseForgetRequest, parseNthThingRequest, parsePinRequest,
  parseRemoveScheduleRequest, parseToggleScheduleRequest
} from "./memoryRequests.js";
import { matchMemories } from "./factWording.js";
import { resolveFilePronoun, resolveProjectReference } from "./activeProject.js";

export type OrchestratorInput = {
  mode: "general" | "build" | "code" | "debug" | "research" | "plan" | "coding" | "business" | "creator";
  userMessage: string;
  /** Present only when there is a session to report live tool activity against. */
  sessionId?: string;
  memoryContext?: Array<{ id?: string; title: string; body: string; pinned?: boolean; createdAt?: string }>;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  /** What actually happened to memory this turn; see MemoryWriteOutcome. */
  memoryWrite?: MemoryWriteOutcome;
  /** Knowledge passages available to ground an answer. */
  knowledge?: ComposerKnowledge[];
  /**
   * Writes a fact to memory for the "remember" tool. Omitted when there is
   * nowhere to write, in which case the tool reports that nothing was saved
   * rather than the assistant claiming otherwise. "duplicate" is a success —
   * the fact is already there — not a failure to report as one.
   */
  saveMemory?: (fact: string) => "saved" | "duplicate" | "empty";
  /** Removes a saved memory by id, for the "forget" tool. */
  forgetMemory?: (id: string) => boolean;
  /** Facts the user asked to forget this session; see ComposerInput.forgottenFacts. */
  forgottenFacts?: string[];
  /** The file "it" means this turn; see resolveFilePronoun. Set by the orchestrator. */
  impliedFile?: string;
  /**
   * Every memory in the session, for the forget flow. memoryContext is the
   * newest few, chosen for the model's prompt; a request to forget something
   * older than those must still find it.
   */
  listMemories?: () => Array<{ id: string; body: string; pinned?: boolean }>;
  /** Clears the session's memory, for "forget everything". Returns how many went. */
  forgetAllMemories?: () => number;
  /** The machine's schedules, described, for "what schedules do I have". */
  listSchedules?: () => Array<{ id: string; name: string; cadenceLabel: string; actionLabel: string; enabled: boolean }>;
  /** Removes a schedule by id, for "cancel my daily reminder". */
  removeSchedule?: (id: string) => boolean;
  /** Pauses or resumes a schedule by id, for "turn off the 9am reminder". */
  setScheduleEnabled?: (id: string, enabled: boolean) => boolean;
  /** Documents in this session, for the document tools. */
  documents?: Array<{ id: string; title: string; body: string }>;
  /** Saves a new document, for the "write_document" tool. */
  saveDocument?: (title: string, body: string) => boolean;
  /** Replaces a document's body, for the "update_document" tool. */
  updateDocument?: (id: string, body: string) => boolean;
  /** Deletes a document, for the "delete_document" tool. */
  deleteDocument?: (id: string) => boolean;
  /** Pins or unpins a memory, for the "pin_memory" tool. */
  pinMemory?: (id: string, pinned: boolean) => boolean;
  /** Launches a built app so it runs live; see appRunner. Forwarded to run_app and build_app. */
  launchApp?: (project: string) => Promise<StartResult>;
  stopApp?: (project: string) => boolean;
  runningApps?: () => RunningApp[];
  /** Writes an application with the local model, for requests no template covers. */
  authorApp?: (description: string) => Promise<{ ok: true; text: string } | { ok: false; reason: string }>;
  /**
   * Fired with each new piece of a generated reply, for callers that can show
   * it arriving. Optional throughout: without it every request is made and
   * answered exactly as before.
   *
   * Only ever fires on the branch that reaches a model. A reply quoted from
   * saved memory or a stored document is not generated a token at a time and
   * has nothing to stream — it is already whole when it is found.
   */
  onToken?: (text: string) => void;
  /**
   * True when nothing is watching this turn — a schedule firing on a timer
   * rather than someone sitting at the machine.
   *
   * Command access is withheld whatever the arming window says. Switching
   * machine control on is a grant for working at the machine; a scheduled run
   * must not inherit it merely because the window happens to still be open
   * when the timer fires.
   */
  unattended?: boolean;
  /**
   * Stops this turn: the user pressed Stop, or their browser went away.
   *
   * Real cancellation rather than a discarded result. A local model can hold
   * the GPU for a minute, so throwing the reply away while it kept generating
   * would leave the whole cost and remove only the benefit.
   */
  cancel?: AbortSignal;
};

export type OrchestratorResult = {
  model: string;
  assistantMessage: string;
  inputTokens: number;
  outputTokens: number;
  /** How the reply was produced. */
  strategy: string;
  /** The text a build should be generated from, when this was a build request. */
  buildRequest?: string;
  /**
   * Tools the assistant actually called, in order, each with whether it
   * achieved anything. Empty when it used none.
   */
  toolsUsed?: ToolOutcome[];
  /**
   * A destructive action waiting on the user's approval.
   *
   * Present only when the permission gate refused something this turn. The
   * client renders a confirmation dialog from it; without this the refusal
   * is only a sentence in the reply, and the user has to know to type "yes".
   */
  pendingConfirmation?: { tool: string; verb: string; target: string };
  /** Memory ids the reply was actually grounded on, not merely retrieved. */
  groundedOn: string[];
  /** Conversation turns the reply was actually grounded on, not merely sent. */
  groundedOnHistory: number;
};

const modelRouter = new ModelRouter();

export async function runAssistantOrchestrator(
  input: OrchestratorInput
): Promise<OrchestratorResult> {
  // An affirmative answers the offer that is actually standing, or it is
  // ordinary conversation. Consumed rather than merely read, so one "yes"
  // cannot authorise a second destructive action later in the same session.
  //
  // A null here is a real answer: "yes" with nothing pending grants nothing
  // at all, which is the whole point of holding the offer rather than
  // trusting the word on its own. Checked before continuation because the
  // two overlap — "do it" is both — and answering a standing offer to delete
  // something is the more specific reading.
  const approving = input.sessionId && isAffirmative(input.userMessage)
    ? consumePendingConfirmation(input.sessionId)
    : null;

  // A continuation carries no content of its own — "do it" is two words with
  // nothing to act on. What it means is entirely in the task it refers back
  // to, so that task's request is what the rest of this function works from.
  //
  // When nothing is resumable the message is left exactly as it arrived. It
  // then reaches the composer's vague branch and asks what to do, which is
  // the honest answer: inventing a task here to look responsive is the
  // failure this whole store exists to prevent.
  const resuming = input.sessionId && !approving && isContinuationRequest(input.userMessage)
    ? getResumableTask(input.sessionId)
    : null;

  const effectiveMessage = approving
    ? approving.request
    : resuming
      ? resuming.request
      : input.userMessage;

  if (resuming && input.sessionId) {
    updateTask(input.sessionId, { status: "executing" });
  }

  // Forgetting is done here, deterministically, and never by the model.
  //
  // It used to reach the agent loop like any other request, and the loop is
  // the wrong place for it. Caught live: "forget that my printer is on the
  // second floor" went to the model, which called forget with an empty fact,
  // was told to fill it in, and answered with a call to every one of the
  // twenty tools on offer, in the order they were listed. The loop ran them:
  // it built an app called "Forget", rendered a video and installed a global
  // npm package through run_command - on a request to delete one sentence.
  // Nothing about that request needs a model. The memories are a list, the
  // request names one, and the only decision is the user's.
  const forgetting = resolveForget(input, approving, effectiveMessage);
  if (forgetting) return forgetting;

  // "delete my Scratch document" - a destructive doc op. Left to the model it
  // called delete_document, got "needs confirmation", retried with placeholder
  // titles across four rounds, invented a confirm_action tool and returned an
  // empty reply, and the document was never removed. Handled here with the same
  // confirm-then-do flow as forget.
  const deletingDocument = resolveDeleteDocument(input, approving, effectiveMessage);
  if (deletingDocument) return deletingDocument;

  const pinning = resolvePin(input, approving, effectiveMessage);
  if (pinning) return pinning;

  const listing = resolveListMemories(input, approving, effectiveMessage);
  if (listing) return listing;

  const recap = resolveLastAsk(input, approving, effectiveMessage);
  if (recap) return recap;

  const schedules = resolveListSchedules(input, approving, effectiveMessage);
  if (schedules) return schedules;

  // "cancel my daily reminder" answered "Got it." and cancelled nothing; "turn
  // off the 9am reminder" called add_schedule and made a second one. Both are
  // decided here now: a confirm-then-do cancel, and a reversible pause/resume.
  const removingSchedule = resolveRemoveSchedule(input, approving, effectiveMessage);
  if (removingSchedule) return removingSchedule;

  const togglingSchedule = resolveToggleSchedule(input, approving, effectiveMessage);
  if (togglingSchedule) return togglingSchedule;

  // "save a document called X with the text Y" is a list operation, not a
  // reasoning one: a title and a body, straight into the store. Left to the
  // model it reached for write_file (an X.txt in the workspace), then
  // update_document (which will not create), then flailed - never write_document.
  const savingDocument = resolveSaveDocument(input, approving, effectiveMessage);
  if (savingDocument) return savingDocument;

  // "add to my Roadmap document: ..." — left to the model it fumbled
  // update_document's arguments across four rounds and reported confusion.
  const appendingDocument = resolveAppendDocument(input, approving, effectiveMessage);
  if (appendingDocument) return appendingDocument;

  // "search my documents for X" — left to the model it ran search_files and
  // read back workspace paths instead of the knowledge base.
  const searchingDocuments = resolveSearchDocuments(input, approving, effectiveMessage);
  if (searchingDocuments) return searchingDocuments;

  // "list my documents" is a list operation too; left to the model it ran
  // list_files and read back workspace paths instead of the knowledge base.
  const listingDocuments = resolveListDocuments(input, approving, effectiveMessage);
  if (listingDocuments) return listingDocuments;

  // "plan an app for X" is a plan, not a build. Left to the model it ran
  // build_app - build_app and plan_app both said "when the user wants something
  // built" - and built the app despite "do not build it yet". planProject is
  // deterministic, so the plan comes straight from it.
  const planningApp = resolvePlanApp(input, approving, effectiveMessage);
  if (planningApp) return planningApp;

  // Working out what was asked. Set here because this is the line that does
  // it, not a step announced before it starts.
  enterStage(input.sessionId, "understanding");

  const modelReply = await modelRouter.generate({
    mode: input.mode,
    userMessage: effectiveMessage,
    memoryContext: input.memoryContext,
    history: input.history,
    memoryWrite: input.memoryWrite,
    knowledge: input.knowledge,
    forgottenFacts: input.forgottenFacts
  });

  // "What can you do?" must describe what is actually wired up right now, so the
  // one branch whose answer depends on the backend asks before answering.
  if (modelReply.strategy === "capability") {
    const config = readLocalModelConfig();
    const availability = await checkAvailability(config);
    if (availability.available) {
      return {
        ...toResult(modelReply),
        assistantMessage: buildCapabilityReply(`ollama/${availability.model}`)
      };
    }
  }

  // The deterministic path had nothing, so try a local model if one is running.
  // Only this branch is eligible: a reply grounded in saved memory or a document
  // is an exact quote with a source, and must never be replaced by a generation.
  // Eligible when the deterministic path had no answer, and also when it fell
  // back to a generic plan for something that is not a build. "Explain what a
  // REST API is" was answered with "1. Clarify the end state ... 2. Identify the
  // highest-impact next move", which is a template, not an answer. Only a
  // "create" request produces an app, so only there is the plan worth keeping.
  // Every plan is now eligible, including a "create" one.
  //
  // That exception existed because a create request produced a scaffold the
  // model could not, so the deterministic plan was the better answer. The
  // assistant can build the app itself now, and keeping the exception made
  // build_app unreachable from a conversation: "build me an app to track
  // invoices" returned a four-step plan and never called the tool that would
  // have built it.
  const isPlan = modelReply.strategy === "plan";

  // A grounded answer or a confirmed save that only covers part of the
  // message is also eligible.
  //
  // Two live failures of the same shape. "Which database does my billing run
  // on, and what is today's date?" matched memory on the database, returned
  // that answer whole, and dropped the date half without a word. "Remember
  // that the server room door code is 4471. Then tell me every door code I
  // have saved." saved the fact and answered with a bare "Saved." — the
  // remember branch returns as soon as it recognises the opening clause and
  // never reads what follows. Both are covered by the same partial flag; the
  // agent can call search_memory, list_memories or current_datetime and
  // answer the rest, and if there is no model to ask, the partial reply below
  // still stands, because half an answer beats none.
  const isPartialAnswer = modelReply.partial === true
    && (modelReply.strategy === "answer" || modelReply.strategy === "acknowledge");

  if (modelReply.strategy === "no-answer" || isPlan || isPartialAnswer) {
    // When the deterministic path already found or just wrote the fact, hand
    // it over rather than making the model search for it again. Asked the
    // database and the date, memory had matched the database — and the
    // agent's own search_memory then came back empty and it reported the
    // database as unrecorded. Rediscovering a fact we are already holding is
    // a coin flip we do not need to take.
    const known = isPartialAnswer
      ? modelReply.strategy === "answer"
        ? modelReply.groundedOn.map((id) => input.memoryContext?.find((entry) => entry.id === id))
          .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
          .map((entry) => entry.body)
        // The acknowledge case: groundedOn is empty, since nothing was
        // searched — this was a write, not a retrieval. What was actually
        // written is what needs to be handed over instead.
        : input.memoryWrite?.savedBodies ?? []
      : [];

    // A "plan" reply's buildRequest is the merged text — the original request
    // plus a clarifying answer, when there was one — while input.userMessage
    // is only ever this single turn. Caught live: "Build me something to help
    // my business", then asked to clarify, answered "customers with email,
    // phone and company". The composer correctly merged those into one build
    // request and returned strategy "plan" — and the agent was then handed
    // only the current turn, "customers with email, phone and company", with
    // no idea it was ever about a build. It searched the user's documents for
    // "customers" and reported finding nothing. Passing the merged text here
    // is what the composer already computed and this branch already trusts;
    // not using it was passing up the answer sitting one line above.
    //
    // For a "create" plan specifically, the deterministic path has already
    // decided this is a build — that is the entire reason this branch exists.
    // The agent still gets to choose its own tool, and on the next attempt at
    // this exact scenario it chose plan_app over build_app: it worked out
    // what the app would contain, correctly, and then invented a description
    // of a "Build screen" with a "Plan" selector that this app does not have,
    // rather than building anything. Stating the right tool by name is the
    // same move already proven twice on this branch — the date stated
    // outright rather than left to current_datetime, a fact stated as already
    // saved rather than left to the model's own search — because a model that
    // is told what to do and does something else anyway is not fixed by
    // asking more politely; it is fixed by removing the choice that goes
    // wrong.
    // Naming a file to write is not asking for an app, however create-shaped
    // the sentence looks.
    //
    // "Create a file called launch-check.txt containing the single line: it
    // works" reaches the composer's create plan, because it does open with
    // "create". Instructing build_app from there set two parts of the system
    // against each other: agentLoop withholds the scaffolding tools from a
    // write that names its file, so the model was ordered to call a tool it
    // could not see, produced nothing, and the turn fell back to a generic
    // four-step plan. No file was written at all - worse than the spurious
    // build_app it replaced.
    //
    // The same classifier both sites already consult decides it, so they can
    // no longer disagree. classifyIntent tests generate before write, so
    // "build me a todo app" is untouched and keeps its instruction.
    //
    // "it" spelled out first, before this check and before the classifier
    // that decides how a failure is reported. Resolved only in the loop, "now
    // add a line saying omega to the end of it" was still no action to this
    // function: the composer's create plan got the build_app instruction
    // appended - "Do not stop at explaining what it would contain" - and the
    // word "contain" in that sentence made the loop's classifier read the
    // whole thing as a request for a file's contents, so the tools that
    // write were withheld from a request to write. See resolveFilePronoun.
    const impliedFile = resolveFilePronoun(effectiveMessage, input.sessionId);
    // The project, when no file was meant: "add a notes field to the plants",
    // "run its smoke test", "what files did that create?".
    const impliedProject = impliedFile ? null : resolveProjectReference(effectiveMessage, input.sessionId);
    const implied = impliedFile ?? impliedProject;
    const planIntent = classifyIntent(implied?.request ?? modelReply.buildRequest ?? "");
    const planWritesANamedFile = planIntent.kind === "write" && planIntent.hasTarget;
    // The build_app instruction goes only with a request for an app. The
    // composer's "create" plan fires on the word "build" anywhere, so "every
    // weekday at 8am ask me whether the build passed" - a schedule - reached
    // the model with "Call build_app with this" appended.
    const planWantsAnApp = planIntent.kind === "generate"
      || (planIntent.kind === undefined && !looksLikeScheduleRequest(modelReply.buildRequest ?? ""));

    // A remembered fact with a trailing request: the trailing clause is what
    // the model is asked, with the fact marked as already stored. Handed the
    // whole sentence, the model called remember a second time on one run and
    // answered "No changes were made." on the next - the save it was reading
    // about had already happened without it. And when the trailing clause
    // is itself a list of what is saved, no model is needed at all.
    const trailing = isPartialAnswer && modelReply.strategy === "acknowledge"
      ? trailingRequest(input.userMessage)
      : null;
    if (trailing && input.sessionId && isListMemoriesRequest(trailing)) {
      const listed = resolveListMemories(input, null, trailing);
      if (listed) {
        return { ...listed, assistantMessage: `Saved.\n\n${listed.assistantMessage}`, strategy: "acknowledge" };
      }
    }

    const question = implied
      ? implied.request
      : isPlan && modelReply.buildRequest
        ? modelReply.planTaskType === "create" && !planWritesANamedFile && planWantsAnApp
          ? `${modelReply.buildRequest}\n\nCall build_app with this. Not plan_app — the user wants it `
            + `actually built, not described. Do not stop at explaining what it would contain.`
          : modelReply.buildRequest
        : trailing ?? undefined;

    // This branch is where real work happens — it is the one that reaches the
    // agent and its tools. Recording here rather than on every turn keeps the
    // store to things there is actually something to resume, instead of
    // filing a "task" for every greeting.
    if (input.sessionId && !resuming) {
      recordTask(input.sessionId, {
        request: effectiveMessage,
        taskType: detectTaskType(effectiveMessage),
        status: "executing"
      });
    }

    const generated = await answerWithLocalModel(
      { ...input, userMessage: effectiveMessage, ...(impliedFile ? { impliedFile: impliedFile.file } : {}) },
      known,
      question,
      // Authorised for this turn only, and only for the exact tool the user
      // was asked about. An approval does not become a standing permission.
      approving ? new Set([approving.tool]) : undefined
    );

    // The gate refused something. Hold the offer open so the user's "yes"
    // has a specific action to attach to, rather than being read as blanket
    // permission for whatever comes next.
    if (input.sessionId && generated?.awaitingConfirmation) {
      recordPendingConfirmation(input.sessionId, {
        tool: generated.awaitingConfirmation.tool,
        arguments: generated.awaitingConfirmation.arguments,
        request: effectiveMessage
      });
    }

    if (input.sessionId) {
      updateTask(input.sessionId, generated
        ? {
          status: "succeeded",
          // Names only: the task store is a record of what ran, not the
          // source of a user-facing label.
          toolsUsed: generated.toolsUsed.map((used) => used.name),
          lastResult: generated.text
        }
        // No local model to ask. The work did not fail on its merits — it never
        // ran — so it stays resumable and says why, rather than being recorded
        // as a failure or quietly dropped.
        : { status: "blocked", error: "No local model was available to run this." });
    }

    // Read back rather than reconstructed, so what the dialog offers is
    // exactly what a later approval will consume.
    const nowPending = input.sessionId ? getPendingConfirmation(input.sessionId) : null;
    const described = nowPending ? describePendingAction(nowPending) : null;

    // An order the model could not carry out is reported as that. The
    // fallback below is the composer's reply, and for a "plan" it is a
    // generic four-step template - "1. Write down what done looks like for
    // now add a line saying omega to the end of it" was returned, verbatim,
    // for a request to append one line to a file.
    //
    // A create plan is the exception: with no model at all, the deterministic
    // generator still builds it from the "Build this" control, so the plan is
    // a real deliverable there rather than a template.
    const failedIntent = classifyIntent(implied?.request ?? effectiveMessage);
    const deterministicBuild = isPlan && modelReply.planTaskType === "create" && Boolean(modelReply.buildRequest)
      && failedIntent.kind !== "write";
    if (!generated && !deterministicBuild && failedIntent.action) {
      const text = "I could not complete that. The local model did not manage to carry it out - "
        + "nothing was changed. Try again, or say the file or command in full.";
      return {
        model: "memory",
        assistantMessage: text,
        inputTokens: modelReply.inputTokens,
        outputTokens: estimateTokens(text),
        strategy: "failed",
        toolsUsed: [],
        groundedOn: [],
        groundedOnHistory: 0
      };
    }

    if (generated) {
      return {
        model: generated.model,
        assistantMessage: generated.text,
        inputTokens: modelReply.inputTokens,
        outputTokens: estimateTokens(generated.text),
        // A distinct strategy: this was written by a model, not quoted from
        // anything the user saved, and the client labels provenance from it.
        strategy: "generated",
        toolsUsed: generated.toolsUsed,
        ...(nowPending && described
          ? { pendingConfirmation: { tool: nowPending.tool, ...described } }
          : {}),
        // No build offer here. Only a "create" plan survives to be built, and
        // neither case that reaches this branch is one — so carrying the
        // discarded plan's build request through put a "Build this" button
        // under a two-sentence explanation of what a mutex is.
        buildRequest: undefined,
        groundedOn: [],
        groundedOnHistory: 0
      };
    }
  }

  return toResult(modelReply);
}

/** A reply written here, by neither a model nor the composer. */
function deterministicResult(
  request: string,
  text: string,
  strategy: string,
  pending?: { tool: string; verb: string; target: string }
): OrchestratorResult {
  return {
    model: "memory",
    assistantMessage: text,
    inputTokens: estimateTokens(request),
    outputTokens: estimateTokens(text),
    strategy,
    toolsUsed: [],
    groundedOn: [],
    groundedOnHistory: 0,
    ...(pending ? { pendingConfirmation: pending } : {})
  };
}

/** Every memory the session has, or the prompt's few when the caller gave no list. */
function allMemories(input: OrchestratorInput): Array<{ id: string; body: string; pinned?: boolean }> {
  const listed = input.listMemories?.();
  if (listed) return listed;
  return (input.memoryContext ?? [])
    .filter((entry): entry is typeof entry & { id: string } => typeof entry.id === "string")
    .map((entry) => ({ id: entry.id, body: entry.body, pinned: entry.pinned }));
}

/**
 * "what do you know about me", "list everything you have saved" - the list,
 * read straight from the store.
 *
 * This went to the model, which either called list_memories and then also
 * remember (on a request to list), or called nothing and answered "I don't
 * have any specific information about you" with the facts sitting in the
 * session. A list is not a judgement call.
 */
function resolveListMemories(
  input: OrchestratorInput,
  approving: PendingConfirmation | null,
  effectiveMessage: string
): OrchestratorResult | null {
  if (approving || !input.sessionId || !isListMemoriesRequest(effectiveMessage)) return null;

  const memories = allMemories(input);
  if (memories.length === 0) {
    return deterministicResult(effectiveMessage,
      "Nothing is saved yet. Tell me something to remember and I will keep it.", "list");
  }
  const lines = memories.map((memory) => `- ${memory.pinned ? "[important] " : ""}${memory.body}`).join("\n");
  return deterministicResult(effectiveMessage, `Saved so far (${memories.length}):\n${lines}`, "list");
}

/**
 * "what schedules do I have" - the list, read from the store.
 *
 * This was answered from the transcript ("You mentioned this earlier: every
 * weekday at 8am ask me...") - the request that made the schedule, quoted
 * back as if it were the answer.
 */
function resolveListSchedules(
  input: OrchestratorInput,
  approving: PendingConfirmation | null,
  effectiveMessage: string
): OrchestratorResult | null {
  if (approving || !input.listSchedules || !isListSchedulesRequest(effectiveMessage)) return null;

  const schedules = input.listSchedules();
  if (schedules.length === 0) {
    return deterministicResult(effectiveMessage,
      "No schedules are set. Say when and what - \"every weekday at 8am ask me whether the build passed\" - and I will add one.",
      "list");
  }
  const lines = schedules
    .map((schedule) => `- ${schedule.name}: ${schedule.cadenceLabel}. ${schedule.actionLabel}${schedule.enabled ? "" : " (paused)"}`)
    .join("\n");
  return deterministicResult(effectiveMessage, `Schedules (${schedules.length}):\n${lines}`, "list");
}

type ScheduleSummary = { id: string; name: string; cadenceLabel: string; actionLabel: string; enabled: boolean };

/** Words too common to tell one schedule from another. */
const scheduleStopWords = new Set([
  "the", "a", "an", "my", "me", "to", "for", "about", "that", "this", "and", "of", "on", "at",
  "every", "day", "daily", "reminder", "schedule", "task", "job", "ask", "check"
]);

/**
 * Collapse "9:00 am" and "9 am" to "9am" so a time named loosely ("the 9am
 * reminder") still meets the cadence text ("Every day at 9:00 AM.").
 */
function normalizeScheduleText(value: string): string {
  return value.toLowerCase()
    .replace(/(\d{1,2}):00\s*([ap]m)/g, "$1$2")
    .replace(/(\d{1,2})\s+([ap]m)/g, "$1$2");
}

type ScheduleMatch =
  | { kind: "one"; schedule: ScheduleSummary }
  | { kind: "several"; candidates: ScheduleSummary[] }
  | { kind: "none" };

/**
 * Which schedule the user meant, matched loosely against its name, its action
 * and its cadence. A single containment wins outright; otherwise the schedule
 * sharing the most words with the request does, and a tie is reported rather
 * than guessed - cancelling the wrong schedule is exactly what confirmation is
 * meant to prevent.
 */
function matchSchedule(target: string, schedules: ScheduleSummary[]): ScheduleMatch {
  const needle = normalizeScheduleText(target).trim();
  if (!needle) return { kind: "none" };

  const hay = (schedule: ScheduleSummary) =>
    normalizeScheduleText(`${schedule.name} ${schedule.actionLabel} ${schedule.cadenceLabel}`);

  const contained = schedules.filter((schedule) =>
    normalizeScheduleText(schedule.name) === needle || hay(schedule).includes(needle));
  if (contained.length === 1) return { kind: "one", schedule: contained[0] };

  const words = needle.split(/\s+/).filter((word) => word.length > 1 && !scheduleStopWords.has(word));
  const scored = schedules
    .map((schedule) => ({ schedule, score: words.filter((word) => hay(schedule).includes(word)).length }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { kind: "none" };
  if (scored.length === 1 || scored[0].score > scored[1].score) return { kind: "one", schedule: scored[0].schedule };
  const top = scored[0].score;
  return { kind: "several", candidates: scored.filter((entry) => entry.score === top).map((entry) => entry.schedule) };
}

/** How schedules are listed back when a name matches none, or several. */
function listSchedulesBrief(schedules: ScheduleSummary[]): string {
  return schedules
    .map((schedule) => `- ${schedule.name}: ${schedule.cadenceLabel}${schedule.enabled ? "" : " (paused)"}`)
    .join("\n");
}

/**
 * Cancelling a schedule, all of it: the request that names one, the answer that
 * declines, and the approval that removes it. A confirm-then-do flow like
 * forget and delete_document, because a cancelled schedule is gone - re-adding
 * it means restating its cadence and action from scratch.
 */
function resolveRemoveSchedule(
  input: OrchestratorInput,
  approving: PendingConfirmation | null,
  effectiveMessage: string
): OrchestratorResult | null {
  const sessionId = input.sessionId;
  if (!sessionId || !input.removeSchedule || !input.listSchedules) return null;

  const reply = (text: string, strategy = "schedule", pending?: { tool: string; verb: string; target: string }) =>
    deterministicResult(effectiveMessage, text, strategy, pending);
  const schedules = input.listSchedules();

  if (approving?.tool === "delete_schedule") {
    if (approving.arguments?.all === true) {
      const removed = schedules.filter((schedule) => input.removeSchedule!(schedule.id)).length;
      return reply(removed > 0
        ? `Cancelled every schedule: ${removed} of them.`
        : "No schedules were set, so nothing was cancelled.");
    }
    const id = typeof approving.arguments?.id === "string" ? approving.arguments.id : "";
    const schedule = schedules.find((entry) => entry.id === id);
    if (!schedule) return reply("That schedule is no longer set, so nothing was cancelled.");
    return reply(input.removeSchedule(schedule.id)
      ? `Cancelled the schedule "${schedule.name}".`
      : "The schedule could not be cancelled, so nothing was changed.");
  }
  if (approving) return null;

  // "no" to a standing offer withdraws it, the same as forget.
  if (isDecline(effectiveMessage) && getPendingConfirmation(sessionId)?.tool === "delete_schedule") {
    clearPendingConfirmation(sessionId);
    return reply("Kept. Nothing was cancelled.");
  }

  const parsed = parseRemoveScheduleRequest(effectiveMessage);
  if (!parsed) return null;

  if (schedules.length === 0) return reply("No schedules are set, so there is nothing to cancel.");

  const offer = (pending: Omit<PendingConfirmation, "askedAt">, text: string) => {
    recordPendingConfirmation(sessionId, pending);
    return reply(text, "confirm", { tool: pending.tool, ...describePendingAction({ ...pending, askedAt: Date.now() }) });
  };

  if (parsed.kind === "all") {
    return offer(
      { tool: "delete_schedule", arguments: { all: true }, request: effectiveMessage },
      `This would cancel every schedule - ${schedules.length} of them. Say yes to cancel them all, or no to keep them.`
    );
  }

  // "cancel my reminder" with nothing to name it: the one schedule if there is
  // only one, otherwise a request to say which.
  if (!parsed.target.trim()) {
    if (schedules.length === 1) {
      const only = schedules[0];
      return offer(
        { tool: "delete_schedule", arguments: { id: only.id, name: only.name }, request: effectiveMessage },
        `This would cancel the schedule "${only.name}" (${only.cadenceLabel}). Say yes to cancel it, or no to keep it.`
      );
    }
    return reply(`Which schedule should I cancel? Your schedules:\n${listSchedulesBrief(schedules)}`);
  }

  const match = matchSchedule(parsed.target, schedules);
  if (match.kind === "one") {
    return offer(
      { tool: "delete_schedule", arguments: { id: match.schedule.id, name: match.schedule.name }, request: effectiveMessage },
      `This would cancel the schedule "${match.schedule.name}" (${match.schedule.cadenceLabel}). Say yes to cancel it, or no to keep it.`
    );
  }
  if (match.kind === "several") {
    return reply(`Several schedules match that:\n${listSchedulesBrief(match.candidates)}\n\nSay which one to cancel, by name.`);
  }
  return reply(`No schedule matches "${parsed.target}", so nothing was cancelled. Your schedules:\n${listSchedulesBrief(schedules)}`);
}

/**
 * Pausing or resuming a schedule. No confirmation: unlike cancelling, a pause
 * is reversible and keeps the schedule, so it is a level 2 change like any
 * other. The model's own answer to "turn off the 9am reminder" was to create a
 * second one, which is why this is decided here.
 */
function resolveToggleSchedule(
  input: OrchestratorInput,
  approving: PendingConfirmation | null,
  effectiveMessage: string
): OrchestratorResult | null {
  if (approving || !input.setScheduleEnabled || !input.listSchedules) return null;
  const parsed = parseToggleScheduleRequest(effectiveMessage);
  if (!parsed) return null;

  const reply = (text: string) => deterministicResult(effectiveMessage, text, "schedule");
  const schedules = input.listSchedules();
  if (schedules.length === 0) return reply("No schedules are set, so there is nothing to change.");

  const verb = parsed.enabled ? "resume" : "pause";
  const done = parsed.enabled ? "Resumed" : "Paused";

  if (parsed.kind === "all") {
    const changed = schedules.filter((schedule) => input.setScheduleEnabled!(schedule.id, parsed.enabled)).length;
    return reply(`${done} ${changed} schedule${changed === 1 ? "" : "s"}.`);
  }

  if (!parsed.target.trim() && schedules.length > 1) {
    return reply(`Which schedule should I ${verb}? Your schedules:\n${listSchedulesBrief(schedules)}`);
  }
  const target = parsed.target.trim() || schedules[0].name;

  const match = matchSchedule(target, schedules);
  if (match.kind === "one") {
    return reply(input.setScheduleEnabled(match.schedule.id, parsed.enabled)
      ? `${done} the schedule "${match.schedule.name}" (${match.schedule.cadenceLabel}).`
      : "That schedule could not be changed, so nothing happened.");
  }
  if (match.kind === "several") {
    return reply(`Several schedules match that:\n${listSchedulesBrief(match.candidates)}\n\nSay which one to ${verb}, by name.`);
  }
  return reply(`No schedule matches "${target}", so nothing was changed. Your schedules:\n${listSchedulesBrief(schedules)}`);
}

/**
 * "what did I just ask you?" - answered from the transcript.
 *
 * The composer's recall path matched it against memory and quoted the server
 * room code back; the question was about the previous turn.
 */
function resolveLastAsk(
  input: OrchestratorInput,
  approving: PendingConfirmation | null,
  effectiveMessage: string
): OrchestratorResult | null {
  if (approving) return null;

  const current = effectiveMessage.trim();
  const userTurns = (input.history ?? [])
    .filter((turn) => turn.role === "user" && turn.content.trim().length > 0 && turn.content.trim() !== current)
    .map((turn) => turn.content.trim());

  // "what was the second thing I told you?" - counted from the start of the
  // conversation. The model answered "I don't have any saved memories of
  // things you told me" with the transcript in front of it.
  const nth = parseNthThingRequest(effectiveMessage);
  if (nth !== null) {
    const picked = nth === -1 ? userTurns[userTurns.length - 1] : userTurns[nth - 1];
    if (!picked) {
      return deterministicResult(effectiveMessage, userTurns.length === 0
        ? "You have not told me anything yet in this conversation."
        : `You have said ${userTurns.length} thing${userTurns.length === 1 ? "" : "s"} so far in this conversation, not that many.`, "recap");
    }
    return deterministicResult(effectiveMessage, `You said: "${picked}"`, "recap");
  }

  if (!isLastAskRequest(effectiveMessage)) return null;
  // The client may send the current message as the last turn of the history.
  const previous = [...(input.history ?? [])]
    .reverse()
    .find((turn) => turn.role === "user" && turn.content.trim().length > 0 && turn.content.trim() !== current);

  return deterministicResult(effectiveMessage, previous
    ? `You asked: "${previous.content.trim()}"`
    : "That is the first thing you have asked me in this conversation.", "recap");
}

/** At most this many saved memories are listed back when a name matches none. */
const listedWhenUnmatched = 8;

/**
 * The forget flow, all of it: the request that names a memory, the answer
 * that declines, and the approval that deletes.
 *
 * Null when this turn is not about forgetting, which is nearly always. The
 * offer is recorded with the memory's stored wording and matched again on
 * approval rather than trusted as an id - the list may have changed between
 * the question and the answer.
 */
function resolveForget(
  input: OrchestratorInput,
  approving: PendingConfirmation | null,
  effectiveMessage: string
): OrchestratorResult | null {
  const sessionId = input.sessionId;
  if (!sessionId) return null;
  const reply = (text: string, strategy = "forget", pending?: { tool: string; verb: string; target: string }) =>
    deterministicResult(effectiveMessage, text, strategy, pending);
  const offer = (pending: Omit<PendingConfirmation, "askedAt">, text: string) => {
    recordPendingConfirmation(sessionId, pending);
    return reply(text, "confirm", { tool: pending.tool, ...describePendingAction({ ...pending, askedAt: Date.now() }) });
  };

  if (approving?.tool === "forget") {
    if (approving.arguments?.all === true) {
      const count = input.forgetAllMemories?.() ?? 0;
      return reply(count > 0
        ? `Deleted every saved memory: ${count} of them. Nothing is saved now.`
        : "Nothing was saved, so nothing was deleted.");
    }
    const fact = typeof approving.arguments?.fact === "string" ? approving.arguments.fact : "";
    const match = matchMemories(fact, allMemories(input));
    if (match.kind !== "one") {
      return reply(`Nothing saved matches "${fact}" any more, so nothing was deleted.`);
    }
    const removed = input.forgetMemory?.(match.memory.id) ?? false;
    return reply(removed
      ? `Deleted from memory: ${match.memory.body}`
      : "The delete did not go through, so nothing was removed.");
  }
  if (approving) return null;

  // "no" to a standing offer withdraws it. Left standing, the offer would
  // wait for the window to expire, and a "yes" meant for something else
  // could land on it in the meantime.
  if (isDecline(effectiveMessage) && getPendingConfirmation(sessionId)?.tool === "forget") {
    clearPendingConfirmation(sessionId);
    return reply("Kept. Nothing was deleted.");
  }

  const parsed = parseForgetRequest(effectiveMessage);
  if (!parsed) return null;

  const memories = allMemories(input);
  if (memories.length === 0) return reply("Nothing is saved, so there is nothing to forget.");

  if (parsed.kind === "all") {
    return offer(
      { tool: "forget", arguments: { all: true }, request: effectiveMessage },
      `This would delete every saved memory - ${memories.length} of them. Say yes to delete them all, or no to keep them.`
    );
  }

  const match = matchMemories(parsed.target, memories);
  if (match.kind === "one") {
    return offer(
      { tool: "forget", arguments: { fact: match.memory.body }, request: effectiveMessage },
      `This would delete the saved memory "${match.memory.body}". Say yes to delete it, or no to keep it.`
    );
  }
  if (match.kind === "several") {
    const listed = match.candidates.map((memory) => `- ${memory.body}`).join("\n");
    return reply(`Several saved memories match "${parsed.target}":\n${listed}\n\nSay which one to forget, in its own words.`);
  }

  const shown = memories.slice(0, listedWhenUnmatched).map((memory) => `- ${memory.body}`).join("\n");
  const more = memories.length > listedWhenUnmatched ? `\n- and ${memories.length - listedWhenUnmatched} more` : "";
  return reply(`Nothing saved matches "${parsed.target}", so nothing was deleted. What is saved:\n${shown}${more}`);
}

/**
 * Marking a memory as important, decided here for the same reason as
 * forgetting - and because it never reached the model at all: "mark the
 * server room code as important" reads as a statement, so the composer
 * answered "Got it." and nothing was marked.
 */
function resolvePin(
  input: OrchestratorInput,
  approving: PendingConfirmation | null,
  effectiveMessage: string
): OrchestratorResult | null {
  if (approving || !input.sessionId || !input.pinMemory) return null;
  const parsed = parsePinRequest(effectiveMessage);
  if (!parsed) return null;

  const reply = (text: string) => deterministicResult(effectiveMessage, text, "pin");
  const memories = allMemories(input);
  const match = matchMemories(parsed.target, memories);

  if (match.kind === "several") {
    const listed = match.candidates.map((memory) => `- ${memory.body}`).join("\n");
    return reply(`Several saved memories match "${parsed.target}":\n${listed}\n\nSay which one, in its own words.`);
  }
  if (match.kind === "none") {
    // A sentence that merely sounds like a pin request is left to the rest
    // of the pipeline; see PinRequest.explicit.
    if (!parsed.explicit) return null;
    if (memories.length === 0) return reply("Nothing is saved yet, so there is nothing to mark.");
    const shown = memories.slice(0, listedWhenUnmatched).map((memory) => `- ${memory.body}`).join("\n");
    return reply(`Nothing saved matches "${parsed.target}", so nothing was marked. What is saved:\n${shown}`);
  }

  const changed = input.pinMemory(match.memory.id, parsed.pinned);
  if (!changed) return reply("That could not be changed, so nothing was marked.");
  return reply(parsed.pinned
    ? `Marked as important: ${match.memory.body}`
    : `No longer marked as important: ${match.memory.body}`);
}

/**
 * Parse "save a document called X with the text Y" into a title and body.
 *
 * Explicit and shape-bound on purpose: it wants "document" named, a title after
 * called/titled/named, and a body after with/containing/saying or a colon.
 * Anything looser is left to the model rather than risk turning an ordinary
 * sentence into a stored document.
 */
export function parseSaveDocumentRequest(message: string): { title: string; body: string } | null {
  const text = (message ?? "").trim();
  const match = /^(?:please\s+)?(?:save|create|make|store|write|add|start)\s+(?:me\s+)?(?:a|an|the)?\s*(?:new\s+)?(?:knowledge\s+)?document\s+(?:called|titled|named|labell?ed)\s+["']?(.+?)["']?\s*(?:with(?:\s+the)?\s+(?:text|content|body)?|containing|that\s+says|saying|[:,-])\s*:?\s*["']?([\s\S]+?)["']?$/i
    .exec(text);
  if (!match) return null;
  const title = match[1].trim();
  const body = match[2].trim();
  if (!title || !body) return null;
  return { title, body };
}

/**
 * Save a knowledge document deterministically, off the model. Mirrors the
 * memory resolvers: the request carries the title and body, and the only work
 * is storing them. A title that already exists is refused rather than
 * duplicated, the same as write_document does.
 */
function resolveSaveDocument(
  input: OrchestratorInput,
  approving: PendingConfirmation | null,
  effectiveMessage: string
): OrchestratorResult | null {
  if (approving || !input.saveDocument) return null;
  const parsed = parseSaveDocumentRequest(effectiveMessage);
  if (!parsed) return null;

  const reply = (text: string) => deterministicResult(effectiveMessage, text, "document");
  const exists = (input.documents ?? []).some(
    (document) => document.title.trim().toLowerCase() === parsed.title.toLowerCase()
  );
  if (exists) {
    return reply(`A document called "${parsed.title}" already exists. Ask me to update it, or use a different title.`);
  }

  const saved = input.saveDocument(parsed.title, parsed.body);
  return saved
    ? reply(`Saved the document "${parsed.title}".`)
    : reply("There is nowhere to save documents right now, so nothing was stored.");
}

/** Whether the request asks to see the list of knowledge documents (plural). */
export function isListDocumentsRequest(message: string): boolean {
  const text = (message ?? "").toLowerCase();
  if (/\bdocuments?\s+(?:called|titled|named)\b/.test(text)) return false;
  return /\b(?:list|show|see|view)\s+(?:me\s+)?(?:my|the|all|any)?\s*documents\b/.test(text)
    || /\bwhat\s+documents\b/.test(text)
    || /\bwhich\s+documents\b/.test(text)
    || /\bhow\s+many\s+documents\b/.test(text)
    || /\b(?:my|the|all)\s+documents\b\s*\??$/.test(text);
}

/** List the knowledge documents deterministically, off the model. */
function resolveListDocuments(
  input: OrchestratorInput,
  approving: PendingConfirmation | null,
  effectiveMessage: string
): OrchestratorResult | null {
  if (approving || !isListDocumentsRequest(effectiveMessage)) return null;
  const documents = input.documents ?? [];
  if (documents.length === 0) {
    return deterministicResult(effectiveMessage,
      "You have no documents saved yet. Say \"save a document called X with ...\" to add one.", "list");
  }
  const lines = documents.map((document) => `- ${document.title}`).join("\n");
  return deterministicResult(effectiveMessage, `Your documents (${documents.length}):\n${lines}`, "list");
}

/**
 * Parse "plan an app for X" into the description to plan. The leading verb must
 * be plan/outline/sketch - a plan, not a build - and it must name an app-like
 * thing, so "plan my week" or "build an app" do not match.
 */
export function parsePlanAppRequest(message: string): string | null {
  const text = (message ?? "").trim();
  const match = /^(?:please\s+)?(?:plan|outline|sketch)\s+(?:out\s+|me\s+)?(?:a|an|the)?\s*(?:app|application|tool|program|system|tracker|dashboard|feature|api)\b\s*(?:for|to|that|which|about|:|-)?\s*(.+)$/i
    .exec(text);
  if (!match) return null;
  // Strip a trailing "do not build it yet" / "just plan it" clause: left in, it
  // fed planProject junk records ("Not", "Yet" from "do not build it yet").
  const description = match[1]
    .replace(/\s*[,;.-]?\s*(?:but\s+)?(?:do\s+not|don'?t|do\s*nt)\s+build\b[\s\S]*$/i, "")
    .replace(/\s*[,;.-]?\s*(?:without\s+building|just\s+plan(?:ning)?|only\s+plan(?:ning)?|no\s+build|for\s+now|not\s+yet)\b[\s\S]*$/i, "")
    .trim();
  return description.length >= 3 ? description : null;
}

/**
 * Plan an app deterministically, off the model. Mirrors the other resolvers:
 * planProject already turns a description into records and fields, so a plan
 * request needs no model and never turns into a build.
 */
function resolvePlanApp(
  _input: OrchestratorInput,
  approving: PendingConfirmation | null,
  effectiveMessage: string
): OrchestratorResult | null {
  if (approving) return null;
  const description = parsePlanAppRequest(effectiveMessage);
  if (!description) return null;

  const spec = planProject(description);
  // Nothing concrete to store means there is nothing to plan yet; let the rest
  // of the pipeline ask for detail rather than print an empty plan.
  if (spec.entities.length === 0) return null;

  const entities = spec.entities
    .map((entity) => `- ${entity.label}: ${entity.fields.map((field) => `${field.name} (${field.type})`).join(", ")}`)
    .join("\n");
  return deterministicResult(
    effectiveMessage,
    `Here is a plan for "${spec.title}" (nothing built yet):\n${entities}\n\nSay "build it" when you want me to create it.`,
    "plan"
  );
}

/** Parse "add to my Roadmap document: hire two engineers" into a title and addition. */
export function parseAppendDocumentRequest(message: string): { title: string; addition: string } | null {
  const text = (message ?? "").trim();
  let match = /^(?:please\s+)?(?:add|append|put)\s+(?:this\s+)?to\s+(?:my|the)?\s*(.+?)\s+document\s*[:,-]\s*(.+)$/i.exec(text);
  if (match) return { title: match[1].trim(), addition: match[2].trim() };
  match = /^(?:please\s+)?(?:add|append|put)\s+(.+?)\s+(?:to|in|into)\s+(?:my|the)?\s*(.+?)\s+document\b/i.exec(text);
  if (match) return { title: match[2].trim(), addition: match[1].trim() };
  return null;
}

/** Append to a knowledge document deterministically, off the model. */
function resolveAppendDocument(
  input: OrchestratorInput,
  approving: PendingConfirmation | null,
  effectiveMessage: string
): OrchestratorResult | null {
  if (approving || !input.updateDocument) return null;
  const parsed = parseAppendDocumentRequest(effectiveMessage);
  if (!parsed) return null;

  const reply = (text: string) => deterministicResult(effectiveMessage, text, "document");
  const wanted = parsed.title.toLowerCase();
  const documents = input.documents ?? [];
  const doc = documents.find((document) => document.title.trim().toLowerCase() === wanted)
    ?? documents.find((document) => document.title.toLowerCase().includes(wanted));
  if (!doc) {
    return reply(`There is no document called "${parsed.title}". Say "save a document called ${parsed.title} with ..." to create it.`);
  }

  const next = doc.body.trimEnd() ? `${doc.body.trimEnd()}\n${parsed.addition}` : parsed.addition;
  return input.updateDocument(doc.id, next)
    ? reply(`Added to "${doc.title}".`)
    : reply(`I couldn't update "${doc.title}", so nothing was changed.`);
}

/** Parse "search my documents for X" / "find X in my documents" into the query. */
export function parseSearchDocumentsRequest(message: string): string | null {
  const text = (message ?? "").trim();
  let match = /^(?:please\s+)?(?:search|find|look)\s+(?:up\s+|through\s+|in\s+)?(?:my|the|all)?\s*documents?\s+(?:for|containing|about|mentioning|with)\s+(.+)$/i.exec(text);
  if (match) return match[1].trim().replace(/[?.!]+$/, "");
  match = /^(?:please\s+)?(?:search|find)\s+(.+?)\s+in\s+(?:my|the|all)?\s*documents?\b/i.exec(text);
  if (match) return match[1].trim().replace(/[?.!]+$/, "");
  return null;
}

/** Search the knowledge documents deterministically, off the model. */
function resolveSearchDocuments(
  input: OrchestratorInput,
  approving: PendingConfirmation | null,
  effectiveMessage: string
): OrchestratorResult | null {
  if (approving) return null;
  const query = parseSearchDocumentsRequest(effectiveMessage);
  if (!query) return null;

  const reply = (text: string) => deterministicResult(effectiveMessage, text, "list");
  const documents = input.documents ?? [];
  if (documents.length === 0) return reply("You have no documents saved yet.");

  const needle = query.toLowerCase();
  const matches = documents.filter(
    (document) => document.title.toLowerCase().includes(needle) || document.body.toLowerCase().includes(needle)
  );
  if (matches.length === 0) return reply(`Nothing in your documents mentions "${query}".`);
  const lines = matches.map((document) => `- ${document.title}`).join("\n");
  return reply(`Documents mentioning "${query}" (${matches.length}):\n${lines}`);
}

/**
 * Parse "delete my Scratch document" / "remove the document called Notes" into
 * the title to delete. Requires both a delete verb and the word "document", so
 * an ordinary sentence can't trigger a destructive op.
 */
export function parseDeleteDocumentRequest(message: string): string | null {
  const text = (message ?? "").trim();
  const verb = "(?:delete|remove|discard|trash|drop|erase|get\\s+rid\\s+of)";
  // "delete the document called/titled/named X"
  let match = new RegExp(
    `^(?:please\\s+)?${verb}\\s+(?:my|the|that)?\\s*(?:knowledge\\s+)?document\\s+(?:called|titled|named|labell?ed)\\s+["']?(.+?)["']?$`,
    "i"
  ).exec(text);
  if (match) return match[1].trim().replace(/[?.!]+$/, "");
  // "delete my X document"
  match = new RegExp(
    `^(?:please\\s+)?${verb}\\s+(?:my|the|that)?\\s*(.+?)\\s+(?:knowledge\\s+)?document\\b`,
    "i"
  ).exec(text);
  if (match) return match[1].trim().replace(/[?.!]+$/, "");
  return null;
}

/**
 * Delete a knowledge document deterministically, with a confirm-then-do flow.
 *
 * Left to the model, delete_document hit the level-3 permission gate, came back
 * "needs the user's confirmation", and the model retried with placeholder
 * titles across several rounds, invented a confirm_action tool, and returned an
 * empty reply - the document was never removed and no confirmation was ever
 * offered. Mirrors resolveForget: offer, then act on the user's "yes".
 */
function resolveDeleteDocument(
  input: OrchestratorInput,
  approving: PendingConfirmation | null,
  effectiveMessage: string
): OrchestratorResult | null {
  const sessionId = input.sessionId;
  if (!sessionId || !input.deleteDocument) return null;

  const reply = (text: string, strategy = "document", pending?: { tool: string; verb: string; target: string }) =>
    deterministicResult(effectiveMessage, text, strategy, pending);
  const documents = input.documents ?? [];
  const findDoc = (title: string) => {
    const wanted = title.trim().toLowerCase();
    return documents.find((document) => document.title.trim().toLowerCase() === wanted)
      ?? documents.find((document) => document.title.toLowerCase().includes(wanted));
  };

  if (approving?.tool === "delete_document") {
    const title = typeof approving.arguments?.title === "string" ? approving.arguments.title : "";
    const doc = findDoc(title);
    if (!doc) return reply(`There is no document called "${title}" any more, so nothing was deleted.`);
    const removed = input.deleteDocument(doc.id);
    return reply(removed
      ? `Deleted the document "${doc.title}".`
      : "The delete did not go through, so nothing was removed.");
  }
  if (approving) return null;

  // "no" to a standing delete offer withdraws it, the same as forget.
  if (isDecline(effectiveMessage) && getPendingConfirmation(sessionId)?.tool === "delete_document") {
    clearPendingConfirmation(sessionId);
    return reply("Kept. Nothing was deleted.");
  }

  const parsed = parseDeleteDocumentRequest(effectiveMessage);
  if (!parsed) return null;

  if (documents.length === 0) {
    return reply("You have no documents saved, so there is nothing to delete.");
  }

  const doc = findDoc(parsed);
  if (!doc) {
    const shown = documents.slice(0, listedWhenUnmatched).map((document) => `- ${document.title}`).join("\n");
    return reply(`There is no document called "${parsed}", so nothing was deleted. Your documents:\n${shown}`);
  }

  const pending = { tool: "delete_document", arguments: { title: doc.title }, request: effectiveMessage };
  recordPendingConfirmation(sessionId, pending);
  return reply(
    `This would delete the document "${doc.title}". Say yes to delete it, or no to keep it.`,
    "confirm",
    { tool: "delete_document", ...describePendingAction({ ...pending, askedAt: Date.now() }) }
  );
}

function toResult(modelReply: Awaited<ReturnType<ModelRouter["generate"]>>): OrchestratorResult {
  return {
    model: modelReply.model,
    assistantMessage: modelReply.output,
    inputTokens: modelReply.inputTokens,
    outputTokens: modelReply.outputTokens,
    strategy: modelReply.strategy,
    buildRequest: modelReply.buildRequest,
    groundedOn: modelReply.groundedOn,
    groundedOnHistory: modelReply.groundedOnHistory
  };
}

/** Rough token estimate, matching the router's own accounting. */
function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

/**
 * Ask a local model, or return null if there is not one to ask.
 *
 * Availability is checked per request rather than cached. A user starts Ollama
 * after the API, or stops it mid-session, and a cached "unavailable" would keep
 * the feature dark until a restart for no reason the user could see.
 */
async function answerWithLocalModel(
  input: OrchestratorInput,
  /** Facts already retrieved for this question, so the model need not re-find them. */
  known: string[] = [],
  /**
   * What to actually ask, when it differs from input.userMessage — the merged
   * buildRequest for a "plan" turn, which carries an earlier turn's context
   * that the current message alone does not.
   */
  askAs?: string,
  /** Tool names the user authorised this turn; see the permission ladder. */
  confirmedActions?: ReadonlySet<string>
): Promise<{
  text: string;
  model: string;
  toolsUsed: ToolOutcome[];
  awaitingConfirmation?: { tool: string; arguments: Record<string, unknown> };
} | null> {
  const config = readLocalModelConfig();
  const availability = await checkAvailability(config);
  if (!availability.available) return null;

  const { sessionId } = input;
  const onToolStart = sessionId ? (tool: string) => setActivity(sessionId, tool) : undefined;

  // The agent loop rather than a single completion.
  //
  // A one-shot call could only work with whatever context happened to be
  // attached to the request, which meant the model saw at most a handful of
  // memories and never the documents. Here it asks for what it needs and gets
  // the real thing back — and can follow one lookup with another.
  // Stated as fact rather than as a hint, and stated as already saved rather
  // than merely found. Without "do not save it again", a remember-then-ask
  // turn handed the fact over correctly and the model still called remember
  // on it a second time — redundant at best, and confusing when that second,
  // unnecessary write failed and the reply had to explain a failure that
  // never needed to happen.
  const baseQuestion = askAs ?? input.userMessage;

  const question = known.length > 0
    ? `${baseQuestion}\n\nAlready in the user's saved memory — it is stored, do not save it again, `
      + `just use it directly:\n`
      + known.map((fact) => `- ${fact}`).join("\n")
    : baseQuestion;

  // Worked down in order rather than betting on one.
  //
  // A model that is listed is not a model that will load. Asked to answer,
  // Ollama returned 500 "cudaMalloc failed: out of memory" for the 8B model
  // and a failed CPU buffer allocation for the 3B one — while the app went on
  // reporting the first as available and silently falling back on every single
  // question, with nothing on screen to say why.
  // Code work goes to the coding model when one is installed.
  //
  // The chat model runs everything by default, and for conversation that is
  // right. For editing a file it is not: asked to use edit_file on a real path,
  // the 1.9GB chat model replied "Got it - I'll keep that in mind for this
  // conversation" and called no tool at all. The tools were fine; the model
  // did not act. The same request to the coding model picks the tool.
  //
  // Put in front of the ordinary candidates rather than replacing them, so if
  // it fails to load the existing fallback still works its way down the list.
  const codeWork = isCodeWork(input.mode, input.userMessage ?? "");
  const ordinary = orderedCandidates(config.model, availability.installedModels, config.modelFromEnv ?? true);
  const coder = codeWork ? pickAuthorModel(availability.installedModels, "") : "";
  const candidates = coder && ordinary[0] !== coder
    ? [coder, ...ordinary.filter((name) => name !== coder)]
    : ordinary;
  const attempted: string[] = [];

  for (const model of candidates) {
    attempted.push(model);
    const result = await runAgent({ ...config, model }, question, {
    memories: (input.memoryContext ?? []).map((entry, index) => ({
      id: entry.id ?? `memory-${index}`,
      title: entry.title,
      body: entry.body,
      pinned: entry.pinned ?? false,
      createdAt: entry.createdAt ?? new Date(index).toISOString()
    })),
    knowledge: (input.knowledge ?? []).map((entry) => ({
      id: entry.id,
      title: entry.title,
      body: entry.body,
      pinned: entry.pinned ?? false,
      createdAt: entry.createdAt,
      documentTitle: entry.documentTitle
    })),
    saveMemory: input.saveMemory,
    forgetMemory: input.forgetMemory,
    documents: input.documents,
    saveDocument: input.saveDocument,
    updateDocument: input.updateDocument,
    deleteDocument: input.deleteDocument,
    pinMemory: input.pinMemory,
    launchApp: input.launchApp,
    stopApp: input.stopApp,
    runningApps: input.runningApps,
    authorApp: input.authorApp,
    confirmedActions,
    unattended: input.unattended,
    sessionId: input.sessionId,
    impliedFile: input.impliedFile,
    // The transcript the request already carries, so "what did I just ask you"
    // is answerable without saving every turn to memory first.
    conversation: input.history,
    // The user's own words, so a built app is named after what they asked for
    // rather than after the model's paraphrase of it.
    //
    // input.userMessage, not baseQuestion: baseQuestion is the constructed
    // prompt, and it carries the instruction telling the model to call
    // build_app. Naming an app from that produced folders called
    // calculator-call-build-app and snake-game-call-build-app - right at the
    // front, wrong from there on.
    request: input.userMessage
  }, fetch, onToolStart, input.onToken, input.unattended, input.cancel);

    if (result.ok) {
      return {
        text: result.text,
        model: `ollama/${result.model}`,
        toolsUsed: result.toolsUsed,
        ...(result.awaitingConfirmation ? { awaitingConfirmation: result.awaitingConfirmation } : {})
      };
    }

    // Only a model that could not be loaded, or that produced nothing at all,
    // is worth replacing. One that loaded and answered badly will answer
    // badly again, and trying every installed model against it just makes the
    // user wait.
    //
    // Logged either way. This used to return null in silence, which meant a
    // model failing mid-conversation was invisible: the caller fell back to a
    // deterministic reply that looks like a deliberate answer, and nothing
    // anywhere said the model had been asked and had failed.
    if (!result.modelUnusable) {
      console.warn(`[assist] ${model} could not answer: ${result.reason}`);
      return null;
    }
    console.warn(`[assist] ${model} unusable: ${result.reason}`);
  }

  if (attempted.length > 0) {
    console.error(`[assist] no local model could be loaded; tried ${attempted.join(", ")}`);
  }

  return null;
}

