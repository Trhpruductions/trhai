import test from "node:test";
import assert from "node:assert/strict";
import {
  authHeaderFor, authRequest, authStorageKey, chooseGuest, clearGuest, clearStoredAuth, guestStorageKey,
  isGuestThisSession, looksLikeEmail, passwordStrength, readStoredAuth, writeStoredAuth, type StoredAuth
} from "../src/lib/auth.js";

function memoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key)
  } as unknown as Storage;
}

const account = { id: "u1", email: "ada@example.com", displayName: "Ada", createdAt: "2026-10-01T00:00:00.000Z" };
const future = new Date(Date.now() + 86_400_000).toISOString();
const auth = (remember: boolean): StoredAuth => ({ token: "tok-123", account, expiresAt: future, remember });

test("'keep me signed in' keeps the session across launches, and without it only for this one", () => {
  const local = memoryStorage();
  const session = memoryStorage();

  writeStoredAuth(local, session, auth(true));
  assert.ok(local.getItem(authStorageKey), "kept for the next launch");
  assert.equal(session.getItem(authStorageKey), null, "never in both");
  assert.equal(readStoredAuth(local, session)?.remember, true);

  writeStoredAuth(local, session, auth(false));
  assert.equal(local.getItem(authStorageKey), null, "the long-lived copy is gone");
  assert.ok(session.getItem(authStorageKey));
  assert.deepEqual(readStoredAuth(local, session)?.account, account);
  assert.equal(readStoredAuth(local, session)?.remember, false);
});

test("an expired session is forgotten rather than sent", () => {
  const local = memoryStorage();
  const session = memoryStorage();
  writeStoredAuth(local, session, { ...auth(true), expiresAt: new Date(Date.now() - 1000).toISOString() });

  assert.equal(readStoredAuth(local, session), null);
  assert.equal(local.getItem(authStorageKey), null, "and cleared, so no request carries it");
});

test("anything malformed in storage reads as signed out, never as a crash", () => {
  const local = memoryStorage();
  local.setItem(authStorageKey, "{not json");
  assert.equal(readStoredAuth(local, memoryStorage()), null);
  local.setItem(authStorageKey, JSON.stringify({ token: "x", expiresAt: future, account: { id: 1 } }));
  assert.equal(readStoredAuth(local, memoryStorage()), null);
  assert.equal(readStoredAuth(undefined, undefined), null);

  const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => {} };
  assert.equal(readStoredAuth(throwing as unknown as Storage, throwing as unknown as Storage), null);
  assert.doesNotThrow(() => writeStoredAuth(throwing as unknown as Storage, throwing as unknown as Storage, auth(true)));
});

test("signed in, requests carry the token; signed out, they carry nothing", () => {
  assert.deepEqual(authHeaderFor(auth(true)), { Authorization: "Bearer tok-123" });
  assert.deepEqual(authHeaderFor(null), {});

  const local = memoryStorage();
  const session = memoryStorage();
  writeStoredAuth(local, session, auth(true));
  clearStoredAuth(local, session);
  assert.deepEqual(authHeaderFor(readStoredAuth(local, session)), {});
});

test("'continue without an account' lasts this session, and signing in ends it", () => {
  const local = memoryStorage();
  const session = memoryStorage();
  assert.equal(isGuestThisSession(session), false);
  chooseGuest(session);
  assert.equal(isGuestThisSession(session), true);
  writeStoredAuth(local, session, auth(true));
  assert.equal(session.getItem(guestStorageKey), null);
  chooseGuest(session);
  clearGuest(session);
  assert.equal(isGuestThisSession(session), false);
});

test("the strength meter never calls a password strong below the API's minimum", () => {
  assert.equal(passwordStrength("").score, 0);
  const short = passwordStrength("Tr0ub4dor!");
  assert.equal(short.meetsMinimum, true, "ten characters is the floor");
  assert.equal(passwordStrength("abc").meetsMinimum, false);
  assert.match(passwordStrength("abc").label, /Too short/);
  assert.ok(passwordStrength("abcdefghi").score <= 1);
  assert.equal(passwordStrength("correct horse battery staple 9!").score, 4);
  assert.ok(passwordStrength("password12345").score < passwordStrength("Lantern-Orbit-42").score, "an obvious pattern costs");
});

test("an email is checked the way the API checks it", () => {
  assert.equal(looksLikeEmail("ada@example.com"), true);
  assert.equal(looksLikeEmail("  ada@example.com  "), true);
  assert.equal(looksLikeEmail("ada@example"), false);
  assert.equal(looksLikeEmail("ada example.com"), false);
});

function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

test("signing in returns the session the API issued", async () => {
  const { fetcher, calls } = fakeFetch(200, { data: { account, token: "tok-9", expiresAt: future } });
  const result = await authRequest("http://api", "login", { email: "ada@example.com", password: "secret-secret" }, fetcher);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.token, "tok-9");
  assert.equal(calls[0].url, "http://api/v1/auth/login");
  assert.equal(calls[0].init?.method, "POST");
});

test("making an account brings back its recovery codes", async () => {
  const codes = ["AAAA-BBBB-CCCC", "DDDD-EEEE-FFFF"];
  const { fetcher } = fakeFetch(201, { data: { account, token: "tok-1", expiresAt: future, recoveryCodes: codes } });
  const result = await authRequest("http://api", "register", { email: "ada@example.com", password: "long-enough-1" }, fetcher);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.recoveryCodes, codes);
});

test("a refusal says what the API said, and a lockout says how long to wait", async () => {
  const wrong = await authRequest("http://api", "login", {}, fakeFetch(401, { message: "Email or password is incorrect" }).fetcher);
  assert.deepEqual(wrong, { ok: false, message: "Email or password is incorrect." });

  const locked = await authRequest("http://api", "login", {}, fakeFetch(429, { message: "Too many attempts.", retryAfterSeconds: 42 }).fetcher);
  assert.equal(locked.ok, false);
  if (!locked.ok) {
    assert.equal(locked.retryAfterSeconds, 42);
    assert.match(locked.message, /Try again in 42 seconds/);
  }

  const down = await authRequest("http://api", "login", {}, (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch);
  assert.equal(down.ok, false);
  if (!down.ok) {
    assert.equal(down.unreachable, true);
    assert.match(down.message, /not answering/);
  }
});
