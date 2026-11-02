import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

// On a copy of TRH AI that other people sign in to (TRHAI_AUTHORITY=on), what is
// somebody's is answered only to a signed-in account, and what is the copy's own - its
// license, its email account, what is installed, its switches and shared schedules - is
// changed only by the owner. On a person's own PC none of this applies: everything is
// theirs, and nothing here stands in the way.

const dir = mkdtempSync(path.join(tmpdir(), "trhai-shared-gate-"));
process.env.ASSIST_ACCOUNTS_FILE = path.join(dir, "accounts.json");
process.env.ASSIST_AUDIT_FILE = path.join(dir, "audit.json");
process.env.ASSIST_MEMORY_FILE = path.join(dir, "memory.json");
process.env.ASSIST_CONVERSATION_FILE = path.join(dir, "conversations.json");
process.env.ASSIST_KNOWLEDGE_FILE = path.join(dir, "knowledge.json");
process.env.ASSIST_TASKS_FILE = path.join(dir, "tasks-list.json");
process.env.ASCEND_PREFERENCES_FILE = path.join(dir, "preferences.json");
process.env.TRHAI_LICENSE_FILE = path.join(dir, "license.json");
process.env.TRHAI_TRIAL_MARKER = path.join(dir, "elsewhere", "trial-started");
delete process.env.TRHAI_PAYWALL;
delete process.env.TRHAI_AUTHORITY;

const accounts = await import("../src/services/accounts.js");
const { createApp } = await import("../src/server.js");
const { resetRateLimits } = await import("../src/services/rateLimit.js");

const server = createApp().listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

test.after(() => {
  server.closeAllConnections();
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const password = "correct horse battery";

async function call(method: string, route: string, token?: string, body?: unknown): Promise<{ status: number; code: string | null }> {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await response.json().catch(() => null) as { code?: string } | null;
  return { status: response.status, code: payload?.code ?? null };
}

function people(): { owner: string; member: string } {
  accounts.resetAccounts();
  resetRateLimits();
  const owner = accounts.registerAccount({ email: "owner@example.com", password });
  const member = accounts.registerAccount({ email: "member@example.com", password });
  assert.ok(owner.ok && member.ok);
  assert.ok(accounts.assignOwner(owner.account.id).ok);
  return { owner: owner.token, member: member.token };
}

test("on a shared copy, what is somebody's needs a sign-in, and what a sign-in needs stays open", async () => {
  process.env.TRHAI_AUTHORITY = "on";
  try {
    const { member } = people();
    for (const route of ["/v1/files", "/v1/conversations", "/v1/schedules", "/v1/flow", "/v1/commands", "/v1/system/data", "/v1/identity", "/v1/network", "/v1/world", "/v1/preferences", "/v1/messaging"]) {
      const reply = await call("GET", route);
      assert.equal(reply.status, 401, `${route} without a sign-in`);
      assert.equal(reply.code, "UNAUTHORIZED");
    }
    for (const route of ["/health", "/v1/build-info", "/v1/entitlements", "/v1/plans", "/v1/capabilities", "/v1/assist/model", "/v1/license"]) {
      assert.notEqual((await call("GET", route)).status, 401, `${route} is what the sign-in screen and the paywall need`);
    }
    assert.equal((await call("POST", "/v1/auth/login", undefined, { email: "member@example.com", password })).status, 200, "signing in itself");
    for (const route of ["/v1/files", "/v1/conversations", "/v1/schedules", "/v1/preferences"]) {
      assert.notEqual((await call("GET", route, member)).status, 401, `${route} for a signed-in member`);
    }
  } finally {
    delete process.env.TRHAI_AUTHORITY;
  }
});

test("on a shared copy, a change to the copy itself is the owner's, not a member's", async () => {
  process.env.TRHAI_AUTHORITY = "on";
  try {
    const { owner, member } = people();
    const changes: Array<[string, string, unknown]> = [
      ["PUT", "/v1/messaging/email", { address: "x@example.com", password: "p" }],
      ["POST", "/v1/messaging/email/test", undefined],
      ["POST", "/v1/license/activate", { key: "TRHAI-x" }],
      ["DELETE", "/v1/license", undefined],
      ["POST", "/v1/setup/required", undefined],
      ["PATCH", "/v1/preferences", { personality: "direct" }],
      ["POST", "/v1/network/check", undefined],
      ["POST", "/v1/files/open", { path: "x.txt" }]
    ];
    for (const [method, route, body] of changes) {
      const asMember = await call(method, route, member, body);
      assert.equal(asMember.status, 403, `${method} ${route} as a member`);
      assert.equal(asMember.code, "FORBIDDEN");
      const asOwner = await call(method, route, owner, body);
      assert.ok(asOwner.status !== 401 && asOwner.status !== 403, `${method} ${route} as the owner reaches the route (answered ${asOwner.status})`);
    }
    // The work a plan covers stays the member's: a member in their trial switches machine access, as docs/28 says.
    assert.notEqual((await call("POST", "/v1/commands/disarm", member)).status, 403, "a feature is not a change to the copy");
    assert.notEqual((await call("GET", "/v1/schedules", member)).status, 403, "reading the shared schedules is everyone's");
    assert.notEqual((await call("GET", "/v1/messaging", member)).status, 403, "reading which account sends mail is everyone's; its password never leaves the service");
  } finally {
    delete process.env.TRHAI_AUTHORITY;
  }
});

test("on a person's own PC none of this stands in the way", async () => {
  people();
  for (const route of ["/v1/files", "/v1/schedules", "/v1/preferences", "/v1/license"]) {
    const reply = await call("GET", route);
    assert.ok(reply.status !== 401 && reply.status !== 403, `${route} with no account at all (answered ${reply.status})`);
  }
  assert.notEqual((await call("POST", "/v1/commands/disarm")).status, 403);
});
