import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The record of who changed who may do what. Paths and the size limit are read
// when the module loads, so they are set before the import.
const dir = mkdtempSync(path.join(tmpdir(), "trhai-audit-"));
process.env.ASSIST_AUDIT_FILE = path.join(dir, "audit.json");
process.env.ASSIST_AUDIT_MAX_ENTRIES = "5";

const { auditEntriesForTests, listAudit, recordAudit, reloadAuditFromDisk, resetAuditForTests, verifyAuditChain } =
  await import("../src/services/audit.js");

test.after(() => {
  rmSync(dir, { recursive: true, force: true });
});

const actor = { kind: "account", id: "a1", email: "owner@example.com", role: "owner" } as const;
const target = { id: "t1", email: "user@example.com" };

function add(count: number): void {
  for (let index = 0; index < count; index += 1) {
    recordAudit({ actor, action: "account.suspended", target, detail: `entry ${index + 1}` });
  }
}

test("each entry carries the hash of the one before it, and the chain checks out", () => {
  resetAuditForTests();
  add(4);
  const entries = auditEntriesForTests();
  assert.equal(entries.length, 4);
  assert.equal(entries[0].prevHash, "0".repeat(64), "the first follows the starting value");
  for (let index = 1; index < entries.length; index += 1) assert.equal(entries[index].prevHash, entries[index - 1].hash);
  assert.deepEqual(verifyAuditChain(), { ok: true, count: 4 });
});

test("changing an entry, or taking one out, is noticed at the first entry that no longer follows", () => {
  resetAuditForTests();
  add(4);
  const entries = auditEntriesForTests();

  const original = entries[1].detail;
  entries[1].detail = "nothing happened here";
  assert.deepEqual(verifyAuditChain(), { ok: false, brokenAtSeq: 2 }, "an edited entry");
  entries[1].detail = original;
  assert.equal(verifyAuditChain().ok, true);

  const [removed] = entries.splice(2, 1);
  assert.deepEqual(verifyAuditChain(), { ok: false, brokenAtSeq: 4 }, "an entry taken out breaks the one after it");
  entries.splice(2, 0, removed);
  assert.equal(verifyAuditChain().ok, true);

  const who = entries[0].actor;
  entries[0].actor = { kind: "system", name: "someone else" };
  assert.equal(verifyAuditChain().ok, false, "so does a changed actor");
  entries[0].actor = who;
  assert.equal(verifyAuditChain().ok, true);
});

test("the record survives a restart and still checks out", () => {
  resetAuditForTests();
  add(3);
  reloadAuditFromDisk();
  assert.equal(listAudit().total, 3);
  assert.deepEqual(verifyAuditChain(), { ok: true, count: 3 });
  recordAudit({ actor: { kind: "system", name: "setup" }, action: "role.owner_assigned", target });
  assert.deepEqual(verifyAuditChain(), { ok: true, count: 4 }, "and goes on from where it left off");
});

test("it lists newest first, a page at a time", () => {
  resetAuditForTests();
  add(5);
  const page = listAudit({ limit: 2 });
  assert.deepEqual(page.entries.map((entry) => entry.seq), [5, 4]);
  assert.deepEqual(listAudit({ limit: 2, before: 4 }).entries.map((entry) => entry.seq), [3, 2]);
  assert.equal(listAudit({ limit: 0 }).entries.length, 1, "a limit below one is one");
  assert.equal(listAudit({ before: 1 }).entries.length, 0);
});

test("past its size limit it drops the oldest entries, and the rest still check out", () => {
  resetAuditForTests();
  add(8);
  const entries = auditEntriesForTests();
  assert.equal(entries.length, 5);
  assert.deepEqual(entries.map((entry) => entry.seq), [4, 5, 6, 7, 8]);
  assert.deepEqual(verifyAuditChain(), { ok: true, count: 5 }, "the dropped entries are folded into the starting hash");
  reloadAuditFromDisk();
  assert.deepEqual(verifyAuditChain(), { ok: true, count: 5 }, "and that survives a restart");
  recordAudit({ actor, action: "account.reactivated", target });
  assert.equal(auditEntriesForTests().at(-1)?.seq, 9, "numbering carries on");
});

test("a long description is cut short, and the entry still checks out", () => {
  resetAuditForTests();
  const entry = recordAudit({ actor, action: "billing.event", detail: "x".repeat(1000) });
  assert.equal(entry.detail.length, 200);
  assert.equal(entry.target, null);
  assert.equal(verifyAuditChain().ok, true);
});
