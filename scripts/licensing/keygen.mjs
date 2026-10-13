// Makes the key pair that signs TRH AI license keys. Run once, by the owner.
//
//   node scripts/licensing/keygen.mjs [folder]
//
// The PRIVATE key is written to <folder>/trhai-license-private.pem (default
// folder: %USERPROFILE%\.trhai-license) and must never enter the repo, the
// installer or any PC but the owner's: whoever has it can issue licenses. The
// PUBLIC key is printed; it goes in apps/api/src/services/licensePublicKey.ts
// so every installed copy can check a key offline. Nothing else is needed:
// no account with anyone, no server, no payment provider key in the app.

import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const folder = process.argv[2] ?? path.join(os.homedir(), ".trhai-license");
const privateFile = path.join(folder, "trhai-license-private.pem");
if (existsSync(privateFile)) {
  console.error(`Refusing to overwrite ${privateFile}. Move it away first if you really mean to replace the signing key (every issued license would stop working).`);
  process.exit(1);
}
mkdirSync(folder, { recursive: true });
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
writeFileSync(privateFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
const publicBase64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
writeFileSync(path.join(folder, "trhai-license-public.txt"), publicBase64 + "\n");
console.log(`private key: ${privateFile}  (keep this; never commit it)`);
console.log(`public key : ${publicBase64}`);
