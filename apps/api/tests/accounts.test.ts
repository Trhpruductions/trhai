import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { once } from "node:events";

// Paths are read at module load, so they must be set before importing.
const dataDir = mkdtempSync(path.join(tmpdir(), "ascend-accounts-"));
const accountsFile = path.join(dataDir, "accounts.json");
process.env.ASSIST_ACCOUNTS_FILE = accountsFile;
process.env.ASSIST_MEMORY_FILE = path.join(dataDir, "memory.json");

const {
  accountForToken,
  bearerToken,
  login,
  logout,
  minPasswordLength,
  registerAccount,
  reloadAccountsFromDisk,
  resetAccounts
} = await import("../src/services/accounts.js");
const { createApp } = await import("../src/server.js");
const { resetRateLimits } = await import("../src/services/rateLimit.js");

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

test("registers an account and issues a token", () => {
  resetAccounts();
  const result = registerAccount({ email: "Ada@Example.com", password: "correct horse battery" });

  assert.ok(result.ok);
  assert.equal(result.account.email, "ada@example.com", "email should be normalized");
  assert.ok(result.token.length >= 32);
});

test("rejects a weak password and an invalid email", () => {
  resetAccounts();

  const short = registerAccount({ email: "a@b.co", password: "short" });
  assert.ok(!short.ok);
  assert.match(short.error, new RegExp(String(minPasswordLength)));

  const bad = registerAccount({ email: "not-an-email", password: "correct horse battery" });
  assert.ok(!bad.ok);
});

test("refuses a duplicate email regardless of case", () => {
  resetAccounts();
  registerAccount({ email: "dup@example.com", password: "correct horse battery" });
  const again = registerAccount({ email: "DUP@example.com", password: "correct horse battery" });

  assert.ok(!again.ok);
  assert.match(again.error, /already exists/i);
});

test("logs in with the right password and rejects the wrong one", () => {
  resetAccounts();
  registerAccount({ email: "user@example.com", password: "correct horse battery" });

  assert.ok(login({ email: "user@example.com", password: "correct horse battery" }).ok);
  assert.ok(!login({ email: "user@example.com", password: "wrong password here" }).ok);
});

test("does not reveal whether an email is registered", () => {
  resetAccounts();
  registerAccount({ email: "known@example.com", password: "correct horse battery" });

  const wrongPassword = login({ email: "known@example.com", password: "nope nope nope" });
  const unknownEmail = login({ email: "stranger@example.com", password: "nope nope nope" });

  assert.ok(!wrongPassword.ok && !unknownEmail.ok);
  assert.equal(wrongPassword.error, unknownEmail.error);
});

test("never stores the password in plaintext", () => {
  resetAccounts();
  const secret = "unmistakable-password-value";
  registerAccount({ email: "hash@example.com", password: secret });

  const onDisk = readFileSync(accountsFile, "utf8");
  assert.ok(!onDisk.includes(secret), "password must not appear on disk");
  assert.match(onDisk, /"salt"/);
  assert.match(onDisk, /"hash"/);
});

test("resolves a token to its account and rejects an unknown one", () => {
  resetAccounts();
  const created = registerAccount({ email: "token@example.com", password: "correct horse battery" });
  assert.ok(created.ok);

  assert.equal(accountForToken(created.token)?.email, "token@example.com");
  assert.equal(accountForToken("not-a-real-token"), null);
  assert.equal(accountForToken(undefined), null);
});

test("logout revokes the token immediately", () => {
  resetAccounts();
  const created = registerAccount({ email: "bye@example.com", password: "correct horse battery" });
  assert.ok(created.ok);

  assert.equal(logout(created.token), true);
  assert.equal(accountForToken(created.token), null);
});

test("accounts and sessions survive a restart", () => {
  resetAccounts();
  const created = registerAccount({ email: "durable@example.com", password: "correct horse battery" });
  assert.ok(created.ok);

  reloadAccountsFromDisk();

  assert.equal(accountForToken(created.token)?.email, "durable@example.com");
  assert.ok(login({ email: "durable@example.com", password: "correct horse battery" }).ok);
});

test("parses bearer tokens and ignores malformed headers", () => {
  assert.equal(bearerToken("Bearer abc123"), "abc123");
  assert.equal(bearerToken("bearer abc123"), "abc123");
  assert.equal(bearerToken("Basic abc123"), null);
  assert.equal(bearerToken(undefined), null);
  assert.equal(bearerToken(""), null);
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

async function post(baseUrl: string, route: string, body: unknown, token?: string) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() as any };
}

test("memory follows the account, not the browser session", async () => {
  resetAccounts();
  resetRateLimits();
  const server = await startTestServer();

  try {
    const registered = await post(server.baseUrl, "/v1/auth/register", {
      email: "owner@example.com",
      password: "correct horse battery"
    });
    assert.equal(registered.status, 201);
    const token = registered.body.data.token;

    // Teach it from "browser A" while signed in.
    await post(server.baseUrl, "/v1/assist", {
      mode: "general",
      message: "Remember that we standardized on Postgres.",
      sessionId: "browser-a"
    }, token);

    // Ask from "browser B" — a different anonymous session, same account.
    const asked = await post(server.baseUrl, "/v1/assist", {
      mode: "general",
      message: "Which database should the new service use?",
      sessionId: "browser-b"
    }, token);

    assert.equal(asked.body.data.usedMemoryEntries, 1);
    assert.match(asked.body.data.assistantMessage, /Postgres/i);
  } finally {
    await server.close();
  }
});

test("one account cannot read another account's memory", async () => {
  resetAccounts();
  resetRateLimits();
  const server = await startTestServer();

  try {
    const alice = (await post(server.baseUrl, "/v1/auth/register", {
      email: "alice@example.com", password: "correct horse battery"
    })).body.data.token;
    const bob = (await post(server.baseUrl, "/v1/auth/register", {
      email: "bob@example.com", password: "correct horse battery"
    })).body.data.token;

    await post(server.baseUrl, "/v1/assist", {
      mode: "general", message: "Remember that the vault code is alpha.", sessionId: "s"
    }, alice);

    const bobAsks = await post(server.baseUrl, "/v1/assist", {
      mode: "general", message: "What is the vault code?", sessionId: "s"
    }, bob);

    assert.equal(bobAsks.body.data.usedMemoryEntries, 0);
    assert.doesNotMatch(bobAsks.body.data.assistantMessage, /alpha/i);
  } finally {
    await server.close();
  }
});

test("signing in does not expose memory saved anonymously under the same session id", async () => {
  resetAccounts();
  resetRateLimits();
  const server = await startTestServer();

  try {
    // Anonymous memory under a session id.
    await post(server.baseUrl, "/v1/assist", {
      mode: "general", message: "Remember that the anon secret is bravo.", sessionId: "shared-id"
    });

    const token = (await post(server.baseUrl, "/v1/auth/register", {
      email: "fresh@example.com", password: "correct horse battery"
    })).body.data.token;

    const signedIn = await post(server.baseUrl, "/v1/assist", {
      mode: "general", message: "What is the anon secret?", sessionId: "shared-id"
    }, token);

    // The `user:` prefix keeps the namespaces apart.
    assert.equal(signedIn.body.data.usedMemoryEntries, 0);
    assert.doesNotMatch(signedIn.body.data.assistantMessage, /bravo/i);
  } finally {
    await server.close();
  }
});

test("auth endpoints report the signed-in account and reject bad credentials", async () => {
  resetAccounts();
  resetRateLimits();
  const server = await startTestServer();

  try {
    const registered = await post(server.baseUrl, "/v1/auth/register", {
      email: "me@example.com", password: "correct horse battery", displayName: "Me"
    });
    const token = registered.body.data.token;

    const me = await fetch(`${server.baseUrl}/v1/auth/me`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(me.status, 200);
    assert.equal((await me.json() as any).data.account.displayName, "Me");

    const anon = await fetch(`${server.baseUrl}/v1/auth/me`);
    assert.equal(anon.status, 401);

    const badLogin = await post(server.baseUrl, "/v1/auth/login", {
      email: "me@example.com", password: "definitely wrong"
    });
    assert.equal(badLogin.status, 401);

    const goodLogin = await post(server.baseUrl, "/v1/auth/login", {
      email: "me@example.com", password: "correct horse battery"
    });
    assert.equal(goodLogin.status, 200);
  } finally {
    await server.close();
  }
});

test("a revoked token stops working", async () => {
  resetAccounts();
  resetRateLimits();
  const server = await startTestServer();

  try {
    const token = (await post(server.baseUrl, "/v1/auth/register", {
      email: "revoke@example.com", password: "correct horse battery"
    })).body.data.token;

    await post(server.baseUrl, "/v1/auth/logout", {}, token);

    const me = await fetch(`${server.baseUrl}/v1/auth/me`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(me.status, 401);
  } finally {
    await server.close();
  }
});
