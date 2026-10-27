import type { NextFunction, Request, Response } from "express";
import { accountForToken, bearerToken, storedRoleOf, type Account } from "./accounts.js";
import {
  decide, decideAll, defaultPlans, featureCatalogue, featureIds, hasPermission, permissionList,
  type AccessFacts, type AccountStatus, type Decision, type EffectivePlan, type FeatureId, type LockReason,
  type Permission, type Role
} from "./entitlements.js";
import { licenseStatus, trialDays } from "./licensing.js";

// Applies the rules in entitlements.ts to a request: works out who is asking,
// what role the SERVER knows them to have, what plan they are on, and either
// lets the request through or answers with the reason it did not.
//
// Nothing the caller sends decides any of it. The role is read from this
// service's own records (and, on someone's own PC, from a license key whose
// signature is checked on every request); the plan from the license or the
// subscription on record. A header, a field in the body, a value in the page's
// storage - none of them is consulted.

/**
 * Whether this copy is the system of record for its accounts: the one whose
 * stored roles, grants and subscriptions are believed. Off on an ordinary
 * install, where whoever sits at the PC can edit every file on it, so a role
 * written into a file proves nothing and only a signed key counts. On for a copy
 * that other people sign in to and that its owner looks after.
 */
export function authorityMode(): boolean {
  return process.env.TRHAI_AUTHORITY === "on";
}

export type Principal = {
  /** The account behind the request's token, or null: no token, an unknown one, an expired or ended one. */
  account: Account | null;
  signedIn: boolean;
  role: Role;
  status: AccountStatus;
};

const rank: Record<Role, number> = { owner: 3, admin: 2, user: 1 };

function higher(a: Role, b: Role): Role {
  return rank[a] >= rank[b] ? a : b;
}

/**
 * The role an account holds on this copy.
 *
 * On an ordinary install that is whatever the activated license key says about
 * the account's email - owner, administrator, or neither. The key is signed, so
 * the role cannot be added to it, and it is checked again on every request,
 * not remembered. On a copy that is the system of record, the role this service
 * recorded for the account counts as well, and the higher of the two wins.
 */
export function effectiveRole(account: Account | null): Role {
  if (!account) return "user";
  let role: Role = "user";
  const license = licenseStatus();
  const key = license.license;
  if (key?.role && license.state === "licensed" && key.email.trim().toLowerCase() === account.email) role = key.role;
  if (authorityMode()) role = higher(role, storedRoleOf(account.id));
  return role;
}

export function principalFor(account: Account | null): Principal {
  return {
    account,
    signedIn: account !== null,
    role: effectiveRole(account),
    status: account?.status ?? "active"
  };
}

export function resolvePrincipal(req: { headers: Request["headers"] }): Principal {
  return principalFor(accountForToken(bearerToken(req.headers.authorization)));
}

/** The principal an earlier middleware on this request settled on, if one did. */
export function principalOf(res: Response): Principal | null {
  return (res.locals.principal as Principal | undefined) ?? null;
}

// ------------------------------------------------------------------- the facts

/**
 * What the person is on right now.
 *
 * On an ordinary install the plan belongs to the PC: its trial, or the license
 * key on it, shared by whoever uses it - as it always has been. On a copy that
 * is the system of record, the plan belongs to the account, and a new account
 * gets the same free trial a new PC does, counted from the day it was made.
 */
export function accessFacts(principal: Principal, at: Date = new Date()): AccessFacts {
  const status = licenseStatus(at);
  const paywallOff = status.paywallDisabled;

  if (authorityMode()) {
    const started = principal.account ? Date.parse(principal.account.createdAt) : NaN;
    const inTrial = Number.isFinite(started) && at.getTime() < started + trialDays * 24 * 60 * 60 * 1000;
    return {
      plan: inTrial ? "trial" : "free",
      lockReason: inTrial ? null : "trial_ended",
      paywallOff,
      accountRequired: true
    };
  }

  switch (status.state) {
    case "licensed":
      return { plan: status.plan as EffectivePlan, lockReason: null, paywallOff, accountRequired: false };
    case "trial":
      return { plan: "trial", lockReason: null, paywallOff, accountRequired: false };
    case "license_expired":
      return { plan: "free", lockReason: "license_expired", paywallOff, accountRequired: false };
    default:
      return { plan: "free", lockReason: "trial_ended", paywallOff, accountRequired: false };
  }
}

export function mayUse(principal: Principal, feature: FeatureId, at: Date = new Date()): Decision {
  return decide(principal, accessFacts(principal, at), feature);
}

// ----------------------------------------------------------------- the answers

const lockMessages: Record<LockReason, string> = {
  trial_ended: `Your ${trialDays}-day trial of TRH AI has ended. Enter a license key in Settings to keep going.`,
  license_expired: "Your TRH AI license has expired. Renew it, or enter a new key, in Settings.",
  subscription_ended: "Your TRH AI subscription has ended. Subscribe again to keep going.",
  payment_failed: "Your last TRH AI payment did not go through. Update your payment method to keep going."
};

type Refusal = { status: number; body: Record<string, unknown> };

/** The HTTP answer for a refused decision. 402 keeps the shape the screens already listen for. */
export function refusalFor(decision: Extract<Decision, { allowed: false }>, feature: FeatureId): Refusal {
  switch (decision.reason) {
    case "not_signed_in":
      return { status: 401, body: { code: "UNAUTHORIZED", message: "Sign in to use this.", traceId: "trace-local" } };
    case "suspended":
      return {
        status: 403,
        body: { code: "ACCOUNT_SUSPENDED", message: "This account is suspended. Ask whoever runs this copy of TRH AI.", traceId: "trace-local" }
      };
    case "not_in_plan":
      return {
        status: 403,
        body: {
          code: "PLAN_DOES_NOT_INCLUDE",
          message: `Your ${defaultPlans[decision.plan].label} plan does not include ${featureCatalogue[feature].label.toLowerCase()}. Upgrade to use it.`,
          feature,
          plan: decision.plan,
          traceId: "trace-local"
        }
      };
    default:
      return {
        status: 402,
        body: {
          code: "PAYMENT_REQUIRED",
          message: lockMessages[decision.reason],
          license: licenseStatus(),
          feature,
          traceId: "trace-local"
        }
      };
  }
}

// ----------------------------------------------------------------- middleware

/**
 * The gate in front of the routes that do the work. Reads stay open, so a locked
 * app still shows what it holds; what is refused is making it do more.
 */
export function featureGate(feature: FeatureId) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
      next();
      return;
    }
    const principal = resolvePrincipal(req);
    const decision = mayUse(principal, feature);
    if (decision.allowed) {
      res.locals.principal = principal;
      next();
      return;
    }
    const refusal = refusalFor(decision, feature);
    res.status(refusal.status).json(refusal.body);
  };
}

/** The gate in front of the administrator routes: signed in, not suspended, and holding the permission. */
export function requirePermission(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const principal = resolvePrincipal(req);
    if (!principal.signedIn) {
      res.status(401).json({ code: "UNAUTHORIZED", message: "Sign in to use this.", traceId: "trace-local" });
      return;
    }
    if (principal.status === "suspended" && principal.role !== "owner") {
      res.status(403).json({ code: "ACCOUNT_SUSPENDED", message: "This account is suspended. Ask whoever runs this copy of TRH AI.", traceId: "trace-local" });
      return;
    }
    if (!hasPermission(principal.role, permission)) {
      res.status(403).json({ code: "FORBIDDEN", message: "Your account is not allowed to do that.", traceId: "trace-local" });
      return;
    }
    res.locals.principal = principal;
    next();
  };
}

// ------------------------------------------------------------------- the view

export type FeatureView = {
  id: FeatureId;
  label: string;
  description: string;
  allowed: boolean;
  /** Why it is allowed, or why not. */
  via?: Extract<Decision, { allowed: true }>["via"];
  reason?: Extract<Decision, { allowed: false }>["reason"];
};

/** What the screens are told about the caller. Computed here, from the same rules the gate uses, so they cannot disagree. */
export function entitlementView(principal: Principal, at: Date = new Date()) {
  const facts = accessFacts(principal, at);
  const decisions = decideAll(principal, facts);
  const features: FeatureView[] = featureIds.map((id) => {
    const decision = decisions[id];
    return {
      id,
      label: featureCatalogue[id].label,
      description: featureCatalogue[id].description,
      allowed: decision.allowed,
      ...(decision.allowed ? { via: decision.via } : { reason: decision.reason })
    };
  });
  return {
    signedIn: principal.signedIn,
    role: principal.role,
    status: principal.status,
    plan: facts.plan,
    planLabel: defaultPlans[facts.plan].label,
    lockReason: facts.lockReason,
    accountRequired: facts.accountRequired,
    authority: authorityMode(),
    exempt: principal.role === "owner" || principal.role === "admin",
    features,
    permissions: permissionList.filter((permission) => hasPermission(principal.role, permission))
  };
}
