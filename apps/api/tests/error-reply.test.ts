import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { errorReply, internalErrorMessage } from "../src/services/errorReply.js";

// What a failed request is told: a client error in its own words, a failure inside the
// service in one sentence that carries no path, name or stack.

const { createApp } = await import("../src/server.js");

test("a client error keeps its message; a failure inside the service does not", () => {
  assert.deepEqual(errorReply({ status: 400, message: "Unexpected token } in JSON at position 3" }), { status: 400, code: "REQUEST_ERROR", message: "Unexpected token } in JSON at position 3" });
  assert.deepEqual(errorReply({ statusCode: 413, message: "request entity too large" }), { status: 413, code: "REQUEST_ERROR", message: "request entity too large" });
  const inside = errorReply({ message: "ENOENT: no such file or directory, open 'C:\\Users\\sam\\Documents\\tax.xlsx'" });
  assert.equal(inside.status, 500);
  assert.equal(inside.code, "INTERNAL_ERROR");
  assert.equal(inside.message, internalErrorMessage);
  assert.ok(!inside.message.includes("sam"));
  assert.equal(errorReply({ status: 503, message: "upstream" }).message, internalErrorMessage);
  assert.equal(errorReply({ status: 999, message: "odd" }).status, 500, "a code that is no status is a 500");
  assert.equal(errorReply({ status: 400 }).message, "The request could not be read.");
});

test("through the server: a malformed body is explained, in words that are about the request", async () => {
  const server = createApp().listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json" });
    assert.equal(response.status, 400);
    const body = await response.json() as { code: string; message: string };
    assert.equal(body.code, "REQUEST_ERROR");
    assert.match(body.message, /JSON|token/i);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
