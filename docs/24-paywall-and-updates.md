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

### Backing up the signing key, and restoring it

The private key is the only thing that can issue keys that existing installs
accept. If it is lost, every copy already sold keeps working, but no new key
can be issued for them, so new buyers would need a new release with a new
public key. If it leaks, anyone can issue keys.

**Back it up now**, to at least two places that are not this PC and are not
online in plain text:

1. Copy the whole folder `%USERPROFILE%\.trhai-license`. It holds
   `trhai-license-private.pem`, `trhai-license-public.txt` and
   `issued-licenses.jsonl`, the record of every key issued.
2. Put one copy on an encrypted USB drive (BitLocker To Go, or VeraCrypt) and
   keep it somewhere safe.
3. Put a second copy in a password manager that holds files (1Password and
   Bitwarden do), or print the `.pem` and store the paper securely. It is a
   short block of text.
4. Do not email it, commit it, or put it in an ordinary cloud folder.
   `*.pem` and `issued-licenses.jsonl` are already ignored by git in this repo.

**Check a backup** before you rely on it:

```bash
node scripts/licensing/verify.mjs --key E:\trhai-license\trhai-license-private.pem
```

It says whether that key matches the public key built into the app. It
issues nothing and writes nothing.

**Restore** on a new PC: copy the folder back to
`%USERPROFILE%\.trhai-license`, run the check above without `--key`, and carry
on issuing keys. `--license TRHAI-…` checks a key you sent someone: whether it
is genuine and what it says.

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
- The trial start is kept twice: in `license.json` in the data folder, and
  in `%LOCALAPPDATA%\TRHAI\trial-started`, which uninstalling leaves. The
  earlier one wins, so deleting the license file, the data folder or the app
  and reinstalling does not restart the trial. Deleting both still does.
- A license file changed by hand ends the trial instead of extending it. That
  covers a plain-text file, one that cannot be decrypted, or one whose trial
  starts in the future. The app only writes it encrypted. A genuine key in such
  a file still unlocks, because its signature is checked on its own. Losing
  the data key (`trhai-data.key`) has the same effect: re-enter the license
  key.

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
2. Add a note for that version at the top of `releaseNotes.ts`. Its title and
   lines also become the release page's text, which installed copies show
   when they offer the update, so write them for the people using the app.
   The workflow refuses to publish a version that has no note. If every copy
   has to move to it, give the note `required: true`: see *Required updates*
   below.
3. Merge the change. Tag a release candidate first, such as `v0.1.5-rc.1`.
   It is published as a pre-release, which no installed copy is offered, so
   it can be installed and updated to by hand (`TRHAI_DESKTOP_UPDATE_URL` set
   to its download folder) before anyone else sees it.
4. Then tag the release:

```bash
git tag v0.1.5
```

```bash
git push origin v0.1.5
```

The **Release** workflow builds both installers on Windows, checks that the
tag matches the version, and publishes a GitHub release with them attached,
together with `latest.yml`, the installer's `.blockmap` and `SHA256SUMS.txt`.
From then on, every installed copy offers it. A release candidate is
published the same way, marked as a pre-release.

### How an installed copy updates itself

- The update card and *Settings → Updates* show **Download and install**.
  The download runs in the app, with its progress shown. Then the button
  becomes **Restart to update**. Nothing is downloaded or installed until the
  person asks.
- The app quits and runs the installer silently. The installer reopens the new
  version itself (its "open the app afterwards" switch), and a small hidden
  helper covers the times it does not: it waits for the installer to finish,
  then opens the app unless one is already running, and writes each step to
  `%APPDATA%\TRH AI\logs\update-restart.log`.
- A downloaded update that is not installed then is installed the next time
  the app quits.
- The portable build, a browser, and a copy run from source keep the
  download link: they have nothing to install over.
- `latest.yml` is what the updater reads. A release without it can still be
  downloaded by hand, but installed copies cannot update themselves from it,
  so the workflow refuses to publish one without it.
- To try an update without publishing one, serve a folder holding
  `latest.yml` and the new Setup file over http, and start the installed app
  with `TRHAI_DESKTOP_UPDATE_URL` set to that address. The installer starts
  its own copy of the app through Explorer, which gives that copy Explorer's
  settings, not the test's: to keep a test from touching real data, and to
  leave the restart to the helper, stop that copy the moment it appears (the
  helper then starts the app from the settings the old app had).

### Required updates (from 0.1.8)

An update that the app has to be on - because the parts of it that matter
(the models, the voices, the service's answers) changed together - can be
marked required. A note with `required: true` puts one fixed line under the
release page's title (`requiredUpdateLine` in `releaseNotes.ts`, "Required
update: TRH AI downloads this one by itself and restarts to install it."), and
the API reads that line back out of the latest release (`LatestRelease.required`
in `updates.ts`).

On an installed copy that is on an older version, a required release is not
offered, it is installed: the app downloads it by itself as soon as the release
is seen, then shows a window over everything with how far it has got and, once
it is ready, a restart that happens by itself after two minutes (or at once
from the button). The window cannot be closed; if the download fails it says
why, with *Try again* and *Not now* (the update is still installed when the app
quits, as any downloaded one is).

The restart comes by itself **once per version**. The window notes the version in
the app's own storage (`trhai.update.install-tried.v1`) the moment a restart is
asked for - by the countdown or by *Restart now* - before the installer has run.
A copy that comes back still on the old version has an installer that did not
take (blocked, out of space, closed early), and restarting into it again every
two minutes would be a loop with no way out, since the window cannot be closed
while the countdown runs. So the second time it says the install did not finish
and asks: *Try again* gives one more automatic restart, *Not now* puts the window
away and leaves the update card, which installs it by hand. A copy that installs
normally never sees this: it comes back on the version the release names, and
nothing is offered. The next required version restarts by itself once, as this
one did.

What it cannot do: **force a copy whose own version does not know the line.** A
0.1.7 copy cannot, so 0.1.8 itself reaches it as an ordinary update, with
*Later*, or by hand (the installer is also copied to `D:\TRHAI-Installer` for
sending); from 0.1.8 on, the next release can be forced. The portable build, a
browser and a copy run from source have nothing to install over, so for them a
required release is the ordinary card, without *Later*.
