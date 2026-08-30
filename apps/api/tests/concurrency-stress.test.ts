import test from "node:test";
import assert from "node:assert/strict";
import { AddressInfo } from "node:net";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// A store of its own, so a stress run cannot trample the developer's real data
// or another suite's fixtures.
const stressRoot = mkdtempSync(path.join(tmpdir(), "ascend-stress-"));
process.env.ASCEND_WORKSPACE = stressRoot;
process.env.ASSIST_MEMORY_FILE = path.join(stressRoot, "assist-memory.json");

const { createApp } = await import("../src/server.js");

// Concurrency and abuse, against the real routes (E14-S2).
//
// The stores write synchronously with a temp-file-and-rename, so two writes
// cannot interleave inside one process. That is an argument, not evidence —
// and the failure it would hide is the worst one this app has: silently
// losing something the user asked it to remember. Express serves requests
// concurrently, so a read-modify-write split across an await is exactly where
// an update would go missing.
//
// These fire real HTTP at a real server and count what survives. A lost write
// shows up as a missing row, not as an error, which is why asserting on the
// response alone would not catch it.

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

/** Enough to interleave, small enough that the suite stays quick. */
const burst = 60;

/**
 * A session nobody has used before, minted per run.
 *
 * The task store persists to disk, so a fixed session id accumulates across
 * runs — this suite reported "60 writes were accepted but 180 survived" on its
 * third run, which was three runs of its own leftovers rather than anything
 * the app did wrong. A unique key per run makes the count mean what it says.
 */
const runKey = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

test("every concurrent write survives, none are lost", async () => {
  const { baseUrl, close } = await startTestServer();
  const sessionId = `stress-tasks-${runKey}`;

  try {
    const writes = Array.from({ length: burst }, (_, index) =>
      fetch(`${baseUrl}/v1/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, title: `task ${index}` })
      }));

    const responses = await Promise.all(writes);
    const accepted = responses.filter((response) => response.status === 201).length;
    assert.equal(accepted, burst, `only ${accepted} of ${burst} writes were accepted`);

    // The part that matters. Every accepted write must still be there: an
    // update lost to a read-modify-write race returns 201 and then quietly
    // is not in the list.
    const listed = await fetch(`${baseUrl}/v1/tasks?sessionId=${sessionId}`);
    const body = await listed.json() as { data: { tasks: Array<{ title: string }> } };
    const titles = new Set(body.data.tasks.map((task) => task.title));

    assert.equal(
      body.data.tasks.length, burst,
      `${burst} writes were accepted but ${body.data.tasks.length} survived`
    );
    for (let index = 0; index < burst; index += 1) {
      assert.ok(titles.has(`task ${index}`), `"task ${index}" was accepted and then lost`);
    }
  } finally {
    await close();
  }
});

test("ids stay unique under a concurrent burst", async () => {
  const { baseUrl, close } = await startTestServer();
  const sessionId = `stress-ids-${runKey}`;

  try {
    await Promise.all(Array.from({ length: burst }, (_, index) =>
      fetch(`${baseUrl}/v1/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, title: `t${index}` })
      })));

    const listed = await fetch(`${baseUrl}/v1/tasks?sessionId=${sessionId}`);
    const body = await listed.json() as { data: { tasks: Array<{ id: string }> } };
    const ids = body.data.tasks.map((task) => task.id);

    // Ids are minted from Date.now() plus a random suffix. Within one
    // millisecond the timestamp is identical for the whole burst, so the
    // suffix is the only thing keeping them apart — worth asserting rather
    // than assuming, because a duplicate id means one task shadows another.
    assert.equal(new Set(ids).size, ids.length, "two tasks were given the same id");
  } finally {
    await close();
  }
});

test("concurrent writes across different sessions never leak into each other", async () => {
  const { baseUrl, close } = await startTestServer();

  try {
    const sessions = ["a", "b", "c"].map((name) => `stress-${name}-${runKey}`);
    await Promise.all(sessions.flatMap((sessionId) =>
      Array.from({ length: 20 }, (_, index) =>
        fetch(`${baseUrl}/v1/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, title: `${sessionId}-${index}` })
        }))));

    // Session isolation is a privacy property, not just a correctness one:
    // sessions are how this app keeps one person's notes out of another's.
    for (const sessionId of sessions) {
      const listed = await fetch(`${baseUrl}/v1/tasks?sessionId=${sessionId}`);
      const body = await listed.json() as { data: { tasks: Array<{ title: string }> } };
      assert.equal(body.data.tasks.length, 20, `${sessionId} did not keep its own 20`);
      for (const task of body.data.tasks) {
        assert.ok(
          task.title.startsWith(sessionId),
          `${sessionId} is holding "${task.title}", which belongs to another session`
        );
      }
    }
  } finally {
    await close();
  }
});

test("a burst of malformed requests is refused without taking the server down", async () => {
  const { baseUrl, close } = await startTestServer();

  try {
    const junk = [
      JSON.stringify({}),
      JSON.stringify({ sessionId: "" }),
      JSON.stringify({ sessionId: "x".repeat(5000), title: "too long a session" }),
      JSON.stringify({ sessionId: "ok", title: "" }),
      JSON.stringify({ sessionId: "ok", title: 12345 }),
      JSON.stringify({ sessionId: null, title: null }),
      "not json at all",
      ""
    ];

    const responses = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        fetch(`${baseUrl}/v1/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: junk[index % junk.length]
        }).catch(() => null)));

    // Every one must be answered, and none may be a 5xx: a bad request is the
    // client's mistake, and reporting it as a server fault would send whoever
    // reads the logs looking in the wrong place.
    for (const response of responses) {
      assert.ok(response, "a request went unanswered");
      assert.ok(response.status < 500, `malformed input produced ${response.status}`);
    }

    // And the server is still serving afterwards, which is the actual claim.
    const alive = await fetch(`${baseUrl}/v1/capabilities`);
    assert.equal(alive.status, 200, "the server stopped answering after malformed input");
  } finally {
    await close();
  }
});
