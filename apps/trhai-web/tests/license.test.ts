import test from "node:test";
import assert from "node:assert/strict";
import { describeLicense, planLabel, type LicenseStatus } from "../src/lib/license.js";

// What the paywall and the Plan and billing section say about where things stand.

const day = 24 * 60 * 60 * 1000;
function status(overrides: Partial<LicenseStatus> = {}): LicenseStatus {
  return {
    state: "trial", locked: false, plan: "trial", trialStartedAt: new Date(Date.now() - 4 * day).toISOString(),
    trialEndsAt: new Date(Date.now() + 10 * day).toISOString(), trialDaysLeft: 10, license: null,
    checkoutUrl: null, priceText: null, paywallDisabled: false, ...overrides
  };
}

test("plans have the names people see", () => {
  assert.equal(planLabel("trial"), "Free trial");
  assert.equal(planLabel("personal"), "Personal");
  assert.equal(planLabel("pro"), "Pro");
  assert.equal(planLabel("team"), "Team");
});

test("each state is described in a sentence", () => {
  assert.match(describeLicense(status()), /10 days left/);
  assert.match(describeLicense(status({ trialDaysLeft: 1 })), /last day/);
  assert.match(describeLicense(status({ state: "trial_expired", locked: true, trialDaysLeft: 0 })), /trial ended/);
  const license = { id: "abc", plan: "pro" as const, email: "a@example.com", issuedAt: new Date().toISOString() };
  assert.match(describeLicense(status({ state: "licensed", plan: "pro", license })), /Pro plan, licensed to a@example.com\. It does not expire/);
  assert.match(describeLicense(status({ state: "licensed", plan: "pro", license: { ...license, expiresAt: new Date(Date.now() + 30 * day).toISOString() } })), /until/);
  assert.match(describeLicense(status({ state: "license_expired", locked: true, plan: "pro", license: { ...license, expiresAt: new Date(Date.now() - day).toISOString() } })), /expired/);
  assert.match(describeLicense(status({ paywallDisabled: true })), /not limited/);
});
