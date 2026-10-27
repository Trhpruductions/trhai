import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The batch tool that makes keys to give out, run as it is run: a real process,
// a real key file, real output. The keys it writes are then checked by the app's
// own key reader, so "the keys work" is not taken on the tool's word.
//
// The signing key is the test's own, and the tool is told to expect its public
// half in place of the app's - exactly how the app's own tests do it.
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicBase64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
process.env.TRHAI_LICENSE_PUBLIC_KEY = publicBase64;

const { parseLicenseKey } = await import("../src/services/licensing.js");

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "..", "..", "..", "scripts", "licensing", "issue-batch.mjs");
const root = mkdtempSync(path.join(tmpdir(), "trhai-batch-"));
test.after(() => rmSync(root, { recursive: true, force: true }));

let counter = 0;
/** A fresh folder holding the test's private key, as the owner's folder holds theirs. */
function workspace(pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString()) {
  counter += 1;
  const dir = path.join(root, `run-${counter}`);
  mkdirSync(path.join(dir, "keys"), { recursive: true });
  const keyFile = path.join(dir, "keys", "trhai-license-private.pem");
  writeFileSync(keyFile, pem);
  return { dir, keyFile, record: path.join(dir, "keys", "issued-licenses.jsonl"), out: path.join(dir, "keys.csv") };
}

function run(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8", env: { ...process.env, TRHAI_LICENSE_PUBLIC_KEY: publicBase64 } });
}

type Row = { email: string; plan: string; expires: string; id: string; key: string };
function readRows(file: string): Row[] {
  const [header, ...lines] = readFileSync(file, "utf8").split("\r\n").filter(Boolean);
  assert.equal(header, "email,plan,expires,id,key");
  return lines.map((line) => {
    const cells = [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((match) => match[1].replaceAll('""', '"'));
    const [email, plan, expires, id, key] = cells;
    return { email, plan, expires, id, key };
  });
}

function nothingWritten(w: ReturnType<typeof workspace>) {
  assert.equal(existsSync(w.out), false, "no file of keys");
  assert.equal(existsSync(w.record), false, "no record of keys");
}

test("--count makes that many full-access keys that never expire, and the app accepts every one", () => {
  const w = workspace();
  const result = run(w.dir, ["--count", "3", "--key", w.keyFile, "--out", w.out]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Issued 3 pro keys, none of which expire/);

  const rows = readRows(w.out);
  assert.deepEqual(rows.map((row) => row.email), ["user-001@trhai.invalid", "user-002@trhai.invalid", "user-003@trhai.invalid"]);
  assert.equal(new Set(rows.map((row) => row.id)).size, 3, "each key has its own id");
  assert.equal(new Set(rows.map((row) => row.key)).size, 3);
  for (const row of rows) {
    const parsed = parseLicenseKey(row.key);
    assert.ok(parsed.ok, `the app refuses ${row.email}`);
    assert.equal(parsed.payload.plan, "pro");
    assert.equal(parsed.payload.email, row.email);
    assert.equal(parsed.payload.id, row.id);
    assert.equal(parsed.payload.expiresAt, undefined);
    assert.equal(parsed.payload.role, undefined, "a key to give out is never an owner or administrator key");
    assert.equal(row.expires, "never");
  }

  const recorded = readFileSync(w.record, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { key: string; email: string });
  assert.deepEqual(recorded.map((entry) => entry.key), rows.map((row) => row.key), "recorded beside the private key, as issue.mjs does");
});

test("a label, a plan, an end date and seats are carried into every key", () => {
  const w = workspace();
  const result = run(w.dir, ["--count", "2", "--label", "friends", "--plan", "team", "--expires", "2030-01-31", "--seats", "2", "--key", w.keyFile, "--out", w.out]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /each ending 2030-01-31/);
  for (const row of readRows(w.out)) {
    const parsed = parseLicenseKey(row.key);
    assert.ok(parsed.ok);
    assert.match(parsed.payload.email, /^friends-00[12]@trhai\.invalid$/);
    assert.equal(parsed.payload.plan, "team");
    assert.equal(parsed.payload.expiresAt, "2030-01-31T23:59:59.000Z");
    assert.equal(parsed.payload.seats, 2);
    assert.equal(row.expires, "2030-01-31");
  }
});

test("--emails makes one key per address, skipping blanks, comments and repeats, and the app shows who it is for", () => {
  const w = workspace();
  const list = path.join(w.dir, "users.txt");
  writeFileSync(list, ["# friends and testers", "Ann@Example.com", "", "bob@example.com   ", "ann@example.com", "  # not this one", "cy@example.org"].join("\r\n"));
  const result = run(w.dir, ["--emails", list, "--key", w.keyFile, "--out", w.out]);
  assert.equal(result.status, 0, result.stderr);
  const rows = readRows(w.out);
  assert.deepEqual(rows.map((row) => row.email), ["ann@example.com", "bob@example.com", "cy@example.org"], "lower case, once each, in the order given");
  for (const row of rows) {
    const parsed = parseLicenseKey(row.key);
    assert.ok(parsed.ok);
    assert.equal(parsed.payload.email, row.email);
  }
});

test("a line that is not an address stops the whole run before anything is issued", () => {
  const w = workspace();
  const list = path.join(w.dir, "users.txt");
  writeFileSync(list, "good@example.com\nnot an address\nalso-bad\n");
  const result = run(w.dir, ["--emails", list, "--key", w.keyFile, "--out", w.out]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not an address/);
  assert.match(result.stderr, /nothing was issued/);
  nothingWritten(w);

  writeFileSync(list, "# only a comment\n\n");
  assert.equal(run(w.dir, ["--emails", list, "--key", w.keyFile, "--out", w.out]).status, 1, "an empty list issues nothing");
  nothingWritten(w);
});

test("a private key that is not the app's is refused, because every key it made would be refused", () => {
  const other = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const w = workspace(other);
  const result = run(w.dir, ["--count", "2", "--key", w.keyFile, "--out", w.out]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not the key this app was built with/);
  assert.match(result.stderr, /Nothing was issued/);
  nothingWritten(w);

  const missing = run(w.dir, ["--count", "2", "--key", path.join(w.dir, "no-such.pem"), "--out", w.out]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Could not read the private key/);
  assert.match(missing.stderr, /PC that holds it/);
  nothingWritten(w);
});

test("owner and administrator keys are never made in a batch", () => {
  const w = workspace();
  for (const role of ["owner", "admin"]) {
    const result = run(w.dir, ["--count", "1", "--role", role, "--key", w.keyFile, "--out", w.out]);
    assert.equal(result.status, 1, role);
    assert.match(result.stderr, /issue\.mjs --role/);
  }
  nothingWritten(w);
});

test("anything that is not clearly asked for is refused with nothing issued", () => {
  const w = workspace();
  const base = ["--key", w.keyFile, "--out", w.out];
  const list = path.join(w.dir, "users.txt");
  writeFileSync(list, "a@example.com\n");
  const refused: string[][] = [
    [],
    ["--count", "2", "--emails", list],
    ["--count", "0"], ["--count", "501"], ["--count", "2.5"], ["--count", "many"],
    ["--count", "1", "--plan", "platinum"],
    ["--count", "1", "--expires", "next year"],
    ["--count", "1", "--seats", "0"], ["--count", "1", "--seats", "two"],
    ["--count", "1", "--label", "Has Spaces"], ["--count", "1", "--label", "x".repeat(31)],
    ["--emails", path.join(w.dir, "missing.txt")]
  ];
  for (const args of refused) {
    const result = run(w.dir, [...args, ...base]);
    assert.equal(result.status, 1, args.join(" ") || "(no arguments)");
    nothingWritten(w);
  }
});

test("it never overwrites a file of keys, and records nothing when it stops", () => {
  const w = workspace();
  writeFileSync(w.out, "keys someone is still using");
  const result = run(w.dir, ["--count", "1", "--key", w.keyFile, "--out", w.out]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /already exists\. Nothing was issued; choose another --out/);
  assert.equal(readFileSync(w.out, "utf8"), "keys someone is still using");
  assert.equal(existsSync(w.record), false);
});

test("two runs each add to the record, and their keys do not collide", () => {
  const w = workspace();
  assert.equal(run(w.dir, ["--count", "2", "--key", w.keyFile, "--out", w.out]).status, 0);
  assert.equal(run(w.dir, ["--count", "2", "--key", w.keyFile, "--out", path.join(w.dir, "second.csv")]).status, 0);
  const lines = readFileSync(w.record, "utf8").trim().split("\n");
  assert.equal(lines.length, 4);
  assert.equal(new Set(lines.map((line) => (JSON.parse(line) as { id: string }).id)).size, 4);
});

test("the public key the tool checks against is the one the app is built with", () => {
  const config = readFileSync(path.join(here, "..", "src", "services", "licenseConfig.ts"), "utf8");
  const built = /licensePublicKeyBase64\s*=\s*"([A-Za-z0-9+/=]+)"/.exec(config)?.[1];
  const tool = /const appPublicKey = "([A-Za-z0-9+/=]+)"/.exec(readFileSync(script, "utf8"))?.[1];
  assert.ok(built && tool);
  assert.equal(tool, built, "the standalone tool and the app must never drift apart");
});
