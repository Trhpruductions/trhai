import test from "node:test";
import assert from "node:assert/strict";
import {
  canManageRole, decide, decideAll, defaultPlans, featureCatalogue, featureForPath, featureIds, hasPermission, permissionList, roles,
  type AccessFacts, type EffectivePlan, type LockReason, type PlanCatalogue, type Role, type Subject
} from "../src/services/entitlements.js";

// The policy on its own - facts in, decision out - so each rule is pinned
// without a server, a clock or a disk. access.test.ts then proves the same
// rules hold through real requests.

const signedIn = (role: Role, status: Subject["status"] = "active"): Subject => ({ signedIn: true, role, status });
const guest: Subject = { signedIn: false, role: "user", status: "active" };

function facts(plan: EffectivePlan, lockReason: LockReason | null = null, extra: Partial<AccessFacts> = {}): AccessFacts {
  return { plan, lockReason, paywallOff: false, accountRequired: false, ...extra };
}

// Every way a person can be without a paid plan, as the facts a request would produce.
const everyLapse: Array<[string, AccessFacts]> = [
  ["trial ended", facts("free", "trial_ended")],
  ["license expired", facts("free", "license_expired")],
  ["subscription ended", facts("free", "subscription_ended")],
  ["payment failed", facts("free", "payment_failed")],
  ["no plan information at all", facts("free")]
];

test("the owner uses every feature in every state a plan can be in", () => {
  for (const [what, state] of everyLapse) {
    for (const feature of featureIds) {
      const decision = decide(signedIn("owner"), state, feature);
      assert.equal(decision.allowed, true, `${feature} when ${what}`);
      assert.equal((decision as { via: string }).via, "owner");
    }
  }
});

test("an administrator uses every feature in every state a plan can be in", () => {
  for (const [what, state] of everyLapse) {
    for (const feature of featureIds) {
      const decision = decide(signedIn("admin"), state, feature);
      assert.equal(decision.allowed, true, `${feature} when ${what}`);
      assert.equal((decision as { via: string }).via, "admin");
    }
  }
});

test("the owner and the administrators are allowed without the plan being read", () => {
  // A catalogue with no entry for the plan at all: a lookup into it would throw.
  const empty = {} as unknown as PlanCatalogue;
  assert.equal(decide(signedIn("owner"), facts("pro"), "assistant", empty).allowed, true);
  assert.equal(decide(signedIn("admin"), facts("pro"), "assistant", empty).allowed, true);
  assert.throws(() => decide(signedIn("user"), facts("pro"), "assistant", empty));
});

test("a suspended administrator is refused, and a suspended owner record cannot lock the owner out", () => {
  assert.deepEqual(decide(signedIn("admin", "suspended"), facts("pro"), "assistant"), { allowed: false, reason: "suspended", plan: "pro" });
  assert.deepEqual(decide(signedIn("user", "suspended"), facts("pro"), "assistant"), { allowed: false, reason: "suspended", plan: "pro" });
  assert.equal(decide(signedIn("owner", "suspended"), facts("free", "payment_failed"), "assistant").allowed, true);
});

test("an ordinary user gets exactly what their plan includes", () => {
  for (const plan of ["trial", "personal", "pro", "team"] as const) {
    for (const feature of featureIds) {
      const decision = decide(signedIn("user"), facts(plan), feature);
      assert.equal(decision.allowed, true, `${plan} ${feature}`);
      assert.equal((decision as { via: string }).via, "plan");
    }
  }
});

test("a lapsed user is locked out of the work, and told which kind of lapse it was", () => {
  for (const [what, state] of everyLapse.slice(0, 4)) {
    const decision = decide(signedIn("user"), state, "assistant");
    assert.equal(decision.allowed, false, what);
    assert.equal((decision as { reason: string }).reason, state.lockReason);
  }
  // With nothing recorded about why, a plan that leaves a feature out is an upgrade question.
  assert.equal((decide(signedIn("user"), facts("free"), "assistant") as { reason: string }).reason, "not_in_plan");
});

test("the voice was never behind the paywall, and stays open on the free plan", () => {
  assert.equal(decide(signedIn("user"), facts("free", "trial_ended"), "voice_speech").allowed, true);
  assert.equal(decide(signedIn("user"), facts("free", "trial_ended"), "voice_dictation").allowed, true);
  assert.equal(decide(guest, facts("free", "trial_ended"), "voice_speech").allowed, true);
});

test("the default plans keep TRH AI exactly as it was: a trial and every paid plan use everything", () => {
  for (const plan of ["trial", "personal", "pro", "team"] as const) {
    assert.deepEqual([...defaultPlans[plan].features].sort(), [...featureIds].sort(), plan);
  }
  assert.deepEqual([...defaultPlans.free.features].sort(), ["voice_dictation", "voice_speech"]);
});

test("a plan the owner narrows leaves the feature out, and the refusal says so rather than blaming a payment", () => {
  const narrowed: PlanCatalogue = { ...defaultPlans, personal: { ...defaultPlans.personal, features: ["assistant"] } };
  assert.equal(decide(signedIn("user"), facts("personal"), "assistant", narrowed).allowed, true);
  const denied = decide(signedIn("user"), facts("personal"), "music_video", narrowed);
  assert.deepEqual(denied, { allowed: false, reason: "not_in_plan", plan: "personal" });
  // The owner is untouched by it.
  assert.equal(decide(signedIn("owner"), facts("personal"), "music_video", narrowed).allowed, true);
});

test("the paywall switched off lets an ordinary user through, as it always did", () => {
  const decision = decide(signedIn("user"), facts("free", "trial_ended", { paywallOff: true }), "assistant");
  assert.deepEqual(decision, { allowed: true, via: "paywall_off", plan: "free" });
});

test("where an account is required, nobody gets in without one - not even someone claiming to be the owner", () => {
  const required = (plan: EffectivePlan = "pro") => facts(plan, null, { accountRequired: true });
  for (const role of roles) {
    const decision = decide({ signedIn: false, role, status: "active" }, required(), "assistant");
    assert.deepEqual(decision, { allowed: false, reason: "not_signed_in", plan: "pro" }, role);
  }
  assert.equal(decide(signedIn("user"), required(), "assistant").allowed, true);
  // And a guest on someone's own PC, where no account is required, is judged by the plan.
  assert.equal(decide(guest, facts("pro"), "assistant").allowed, true);
  assert.equal(decide(guest, facts("free", "trial_ended"), "assistant").allowed, false);
});

test("decideAll agrees with decide for every feature", () => {
  const state = facts("free", "payment_failed");
  const all = decideAll(signedIn("user"), state);
  for (const feature of featureIds) assert.deepEqual(all[feature], decide(signedIn("user"), state, feature), feature);
});

test("permissions follow the role alone, and only the owner holds the owner-only ones", () => {
  for (const permission of permissionList) {
    assert.equal(hasPermission("user", permission), false, `user ${permission}`);
  }
  for (const permission of ["users.read", "users.suspend", "users.revoke_sessions", "audit.read"] as const) {
    assert.equal(hasPermission("admin", permission), true, `admin ${permission}`);
    assert.equal(hasPermission("owner", permission), true, `owner ${permission}`);
  }
  for (const permission of ["roles.grant_admin", "roles.transfer_ownership", "settings.manage"] as const) {
    assert.equal(hasPermission("admin", permission), false, `admin ${permission}`);
    assert.equal(hasPermission("owner", permission), true, `owner ${permission}`);
  }
});

test("who may act on whom: the owner on everyone but the owner, an administrator on users only, a user on nobody", () => {
  assert.equal(canManageRole("owner", "admin"), true);
  assert.equal(canManageRole("owner", "user"), true);
  assert.equal(canManageRole("owner", "owner"), false);
  assert.equal(canManageRole("admin", "user"), true);
  assert.equal(canManageRole("admin", "admin"), false);
  assert.equal(canManageRole("admin", "owner"), false);
  for (const target of roles) assert.equal(canManageRole("user", target), false, `user on ${target}`);
});

test("every route a feature names maps back to it, and nothing else maps there", () => {
  for (const feature of featureIds) {
    for (const prefix of featureCatalogue[feature].routes) {
      assert.equal(featureForPath(prefix), feature, prefix);
      assert.equal(featureForPath(`${prefix}/anything/below`), feature, `${prefix}/anything/below`);
    }
  }
  assert.equal(featureForPath("/v1/assistant"), null, "a longer word is not the same route");
  assert.equal(featureForPath("/v1/license"), null);
  assert.equal(featureForPath("/v1/auth/login"), null, "signing in must never be behind a plan");
  assert.equal(featureForPath("/v1/admin/users"), null, "the administrator routes are decided by permission, not plan");
  assert.equal(featureForPath("/health"), null);
});

test("no route is claimed by two features", () => {
  const seen = new Map<string, string>();
  for (const feature of featureIds) {
    for (const prefix of featureCatalogue[feature].routes) {
      assert.equal(seen.get(prefix), undefined, `${prefix} is in both ${seen.get(prefix)} and ${feature}`);
      seen.set(prefix, feature);
    }
  }
});
