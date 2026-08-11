import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { once } from "node:events";

const dataDir = mkdtempSync(path.join(tmpdir(), "ascend-recovery-"));
const accountsFile = path.join(dataDir, "accounts.json");
process.env.ASSIST_ACCOUNTS_FILE = accountsFile;
process.env.ASSIST_MEMORY_FILE = path.join(dataDir, "memory.json");

const {
  accountForToken,
  login,
  normalizeRecoveryCode,
  recoverWithCode,
  recoveryCodeCount,
  registerAccount,
  remainingRecoveryCodes,
  reloadAccountsFromDisk,
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

test("registration issues a full set of distinct codes", () => {
  const created = freshAccount();

  assert.equal(created.recoveryCodes.length, recoveryCodeCount);
  assert.equal(new Set(created.recoveryCodes).size, recoveryCodeCount);
  for (const code of created.recoveryCodes) {
    assert.match(code, /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  }
});

test("codes avoid characters that are easy to misread", () => {
  const created = freshAccount();

  for (const code of created.recoveryCodes) {
    assert.doesNotMatch(code, /[ILOU]/, `ambiguous character in ${code}`);
  }
});

test("only hashes are stored, never the codes themselves", () => {
  const created = freshAccount("hash@example.com");
  const onDisk = readFileSync(accountsFile, "utf8");

  for (const code of created.recoveryCodes) {
    assert.ok(!onDisk.includes(code), "a plaintext code reached disk");
    assert.ok(!onDisk.includes(normalizeRecoveryCode(code)), "a normalized code reached disk");
  }
  assert.match(onDisk, /recoveryCodeHashes/);
});

test("a code resets the password and signs the user in", () => {
  const created = freshAccount();

  const recovered = recoverWithCode({
    email: "user@example.com",
    code: created.recoveryCodes[0],
    newPassword: replacement
  });

  assert.ok(recovered.ok);
  assert.ok(accountForToken(recovered.token));
  assert.ok(login({ email: "user@example.com", password: replacement }).ok);
  assert.ok(!login({ email: "user@example.com", password: original }).ok);
});

test("a code works once and never again", () => {
  const created = freshAccount();
  const code = created.recoveryCodes[0];

  assert.ok(recoverWithCode({ email: "user@example.com", code, newPassword: replacement }).ok);

  const reuse = recoverWithCode({
    email: "user@example.com",
    code,
    newPassword: "yet another long password"
  });
  assert.ok(!reuse.ok);
  assert.equal(remainingRecoveryCodes(created.account.id), recoveryCodeCount - 1);
});

test("the remaining codes still work after one is spent", () => {
  const created = freshAccount();
  recoverWithCode({ email: "user@example.com", code: created.recoveryCodes[0], newPassword: replacement });

  const second = recoverWithCode({
    email: "user@example.com",
    code: created.recoveryCodes[1],
    newPassword: "a third long password here"
  });
  assert.ok(second.ok);
});

test("accepts a code regardless of case and dashes", () => {
  const created = freshAccount();
  const messy = created.recoveryCodes[0].toLowerCase().replace(/-/g, " ");

  assert.ok(recoverWithCode({ email: "user@example.com", code: messy, newPassword: replacement }).ok);
});

test("rejects a wrong code and an unknown email identically", () => {
  freshAccount();

  const wrongCode = recoverWithCode({
    email: "user@example.com", code: "AAAA-BBBB-CCCC", newPassword: replacement
  });
  const unknownEmail = recoverWithCode({
    email: "nobody@example.com", code: "AAAA-BBBB-CCCC", newPassword: replacement
  });

  assert.ok(!wrongCode.ok && !unknownEmail.ok);
  assert.equal(wrongCode.error, unknownEmail.error);
});

test("a failed recovery leaves the original password working", () => {
  freshAccount();

  recoverWithCode({ email: "user@example.com", code: "AAAA-BBBB-CCCC", newPassword: replacement });

  assert.ok(login({ email: "user@example.com", password: original }).ok);
});

test("rejects a new password that is too short", () => {
  const created = freshAccount();

  const result = recoverWithCode({
    email: "user@example.com", code: created.recoveryCodes[0], newPassword: "tiny"
  });

  assert.ok(!result.ok);
  // The code must not be consumed by a request that was never going to succeed.
  assert.equal(remainingRecoveryCodes(created.account.id), recoveryCodeCount);
});

test("recovery revokes every existing session", () => {
  const created = freshAccount();
  const attacker = login({ email: "user@example.com", password: original });
  assert.ok(attacker.ok);

  recoverWithCode({
    email: "user@example.com", code: created.recoveryCodes[0], newPassword: replacement
  });

  assert.equal(accountForToken(attacker.token), null);
  assert.equal(accountForToken(created.token), null);
});

test("codes survive a restart", () => {
  const created = freshAccount("durable@example.com");

  reloadAccountsFromDisk();

  const recovered = recoverWithCode({
    email: "durable@example.com", code: created.recoveryCodes[2], newPassword: replacement
  });
  assert.ok(recovered.ok);
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

test("registration returns codes over the API and recovery works end to end", async () => {
  resetAccounts();
  resetRateLimits();
  const server = await startTestServer();

  try {
    const registered = await (await fetch(`${server.baseUrl}/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "api@example.com", password: original })
    })).json() as any;

    assert.equal(registered.data.recoveryCodes.length, recoveryCodeCount);

    const recovered = await fetch(`${server.baseUrl}/v1/auth/recover`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "api@example.com",
        code: registered.data.recoveryCodes[0],
        newPassword: replacement
      })
    });
    assert.equal(recovered.status, 200);

    const me = await fetch(`${server.baseUrl}/v1/auth/me`, {
      headers: { Authorization: `Bearer ${((await recovered.json()) as any).data.token}` }
    });
    assert.equal(me.status, 200);
  } finally {
    await server.close();
  }
});

test("recovery attempts are throttled", async () => {
  resetAccounts();
  resetRateLimits();
  const server = await startTestServer();

  try {
    await fetch(`${server.baseUrl}/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "brute@example.com", password: original })
    });

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const response = await fetch(`${server.baseUrl}/v1/auth/recover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "brute@example.com", code: "AAAA-BBBB-CCCC", newPassword: replacement })
      });
      statuses.push(response.status);
    }

    assert.ok(statuses.includes(400));
    assert.ok(statuses.includes(429), "guessing codes must be throttled");
    assert.equal(statuses[statuses.length - 1], 429);
  } finally {
    await server.close();
  }
});
