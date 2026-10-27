import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, scryptSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

// Who may do what, through a real server. The rules themselves are pinned in
// entitlements.test.ts; this proves they are the ones the routes apply, and that
// nothing a caller sends can change the answer.
//
// The names start with the letter of the scenario they answer in the account
// and payment requirements (A owner, B administrator, C free user, E expired,
// G tampering, H role changes), so a report can say which passed.
//
// Everything the server reads when it loads is pointed at a throwaway folder
// first, and the signing key is the test's own.
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
process.env.TRHAI_LICENSE_PUBLIC_KEY = publicKey.export({ type: "spki", format: "der" }).toString("base64");
const dir = mkdtempSync(path.join(tmpdir(), "trhai-access-"));
const licenseFile = path.join(dir, "license.json");
const markerFile = path.join(dir, "elsewhere", "trial-started");
const accountsFile = path.join(dir, "accounts.json");
process.env.TRHAI_LICENSE_FILE = licenseFile;
process.env.TRHAI_TRIAL_MARKER = markerFile;
process.env.ASSIST_ACCOUNTS_FILE = accountsFile;
process.env.ASSIST_AUDIT_FILE = path.join(dir, "audit.json");
process.env.ASSIST_MEMORY_FILE = path.join(dir, "memory.json");
process.env.ASSIST_CONVERSATION_FILE = path.join(dir, "conversations.json");
process.env.ASSIST_KNOWLEDGE_FILE = path.join(dir, "knowledge.json");
process.env.ASCEND_PREFERENCES_FILE = path.join(dir, "preferences.json");
delete process.env.TRHAI_PAYWALL;
delete process.env.TRHAI_AUTHORITY;

const accounts = await import("../src/services/accounts.js");
const licensing = await import("../src/services/licensing.js");
const audit = await import("../src/services/audit.js");
const { createApp } = await import("../src/server.js");
const { resetRateLimits } = await import("../src/services/rateLimit.js");
const { writeProtectedJsonFile } = await import("../src/services/protectedJson.js");
type LicensePayload = import("../src/services/licensing.js").LicensePayload;

const server = createApp().listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

test.after(() => {
  server.closeAllConnections();
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const day = 24 * 60 * 60 * 1000;
const password = "correct horse battery";

// ------------------------------------------------------------------ helpers

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Reply = { status: number; body: any };

async function call(method: string, route: string, options: { token?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Reply> {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...options.headers
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

function key(overrides: Partial<LicensePayload> = {}): string {
  const payload: LicensePayload = {
    v: 1, id: licensing.newLicenseId(), plan: "pro", email: "buyer@example.com", issuedAt: new Date().toISOString(), ...overrides
  };
  return licensing.formatLicenseKey(payload, sign(null, Buffer.from(JSON.stringify(payload), "utf8"), privateKey));
}

/** A PC that has just been installed: a full trial, no key. */
function freshPc(): void {
  rmSync(licenseFile, { force: true });
  rmSync(markerFile, { force: true });
  licensing.resetLicensingForTests();
}

/** A PC whose trial ended long ago and that holds no key. */
function lockedPc(): void {
  freshPc();
  writeProtectedJsonFile(licenseFile, { trialStartedAt: new Date(Date.now() - (licensing.trialDays + 5) * day).toISOString() });
  licensing.resetLicensingForTests();
}

/** A PC that held a key which has since run out. */
function pcWithExpiredKey(): void {
  freshPc();
  const expired = key({ expiresAt: new Date(Date.now() - day).toISOString() });
  writeProtectedJsonFile(licenseFile, { trialStartedAt: new Date(Date.now() - 60 * day).toISOString(), key: expired });
  licensing.resetLicensingForTests();
}

function reset(): void {
  accounts.resetAccounts();
  audit.resetAuditForTests();
  resetRateLimits();
  freshPc();
}

// One salt and hash for every seeded account, so a test does not pay for a key
// derivation per person. They are made the way accounts.ts makes them.
const seedSalt = "00112233445566778899aabbccddeeff";
const seedHash = scryptSync(password, seedSalt, 64).toString("hex");

type Seed = {
  email: string;
  role?: "owner" | "admin" | "user";
  status?: "active" | "suspended";
  ageDays?: number;
  /** A session this account already has, as a token the test knows. */
  token?: string;
};

/**
 * Accounts written straight to the file, then loaded as the server would on
 * start - the only way to have an account that is already 30 days old, one with
 * a stored role, or one suspended with a session still alive, without going
 * through the very routes under test.
 */
function seed(people: Seed[]): void {
  const stored = people.map((person) => ({
    id: randomUUID(),
    email: person.email,
    displayName: person.email.split("@")[0],
    createdAt: new Date(Date.now() - (person.ageDays ?? 30) * day).toISOString(),
    ...(person.role ? { role: person.role } : {}),
    ...(person.status ? { status: person.status } : {}),
    salt: seedSalt,
    hash: seedHash
  }));
  const tokens = people.flatMap((person, index) => person.token
    ? [{
        tokenHash: createHash("sha256").update(person.token).digest("hex"),
        userId: stored[index].id,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + day).toISOString()
      }]
    : []);
  writeProtectedJsonFile(accountsFile, { version: 1, schema: 2, accounts: stored, tokens });
  accounts.reloadAccountsFromDisk();
}

function signIn(email: string): string {
  const result = accounts.login({ email, password });
  assert.ok(result.ok, `could not sign ${email} in`);
  return result.token;
}

function idOf(email: string): string {
  const found = accounts.listAccounts({ query: email }).accounts.find((account) => account.email === email);
  assert.ok(found, `no account for ${email}`);
  return found.id;
}

/** Runs a body as a copy that is the system of record for its accounts, and puts it back after. */
async function asAuthority(run: () => Promise<void>): Promise<void> {
  process.env.TRHAI_AUTHORITY = "on";
  try {
    await run();
  } finally {
    delete process.env.TRHAI_AUTHORITY;
  }
}

const adminRoutes: Array<[string, string]> = [
  ["GET", "/v1/admin/users"],
  ["GET", "/v1/admin/audit"]
];

// ------------------------------------------------------------------ A: the owner

test("A: the owner, with no subscription, no payment method and a trial long over, uses every feature and every administrator route", async () => {
  await asAuthority(async () => {
    reset();
    seed([{ email: "owner@example.com", role: "owner", ageDays: 400 }]);
    const token = signIn("owner@example.com");

    const view = await call("GET", "/v1/entitlements", { token });
    assert.equal(view.status, 200);
    assert.equal(view.body.data.role, "owner");
    assert.equal(view.body.data.exempt, true);
    assert.equal(view.body.data.plan, "free", "they hold no plan at all");
    assert.ok(view.body.data.features.length >= 10);
    for (const feature of view.body.data.features) {
      assert.equal(feature.allowed, true, feature.id);
      assert.equal(feature.via, "owner", feature.id);
    }
    assert.equal((await call("POST", "/v1/commands/disarm", { token })).status, 200, "work goes through");
    for (const [method, route] of adminRoutes) assert.equal((await call(method, route, { token })).status, 200, route);
  });
});

test("A (this PC): an owner key makes its account the owner; the trial and the PC's plan are beside the point", async () => {
  reset();
  lockedPc();
  const owner = accounts.registerAccount({ email: "owner@example.com", password });
  assert.ok(owner.ok);
  const other = accounts.registerAccount({ email: "friend@example.com", password });
  assert.ok(other.ok);

  assert.equal((await call("POST", "/v1/commands/disarm", { token: owner.token })).status, 402, "locked, and a plain account is no exception");
  assert.equal((await call("GET", "/v1/admin/users", { token: owner.token })).status, 403, "and not yet the owner");

  const activated = licensing.activateLicense(key({ role: "owner", email: "Owner@Example.com", plan: "team" }));
  assert.ok(activated.ok);

  assert.equal((await call("GET", "/v1/admin/users", { token: owner.token })).status, 200, "the email matches, whatever its case");
  assert.equal((await call("GET", "/v1/admin/users", { token: other.token })).status, 403, "the key names one account, not the whole PC");
  const me = await call("GET", "/v1/auth/me", { token: owner.token });
  assert.equal(me.body.data.role, "owner");
  assert.equal((await call("GET", "/v1/auth/me", { token: other.token })).body.data.role, "user");
  // The PC itself is licensed for everyone using it - as a license always has been.
  assert.equal((await call("POST", "/v1/commands/disarm", { token: other.token })).status, 200);

  licensing.removeLicense();
  assert.equal((await call("GET", "/v1/admin/users", { token: owner.token })).status, 403, "take the key off and the role goes with it, at once");
});

// ------------------------------------------------------------ B: the administrator

test("B: an administrator, with no subscription, uses every feature and the support routes - but not the owner's", async () => {
  await asAuthority(async () => {
    reset();
    seed([
      { email: "owner@example.com", role: "owner", ageDays: 400 },
      { email: "admin@example.com", role: "admin", ageDays: 400 },
      { email: "user@example.com", ageDays: 400 }
    ]);
    const token = signIn("admin@example.com");

    const view = await call("GET", "/v1/entitlements", { token });
    assert.equal(view.body.data.role, "admin");
    assert.equal(view.body.data.exempt, true);
    for (const feature of view.body.data.features) assert.equal(feature.via, "admin", feature.id);
    assert.equal((await call("POST", "/v1/commands/disarm", { token })).status, 200);
    for (const [method, route] of adminRoutes) assert.equal((await call(method, route, { token })).status, 200, route);

    // What stays the owner's.
    const refused = await call("PUT", `/v1/admin/users/${idOf("user@example.com")}/role`, { token, body: { role: "admin" } });
    assert.equal(refused.status, 403, "an administrator cannot make administrators");
    const ownerId = idOf("owner@example.com");
    assert.equal((await call("PATCH", `/v1/admin/users/${ownerId}/status`, { token, body: { status: "suspended" } })).status, 403);
    assert.equal((await call("DELETE", `/v1/admin/users/${ownerId}/sessions`, { token })).status, 403, "nor sign the owner out");
    assert.equal((await call("PATCH", `/v1/admin/users/${idOf("admin@example.com")}/status`, { token, body: { status: "suspended" } })).status, 400, "nor suspend themselves");
    assert.equal(accounts.ownerAccount()?.email, "owner@example.com", "and the owner is still the owner");
  });
});

test("B (this PC): an administrator key works the same way, and does not make the holder the owner", async () => {
  reset();
  lockedPc();
  const admin = accounts.registerAccount({ email: "admin@example.com", password });
  assert.ok(admin.ok);
  licensing.activateLicense(key({ role: "admin", email: "admin@example.com" }));
  assert.equal((await call("GET", "/v1/admin/users", { token: admin.token })).status, 200);
  assert.equal((await call("GET", "/v1/auth/me", { token: admin.token })).body.data.role, "admin");
  const refused = await call("PUT", `/v1/admin/users/${admin.account.id}/role`, { token: admin.token, body: { role: "user" } });
  assert.equal(refused.status, 403);
});

// --------------------------------------------------------------- C: the free user

test("C: an ordinary user past their trial is refused the work, with the reason, and keeps what was never paywalled", async () => {
  await asAuthority(async () => {
    reset();
    seed([{ email: "user@example.com", ageDays: 30 }]);
    const token = signIn("user@example.com");

    const refused = await call("POST", "/v1/commands/disarm", { token });
    assert.equal(refused.status, 402);
    assert.equal(refused.body.code, "PAYMENT_REQUIRED");
    assert.match(refused.body.message, /trial/);

    assert.equal((await call("GET", "/v1/commands", { token })).status, 200, "reads stay open, so a locked app still shows what it holds");
    const speech = await call("POST", "/v1/speech", { token, body: {} });
    assert.equal(speech.status, 400, "the voice gate lets the request through; it is the missing text that stops it");

    const view = await call("GET", "/v1/entitlements", { token });
    assert.equal(view.body.data.exempt, false);
    assert.equal(view.body.data.role, "user");
    assert.equal(view.body.data.lockReason, "trial_ended");
    const byId = Object.fromEntries(view.body.data.features.map((feature: { id: string }) => [feature.id, feature]));
    assert.equal(byId.assistant.allowed, false);
    assert.equal(byId.assistant.reason, "trial_ended");
    assert.equal(byId.voice_speech.allowed, true);
    assert.deepEqual(view.body.data.permissions, [], "and no administrator permission at all");
  });
});

test("C: the same user inside their trial is let through, as the plan says", async () => {
  await asAuthority(async () => {
    reset();
    seed([{ email: "new@example.com", ageDays: 3 }]);
    const token = signIn("new@example.com");
    assert.equal((await call("POST", "/v1/commands/disarm", { token })).status, 200);
    assert.equal((await call("GET", "/v1/entitlements", { token })).body.data.plan, "trial");
  });
});

test("C (this PC): a locked PC refuses every route a plan can switch on, and nothing outside the catalogue", async () => {
  reset();
  lockedPc();
  const user = accounts.registerAccount({ email: "user@example.com", password });
  assert.ok(user.ok);
  const gated: Array<[string, string]> = [
    ["POST", "/v1/assist"], ["POST", "/v1/assist/stream"], ["POST", "/v1/apps/start"], ["POST", "/v1/commands/arm"],
    ["POST", "/v1/schedules"], ["POST", "/v1/tasks"], ["POST", "/v1/agent-tasks"], ["PUT", "/v1/flow"],
    ["POST", "/v1/vision/warm"], ["POST", "/v1/music-video/start"]
  ];
  for (const [method, route] of gated) {
    const reply = await call(method, route, { token: user.token, body: {} });
    assert.equal(reply.status, 402, `${method} ${route}`);
    assert.equal(reply.body.code, "PAYMENT_REQUIRED");
  }
  // Without any account at all, the same: it is the PC that is locked.
  assert.equal((await call("POST", "/v1/commands/disarm")).status, 402);
  // Clicking into the chat box must not reopen the paywall, so the warm-up is
  // skipped rather than refused.
  const warm = await call("POST", "/v1/warm-up", { token: user.token, body: {} });
  assert.equal(warm.status, 202);
  assert.equal(warm.body.data.state, "skipped");
  // Never behind a plan: signing in, the license box, the plan screens.
  assert.equal((await call("POST", "/v1/auth/login", { body: { email: "user@example.com", password } })).status, 200);
  assert.equal((await call("GET", "/v1/license")).status, 200);
  assert.equal((await call("GET", "/v1/plans")).status, 200);
  assert.equal((await call("GET", "/v1/entitlements")).status, 200);
});

// ---------------------------------------------------------------------- E: expired

test("E: a license that has run out locks an ordinary user with its own message, and never an owner or administrator", async () => {
  reset();
  pcWithExpiredKey();
  const user = accounts.registerAccount({ email: "user@example.com", password });
  assert.ok(user.ok);
  const refused = await call("POST", "/v1/commands/disarm", { token: user.token });
  assert.equal(refused.status, 402);
  assert.match(refused.body.message, /license has expired/);

  await asAuthority(async () => {
    reset();
    pcWithExpiredKey();
    seed([{ email: "owner@example.com", role: "owner" }, { email: "admin@example.com", role: "admin" }, { email: "user@example.com", ageDays: 90 }]);
    assert.equal((await call("POST", "/v1/commands/disarm", { token: signIn("owner@example.com") })).status, 200);
    assert.equal((await call("POST", "/v1/commands/disarm", { token: signIn("admin@example.com") })).status, 200);
    assert.equal((await call("POST", "/v1/commands/disarm", { token: signIn("user@example.com") })).status, 402);
  });
});

// ------------------------------------------------------------------ G: tampering

test("G: nothing a caller sends can make them an administrator", async () => {
  reset();
  const user = accounts.registerAccount({ email: "user@example.com", password });
  assert.ok(user.ok);
  const target = accounts.registerAccount({ email: "target@example.com", password });
  assert.ok(target.ok);

  const claims: Array<Record<string, string>> = [
    { "X-Role": "owner" }, { "X-User-Role": "admin", "X-Admin": "true" }, { "X-Is-Owner": "1", "X-Forwarded-User": "owner@example.com" }
  ];
  const attempts: Array<[string, string, unknown]> = [
    ["GET", "/v1/admin/users?role=owner&admin=true", undefined],
    ["GET", "/v1/admin/audit", undefined],
    ["PATCH", `/v1/admin/users/${target.account.id}/status`, { status: "suspended", role: "owner", admin: true }],
    ["PUT", `/v1/admin/users/${user.account.id}/role`, { role: "admin", asOwner: true }],
    ["DELETE", `/v1/admin/users/${target.account.id}/sessions`, undefined]
  ];
  for (const headers of claims) {
    for (const [method, route, body] of attempts) {
      const reply = await call(method, route, { token: user.token, headers, body });
      assert.equal(reply.status, 403, `${method} ${route} with ${Object.keys(headers).join(",")}`);
      assert.equal(reply.body.code, "FORBIDDEN");
    }
  }
  assert.equal(accounts.findAccount(target.account.id)?.status, "active", "and nothing was changed");
  assert.equal(accounts.storedRoleOf(user.account.id), "user");

  // A token that was never issued is no one; so is no token.
  for (const [method, route] of [["GET", "/v1/admin/users"], ["GET", "/v1/admin/audit"]] as const) {
    assert.equal((await call(method, route, { token: "f".repeat(64) })).status, 401, "a made-up token");
    assert.equal((await call(method, route)).status, 401, "no token");
  }
  const entitlements = await call("GET", "/v1/entitlements", { token: "f".repeat(64), headers: { "X-Role": "owner" } });
  assert.equal(entitlements.body.data.signedIn, false);
  assert.equal(entitlements.body.data.role, "user");
});

test("G: a role written into the accounts file is not believed on an ordinary install - only a signed key counts", async () => {
  reset();
  lockedPc();
  seed([{ email: "cheater@example.com", role: "owner", ageDays: 400 }]);
  const token = signIn("cheater@example.com");
  assert.equal((await call("GET", "/v1/auth/me", { token })).body.data.role, "user");
  assert.equal((await call("GET", "/v1/admin/users", { token })).status, 403);
  assert.equal((await call("POST", "/v1/commands/disarm", { token })).status, 402, "and being 'owner' in a file buys no features either");

  // The same file, on a copy that is the system of record, is that copy's own word.
  await asAuthority(async () => {
    assert.equal((await call("GET", "/v1/auth/me", { token })).body.data.role, "owner");
    assert.equal((await call("GET", "/v1/admin/users", { token })).status, 200);
  });
});

test("G: a key for someone else's email makes nobody else an administrator", async () => {
  reset();
  const admin = accounts.registerAccount({ email: "admin@example.com", password });
  const impostor = accounts.registerAccount({ email: "impostor@example.com", password });
  assert.ok(admin.ok && impostor.ok);
  licensing.activateLicense(key({ role: "admin", email: "admin@example.com" }));
  assert.equal((await call("GET", "/v1/admin/users", { token: impostor.token })).status, 403);
  assert.equal((await call("GET", "/v1/admin/users", { token: admin.token })).status, 200);
});

test("G: a role added to a signed key by hand is refused when the key is entered", async () => {
  reset();
  const [head, signature] = key().slice("TRHAI-".length).split(".");
  const payload = JSON.parse(Buffer.from(head, "base64url").toString("utf8")) as Record<string, unknown>;
  payload.role = "owner";
  const forged = `TRHAI-${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}.${signature}`;
  const reply = await call("POST", "/v1/license/activate", { body: { key: forged } });
  assert.equal(reply.status, 400);
  assert.equal(reply.body.code, "INVALID_LICENSE");
  assert.equal((await call("GET", "/v1/license")).body.data.license, null);
});

test("G: an administrator listing never carries a password, a hash, a token or a recovery code", async () => {
  await asAuthority(async () => {
    reset();
    seed([{ email: "owner@example.com", role: "owner" }, { email: "someone@example.com" }]);
    const token = signIn("owner@example.com");
    const raw = JSON.stringify((await call("GET", "/v1/admin/users", { token })).body);
    for (const secret of [password, seedHash, seedSalt, token, "recoveryCodeHashes", "recoverySalt", "tokenHash"]) {
      assert.equal(raw.includes(secret), false, `the listing contains ${secret.slice(0, 12)}`);
    }
    assert.match(raw, /someone@example.com/);
  });
});

// ------------------------------------------------------------- H: role changes

test("H: the owner makes an administrator and takes it away again, and the very next request shows it", async () => {
  await asAuthority(async () => {
    reset();
    seed([{ email: "owner@example.com", role: "owner" }, { email: "helper@example.com" }]);
    const owner = signIn("owner@example.com");
    const helper = signIn("helper@example.com");
    const helperId = idOf("helper@example.com");

    assert.equal((await call("GET", "/v1/admin/users", { token: helper })).status, 403);
    const granted = await call("PUT", `/v1/admin/users/${helperId}/role`, { token: owner, body: { role: "admin" } });
    assert.equal(granted.status, 200);
    assert.equal(granted.body.data.user.role, "admin");
    assert.equal((await call("GET", "/v1/admin/users", { token: helper })).status, 200, "the same token, no sign-in again");

    const revoked = await call("PUT", `/v1/admin/users/${helperId}/role`, { token: owner, body: { role: "user" } });
    assert.equal(revoked.status, 200);
    assert.equal((await call("GET", "/v1/admin/users", { token: helper })).status, 403, "and gone the moment it is taken away");

    // Ownership is not something this route hands out or takes.
    assert.equal((await call("PUT", `/v1/admin/users/${helperId}/role`, { token: owner, body: { role: "owner" } })).status, 400);
    assert.equal((await call("PUT", `/v1/admin/users/${idOf("owner@example.com")}/role`, { token: owner, body: { role: "user" } })).status, 403);
    assert.equal(accounts.ownerAccount()?.email, "owner@example.com");
  });
});

test("H: suspending ends the sessions and the sign-in, reactivating gives both back, and the owner cannot be suspended", async () => {
  await asAuthority(async () => {
    reset();
    seed([
      { email: "owner@example.com", role: "owner" },
      { email: "admin@example.com", role: "admin" },
      { email: "other-admin@example.com", role: "admin" },
      { email: "user@example.com", ageDays: 2 }
    ]);
    const admin = signIn("admin@example.com");
    const user = signIn("user@example.com");
    const userId = idOf("user@example.com");
    assert.equal((await call("GET", "/v1/auth/me", { token: user })).status, 200);

    const suspended = await call("PATCH", `/v1/admin/users/${userId}/status`, { token: admin, body: { status: "suspended" } });
    assert.equal(suspended.status, 200);
    assert.equal(suspended.body.data.user.status, "suspended");
    assert.equal((await call("GET", "/v1/auth/me", { token: user })).status, 401, "the signed-in device is out");
    assert.equal((await call("POST", "/v1/commands/disarm", { token: user })).status, 401, "and in a shared service, a token that is gone is no one");

    const blocked = await call("POST", "/v1/auth/login", { body: { email: "user@example.com", password } });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.code, "ACCOUNT_SUSPENDED");
    const wrong = await call("POST", "/v1/auth/login", { body: { email: "user@example.com", password: "not the password" } });
    assert.equal(wrong.status, 401, "someone guessing is told nothing about the account");
    assert.notEqual(wrong.body.message, blocked.body.message);

    const reactivated = await call("PATCH", `/v1/admin/users/${userId}/status`, { token: admin, body: { status: "active" } });
    assert.equal(reactivated.status, 200);
    assert.equal((await call("POST", "/v1/auth/login", { body: { email: "user@example.com", password } })).status, 200);

    // Who an administrator may and may not act on.
    const ownerId = idOf("owner@example.com");
    const otherAdminId = idOf("other-admin@example.com");
    assert.equal((await call("PATCH", `/v1/admin/users/${ownerId}/status`, { token: admin, body: { status: "suspended" } })).status, 403);
    assert.equal((await call("PATCH", `/v1/admin/users/${otherAdminId}/status`, { token: admin, body: { status: "suspended" } })).status, 403);
    const owner = signIn("owner@example.com");
    assert.equal((await call("PATCH", `/v1/admin/users/${ownerId}/status`, { token: owner, body: { status: "suspended" } })).status, 400, "not even by themselves");
    assert.equal((await call("PATCH", `/v1/admin/users/${otherAdminId}/status`, { token: owner, body: { status: "suspended" } })).status, 200, "the owner looks after administrators");
    assert.equal((await call("PATCH", `/v1/admin/users/${userId}/status`, { token: admin, body: { status: "maybe" } })).status, 400);
    assert.equal((await call("PATCH", "/v1/admin/users/no-such-id/status", { token: admin, body: { status: "active" } })).status, 404);
  });
});

test("H: a suspended account whose session somehow survived is still refused - except that a hand-edited owner record cannot lock the owner out", async () => {
  await asAuthority(async () => {
    reset();
    const owner = "o".repeat(64);
    const admin = "a".repeat(64);
    const user = "u".repeat(64);
    seed([
      { email: "owner@example.com", role: "owner", status: "suspended", token: owner },
      { email: "admin@example.com", role: "admin", status: "suspended", token: admin },
      { email: "user@example.com", status: "suspended", token: user, ageDays: 1 }
    ]);
    const support = await call("GET", "/v1/admin/users", { token: admin });
    assert.equal(support.status, 403);
    assert.equal(support.body.code, "ACCOUNT_SUSPENDED");
    const work = await call("POST", "/v1/commands/disarm", { token: user });
    assert.equal(work.status, 403);
    assert.equal(work.body.code, "ACCOUNT_SUSPENDED");
    assert.equal((await call("POST", "/v1/commands/disarm", { token: admin })).status, 403, "an administrator's exemption is not a way round it");
    assert.equal((await call("GET", "/v1/entitlements", { token: user })).body.data.status, "suspended");

    assert.equal((await call("GET", "/v1/admin/users", { token: owner })).status, 200);
    assert.equal((await call("POST", "/v1/commands/disarm", { token: owner })).status, 200);
  });
});

test("H: a recovery code cannot reopen a suspended account, and is not spent trying", async () => {
  reset();
  const made = accounts.registerAccount({ email: "user@example.com", password });
  assert.ok(made.ok);
  accounts.setAccountStatus(made.account.id, "suspended");
  const reply = await call("POST", "/v1/auth/recover", {
    body: { email: "user@example.com", code: made.recoveryCodes[0], newPassword: "a brand new password" }
  });
  assert.equal(reply.status, 400);
  accounts.setAccountStatus(made.account.id, "active");
  assert.equal(accounts.remainingRecoveryCodes(made.account.id), accounts.recoveryCodeCount, "the code is still there");
  assert.ok(accounts.login({ email: "user@example.com", password }).ok, "and the old password still works");
});

test("H: a suspended account is not carried toward a lockout by being told it is suspended", async () => {
  reset();
  seed([{ email: "user@example.com", status: "suspended" }]);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const reply = await call("POST", "/v1/auth/login", { body: { email: "user@example.com", password } });
    assert.equal(reply.status, 403, `attempt ${attempt + 1}`);
  }
});

test("H: revoking an account's sessions signs it out everywhere", async () => {
  await asAuthority(async () => {
    reset();
    seed([{ email: "owner@example.com", role: "owner" }, { email: "user@example.com", ageDays: 2 }]);
    const owner = signIn("owner@example.com");
    const first = signIn("user@example.com");
    const second = signIn("user@example.com");
    const userId = idOf("user@example.com");
    assert.equal((await call("GET", "/v1/admin/users?query=user@", { token: owner })).body.data.users[0].sessionCount, 2);

    const reply = await call("DELETE", `/v1/admin/users/${userId}/sessions`, { token: owner });
    assert.equal(reply.status, 200);
    assert.equal(reply.body.data.revoked, 2);
    assert.equal((await call("GET", "/v1/auth/me", { token: first })).status, 401);
    assert.equal((await call("GET", "/v1/auth/me", { token: second })).status, 401);
  });
});

test("H (this PC): an administrator is made by a key, so the setting that would make one says so", async () => {
  reset();
  const owner = accounts.registerAccount({ email: "owner@example.com", password });
  const user = accounts.registerAccount({ email: "user@example.com", password });
  assert.ok(owner.ok && user.ok);
  licensing.activateLicense(key({ role: "owner", email: "owner@example.com" }));
  const reply = await call("PUT", `/v1/admin/users/${user.account.id}/role`, { token: owner.token, body: { role: "admin" } });
  assert.equal(reply.status, 409);
  assert.equal(reply.body.code, "ROLE_COMES_FROM_KEY");
  assert.equal(accounts.storedRoleOf(user.account.id), "user");
});

test("H: every change to who can do what is in the audit log, by whom and to whom, and the log holds no secrets", async () => {
  await asAuthority(async () => {
    reset();
    seed([{ email: "owner@example.com", role: "owner" }, { email: "user@example.com", ageDays: 2 }]);
    const owner = signIn("owner@example.com");
    const userId = idOf("user@example.com");
    await call("PUT", `/v1/admin/users/${userId}/role`, { token: owner, body: { role: "admin" } });
    await call("PUT", `/v1/admin/users/${userId}/role`, { token: owner, body: { role: "user" } });
    await call("PATCH", `/v1/admin/users/${userId}/status`, { token: owner, body: { status: "suspended" } });
    await call("PATCH", `/v1/admin/users/${userId}/status`, { token: owner, body: { status: "active" } });

    const reply = await call("GET", "/v1/admin/audit", { token: owner });
    assert.equal(reply.status, 200);
    assert.equal(reply.body.data.chain.ok, true);
    const actions = reply.body.data.entries.map((entry: { action: string }) => entry.action);
    assert.deepEqual(actions, ["account.reactivated", "account.suspended", "role.admin_revoked", "role.admin_granted"], "newest first");
    for (const entry of reply.body.data.entries) {
      assert.equal(entry.actor.email, "owner@example.com");
      assert.equal(entry.actor.role, "owner");
      assert.equal(entry.target.email, "user@example.com");
    }
    const raw = JSON.stringify(reply.body);
    for (const secret of [password, seedHash, seedSalt, owner]) assert.equal(raw.includes(secret), false);
    assert.equal((await call("GET", "/v1/admin/audit", { token: signIn("user@example.com") })).status, 403, "an ordinary user cannot read it");
  });
});

// ------------------------------------------------------------------- the listing

test("an administrator finds accounts by part of an email, a page at a time", async () => {
  await asAuthority(async () => {
    reset();
    seed([
      { email: "owner@example.com", role: "owner" },
      ...Array.from({ length: 7 }, (_, index) => ({ email: `person${index}@example.org` })),
      { email: "ada@example.com" }
    ]);
    const token = signIn("owner@example.com");
    const all = await call("GET", "/v1/admin/users", { token });
    assert.equal(all.body.data.total, 9);
    const org = await call("GET", "/v1/admin/users?query=EXAMPLE.ORG", { token });
    assert.equal(org.body.data.total, 7, "case does not matter");
    const page = await call("GET", "/v1/admin/users?query=example.org&limit=3&offset=3", { token });
    assert.equal(page.body.data.users.length, 3);
    assert.equal(page.body.data.total, 7);
    assert.deepEqual(page.body.data.users.map((u: { email: string }) => u.email), ["person3@example.org", "person4@example.org", "person5@example.org"]);
    const ada = (await call("GET", "/v1/admin/users?query=ada", { token })).body.data.users[0];
    assert.equal(ada.email, "ada@example.com");
    assert.equal(ada.status, "active");
    assert.equal(ada.emailVerified, false);
    assert.equal(ada.role, "user");
    assert.match(ada.createdAt, /^\d{4}-/);
    assert.equal(ada.lastLoginAt, null, "never signed in");
    const owner = all.body.data.users.find((user: { email: string }) => user.email === "owner@example.com");
    assert.match(owner.lastLoginAt, /^\d{4}-/, "signed in just now");
  });
});

// -------------------------------------------------------------- an existing install

test("accounts made before roles existed read as active, unverified, ordinary - and are copied once before the file changes", async () => {
  reset();
  const copy = `${accountsFile}.before-roles`;
  rmSync(copy, { force: true });
  const legacy = {
    version: 1,
    accounts: [{ id: randomUUID(), email: "old@example.com", displayName: "old", createdAt: "2026-01-01T00:00:00.000Z", salt: seedSalt, hash: seedHash }],
    tokens: []
  };
  writeProtectedJsonFile(accountsFile, legacy);
  const original = readFileSync(accountsFile);
  accounts.reloadAccountsFromDisk();
  assert.equal(existsSync(copy), false, "reading changes nothing");

  const signedIn = accounts.login({ email: "old@example.com", password });
  assert.ok(signedIn.ok);
  assert.equal(signedIn.account.status, "active");
  assert.equal(signedIn.account.emailVerifiedAt, null);
  assert.equal(accounts.storedRoleOf(signedIn.account.id), "user");
  assert.ok(existsSync(copy), "the first write keeps the old file");
  assert.deepEqual(readFileSync(copy), original, "exactly as it was");

  const second = accounts.login({ email: "old@example.com", password });
  assert.ok(second.ok);
  assert.deepEqual(readFileSync(copy), original, "and the copy is not replaced by later writes");

  accounts.reloadAccountsFromDisk();
  assert.ok(accounts.login({ email: "old@example.com", password }).ok, "the new layout reads back");

  // The old version runs again and writes its own layout; the next upgrade must not
  // replace the copy with that - the copy is the oldest file there was, kept as it was.
  writeProtectedJsonFile(accountsFile, {
    ...legacy,
    accounts: [...legacy.accounts, { id: randomUUID(), email: "older@example.com", displayName: "older", createdAt: "2026-02-01T00:00:00.000Z", salt: seedSalt, hash: seedHash }]
  });
  accounts.reloadAccountsFromDisk();
  assert.ok(accounts.login({ email: "older@example.com", password }).ok);
  assert.deepEqual(readFileSync(copy), original, "never replaced by a later copy of the old layout");
});

test("a second account cannot be made with the same email in another case", () => {
  reset();
  assert.ok(accounts.registerAccount({ email: "Mixed.Case@Example.com", password }).ok);
  for (const variant of ["mixed.case@example.com", "MIXED.CASE@EXAMPLE.COM", " mixed.case@example.com "]) {
    const again = accounts.registerAccount({ email: variant, password });
    assert.equal(again.ok, false, variant);
  }
  assert.equal(accounts.listAccounts().total, 1);
});

test("there is one owner, and a second is made only by handing ownership over", () => {
  reset();
  seed([{ email: "first@example.com" }, { email: "second@example.com" }, { email: "gone@example.com", status: "suspended" }]);
  const first = idOf("first@example.com");
  const second = idOf("second@example.com");
  assert.ok(accounts.assignOwner(first).ok);
  assert.equal(accounts.ownerAccount()?.email, "first@example.com");
  assert.equal(accounts.assignOwner(second).ok, false, "not while there is one");
  assert.equal(accounts.ownerAccount()?.email, "first@example.com");
  assert.equal(accounts.assignOwner(idOf("gone@example.com"), { transfer: true }).ok, false, "a suspended account cannot be given ownership");
  assert.ok(accounts.assignOwner(second, { transfer: true }).ok);
  assert.equal(accounts.ownerAccount()?.email, "second@example.com");
  assert.equal(accounts.storedRoleOf(first), "admin", "the old owner stays on as an administrator");
  assert.equal(accounts.setStoredRole(second, "user").ok, false, "and the owner is not demoted by a role change");
});

test("a guest on a fresh PC is told what the trial gives, and the plans are listed for everyone", async () => {
  reset();
  const view = await call("GET", "/v1/entitlements");
  assert.equal(view.status, 200);
  assert.equal(view.body.data.signedIn, false);
  assert.equal(view.body.data.role, "user");
  assert.equal(view.body.data.plan, "trial");
  assert.equal(view.body.data.exempt, false);
  assert.ok(view.body.data.features.every((feature: { allowed: boolean }) => feature.allowed));
  const plans = await call("GET", "/v1/plans");
  assert.equal(plans.body.data.current, "trial");
  assert.deepEqual(plans.body.data.plans.map((plan: { id: string }) => plan.id).sort(), ["free", "personal", "pro", "team", "trial"]);
  const free = plans.body.data.plans.find((plan: { id: string }) => plan.id === "free");
  assert.deepEqual([...free.features].sort(), ["voice_dictation", "voice_speech"]);
});
