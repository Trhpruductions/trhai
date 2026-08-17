import { NextFunction, Request, RequestHandler, Response, Router } from "express";
import { z } from "zod";
import { slugify } from "@ascend/shared";
import { query, withTransaction } from "../db.js";
import {
  findIdempotentResponse,
  readIdempotencyKey,
  saveIdempotentResponse
} from "../middleware/idempotency.js";
import { requireWorkspaceRole } from "../middleware/rbac.js";
import { ensureActorUserWithClient } from "../services/actor.js";
import { runAssistantOrchestrator } from "../services/orchestrator.js";

const defaultTraceId = "trace-local";
const assistantModes = ["general", "build", "code", "debug", "research", "plan", "coding", "business", "creator"] as const;
type AssistantMode = typeof assistantModes[number];

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

function responseEnvelope(data: unknown) {
  return {
    data,
    traceId: defaultTraceId
  };
}

function asyncRoute(handler: (req: Request, res: Response, next: NextFunction) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    void handler(req, res, next).catch(next);
  };
}

type MemoryRow = {
  id: string;
  title: string;
  body: string;
  owner_scope: "personal" | "workspace" | "team";
  source_type: "conversation" | "file" | "workflow" | "manual";
  pinned: boolean;
  locked: boolean;
  created_at: string;
};

export const v1Router = Router();

v1Router.post(
  "/workspaces",
  asyncRoute(async (req, res) => {
    const parsed = createWorkspaceSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ code: "INVALID_REQUEST", message: "Invalid workspace payload", traceId: defaultTraceId });
      return;
    }

    const workspace = await withTransaction(async (client) => {
      const actor = await ensureActorUserWithClient(client, req);
      const baseSlug = slugify(parsed.data.name, "workspace", 64);

      const result = await client.query<{ id: string; name: string; slug: string; plan_tier: string }>(
        `
        INSERT INTO workspaces (name, slug, created_by)
        VALUES ($1, $2, $3)
        RETURNING id, name, slug, plan_tier
        `,
        [parsed.data.name, baseSlug, actor.userId]
      );

      const created = result.rows[0];
      await client.query(
        `
        INSERT INTO workspace_members (workspace_id, user_id, role, invited_by, joined_at)
        VALUES ($1, $2, 'owner', $2, NOW())
        ON CONFLICT (workspace_id, user_id) DO NOTHING
        `,
        [created.id, actor.userId]
      );

      return created;
    });

    res.status(201).json(
      responseEnvelope({
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        planTier: workspace.plan_tier
      })
    );
  })
);

v1Router.get(
  "/workspaces/:workspaceId/members",
  requireWorkspaceRole(["owner", "admin", "member", "viewer", "billing_admin", "automation_operator"]),
  asyncRoute(async (req, res) => {
    const members = await query<{ user_id: string; email: string; role: string }>(
      `
      SELECT wm.user_id, u.email, wm.role
      FROM workspace_members wm
      JOIN users u ON u.id = wm.user_id
      WHERE wm.workspace_id = $1
      ORDER BY wm.created_at ASC
      `,
      [req.params.workspaceId]
    );

    res.json(
      responseEnvelope(
        members.rows.map((member) => ({
          userId: member.user_id,
          email: member.email,
          role: member.role
        }))
      )
    );
  })
);

v1Router.post(
  "/workspaces/:workspaceId/conversations",
  requireWorkspaceRole(["owner", "admin", "member", "automation_operator"]),
  asyncRoute(async (req, res) => {
    const parsed = createConversationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ code: "INVALID_REQUEST", message: "Invalid conversation payload", traceId: defaultTraceId });
      return;
    }

    const conversation = await withTransaction(async (client) => {
      const actor = await ensureActorUserWithClient(client, req);
      const inserted = await client.query<{
        id: string;
        workspace_id: string;
        project_id: string | null;
        mode: AssistantMode;
        title: string | null;
      }>(
        `
        INSERT INTO conversations (workspace_id, project_id, mode, title, created_by)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, workspace_id, project_id, mode, title
        `,
        [req.params.workspaceId, parsed.data.projectId ?? null, parsed.data.mode, parsed.data.title ?? null, actor.userId]
      );

      return inserted.rows[0];
    });

    res.status(201).json(
      responseEnvelope({
        id: conversation.id,
        workspaceId: conversation.workspace_id,
        projectId: conversation.project_id,
        mode: conversation.mode,
        title: conversation.title
      })
    );
  })
);

v1Router.get(
  "/workspaces/:workspaceId/conversations",
  requireWorkspaceRole(["owner", "admin", "member", "viewer", "billing_admin", "automation_operator"]),
  asyncRoute(async (req, res) => {
    const page = Math.max(1, Number(req.query.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize ?? 20)));
    const offset = (page - 1) * pageSize;

    const countResult = await query<{ total: string }>(
      "SELECT COUNT(*)::text AS total FROM conversations WHERE workspace_id = $1",
      [req.params.workspaceId]
    );

    const items = await query<{
      id: string;
      workspace_id: string;
      project_id: string | null;
      mode: AssistantMode;
      title: string | null;
    }>(
      `
      SELECT id, workspace_id, project_id, mode, title
      FROM conversations
      WHERE workspace_id = $1
      ORDER BY created_at DESC
      OFFSET $2 LIMIT $3
      `,
      [req.params.workspaceId, offset, pageSize]
    );

    const total = Number(countResult.rows[0]?.total ?? "0");
    const hasNext = offset + items.rows.length < total;

    res.json({
      data: items.rows.map((item) => ({
        id: item.id,
        workspaceId: item.workspace_id,
        projectId: item.project_id,
        mode: item.mode,
        title: item.title
      })),
      meta: {
        page,
        pageSize,
        total,
        hasNext
      },
      traceId: defaultTraceId
    });
  })
);

v1Router.post(
  "/workspaces/:workspaceId/conversations/:conversationId/messages",
  requireWorkspaceRole(["owner", "admin", "member", "automation_operator"]),
  asyncRoute(async (req, res) => {
    const idempotencyKey = readIdempotencyKey(req.header("Idempotency-Key") ?? undefined);
    if (!idempotencyKey) {
      res.status(400).json({ code: "IDEMPOTENCY_KEY_REQUIRED", message: "Idempotency-Key header is required", traceId: defaultTraceId });
      return;
    }

    const routeKey = "POST:/workspaces/:workspaceId/conversations/:conversationId/messages";
    const existing = await findIdempotentResponse(req.params.workspaceId, routeKey, idempotencyKey);
    if (existing) {
      res.status(existing.statusCode).json(existing.responseJson);
      return;
    }

    const parsed = sendMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ code: "INVALID_REQUEST", message: "Invalid message payload", traceId: defaultTraceId });
      return;
    }

    const result = await withTransaction(async (client) => {
      const actor = await ensureActorUserWithClient(client, req);

      const conversationResult = await client.query<{ mode: AssistantMode }>(
        `
        SELECT mode
        FROM conversations
        WHERE id = $1 AND workspace_id = $2
        `,
        [req.params.conversationId, req.params.workspaceId]
      );

      if (!conversationResult.rowCount) {
        const error = new Error("Conversation not found");
        (error as Error & { statusCode?: number }).statusCode = 404;
        throw error;
      }

      const mode = parsed.data.modeOverride ?? conversationResult.rows[0].mode;
      const orchestrated = await runAssistantOrchestrator({
        mode,
        userMessage: parsed.data.content
      });

      const userMessage = await client.query<{ id: string; created_at: string }>(
        `
        INSERT INTO messages (conversation_id, workspace_id, role, content_json, trace_id)
        VALUES ($1, $2, 'user', $3::jsonb, $4)
        RETURNING id, created_at
        `,
        [
          req.params.conversationId,
          req.params.workspaceId,
          JSON.stringify({ content: parsed.data.content }),
          defaultTraceId
        ]
      );

      const assistantMessage = await client.query<{
        id: string;
        created_at: string;
        model_name: string;
        token_input: number | null;
        token_output: number | null;
      }>(
        `
        INSERT INTO messages (
          conversation_id,
          workspace_id,
          role,
          content_json,
          model_name,
          token_input,
          token_output,
          trace_id
        )
        VALUES ($1, $2, 'assistant', $3::jsonb, $4, $5, $6, $7)
        RETURNING id, created_at, model_name, token_input, token_output
        `,
        [
          req.params.conversationId,
          req.params.workspaceId,
          JSON.stringify({ content: orchestrated.assistantMessage }),
          orchestrated.model,
          orchestrated.inputTokens,
          orchestrated.outputTokens,
          defaultTraceId
        ]
      );

      await client.query(
        `
        INSERT INTO usage_events (workspace_id, user_id, feature, quantity, unit, cost_usd_micros, trace_id)
        VALUES ($1, $2, 'chat', $3, 'tokens', 0, $4)
        `,
        [
          req.params.workspaceId,
          actor.userId,
          orchestrated.inputTokens + orchestrated.outputTokens,
          defaultTraceId
        ]
      );

      return {
        userMessage: {
          id: userMessage.rows[0].id,
          role: "user",
          content: parsed.data.content,
          model: null,
          traceId: defaultTraceId,
          createdAt: new Date(userMessage.rows[0].created_at).toISOString()
        },
        assistantMessage: {
          id: assistantMessage.rows[0].id,
          role: "assistant",
          content: orchestrated.assistantMessage,
          model: assistantMessage.rows[0].model_name,
          traceId: defaultTraceId,
          createdAt: new Date(assistantMessage.rows[0].created_at).toISOString()
        },
        usage: {
          inputTokens: assistantMessage.rows[0].token_input ?? 0,
          outputTokens: assistantMessage.rows[0].token_output ?? 0,
          model: assistantMessage.rows[0].model_name
        }
      };
    });

    const responsePayload = responseEnvelope(result);
    await saveIdempotentResponse(
      req.params.workspaceId,
      routeKey,
      idempotencyKey,
      200,
      responsePayload,
      res.locals.actor?.userId as string | undefined
    );

    res.json(responsePayload);
  })
);

v1Router.get(
  "/workspaces/:workspaceId/memory",
  requireWorkspaceRole(["owner", "admin", "member", "viewer", "billing_admin", "automation_operator"]),
  asyncRoute(async (req, res) => {
    const page = Math.max(1, Number(req.query.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize ?? 20)));
    const offset = (page - 1) * pageSize;
    const scopeFilter = typeof req.query.scope === "string" ? req.query.scope : undefined;
    const searchQuery = typeof req.query.q === "string" ? req.query.q.trim() : "";

    const where: string[] = ["workspace_id = $1", "deleted_at IS NULL"];
    const params: unknown[] = [req.params.workspaceId];

    if (scopeFilter) {
      params.push(scopeFilter);
      where.push(`owner_scope = $${params.length}`);
    }

    if (searchQuery) {
      params.push(`%${searchQuery}%`);
      where.push(`(title ILIKE $${params.length} OR body ILIKE $${params.length})`);
    }

    const whereClause = where.join(" AND ");
    const countSql = `SELECT COUNT(*)::text AS total FROM memory_records WHERE ${whereClause}`;
    const countResult = await query<{ total: string }>(countSql, params);

    const itemParams = [...params, pageSize, offset];
    const itemSql = `
      SELECT id, title, body, owner_scope, source_type, pinned, locked, created_at
      FROM memory_records
      WHERE ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${itemParams.length - 1}
      OFFSET $${itemParams.length}
    `;
    const items = await query<MemoryRow>(itemSql, itemParams);

    const total = Number(countResult.rows[0]?.total ?? "0");
    const hasNext = offset + items.rows.length < total;

    res.json({
      data: items.rows.map((item) => ({
        id: item.id,
        title: item.title,
        body: item.body,
        ownerScope: item.owner_scope,
        sourceType: item.source_type,
        pinned: item.pinned,
        locked: item.locked,
        createdAt: new Date(item.created_at).toISOString()
      })),
      meta: {
        page,
        pageSize,
        total,
        hasNext
      },
      traceId: defaultTraceId
    });
  })
);

v1Router.post(
  "/workspaces/:workspaceId/memory/:memoryId/pin",
  requireWorkspaceRole(["owner", "admin", "member", "automation_operator"]),
  asyncRoute(async (req, res) => {
    const updated = await query<MemoryRow>(
      `
      UPDATE memory_records
      SET pinned = TRUE, updated_at = NOW()
      WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL
      RETURNING id, title, body, owner_scope, source_type, pinned, locked, created_at
      `,
      [req.params.memoryId, req.params.workspaceId]
    );

    if (!updated.rowCount) {
      res.status(404).json({ code: "NOT_FOUND", message: "Memory record not found", traceId: defaultTraceId });
      return;
    }

    const item = updated.rows[0];
    res.json(
      responseEnvelope({
        id: item.id,
        title: item.title,
        body: item.body,
        ownerScope: item.owner_scope,
        sourceType: item.source_type,
        pinned: item.pinned,
        locked: item.locked,
        createdAt: new Date(item.created_at).toISOString()
      })
    );
  })
);

v1Router.post(
  "/workspaces/:workspaceId/memory/:memoryId/forget",
  requireWorkspaceRole(["owner", "admin", "member", "automation_operator"]),
  asyncRoute(async (req, res) => {
    const updated = await query<MemoryRow>(
      `
      UPDATE memory_records
      SET deleted_at = NOW(), updated_at = NOW(), pinned = FALSE
      WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL
      RETURNING id, title, body, owner_scope, source_type, pinned, locked, created_at
      `,
      [req.params.memoryId, req.params.workspaceId]
    );

    if (!updated.rowCount) {
      res.status(404).json({ code: "NOT_FOUND", message: "Memory record not found", traceId: defaultTraceId });
      return;
    }

    const item = updated.rows[0];
    res.json(
      responseEnvelope({
        id: item.id,
        title: item.title,
        body: item.body,
        ownerScope: item.owner_scope,
        sourceType: item.source_type,
        pinned: item.pinned,
        locked: item.locked,
        createdAt: new Date(item.created_at).toISOString()
      })
    );
  })
);

v1Router.post(
  "/workspaces/:workspaceId/workflows",
  requireWorkspaceRole(["owner", "admin", "member", "automation_operator"]),
  asyncRoute(async (req, res) => {
    const parsed = createWorkflowSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ code: "INVALID_REQUEST", message: "Invalid workflow payload", traceId: defaultTraceId });
      return;
    }

    const workflow = await withTransaction(async (client) => {
      const actor = await ensureActorUserWithClient(client, req);
      const inserted = await client.query<{
        id: string;
        workspace_id: string;
        name: string;
        version: number;
        status: "draft" | "active" | "paused" | "archived";
      }>(
        `
        INSERT INTO workflows (workspace_id, name, version, status, definition_json, created_by)
        VALUES ($1, $2, 1, 'draft', $3::jsonb, $4)
        RETURNING id, workspace_id, name, version, status
        `,
        [req.params.workspaceId, parsed.data.name, JSON.stringify(parsed.data.definition ?? {}), actor.userId]
      );

      return inserted.rows[0];
    });

    res.status(201).json(
      responseEnvelope({
        id: workflow.id,
        workspaceId: workflow.workspace_id,
        name: workflow.name,
        version: workflow.version,
        status: workflow.status
      })
    );
  })
);

v1Router.post(
  "/workspaces/:workspaceId/workflows/:workflowId/runs",
  requireWorkspaceRole(["owner", "admin", "member", "automation_operator"]),
  asyncRoute(async (req, res) => {
    const idempotencyKey = readIdempotencyKey(req.header("Idempotency-Key") ?? undefined);
    if (!idempotencyKey) {
      res.status(400).json({ code: "IDEMPOTENCY_KEY_REQUIRED", message: "Idempotency-Key header is required", traceId: defaultTraceId });
      return;
    }

    const routeKey = "POST:/workspaces/:workspaceId/workflows/:workflowId/runs";
    const existing = await findIdempotentResponse(req.params.workspaceId, routeKey, idempotencyKey);
    if (existing) {
      res.status(existing.statusCode).json(existing.responseJson);
      return;
    }

    const run = await query<{
      id: string;
      workflow_id: string;
      status: "queued" | "running" | "success" | "failed" | "cancelled";
      trace_id: string | null;
      started_at: string | null;
      ended_at: string | null;
    }>(
      `
      INSERT INTO workflow_runs (workspace_id, workflow_id, trigger_type, trigger_payload_json, status, trace_id)
      VALUES ($1, $2, 'manual', '{}'::jsonb, 'queued', $3)
      RETURNING id, workflow_id, status, trace_id, started_at, ended_at
      `,
      [req.params.workspaceId, req.params.workflowId, defaultTraceId]
    );

    const responsePayload = responseEnvelope({
      id: run.rows[0].id,
      workflowId: run.rows[0].workflow_id,
      status: run.rows[0].status,
      traceId: run.rows[0].trace_id ?? defaultTraceId,
      startedAt: run.rows[0].started_at,
      endedAt: run.rows[0].ended_at
    });

    await saveIdempotentResponse(
      req.params.workspaceId,
      routeKey,
      idempotencyKey,
      202,
      responsePayload,
      res.locals.actor?.userId as string | undefined
    );

    res.status(202).json(responsePayload);
  })
);

v1Router.get(
  "/workspaces/:workspaceId/usage",
  requireWorkspaceRole(["owner", "admin", "billing_admin"]),
  asyncRoute(async (req, res) => {
    const fromRaw = typeof req.query.from === "string" ? req.query.from : undefined;
    const toRaw = typeof req.query.to === "string" ? req.query.to : undefined;

    const rows = await query<{ feature: string; quantity: string; unit: string; cost_usd_micros: string }>(
      `
      SELECT feature, SUM(quantity)::text AS quantity, unit, SUM(cost_usd_micros)::text AS cost_usd_micros
      FROM usage_events
      WHERE workspace_id = $1
        AND ($2::timestamptz IS NULL OR created_at >= $2::timestamptz)
        AND ($3::timestamptz IS NULL OR created_at <= $3::timestamptz)
      GROUP BY feature, unit
      ORDER BY feature ASC
      `,
      [req.params.workspaceId, fromRaw ?? null, toRaw ?? null]
    );

    res.json(
      responseEnvelope({
        workspaceId: req.params.workspaceId,
        from: fromRaw ?? null,
        to: toRaw ?? null,
        totals: rows.rows.map((row) => ({
          feature: row.feature,
          quantity: Number(row.quantity),
          unit: row.unit,
          costUsdMicros: Number(row.cost_usd_micros)
        }))
      })
    );
  })
);
