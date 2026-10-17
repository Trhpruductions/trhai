import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";

// DNS rebinding: a site points its own name at 127.0.0.1 and its page's
// requests reach the API as its own origin, past CORS. The Host header still
// carries the site's name, and the API refuses it before anything else runs.

const { createApp } = await import("../src/server.js");

function ask(port: number, host: string, method = "GET", path = "/health"): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { Host: host, Origin: `http://${host}` } }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("a request addressed to another name is refused, preflight included; this PC's own names are answered", async () => {
  const server = createApp().listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  try {
    const rebound = await ask(port, `evil.example:${port}`);
    assert.equal(rebound.status, 421);
    assert.match(rebound.body, /addressed to this PC/);
    assert.equal((await ask(port, `evil.example:${port}`, "OPTIONS", "/v1/assist")).status, 421);
    assert.equal((await ask(port, `evil.example:${port}`, "GET", "/v1/assist/memory?sessionId=s")).status, 421);
    assert.equal((await ask(port, `127.0.0.1:${port}`)).status, 200);
    assert.equal((await ask(port, `localhost:${port}`)).status, 200);
  } finally {
    server.close();
  }
});
