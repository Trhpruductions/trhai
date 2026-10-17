// Checks the owner's license signing key against the app, without issuing anything.
//
//   node scripts/licensing/verify.mjs [--key path\to\private.pem] [--license TRHAI-...]
//
// 1. Signs a throwaway message with the private key (default: the one keygen
//    wrote, %USERPROFILE%\.trhai-license\trhai-license-private.pem) and checks
//    it against the public key built into the app
//    (apps/api/src/services/licenseConfig.ts). Run it on a restored backup: if it
//    says the key matches, that backup can issue keys every installed copy accepts.
// 2. With --license, checks a key you sent someone: whether its signature is
//    the app's, and what it says (plan, email, expiry).
//
// Nothing is written and nothing leaves the PC.

import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.join(here, "..", "..", "apps", "api", "src", "services", "licenseConfig.ts");
const config = readFileSync(configFile, "utf8");
const publicBase64 = /licensePublicKeyBase64\s*=\s*"([A-Za-z0-9+/=]+)"/.exec(config)?.[1];
if (!publicBase64) {
  console.error(`No public key found in ${configFile}.`);
  process.exit(1);
}
const publicKey = createPublicKey({ key: Buffer.from(publicBase64, "base64"), type: "spki", format: "der" });
let failed = false;

const keyFile = option("key") ?? path.join(os.homedir(), ".trhai-license", "trhai-license-private.pem");
let privateKey = null;
try {
  privateKey = createPrivateKey(readFileSync(keyFile, "utf8"));
} catch (error) {
  console.log(`Private key: could not read ${keyFile} (${error instanceof Error ? error.message : String(error)}).`);
  failed = !option("license");
}
if (privateKey) {
  const probe = Buffer.from(`trhai-license-check ${Date.now()}`, "utf8");
  const matches = verify(null, probe, publicKey, sign(null, probe, privateKey));
  console.log(matches
    ? `Private key: ${keyFile} matches the public key built into the app. Keys it issues will be accepted.`
    : `Private key: ${keyFile} does NOT match the public key built into the app. Keys it issues would be refused.`);
  if (!matches) failed = true;
}

const license = option("license");
if (license) {
  const body = license.trim().replace(/\s+/g, "");
  const match = /^TRHAI-([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(body);
  if (!match) {
    console.log("License: not a TRH AI key (it should start TRHAI- and have one dot).");
    failed = true;
  } else {
    let payload = null;
    try { payload = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8")); } catch { /* reported below */ }
    const signed = payload ? Buffer.from(JSON.stringify(payload), "utf8") : null;
    const genuine = Boolean(signed) && signed.toString("base64url") === match[1]
      && verify(null, signed, publicKey, Buffer.from(match[2], "base64url"));
    if (!genuine) {
      console.log("License: the signature is not the app's. This key would be refused.");
      failed = true;
    } else {
      const expires = payload.expiresAt ? `expires ${payload.expiresAt.slice(0, 10)}` : "does not expire";
      const expired = payload.expiresAt && Date.parse(payload.expiresAt) <= Date.now();
      console.log(`License: genuine. ${payload.plan} plan for ${payload.email}, issued ${payload.issuedAt.slice(0, 10)}, ${expires}${expired ? " (already expired)" : ""}, id ${payload.id}.`);
    }
  }
}

process.exit(failed ? 1 : 0);
