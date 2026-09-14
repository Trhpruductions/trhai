import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  anyPersistenceFailing,
  persistenceFailures,
  recordPersistFailure,
  recordPersistSuccess,
  resetPersistenceHealth
} from "../src/services/persistenceHealth.js";

// Whether what the app was told actually reached the disk.
//
// Five stores caught their write errors and recorded nothing: taskStore,
// conversationStore, knowledgeStore, preferences and taskListStore each ended
// in a bare `catch {}`. The catch is right - losing durability must not fail
// the request - but the silence meant the app kept answering normally while
// nothing it was told survived a restart.

test("nothing is failing until something fails", () => {
  resetPersistenceHealth();
  assert.equal(anyPersistenceFailing(), false);
  assert.deepEqual(persistenceFailures(), []);
});

test("a failed write is recorded with its real error", () => {
  resetPersistenceHealth();
  recordPersistFailure("tasks", new Error("EACCES: permission denied"));

  const [failure] = persistenceFailures();
  assert.equal(failure.store, "tasks");
  assert.match(failure.error, /EACCES/, "the cause is the only clue, so it is kept verbatim");
  assert.ok(Date.parse(failure.at) > 0, "and when, so a stale report reads as stale");
  assert.equal(anyPersistenceFailing(), true);
});

test("a later success clears it", () => {
  // The half that keeps this honest. A file locked for a moment by a backup
  // would otherwise be reported forever, and a warning that never clears is one
  // people learn to ignore.
  resetPersistenceHealth();
  recordPersistFailure("tasks", new Error("locked"));
  recordPersistSuccess("tasks");

  assert.equal(anyPersistenceFailing(), false);
  assert.deepEqual(persistenceFailures(), []);
});

test("one store recovering does not hide another still failing", () => {
  resetPersistenceHealth();
  recordPersistFailure("tasks", new Error("disk full"));
  recordPersistFailure("knowledge", new Error("disk full"));
  recordPersistSuccess("tasks");

  const stores = persistenceFailures().map((entry) => entry.store);
  assert.deepEqual(stores, ["knowledge"]);
});

test("repeated failures keep the latest cause, not the first", () => {
  resetPersistenceHealth();
  recordPersistFailure("preferences", new Error("first cause"));
  recordPersistFailure("preferences", new Error("second cause"));

  const failures = persistenceFailures();
  assert.equal(failures.length, 1, "one entry per store, not one per attempt");
  assert.match(failures[0].error, /second cause/);
});

test("a thrown non-Error still reports something usable", () => {
  resetPersistenceHealth();
  recordPersistFailure("conversations", "a bare string was thrown");
  assert.match(persistenceFailures()[0].error, /bare string/);
});

// And that a real store actually reports through it.
//
// The unit tests above prove the record works. This proves it is wired: a
// store whose data directory cannot be written must end up listed, because
// that is the whole point and it is exactly what was missing.

test("a store that cannot write to disk ends up listed", async () => {
  // The unit tests above prove the record works. This proves it is wired: a
  // store whose write genuinely fails must end up listed, because that is the
  // whole point and it is exactly what was missing.
  //
  // The failure is arranged by pointing the store at a path whose parent is a
  // regular file, so creating the directory for it cannot succeed. That is a
  // real I/O failure of the kind this exists to surface - a permission change
  // or a full disk look the same from in here - rather than a stubbed throw.
  const blocker = path.join(mkdtempSync(path.join(tmpdir(), "trhai-persist-")), "blocking-file");
  writeFileSync(blocker, "this is a file, not a directory", "utf8");

  process.env.ASSIST_TASKS_FILE = path.join(blocker, "nested", "task-lists.json");
  resetPersistenceHealth();

  const store = await import(`../src/services/taskListStore.js?persist=${Date.now()}`);
  store.setTaskPersistence(true);

  // Must not throw. Losing durability is bad; failing the request is worse.
  assert.doesNotThrow(() => {
    store.addTask("session-1", { id: "t1", title: "something to keep" });
  });

  const failing = persistenceFailures().map((entry) => entry.store);
  assert.ok(
    failing.includes("task lists"),
    `a failed write should be reported, got ${JSON.stringify(failing)}`
  );

  const reported = persistenceFailures().find((entry) => entry.store === "task lists");
  assert.ok(reported && reported.error.length > 0, "and with the real reason attached");

  delete process.env.ASSIST_TASKS_FILE;
  rmSync(path.dirname(blocker), { recursive: true, force: true });
});
