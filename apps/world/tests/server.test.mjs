import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createServer } from "../server.mjs";

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

async function withServers(upstreamHandler, run) {
  const upstream = http.createServer(upstreamHandler);
  const upstreamPort = await listen(upstream);
  const world = createServer({ upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(world);
  try { await run(`http://127.0.0.1:${port}`); } finally { world.close(); upstream.close(); }
}

test("it serves the page", async () => {
  await withServers((_req, res) => res.end("{}"), async (base) => {
    const response = await fetch(`${base}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);
    assert.match(await response.text(), /TRH World/);
  });
});

test("it passes /api/world to TRH AI's /v1/world, and only that", async () => {
  const seen = [];
  await withServers((req, res) => { seen.push(req.url); res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ data: { working: false } })); }, async (base) => {
    const answer = await fetch(`${base}/api/world`);
    assert.equal(answer.status, 200);
    assert.deepEqual(await answer.json(), { data: { working: false } });
    assert.deepEqual(seen, ["/v1/world"]);

    for (const other of ["/api/assist", "/api/v1/memory", "/v1/world"]) {
      const refused = await fetch(`${base}${other}`);
      assert.equal(refused.status, 404, other);
    }
    assert.deepEqual(seen, ["/v1/world"], "nothing else reached TRH AI");
  });
});

test("when TRH AI is not running it says so with a 502, not a hang", async () => {
  const world = createServer({ upstream: "http://127.0.0.1:1" });
  const port = await listen(world);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/world`);
    assert.equal(response.status, 502);
    assert.equal((await response.json()).code, "TRHAI_NOT_RUNNING");
  } finally { world.close(); }
});

test("it only reads: anything but GET is refused", async () => {
  await withServers((_req, res) => res.end("{}"), async (base) => {
    for (const method of ["POST", "PUT", "DELETE"]) {
      const response = await fetch(`${base}/api/world`, { method });
      assert.equal(response.status, 405, method);
    }
  });
});

test("it cannot be walked out of its public folder", async () => {
  await withServers((_req, res) => res.end("{}"), async (base) => {
    for (const evil of ["/..%2Fserver.mjs", "/%2e%2e/package.json", "/..%5Cserver.mjs"]) {
      const response = await fetch(`${base}${evil}`);
      assert.equal(response.status, 404, evil);
      assert.doesNotMatch(await response.text(), /createServer|ascend/);
    }
  });
});
