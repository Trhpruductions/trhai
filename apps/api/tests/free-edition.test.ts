import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

// TRH AI is free (the owner's decision of 2026-11-05): no trial, no key, nothing locked,
// for anyone. These are the promises that makes, through a real server, on the build's own
// default: TRHAI_PAYWALL is not set here, which is what every installed copy runs with.
//
// licensing.test.ts and access.test.ts keep the paywall itself working, with TRHAI_PAYWALL=on.

const dir = mkdtempSync(path.join(tmpdir(), "trhai-free-"));
const licenseFile = path.join(dir, "license.json");
const markerFile = path.join(dir, "elsewhere", "trial-started");
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
process.env.TRHAI_LICENSE_PUBLIC_KEY = publicKey.export({ type: "spki", format: "der" }).toString("base64");
process.env.TRHAI_LICENSE_FILE = licenseFile;
process.env.TRHAI_TRIAL_MARKER = markerFile;
process.env.ASSIST_ACCOUNTS_FILE = path.join(dir, "accounts.json");
process.env.ASSIST_PRIVACY_REQUESTS_FILE = path.join(dir, "privacy-requests.json");
process.env.ASSIST_AUDIT_FILE = path.join(dir, "audit.json");
process.env.ASSIST_TASKS_FILE = path.join(dir, "tasks-list.json");
process.env.ASSIST_TASKS_PERSIST = "off";
delete process.env.TRHAI_PAYWALL;
delete process.env.TRHAI_AUTHORITY;
delete process.env.TRHAI_CHECKOUT_URL;
delete process.env.TRHAI_PRICE_TEXT;

const licensing = await import("../src/services/licensing.js");
const { accessFacts, effectiveRole, entitlementView, mayUse } = await import("../src/services/access.js");
const { featureIds } = await import("../src/services/entitlements.js");
const { paidEdition } = await import("../src/services/licenseConfig.js");
const { writeProtectedJsonFile } = await import("../src/services/protectedJson.js");
const { createApp } = await import("../src/server.js");
type LicensePayload = import("../src/services/licensing.js").LicensePayload;
type Principal = import("../src/services/access.js").Principal;
type Account = import("../src/services/accounts.js").Account;

const day = 24 * 60 * 60 * 1000;
const guest: Principal = { account: null, signedIn: false, role: "user", status: "active" };

function memberMade(daysAgo: number, overrides: Partial<Principal> = {}): Principal {
  const account = { id: "member", email: "member@example.com", createdAt: new Date(Date.now() - daysAgo * day).toISOString(), status: "active" } as Account;
  return { account, signedIn: true, role: "user", status: "active", ...overrides };
}

function key(overrides: Partial<LicensePayload> = {}): string {
  const payload: LicensePayload = {
    v: 1, id: licensing.newLicenseId(), plan: "pro", email: "keeper@example.com", issuedAt: new Date().toISOString(), ...overrides
  };
  return licensing.formatLicenseKey(payload, sign(null, Buffer.from(JSON.stringify(payload), "utf8"), privateKey));
}

function newPc(): void {
  rmSync(licenseFile, { force: true });
  rmSync(markerFile, { force: true });
  licensing.resetLicensingForTests();
}

/** A PC an earlier version locked: its trial ran out long ago, and it recorded that in both places. */
function pcAnEarlierVersionLocked(): void {
  newPc();
  const started = new Date(Date.now() - (licensing.trialDays + 30) * day).toISOString();
  writeProtectedJsonFile(licenseFile, { trialStartedAt: started });
  mkdirSync(path.dirname(markerFile), { recursive: true });
  writeFileSync(markerFile, `${started}\n`);
  licensing.resetLicensingForTests();
}

const server = createApp().listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function call(method: string, route: string, body?: unknown): Promise<{ status: number; data: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await response.json().catch(() => null) as { data?: unknown } | null;
  return { status: response.status, data: payload?.data ?? payload };
}

test.after(() => {
  server.closeAllConnections();
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

test("this build is free: the switch it is built with says so", () => {
  // A guard on the decision itself. Selling TRH AI again is one line in licenseConfig.ts,
  // and the legal texts say it is free, so turning it back on has to come with changing them.
  assert.equal(paidEdition, false);
});

test("a new PC is free from the first moment: nothing locked, no trial, nothing to buy, and no record left behind", () => {
  newPc();
  process.env.TRHAI_CHECKOUT_URL = "https://example.com/buy";
  process.env.TRHAI_PRICE_TEXT = "$10";
  try {
    const status = licensing.licenseStatus();
    assert.equal(status.state, "free");
    assert.equal(status.plan, "free");
    assert.equal(status.locked, false);
    assert.equal(status.paywallDisabled, true);
    assert.equal(status.license, null);
    assert.equal(status.trialStartedAt, null);
    assert.equal(status.trialEndsAt, null);
    assert.equal(status.trialDaysLeft, 0);
    assert.equal(status.checkoutUrl, null, "there is nothing to buy, whatever a leftover setting says");
    assert.equal(status.priceText, null);
  } finally {
    delete process.env.TRHAI_CHECKOUT_URL;
    delete process.env.TRHAI_PRICE_TEXT;
  }
  assert.equal(existsSync(licenseFile), false, "no license file is written");
  assert.equal(existsSync(markerFile), false, "no trial marker is written");
  assert.equal(licensing.holdsTrialRecord(), false);
});

test("however far off the clock runs, nothing ever locks", () => {
  newPc();
  const later = new Date(Date.now() + 10 * 365 * day);
  assert.equal(licensing.licenseStatus(later).locked, false);
  assert.equal(licensing.licenseStatus(later).state, "free");
  for (const feature of featureIds) assert.equal(mayUse(guest, feature, later).allowed, true, feature);
});

test("every part of TRH AI is open to anyone, with no account, and the screens are told it is free", () => {
  newPc();
  for (const feature of featureIds) {
    assert.deepEqual(mayUse(guest, feature), { allowed: true, via: "paywall_off", plan: "free" }, feature);
  }
  const view = entitlementView(guest);
  assert.equal(view.free, true);
  assert.equal(view.plan, "free");
  assert.equal(view.planLabel, "Free");
  assert.equal(view.lockReason, null);
  assert.ok(view.features.every((feature) => feature.allowed && feature.via === "paywall_off"));
});

test("a PC an earlier version locked opens with the update, and what that version recorded is left alone", () => {
  pcAnEarlierVersionLocked();
  const before = readFileSync(licenseFile, "utf8");
  const marker = readFileSync(markerFile, "utf8");
  const status = licensing.licenseStatus();
  assert.equal(status.state, "free");
  assert.equal(status.locked, false);
  assert.equal(status.trialStartedAt, null, "an old date is not a trial any more, so it is not reported as one");
  assert.equal(accessFacts(guest).lockReason, null);
  assert.equal(mayUse(guest, "assistant").allowed, true);
  assert.equal(readFileSync(licenseFile, "utf8"), before);
  assert.equal(readFileSync(markerFile, "utf8"), marker);
  assert.equal(licensing.holdsTrialRecord(), true);
});

test("a license file changed by hand means nothing: there is no trial for it to end", () => {
  newPc();
  writeFileSync(licenseFile, JSON.stringify({ trialStartedAt: "2099-01-01T00:00:00.000Z" }));
  licensing.resetLicensingForTests();
  const status = licensing.licenseStatus();
  assert.equal(status.state, "free");
  assert.equal(status.locked, false);
  assert.equal(status.trialTampered, false);
  assert.equal(JSON.parse(readFileSync(licenseFile, "utf8")).trialStartedAt, "2099-01-01T00:00:00.000Z", "and nothing rewrote it");
});

test("on a copy other people share nothing lapses either, and signing in and suspending still count", () => {
  newPc();
  process.env.TRHAI_AUTHORITY = "on";
  try {
    const longTimeMember = memberMade(400);
    const facts = accessFacts(longTimeMember);
    assert.equal(facts.lockReason, null, "a lock reason would put the paywall screen in front of them");
    assert.equal(facts.plan, "free");
    assert.equal(facts.accountRequired, true);
    assert.equal(mayUse(longTimeMember, "assistant").allowed, true);
    assert.equal(entitlementView(longTimeMember).lockReason, null);

    // What running a shared copy is about is not the same thing as paying, and stays.
    const refused = mayUse(guest, "assistant");
    assert.equal(refused.allowed, false);
    if (!refused.allowed) assert.equal(refused.reason, "not_signed_in");
    const suspended = mayUse(memberMade(1, { status: "suspended" }), "assistant");
    assert.equal(suspended.allowed, false);
    if (!suspended.allowed) assert.equal(suspended.reason, "suspended");
  } finally {
    delete process.env.TRHAI_AUTHORITY;
  }
});

test("a key still does its one job: it says who looks after the accounts", () => {
  newPc();
  const activated = licensing.activateLicense(key({ role: "admin", email: "Member@Example.com" }));
  assert.equal(activated.ok, true);
  const status = licensing.licenseStatus();
  assert.equal(status.state, "licensed");
  assert.equal(status.locked, false);
  assert.equal(status.license?.role, "admin");
  assert.equal(effectiveRole(memberMade(1).account), "admin");
  assert.equal(effectiveRole({ ...memberMade(1).account as Account, email: "someone@example.com" }), "user");
  // Still free: the view does not turn it into a plan someone is on.
  assert.equal(entitlementView(guest).free, true);
  assert.equal(entitlementView(guest).planLabel, "Free");
  assert.equal(licensing.removeLicense().state, "free");
});

test("a key from before that has since run out locks nothing", () => {
  newPc();
  writeProtectedJsonFile(licenseFile, { key: key({ expiresAt: new Date(Date.now() - day).toISOString() }) });
  licensing.resetLicensingForTests();
  const status = licensing.licenseStatus();
  assert.equal(status.state, "license_expired");
  assert.equal(status.locked, false);
  assert.equal(accessFacts(guest).lockReason, null);
  assert.equal(mayUse(guest, "assistant").allowed, true);
  assert.equal(entitlementView(guest).planLabel, "Free");
});

test("TRHAI_PAYWALL=on brings the trial back for one copy, and =off keeps it free; the spelling does not matter", () => {
  for (const asked of ["on", " ON "]) {
    newPc();
    process.env.TRHAI_PAYWALL = asked;
    try {
      const status = licensing.licenseStatus();
      assert.equal(status.state, "trial", asked);
      assert.equal(status.paywallDisabled, false, asked);
      assert.equal(status.trialDaysLeft, licensing.trialDays, asked);
      assert.equal(existsSync(markerFile), true, "a trial keeps its record");
    } finally {
      delete process.env.TRHAI_PAYWALL;
    }
  }
  newPc();
  process.env.TRHAI_PAYWALL = "off";
  try {
    assert.equal(licensing.licenseStatus().state, "free");
  } finally {
    delete process.env.TRHAI_PAYWALL;
  }
  licensing.resetLicensingForTests();
});

test("through the service: work is done on a PC an earlier version locked, and the screens read that it is free", async () => {
  pcAnEarlierVersionLocked();
  const license = await call("GET", "/v1/license");
  assert.equal(license.status, 200);
  assert.equal(license.data.state, "free");
  assert.equal(license.data.locked, false);
  const entitlements = await call("GET", "/v1/entitlements");
  assert.equal(entitlements.data.free, true);
  assert.equal(entitlements.data.lockReason, null);

  const task = await call("POST", "/v1/tasks", { title: "Water the plants", sessionId: "free-session" });
  assert.notEqual(task.status, 402, "no paywall answers");
  assert.ok(task.status < 400, `the work was done (${task.status})`);
});

test("what an erasure says it left is true: no trial date or key is named on a copy that has neither", async () => {
  newPc();
  const fresh = await call("POST", "/v1/privacy/erase", { sessionId: "free-session", confirm: "ERASE", scope: { ownData: true } });
  assert.equal(fresh.status, 200);
  const kept: string[] = fresh.data.kept;
  assert.ok(kept.every((line) => !/free trial/.test(line)), "no trial was ever recorded here");
  assert.ok(kept.every((line) => !/key on this PC/.test(line)), "there is no key to have kept");
  assert.ok(kept.some((line) => /does not delete them/.test(line)), "the rest of the report is still there");

  pcAnEarlierVersionLocked();
  const older = await call("POST", "/v1/privacy/erase", { sessionId: "free-session", confirm: "ERASE", scope: { ownData: true } });
  assert.ok((older.data.kept as string[]).some((line) => /earlier version .*free trial.*Nothing uses it now/.test(line)), "the old date is named, as what it is");

  newPc();
  assert.equal(licensing.activateLicense(key({ role: "admin" })).ok, true);
  const holding = await call("POST", "/v1/privacy/erase", { sessionId: "free-session", confirm: "ERASE", scope: { ownData: true } });
  assert.ok((holding.data.kept as string[]).some((line) => /key on this PC, because you chose to keep it\. It carries the email address it was issued for/.test(line)), "a key that is there is named");
  assert.notEqual(licensing.licenseStatus().license, null, "and it was left");
  licensing.removeLicense();
});
