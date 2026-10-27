import type { Express, Request, Response } from "express";
import { findAccount, listAccounts, revokeSessions, setAccountStatus, setStoredRole, type Account, type AccountListing } from "./services/accounts.js";
import {
  accessFacts, authorityMode, effectiveRole, entitlementView, principalFor, principalOf, requirePermission, resolvePrincipal,
  type Principal
} from "./services/access.js";
import { listAudit, recordAudit, verifyAuditChain, type AuditActor } from "./services/audit.js";
import { canManageRole, defaultPlans, featureCatalogue, featureIds } from "./services/entitlements.js";

// The routes that tell a person what they may do, and the ones an owner or
// administrator uses to look after accounts. Who may call each is decided by
// requirePermission, from the role the server holds - never from the request.

const traceId = "trace-local";

function singleParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function actorOf(res: Response): AuditActor {
  const principal = principalOf(res) as Principal;
  const account = principal.account as Account;
  return { kind: "account", id: account.id, email: account.email, role: principal.role };
}

/** An account as an administrator's screen shows it: no password, no hash, no token. */
function userView(listing: Account & Partial<Pick<AccountListing, "sessionCount">>) {
  return {
    id: listing.id,
    email: listing.email,
    displayName: listing.displayName,
    createdAt: listing.createdAt,
    status: listing.status,
    emailVerified: listing.emailVerifiedAt !== null,
    lastLoginAt: listing.lastLoginAt,
    sessionCount: listing.sessionCount ?? 0,
    role: effectiveRole(listing),
    plan: accessFacts(principalFor(listing)).plan
  };
}

function refuse(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ code, message, traceId });
}

export function registerAccessRoutes(app: Express): void {
  // What the caller may do, computed by the same rules the gates use. Open to
  // someone with no account too: the answer is then what a guest on this copy gets.
  app.get("/v1/entitlements", (req, res) => {
    res.json({ data: entitlementView(resolvePrincipal(req)), traceId });
  });

  // The plans and what each includes - for the plans screen and the upgrade explanation.
  app.get("/v1/plans", (req, res) => {
    const facts = accessFacts(resolvePrincipal(req));
    res.json({
      data: {
        current: facts.plan,
        plans: Object.values(defaultPlans).map((plan) => ({ id: plan.id, label: plan.label, features: plan.features })),
        features: featureIds.map((id) => ({ id, label: featureCatalogue[id].label, description: featureCatalogue[id].description }))
      },
      traceId
    });
  });

  app.get("/v1/admin/users", requirePermission("users.read"), (req: Request, res: Response) => {
    const { total, accounts } = listAccounts({ query: req.query.query, limit: req.query.limit, offset: req.query.offset });
    res.json({ data: { total, users: accounts.map(userView) }, traceId });
  });

  app.patch("/v1/admin/users/:id/status", requirePermission("users.suspend"), (req: Request, res: Response) => {
    const principal = principalOf(res) as Principal;
    const target = findAccount(singleParam(req.params.id));
    if (!target) {
      refuse(res, 404, "NOT_FOUND", "There is no such account.");
      return;
    }
    const status = req.body?.status;
    if (status !== "active" && status !== "suspended") {
      refuse(res, 400, "INVALID_REQUEST", "status must be \"active\" or \"suspended\".");
      return;
    }
    if (status === "suspended" && target.id === (principal.account as Account).id) {
      refuse(res, 400, "INVALID_REQUEST", "You cannot suspend your own account.");
      return;
    }
    if (!canManageRole(principal.role, effectiveRole(target))) {
      refuse(res, 403, "FORBIDDEN", "Your role cannot change that account.");
      return;
    }
    const result = setAccountStatus(target.id, status);
    if (!result.ok) {
      refuse(res, 404, "NOT_FOUND", result.error);
      return;
    }
    recordAudit({
      actor: actorOf(res),
      action: status === "suspended" ? "account.suspended" : "account.reactivated",
      target: { id: target.id, email: target.email }
    });
    res.json({ data: { user: userView(result.account) }, traceId });
  });

  app.delete("/v1/admin/users/:id/sessions", requirePermission("users.revoke_sessions"), (req: Request, res: Response) => {
    const principal = principalOf(res) as Principal;
    const target = findAccount(singleParam(req.params.id));
    if (!target) {
      refuse(res, 404, "NOT_FOUND", "There is no such account.");
      return;
    }
    // Signing yourself out everywhere is always allowed; anyone else's needs authority over them.
    const own = target.id === (principal.account as Account).id;
    if (!own && !canManageRole(principal.role, effectiveRole(target))) {
      refuse(res, 403, "FORBIDDEN", "Your role cannot change that account.");
      return;
    }
    const revoked = revokeSessions(target.id) ?? 0;
    recordAudit({
      actor: actorOf(res),
      action: "account.sessions_revoked",
      target: { id: target.id, email: target.email },
      detail: `${revoked} session${revoked === 1 ? "" : "s"} ended`
    });
    res.json({ data: { revoked }, traceId });
  });

  // Only the owner makes or removes administrators, and only where this copy's
  // own records are believed (authorityMode). Elsewhere an administrator is a
  // signed key - a stored "admin" would be one anybody could write.
  app.put("/v1/admin/users/:id/role", requirePermission("roles.grant_admin"), (req: Request, res: Response) => {
    if (!authorityMode()) {
      refuse(
        res, 409, "ROLE_COMES_FROM_KEY",
        "On this copy an administrator is made by a signed key, not by a setting. Ask the owner for an administrator key."
      );
      return;
    }
    const target = findAccount(singleParam(req.params.id));
    if (!target) {
      refuse(res, 404, "NOT_FOUND", "There is no such account.");
      return;
    }
    const role = req.body?.role;
    if (role !== "admin" && role !== "user") {
      refuse(res, 400, "INVALID_REQUEST", "role must be \"admin\" or \"user\". Ownership is handed over separately.");
      return;
    }
    const before = effectiveRole(target);
    if (before === "owner") {
      refuse(res, 403, "FORBIDDEN", "The owner's role does not change this way.");
      return;
    }
    const result = setStoredRole(target.id, role);
    if (!result.ok) {
      refuse(res, 400, "INVALID_REQUEST", result.error);
      return;
    }
    recordAudit({
      actor: actorOf(res),
      action: role === "admin" ? "role.admin_granted" : "role.admin_revoked",
      target: { id: target.id, email: target.email },
      detail: `role ${before} to ${role}`
    });
    res.json({ data: { user: userView(result.account) }, traceId });
  });

  app.get("/v1/admin/audit", requirePermission("audit.read"), (req: Request, res: Response) => {
    const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
    const before = typeof req.query.before === "string" ? Number(req.query.before) : undefined;
    const { entries, total } = listAudit({ limit, before });
    res.json({ data: { entries, total, chain: verifyAuditChain() }, traceId });
  });
}
