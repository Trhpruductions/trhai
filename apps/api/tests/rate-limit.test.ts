import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { once } from "node:events";

const dataDir = mkdtempSync(path.join(tmpdir(), "ascend-ratelimit-"));
process.env.ASSIST_ACCOUNTS_FILE = path.join(dataDir, "accounts.json");
process.env.ASSIST_MEMORY_FILE = path.join(dataDir, "memory.json");

const {
  checkRateLimit,
  clearRateLimit,
  clientKey,
  recordFailure,
  resetRateLimits,
  trackedKeyCount,
  loginIpRule
} = await import("../src/services/rateLimit.js");
const { resetAccounts } = await import("../src/services/accounts.js");
const { createApp } = await import("../src/server.js");

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const rule = { limit: 3, windowMs: 1000 };

test("allows attempts up to the limit then blocks", () => {
  resetRateLimits();

  for (let attempt = 0; attempt < rule.limit; attempt += 1) {
    assert.equal(checkRateLimit("k", rule, 1000).allowed, true);
    recordFailure("k", rule, 1000);
  }

  const blocked = checkRateLimit("k", rule, 1000);
  assert.equal(blocked.allowed, false);
  assert.ok(!blocked.allowed && blocked.retryAfterSeconds >= 1);
});

test("the window slides, so attempts expire", () => {
  resetRateLimits();
  for (let attempt = 0; attempt < rule.limit; attempt += 1) recordFailure("slide", rule, 1000);

  assert.equal(checkRateLimit("slide", rule, 1500).allowed, false);
  // Past the window, the old attempts no longer count.
  assert.equal(checkRateLimit("slide", rule, 2200).allowed, true);
});

test("checking does not consume an attempt", () => {
  resetRateLimits();
  recordFailure("peek", rule, 1000);

  for (let i = 0; i < 20; i += 1) checkRateLimit("peek", rule, 1000);

  assert.equal(checkRateLimit("peek", rule, 1000).allowed, true);
});

test("success clears the counter", () => {
  resetRateLimits();
  for (let attempt = 0; attempt < rule.limit; attempt += 1) recordFailure("clear", rule, 1000);
  assert.equal(checkRateLimit("clear", rule, 1000).allowed, false);

  clearRateLimit("clear");
  assert.equal(checkRateLimit("clear", rule, 1000).allowed, true);
});

test("keys are independent", () => {
  resetRateLimits();
  for (let attempt = 0; attempt < rule.limit; attempt += 1) recordFailure("a", rule, 1000);

  assert.equal(checkRateLimit("a", rule, 1000).allowed, false);
  assert.equal(checkRateLimit("b", rule, 1000).allowed, true);
});

test("reports a sane retry-after", () => {
  resetRateLimits();
  const wide = { limit: 1, windowMs: 60_000 };
  recordFailure("retry", wide, 1000);

  const blocked = checkRateLimit("retry", wide, 1000);
  assert.ok(!blocked.allowed);
  assert.ok(!blocked.allowed && blocked.retryAfterSeconds <= 60 && blocked.retryAfterSeconds >= 59);
});

test("normalizes an unknown client address", () => {
  assert.equal(clientKey("203.0.113.5"), "203.0.113.5");
  assert.equal(clientKey(undefined), "unknown-client");
  assert.equal(clientKey("   "), "unknown-client");
});

test("tracked keys do not grow without bound", () => {
  resetRateLimits();
  for (let i = 0; i < 10_050; i += 1) recordFailure(`key-${i}`, loginIpRule, 1000);

  assert.ok(trackedKeyCount() <= 10_000, `expected eviction, got ${trackedKeyCount()}`);
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

async function attemptLogin(baseUrl: string, email: string, password: string) {
  const response = await fetch(`${baseUrl}/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  return { status: response.status, retryAfter: response.headers.get("retry-after") };
}

test("repeated bad logins are eventually refused with 429", async () => {
  resetRateLimits();
  resetAccounts();
  const server = await startTestServer();

  try {
    await fetch(`${server.baseUrl}/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "target@example.com", password: "correct horse battery" })
    });

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      statuses.push((await attemptLogin(server.baseUrl, "target@example.com", "wrong guess here")).status);
    }

    assert.ok(statuses.includes(401), "early attempts should be rejected as unauthorized");
    assert.ok(statuses.includes(429), "later attempts should be rate limited");
    // Guessing must stop being merely "wrong" and start being refused.
    assert.equal(statuses[statuses.length - 1], 429);
  } finally {
    await server.close();
  }
});

test("a 429 carries Retry-After", async () => {
  resetRateLimits();
  resetAccounts();
  const server = await startTestServer();

  try {
    let last = await attemptLogin(server.baseUrl, "nobody@example.com", "guessing away");
    for (let attempt = 0; attempt < 10 && last.status !== 429; attempt += 1) {
      last = await attemptLogin(server.baseUrl, "nobody@example.com", "guessing away");
    }

    assert.equal(last.status, 429);
    assert.ok(last.retryAfter, "Retry-After header should be set");
    assert.ok(Number(last.retryAfter) > 0);
  } finally {
    await server.close();
  }
});

test("throttling does not reveal whether an account exists", async () => {
  resetRateLimits();
  resetAccounts();
  const server = await startTestServer();

  try {
    await fetch(`${server.baseUrl}/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "real@example.com", password: "correct horse battery" })
    });

    const known: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      known.push((await attemptLogin(server.baseUrl, "real@example.com", "wrong password!!")).status);
    }

    resetRateLimits();

    const unknown: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      unknown.push((await attemptLogin(server.baseUrl, "ghost@example.com", "wrong password!!")).status);
    }

    // Identical status sequences for a real and a non-existent account.
    assert.deepEqual(known, unknown);
  } finally {
    await server.close();
  }
});

test("a correct password still works after some failures", async () => {
  resetRateLimits();
  resetAccounts();
  const server = await startTestServer();

  try {
    await fetch(`${server.baseUrl}/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "mistype@example.com", password: "correct horse battery" })
    });

    // A user mistyping twice must not be locked out.
    await attemptLogin(server.baseUrl, "mistype@example.com", "wrong once here");
    await attemptLogin(server.baseUrl, "mistype@example.com", "wrong twice here");

    const good = await attemptLogin(server.baseUrl, "mistype@example.com", "correct horse battery");
    assert.equal(good.status, 200);
  } finally {
    await server.close();
  }
});
