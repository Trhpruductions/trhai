import test from "node:test";
import assert from "node:assert/strict";
import { listenHosts, serveOptions } from "../scripts/serve-options.mjs";

// How `npm run start` reads what it is asked for, and where that means
// listening: this PC's two addresses unless something else is named.

test("the port and hostname are read the way next start reads them", () => {
  assert.deepEqual(serveOptions(["-p", "3210"]), { port: 3210, hostname: null });
  // What the desktop shell passes when it starts the app itself.
  assert.deepEqual(serveOptions(["-H", "127.0.0.1", "-p", "3210"]), { port: 3210, hostname: "127.0.0.1" });
  assert.deepEqual(serveOptions(["--port=4100", "--hostname=localhost"]), { port: 4100, hostname: "localhost" });
  assert.deepEqual(serveOptions([], { PORT: "5000" }), { port: 5000, hostname: null });
  assert.deepEqual(serveOptions([]), { port: 3000, hostname: null });
  assert.throws(() => serveOptions(["-p", "web"]), /Not a port/);
  assert.throws(() => serveOptions(["-p", "70000"]), /Not a port/);
});

test("this PC means both of its addresses; any other hostname is taken as given", () => {
  for (const name of [null, "", "localhost", "LOCALHOST", "127.0.0.1", "::1", "[::1]"]) {
    assert.deepEqual(listenHosts(name), ["127.0.0.1", "::1"], String(name));
  }
  assert.deepEqual(listenHosts("0.0.0.0"), ["0.0.0.0"]);
  assert.deepEqual(listenHosts("192.168.1.20"), ["192.168.1.20"]);
});
