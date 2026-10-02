import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import { agentById } from "@ascend/shared";
import { runAssistantOrchestrator } from "./services/orchestrator.js";
import type { AgentLens } from "./services/agentTools.js";
import { clearActivity, getActivity } from "./services/agentActivity.js";
import { normalizeAssistHistory } from "./services/assistContext.js";
import {
  appendTurn, cleanTitle, clearConversation, currentConversationId, deleteConversation, dropLastExchange, getConversation,
  isConversationId, listConversations, listTurns, resolveConversation, updateConversation
} from "./services/conversationStore.js";
import { isModelName, listChatModels } from "./services/modelCatalog.js";
import { takeContextUse } from "./services/contextUse.js";
import {
  forgetAllMemories,
  forgetMemory,
  listForgottenFacts,
  getMemoryAudit,
  listSessionMemories,
  maxMemoriesPerSession,
  memoryPersistenceError,
  recordMemoriesFromMessage,
  recordSingleMemory,
  relabelMemory,
  retrieveSessionMemories,
  setMemoryPinned
} from "./services/assistMemoryStore.js";
import {
  accountForToken,
  bearerToken,
  changePassword,
  login,
  logout,
  recoverWithCode,
  registerAccount
} from "./services/accounts.js";
import {
  checkRateLimit,
  clearRateLimit,
  clientKey,
  loginEmailRule,
  loginIpRule,
  passwordChangeRule,
  recordFailure,
  recoveryEmailRule,
  recoveryIpRule,
  registerIpRule
} from "./services/rateLimit.js";
import {
  addDocument,
  listDocuments,
  maxDocumentChars,
  removeDocument,
  retrieveKnowledgePassages
} from "./services/knowledgeStore.js";
import { isAllowedOrigin } from "./services/originPolicy.js";
import { checkAvailability, generate, readLocalModelConfig } from "./services/localModel.js";
import { pickAuthorModel } from "./services/appAuthor.js";
import { readPreferences, updatePreferences } from "./services/preferences.js";
import { getBuildInfo } from "./services/buildInfo.js";
import { getSystemCapabilities, toolsByLevel } from "./services/systemCapabilities.js";
import { describeTools, probeTools } from "./services/toolCenter.js";
import { addTask, listTasks, removeTask, setTaskDone } from "./services/taskListStore.js";
import {
  clearPendingConfirmation,
  describePendingAction,
  getPendingConfirmation
} from "./services/pendingConfirmation.js";
import { maxSynthesisCharacters, piperStatus, synthesize, type Cadence } from "./services/piperSpeech.js";
import { describeEmailAccount, knownProviders, readEmailAccount, removeEmailAccount, saveEmailAccount } from "./services/emailAccount.js";
import { phoneLinkStatus, sendWithAccount } from "./services/messaging.js";
import { extractDocumentText, maxDocumentBytes } from "./services/documentText.js";
import { maxImagesPerTurn, parseImages, warmVisionModel } from "./services/vision.js";
import path from "node:path";
import { maxAudioBytes, requiredChannels, requiredSampleRate, transcribe, whisperStatus } from "./services/whisperTranscribe.js";
import {
  addSchedule,
  describeAction,
  describeCadence,
  isCadence,
  isScheduleAction,
  listScheduleRuns,
  listSchedules,
  schedulePersistenceError,
  removeSchedule,
  setScheduleEnabled,
  type Schedule
} from "./services/scheduleStore.js";
import { isScheduleRunning, runScheduleNow } from "./services/scheduler.js";
import { listRunningApps, listBuiltApps, removeBuiltApp, startApp, stopApp } from "./services/appRunner.js";
import { listRenderings, latestRendering } from "./services/renderMockup.js";
import { getFlow, saveFlow } from "./services/flowStore.js";
import { readTelemetry, readIdentity } from "./services/systemTelemetry.js";
import { getResumableTask, getTask, isTaskRunning } from "./services/taskStore.js";
import { clearFinishedTasks, forgetFinishedTask, listFinishedTasks, maxFinishedPerSession } from "./services/taskHistory.js";
import { clearEvents, listEvents } from "./services/executionLog.js";
import { finishStages, getStage, stageLabels } from "./services/reasoningStage.js";
import { snapshot, toPrometheus } from "./services/metrics.js";
import {
  armCommands,
  armedUntil,
  commandHistory,
  commandsArmed,
  disarmCommands
} from "./services/commandRunner.js";
import {
  listWorkspace,
  looksBinary,
  maxListedFiles,
  readWorkspaceFile,
  workspaceRoot
} from "./services/workspace.js";

type AssistRouteMode = "general" | "build" | "code" | "debug" | "research" | "plan" | "coding" | "business" | "creator";

const maxSessionIdLength = 100;
/** Candidates handed to the composer for relevance scoring. */
const memoryCandidateLimit = 25;

/** Client-supplied session ids are untrusted; reject anything unusable. */
function normalizeSessionId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxSessionIdLength) {
    return null;
  }
  return trimmed;
}

/**
 * The key memory is filed under.
 *
 * A signed-in user owns their memory, so it follows them to any browser. Signed
 * out, the anonymous session id still works — requiring an account just to try
 * the assistant would be worse than the problem it solves. The `user:` prefix
 * keeps the two namespaces from ever colliding.
 */
function resolveMemoryKey(req: express.Request, sessionId: string | null): string | null {
  const account = accountForToken(bearerToken(req.headers.authorization));
  if (account) return `user:${account.id}`;
  return sessionId;
}

/** A schedule as the screens see it: its words, and whether it is running now. */
function scheduleView(schedule: Schedule) {
  return {
    ...schedule,
    cadenceLabel: describeCadence(schedule.cadence),
    actionLabel: describeAction(schedule.action),
    running: isScheduleRunning(schedule.id)
  };
}

/** Client-supplied cadence, or undefined to let the voice's default stand. */
function normalizeCadence(value: unknown): Cadence | undefined {
  if (value === "measured" || value === "brisk" || value === "playful" || value === "deliberate") {
    return value;
  }
  return undefined;
}

/**
 * The active agent a request names, if it names a real one.
 *
 * Only an id crosses the wire, and only the catalogue's own entry is used: a
 * client cannot send a persona of its own making into the system prompt. An
 * unknown or missing id is no agent, not an error - the turn is answered as
 * it would have been anyway.
 */
function agentFromRequest(req: express.Request): AgentLens | undefined {
  const id = typeof req.body?.agentId === "string" ? req.body.agentId.trim() : "";
  const agent = id ? agentById(id) : undefined;
  return agent
    ? { name: agent.name, role: agent.role, description: agent.description, focus: agent.focus }
    : undefined;
}

function normalizeAssistMode(mode: unknown): AssistRouteMode {
  if (mode === "build"
    || mode === "code"
    || mode === "debug"
    || mode === "research"
    || mode === "plan"
    || mode === "coding"
    || mode === "business"
    || mode === "creator"
    || mode === "general") {
    return mode;
  }
  return "general";
}

/**
 * Everything the orchestrator needs for one turn, wired to this session's
 * real stores.
 *
 * Shared by /v1/assist and /v1/assist/stream. It was briefly duplicated into
 * the streaming route, which is how two copies of a dozen closures start
 * drifting apart — one gains a capability the other quietly lacks, and the
 * difference only shows up as "it works in chat but not on the dashboard".
 */
function buildAssistInput(
  req: express.Request,
  options: {
    mode: AssistRouteMode;
    message: string;
    sessionId: string | null;
    savedMemories: Array<{ body: string }>;
    memoryContext: Array<{ id: string; title: string; body: string; pinned: boolean; createdAt: string }>;
    history: Array<{ role: "user" | "assistant"; content: string }>;
    onToken?: (text: string) => void;
    cancel?: AbortSignal;
  }
) {
  const { mode, message, sessionId, savedMemories, memoryContext, history, onToken, cancel } = options;

  return {
    mode,
    userMessage: message,
    sessionId: sessionId ?? undefined,
    history,
    agent: agentFromRequest(req),
    model: chosenModel(req),
    memoryContext: memoryContext.map((entry) => ({
      id: entry.id,
      title: entry.title,
      body: entry.body,
      pinned: entry.pinned,
      createdAt: entry.createdAt
    })),
    // Reported so the reply can only confirm a save that actually happened.
    // Without a session there is nowhere to write, and the user must be told
    // that rather than reassured.
    memoryWrite: {
      available: sessionId !== null,
      saved: savedMemories.length,
      savedBodies: savedMemories.map((memory) => memory.body),
          // Recorded by the store for a long time and read by nothing until now.
          persistError: memoryPersistenceError()
    },
    knowledge: sessionId ? retrieveKnowledgePassages(sessionId) : [],
    // The write path for the assistant's own "remember" tool. Omitted without
    // a session, so the tool reports that nothing was saved rather than the
    // assistant claiming a write that had nowhere to go.
    saveMemory: sessionId
      ? (fact: string) => recordSingleMemory(sessionId, fact).status
      : undefined,
    forgetMemory: sessionId ? (id: string) => forgetMemory(sessionId, id) : undefined,
    forgottenFacts: sessionId ? listForgottenFacts(sessionId) : [],
    listMemories: sessionId ? () => listSessionMemories(sessionId) : undefined,
    forgetAllMemories: sessionId ? () => forgetAllMemories(sessionId) : undefined,
    listSchedules: () => listSchedules().map((schedule) => ({
      id: schedule.id,
      name: schedule.name,
      cadenceLabel: describeCadence(schedule.cadence),
      actionLabel: describeAction(schedule.action),
      enabled: schedule.enabled
    })),
    removeSchedule: (id: string) => removeSchedule(id),
    setScheduleEnabled: (id: string, enabled: boolean) => Boolean(setScheduleEnabled(id, enabled)),
    documents: sessionId
      ? listDocuments(sessionId).map((document) => ({
        id: document.id,
        title: document.title,
        body: document.body
      }))
      : undefined,
    saveDocument: sessionId
      ? (title: string, body: string) => Boolean(addDocument(sessionId, {
        id: globalThis.crypto.randomUUID(),
        title,
        body
      }))
      : undefined,
    // An update is a delete and a re-add under the original title and id,
    // because the store has no in-place edit. Done in this order so a failed
    // write cannot leave the session with neither version.
    updateDocument: sessionId
      ? (id: string, body: string) => {
        const existing = listDocuments(sessionId).find((document) => document.id === id);
        if (!existing) return false;
        const replaced = addDocument(sessionId, { id: `${id}-updated`, title: existing.title, body });
        if (!replaced) return false;
        removeDocument(sessionId, id);
        return true;
      }
      : undefined,
    deleteDocument: sessionId ? (id: string) => removeDocument(sessionId, id) : undefined,
    pinMemory: sessionId
      ? (id: string, pinned: boolean) => Boolean(setMemoryPinned(sessionId, id, pinned))
      : undefined,
    launchApp: (project: string) => startApp(project),
    stopApp: (project: string) => stopApp(project),
    runningApps: () => listRunningApps(),
    listApps: () => listBuiltApps(),
    deleteApp: (name: string) => removeBuiltApp(name),
    authorApp: authorAppWithModel,
    generateText: generateWithModel,
    images: parseImages(req.body?.images),
    ...(onToken ? { onToken } : {}),
    ...(cancel ? { cancel } : {})
  };
}

/**
 * Ask the local model to write an application.
 *
 * Only reached for requests that are neither a records app nor a calculator -
 * the shapes the templates cover. The prompt is passed through verbatim
 * (rawPrompt) because the assistant's own prompt tells the model to answer in
 * a few sentences and not to invent specifics, which is the opposite of what
 * writing an application needs.
 */
async function authorAppWithModel(prompt: string) {
  const base = readLocalModelConfig();

  // Written by a coding model when one is installed, and given longer than a
  // chat reply gets. Both matter: on this machine the general model did not
  // finish a snake game in five minutes and the coder model wrote one in
  // thirty seconds, and the default timeout is tuned for answering a question
  // rather than producing five files.
  const availability = await checkAvailability(base);
  const model = availability.available
    ? pickAuthorModel(availability.installedModels, availability.model)
    : base.model;

  const config = { ...base, model, timeoutMs: Math.max(base.timeoutMs, 300000) };
  const result = await generate(config, { question: prompt, context: [], rawPrompt: prompt });
  return result.ok ? { ok: true as const, text: result.text } : { ok: false as const, reason: result.reason };
}

/**
 * The user's turn as the transcript keeps it: the words, and a note when
 * images came with them. The images themselves are not stored - a reloaded
 * conversation shows that one was sent, not the picture.
 */
function userTurnText(message: string, req: express.Request): string {
  const count = Array.isArray(req.body?.images) ? Math.min(req.body.images.length, maxImagesPerTurn) : 0;
  return count > 0 ? `${message}\n[${count} image${count === 1 ? "" : "s"} attached]` : message;
}

/**
 * One call to the configured local model with a prompt sent as written - the
 * section notes of a long document's summary. The configured model, not the
 * coding one authorApp prefers: this is reading prose, not writing an app.
 * Given longer than a chat reply, since a section is a page or two of text.
 */
async function generateWithModel(prompt: string) {
  const base = readLocalModelConfig();
  const result = await generate({ ...base, timeoutMs: Math.max(base.timeoutMs, 120000) },
    { question: prompt, context: [], rawPrompt: prompt });
  return result.ok ? { ok: true as const, text: result.text, model: result.model } : { ok: false as const, reason: result.reason };
}

/** The per-turn session state both assist routes derive the same way. */
/**
 * Close a turn's stages and record how long each actually took.
 *
 * The telemetry the spec asks for, in the only form worth having: measured
 * durations for stages that genuinely ran, rather than a fixed sequence with
 * timings hung off it. A turn that stopped early reports the stages it
 * reached and no more.
 */
function reportStages(sessionId: string): void {
  const sequence = finishStages(sessionId);
  if (sequence.length === 0) return;
  console.info(`[stages] ${sequence.map((entry) => `${entry.stage} ${entry.durationMs}ms`).join(" -> ")}`);
}

function readTurnContext(req: express.Request, message: string) {
  const sessionId = resolveMemoryKey(req, normalizeSessionId(req.body?.sessionId));
  // A measurement left by an earlier request that failed must not be reported
  // as this one's.
  if (sessionId) takeContextUse(sessionId);
  // A new request starts a fresh trace. The panel is for watching the work
  // happening now; keeping every step since the browser opened would bury the
  // one that matters at the moment it matters most.
  clearEvents(sessionId ?? undefined);
  const savedMemories = sessionId ? recordMemoriesFromMessage(sessionId, message) : [];
  // Widen the candidate set: the composer scores for relevance, so limiting
  // to the 5 newest would hide the one memory that actually answers.
  const memoryContext = sessionId ? retrieveSessionMemories(sessionId, memoryCandidateLimit) : [];

  const clientHistory = normalizeAssistHistory(req.body?.history);
  const conversationId = requestedConversation(req);
  // Fall back to the stored transcript when the client sends none — that is
  // what lets a fresh browser continue an existing conversation.
  const history = clientHistory.length > 0 || !sessionId
    ? clientHistory
    : normalizeAssistHistory(
      listTurns(sessionId, undefined, conversationId).map((turn) => ({ role: turn.role, content: turn.content }))
    );

  return { sessionId, savedMemories, memoryContext, history, conversationId };
}

/**
 * The conversation a chat turn belongs to, as the client named it - a new
 * chat's id before its first message, or one picked from the list. Absent
 * means the one used most recently, which is all there was before
 * conversations could be told apart.
 */
function requestedConversation(req: express.Request): string | undefined {
  return isConversationId(req.body?.conversationId) ? req.body.conversationId : undefined;
}

/** The model the conversation asked for, if it named a plausible one. Checked, not trusted. */
function chosenModel(req: express.Request): string | undefined {
  return isModelName(req.body?.model) ? req.body.model : undefined;
}

/**
 * Records one finished exchange in its conversation, and says which
 * conversation that was. A regenerated answer replaces the exchange it
 * re-asks rather than following it - and only after the new answer exists,
 * so a failed retry loses nothing.
 */
function recordExchange(
  req: express.Request,
  sessionId: string,
  message: string,
  result: { assistantMessage: string; strategy?: string; model?: string }
): string {
  const conversation = resolveConversation(sessionId, requestedConversation(req));
  const conversationId = conversation.id;
  // The model it was asked with becomes the conversation's own, so it follows
  // the conversation to another browser. Saved only when it changes.
  const model = chosenModel(req);
  if (model && conversation.model !== model) updateConversation(sessionId, conversationId, { model });
  if (req.body?.regenerate === true) dropLastExchange(sessionId, conversationId, message);
  appendTurn(sessionId, "user", userTurnText(message, req), undefined, conversationId);
  // The assistant turn carries how it was produced, so a reloaded transcript
  // still shows whether an answer was quoted or generated.
  appendTurn(sessionId, "assistant", result.assistantMessage, { strategy: result.strategy, model: result.model }, conversationId);
  return conversationId;
}

export function createApp() {
  const app = express();

  app.use(helmet());
  // Defaults to this machine's own origins rather than "*". The API listens on
  // localhost, but that does not stop a page on any site the user visits from
  // calling it — CORS is what decides whether that page may read the reply, and
  // these endpoints carry no credentials. CORS_ORIGIN still overrides, and takes
  // a comma-separated list.
  app.use(cors({
    origin(origin, callback) {
      callback(null, isAllowedOrigin(origin, process.env.CORS_ORIGIN));
    },
    // Response headers a browser client is allowed to read. Without this the
    // browser hides them from JavaScript even though they are sent, which is
    // the worst kind of bug: the header looks right in curl and does nothing
    // in the app.
    exposedHeaders: ["X-Speech-Voice"]
  }));
  // A chat turn may carry images, base64 in the body, far past the 1 MB every
  // other route needs - so only the two chat routes get the larger allowance.
  const smallJson = express.json({ limit: "1mb" });
  const chatJson = express.json({ limit: "40mb" });
  app.use((req, res, next) =>
    (req.path === "/v1/assist" || req.path === "/v1/assist/stream" ? chatJson : smallJson)(req, res, next));
  app.use(morgan("tiny"));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "ascend-api" });
  });

  // Which build is actually answering. Found live: three differently-aged,
  // differently-architected installs of this app existed on one machine at
  // once, all under the same name, with no way to tell them apart from the
  // running window alone. This is the answer to "which one is this".
  app.get("/v1/build-info", (_req, res) => {
    res.json({ data: getBuildInfo(), traceId: "trace-local" });
  });

  // Texting and email: what is set up, and the user's own email account. The
  // app password goes in and never comes back out - see emailAccount.ts.
  app.get("/v1/messaging", (_req, res) => {
    res.json({
      data: {
        email: describeEmailAccount(),
        texts: { phoneLink: phoneLinkStatus() },
        providers: knownProviders.map(({ name, domains, passwordHelp }) => ({ name, domains, passwordHelp }))
      },
      traceId: "trace-local"
    });
  });

  app.put("/v1/messaging/email", (req, res) => {
    const saved = saveEmailAccount(req.body);
    if (!saved.ok) {
      res.status(400).json({ code: "INVALID_REQUEST", message: saved.message, traceId: "trace-local" });
      return;
    }
    res.json({ data: { email: saved.account }, traceId: "trace-local" });
  });

  app.delete("/v1/messaging/email", (_req, res) => {
    removeEmailAccount();
    res.json({ data: { email: describeEmailAccount() }, traceId: "trace-local" });
  });

  // A test email to the account's own address - sent only when the user
  // presses the button for it, and only to themselves.
  app.post("/v1/messaging/email/test", async (_req, res) => {
    const account = readEmailAccount();
    if (!account) {
      res.status(400).json({ code: "NOT_CONFIGURED", message: "No email account is saved yet.", traceId: "trace-local" });
      return;
    }
    const result = await sendWithAccount(account, {
      to: [account.address],
      subject: "TRH AI can send email",
      body: "This is a test from TRH AI on your PC. If it arrived, TRH AI can send email from this account."
    });
    res.json({
      data: { ok: result.ok, message: result.ok ? `Sent a test email to ${account.address} - check your inbox.` : result.content },
      traceId: "trace-local"
    });
  });

  app.post("/v1/assist", async (req, res, next) => {
    try {
      const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
      if (!message) {
        res.status(400).json({
          code: "INVALID_REQUEST",
          message: "message is required",
          traceId: "trace-local"
        });
        return;
      }

      const mode = normalizeAssistMode(req.body?.mode);
      const clientHistory = normalizeAssistHistory(req.body?.history);

      // Memory belongs to the signed-in account when there is one, otherwise to
      // the anonymous session id. Without either we skip memory entirely rather
      // than pooling callers into a shared bucket.
      const sessionId = resolveMemoryKey(req, normalizeSessionId(req.body?.sessionId));
      // A measurement left by an earlier request that failed must not be
      // reported as this one's.
      if (sessionId) takeContextUse(sessionId);
      const savedMemories = sessionId ? recordMemoriesFromMessage(sessionId, message) : [];
      // Widen the candidate set: the composer scores for relevance, so limiting to
      // the 5 newest would hide the one memory that actually answers the question.
      const memoryContext = sessionId ? retrieveSessionMemories(sessionId, memoryCandidateLimit) : [];

      // Fall back to the stored transcript when the client sends none — that is
      // what lets a fresh browser continue an existing conversation.
      const history = clientHistory.length > 0 || !sessionId
        ? clientHistory
        : normalizeAssistHistory(
          listTurns(sessionId, undefined, requestedConversation(req)).map((turn) => ({ role: turn.role, content: turn.content }))
        );

      const result = await runAssistantOrchestrator({
        mode,
        userMessage: message,
        sessionId: sessionId ?? undefined,
        history,
        agent: agentFromRequest(req),
        model: chosenModel(req),
        memoryContext: memoryContext.map((entry) => ({
          id: entry.id,
          title: entry.title,
          body: entry.body,
          pinned: entry.pinned,
          createdAt: entry.createdAt
        })),
        // Reported so the reply can only confirm a save that actually happened.
        // Without a session there is nowhere to write, and the user must be told
        // that rather than reassured.
        memoryWrite: {
          available: sessionId !== null,
          saved: savedMemories.length,
          savedBodies: savedMemories.map((memory) => memory.body),
          // Recorded by the store for a long time and read by nothing until now.
          persistError: memoryPersistenceError()
        },
        knowledge: sessionId ? retrieveKnowledgePassages(sessionId) : [],
        // The write path for the assistant's own "remember" tool. Omitted
        // without a session, so the tool reports that nothing was saved rather
        // than the assistant claiming a write that had nowhere to go.
        saveMemory: sessionId
          ? (fact: string) => recordSingleMemory(sessionId, fact).status
          : undefined,
        forgetMemory: sessionId ? (id: string) => forgetMemory(sessionId, id) : undefined,
        forgottenFacts: sessionId ? listForgottenFacts(sessionId) : [],
        listMemories: sessionId ? () => listSessionMemories(sessionId) : undefined,
        forgetAllMemories: sessionId ? () => forgetAllMemories(sessionId) : undefined,
        listSchedules: () => listSchedules().map((schedule) => ({
          id: schedule.id,
          name: schedule.name,
          cadenceLabel: describeCadence(schedule.cadence),
          actionLabel: describeAction(schedule.action),
          enabled: schedule.enabled
        })),
        removeSchedule: (id: string) => removeSchedule(id),
        setScheduleEnabled: (id: string, enabled: boolean) => Boolean(setScheduleEnabled(id, enabled)),
        documents: sessionId
          ? listDocuments(sessionId).map((document) => ({
            id: document.id,
            title: document.title,
            body: document.body
          }))
          : undefined,
        saveDocument: sessionId
          ? (title: string, body: string) => Boolean(addDocument(sessionId, {
            id: globalThis.crypto.randomUUID(),
            title,
            body
          }))
          : undefined,
        // An update is a delete and a re-add under the original title and id,
        // because the store has no in-place edit. Done in this order so a
        // failed write cannot leave the session with neither version.
        updateDocument: sessionId
          ? (id: string, body: string) => {
            const existing = listDocuments(sessionId).find((document) => document.id === id);
            if (!existing) return false;
            const replaced = addDocument(sessionId, { id: `${id}-updated`, title: existing.title, body });
            if (!replaced) return false;
            removeDocument(sessionId, id);
            return true;
          }
          : undefined,
        deleteDocument: sessionId ? (id: string) => removeDocument(sessionId, id) : undefined,
        pinMemory: sessionId
          ? (id: string, pinned: boolean) => Boolean(setMemoryPinned(sessionId, id, pinned))
          : undefined,
        launchApp: (project: string) => startApp(project),
        stopApp: (project: string) => stopApp(project),
        runningApps: () => listRunningApps(),
        listApps: () => listBuiltApps(),
        deleteApp: (name: string) => removeBuiltApp(name),
        authorApp: authorAppWithModel,
        generateText: generateWithModel,
        images: parseImages(req.body?.images)
      }).finally(() => {
        // Whatever a client polling /v1/assist/activity mid-turn was told is
        // stale the instant this turn ends, success or failure alike.
        if (sessionId) {
          clearActivity(sessionId);
          reportStages(sessionId);
        }
      });

      // Recorded after a successful reply so a failed request leaves no orphan turn.
      const conversationId = sessionId ? recordExchange(req, sessionId, message, result) : null;

      res.json({
        data: {
          assistantMessage: result.assistantMessage,
          model: result.model,
          mode,
          // Which conversation this exchange was recorded in - the id a new
          // chat's first message created, or the one it continued.
          conversationId,
          // How full the model's context window was, as measured when the
          // prompt was sent. Null when no model was asked.
          context: sessionId ? takeContextUse(sessionId) : null,
          // Report what was actually used so the client can label provenance
          // from the server's behaviour rather than from what it hoped to send.
          // Both counts mean "actually used in the reply", not "sent to the model".
          usedHistoryTurns: result.groundedOnHistory,
          sentHistoryTurns: history.length,
          usedMemoryEntries: result.groundedOn.length,
          savedMemoryEntries: savedMemories.length,
          strategy: result.strategy,
          // Present only when the permission gate refused something. The
          // client renders a confirmation dialog from it.
          ...(result.pendingConfirmation ? { pendingConfirmation: result.pendingConfirmation } : {}),
          // What the client should scaffold from: the original request merged
          // with any clarifying answer, not just this turn's text.
          buildRequest: result.buildRequest,
          // Which tools the assistant actually called. Reported so the interface
          // can show what it did rather than only what it said.
          toolsUsed: result.toolsUsed ?? []
        },
        traceId: "trace-local"
      });
    } catch (error) {
      next(error);
    }
  });

  // ---- Accounts -----------------------------------------------------------

  function tooManyAttempts(res: express.Response, retryAfterSeconds: number): void {
    res.setHeader("Retry-After", String(retryAfterSeconds));
    res.status(429).json({
      code: "TOO_MANY_REQUESTS",
      message: "Too many attempts. Please wait and try again.",
      retryAfterSeconds,
      traceId: "trace-local"
    });
  }

  /** Lower-cased so casing cannot be used to sidestep the per-email counter. */
  function emailKey(value: unknown): string {
    return typeof value === "string" ? `email:${value.trim().toLowerCase()}` : "email:unknown";
  }

  app.post("/v1/auth/register", (req, res) => {
    const ipKey = `register-ip:${clientKey(req.ip)}`;
    const ipCheck = checkRateLimit(ipKey, registerIpRule);
    if (!ipCheck.allowed) {
      tooManyAttempts(res, ipCheck.retryAfterSeconds);
      return;
    }

    const result = registerAccount(req.body ?? {});
    if (!result.ok) {
      // Counted so the endpoint cannot be used to enumerate or spam accounts.
      recordFailure(ipKey, registerIpRule);
      res.status(400).json({ code: "INVALID_REQUEST", message: result.error, traceId: "trace-local" });
      return;
    }

    recordFailure(ipKey, registerIpRule);
    res.status(201).json({
      data: {
        account: result.account,
        token: result.token,
        expiresAt: result.expiresAt,
        // Returned once and never again; the server keeps only hashes.
        recoveryCodes: result.recoveryCodes
      },
      traceId: "trace-local"
    });
  });

  app.post("/v1/auth/recover", (req, res) => {
    const ipKey = `recover-ip:${clientKey(req.ip)}`;
    const perEmailKey = `recover-${emailKey(req.body?.email)}`;

    for (const [key, rule] of [[ipKey, recoveryIpRule], [perEmailKey, recoveryEmailRule]] as const) {
      const check = checkRateLimit(key, rule);
      if (!check.allowed) {
        tooManyAttempts(res, check.retryAfterSeconds);
        return;
      }
    }

    const result = recoverWithCode({
      email: req.body?.email,
      code: req.body?.code,
      newPassword: req.body?.newPassword
    });

    if (!result.ok) {
      recordFailure(ipKey, recoveryIpRule);
      recordFailure(perEmailKey, recoveryEmailRule);
      res.status(400).json({ code: "INVALID_REQUEST", message: result.error, traceId: "trace-local" });
      return;
    }

    clearRateLimit(ipKey);
    clearRateLimit(perEmailKey);
    res.json({
      data: { account: result.account, token: result.token, expiresAt: result.expiresAt },
      traceId: "trace-local"
    });
  });

  app.post("/v1/auth/login", (req, res) => {
    const ipKey = `login-ip:${clientKey(req.ip)}`;
    const perEmailKey = `login-${emailKey(req.body?.email)}`;

    // Checked before verifying anything: a locked-out caller should not get a
    // password comparison run on their behalf.
    const ipCheck = checkRateLimit(ipKey, loginIpRule);
    if (!ipCheck.allowed) {
      tooManyAttempts(res, ipCheck.retryAfterSeconds);
      return;
    }
    const emailCheck = checkRateLimit(perEmailKey, loginEmailRule);
    if (!emailCheck.allowed) {
      tooManyAttempts(res, emailCheck.retryAfterSeconds);
      return;
    }

    const result = login(req.body ?? {});
    if (!result.ok) {
      recordFailure(ipKey, loginIpRule);
      recordFailure(perEmailKey, loginEmailRule);
      // 401 with a deliberately vague message; see accounts.ts.
      res.status(401).json({ code: "UNAUTHORIZED", message: result.error, traceId: "trace-local" });
      return;
    }

    // A success clears both counters so a legitimate user who mistyped once is
    // never carried toward a lockout.
    clearRateLimit(ipKey);
    clearRateLimit(perEmailKey);
    res.json({
      data: { account: result.account, token: result.token, expiresAt: result.expiresAt },
      traceId: "trace-local"
    });
  });

  app.post("/v1/auth/password", (req, res) => {
    const token = bearerToken(req.headers.authorization);
    const account = accountForToken(token);
    if (!account) {
      res.status(401).json({ code: "UNAUTHORIZED", message: "Not signed in", traceId: "trace-local" });
      return;
    }

    // Keyed by account: this endpoint takes the current password, so it is
    // another surface for guessing it.
    const limitKey = `password-change:${account.id}`;
    const check = checkRateLimit(limitKey, passwordChangeRule);
    if (!check.allowed) {
      tooManyAttempts(res, check.retryAfterSeconds);
      return;
    }

    const result = changePassword({
      token,
      currentPassword: req.body?.currentPassword,
      newPassword: req.body?.newPassword
    });

    if (!result.ok) {
      recordFailure(limitKey, passwordChangeRule);
      res.status(400).json({ code: "INVALID_REQUEST", message: result.error, traceId: "trace-local" });
      return;
    }

    clearRateLimit(limitKey);
    res.json({
      data: { account: result.account, token: result.token, expiresAt: result.expiresAt },
      traceId: "trace-local"
    });
  });

  app.post("/v1/auth/logout", (req, res) => {
    const revoked = logout(bearerToken(req.headers.authorization));
    res.json({ data: { revoked }, traceId: "trace-local" });
  });

  app.get("/v1/auth/me", (req, res) => {
    const account = accountForToken(bearerToken(req.headers.authorization));
    if (!account) {
      res.status(401).json({ code: "UNAUTHORIZED", message: "Not signed in", traceId: "trace-local" });
      return;
    }
    res.json({ data: { account }, traceId: "trace-local" });
  });

  // E4-S2 memory controls. Scoped to the signed-in account when there is one,
  // otherwise to the anonymous session id. A request with neither is a client
  // error, not an empty list — it must never fall back to a shared bucket.
  function requireSessionId(
    value: unknown,
    res: express.Response,
    req: express.Request
  ): string | null {
    const sessionId = resolveMemoryKey(req, normalizeSessionId(value));
    if (!sessionId) {
      res.status(400).json({
        code: "INVALID_REQUEST",
        message: "sessionId is required",
        traceId: "trace-local"
      });
      return null;
    }
    return sessionId;
  }

  // The current conversation - the one used most recently - or a named one.
  // What the app reads on load; conversationId says which it was, so the
  // next message continues it.
  app.get("/v1/assist/conversation", (req, res) => {
    const sessionId = requireSessionId(req.query?.sessionId, res, req);
    if (!sessionId) return;

    const asked = req.query?.conversationId;
    const named = isConversationId(asked) ? asked : undefined;
    const conversationId = named ?? currentConversationId(sessionId);
    res.json({
      data: {
        turns: listTurns(sessionId, undefined, named),
        conversationId,
        // The conversation's own model, so the app shows and keeps using it.
        model: conversationId ? getConversation(sessionId, conversationId)?.model ?? null : null
      },
      traceId: "trace-local"
    });
  });

  app.delete("/v1/assist/conversation", (req, res) => {
    const sessionId = requireSessionId(req.query?.sessionId ?? req.body?.sessionId, res, req);
    if (!sessionId) return;

    const named = req.query?.conversationId ?? req.body?.conversationId;
    res.json({
      data: { cleared: clearConversation(sessionId, isConversationId(named) ? named : undefined) },
      traceId: "trace-local"
    });
  });

  // ---- Conversations ------------------------------------------------------
  //
  // The list behind the chat workspace: every conversation this account (or
  // this browser, signed out) has had, to search, rename, pin, archive and
  // delete. Keyed exactly like the transcript, so one caller never sees
  // another's - a conversation that is not yours is simply not found.

  function noSuchConversation(res: express.Response): void {
    res.status(404).json({ code: "NOT_FOUND", message: "There is no such conversation.", traceId: "trace-local" });
  }

  app.get("/v1/conversations", (req, res) => {
    const sessionId = requireSessionId(req.query?.sessionId, res, req);
    if (!sessionId) return;

    const query = typeof req.query?.q === "string" ? req.query.q.slice(0, 200) : undefined;
    const archived = req.query?.archived === "1" || req.query?.archived === "true";
    res.json({ data: { conversations: listConversations(sessionId, { query, archived }) }, traceId: "trace-local" });
  });

  app.get("/v1/conversations/:conversationId", (req, res) => {
    const sessionId = requireSessionId(req.query?.sessionId, res, req);
    if (!sessionId) return;

    const conversation = isConversationId(req.params.conversationId)
      ? getConversation(sessionId, req.params.conversationId)
      : null;
    if (!conversation) {
      noSuchConversation(res);
      return;
    }
    res.json({ data: { conversation }, traceId: "trace-local" });
  });

  app.patch("/v1/conversations/:conversationId", (req, res) => {
    const sessionId = requireSessionId(req.query?.sessionId ?? req.body?.sessionId, res, req);
    if (!sessionId) return;

    const body = req.body ?? {};
    const title = body.title === undefined ? undefined : cleanTitle(body.title);
    const invalid = (body.title !== undefined && !title)
      || (body.pinned !== undefined && typeof body.pinned !== "boolean")
      || (body.archived !== undefined && typeof body.archived !== "boolean")
      || (body.model !== undefined && body.model !== null && !isModelName(body.model));
    if (invalid) {
      res.status(400).json({
        code: "INVALID_REQUEST",
        message: "title must be non-empty text; pinned and archived must be true or false; model must be a model name or null",
        traceId: "trace-local"
      });
      return;
    }

    const updated = isConversationId(req.params.conversationId)
      ? updateConversation(sessionId, req.params.conversationId, {
        ...(title ? { title } : {}),
        ...(typeof body.pinned === "boolean" ? { pinned: body.pinned } : {}),
        ...(typeof body.archived === "boolean" ? { archived: body.archived } : {}),
        // null goes back to the usual model.
        ...(body.model !== undefined ? { model: body.model as string | null } : {})
      })
      : null;
    if (!updated) {
      noSuchConversation(res);
      return;
    }
    res.json({ data: { conversation: updated }, traceId: "trace-local" });
  });

  app.delete("/v1/conversations/:conversationId", (req, res) => {
    const sessionId = requireSessionId(req.query?.sessionId ?? req.body?.sessionId, res, req);
    if (!sessionId) return;

    if (!isConversationId(req.params.conversationId) || !deleteConversation(sessionId, req.params.conversationId)) {
      noSuchConversation(res);
      return;
    }
    res.json({ data: { deleted: true }, traceId: "trace-local" });
  });

  /**
   * Whatever destructive action is still awaiting approval, if any.
   *
   * Read on load. Without it a reload closed the dialog while the offer was
   * still standing on the server — the user saw nothing pending, and a "yes"
   * typed later would still have run it.
   */
  app.get("/v1/assist/confirmation", (req, res) => {
    const sessionId = requireSessionId(req.query?.sessionId, res, req);
    if (!sessionId) return;

    const pending = getPendingConfirmation(sessionId);

    res.json({
      data: {
        pendingConfirmation: pending
          ? { tool: pending.tool, ...describePendingAction(pending) }
          : null
      },
      traceId: "trace-local"
    });
  });

  /**
   * Decline a pending destructive action.
   *
   * Without this, Cancel would only close the dialog: the offer would still
   * be standing server-side, and an unrelated "yes" later in the session
   * could land on the deletion the user had just declined.
   */
  app.delete("/v1/assist/confirmation", (req, res) => {
    const sessionId = requireSessionId(req.query?.sessionId ?? req.body?.sessionId, res, req);
    if (!sessionId) return;

    const pending = getPendingConfirmation(sessionId);
    clearPendingConfirmation(sessionId);

    res.json({ data: { declined: Boolean(pending) }, traceId: "trace-local" });
  });

  app.get("/v1/assist/memory", (req, res) => {
    const sessionId = requireSessionId(req.query?.sessionId, res, req);
    if (!sessionId) return;

    res.json({
      data: {
        memories: listSessionMemories(sessionId),
        audit: getMemoryAudit(sessionId, 20),
        // How many are kept; past it the oldest unpinned one makes room.
        limit: maxMemoriesPerSession
      },
      traceId: "trace-local"
    });
  });

  // Remember something on purpose, from the Memory workspace - the same path
  // the assistant's own "remember" tool takes, so a fact typed here and one
  // said in chat are stored, deduplicated and audited the same way.
  app.post("/v1/assist/memory", (req, res) => {
    const sessionId = requireSessionId(req.body?.sessionId, res, req);
    if (!sessionId) return;

    const text = typeof req.body?.text === "string" ? req.body.text.replace(/\s+/g, " ").trim().slice(0, 500) : "";
    const outcome = text ? recordSingleMemory(sessionId, text) : { status: "empty" as const };
    if (outcome.status === "empty") {
      res.status(400).json({ code: "INVALID_REQUEST", message: "Say what to remember.", traceId: "trace-local" });
      return;
    }
    res.status(outcome.status === "saved" ? 201 : 200).json({
      data: outcome.status === "saved" ? { status: "saved", memory: outcome.memory } : { status: "duplicate" },
      traceId: "trace-local"
    });
  });

  // What the assistant can currently do. The client shows a live indicator from
  // this, because whether a model is answering changes what the app is capable
  // of and the user should not have to discover that by asking a question.
  // The models a conversation can be answered by - installed, and able to
  // hold a conversation - and which one answers when it names none.
  app.get("/v1/models", async (_req, res) => {
    const { models, defaultModel, reason } = await listChatModels(readLocalModelConfig());
    res.json({ data: { models, defaultModel, ...(reason ? { reason } : {}) }, traceId: "trace-local" });
  });

  app.get("/v1/assist/model", async (_req, res) => {
    const availability = await checkAvailability(readLocalModelConfig());

    res.json({
      data: availability.available
        ? { available: true, model: availability.model }
        : { available: false, model: null, reason: availability.reason },
      traceId: "trace-local"
    });
  });

  // Loads the vision model while the user is still typing a question about an
  // image they just attached. The load is the slow part of looking - 73 s
  // measured on a busy 8 GB card - and without this all of it happened after
  // Send. One load at a time: attaching three images is one warm-up, not three.
  //
  // JSON only, though nothing is read from the body: a page on another site can
  // send a plain-text POST here without asking first, and only a JSON one makes
  // the browser check CORS before sending - which stops that page loading
  // models on this machine.
  let visionWarming: Promise<boolean> | null = null;
  app.post("/v1/vision/warm", async (req, res) => {
    if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
      res.status(415).json({ message: "Send this as JSON." });
      return;
    }
    visionWarming ??= warmVisionModel(readLocalModelConfig()).finally(() => { visionWarming = null; });
    res.json({ data: { loaded: await visionWarming }, traceId: "trace-local" });
  });

  // What the assistant can actually do, read from the same registry runTool
  // enforces — see systemCapabilities.ts. Existed only as prose inside a chat
  // reply before this: a "Security" screen showing real tools and real
  // permission levels needs the same data as structured JSON, not a page that
  // re-describes the registry from memory and can drift from what the gate
  // actually allows.
  app.get("/v1/capabilities", async (_req, res) => {
    const availability = await checkAvailability(readLocalModelConfig());
    const capabilities = getSystemCapabilities(availability.available ? availability.model : null);

    res.json({
      data: { ...capabilities, groups: toolsByLevel(capabilities) },
      traceId: "trace-local"
    });
  });

  // The Tool center: every tool there is, including one switched off, with
  // what it is for in plain words, whether it can run on this PC right now
  // and why not, and how often it has run. /v1/capabilities stays what the
  // model is offered this moment; this is the whole set, for a person.
  app.get("/v1/tools", async (_req, res) => {
    const probe = await probeTools();
    res.json({
      data: { tools: describeTools(probe), model: probe.model, machineAccess: probe.machineAccess },
      traceId: "trace-local"
    });
  });

  // Whether the neural voice is installed, so the interface can offer it
  // honestly instead of listing a voice that would produce silence. Absent is a
  // normal state with a reason attached, not an error.
  app.get("/v1/speech", (_req, res) => {
    const status = piperStatus();

    res.json({
      data: status.available
        ? {
            available: true,
            voice: status.voice.id,
            // The full list, so the picker offers what is actually on disk
            // rather than a hardcoded menu that can drift out of date.
            voices: status.voices.map(({ id, name, locale, quality, gender }) => ({ id, name, locale, quality, gender })),
            maxCharacters: maxSynthesisCharacters
          }
        : { available: false, voice: null, voices: [], reason: status.reason },
      traceId: "trace-local"
    });
  });

  // Text in, spoken audio out. The synthesis runs on this machine — no account,
  // no key, nothing leaves the box — which is the whole reason for preferring
  // it over a hosted voice.
  app.post("/v1/speech", async (req, res) => {
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    if (!text.trim()) {
      res.status(400).json({
        code: "INVALID_REQUEST",
        message: "text is required",
        traceId: "trace-local"
      });
      return;
    }

    // All clamped or resolved inside the service, and passed through as-is so
    // a nonsense value falls back to the voice's own delivery rather than
    // failing a request the user would rather just hear.
    const result = await synthesize(text, {
      voiceId: typeof req.body?.voiceId === "string" ? req.body.voiceId : undefined,
      rate: typeof req.body?.rate === "number" ? req.body.rate : undefined,
      expressiveness: typeof req.body?.expressiveness === "number" ? req.body.expressiveness : undefined,
      cadence: normalizeCadence(req.body?.cadence)
    });

    if (!result.ok) {
      // 503 rather than 500: the usual cause is that the voice is not
      // installed, which is a state of the machine, not a bug in the request.
      res.status(503).json({
        code: "SPEECH_UNAVAILABLE",
        message: result.reason,
        traceId: "trace-local"
      });
      return;
    }

    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Content-Length", String(result.audio.length));
    // Which voice actually spoke, so a client that asked for one no longer
    // installed can tell it got a different one.
    res.setHeader("X-Speech-Voice", result.voice);
    // Each reply is spoken once; caching would only serve stale audio after a
    // voice change.
    res.setHeader("Cache-Control", "no-store");
    res.send(result.audio);
  });

  // Whether local speech-to-text is installed, so the interface can offer the
  // microphone honestly instead of a button that would hear nothing. Absent is
  // a normal state with a reason attached, exactly as for the neural voice.
  app.get("/v1/transcribe", (_req, res) => {
    const status = whisperStatus();

    res.json({
      data: status.available
        ? {
            available: true,
            model: status.model.id,
            models: status.models.map(({ id, size, englishOnly }) => ({ id, size, englishOnly })),
            sampleRate: requiredSampleRate,
            channels: requiredChannels,
            maxBytes: maxAudioBytes
          }
        : { available: false, model: null, models: [], reason: status.reason },
      traceId: "trace-local"
    });
  });

  // Audio in, text out. The transcription runs on this machine — no account,
  // no key, nothing uploaded — which is the entire reason for preferring
  // whisper.cpp over the browser's own SpeechRecognition, which would have
  // streamed the microphone to a third party to do the same job.
  app.post("/v1/transcribe",
    express.raw({ type: ["audio/wav", "audio/wave", "audio/x-wav", "application/octet-stream"], limit: maxAudioBytes }),
    async (req, res) => {
      const audio = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (audio.length === 0) {
        res.status(400).json({
          code: "INVALID_REQUEST",
          message: "audio is required, as a 16 kHz mono WAV body",
          traceId: "trace-local"
        });
        return;
      }

      const result = await transcribe(audio);

      if (!result.ok) {
        // 503 rather than 500: the usual cause is that whisper.cpp is not
        // installed, which is a state of the machine, not a bug in the
        // request. The one exception is audio this cannot read, which is.
        const isRequestFault = /not a WAV|must be .* kHz/i.test(result.reason);
        res.status(isRequestFault ? 400 : 503).json({
          code: isRequestFault ? "INVALID_REQUEST" : "TRANSCRIPTION_UNAVAILABLE",
          message: result.reason,
          traceId: "trace-local"
        });
        return;
      }

      res.json({ data: { text: result.text, model: result.model }, traceId: "trace-local" });
    });

  // Scheduled work. These are machine-wide rather than per-session: the
  // scheduler runs them from the API process whether or not anyone has a tab
  // open, which is the only arrangement under which "every day at 9:00 AM"
  // is a true statement rather than a picture of one.
  app.get("/v1/schedules", (_req, res) => {
    res.json({
      data: {
        schedules: listSchedules().map(scheduleView),
        // Whether the last write to disk failed.
        //
        // scheduleStore has recorded this since it was written and nothing ever
        // read it, so a store that could no longer save - a locked file, a full
        // disk - kept accepting schedules, logged to a console nobody has open,
        // and lost them all on restart. Sent so the screen can say so.
        persistenceError: schedulePersistenceError()
      },
      traceId: "trace-local"
    });
  });

  // The saved automation flow, kept server-side so the scheduler can reach
  // it. It used to live only in a browser's localStorage, where nothing but
  // that one tab could see it.
  app.get("/v1/flow", (_req, res) => {
    res.json({ data: { flow: getFlow() }, traceId: "trace-local" });
  });

  app.put("/v1/flow", (req, res) => {
    const saved = saveFlow(req.body?.flow);
    if (!saved) {
      res.status(400).json({
        code: "INVALID_REQUEST",
        message: "flow must have an id, a name and a list of known node types",
        traceId: "trace-local"
      });
      return;
    }
    res.json({ data: { flow: saved }, traceId: "trace-local" });
  });

  // Live hardware readings for the dashboard rings. Measured per request
  // rather than cached: a ring showing a number from thirty seconds ago is
  // not showing what the machine is doing now, which is the only thing it
  // claims to show.
  app.get("/v1/system-telemetry", async (_req, res) => {
    res.json({ data: await readTelemetry(), traceId: "trace-local" });
  });

  // Who is at the keyboard, from the OS rather than from a constant.
  //
  // The screen greets the user by name, and the name has to come from
  // somewhere real or it is decoration that happens to be right on one
  // machine. This is the account the API process runs under, which on a
  // desktop build is the person who launched it.
  app.get("/v1/identity", (_req, res) => {
    res.json({ data: readIdentity(), traceId: "trace-local" });
  });

  // The same turn as /v1/assist, streamed.
  //
  // A local model can take half a minute to answer, and watching nothing
  // happen for that long is the worst part of using one. This sends the reply
  // as it is generated.
  //
  // Deliberately a second route rather than a flag on the first. Everything
  // that already calls /v1/assist keeps the exact request and the exact
  // response it had, and the streaming path cannot change an answer for a
  // caller that did not ask for it. The final "done" event carries the whole
  // result, so a client can rely on that alone and treat the tokens as
  // presentation — which is what makes it safe for the tokens to be withheld
  // when the model turns out to have been writing a tool call.
  app.post("/v1/assist/stream", async (req, res) => {
    const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    if (!message) {
      res.status(400).json({ code: "INVALID_REQUEST", message: "message is required", traceId: "trace-local" });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    // Nginx and friends buffer event streams by default, which turns a live
    // reply back into one long wait with extra steps.
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const mode = normalizeAssistMode(req.body?.mode);
    const turn = readTurnContext(req, message);
    const { sessionId } = turn;

    try {
      // The browser going away is the signal to stop working. Pressing Stop
      // aborts the fetch, which closes this connection, which lands here — one
      // path for both, and neither leaves the model generating a reply that
      // nothing is waiting for.
      // On the RESPONSE, not the request.
      //
      // req.on("close") fires when the request stream finishes being read,
      // which for a POST whose body express.json() has already consumed is
      // immediately — so every turn aborted itself the moment it started, the
      // model call was cancelled before it produced anything, and the reply
      // fell back to the deterministic plan. The symptom looked exactly like
      // the model failing. The response closing is the thing that actually
      // means the client has gone.
      const stopping = new AbortController();
      let finished = false;
      res.on("close", () => {
        // Not after we have already answered: the response closes on every
        // successful turn too, and aborting there would cancel work that had
        // just completed.
        if (!finished) stopping.abort();
      });

      const result = await runAssistantOrchestrator(
        buildAssistInput(req, {
          mode, message, ...turn,
          onToken: (text) => send("token", { text }),
          cancel: stopping.signal
        })
      );

      let conversationId: string | null = null;
      if (sessionId) {
        // Provenance goes on the assistant turn for the same reason it does
        // on the unstreamed route: a reloaded transcript still has to show
        // whether an answer was quoted or generated.
        conversationId = recordExchange(req, sessionId, message, result);
        clearActivity(sessionId);
        reportStages(sessionId);
      }

      // The whole result, so a client never has to reassemble the reply from
      // the tokens it happened to receive - which conversation it is now in,
      // and how full the model's context window was when it was asked.
      finished = true;
      send("done", { ...result, conversationId, context: sessionId ? takeContextUse(sessionId) : null });
    } catch (error) {
      // An error mid-stream cannot be a status code — the headers are long
      // gone — so it is an event the client can render as a failed turn.
      send("failed", {
        message: error instanceof Error ? error.message : "The assistant could not answer."
      });
    } finally {
      res.end();
    }
  });

  // Telemetry for this process, in the Prometheus text format.
  //
  // E10 asks for OpenTelemetry with Prometheus, Grafana and Loki. The
  // instrumentation is worth having; three server processes beside an app
  // whose premise is running on one machine with nothing else installed are
  // not, and the two are separable. Point Prometheus at this and it scrapes;
  // read it in a browser and it is legible without one.
  app.get("/v1/metrics", (_req, res) => {
    res.type("text/plain; version=0.0.4").send(toPrometheus());
  });

  // The same numbers as JSON, for anything that would rather not parse the
  // text format — the System surface, mostly.
  app.get("/v1/metrics.json", (_req, res) => {
    res.json({ data: snapshot(), traceId: "trace-local" });
  });

  // What the assistant actually did, step by step, as it happens.
  //
  // Not the same as /v1/agent-tasks, which records one request and whether it
  // succeeded. This is the individual steps inside it — the thing that makes
  // a long build watchable rather than merely pending.
  //
  // Read under the same key the work is filed under. This took the raw
  // sessionId, while the orchestrator files a signed-in user's steps under
  // their account - so for anyone signed in, the trace was always empty.
  app.get("/v1/execution", (req, res) => {
    const key = resolveMemoryKey(req, normalizeSessionId(req.query?.sessionId));
    res.json({ data: { events: listEvents(key ?? undefined) }, traceId: "trace-local" });
  });

  // Apps that build_app built and run_app started, running right now. The web
  // client shows these with a live preview and an Open link.
  app.get("/v1/apps", (_req, res) => {
    res.json({ data: { apps: listRunningApps() }, traceId: "trace-local" });
  });

  // Visuals the assistant has rendered (render_mockup). The dashboard shows the
  // latest one live, so its HTML rides along rather than needing a second call.
  app.get("/v1/renderings", (_req, res) => {
    res.json({ data: { renderings: listRenderings(), latest: latestRendering() }, traceId: "trace-local" });
  });

  app.post("/v1/apps/start", async (req, res) => {
    const project = typeof req.body?.project === "string" ? req.body.project : "";
    if (!project.trim()) {
      res.status(400).json({ message: "project is required" });
      return;
    }
    const started = await startApp(project);
    if (!started.ok) {
      res.status(422).json({ message: started.reason });
      return;
    }
    res.json({ data: { app: started.app, alreadyRunning: started.alreadyRunning }, traceId: "trace-local" });
  });

  app.post("/v1/apps/stop", (req, res) => {
    const project = typeof req.body?.project === "string" ? req.body.project : "";
    if (!project.trim()) {
      res.status(400).json({ message: "project is required" });
      return;
    }
    res.json({ data: { stopped: stopApp(project) }, traceId: "trace-local" });
  });

  // Command access: the switch, and what it has actually run.
  //
  // Deliberately a switch with a horizon rather than a permanent setting. A
  // grant that never expires is one nobody remembers making, and this is the
  // only capability in the app that is not bounded by the workspace.
  app.get("/v1/commands", (_req, res) => {
    res.json({
      data: { armed: commandsArmed(), armedUntil: armedUntil(), history: commandHistory() },
      traceId: "trace-local"
    });
  });

  app.post("/v1/commands/arm", (_req, res) => {
    const { armedUntil: until } = armCommands();
    console.warn(`[command] access armed until ${until}`);
    res.json({ data: { armed: true, armedUntil: until }, traceId: "trace-local" });
  });

  app.post("/v1/commands/disarm", (_req, res) => {
    disarmCommands();
    console.warn("[command] access switched off");
    res.json({ data: { armed: false, armedUntil: null }, traceId: "trace-local" });
  });

  // What the assistant is actually working on.
  //
  // Not the to-do list at /v1/tasks — that is a list you write. These are
  // recorded by the orchestrator when a request reaches the agent, so the
  // panel shows real work with a real status rather than a progress bar
  // ticking towards a number nobody measured. There is no percentage here on
  // purpose: nothing in the loop knows how far through a request it is, and
  // a bar filling to 72% would be an animation, not a measurement.
  //
  // Under the same key the orchestrator files it under - see /v1/execution,
  // which had the same mismatch. `running` is whether this process is working
  // on it right now: a stored "executing" outlives a restart that the work did
  // not. `resumable` is whether "continue" would pick it up.
  app.get("/v1/agent-tasks", (req, res) => {
    const key = requireSessionId(req.query?.sessionId, res, req);
    if (!key) return;

    const task = getTask(key);
    res.json({
      data: {
        tasks: task ? [{ ...task, running: isTaskRunning(key), resumable: getResumableTask(key) !== null }] : []
      },
      traceId: "trace-local"
    });
  });

  // The work that has finished, newest first, each with the steps it took.
  // Its own route rather than part of the one above, which every screen
  // polls every few seconds and which should stay one task long.
  app.get("/v1/agent-tasks/history", (req, res) => {
    const key = requireSessionId(req.query?.sessionId, res, req);
    if (!key) return;
    res.json({ data: { history: listFinishedTasks(key), limit: maxFinishedPerSession }, traceId: "trace-local" });
  });

  app.delete("/v1/agent-tasks/history", (req, res) => {
    const key = requireSessionId(req.query?.sessionId, res, req);
    if (!key) return;
    res.json({ data: { cleared: clearFinishedTasks(key) }, traceId: "trace-local" });
  });

  app.delete("/v1/agent-tasks/history/:taskId", (req, res) => {
    const key = requireSessionId(req.query?.sessionId, res, req);
    if (!key) return;
    if (!forgetFinishedTask(key, req.params.taskId)) {
      res.status(404).json({ code: "NOT_FOUND", message: "That task is not in the history", traceId: "trace-local" });
      return;
    }
    res.status(204).end();
  });

  // The workspace, over HTTP.
  //
  // Until now the only way to see these files was to ask the model to list
  // them, which is a strange way to look at your own disk. Both routes go
  // through the same resolveInWorkspace the tools use rather than reading
  // paths directly: a browser can send "../../.ssh/id_rsa" exactly as easily
  // as a model can, and there is no reason for a second, weaker check to
  // exist alongside the one that already refuses it.
  app.get("/v1/files", (req, res) => {
    const requested = typeof req.query.path === "string" && req.query.path.trim() ? req.query.path : ".";
    const entries = listWorkspace(requested);
    if (entries === null) {
      res.status(400).json({
        code: "INVALID_REQUEST",
        message: "That path is outside the workspace.",
        traceId: "trace-local"
      });
      return;
    }

    // The walk stops at maxListedFiles. Without saying so, a listing that hit
    // the cap looks exactly like a complete one, and the page would imply
    // "this is everything" about a directory it only partly read.
    res.json({
      data: {
        root: workspaceRoot(),
        path: requested,
        entries,
        truncated: entries.length >= maxListedFiles,
        limit: maxListedFiles
      },
      traceId: "trace-local"
    });
  });

  app.get("/v1/files/content", (req, res) => {
    const requested = typeof req.query.path === "string" ? req.query.path : "";
    const result = readWorkspaceFile(requested);
    if (!result.ok) {
      // 404 only for a genuinely missing file; a refused path is a bad
      // request, and conflating the two would tell a caller probing for
      // paths outside the workspace which ones exist.
      const missing = result.reason.startsWith("There is no file at");
      res.status(missing ? 404 : 400).json({
        code: missing ? "NOT_FOUND" : "INVALID_REQUEST",
        message: result.reason,
        traceId: "trace-local"
      });
      return;
    }

    // Whether it is really text is answered from the content, not the file
    // name — ".git/config", "HEAD" and "COMMIT_EDITMSG" have no extension and
    // are plainly readable, and a name-based guess calls all three binary.
    // Binary content is not sent at all: it is megabytes of noise that would
    // render as mojibake and make the file look corrupted.
    const binary = looksBinary(result.content);
    res.json({
      data: {
        path: requested,
        content: binary ? "" : result.content,
        truncated: result.truncated,
        binary
      },
      traceId: "trace-local"
    });
  });

  app.post("/v1/schedules", (req, res) => {
    const name = typeof req.body?.name === "string" ? req.body.name : "";
    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt : "";
    const action = req.body?.action;
    const cadence = req.body?.cadence;

    if (!isCadence(cadence)) {
      res.status(400).json({
        code: "INVALID_REQUEST",
        message: "cadence must be {kind:'daily',minuteOfDay} or {kind:'interval',minutes}",
        traceId: "trace-local"
      });
      return;
    }

    const schedule = addSchedule({
      id: `sched-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      prompt,
      // Either shape is accepted; addSchedule turns a bare prompt into an
      // "ask" action so a caller never has to send both.
      action: isScheduleAction(action) ? action : undefined,
      cadence
    });

    if (!schedule) {
      res.status(400).json({
        code: "INVALID_REQUEST",
        message: "A schedule needs a name and a prompt, and there is a limit on how many can exist",
        traceId: "trace-local"
      });
      return;
    }

    res.status(201).json({ data: { schedule: scheduleView(schedule) }, traceId: "trace-local" });
  });

  app.patch("/v1/schedules/:scheduleId", (req, res) => {
    if (typeof req.body?.enabled !== "boolean") {
      res.status(400).json({ code: "INVALID_REQUEST", message: "enabled must be a boolean", traceId: "trace-local" });
      return;
    }

    const schedule = setScheduleEnabled(req.params.scheduleId, req.body.enabled);
    if (!schedule) {
      res.status(404).json({ code: "NOT_FOUND", message: "Schedule not found", traceId: "trace-local" });
      return;
    }

    res.json({ data: { schedule: scheduleView(schedule) }, traceId: "trace-local" });
  });

  app.delete("/v1/schedules/:scheduleId", (req, res) => {
    if (!removeSchedule(req.params.scheduleId)) {
      res.status(404).json({ code: "NOT_FOUND", message: "Schedule not found", traceId: "trace-local" });
      return;
    }
    res.status(204).end();
  });

  // Each run of one schedule, newest first: the log behind its last status.
  app.get("/v1/schedules/:scheduleId/runs", (req, res) => {
    const runs = listScheduleRuns(req.params.scheduleId);
    if (!runs) {
      res.status(404).json({ code: "NOT_FOUND", message: "Schedule not found", traceId: "trace-local" });
      return;
    }
    res.json({ data: { runs }, traceId: "trace-local" });
  });

  // Run a schedule now rather than at its time - to try one out, or to have
  // the nine o'clock summary at eight. Started, not awaited: the outcome is
  // logged with its other runs. A paused schedule can still be run by hand.
  app.post("/v1/schedules/:scheduleId/run", (req, res) => {
    const outcome = runScheduleNow(req.params.scheduleId);
    if (outcome === "missing") {
      res.status(404).json({ code: "NOT_FOUND", message: "Schedule not found", traceId: "trace-local" });
      return;
    }
    if (outcome === "running") {
      res.status(409).json({ code: "ALREADY_RUNNING", message: "That schedule is running already", traceId: "trace-local" });
      return;
    }
    res.status(202).json({ data: { started: true }, traceId: "trace-local" });
  });

  // Which tool the agent is running right now, for a client to poll while a
  // reply is in flight. Absent is a real answer — the model is still thinking,
  // or between tool calls — not an error, so this never 404s on a live session.
  app.get("/v1/assist/activity", (req, res) => {
    const sessionId = requireSessionId(req.query?.sessionId, res, req);
    if (!sessionId) return;

    const activity = getActivity(sessionId);
    // The stage rides along on the poll the client already makes. "Thinking"
    // for thirty seconds is true and tells you almost nothing; which part of
    // the pipeline it is in is the part worth knowing.
    const stage = getStage(sessionId);
    res.json({
      data: {
        tool: activity?.tool ?? null,
        stage: stage?.stage ?? null,
        stageLabel: stage ? stageLabels[stage.stage] : null,
        // Real elapsed time in the current stage, and what each finished one
        // actually took — measured, never estimated.
        stageMs: stage ? Math.max(0, Date.now() - stage.startedAt) : null,
        completedStages: stage?.completed ?? []
      },
      traceId: "trace-local"
    });
  });

  // Machine-wide preferences, so the desktop window and a browser tab agree.
  // Not keyed by session: the session id lives in the browser's own storage, so
  // keying by it would reproduce the split this exists to close.
  app.get("/v1/preferences", (_req, res) => {
    res.json({ data: readPreferences(), traceId: "trace-local" });
  });

  app.patch("/v1/preferences", (req, res) => {
    const personality = typeof req.body?.personality === "string" ? req.body.personality : undefined;
    res.json({ data: updatePreferences({ personality }), traceId: "trace-local" });
  });

  app.get("/v1/knowledge", (req, res) => {
    const sessionId = requireSessionId(req.query?.sessionId, res, req);
    if (!sessionId) return;

    res.json({ data: { documents: listDocuments(sessionId) }, traceId: "trace-local" });
  });

  app.post("/v1/knowledge", (req, res) => {
    const sessionId = requireSessionId(req.body?.sessionId, res, req);
    if (!sessionId) return;

    const title = typeof req.body?.title === "string" ? req.body.title : "";
    const body = typeof req.body?.body === "string" ? req.body.body : "";

    const document = addDocument(sessionId, {
      id: `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title,
      body
    });

    if (!document) {
      res.status(400).json({
        code: "INVALID_REQUEST",
        message: "A document needs a title and a body",
        traceId: "trace-local"
      });
      return;
    }

    res.status(201).json({
      data: {
        document,
        // Disclosed so a silently shortened paste is visible rather than assumed intact.
        truncated: body.trim().length > maxDocumentChars
      },
      traceId: "trace-local"
    });
  });

  // A document file - PDF, Word, PowerPoint or plain text - read on this
  // machine and kept as a knowledge document. The file is the raw request body
  // (application/octet-stream), so the JSON parser's 1 MB limit never sees it;
  // the name and session ride in the query.
  app.post("/v1/knowledge/import", express.raw({ type: "application/octet-stream", limit: maxDocumentBytes }), async (req, res) => {
    const sessionId = requireSessionId(req.query?.sessionId, res, req);
    if (!sessionId) return;

    const fileName = typeof req.query?.name === "string" ? path.basename(req.query.name).slice(0, 200) : "";
    if (!Buffer.isBuffer(req.body) || req.body.length === 0 || !fileName) {
      res.status(400).json({ code: "INVALID_REQUEST", message: "Send the file itself as the body, with its name.", traceId: "trace-local" });
      return;
    }

    const extracted = await extractDocumentText(req.body, fileName);
    if (!extracted.ok) {
      res.status(422).json({ code: "UNREADABLE_DOCUMENT", message: extracted.reason, traceId: "trace-local" });
      return;
    }

    const title = fileName.replace(/\.[a-z0-9]{1,5}$/i, "").replace(/[_]+/g, " ").trim() || fileName;
    const document = addDocument(sessionId, {
      id: `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title,
      body: extracted.text
    });
    if (!document) {
      res.status(422).json({ code: "UNREADABLE_DOCUMENT", message: "The document had no text to keep.", traceId: "trace-local" });
      return;
    }

    res.status(201).json({
      data: {
        // The text stays on the server; the reply says what was kept, not all of it.
        document: { id: document.id, title: document.title, createdAt: document.createdAt, characters: document.body.length },
        kind: extracted.kind,
        ...(extracted.pages ? { pages: extracted.pages } : {}),
        truncated: extracted.text.length > maxDocumentChars
      },
      traceId: "trace-local"
    });
  });

  // E-Tasks: a plain to-do list, scoped per session exactly like knowledge
  // documents. Not to be confused with the orchestrator's own StoredTask —
  // that is one in-flight job per session, resolved on a "continue" follow
  // up; this is a list the user wrote down themselves, and the two never
  // read each other.
  app.get("/v1/tasks", (req, res) => {
    const sessionId = requireSessionId(req.query?.sessionId, res, req);
    if (!sessionId) return;

    res.json({ data: { tasks: listTasks(sessionId) }, traceId: "trace-local" });
  });

  app.post("/v1/tasks", (req, res) => {
    const sessionId = requireSessionId(req.body?.sessionId, res, req);
    if (!sessionId) return;

    const title = typeof req.body?.title === "string" ? req.body.title : "";
    const task = addTask(sessionId, { id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, title });

    if (!task) {
      res.status(400).json({ code: "INVALID_REQUEST", message: "A task needs a title", traceId: "trace-local" });
      return;
    }

    res.status(201).json({ data: { task }, traceId: "trace-local" });
  });

  app.patch("/v1/tasks/:taskId", (req, res) => {
    const sessionId = requireSessionId(req.body?.sessionId, res, req);
    if (!sessionId) return;

    if (typeof req.body?.done !== "boolean") {
      res.status(400).json({ code: "INVALID_REQUEST", message: "done must be a boolean", traceId: "trace-local" });
      return;
    }

    const task = setTaskDone(sessionId, req.params.taskId, req.body.done);
    if (!task) {
      res.status(404).json({ code: "NOT_FOUND", message: "Task not found", traceId: "trace-local" });
      return;
    }

    res.json({ data: { task }, traceId: "trace-local" });
  });

  app.delete("/v1/tasks/:taskId", (req, res) => {
    const sessionId = requireSessionId(req.query?.sessionId, res, req);
    if (!sessionId) return;

    if (!removeTask(sessionId, req.params.taskId)) {
      res.status(404).json({ code: "NOT_FOUND", message: "Task not found", traceId: "trace-local" });
      return;
    }

    res.status(204).end();
  });

  app.delete("/v1/knowledge/:documentId", (req, res) => {
    const sessionId = requireSessionId(req.query?.sessionId, res, req);
    if (!sessionId) return;

    if (!removeDocument(sessionId, req.params.documentId)) {
      res.status(404).json({
        code: "NOT_FOUND",
        message: "Document not found",
        traceId: "trace-local"
      });
      return;
    }

    res.status(204).end();
  });

  app.patch("/v1/assist/memory/:memoryId", (req, res) => {
    const sessionId = requireSessionId(req.body?.sessionId, res, req);
    if (!sessionId) return;

    const { memoryId } = req.params;
    let updated = null;

    if (typeof req.body?.pinned === "boolean") {
      updated = setMemoryPinned(sessionId, memoryId, req.body.pinned);
    }

    if (typeof req.body?.title === "string") {
      const relabeled = relabelMemory(sessionId, memoryId, req.body.title);
      if (relabeled) {
        updated = relabeled;
      }
    }

    if (!updated) {
      res.status(404).json({
        code: "NOT_FOUND",
        message: "Memory not found or no valid update supplied",
        traceId: "trace-local"
      });
      return;
    }

    res.json({ data: { memory: updated }, traceId: "trace-local" });
  });

  app.delete("/v1/assist/memory/:memoryId", (req, res) => {
    const sessionId = requireSessionId(req.query?.sessionId ?? req.body?.sessionId, res, req);
    if (!sessionId) return;

    const { memoryId } = req.params;
    const removed = memoryId === "all"
      ? forgetAllMemories(sessionId) > 0
      : forgetMemory(sessionId, memoryId);

    if (!removed) {
      res.status(404).json({
        code: "NOT_FOUND",
        message: "Memory not found",
        traceId: "trace-local"
      });
      return;
    }

    res.json({ data: { forgotten: true }, traceId: "trace-local" });
  });

  app.use((error: Error & { statusCode?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const statusCode = error.statusCode ?? 500;
    res.status(statusCode).json({
      code: statusCode >= 500 ? "INTERNAL_ERROR" : "REQUEST_ERROR",
      message: error.message,
      traceId: "trace-local"
    });
  });

  app.use((req, res) => {
    res.status(404).json({
      code: "NOT_FOUND",
      message: `Route not found: ${req.method} ${req.path}`,
      traceId: "n/a"
    });
  });

  return app;
}
