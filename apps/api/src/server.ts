import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import { runAssistantOrchestrator } from "./services/orchestrator.js";
import { normalizeAssistHistory } from "./services/assistContext.js";
import { appendTurn, clearConversation, listTurns } from "./services/conversationStore.js";
import {
  forgetAllMemories,
  forgetMemory,
  getMemoryAudit,
  listSessionMemories,
  recordMemoriesFromMessage,
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
import { attachAuthIdentity } from "./middleware/auth.js";
import { v1MemoryRouter } from "./routes/v1Memory.js";
import { v1Router } from "./routes/v1.js";

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
  const storageBackend = (process.env.API_STORAGE_BACKEND ?? "memory").toLowerCase();

  app.use(helmet());
  app.use(cors({ origin: process.env.CORS_ORIGIN ?? "*" }));
  app.use(express.json({ limit: "1mb" }));
  app.use(morgan("tiny"));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "ascend-api" });
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
        memoryWrite: { available: sessionId !== null, saved: savedMemories.length },
        knowledge: sessionId ? retrieveKnowledgePassages(sessionId) : []
      });

      // Recorded after a successful reply so a failed request leaves no orphan turn.
      if (sessionId) {
        appendTurn(sessionId, "user", message);
        appendTurn(sessionId, "assistant", result.assistantMessage);
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
          // What the client should scaffold from: the original request merged
          // with any clarifying answer, not just this turn's text.
          buildRequest: result.buildRequest
        },
        traceId: "trace-local"
      });
    } catch (error) {
      next(error);
    }
  });

  // ---- Accounts -----------------------------------------------------------
  // Registered before attachAuthIdentity for the same reason /v1/assist is: this
  // is the layer that establishes identity, so it cannot require it.

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

  app.use(attachAuthIdentity());

  app.use("/v1", storageBackend === "postgres" ? v1Router : v1MemoryRouter);

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
