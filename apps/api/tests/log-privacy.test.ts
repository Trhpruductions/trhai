import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { accessLogFormat, pathOnly } from "../src/services/accessLog.js";
import { commandForLog } from "../src/services/commandRunner.js";

// What the service writes to its log file. The file is appended to and nobody tends it,
// so it must never hold what a person typed or chose: a guest's session id (the key to
// their data), the words of a web search, a page's address, a file's path, a command line.

const { createApp } = await import("../src/server.js");

test("the route is logged without its query", () => {
  assert.equal(pathOnly({ url: "/v1/web/search?q=my+secret+question" }), "/v1/web/search");
  assert.equal(pathOnly({ url: "/v1/assist/memory?sessionId=abc-123" }), "/v1/assist/memory");
  assert.equal(pathOnly({ url: "/x?a=1?b=2" }), "/x");
  assert.equal(pathOnly({ url: "/health" }), "/health");
  assert.equal(pathOnly({ url: "/" }), "/");
  assert.equal(pathOnly({ url: undefined }), "");
  // Behind a mounted router `url` is cut short; the whole address is `originalUrl`.
  assert.equal(pathOnly({ url: "/search?q=x", originalUrl: "/v1/web/search?q=x" }), "/v1/web/search");
});

test("the access log format names the route and the outcome, and no token in it could carry the query", () => {
  assert.equal(accessLogFormat, ":method :path :status :res[content-length] - :response-time ms");
  assert.doesNotMatch(accessLogFormat, /:url|:referrer|:req\[|:remote-addr/);
});

test("a request with a session id, a search and a path in its address leaves none of them in the log", async () => {
  const server = createApp().listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  try {
    const reply = await fetch(`http://127.0.0.1:${port}/health?sessionId=guest-secret-id-9&q=private+words&path=C%3A%5CUsers%5Csam%5Ctax.xlsx`);
    await reply.arrayBuffer();
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    process.stdout.write = original;
    server.closeAllConnections();
    server.close();
  }
  const log = written.join("");
  assert.match(log, /GET \/health 200/, "the route and what became of it are there");
  for (const secret of ["guest-secret-id-9", "private+words", "private", "tax.xlsx", "sessionId"]) {
    assert.ok(!log.includes(secret), `the log must not hold ${secret}`);
  }
});

test("a command is logged by the program that was started and the length of the line, never the line", () => {
  assert.equal(commandForLog("git status"), "git (10 characters)");
  assert.equal(commandForLog("  npm  test  "), "npm (13 characters)");
  assert.equal(commandForLog('"C:\\Program Files\\Tool\\tool.exe" --token=abc123secret'), "tool (53 characters)");
  assert.equal(commandForLog("C:/tools/Deploy.CMD now"), "Deploy (23 characters)");
  const curl = "curl -H 'Authorization: Bearer sk-live-123' https://example.com";
  assert.equal(commandForLog(curl), `curl (${curl.length} characters)`);
  assert.equal(commandForLog(""), "(command) (0 characters)");
  assert.equal(commandForLog("   "), "(command) (3 characters)");
  for (const line of ["curl -u admin:hunter2 https://x.example", "mysql -pS3cretPass db", 'powershell -Command "Set-Item secret"']) {
    assert.doesNotMatch(commandForLog(line), /hunter2|S3cretPass|secret|admin|https/i);
  }
});
