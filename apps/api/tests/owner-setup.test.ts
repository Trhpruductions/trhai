import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The one way an owner is made: from the machine itself.
const dir = mkdtempSync(path.join(tmpdir(), "trhai-owner-"));
process.env.ASSIST_ACCOUNTS_FILE = path.join(dir, "accounts.json");
process.env.ASSIST_AUDIT_FILE = path.join(dir, "audit.json");
process.env.TRHAI_LICENSE_FILE = path.join(dir, "license.json");
process.env.TRHAI_TRIAL_MARKER = path.join(dir, "elsewhere", "trial-started");
delete process.env.TRHAI_AUTHORITY;

const accounts = await import("../src/services/accounts.js");
const audit = await import("../src/services/audit.js");
const { makeOwner } = await import("../src/services/ownerSetup.js");

test.after(() => {
  delete process.env.TRHAI_AUTHORITY;
  rmSync(dir, { recursive: true, force: true });
});

const password = "correct horse battery";

function fresh(): void {
  accounts.resetAccounts();
  audit.resetAuditForTests();
}

test("on an ordinary install it refuses, and says the owner is made with a signed key instead", () => {
  fresh();
  accounts.registerAccount({ email: "me@example.com", password });
  delete process.env.TRHAI_AUTHORITY;
  const result = makeOwner({ email: "me@example.com" });
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /signed key/);
  assert.equal(accounts.ownerAccount(), null, "nothing was written");
  assert.equal(audit.listAudit().total, 0);
});

test("it makes an existing account the owner, whatever the case of the address, and records who did it", () => {
  fresh();
  process.env.TRHAI_AUTHORITY = "on";
  accounts.registerAccount({ email: "me@example.com", password });
  const result = makeOwner({ email: "  Me@Example.COM " });
  assert.deepEqual(result, { ok: true, email: "me@example.com", transferred: false, previousOwner: null });
  assert.equal(accounts.ownerAccount()?.email, "me@example.com");
  const [entry] = audit.listAudit().entries;
  assert.equal(entry.action, "role.owner_assigned");
  assert.deepEqual(entry.actor, { kind: "system", name: "host setup script" });
  assert.equal(entry.target?.email, "me@example.com");
  assert.equal(audit.verifyAuditChain().ok, true);
});

test("it does not invent an account: an address nobody has registered is refused", () => {
  fresh();
  process.env.TRHAI_AUTHORITY = "on";
  accounts.registerAccount({ email: "someone@example.com", password });
  for (const email of ["nobody@example.com", "", undefined, 42, "someone"]) {
    const result = makeOwner({ email });
    assert.equal(result.ok, false, String(email));
    assert.match((result as { error: string }).error, /no account for|Register it first/);
  }
  assert.equal(accounts.ownerAccount(), null);
  assert.equal(audit.listAudit().total, 0);
});

test("a part of an address is not an address: only the exact one becomes the owner", () => {
  fresh();
  process.env.TRHAI_AUTHORITY = "on";
  accounts.registerAccount({ email: "ann@example.com", password });
  accounts.registerAccount({ email: "joann@example.com", password });
  assert.equal(makeOwner({ email: "ann@example.com" }).ok, true);
  assert.equal(accounts.ownerAccount()?.email, "ann@example.com", "not joann@, which also contains ann@");
});

test("there is one owner: a second needs ownership handed over, and the old owner stays on as an administrator", () => {
  fresh();
  process.env.TRHAI_AUTHORITY = "on";
  accounts.registerAccount({ email: "first@example.com", password });
  accounts.registerAccount({ email: "second@example.com", password });
  assert.equal(makeOwner({ email: "first@example.com" }).ok, true);

  const refused = makeOwner({ email: "second@example.com" });
  assert.equal(refused.ok, false);
  assert.match((refused as { error: string }).error, /already an owner/);
  assert.equal(accounts.ownerAccount()?.email, "first@example.com");

  const handed = makeOwner({ email: "second@example.com", transfer: true });
  assert.deepEqual(handed, { ok: true, email: "second@example.com", transferred: true, previousOwner: "first@example.com" });
  assert.equal(accounts.ownerAccount()?.email, "second@example.com");
  const first = accounts.listAccounts({ query: "first@" }).accounts[0];
  assert.equal(first.storedRole, "admin");
  const [newest] = audit.listAudit().entries;
  assert.equal(newest.action, "role.owner_transferred");
  assert.match(newest.detail, /first@example.com/);
});

test("running it again for the same owner changes nothing and is not called a transfer", () => {
  fresh();
  process.env.TRHAI_AUTHORITY = "on";
  accounts.registerAccount({ email: "me@example.com", password });
  makeOwner({ email: "me@example.com" });
  const again = makeOwner({ email: "me@example.com" });
  assert.deepEqual(again, { ok: true, email: "me@example.com", transferred: false, previousOwner: null });
  assert.equal(accounts.listAccounts().accounts.filter((account) => account.storedRole === "owner").length, 1);
});

test("a suspended account cannot be made the owner", () => {
  fresh();
  process.env.TRHAI_AUTHORITY = "on";
  const made = accounts.registerAccount({ email: "me@example.com", password });
  assert.ok(made.ok);
  accounts.setAccountStatus(made.account.id, "suspended");
  const result = makeOwner({ email: "me@example.com" });
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /suspended/);
  assert.equal(accounts.ownerAccount(), null);
});
