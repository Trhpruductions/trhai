import test from "node:test";
import assert from "node:assert/strict";
import { idleWords, reachWords, visibleAddresses, windowWords } from "../src/lib/systemMonitor.js";

// The System and Network workspaces' wording.

test("a loaded model says the window it was given", () => {
  // The engine fits each model's window to the graphics card, so it is the
  // figure that differs from one model to the next: measured on an 8 GB card.
  assert.equal(windowWords({ name: "qwen3-8b", sizeBytes: 5_200_000_000, windowTokens: 9216 }), "9,216-token window");
  assert.equal(windowWords({ name: "qwen2.5-coder-7b", sizeBytes: 4_700_000_000, windowTokens: 31232 }), "31,232-token window");
  assert.equal(windowWords({ name: "a", sizeBytes: 100, windowTokens: null }), null, "not said until the engine says it");
  assert.equal(windowWords({ name: "a", sizeBytes: 100, windowTokens: 0 }), null);
});

test("when a model will be let go reads as how long it may sit idle, or that it is kept", () => {
  assert.equal(idleWords(300), "let go after 5 idle minutes");
  assert.equal(idleWords(60), "let go after 60 idle seconds");
  assert.equal(idleWords(90), "let go after 2 idle minutes");
  assert.equal(idleWords(120), "let go after 2 idle minutes");
  assert.equal(idleWords(0), "kept loaded");
  assert.equal(idleWords(null), "kept loaded");
});

test("who can reach the service follows from what it is bound to", () => {
  const thisPc = [{ address: "127.0.0.1", family: "IPv4" }, { address: "::1", family: "IPv6" }];
  assert.deepEqual(reachWords({ port: 4000, addresses: thisPc, fromNetwork: false, keyRequired: false }),
    { text: "Listening on 127.0.0.1 and ::1, port 4000: only this PC can reach it.", fromNetwork: false });
  assert.deepEqual(reachWords({ port: 4000, addresses: [thisPc[0]], fromNetwork: false, keyRequired: false }),
    { text: "Listening on 127.0.0.1, port 4000: only this PC can reach it.", fromNetwork: false });
  const every = [{ address: "::", family: "IPv6" }];
  assert.deepEqual(reachWords({ port: 4000, addresses: every, fromNetwork: true, keyRequired: true }), {
    text: "Listening on every address, port 4000: other devices on your network can reach it, unless a firewall blocks the port, and only with the access key.",
    fromNetwork: true
  });
  assert.deepEqual(reachWords({ port: 4000, addresses: every, fromNetwork: true, keyRequired: false }),
    { text: "Listening on every address, port 4000: other devices on your network can reach it, unless a firewall blocks the port.", fromNetwork: true });
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
