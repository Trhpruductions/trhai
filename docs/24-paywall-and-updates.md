# Paywall, payments and update notices

Written 2026-10-13. This is the owner's guide to selling TRH AI and telling
everyone who uses it about new versions. It also records why each part works
the way it does.

## The rule it had to keep

`21-handoff.md` says TRH AI uses no cloud APIs and holds no keys. So the app
never talks to a payment provider and never sees a card. Paying happens on a
web page in the buyer's browser. What the buyer gets back is a **license
key**, which the app checks offline against the owner's public key.

## How it works for someone using the app

1. A new PC gets a **14-day free trial**. It starts the first time the API
   runs and is remembered in `license.json` in the data folder, protected at
   rest like every other data file.
2. When the trial ends, the app is **locked**. Everything stays readable:
   conversations, memory, documents, settings. Anything that makes it do new
   work is refused with HTTP 402 and the paywall screen appears. That covers
   the assistant, building and running apps, commands, schedules, tasks,
   flows and vision.
3. **Settings → Plan and billing** shows the plan, the trial dates, a
   *Buy a license* button and the key box. The paywall has the same button
   and box.
4. Pasting a key unlocks the PC at once, with no account and no internet.
   A key with an expiry date locks the app again when it passes.

## Selling it: what the owner does

### Once

The signing key pair already exists on the owner's PC:

| File | What it is |
|---|---|
| `%USERPROFILE%\.trhai-license\trhai-license-private.pem` | Issues keys. **Never** commit, copy or share it. Back it up somewhere offline. Losing it means no new keys can be issued for existing installs. |
| `%USERPROFILE%\.trhai-license\trhai-license-public.txt` | Already in `apps/api/src/services/licenseConfig.ts`. |

Then set up a checkout page with any hosted provider that takes the payment
for you: a Stripe Payment Link, Lemon Squeezy, Gumroad or PayPal. Put its
link and the price text in `licenseConfig.ts`:

```ts
export const checkoutUrl: string | null = "https://buy.stripe.com/your-link";
export const priceText: string | null = "$29, one-time";
```

Only `https://` links are accepted. Until this is set, the Buy button is
replaced by "Ask whoever gave you TRH AI for a license key."

### For each sale

When the provider tells you someone paid, issue their key and send it to them
by email:

```bash
node scripts/licensing/issue.mjs --email buyer@example.com --plan pro
```

| Option | Meaning |
|---|---|
| `--plan` | `personal`, `pro` or `team`. Shown in the app. |
| `--expires 2027-10-13` | For a yearly plan. Leave it out for a key that never expires. |
| `--seats 5` | Shown in the app. Not enforced, because enforcing it needs a server. |

Every key issued is also recorded in `issued-licenses.jsonl` next to the
private key.

### The owner's own PCs

Set `TRHAI_PAYWALL=off` in that PC's `.env`, or issue yourself a key.

### Limits, stated plainly

- Keys are not tied to a PC, so one key can be shared. Stopping that needs an
  activation server, which this app has chosen not to have.
- Someone who edits the app's code can remove the check. That is true of any
  app that runs entirely on the buyer's own PC.
- Deleting `license.json` restarts the trial on that PC.

## Update notices

Everyone using the app sees two kinds of notice, on any screen, signed in or
not:

- **What's new** appears the first time a version runs in that browser. It
  shows that version's notes once. *Settings → Updates* can show it again.
- **Update available** is a card in the corner when a newer version has been
  released, with a Download button. *Later* hides it until the next release.

*Settings → Updates* shows the running version, a *Check now* button, the
newest release and the notes of recent versions.

### Where the information comes from

- The **notes** ship inside the app, in `packages/shared/src/releaseNotes.ts`,
  so What's new works offline.
- The **newest version** comes from this repo's latest GitHub release. It is
  one unauthenticated request every six hours with no key, and nothing about
  the user is sent. `TRHAI_UPDATE_CHECK=off` stops it.
  `TRHAI_UPDATE_FEED_URL` points it at a different feed in the same format.

### Making a release

1. Bump `version` in `apps/desktop/package.json`, which is the product
   version the installer is named after.
2. Add a note for that version at the top of `releaseNotes.ts`.
3. Merge the change, then tag the release:

```bash
git tag v0.1.5
```

```bash
git push origin v0.1.5
```

The **Release** workflow builds both installers on Windows, checks that the
tag matches the version, and publishes a GitHub release with them attached.
From then on, every installed copy offers it.
