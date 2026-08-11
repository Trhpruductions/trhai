import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { once } from "node:events";

const dataDir = mkdtempSync(path.join(tmpdir(), "ascend-password-"));
const accountsFile = path.join(dataDir, "accounts.json");
process.env.ASSIST_ACCOUNTS_FILE = accountsFile;
process.env.ASSIST_MEMORY_FILE = path.join(dataDir, "memory.json");

const {
  accountForToken,
  changePassword,
  login,
  registerAccount,
  resetAccounts
} = await import("../src/services/accounts.js");
const { resetRateLimits } = await import("../src/services/rateLimit.js");
const { createApp } = await import("../src/server.js");

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const original = "correct horse battery";
const replacement = "a different long password";

function freshAccount(email = "user@example.com") {
  resetAccounts();
  resetRateLimits();
  const created = registerAccount({ email, password: original });
  assert.ok(created.ok);
  return created;
}

test("changes the password and lets the new one sign in", () => {
  const created = freshAccount();

  const changed = changePassword({
    token: created.token,
    currentPassword: original,
    newPassword: replacement
  });

  assert.ok(changed.ok);
  assert.ok(login({ email: "user@example.com", password: replacement }).ok);
  assert.ok(!login({ email: "user@example.com", password: original }).ok);
});

test("rejects a wrong current password", () => {
  const created = freshAccount();

  const changed = changePassword({
    token: created.token,
    currentPassword: "not the right one",
    newPassword: replacement
  });

  assert.ok(!changed.ok);
  assert.match(changed.error, /current password/i);
  // The old password must still work after a failed attempt.
  assert.ok(login({ email: "user@example.com", password: original }).ok);
});

test("rejects a new password that is too short or unchanged", () => {
  const created = freshAccount();

  const short = changePassword({ token: created.token, currentPassword: original, newPassword: "tiny" });
  assert.ok(!short.ok);

  const same = changePassword({ token: created.token, currentPassword: original, newPassword: original });
  assert.ok(!same.ok);
  assert.match(same.error, /different/i);
});

test("requires a valid session", () => {
  freshAccount();

  const result = changePassword({
    token: "not-a-real-token",
    currentPassword: original,
    newPassword: replacement
  });

  assert.ok(!result.ok);
  assert.match(result.error, /not signed in/i);
});

test("revokes every other session so a stolen token stops working", () => {
  const created = freshAccount();
  // A second sign-in, standing in for an attacker's session.
  const attacker = login({ email: "user@example.com", password: original });
  assert.ok(attacker.ok);
  assert.ok(accountForToken(attacker.token));

  const changed = changePassword({
    token: created.token,
    currentPassword: original,
    newPassword: replacement
  });
  assert.ok(changed.ok);

  assert.equal(accountForToken(attacker.token), null, "other sessions must be revoked");
  assert.equal(accountForToken(created.token), null, "the old token is replaced");
  assert.ok(accountForToken(changed.token), "the caller receives a working token");
});

test("stores a fresh salt so the new hash is unrelated to the old", () => {
  const created = freshAccount("salt@example.com");
  const before = JSON.parse(readFileSync(accountsFile, "utf8"));
  const saltBefore = before.accounts[0].salt;

  changePassword({ token: created.token, currentPassword: original, newPassword: replacement });

  const after = JSON.parse(readFileSync(accountsFile, "utf8"));
  assert.notEqual(after.accounts[0].salt, saltBefore);
  assert.notEqual(after.accounts[0].hash, before.accounts[0].hash);
});

test("never writes either password to disk", () => {
  const created = freshAccount("plain@example.com");
  changePassword({ token: created.token, currentPassword: original, newPassword: replacement });

  const onDisk = readFileSync(accountsFile, "utf8");
  assert.ok(!onDisk.includes(original));
  assert.ok(!onDisk.includes(replacement));
});

async function startTestServer() {
  const app = createApp();
  const server = app.listen(0);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

async function changeViaApi(baseUrl: string, token: string, currentPassword: string, newPassword: string) {
  const response = await fetch(`${baseUrl}/v1/auth/password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ currentPassword, newPassword })
  });
  return { status: response.status, body: await response.json() as any };
}

test("the endpoint changes the password and returns a usable token", async () => {
  const created = freshAccount("api@example.com");
  const server = await startTestServer();

  try {
    const changed = await changeViaApi(server.baseUrl, created.token, original, replacement);
    assert.equal(changed.status, 200);

    const me = await fetch(`${server.baseUrl}/v1/auth/me`, {
      headers: { Authorization: `Bearer ${changed.body.data.token}` }
    });
    assert.equal(me.status, 200);
  } finally {
    await server.close();
  }
});

test("the endpoint requires authentication", async () => {
  freshAccount("noauth@example.com");
  const server = await startTestServer();

  try {
    const response = await fetch(`${server.baseUrl}/v1/auth/password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword: original, newPassword: replacement })
    });
    assert.equal(response.status, 401);
  } finally {
    await server.close();
  }
});

test("repeated wrong current passwords are throttled", async () => {
  const created = freshAccount("throttle@example.com");
  const server = await startTestServer();

  try {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      statuses.push((await changeViaApi(server.baseUrl, created.token, "wrong guess here", replacement)).status);
    }

    assert.ok(statuses.includes(400), "early attempts are rejected");
    assert.ok(statuses.includes(429), "later attempts are throttled");
  } finally {
    await server.close();
  }
});
