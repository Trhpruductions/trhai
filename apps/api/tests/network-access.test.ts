import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";

// Who can reach TRH AI's service: this PC alone, unless other devices are let
// in - and then only with the access key. And the signed-in namespace, which
// a made-up session id must never reach.

const dataDir = mkdtempSync(path.join(tmpdir(), "ascend-network-access-"));
process.env.ASSIST_MEMORY_FILE = path.join(dataDir, "memory.json");
process.env.ASSIST_CONVERSATION_FILE = path.join(dataDir, "conversations.json");
process.env.ASSIST_ACCOUNTS_FILE = path.join(dataDir, "accounts.json");
process.env.ASSIST_KNOWLEDGE_FILE = path.join(dataDir, "knowledge.json");
process.env.ASCEND_PREFERENCES_FILE = path.join(dataDir, "preferences.json");
process.env.ASCEND_NETWORK_KEY_FILE = path.join(dataDir, "network-access.json");
// /v1/network asks Ollama what it holds; nothing answers here, and quickly.
process.env.TRHAI_ENGINE_URL = "http://127.0.0.1:1";

const { createApp } = await import("../src/server.js");
const { accessKey, accessKeyHeader, guardOtherDevices, isLoopback, listenOn, listenPlan } = await import("../src/services/networkAccess.js");
const { protectedJsonLooksEncrypted } = await import("../src/services/protectedJson.js");
const { accountForToken, registerAccount, resetAccounts } = await import("../src/services/accounts.js");
const { resetRateLimits } = await import("../src/services/rateLimit.js");

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

/** This PC's address on its network - what another device would connect to - or null on a machine with none. */
function networkAddress(): string | null {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal && !entry.address.startsWith("169.254.")) return entry.address;
    }
  }
  return null;
}

const outside = networkAddress();
const noNetwork = outside ? false : "this machine has no network address to connect from";

/** Whether a TCP connection to host:port is accepted. */
function connects(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    socket.setTimeout(5000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function closeAll(listeners: Array<{ server: Server }>): Promise<void[]> {
  return Promise.all(listeners.map(({ server }) => new Promise<void>((resolve) => server.close(() => resolve()))));
}

test("the service listens on this PC's own two addresses unless other devices are asked for", () => {
  assert.deepEqual(listenPlan({}), { hosts: ["127.0.0.1", "::1"], otherDevices: false });
  assert.deepEqual(listenPlan({ ASCEND_NETWORK_ACCESS: "off" }), { hosts: ["127.0.0.1", "::1"], otherDevices: false });
  for (const on of ["on", "1", "true", "YES"]) {
    assert.deepEqual(listenPlan({ ASCEND_NETWORK_ACCESS: on }), { hosts: ["::"], otherDevices: true }, on);
  }
});

test("this PC is told from every other device by the connection's own address", () => {
  for (const address of ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"]) {
    assert.equal(isLoopback(address), true, address);
  }
  for (const address of ["192.168.1.20", "::ffff:192.168.1.20", "100.101.102.103", "10.0.0.1", "fe80::1", "", undefined, null]) {
    assert.equal(isLoopback(address), false, String(address));
  }
});

test("listening on this PC's addresses answers on both, on one port", async () => {
  const { listeners, skipped } = await listenOn(() => createServer((_request, response) => response.end("ok")), 0, ["127.0.0.1", "::1"]);
  try {
    const port = listeners[0].address.port;
    assert.ok(listeners.every(({ address }) => address.port === port), "one port for both addresses");
    const ipv6 = skipped.length === 0;
    assert.deepEqual(listeners.map(({ address }) => address.address), ipv6 ? ["127.0.0.1", "::1"] : ["127.0.0.1"]);
    assert.equal(await connects("127.0.0.1", port), true);
    if (ipv6) assert.equal(await connects("::1", port), true);
  } finally {
    await closeAll(listeners);
  }
});

test("listening on this PC's addresses refuses the address another device would use", { skip: noNetwork }, async () => {
  // The control: listening on every address, as the service used to, that
  // same address connects - so a refusal below is the binding, not a network
  // path that never worked.
  const open = await listenOn(() => createServer((_request, response) => response.end("ok")), 0, ["::"]);
  try {
    assert.equal(await connects(outside as string, open.listeners[0].address.port), true, "the control connects");
  } finally {
    await closeAll(open.listeners);
  }

  const { listeners } = await listenOn(() => createServer((_request, response) => response.end("ok")), 0, ["127.0.0.1", "::1"]);
  try {
    const port = listeners[0].address.port;
    assert.equal(await connects(outside as string, port), false, `${outside}:${port} must refuse`);
  } finally {
    await closeAll(listeners);
  }
});

test("a port held by another server on either address fails the start, rather than leaving half a service", async () => {
  const blocker = createServer();
  blocker.listen(0, "127.0.0.1");
  await once(blocker, "listening");
  const taken = (blocker.address() as AddressInfo).port;
  try {
    await assert.rejects(listenOn(() => createServer(), taken, ["127.0.0.1", "::1"]), { code: "EADDRINUSE" });
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }

  // Taken on ::1 alone: what opened on 127.0.0.1 is closed again, so
  // "localhost" is never answered by someone else's server.
  const ipv6Blocker = createServer();
  try {
    ipv6Blocker.listen(0, "::1");
    await once(ipv6Blocker, "listening");
  } catch {
    return; // No IPv6 here; the first half has made the point.
  }
  const ipv6Taken = (ipv6Blocker.address() as AddressInfo).port;
  try {
    await assert.rejects(listenOn(() => createServer(), ipv6Taken, ["127.0.0.1", "::1"]), { code: "EADDRINUSE" });
    assert.equal(await connects("127.0.0.1", ipv6Taken), false, "the IPv4 half was closed again");
  } finally {
    await new Promise<void>((resolve) => ipv6Blocker.close(() => resolve()));
  }
});

test("with other devices let in, one without the key is turned away and one with it is not", { skip: noNetwork }, async () => {
  const app = createApp({ otherDevices: true });
  const { listeners } = await listenOn(() => createServer(app), 0, ["::"]);
  const port = listeners[0].address.port;
  const key = accessKey();
  try {
    // Connecting to this PC's network address arrives from that address, as
    // a request from another device does.
    const away = await fetch(`http://${outside}:${port}/health`);
    assert.equal(away.status, 401);
    assert.match(((await away.json()) as { message: string }).message, new RegExp(accessKeyHeader));

    const wrong = await fetch(`http://${outside}:${port}/health`, { headers: { [accessKeyHeader]: "not-the-key" } });
    assert.equal(wrong.status, 401);

    const keyed = await fetch(`http://${outside}:${port}/v1/network`, { headers: { [accessKeyHeader]: key } });
    assert.equal(keyed.status, 200);
    const fromAway = ((await keyed.json()) as { data: { access: { otherDevices: boolean; key: string | null } } }).data.access;
    assert.equal(fromAway.otherDevices, true);
    assert.equal(fromAway.key, null, "the key is never handed to another device");

    const local = await fetch(`http://127.0.0.1:${port}/v1/network`);
    assert.equal(local.status, 200, "this PC needs no key");
    assert.equal(((await local.json()) as { data: { access: { key: string | null } } }).data.access.key, key,
      "this PC is shown the key, to type into another device");
  } finally {
    await closeAll(listeners);
  }
});

test("the guard reads where a connection came from, never a header claiming it", () => {
  const key = "k".repeat(32);
  const outcome = (guard: ReturnType<typeof guardOtherDevices>, remoteAddress: string, headers: Record<string, string> = {}) => {
    let status = 0;
    let through = false;
    const request = { socket: { remoteAddress }, get: (name: string) => headers[name.toLowerCase()] };
    const response = {
      status(code: number) {
        status = code;
        return this;
      },
      json() {
        return this;
      }
    };
    guard(request as never, response as never, () => {
      through = true;
    });
    return through ? "through" : status;
  };
  const guard = guardOtherDevices(key);
  assert.equal(outcome(guard, "192.168.1.20", { "x-forwarded-for": "127.0.0.1" }), 401);
  assert.equal(outcome(guard, "192.168.1.20", { "x-trhai-key": key }), "through");
  assert.equal(outcome(guard, "::ffff:127.0.0.1"), "through");
  assert.equal(outcome(guard, "::1"), "through");
  // A key that could not be read lets no other device in, whatever it sends.
  assert.equal(outcome(guardOtherDevices(null), "192.168.1.20", { "x-trhai-key": "" }), 401);
});

test("the access key is made once, kept encrypted, and the same each time it is asked for", () => {
  const first = accessKey();
  assert.ok(first.length >= 32);
  assert.equal(accessKey(), first);
  const stored = readFileSync(process.env.ASCEND_NETWORK_KEY_FILE as string, "utf8");
  assert.equal(protectedJsonLooksEncrypted(stored), true);
  assert.equal(stored.includes(first), false, "the key itself is not readable in the file");
});

test("with other devices kept out, no key is asked for and none is shown", async () => {
  const server = createApp().listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/network`);
    const { access } = ((await response.json()) as { data: { access: unknown } }).data;
    assert.deepEqual(access, { otherDevices: false, header: accessKeyHeader, key: null });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a made-up session id cannot name a signed-in account's own space", async () => {
  resetAccounts();
  resetRateLimits();
  const created = registerAccount({ email: "owner@example.com", password: "correct horse battery" });
  assert.ok(created.ok);
  const account = accountForToken(created.token);
  assert.ok(account);
  const server = createApp().listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const signedIn = { Authorization: `Bearer ${created.token}` };
  try {
    const saved = await fetch(`${base}/v1/assist/memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...signedIn },
      body: JSON.stringify({ sessionId: "browser-1", text: "the spare key is in the blue notebook" })
    });
    assert.equal(saved.status, 201);

    // The control: signed out, an ordinary session id is answered.
    assert.equal((await fetch(`${base}/v1/assist/memory?sessionId=browser-2`)).status, 200);

    // Signed out, the account's own key is not a session id anyone may use.
    for (const sessionId of [`user:${account.id}`, `USER:${account.id}`, `  user:${account.id}`]) {
      const memory = await fetch(`${base}/v1/assist/memory?sessionId=${encodeURIComponent(sessionId)}`);
      assert.equal(memory.status, 400, sessionId);
      assert.match(((await memory.json()) as { message: string }).message, /sessionId is required/);
      const conversations = await fetch(`${base}/v1/conversations?sessionId=${encodeURIComponent(sessionId)}`);
      assert.equal(conversations.status, 400, sessionId);
    }

    // The owner, signed in, still reads it.
    const own = await fetch(`${base}/v1/assist/memory?sessionId=browser-1`, { headers: signedIn });
    const { memories } = ((await own.json()) as { data: { memories: Array<{ body: string }> } }).data;
    assert.equal(memories.length, 1);
    assert.match(memories[0].body, /blue notebook/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
