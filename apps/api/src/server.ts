import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import { runAssistantOrchestrator } from "./services/orchestrator.js";
import { clearActivity, getActivity } from "./services/agentActivity.js";
import { normalizeAssistHistory } from "./services/assistContext.js";
import { appendTurn, clearConversation, listTurns } from "./services/conversationStore.js";
import {
  forgetAllMemories,
  forgetMemory,
  getMemoryAudit,
  listSessionMemories,
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
import { checkAvailability, readLocalModelConfig } from "./services/localModel.js";
import { readPreferences, updatePreferences } from "./services/preferences.js";
import { getBuildInfo } from "./services/buildInfo.js";
import { getSystemCapabilities, toolsByLevel } from "./services/systemCapabilities.js";
import {
  clearPendingConfirmation,
  describePendingAction,
  getPendingConfirmation
} from "./services/pendingConfirmation.js";
import { maxSynthesisCharacters, piperStatus, synthesize, type Cadence } from "./services/piperSpeech.js";

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

/** Client-supplied cadence, or undefined to let the voice's default stand. */
function normalizeCadence(value: unknown): Cadence | undefined {
  if (value === "measured" || value === "brisk" || value === "playful" || value === "deliberate") {
    return value;
  }
  return undefined;
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
  app.use(express.json({ limit: "1mb" }));
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
      const savedMemories = sessionId ? recordMemoriesFromMessage(sessionId, message) : [];
      // Widen the candidate set: the composer scores for relevance, so limiting to
      // the 5 newest would hide the one memory that actually answers the question.
      const memoryContext = sessionId ? retrieveSessionMemories(sessionId, memoryCandidateLimit) : [];

      // Fall back to the stored transcript when the client sends none — that is
      // what lets a fresh browser continue an existing conversation.
      const history = clientHistory.length > 0 || !sessionId
        ? clientHistory
        : normalizeAssistHistory(
          listTurns(sessionId).map((turn) => ({ role: turn.role, content: turn.content }))
        );

      const result = await runAssistantOrchestrator({
        mode,
        userMessage: message,
        sessionId: sessionId ?? undefined,
        history,
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
          savedBodies: savedMemories.map((memory) => memory.body)
        },
        knowledge: sessionId ? retrieveKnowledgePassages(sessionId) : [],
        // The write path for the assistant's own "remember" tool. Omitted
        // without a session, so the tool reports that nothing was saved rather
        // than the assistant claiming a write that had nowhere to go.
        saveMemory: sessionId
          ? (fact: string) => recordSingleMemory(sessionId, fact).status
          : undefined,
        forgetMemory: sessionId ? (id: string) => forgetMemory(sessionId, id) : undefined,
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
          : undefined
      }).finally(() => {
        // Whatever a client polling /v1/assist/activity mid-turn was told is
        // stale the instant this turn ends, success or failure alike.
        if (sessionId) clearActivity(sessionId);
      });

      // Recorded after a successful reply so a failed request leaves no orphan turn.
      if (sessionId) {
        appendTurn(sessionId, "user", message);
        // The assistant turn carries how it was produced, so a reloaded
        // transcript still shows whether an answer was quoted or generated.
        appendTurn(sessionId, "assistant", result.assistantMessage, {
          strategy: result.strategy,
          // Present only when the permission gate refused something. The
          // client renders a confirmation dialog from it.
          ...(result.pendingConfirmation ? { pendingConfirmation: result.pendingConfirmation } : {}),
          model: result.model
        });
      }

      res.json({
        data: {
          assistantMessage: result.assistantMessage,
          model: result.model,
          mode,
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

  app.get("/v1/assist/conversation", (req, res) => {
    const sessionId = requireSessionId(req.query?.sessionId, res, req);
    if (!sessionId) return;

    res.json({ data: { turns: listTurns(sessionId) }, traceId: "trace-local" });
  });

  app.delete("/v1/assist/conversation", (req, res) => {
    const sessionId = requireSessionId(req.query?.sessionId ?? req.body?.sessionId, res, req);
    if (!sessionId) return;

    res.json({ data: { cleared: clearConversation(sessionId) }, traceId: "trace-local" });
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
        audit: getMemoryAudit(sessionId, 20)
      },
      traceId: "trace-local"
    });
  });

  // What the assistant can currently do. The client shows a live indicator from
  // this, because whether a model is answering changes what the app is capable
  // of and the user should not have to discover that by asking a question.
  app.get("/v1/assist/model", async (_req, res) => {
    const availability = await checkAvailability(readLocalModelConfig());

    res.json({
      data: availability.available
        ? { available: true, model: availability.model }
        : { available: false, model: null, reason: availability.reason },
      traceId: "trace-local"
    });
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

  // Which tool the agent is running right now, for a client to poll while a
  // reply is in flight. Absent is a real answer — the model is still thinking,
  // or between tool calls — not an error, so this never 404s on a live session.
  app.get("/v1/assist/activity", (req, res) => {
    const sessionId = requireSessionId(req.query?.sessionId, res, req);
    if (!sessionId) return;

    const activity = getActivity(sessionId);
    res.json({ data: { tool: activity?.tool ?? null }, traceId: "trace-local" });
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
