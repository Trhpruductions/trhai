// Who may do what, decided in one place.
//
// Two different questions share this file because they are easy to confuse and
// must never be answered by the same switch:
//
//   - a PERMISSION is about security: may this person manage other accounts,
//     read the audit log, make someone an administrator? It follows the role
//     and nothing else. Paying never grants one, and not paying never removes one.
//
//   - an ENTITLEMENT is about the product: may this person use the assistant,
//     build apps, speak replies? It follows the plan they are on, with two
//     exceptions that no plan, payment or expiry can take away: the owner and
//     the administrators use everything, always.
//
// The order a request is judged in is fixed (decide below): who is asking, what
// role the server knows them to have, then the owner's grant, then the
// administrator's, and only then the plan. Everything here is pure - facts go
// in, a decision comes out - so the rules can be tested without a server, a
// clock or a disk, and so the same rules can run wherever the accounts live.

export type Role = "owner" | "admin" | "user";
export const roles: readonly Role[] = ["owner", "admin", "user"];

export type AccountStatus = "active" | "suspended";

/** The plans a license key can name (licensing.ts), plus what is left after a trial or a license runs out. */
export type PlanId = "free" | "personal" | "pro" | "team";

/** "trial" is not a plan anyone buys: it is the first 14 days of using everything. */
export type EffectivePlan = PlanId | "trial";

export const featureIds = [
  "assistant", "apps", "commands", "schedules", "tasks", "flow", "vision", "music_video", "voice_speech", "voice_dictation"
] as const;
export type FeatureId = typeof featureIds[number];

export type FeatureInfo = {
  label: string;
  description: string;
  /** The route prefixes the server enforces this feature on (writes only; reads stay open). */
  routes: readonly string[];
};

/**
 * The features of TRH AI as it is today, each tied to the routes that do the
 * work. Reads are never gated - a locked app still shows what it holds - so a
 * feature is what is needed to make the app DO something.
 */
export const featureCatalogue: Readonly<Record<FeatureId, FeatureInfo>> = {
  assistant: {
    label: "Assistant",
    description: "Talk to the assistant, ask it to get things done, and let it remember.",
    routes: ["/v1/assist"]
  },
  apps: {
    label: "Build and run apps",
    description: "Have the assistant write small apps and run them on this PC.",
    routes: ["/v1/apps"]
  },
  commands: {
    label: "Commands on this PC",
    description: "Let the assistant run commands, once you have allowed it to.",
    routes: ["/v1/commands"]
  },
  schedules: {
    label: "Schedules",
    description: "Run things on a timetable.",
    routes: ["/v1/schedules"]
  },
  tasks: {
    label: "Tasks",
    description: "Keep a task list and let the assistant work through tasks in the background.",
    routes: ["/v1/tasks", "/v1/agent-tasks"]
  },
  flow: {
    label: "Automation flow",
    description: "Build and run an automation flow.",
    routes: ["/v1/flow"]
  },
  vision: {
    label: "Pictures",
    description: "Have the assistant look at pictures and screens.",
    routes: ["/v1/vision"]
  },
  music_video: {
    label: "Music videos",
    description: "Turn a song into a music video.",
    routes: ["/v1/music-video"]
  },
  voice_speech: {
    label: "Spoken replies",
    description: "Hear replies in a natural voice.",
    routes: ["/v1/speech"]
  },
  voice_dictation: {
    label: "Dictation",
    description: "Talk instead of typing.",
    routes: ["/v1/transcribe"]
  }
};

/** Which feature a request path needs, or null for a route no plan decides. */
export function featureForPath(pathname: string): FeatureId | null {
  for (const id of featureIds) {
    for (const prefix of featureCatalogue[id].routes) {
      if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return id;
    }
  }
  return null;
}

export type PlanDefinition = {
  id: EffectivePlan;
  label: string;
  features: readonly FeatureId[];
};

/**
 * What each plan includes. These defaults are TRH AI as it was before plans
 * could differ: a trial and every paid plan use everything, and once a trial or
 * license has run out the work is locked while the voice, which was never behind
 * the paywall, stays open. The owner can narrow any plan; nothing here is a
 * price - what a plan costs belongs to whoever sells it.
 */
const everything: readonly FeatureId[] = featureIds;
export const defaultPlans: Readonly<Record<EffectivePlan, PlanDefinition>> = {
  free: { id: "free", label: "Free", features: ["voice_speech", "voice_dictation"] },
  trial: { id: "trial", label: "Free trial", features: everything },
  personal: { id: "personal", label: "Personal", features: everything },
  pro: { id: "pro", label: "Pro", features: everything },
  team: { id: "team", label: "Team", features: everything }
};

export type PlanCatalogue = Readonly<Record<EffectivePlan, PlanDefinition>>;

// ------------------------------------------------------------------ permissions

export type Permission =
  | "users.read"
  | "users.suspend"
  | "users.revoke_sessions"
  | "audit.read"
  | "roles.grant_admin"
  | "roles.transfer_ownership"
  | "settings.manage";

const permissionRoles: Readonly<Record<Permission, readonly Role[]>> = {
  "users.read": ["owner", "admin"],
  "users.suspend": ["owner", "admin"],
  "users.revoke_sessions": ["owner", "admin"],
  "audit.read": ["owner", "admin"],
  // The things only the owner does. An administrator can run support and look
  // after accounts; making administrators, handing over ownership and changing
  // how the whole thing is set up stay with the owner.
  "roles.grant_admin": ["owner"],
  "roles.transfer_ownership": ["owner"],
  "settings.manage": ["owner"]
};

export const permissionList = Object.keys(permissionRoles) as readonly Permission[];

export function hasPermission(role: Role, permission: Permission): boolean {
  return permissionRoles[permission].includes(role);
}

/**
 * Whether `actor` may act on an account that has `target`'s role. The owner
 * looks after administrators and users, an administrator after users only, and
 * nobody acts on the owner through these routes: ownership moves by its own
 * process, never as a side effect of managing an account.
 */
export function canManageRole(actor: Role, target: Role): boolean {
  if (actor === "owner") return target !== "owner";
  if (actor === "admin") return target === "user";
  return false;
}

// ------------------------------------------------------------------ the decision

export type Subject = {
  /** False for someone using the app without an account. */
  signedIn: boolean;
  /** Read from the server's own records - never from anything the caller sent. */
  role: Role;
  status: AccountStatus;
};

export type LockReason = "trial_ended" | "license_expired" | "subscription_ended" | "payment_failed";

export type AccessFacts = {
  /** The plan the person is on right now. "free" once a trial, license or subscription has run out. */
  plan: EffectivePlan;
  /** Why they are on "free" when they were not meant to be; null when nothing has lapsed. */
  lockReason: LockReason | null;
  /** The paywall is switched off for this copy (the owner's own PCs, and tests). */
  paywallOff: boolean;
  /** True where every caller must be signed in (a shared service), false on someone's own PC. */
  accountRequired: boolean;
};

export type Decision =
  | { allowed: true; via: "owner" | "admin" | "paywall_off" | "plan"; plan: EffectivePlan }
  | { allowed: false; reason: "not_signed_in" | "suspended" | LockReason | "not_in_plan"; plan: EffectivePlan };

/**
 * May this subject use this feature?
 *
 * The order is the policy. The owner is judged before the administrators and
 * the administrators before any plan, so no plan, no lapsed payment and no
 * missing record can ever stand between them and the product; they are allowed
 * without the plan being read at all.
 */
export function decide(
  subject: Subject,
  facts: AccessFacts,
  feature: FeatureId,
  catalogue: PlanCatalogue = defaultPlans
): Decision {
  const plan = facts.plan;

  if (facts.accountRequired && !subject.signedIn) return { allowed: false, reason: "not_signed_in", plan };

  // The owner cannot be suspended through the service, so a suspended owner can
  // only be a record that was edited by hand - and a hand-edit must not be able
  // to lock the owner out of their own product any more than into someone else's.
  if (subject.role === "owner") return { allowed: true, via: "owner", plan };

  if (subject.status === "suspended") return { allowed: false, reason: "suspended", plan };

  if (subject.role === "admin") return { allowed: true, via: "admin", plan };

  if (facts.paywallOff) return { allowed: true, via: "paywall_off", plan };

  if (catalogue[plan].features.includes(feature)) return { allowed: true, via: "plan", plan };

  // Not in the plan. A lapse is a payment problem; a plan that simply leaves the
  // feature out is an upgrade problem, and the words to the person differ.
  return { allowed: false, reason: facts.lockReason ?? "not_in_plan", plan };
}

/** Every feature, decided at once - what the screens use to show or dim things. */
export function decideAll(subject: Subject, facts: AccessFacts, catalogue: PlanCatalogue = defaultPlans): Record<FeatureId, Decision> {
  const all = {} as Record<FeatureId, Decision>;
  for (const id of featureIds) all[id] = decide(subject, facts, id, catalogue);
  return all;
}
