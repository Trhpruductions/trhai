import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditLine, describeAccess, featureStatus, listUsers, mayManage, mayManagePeople, roleLabel, type AuditEntryView
} from "../src/lib/access";
import { filterSections, isSectionId, sections } from "../src/lib/settings";

// What the screens say about who may do what. The API decides it all; these pin
// that the words are right and that the screens ask the API rather than guess.

const base = { status: "active" as const, lockReason: null, planLabel: "Pro" };

test("the owner is told everything is open to them whatever the plan, payments or trial", () => {
  const line = describeAccess({ ...base, role: "owner", lockReason: "payment_failed" });
  assert.match(line, /owner/i);
  assert.match(line, /never taken away/);
  assert.doesNotMatch(line, /payment did not go through/, "a lapse is not what an owner is told");
});

test("an administrator is told the same, and that they can look after accounts", () => {
  const line = describeAccess({ ...base, role: "admin", lockReason: "trial_ended" });
  assert.match(line, /administrator/i);
  assert.match(line, /look after accounts/);
  assert.doesNotMatch(line, /trial has ended/);
});

test("a member is told which kind of lapse it is, or what plan they are on", () => {
  assert.match(describeAccess({ ...base, role: "user", lockReason: "trial_ended" }), /free trial has ended/);
  assert.match(describeAccess({ ...base, role: "user", lockReason: "license_expired" }), /license has expired/);
  assert.match(describeAccess({ ...base, role: "user", lockReason: "subscription_ended" }), /subscription has ended/);
  assert.match(describeAccess({ ...base, role: "user", lockReason: "payment_failed" }), /payment did not go through/);
  assert.match(describeAccess({ ...base, role: "user", lockReason: "trial_ended" }), /still yours to read/);
  assert.equal(describeAccess({ ...base, role: "user" }), "You are on the Pro plan.");
});

test("a suspended account is told so before anything else, whatever its role", () => {
  for (const role of ["owner", "admin", "user"] as const) {
    assert.match(describeAccess({ ...base, role, status: "suspended" }), /suspended/, role);
  }
});

test("each feature says why it is open or shut", () => {
  assert.equal(featureStatus({ allowed: true, via: "owner" }), "Open to you as the owner");
  assert.equal(featureStatus({ allowed: true, via: "admin" }), "Open to you as an administrator");
  assert.equal(featureStatus({ allowed: true, via: "plan" }), "In your plan");
  assert.match(featureStatus({ allowed: true, via: "paywall_off" }), /paywall is off/);
  assert.equal(featureStatus({ allowed: false, reason: "not_in_plan" }), "Not in your plan");
  assert.equal(featureStatus({ allowed: false, reason: "suspended" }), "This account is suspended");
  assert.equal(featureStatus({ allowed: false, reason: "not_signed_in" }), "Sign in to use this");
  assert.equal(featureStatus({ allowed: false, reason: "trial_ended" }), "Your free trial has ended.");
  assert.equal(featureStatus({ allowed: false, reason: "something new" }), "Not available right now");
});

test("roles have plain names", () => {
  assert.equal(roleLabel("owner"), "Owner");
  assert.equal(roleLabel("admin"), "Administrator");
  assert.equal(roleLabel("user"), "Member");
});

test("buttons are offered on the same terms the service enforces: the owner on all but the owner, an administrator on members only", () => {
  assert.equal(mayManage("owner", "admin"), true);
  assert.equal(mayManage("owner", "user"), true);
  assert.equal(mayManage("owner", "owner"), false);
  assert.equal(mayManage("admin", "user"), true);
  assert.equal(mayManage("admin", "admin"), false);
  assert.equal(mayManage("admin", "owner"), false);
  for (const target of ["owner", "admin", "user"] as const) assert.equal(mayManage("user", target), false, `member on ${target}`);
});

test("the people section is for those who may read accounts, and for nobody while that is not known", () => {
  assert.equal(mayManagePeople(null), false);
  assert.equal(mayManagePeople({ permissions: [] }), false);
  assert.equal(mayManagePeople({ permissions: ["audit.read"] }), false);
  assert.equal(mayManagePeople({ permissions: ["users.read", "audit.read"] }), true);
});

test("the people section is in the settings list and found by searching for what it holds", () => {
  assert.equal(isSectionId("people"), true);
  assert.ok(sections.some((section) => section.id === "people"));
  assert.ok(filterSections("administrator").some((section) => section.id === "people"));
  assert.ok(filterSections("audit").some((section) => section.id === "people"));
  assert.equal(filterSections("license key").some((section) => section.id === "people"), false, "the license key stays under plan and billing");
});

test("a line of the record says who did what to whom", () => {
  const entry = (overrides: Partial<AuditEntryView>): AuditEntryView => ({
    seq: 1, at: "2026-10-27T12:00:00.000Z",
    actor: { kind: "account", id: "a", email: "owner@example.com", role: "owner" },
    action: "account.suspended", target: { id: "t", email: "user@example.com" }, detail: "", ...overrides
  });
  assert.equal(auditLine(entry({})), "owner@example.com: user@example.com suspended");
  assert.equal(auditLine(entry({ action: "role.admin_granted", detail: "role user to admin" })), "owner@example.com: user@example.com made an administrator (role user to admin)");
  assert.equal(auditLine(entry({ actor: { kind: "system", name: "setup" }, action: "role.owner_assigned" })), "setup: user@example.com made the owner");
  assert.equal(auditLine(entry({ target: null, action: "billing.event", detail: "invoice paid" })), "owner@example.com: billing.event (invoice paid)");
});

test("the account list asks the service, with the search encoded and left out when empty", async () => {
  const asked: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    asked.push(String(input));
    return new Response(JSON.stringify({ data: { total: 0, users: [] } }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    await listUsers("  ");
    await listUsers("a b@x.org");
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.match(asked[0], /\/v1\/admin\/users\?limit=100$/);
  assert.match(asked[1], /\/v1\/admin\/users\?limit=100&query=a%20b%40x\.org$/);
});

// ------------------------------------------------------- the screens use it

const source = (relative: string) => readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", relative), "utf8");

test("the payment wall is not shown to the owner or an administrator", () => {
  const wall = source("components/PaywallScreen.tsx");
  assert.match(wall, /entitlements\?\.exempt === true/);
  assert.match(wall, /!exempt/, "an exempt person is never counted as locked");
});

test("on a copy that holds its own accounts the wall speaks about the account, not this PC's trial or license box", () => {
  const wall = source("components/PaywallScreen.tsx");
  const authorityBranch = wall.slice(wall.indexOf("if (entitlements?.authority) {"), wall.indexOf("const expiredLicense"));
  assert.match(authorityBranch, /describeAccess\(entitlements\)/);
  assert.doesNotMatch(authorityBranch, /describeLicense|LicenseKeyForm|BuyButton/, "no PC trial dates, no license box");
});

test("the people section is offered only to those who may manage them, and a deep link to it falls back otherwise", () => {
  const settings = source("os/views/SettingsView.tsx");
  assert.match(settings, /entry\.id !== "people" \|\| canManagePeople/);
  assert.match(settings, /section === "people" && !canManagePeople \? "account"/);
  assert.match(settings, /shownSection === "people" \? <AdminPanel \/>/);
});
