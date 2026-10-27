// Makes one account the owner of a copy of TRH AI that holds its own accounts
// (TRHAI_AUTHORITY=on). Run it on the machine that runs the service, with the
// same environment as the service, so it reads the same accounts and the same
// data key:
//
//   npx tsx scripts/accounts/make-owner.ts --email you@example.com
//   npx tsx scripts/accounts/make-owner.ts --email new@example.com --transfer
//
// The account must already exist (register it in the app first). There is one
// owner: --transfer hands ownership to another account and makes the old owner
// an administrator in the same step. Nothing is printed that is secret, and the
// change is written to the audit log.

import { makeOwner } from "../../apps/api/src/services/ownerSetup.js";

const args = process.argv.slice(2);
const at = args.indexOf("--email");
const email = at >= 0 ? args[at + 1] : undefined;

if (!email) {
  console.error("--email is required");
  process.exit(1);
}

const result = makeOwner({ email, transfer: args.includes("--transfer") });
if (!result.ok) {
  console.error(result.error);
  process.exit(1);
}
console.log(result.transferred
  ? `${result.email} is now the owner. ${result.previousOwner} is an administrator.`
  : `${result.email} is now the owner.`);
