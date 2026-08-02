import { NextFunction, Request, RequestHandler, Response } from "express";
import { query } from "../db.js";
import { ensureActorUserFromRequest } from "../services/actor.js";

type WorkspaceRole = "owner" | "admin" | "member" | "viewer" | "billing_admin" | "automation_operator";

export function requireWorkspaceRole(allowedRoles: WorkspaceRole[]): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.params.workspaceId;
      if (!workspaceId) {
        res.status(400).json({ code: "INVALID_REQUEST", message: "workspaceId is required", traceId: "trace-local" });
        return;
      }

      const actor = await ensureActorUserFromRequest(req);
      const membership = await query<{ role: WorkspaceRole }>(
        "SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
        [workspaceId, actor.userId]
      );

      if (!membership.rowCount || !membership.rows[0]) {
        res.status(403).json({ code: "FORBIDDEN", message: "No workspace membership", traceId: "trace-local" });
        return;
      }

      const role = membership.rows[0].role;
      if (!allowedRoles.includes(role)) {
        res.status(403).json({ code: "FORBIDDEN", message: "Insufficient role", traceId: "trace-local" });
        return;
      }

      res.locals.actor = { userId: actor.userId, role, email: actor.email, displayName: actor.displayName };
      next();
    } catch (error) {
      next(error);
    }
  };
}
