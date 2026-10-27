# Accounts, roles and who may use what

Written 2026-10-27. This is how TRH AI decides who may do what, what the owner
and the administrators can do, how to give people access, and - stated plainly -
what is **not** built yet.

## The rule it had to keep

`21-handoff.md`: TRH AI runs on the buyer's own PC, with no cloud service and no
keys. That shapes everything below, because **anything checked on a PC can be
changed by the person who owns the PC.** So the design has two kinds of "who is
allowed", and keeps them apart:

- **A signed key** (a license key, or an owner or administrator key). It is
  checked with the owner's public key, offline. Nobody can make or change one
  without the private key, which stays with the owner. This is what an ordinary
  install trusts.
- **A record this copy keeps for itself** (an account's role, its status). On an
  ordinary install anyone who can edit that file can write "owner" into it, so it
  proves nothing. It is believed only on a copy that is **the system of record for
  its accounts** - one that other people sign in to and that its owner looks after
  (`TRHAI_AUTHORITY=on`, below).

## Roles

| Role | Can do | Never |
|---|---|---|
| **Owner** | Everything in the product, always. Looks after administrators and members. | Is not locked out by a trial, a plan, a payment, a lapse or a usage limit. Cannot be suspended or changed by an administrator. |
| **Administrator** | Everything in the product, always. Supports accounts: finds them, suspends and reactivates members, signs them out everywhere, reads the audit record. | Cannot make administrators, hand over ownership, change settings, or act on the owner or on another administrator. |
| **Member** | What their plan includes (below). | Sees no administrator screen and is refused every administrator route. |

The order a request is judged in is fixed, in `apps/api/src/services/entitlements.ts`:
signed in, then the role the **server** holds, then the owner, then administrators,
and only then the plan. The owner and the administrators are allowed without the
plan being read at all, so no plan, payment or record can stand between them and the
product. Nothing the caller sends - a header, a field, a value in the page's storage -
is consulted.

### How a role is given

- **On an ordinary install: by a signed key.** The owner makes it on the PC that
  holds the signing key:

  ```bash
  node scripts/licensing/issue.mjs --email someone@example.com --role admin
  node scripts/licensing/issue.mjs --email you@example.com --role owner
  ```

  The role is inside the signed text, so it cannot be added afterwards. A key with
  a role never expires (the tool refuses `--expires` with it). The person enters it
  under *Settings, Plan and billing*; it makes **the account with that email** the
  owner or administrator of that copy. Take the key off the PC and the role goes
  with it, at once.
- **On a copy that holds its own accounts** (`TRHAI_AUTHORITY=on`): the owner is
  made from the machine itself, by someone with shell access to it and to its data
  key - nothing reachable over the network can do it:

  ```bash
  npx tsx scripts/accounts/make-owner.ts --email you@example.com
  ```

  The account must already exist. There is one owner; `--transfer` hands ownership
  to another account and makes the old owner an administrator in the same step. The
  owner then makes administrators in *Settings, People and access*.

Keys with a role are for the people who run TRH AI. **Do not give an owner or
administrator key to ordinary users.**

## What a member can use

Every route that does work is listed once, in the feature catalogue
(`featureCatalogue` in `entitlements.ts`), and gated from that list: the assistant,
building and running apps, commands on the PC, schedules, tasks, the automation
flow, pictures, music videos, spoken replies and dictation. Reads are never gated, so
a locked app still shows what it holds. Which features each plan includes is the
`defaultPlans` table in the same file.

The defaults keep TRH AI exactly as it was: a trial and every paid plan (`personal`,
`pro`, `team`) use everything; once a trial or license has run out the work is locked
and the voice, which was never behind the paywall, stays open. **Nothing here is a
price.** Narrowing a plan is a change to that table; it is not yet a setting in the
app.

*Settings, Plan and billing* shows each member their role, their plan and every
feature marked open or shut with the reason. It is computed by the same rules the
routes apply, so it cannot say something the app would not do.

## Giving people access

- **One key per person:** `node scripts/licensing/issue.mjs --email them@example.com --plan pro`
  (no `--expires` for a key that never ends).
- **A batch of full-access keys to hand out:** `scripts/licensing/issue-batch.mjs`
  makes many at once and writes them to a CSV. It is one file with no dependencies,
  so it can be copied to the PC that holds the signing key:

  ```bash
  node issue-batch.mjs --count 20 --label friends        # friends-001@trhai.invalid, friends-002@...
  node issue-batch.mjs --emails users.txt                # one key per address, so the app shows who it is for
  node issue-batch.mjs --count 5 --expires 2027-01-31    # keys that stop on that date
  ```

  It checks the private key against the public key built into the app first (a key
  from any other pair would be refused by every installed copy), refuses to
  overwrite a file of keys, writes nothing unless every key can be made, and records
  each key in `issued-licenses.jsonl` beside the private key. It never makes owner or
  administrator keys.
- **What a key is:** a password. Whoever holds it can use TRH AI on their PC, and it
  cannot be taken back from a PC once given - nothing is online. Give each person
  their own, and use `--expires` for anything meant to end. Stopping sharing, or
  revoking a key, needs a service that checks keys online; this app has chosen not to
  have one.

## People and access (owner and administrators)

*Settings, People and access* appears only for the owner and the administrators (the
routes refuse anyone else whatever the screen shows). It lists the accounts on the
copy, searchable by part of an email or a name: when each joined and last signed in,
how many sessions are open, their role and status. For each account, where the role
allows:

- **Suspend / Reactivate.** Suspending signs the person out everywhere at once and
  stops them signing in; they are told why, and only after giving the right password,
  so nobody guessing learns which addresses exist. A recovery code cannot reopen a
  suspended account.
- **Sign out everywhere.**
- **Make / Remove administrator** (owner only, and only on a copy that holds its own
  accounts; elsewhere an administrator is a signed key, and the screen says so).

Below the list is the **record of changes**: every suspension, sign-out and change of
role, with who did it, to whom and when. It is append-only and hash-chained - each
entry carries the hash of the one before - so taking an entry out or changing one is
reported ("Intact" or "Altered at entry N"). It never holds a password, a token, a
recovery code or a key. (Someone with the data key can still rewrite the whole file;
the chain makes a quiet edit show, not impossible.)

## Running a copy that holds its own accounts

`TRHAI_AUTHORITY=on` makes a copy believe its own records: stored roles count, a plan
belongs to the account (a new account gets the same 14-day trial a new PC does, counted
from the day it was made), and every caller of a gated route must be signed in. Use it
for a copy that other people sign in to - a household or a team sharing one PC or one
machine on the network - and that its owner looks after. On such a copy:

1. Set `TRHAI_AUTHORITY=on` in the service's environment.
2. Have each person register an account in the app.
3. Make the owner: `npx tsx scripts/accounts/make-owner.ts --email you@example.com`,
   run with the same environment as the service (so it reads the same accounts and the
   same data key).
4. The owner opens *Settings, People and access* and makes administrators.

Back up the data folder before first turning it on. The accounts file gains a status,
a verification date, a last sign-in and a stored role; nothing is converted (an old
account reads as active, unverified, role member), but the first write after an upgrade
keeps the previous file beside it as `accounts.json.before-roles`, and putting that one
file back undoes the upgrade.

## Signing in, as it is today

Email and password accounts, with scrypt-hashed passwords (never stored or logged),
sessions that are random tokens kept as hashes, a 30-day expiry, sign-out, a password
change that ends every other session, recovery codes for a forgotten password,
case-insensitive duplicate-email protection, and rate limits on sign-in, registration,
recovery and password change.

## Not built yet

Said plainly, so nothing here is mistaken for working:

- **Email verification, password-reset links, invitations by email.** There is no
  email service: TRH AI sends no mail of its own. Recovery codes cover a forgotten
  password; an administrator cannot yet issue a reset or an expiring single-use
  invitation. These need a mail provider's credentials.
- **Subscriptions and a payment provider.** There is no provider and no checkout
  session, webhook, billing portal or cancellation flow, and the app holds no payment
  credentials. A paid plan today is a signed key. Taking payment needs a provider's
  account and keys, and a public address for its webhooks that a PC on its own cannot
  offer.
- **Usage limits** (messages a day, storage, voice minutes). Plans decide features, not
  quantities.
- **A service other people sign in to over the internet.** `TRHAI_AUTHORITY=on` is for a
  copy on one machine or one network. A hosted account service needs hosting, a domain
  and a mail provider.
- **Revoking a key or a role from a PC you do not control.** Offline, a signed key stays
  valid until it expires or is taken off the PC.

## Tests

`entitlements.test.ts` (the rules, with no server), `access.test.ts` (through a real
server: the owner and an administrator with no subscription, a free user, an expired
license, tampering, role changes and revoked privileges), `audit.test.ts`,
`owner-setup.test.ts` and `license-batch.test.ts`, with the screens' own tests in
`apps/trhai-web/tests/access.test.ts`. Every rule was also changed on purpose, one at a
time, to confirm a test fails when it breaks.
