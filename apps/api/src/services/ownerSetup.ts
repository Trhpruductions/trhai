import { authorityMode } from "./access.js";
import { assignOwner, listAccounts, ownerAccount } from "./accounts.js";
import { recordAudit } from "./audit.js";

// Making an account the owner of a copy that holds its own accounts.
//
// The owner is the one role nobody can be given by clicking: it is set from the
// machine itself, by someone with shell access to it and to its data key - the
// controlled process an owner's authority needs, because anything reachable over
// the network would be something an attacker could reach too. The script
// (scripts/accounts/make-owner.ts) is the only caller.
//
// The account must already exist, made the ordinary way, and be one the person
// running this has confirmed belongs to the person it is for: nothing here
// invents an account or attaches the role to an address nobody has used.

export type OwnerSetupResult =
  | { ok: true; email: string; transferred: boolean; previousOwner: string | null }
  | { ok: false; error: string };

export function makeOwner(input: { email: unknown; transfer?: boolean }): OwnerSetupResult {
  if (!authorityMode()) {
    return {
      ok: false,
      error: "This copy does not hold its own accounts (TRHAI_AUTHORITY is not on), so it would not believe a stored role. "
        + "On an ordinary install the owner is made with a signed key: scripts/licensing/issue.mjs --role owner."
    };
  }

  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const found = email ? listAccounts({ query: email, limit: 200 }).accounts.find((account) => account.email === email) : undefined;
  if (!found) {
    return { ok: false, error: `There is no account for ${email || "that address"}. Register it first, then run this again.` };
  }

  const before = ownerAccount();
  const result = assignOwner(found.id, { transfer: input.transfer === true });
  if (!result.ok) return { ok: false, error: result.error };

  const transferred = before !== null && before.id !== found.id;
  recordAudit({
    actor: { kind: "system", name: "host setup script" },
    action: transferred ? "role.owner_transferred" : "role.owner_assigned",
    target: { id: found.id, email: found.email },
    detail: transferred ? `from ${before.email}` : ""
  });
  return { ok: true, email: found.email, transferred, previousOwner: transferred ? before.email : null };
}
