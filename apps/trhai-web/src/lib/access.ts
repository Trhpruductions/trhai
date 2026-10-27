// What the person signed in may do, as the screens say it.
//
// The API decides every bit of it - the role from its own records, the plan from
// the license or the subscription on record - and its routes enforce it. Nothing
// here grants or withholds anything, so nothing here can be edited to change what
// is allowed: a screen that hid a button the API would have allowed, or showed
// one it would refuse, is a wrong screen, not a wrong permission.

import { apiDelete, apiGet, apiPatch, apiPut } from "./api";

export type Role = "owner" | "admin" | "user";

export type FeatureView = {
  id: string;
  label: string;
  description: string;
  allowed: boolean;
  via?: "owner" | "admin" | "paywall_off" | "plan";
  reason?: string;
};

export type EntitlementView = {
  signedIn: boolean;
  role: Role;
  status: "active" | "suspended";
  plan: string;
  planLabel: string;
  lockReason: string | null;
  accountRequired: boolean;
  /** True on a copy that is the system of record for its accounts. */
  authority: boolean;
  /** Owners and administrators: no plan, payment or expiry locks them out. */
  exempt: boolean;
  features: FeatureView[];
  permissions: string[];
};

export const readEntitlements = () => apiGet<EntitlementView>("/v1/entitlements");

export function roleLabel(role: Role): string {
  return role === "owner" ? "Owner" : role === "admin" ? "Administrator" : "Member";
}

const lapseWords: Record<string, string> = {
  trial_ended: "Your free trial has ended.",
  license_expired: "Your license has expired.",
  subscription_ended: "Your subscription has ended.",
  payment_failed: "Your last payment did not go through."
};

/** One line saying where things stand, for the top of the panel. */
export function describeAccess(view: Pick<EntitlementView, "role" | "status" | "lockReason" | "planLabel">): string {
  if (view.status === "suspended") return "This account is suspended. Ask whoever runs this copy of TRH AI.";
  if (view.role === "owner") {
    return "You are the owner. Everything in TRH AI is open to you, whatever the plan, the payments or the trial - that is never taken away.";
  }
  if (view.role === "admin") {
    return "You are an administrator. Everything in TRH AI is open to you, whatever the plan or the payments, and you can look after accounts.";
  }
  if (view.lockReason) return `${lapseWords[view.lockReason] ?? "Your plan has run out."} What is already here is still yours to read.`;
  return `You are on the ${view.planLabel} plan.`;
}

/** Why one feature is open or shut, in a few words. */
export function featureStatus(feature: Pick<FeatureView, "allowed" | "via" | "reason">): string {
  if (feature.allowed) {
    switch (feature.via) {
      case "owner": return "Open to you as the owner";
      case "admin": return "Open to you as an administrator";
      case "paywall_off": return "Open: the paywall is off on this copy";
      default: return "In your plan";
    }
  }
  switch (feature.reason) {
    case "not_signed_in": return "Sign in to use this";
    case "suspended": return "This account is suspended";
    case "not_in_plan": return "Not in your plan";
    default: return lapseWords[feature.reason ?? ""] ?? "Not available right now";
  }
}

/**
 * Whether to offer a button that changes an account with this role. This
 * mirrors the service's own rule only to decide what to SHOW; the service
 * decides again on every request, and its answer is the one that counts.
 */
export function mayManage(actor: Role, target: Role): boolean {
  if (actor === "owner") return target !== "owner";
  return actor === "admin" && target === "user";
}

// ------------------------------------------------------------ looking after accounts

export type AdminUser = {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
  status: "active" | "suspended";
  emailVerified: boolean;
  lastLoginAt: string | null;
  sessionCount: number;
  role: Role;
  plan: string;
};

export function listUsers(query: string) {
  const search = query.trim() ? `&query=${encodeURIComponent(query.trim())}` : "";
  return apiGet<{ total: number; users: AdminUser[] }>(`/v1/admin/users?limit=100${search}`);
}

export const setUserStatus = (id: string, status: "active" | "suspended") =>
  apiPatch<{ user: AdminUser }>(`/v1/admin/users/${encodeURIComponent(id)}/status`, { status });

export const endUserSessions = (id: string) => apiDelete(`/v1/admin/users/${encodeURIComponent(id)}/sessions`);

export const setUserRole = (id: string, role: "admin" | "user") =>
  apiPut<{ user: AdminUser }>(`/v1/admin/users/${encodeURIComponent(id)}/role`, { role });

export type AuditEntryView = {
  seq: number;
  at: string;
  actor: { kind: "account"; id: string; email: string; role: string } | { kind: "system"; name: string };
  action: string;
  target: { id: string; email: string } | null;
  detail: string;
};

export type AuditView = {
  entries: AuditEntryView[];
  total: number;
  chain: { ok: true; count: number } | { ok: false; brokenAtSeq: number };
};

export const readAudit = () => apiGet<AuditView>("/v1/admin/audit?limit=50");

const actionWords: Record<string, string> = {
  "account.suspended": "suspended",
  "account.reactivated": "reactivated",
  "account.sessions_revoked": "signed out everywhere",
  "account.password_reset_issued": "given a password reset",
  "role.admin_granted": "made an administrator",
  "role.admin_revoked": "no longer an administrator",
  "role.owner_assigned": "made the owner",
  "role.owner_transferred": "ownership handed over",
  "invitation.created": "invited",
  "invitation.revoked": "invitation withdrawn",
  "invitation.redeemed": "accepted an invitation",
  "access.granted": "given access",
  "access.revoked": "access removed"
};

/** One line of the audit log: who, what, to whom. */
export function auditLine(entry: AuditEntryView): string {
  const who = entry.actor.kind === "account" ? entry.actor.email : entry.actor.name;
  const what = actionWords[entry.action] ?? entry.action;
  const detail = entry.detail ? ` (${entry.detail})` : "";
  return entry.target ? `${who}: ${entry.target.email} ${what}${detail}` : `${who}: ${what}${detail}`;
}

/** The settings section only the people who may look after accounts are shown. */
export function mayManagePeople(view: Pick<EntitlementView, "permissions"> | null): boolean {
  return view?.permissions.includes("users.read") ?? false;
}
