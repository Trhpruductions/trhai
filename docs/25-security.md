# Security review before the first release

Written 2026-10-16, from a review of the code and the dependency audit on
master at `deadff0`. It records what was found, what was changed, and what
is left on purpose. Everything here was checked on the PC in
`21-handoff.md`, not only in tests, unless it says otherwise.

## The audit, before and after

| | High | Moderate | Total |
|---|---|---|---|
| master `deadff0` | 13 | 8 | 21 |
| after this change | 5 | 8 | 13 |

What ships in the installer was checked separately from what only builds it.
`app.asar`, the API's single file (`resources/api/server.mjs`) and the web
app's standalone `node_modules` were searched for every flagged package.

| Finding | Ships to users? | What was done |
|---|---|---|
| Electron 37.2.3: 38 advisories (11 high, 21 moderate, 6 low), among them a context-isolation bypass, sandbox escapes through popups, use-after-frees, and file and HTTP handlers allowing cross-origin reads | Yes: it is the app | Upgraded to **44.5.1**, the newest 44.x at least two weeks old. Electron 42, 43 and 44 are the supported lines, and 44 has the longest support ahead of it |
| js-yaml 4.3.1 (CPU use on crafted merge keys) | Yes, once self-updating is merged: electron-updater reads `latest.yml` with it | 4.3.2, a patch release |
| brace-expansion, @xmldom/xmldom, fast-uri, http-cache-semantics, undici | No: electron-builder, node-gyp and ESLint only | Patch releases (`npm audit fix`, no `--force`) |
| extract-zip, @electron/get 2.x | No: Electron's own downloader at install time | Gone with Electron 44 |
| eslint-config-next → @next/eslint-plugin-next → fast-glob → micromatch → braces (5 high) | No: linting only | **Left.** npm's only fix is eslint-config-next 14, which does not support Next 16, and no braces release is fixed. Reachable only by linting attacker-written glob patterns |
| electron-builder 26 → app-builder-lib → @electron/get 3 → global-agent → roarr → sprintf-js (8 moderate) | No: building the installer only | **Left.** The newest stable electron-builder, 26.17.0, still uses @electron/get 3; the fix is in 27 alphas. The vulnerable code is reached only through a proxy setting this build does not use |

## The desktop window

| Was | Now | Why it mattered |
|---|---|---|
| `sandbox: false`, because the preload was an ES module | `sandbox: true`, with the preload compiled as CommonJS (`preload.cts`) | A sandboxed renderer cannot reach Node or the OS if a page is compromised |
| "Trusted" meant any page on 127.0.0.1 or localhost, on any port, and any `file:` URL, for both navigation and the IPC bridge | Only this PC's addresses on the app's own port, and the loading screen file the shell writes (`isTrustedAppUrl`) | The bridge reads project files, captures the screens and runs workspace checks. The apps TRH AI builds run on ports of their own, so any of them, or any other local server, would have had the bridge if the window reached it |
| No permission handler: Electron grants every request | Only the app's own pages get anything, and only microphone audio, notifications, clipboard writes and full screen | Camera, location, USB, HID, serial and MIDI were all granted silently |
| `<webview>` allowed | Refused in every web contents | A webview can bring its own preload and settings |

Checked in the running window under Electron 44 (`--remote-debugging-port`):

- the bridge is present and answers;
- `require` and `process` do not exist in the page;
- the microphone is granted, and location is refused and logged;
- a navigation to the API's own port, 4000, is blocked and logged.

The camera could not be tried, because this PC has none.

## The local servers

| Was | Now | Why it mattered |
|---|---|---|
| The API answered any `Host` header | Only requests addressed to this PC's names (or, with other devices let in, a numeric address) are answered; anything else gets 421 before any other code runs, preflight included (`isAllowedHost`) | **DNS rebinding**: a site you visit can point its own name at 127.0.0.1, and its page's requests then reach the API as its own origin, where CORS never applies. It could have read memory, conversations and documents, and posted requests |
| CORS allowed this PC's addresses on any port | Only the web app's own port (`ASCEND_WEB_PORT`, default 3210) | The apps TRH AI builds, whose code the model writes, run on other ports on this PC and could read the API |
| The model engine (llama.cpp, port 4040) answered any request from any origin; llama.cpp warns about this itself at start | Started with a fresh random `--api-key` each time; every engine request carries it (`engineKey.ts`); `/health` stays open. A second copy of the app reads the key from the engine's pid file | Any web page could use the model, load and unload models, and keep the PC busy |
| A second copy recognised the first's API only if its process was `node` | `node` or `TRH AI` | An installed copy's API runs as `TRH AI.exe`, so a second copy would have ended the first's engine mid-reply |

The web app on port 3210 has no server routes, only pages, so a rebound
page can read nothing from it.

## The second review, 2026-11-01 to 2026-11-02

A read-only audit of the code on 2026-11-01 (its findings are listed in
`29-legal-privacy-compliance.md`) led to these changes, each with a test:

| Was | Now | Why it mattered |
|---|---|---|
| CORS hid replies from a page on another origin, and nothing refused the request itself | A request whose `Origin` is not the app's, or whose `Sec-Fetch-Site` is `cross-site`, is refused (403) before anything else runs, whatever its method; the two routes that fetch from the internet also refuse any embedded subresource (`requestOrigin.ts`) | Arming machine access, starting a download, sending a test email or fetching a page does its work whether or not the caller can read the answer. A page on any site - or an app TRH AI built, on its own port - could fire those |
| On a copy other people sign in to, reads and many writes needed no sign-in | With `TRHAI_AUTHORITY=on`: every route but the ones a sign-in needs answers only a signed-in account, and the license, the email account, installs, the network check, the shared preferences and opening a file on the host are the owner's (`requireSignInOnSharedCopy`, `requireOwnerForCopyChangesOnSharedCopy` in `access.ts`) | Anyone who could reach a shared copy could read its workspace and schedules and change its SMTP password |
| The saved SMTP password was reused when the address was unchanged, even if the server changed | The password is reused only for the same address on the same host, port and sign-in name; otherwise it must be typed again (`emailAccount.ts`) | Anyone who could reach the route could point the account at a server of their own and have the test send deliver the password to it |
| `/v1/world` returned every session's newest steps with their words and results | Steps carry their kind, status and time; a command's label is "Ran a command"; details and artifacts stay in their session (`worldState.ts`) | A command line can carry a password; the world is read without a sign-in |
| A `.docx` was unpacked with no limit | A part unpacks to at most 64 MB and an archive has at most 4,096 parts (`documentText.ts`) | A 695 KB file inflated to 200 MB and held the service for seconds; a larger one would have ended it |
| The web fetch checked one address of a name, then let `fetch` resolve it again; some private ranges were missing; the time limit ended at the headers | Every address of the name is checked (carrier-NAT, benchmarking, multicast, site-local, NAT64, 6to4 and Teredo forms included), the connection is made to a checked address and never resolves the name again (`pinnedFetch`), and the limit runs to the last byte (`webFetch.ts`) | DNS rebinding and a slow drip of a body |
| The interface was served without a content security policy or referrer policy | Every page carries a policy that allows only this PC's addresses as sources and frames, forbids being framed, and sends no referrer (`next.config.ts`) | A flaw in a screen could have loaded or sent to anywhere; another page could have framed the app |
| Stores dropped the oldest key when full, an account's as readily as a guest's | The oldest anonymous key goes and an account's never does (`storeEviction.ts`) | Five hundred made-up guest ids pushed a real person's conversations off the disk |
| A command or an app the model wrote inherited the service's whole environment | TRH AI's own keys are left out of a child's environment (`childEnv.ts`) | The data key or an engine key in `.env` reached a program a page talked the model into writing |
| ffmpeg read uploaded songs with every protocol allowed | `-protocol_whitelist file,pipe` on every ffmpeg run (`musicVideo.ts`) | A crafted file could make ffmpeg open an address |
| A failure inside the service answered with the error's own message | One sentence to the caller; the message goes to the service's log (`errorReply.ts`) | A message can carry a file path, a user name or a line of a stack |

Still open from that audit, on purpose or for later: machine access on by default
(the owner's decision), the engine key on the engine's command line and in its pid
file (a second copy reads it from there), the unverified email on a role key, the
audit record's emails on a shared copy (taken out when an account is erased), and
the Chromium spell-check question.

## Left on purpose, or still open

- **`ELECTRON_RUN_AS_NODE` stays on.** The packaged app runs its API and web
  app with its own Electron as Node. Anyone who can run programs as the user
  could do the same, which gives them nothing they did not already have.
- **The installer is unsigned.** Windows SmartScreen warns on first run, and
  nothing proves an update came from you except the release page it was
  downloaded from. A code-signing certificate is a purchase; see
  `24-paywall-and-updates.md`.
- **License keys are not tied to a PC.** Deleting the license file alone no
  longer restarts the trial, but deleting it together with the trial marker
  (`%LOCALAPPDATA%\TRHAI\trial-started`) does. Both need a server to change,
  which the no-cloud rule rules out.
- **Commands.** `run_command` runs what the PC has, behind the machine-access
  switch; that switch is the control. **The switch is on by default** (see
  `15-machine-control.md`, and `machineAccessDefault` in `commandRunner.ts`);
  earlier text here that said otherwise was out of date.
- **The access log kept the whole address** of every request - with it, a guest's
  session id, search words, page addresses and file names - and was never pruned.
  Since 2026-11 it logs the route and the outcome only (`accessLog.ts`), command
  lines are logged as the program and the length (`commandForLog`), and the
  desktop shell moves a log aside at 2 MB and deletes one untouched for 30 days
  (`logRetention.ts`).
