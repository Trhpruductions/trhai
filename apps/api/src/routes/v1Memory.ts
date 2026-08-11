import { NextFunction, Request, RequestHandler, Response, Router } from "express";
import { z } from "zod";
import { query } from "../db.js";
import { runAssistantOrchestrator } from "../services/orchestrator.js";

type Role = "owner" | "admin" | "member" | "viewer" | "billing_admin" | "automation_operator";
const assistantModes = ["general", "build", "code", "debug", "research", "plan", "coding", "business", "creator"] as const;
type Mode = typeof assistantModes[number];

type Workspace = {
  id: string;
  name: string;
  slug: string;
  planTier: "free" | "pro" | "business" | "enterprise";
  members: Array<{ userId: string; email: string; role: Role }>;
};

type Conversation = {
  id: string;
  workspaceId: string;
  mode: Mode;
  title: string | null;
};

type StoredMessage = {
  id: string;
  conversationId: string;
  workspaceId: string;
  role: "user" | "assistant";
  content: string;
  model: string | null;
  createdAt: string;
};

type Workflow = {
  id: string;
  workspaceId: string;
  name: string;
  version: number;
  status: "draft" | "active" | "paused" | "archived";
};

type MemoryEntry = {
  id: string;
  workspaceId: string;
  title: string;
  body: string;
  kind: string;
  createdAt: string;
};

type WorkflowRun = {
  id: string;
  workflowId: string;
  workspaceId: string;
  status: "queued" | "running" | "success" | "failed" | "cancelled";
  traceId: string;
  startedAt: string | null;
  endedAt: string | null;
};

type UsageEntry = {
  feature: "chat" | "coding" | "image" | "video" | "music" | "automation" | "api";
  quantity: number;
  unit: "tokens" | "seconds" | "jobs" | "bytes" | "requests";
  costUsdMicros: number;
};

const defaultTraceId = "trace-memory";
const seedUserId = "00000000-0000-0000-0000-000000000001";
let persistenceReady = false;
let persistenceMode: "database" | "memory" = "memory";
let persistenceInitPromise: Promise<void> | null = null;

const createWorkspaceSchema = z.object({
  name: z.string().trim().min(2).max(80)
});

const createConversationSchema = z.object({
  mode: z.enum(assistantModes),
  title: z.string().trim().max(200).optional().nullable(),
  projectId: z.string().uuid().optional().nullable()
});

const sendMessageSchema = z.object({
  content: z.string().trim().min(1),
  modeOverride: z.enum(assistantModes).optional(),
  stream: z.boolean().optional()
});

const createWorkflowSchema = z.object({
  name: z.string().trim().min(2).max(80),
  definition: z.record(z.string(), z.unknown()).optional()
});

const createMemorySchema = z.object({
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(4000),
  kind: z.string().trim().min(1).max(80).optional()
});

const workspaces = new Map<string, Workspace>();
const conversations = new Map<string, Conversation>();
const messagesByConversation = new Map<string, StoredMessage[]>();
const workflows = new Map<string, Workflow>();
const workflowRuns = new Map<string, WorkflowRun[]>();
const usageByWorkspace = new Map<string, UsageEntry[]>();
const memoryByWorkspace = new Map<string, MemoryEntry[]>();
const idempotencyStore = new Map<string, { statusCode: number; payload: unknown }>();
const telemetrySubscribers = new Map<string, Set<Response>>();
const telemetryFlushTimers = new Map<string, NodeJS.Timeout>();

function responseEnvelope(data: unknown) {
  return { data, traceId: defaultTraceId };
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 64);
  return slug || "workspace";
}

function asyncRoute(handler: (req: Request, res: Response, next: NextFunction) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    void handler(req, res, next).catch(next);
  };
}

function ensureWorkspaceRole(_allowed: Role[]): RequestHandler {
  return async (req, res, next) => {
    const workspaceId = req.params.workspaceId;
    if (!workspaceId) {
      res.status(404).json({ code: "NOT_FOUND", message: "Workspace not found", traceId: defaultTraceId });
      return;
    }

    await ensurePersistenceReady();
    if (!workspaces.has(workspaceId) && persistenceMode === "database") {
      await hydrateFromDatabase(workspaceId);
    }

    if (!workspaces.has(workspaceId)) {
      res.status(404).json({ code: "NOT_FOUND", message: "Workspace not found", traceId: defaultTraceId });
      return;
    }
    next();
  };
}

async function ensurePersistenceReady() {
  if (persistenceReady) return;
  if (!persistenceInitPromise) {
    persistenceInitPromise = initializePersistence();
  }
  await persistenceInitPromise;
}

async function initializePersistence() {
  if (!process.env.DATABASE_URL) {
    persistenceMode = "memory";
    persistenceReady = true;
    return;
  }

  try {
    await query("SELECT 1");
    await query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        auth_provider TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id UUID PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL,
        plan_tier TEXT NOT NULL DEFAULT 'free',
        created_by UUID NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS workspace_members (
        id UUID PRIMARY KEY,
        workspace_id UUID NOT NULL,
        user_id UUID NOT NULL,
        role TEXT NOT NULL,
        invited_by UUID,
        joined_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id UUID PRIMARY KEY,
        workspace_id UUID NOT NULL,
        project_id UUID,
        mode TEXT NOT NULL,
        title TEXT,
        created_by UUID NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS messages (
        id UUID PRIMARY KEY,
        conversation_id UUID NOT NULL,
        workspace_id UUID NOT NULL,
        role TEXT NOT NULL,
        content_json JSONB NOT NULL,
        token_input INTEGER,
        token_output INTEGER,
        model_name TEXT,
        trace_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS memory_records (
        id UUID PRIMARY KEY,
        workspace_id UUID NOT NULL,
        project_id UUID,
        owner_scope TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_id TEXT,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        created_by UUID NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS usage_events (
        id UUID PRIMARY KEY,
        workspace_id UUID NOT NULL,
        feature TEXT NOT NULL,
        quantity NUMERIC(20,6) NOT NULL,
        unit TEXT NOT NULL,
        cost_usd_micros BIGINT NOT NULL DEFAULT 0,
        trace_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await query(`
      INSERT INTO users (id, email, display_name, auth_provider, status)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (id) DO NOTHING
    `, [seedUserId, "owner@example.com", "Local Dev User", "local", "active"]);

    persistenceMode = "database";
    await hydrateFromDatabase();
  } catch (error) {
    console.warn("Falling back to in-memory persistence because the database is unavailable:", error);
    persistenceMode = "memory";
  } finally {
    persistenceReady = true;
  }
}

async function hydrateFromDatabase(workspaceId?: string) {
  if (persistenceMode !== "database") return;

  const workspaceRows = await query<{ id: string; name: string; slug: string; plan_tier: string }>(
    workspaceId
      ? `SELECT id, name, slug, plan_tier FROM workspaces WHERE id = $1 ORDER BY created_at ASC`
      : `SELECT id, name, slug, plan_tier FROM workspaces ORDER BY created_at ASC`,
    workspaceId ? [workspaceId] : []
  );

  for (const row of workspaceRows.rows) {
    if (!workspaces.has(row.id)) {
      workspaces.set(row.id, {
        id: row.id,
        name: row.name,
        slug: row.slug,
        planTier: row.plan_tier as Workspace["planTier"],
        members: [{ userId: seedUserId, email: "owner@example.com", role: "owner" }]
      });
    }
  }

  const conversationRows = await query<{ id: string; workspace_id: string; mode: Mode; title: string | null }>(
    workspaceId
      ? `SELECT id, workspace_id, mode, title FROM conversations WHERE workspace_id = $1 ORDER BY created_at ASC`
      : `SELECT id, workspace_id, mode, title FROM conversations ORDER BY created_at ASC`,
    workspaceId ? [workspaceId] : []
  );

  for (const row of conversationRows.rows) {
    const conversation = {
      id: row.id,
      workspaceId: row.workspace_id,
      mode: row.mode,
      title: row.title
    };
    conversations.set(row.id, conversation);
    if (!messagesByConversation.has(row.id)) {
      messagesByConversation.set(row.id, []);
    }
  }

  const messageRows = await query<{ id: string; conversation_id: string; workspace_id: string; role: "user" | "assistant"; content_json: { content?: string } | string; model_name: string | null; created_at: string }>(
    workspaceId
      ? `SELECT id, conversation_id, workspace_id, role, content_json, model_name, created_at FROM messages WHERE workspace_id = $1 ORDER BY created_at ASC`
      : `SELECT id, conversation_id, workspace_id, role, content_json, model_name, created_at FROM messages ORDER BY created_at ASC`,
    workspaceId ? [workspaceId] : []
  );

  for (const row of messageRows.rows) {
    const contentPayload = typeof row.content_json === "string" ? JSON.parse(row.content_json) : row.content_json;
    const message: StoredMessage = {
      id: row.id,
      conversationId: row.conversation_id,
      workspaceId: row.workspace_id,
      role: row.role,
      content: contentPayload.content ?? "",
      model: row.model_name,
      createdAt: row.created_at
    };
    const current = messagesByConversation.get(row.conversation_id) ?? [];
    current.push(message);
    messagesByConversation.set(row.conversation_id, current);
  }

  const memoryRows = await query<{ id: string; workspace_id: string; title: string; body: string; source_type: string; created_at: string }>(
    workspaceId
      ? `SELECT id, workspace_id, title, body, source_type, created_at FROM memory_records WHERE workspace_id = $1 ORDER BY created_at ASC`
      : `SELECT id, workspace_id, title, body, source_type, created_at FROM memory_records ORDER BY created_at ASC`,
    workspaceId ? [workspaceId] : []
  );

  for (const row of memoryRows.rows) {
    const current = memoryByWorkspace.get(row.workspace_id) ?? [];
    current.push({
      id: row.id,
      workspaceId: row.workspace_id,
      title: row.title,
      body: row.body,
      kind: row.source_type,
      createdAt: row.created_at
    });
    memoryByWorkspace.set(row.workspace_id, current);
  }
}

function recordUsage(workspaceId: string, usage: UsageEntry) {
  const current = usageByWorkspace.get(workspaceId) ?? [];
  current.push(usage);
  usageByWorkspace.set(workspaceId, current);
}

async function persistWorkspaceToDatabase(workspace: Workspace) {
  if (persistenceMode !== "database") return;
  await query(`
    INSERT INTO workspaces (id, name, slug, plan_tier, created_by, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      slug = EXCLUDED.slug,
      plan_tier = EXCLUDED.plan_tier,
      updated_at = NOW()
  `, [workspace.id, workspace.name, workspace.slug, workspace.planTier, seedUserId]);

  await query(`
    INSERT INTO workspace_members (id, workspace_id, user_id, role, invited_by, joined_at, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, NOW(), NOW(), NOW())
    ON CONFLICT (workspace_id, user_id) DO NOTHING
  `, [crypto.randomUUID(), workspace.id, seedUserId, "owner", seedUserId]);
}

async function persistConversationToDatabase(conversation: Conversation) {
  if (persistenceMode !== "database") return;
  await query(`
    INSERT INTO conversations (id, workspace_id, project_id, mode, title, created_by, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
    ON CONFLICT (id) DO UPDATE SET
      workspace_id = EXCLUDED.workspace_id,
      project_id = EXCLUDED.project_id,
      mode = EXCLUDED.mode,
      title = EXCLUDED.title,
      updated_at = NOW()
  `, [conversation.id, conversation.workspaceId, null, conversation.mode, conversation.title, seedUserId]);
}

async function persistMessageToDatabase(message: StoredMessage) {
  if (persistenceMode !== "database") return;
  await query(`
    INSERT INTO messages (id, conversation_id, workspace_id, role, content_json, token_input, token_output, model_name, trace_id, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
  `, [
    message.id,
    message.conversationId,
    message.workspaceId,
    message.role,
    JSON.stringify({ content: message.content }),
    null,
    null,
    message.model,
    defaultTraceId
  ]);
}

async function getConversationsFromDatabase(workspaceId: string): Promise<Conversation[]> {
  if (persistenceMode !== "database") return [];
  const result = await query<{ id: string; workspace_id: string; mode: Mode; title: string | null }>(
    `SELECT id, workspace_id, mode, title FROM conversations WHERE workspace_id = $1 ORDER BY created_at ASC`,
    [workspaceId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    mode: row.mode,
    title: row.title
  }));
}

async function getMessagesFromDatabase(conversationId: string): Promise<StoredMessage[]> {
  if (persistenceMode !== "database") return [];
  const result = await query<{ id: string; conversation_id: string; workspace_id: string; role: "user" | "assistant"; content_json: { content?: string } | string; model_name: string | null; created_at: string }>(
    `SELECT id, conversation_id, workspace_id, role, content_json, model_name, created_at FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
    [conversationId]
  );

  return result.rows.map((row) => {
    const contentPayload = typeof row.content_json === "string" ? JSON.parse(row.content_json) : row.content_json;
    return {
      id: row.id,
      conversationId: row.conversation_id,
      workspaceId: row.workspace_id,
      role: row.role,
      content: contentPayload.content ?? "",
      model: row.model_name,
      createdAt: row.created_at
    };
  });
}

async function persistMemoryToDatabase(entry: MemoryEntry) {
  if (persistenceMode !== "database") return;
  await query(`
    INSERT INTO memory_records (id, workspace_id, project_id, owner_scope, source_type, source_id, title, body, created_by, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
  `, [entry.id, entry.workspaceId, null, "workspace", "manual", entry.id, entry.title, entry.body, seedUserId]);
}

async function getMemoryFromDatabase(workspaceId: string): Promise<MemoryEntry[]> {
  if (persistenceMode !== "database") return [];
  const result = await query<{ id: string; workspace_id: string; title: string; body: string; source_type: string; created_at: string }>(
    `SELECT id, workspace_id, title, body, source_type, created_at FROM memory_records WHERE workspace_id = $1 ORDER BY created_at ASC`,
    [workspaceId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    body: row.body,
    kind: row.source_type,
    createdAt: row.created_at
  }));
}

async function persistUsageToDatabase(workspaceId: string, usage: UsageEntry) {
  if (persistenceMode !== "database") return;
  await query(`
    INSERT INTO usage_events (id, workspace_id, feature, quantity, unit, cost_usd_micros, trace_id, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
  `, [crypto.randomUUID(), workspaceId, usage.feature, usage.quantity, usage.unit, usage.costUsdMicros, defaultTraceId]);
}

function getWorkspaceTelemetrySnapshot(workspaceId: string) {
  const workspaceConversations = [...conversations.values()].filter((conversation) => conversation.workspaceId === workspaceId);
  const conversationIds = new Set(workspaceConversations.map((conversation) => conversation.id));
  const workspaceMessages = [...messagesByConversation.entries()]
    .filter(([conversationId]) => conversationIds.has(conversationId))
    .flatMap(([, items]) => items);

  const workspaceWorkflows = [...workflows.values()].filter((workflow) => workflow.workspaceId === workspaceId);
  const workspaceWorkflowRuns = workspaceWorkflows.flatMap((workflow) => workflowRuns.get(workflow.id) ?? []);
  const workspaceMemory = memoryByWorkspace.get(workspaceId) ?? [];
  const workspaceUsage = usageByWorkspace.get(workspaceId) ?? [];

  const tokenUsage = workspaceUsage
    .filter((entry) => entry.unit === "tokens")
    .reduce((sum, entry) => sum + entry.quantity, 0);
  const automationJobs = workspaceUsage
    .filter((entry) => entry.feature === "automation" && entry.unit === "jobs")
    .reduce((sum, entry) => sum + entry.quantity, 0);

  return {
    workspaceId,
    counts: {
      conversations: workspaceConversations.length,
      messages: workspaceMessages.length,
      memoryRecords: workspaceMemory.length,
      workflows: workspaceWorkflows.length,
      workflowRuns: workspaceWorkflowRuns.length
    },
    usage: {
      tokenUsage,
      automationJobs,
      usageEvents: workspaceUsage.length
    },
    health: {
      persistenceMode,
      updatedAt: new Date().toISOString()
    }
  };
}

function subscribeTelemetry(workspaceId: string, response: Response) {
  const current = telemetrySubscribers.get(workspaceId) ?? new Set<Response>();
  current.add(response);
  telemetrySubscribers.set(workspaceId, current);
}

function unsubscribeTelemetry(workspaceId: string, response: Response) {
  const current = telemetrySubscribers.get(workspaceId);
  if (!current) return;

  current.delete(response);
  if (current.size === 0) {
    telemetrySubscribers.delete(workspaceId);
  }
}

function emitTelemetrySnapshot(workspaceId: string) {
  const subscribers = telemetrySubscribers.get(workspaceId);
  if (!subscribers || subscribers.size === 0) return;

  const snapshot = getWorkspaceTelemetrySnapshot(workspaceId);
  const payload = `event: telemetry\ndata: ${JSON.stringify(responseEnvelope(snapshot))}\n\n`;

  for (const response of [...subscribers]) {
    try {
      response.write(payload);
    } catch {
      unsubscribeTelemetry(workspaceId, response);
    }
  }
}

function scheduleTelemetrySnapshot(workspaceId: string, delayMs = 140) {
  if (telemetryFlushTimers.has(workspaceId)) return;

  const timer = setTimeout(() => {
    telemetryFlushTimers.delete(workspaceId);
    emitTelemetrySnapshot(workspaceId);
  }, delayMs);

  telemetryFlushTimers.set(workspaceId, timer);
}

export const v1MemoryRouter = Router();

v1MemoryRouter.post(
  "/workspaces",
  asyncRoute(async (req, res) => {
    const parsed = createWorkspaceSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ code: "INVALID_REQUEST", message: "Invalid workspace payload", traceId: defaultTraceId });
      return;
    }

    const id = crypto.randomUUID();
    const workspace: Workspace = {
      id,
      name: parsed.data.name,
      slug: slugify(parsed.data.name),
      planTier: "free",
      members: [
        {
          userId: "dev-user",
          email: "owner@example.com",
          role: "owner"
        }
      ]
    };

    workspaces.set(id, workspace);
    await ensurePersistenceReady();
    await persistWorkspaceToDatabase(workspace);

    res.status(201).json(
      responseEnvelope({
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        planTier: workspace.planTier
      })
    );
  })
);

v1MemoryRouter.get(
  "/workspaces/:workspaceId/members",
  ensureWorkspaceRole(["owner", "admin", "member", "viewer", "billing_admin", "automation_operator"]),
  asyncRoute(async (req, res) => {
    const workspace = workspaces.get(req.params.workspaceId)!;
    res.json(
      responseEnvelope(
        workspace.members.map((member) => ({
          userId: member.userId,
          email: member.email,
          role: member.role
        }))
      )
    );
  })
);

v1MemoryRouter.post(
  "/workspaces/:workspaceId/conversations",
  ensureWorkspaceRole(["owner", "admin", "member", "automation_operator"]),
  asyncRoute(async (req, res) => {
    const parsed = createConversationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ code: "INVALID_REQUEST", message: "Invalid conversation payload", traceId: defaultTraceId });
      return;
    }

    const id = crypto.randomUUID();
    const conversation: Conversation = {
      id,
      workspaceId: req.params.workspaceId,
      mode: parsed.data.mode,
      title: parsed.data.title ?? null
    };

    conversations.set(id, conversation);
    messagesByConversation.set(id, []);
    await ensurePersistenceReady();
    await persistConversationToDatabase(conversation);
    scheduleTelemetrySnapshot(conversation.workspaceId);

    res.status(201).json(
      responseEnvelope({
        id: conversation.id,
        workspaceId: conversation.workspaceId,
        projectId: null,
        mode: conversation.mode,
        title: conversation.title
      })
    );
  })
);

v1MemoryRouter.get(
  "/workspaces/:workspaceId/conversations",
  ensureWorkspaceRole(["owner", "admin", "member", "viewer", "billing_admin", "automation_operator"]),
  asyncRoute(async (req, res) => {
    const page = Math.max(1, Number(req.query.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize ?? 20)));

    await ensurePersistenceReady();
    const databaseConversations = await getConversationsFromDatabase(req.params.workspaceId);
    const allItems = databaseConversations.length > 0
      ? databaseConversations
      : [...conversations.values()].filter((item) => item.workspaceId === req.params.workspaceId);
    const total = allItems.length;
    const offset = (page - 1) * pageSize;
    const slice = allItems.slice(offset, offset + pageSize);

    res.json({
      data: slice.map((item) => ({
        id: item.id,
        workspaceId: item.workspaceId,
        projectId: null,
        mode: item.mode,
        title: item.title
      })),
      meta: {
        page,
        pageSize,
        total,
        hasNext: offset + slice.length < total
      },
      traceId: defaultTraceId
    });
  })
);

v1MemoryRouter.post(
  "/workspaces/:workspaceId/conversations/:conversationId/messages",
  ensureWorkspaceRole(["owner", "admin", "member", "automation_operator"]),
  asyncRoute(async (req, res) => {
    const idempotencyKey = req.header("Idempotency-Key")?.trim();
    if (!idempotencyKey) {
      res.status(400).json({ code: "IDEMPOTENCY_KEY_REQUIRED", message: "Idempotency-Key header is required", traceId: defaultTraceId });
      return;
    }

    const idempotencyRouteKey = `${req.params.workspaceId}:msg:${req.params.conversationId}:${idempotencyKey}`;
    const existing = idempotencyStore.get(idempotencyRouteKey);
    if (existing) {
      res.status(existing.statusCode).json(existing.payload);
      return;
    }

    const parsed = sendMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ code: "INVALID_REQUEST", message: "Invalid message payload", traceId: defaultTraceId });
      return;
    }

    const conversation = conversations.get(req.params.conversationId);
    if (!conversation || conversation.workspaceId !== req.params.workspaceId) {
      res.status(404).json({ code: "NOT_FOUND", message: "Conversation not found", traceId: defaultTraceId });
      return;
    }

    const mode = parsed.data.modeOverride ?? conversation.mode;
    const recentHistory = (messagesByConversation.get(conversation.id) ?? [])
      .slice(-4)
      .map((message) => ({ role: message.role, content: message.content }));
    const workspaceMemory = (memoryByWorkspace.get(conversation.workspaceId) ?? [])
      .slice(-6)
      .map((entry) => ({ title: entry.title, body: entry.body }));

    const orchestrated = await runAssistantOrchestrator({
      mode,
      userMessage: parsed.data.content,
      memoryContext: workspaceMemory,
      history: recentHistory
    });

    const createdAt = new Date().toISOString();
    const userMessage: StoredMessage = {
      id: crypto.randomUUID(),
      conversationId: conversation.id,
      workspaceId: conversation.workspaceId,
      role: "user",
      content: parsed.data.content,
      model: null,
      createdAt
    };

    const assistantMessage: StoredMessage = {
      id: crypto.randomUUID(),
      conversationId: conversation.id,
      workspaceId: conversation.workspaceId,
      role: "assistant",
      content: orchestrated.assistantMessage,
      model: orchestrated.model,
      createdAt: new Date().toISOString()
    };

    const list = messagesByConversation.get(conversation.id) ?? [];
    list.push(userMessage, assistantMessage);
    messagesByConversation.set(conversation.id, list);
    await ensurePersistenceReady();
    await persistMessageToDatabase(userMessage);
    await persistMessageToDatabase(assistantMessage);

    recordUsage(conversation.workspaceId, {
      feature: "chat",
      quantity: orchestrated.inputTokens + orchestrated.outputTokens,
      unit: "tokens",
      costUsdMicros: 0
    });
    await persistUsageToDatabase(conversation.workspaceId, {
      feature: "chat",
      quantity: orchestrated.inputTokens + orchestrated.outputTokens,
      unit: "tokens",
      costUsdMicros: 0
    });

    const payload = responseEnvelope({
      userMessage: {
        id: userMessage.id,
        role: "user",
        content: userMessage.content,
        model: userMessage.model,
        traceId: defaultTraceId,
        createdAt: userMessage.createdAt
      },
      assistantMessage: {
        id: assistantMessage.id,
        role: "assistant",
        content: assistantMessage.content,
        model: assistantMessage.model,
        traceId: defaultTraceId,
        createdAt: assistantMessage.createdAt
      },
      usage: {
        inputTokens: orchestrated.inputTokens,
        outputTokens: orchestrated.outputTokens,
        model: orchestrated.model
      }
    });

    const normalizedPayload = {
      data: payload.data,
      traceId: payload.traceId
    };

    idempotencyStore.set(idempotencyRouteKey, { statusCode: 200, payload: normalizedPayload });
    scheduleTelemetrySnapshot(conversation.workspaceId);
    res.json(normalizedPayload);
  })
);

v1MemoryRouter.post(
  "/workspaces/:workspaceId/memory",
  ensureWorkspaceRole(["owner", "admin", "member", "automation_operator"]),
  asyncRoute(async (req, res) => {
    const parsed = createMemorySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ code: "INVALID_REQUEST", message: "Invalid memory payload", traceId: defaultTraceId });
      return;
    }

    const entry: MemoryEntry = {
      id: crypto.randomUUID(),
      workspaceId: req.params.workspaceId,
      title: parsed.data.title,
      body: parsed.data.body,
      kind: parsed.data.kind ?? "memory",
      createdAt: new Date().toISOString()
    };

    const current = memoryByWorkspace.get(req.params.workspaceId) ?? [];
    current.push(entry);
    memoryByWorkspace.set(req.params.workspaceId, current);
    await ensurePersistenceReady();
    await persistMemoryToDatabase(entry);
    scheduleTelemetrySnapshot(entry.workspaceId);

    res.status(201).json(responseEnvelope({
      id: entry.id,
      workspaceId: entry.workspaceId,
      title: entry.title,
      body: entry.body,
      kind: entry.kind,
      createdAt: entry.createdAt
    }));
  })
);

v1MemoryRouter.get(
  "/workspaces/:workspaceId/memory",
  ensureWorkspaceRole(["owner", "admin", "member", "viewer", "billing_admin", "automation_operator"]),
  asyncRoute(async (req, res) => {
    await ensurePersistenceReady();
    const databaseEntries = await getMemoryFromDatabase(req.params.workspaceId);
    const entries = databaseEntries.length > 0
      ? databaseEntries.slice(-12).reverse()
      : (memoryByWorkspace.get(req.params.workspaceId) ?? []).slice(-12).reverse();
    res.json(responseEnvelope(entries.map((entry) => ({
      id: entry.id,
      workspaceId: entry.workspaceId,
      title: entry.title,
      body: entry.body,
      kind: entry.kind,
      createdAt: entry.createdAt
    }))));
  })
);

v1MemoryRouter.post(
  "/workspaces/:workspaceId/workflows",
  ensureWorkspaceRole(["owner", "admin", "member", "automation_operator"]),
  asyncRoute(async (req, res) => {
    const parsed = createWorkflowSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ code: "INVALID_REQUEST", message: "Invalid workflow payload", traceId: defaultTraceId });
      return;
    }

    const workflow: Workflow = {
      id: crypto.randomUUID(),
      workspaceId: req.params.workspaceId,
      name: parsed.data.name,
      version: 1,
      status: "draft"
    };
    workflows.set(workflow.id, workflow);
    scheduleTelemetrySnapshot(workflow.workspaceId);

    res.status(201).json(
      responseEnvelope({
        id: workflow.id,
        workspaceId: workflow.workspaceId,
        name: workflow.name,
        version: workflow.version,
        status: workflow.status
      })
    );
  })
);

v1MemoryRouter.post(
  "/workspaces/:workspaceId/workflows/:workflowId/runs",
  ensureWorkspaceRole(["owner", "admin", "member", "automation_operator"]),
  asyncRoute(async (req, res) => {
    const idempotencyKey = req.header("Idempotency-Key")?.trim();
    if (!idempotencyKey) {
      res.status(400).json({ code: "IDEMPOTENCY_KEY_REQUIRED", message: "Idempotency-Key header is required", traceId: defaultTraceId });
      return;
    }

    const routeKey = `${req.params.workspaceId}:run:${req.params.workflowId}:${idempotencyKey}`;
    const existing = idempotencyStore.get(routeKey);
    if (existing) {
      res.status(existing.statusCode).json(existing.payload);
      return;
    }

    const workflow = workflows.get(req.params.workflowId);
    if (!workflow || workflow.workspaceId !== req.params.workspaceId) {
      res.status(404).json({ code: "NOT_FOUND", message: "Workflow not found", traceId: defaultTraceId });
      return;
    }

    const run: WorkflowRun = {
      id: crypto.randomUUID(),
      workflowId: workflow.id,
      workspaceId: workflow.workspaceId,
      status: "queued",
      traceId: defaultTraceId,
      startedAt: null,
      endedAt: null
    };

    const runs = workflowRuns.get(workflow.id) ?? [];
    runs.push(run);
    workflowRuns.set(workflow.id, runs);

    recordUsage(workflow.workspaceId, {
      feature: "automation",
      quantity: 1,
      unit: "jobs",
      costUsdMicros: 0
    });
    await persistUsageToDatabase(workflow.workspaceId, {
      feature: "automation",
      quantity: 1,
      unit: "jobs",
      costUsdMicros: 0
    });

    const payload = responseEnvelope({
      id: run.id,
      workflowId: run.workflowId,
      status: run.status,
      traceId: run.traceId,
      startedAt: run.startedAt,
      endedAt: run.endedAt
    });

    idempotencyStore.set(routeKey, { statusCode: 202, payload });
    scheduleTelemetrySnapshot(workflow.workspaceId);
    res.status(202).json(payload);
  })
);

v1MemoryRouter.get(
  "/workspaces/:workspaceId/telemetry/stream",
  ensureWorkspaceRole(["owner", "admin", "member", "viewer", "billing_admin", "automation_operator"]),
  asyncRoute(async (req, res) => {
    await ensurePersistenceReady();

    const workspaceId = req.params.workspaceId;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    subscribeTelemetry(workspaceId, res);
    emitTelemetrySnapshot(workspaceId);

    const heartbeat = setInterval(() => {
      res.write(": heartbeat\n\n");
    }, 15000);

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribeTelemetry(workspaceId, res);
      res.end();
    });
  })
);

v1MemoryRouter.get(
  "/workspaces/:workspaceId/telemetry",
  ensureWorkspaceRole(["owner", "admin", "member", "viewer", "billing_admin", "automation_operator"]),
  asyncRoute(async (req, res) => {
    await ensurePersistenceReady();
    const snapshot = getWorkspaceTelemetrySnapshot(req.params.workspaceId);
    res.json(responseEnvelope(snapshot));
  })
);

v1MemoryRouter.get(
  "/workspaces/:workspaceId/usage",
  ensureWorkspaceRole(["owner", "admin", "billing_admin"]),
  asyncRoute(async (req, res) => {
    const entries = usageByWorkspace.get(req.params.workspaceId) ?? [];
    const aggregate = new Map<string, UsageEntry>();

    for (const entry of entries) {
      const key = `${entry.feature}:${entry.unit}`;
      const current = aggregate.get(key);
      if (!current) {
        aggregate.set(key, { ...entry });
      } else {
        current.quantity += entry.quantity;
        current.costUsdMicros += entry.costUsdMicros;
      }
    }

    res.json(
      responseEnvelope({
        workspaceId: req.params.workspaceId,
        from: null,
        to: null,
        totals: [...aggregate.values()].map((entry) => ({
          feature: entry.feature,
          quantity: entry.quantity,
          unit: entry.unit,
          costUsdMicros: entry.costUsdMicros
        }))
      })
    );
  })
);
