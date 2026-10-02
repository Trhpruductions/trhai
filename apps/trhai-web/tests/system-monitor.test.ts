import test from "node:test";
import assert from "node:assert/strict";
import { placement, reachWords, unloadsWhen, visibleAddresses } from "../src/lib/systemMonitor.js";

// The System and Network workspaces' wording.

test("a loaded model says where it sits", () => {
  assert.equal(placement({ name: "a", sizeBytes: 100, vramBytes: 100, expiresAt: null }), "All on the graphics card");
  assert.equal(placement({ name: "a", sizeBytes: 100, vramBytes: 0, expiresAt: null }), "In memory - none on the graphics card");
  assert.equal(placement({ name: "a", sizeBytes: 100, vramBytes: 62, expiresAt: null }), "62% on the graphics card, the rest in memory");
});

test("when a model will be let go reads as how long, or that it is kept", () => {
  const now = new Date("2026-10-02T10:00:00Z");
  assert.equal(unloadsWhen("2026-10-02T10:04:00Z", now), "lets go in 4 min unless used");
  assert.equal(unloadsWhen("2026-10-02T12:00:00Z", now), "lets go in 2 h unless used");
  assert.equal(unloadsWhen("2318-01-01T00:00:00Z", now), "kept loaded", "Ollama's date for keep it loaded");
  assert.equal(unloadsWhen("2026-10-02T10:00:10Z", now), "lets go any moment");
  assert.equal(unloadsWhen(null, now), "being let go");
});

test("who can reach the service follows from what it is bound to", () => {
  assert.deepEqual(reachWords({ address: "::", port: 4000, family: "IPv6", fromNetwork: true }),
    { text: "Listening on every address, port 4000: other devices on your network can reach it, unless a firewall blocks the port.", fromNetwork: true });
  assert.deepEqual(reachWords({ address: "127.0.0.1", port: 4000, family: "IPv4", fromNetwork: false }),
    { text: "Listening on 127.0.0.1, port 4000: only this PC can reach it.", fromNetwork: false });
  assert.equal(reachWords(null).fromNetwork, null);
});

test("loopback and link-local addresses, of both kinds, are left out unless asked for", () => {
  const list = [
    { address: "127.0.0.1", family: "IPv4", internal: true },
    { address: "fe80::1", family: "IPv6", internal: false },
    { address: "169.254.83.107", family: "IPv4", internal: false },
    { address: "192.168.1.20", family: "IPv4", internal: false }
  ];
  assert.deepEqual(visibleAddresses(list, false).map((entry) => entry.address), ["192.168.1.20"]);
  assert.equal(visibleAddresses(list, true).length, 4);
});
