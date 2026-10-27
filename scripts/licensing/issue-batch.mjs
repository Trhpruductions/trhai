// Issues a batch of full-access TRH AI license keys, to give out. Owner only; needs the private key.
//
//   node issue-batch.mjs --count 20 [--label friends]
//   node issue-batch.mjs --emails users.txt
//
// Options for both:
//   --plan pro            personal, pro or team. Every plan includes everything today. Default: pro.
//   --expires 2027-10-13  the keys stop working on that date. Leave it out for keys that never expire.
//   --seats 1             shown in the app, not enforced (enforcing it would need a server).
//   --out keys.csv        where the keys are written. Default: trhai-keys-<date and time>.csv here. Never overwrites.
//   --key path\to.pem     the private key. Default: %USERPROFILE%\.trhai-license\trhai-license-private.pem
//
// --count N makes N keys, each "licensed to" label-001@trhai.invalid, label-002@... (.invalid can never be a real
// address). --emails reads one address per line (blank lines and # comments are skipped) and makes one key each, so
// the app shows who it was given to.
//
// Before anything is issued the private key is checked against the public key built into the app: a key from any
// other pair would be refused by every installed copy. Nothing is written unless every key can be made. Each key is
// also recorded in issued-licenses.jsonl beside the private key, as issue.mjs does.
//
// Owner and administrator keys are NOT made here, on purpose: they are one at a time, with issue.mjs --role.
//
// A key is a password: whoever holds it can use TRH AI on their PC. It cannot be taken back from a PC once given
// (nothing here is online), so give each person their own, and use --expires for anything meant to end.
//
// Standalone: needs only Node, so this one file can be copied to the PC that holds the private key.

import { createPrivateKey, createPublicKey, randomUUID, sign } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** The public half of the key every installed copy checks against (apps/api/src/services/licenseConfig.ts). */
const appPublicKey = "MCowBQYDK2VwAyEAJm8FFhwq7P50zHJ+RJjFIcdu9iX0zyJsAECduST5tUs=";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

if (args.includes("--role")) fail("Owner and administrator keys are not made in a batch. Make each one with issue.mjs --role owner|admin.");

const countText = option("count");
const emailsFile = option("emails");
if ((countText === undefined) === (emailsFile === undefined)) fail("Give exactly one of --count N or --emails file.");

const plan = option("plan") ?? "pro";
if (!["personal", "pro", "team"].includes(plan)) fail("--plan must be personal, pro or team");
const expires = option("expires");
if (expires !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(expires)) fail("--expires must be YYYY-MM-DD");
const seatsText = option("seats");
const seats = seatsText === undefined ? undefined : Number(seatsText);
if (seats !== undefined && !(Number.isInteger(seats) && seats > 0)) fail("--seats must be a whole number above zero");

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
let emails;
if (emailsFile !== undefined) {
  let text;
  try {
    text = readFileSync(emailsFile, "utf8");
  } catch (error) {
    fail(`Could not read ${emailsFile}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  const bad = lines.filter((line) => !emailPattern.test(line));
  if (bad.length > 0) fail(`These lines are not email addresses, so nothing was issued: ${bad.slice(0, 5).join(", ")}${bad.length > 5 ? ", ..." : ""}`);
  emails = [...new Set(lines.map((line) => line.toLowerCase()))];
  if (emails.length === 0) fail(`${emailsFile} has no addresses in it.`);
} else {
  const count = Number(countText);
  if (!(Number.isInteger(count) && count >= 1 && count <= 500)) fail("--count must be a whole number from 1 to 500");
  const label = option("label") ?? "user";
  if (!/^[a-z0-9-]{1,30}$/.test(label)) fail("--label may use lower-case letters, digits and dashes, up to 30 of them");
  emails = Array.from({ length: count }, (_, index) => `${label}-${String(index + 1).padStart(3, "0")}@trhai.invalid`);
}

const keyFile = option("key") ?? path.join(os.homedir(), ".trhai-license", "trhai-license-private.pem");
let privateKey;
try {
  privateKey = createPrivateKey(readFileSync(keyFile, "utf8"));
} catch (error) {
  fail(`Could not read the private key at ${keyFile} (${error instanceof Error ? error.message : String(error)}).\n`
    + "Run this on the PC that holds it, or point --key at a restored copy.");
}

const expectedPublicKey = process.env.TRHAI_LICENSE_PUBLIC_KEY?.trim() || appPublicKey;
const madePublicKey = createPublicKey(privateKey).export({ type: "spki", format: "der" }).toString("base64");
if (madePublicKey !== expectedPublicKey) {
  fail(`${keyFile} is not the key this app was built with, so every key it made would be refused. Nothing was issued.`);
}

const out = option("out") ?? `trhai-keys-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}.csv`;
if (existsSync(out)) fail(`${out} already exists. Nothing was issued; choose another --out.`);

const issuedAt = new Date().toISOString();
const rows = emails.map((email) => {
  const payload = {
    v: 1,
    id: randomUUID().replace(/-/g, "").slice(0, 16),
    plan,
    email,
    issuedAt,
    ...(expires ? { expiresAt: new Date(`${expires}T23:59:59Z`).toISOString() } : {}),
    ...(seats ? { seats } : {})
  };
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  const key = `TRHAI-${bytes.toString("base64url")}.${sign(null, bytes, privateKey).toString("base64url")}`;
  return { payload, key };
});

const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
const csv = ["email,plan,expires,id,key", ...rows.map(({ payload, key }) =>
  [payload.email, payload.plan, payload.expiresAt?.slice(0, 10) ?? "never", payload.id, key].map(quote).join(","))].join("\r\n") + "\r\n";
try {
  writeFileSync(out, csv, { encoding: "utf8", flag: "wx" });
} catch (error) {
  fail(`Could not write ${out}: ${error instanceof Error ? error.message : String(error)}. Nothing was issued.`);
}

const record = path.join(path.dirname(keyFile), "issued-licenses.jsonl");
try {
  appendFileSync(record, rows.map(({ payload, key }) => JSON.stringify({ ...payload, key })).join("\n") + "\n");
} catch (error) {
  console.error(`WARNING: the keys are in ${out}, but they could not be recorded in ${record}: ${error instanceof Error ? error.message : String(error)}`);
}

console.log(`Issued ${rows.length} ${plan} key${rows.length === 1 ? "" : "s"}${expires ? `, each ending ${expires}` : ", none of which expire"}.`);
console.log(`Keys:   ${path.resolve(out)}`);
console.log(`Record: ${record}`);
console.log("Give each person their own key; they paste it under Settings, Plan and billing. A key cannot be taken back once given.");
