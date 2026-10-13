// Issues a TRH AI license key. Owner only; needs the private key from keygen.
//
//   node scripts/licensing/issue.mjs --email someone@example.com --plan pro [--expires 2027-10-13] [--seats 1] [--key path\to\private.pem]
//
// Prints the key, which is what the buyer is sent. Each run also appends a
// line to issued-licenses.jsonl beside the private key, so the owner has a
// record of what was issued to whom without any server.

import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const email = option("email");
const plan = option("plan") ?? "personal";
const expires = option("expires");
const seats = option("seats");
const keyFile = option("key") ?? path.join(os.homedir(), ".trhai-license", "trhai-license-private.pem");

if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error("--email is required");
  process.exit(1);
}
if (!["personal", "pro", "team"].includes(plan)) {
  console.error("--plan must be personal, pro or team");
  process.exit(1);
}
if (expires && !/^\d{4}-\d{2}-\d{2}$/.test(expires)) {
  console.error("--expires must be YYYY-MM-DD");
  process.exit(1);
}

const payload = {
  v: 1,
  id: randomUUID().replace(/-/g, "").slice(0, 16),
  plan,
  email: email.trim().toLowerCase(),
  issuedAt: new Date().toISOString(),
  ...(expires ? { expiresAt: new Date(`${expires}T23:59:59Z`).toISOString() } : {}),
  ...(seats ? { seats: Number(seats) } : {})
};
const bytes = Buffer.from(JSON.stringify(payload), "utf8");
const privateKey = createPrivateKey(readFileSync(keyFile, "utf8"));
const signature = sign(null, bytes, privateKey);
const key = `TRHAI-${bytes.toString("base64url")}.${signature.toString("base64url")}`;
appendFileSync(path.join(path.dirname(keyFile), "issued-licenses.jsonl"), JSON.stringify({ ...payload, key }) + "\n");
console.log(key);
