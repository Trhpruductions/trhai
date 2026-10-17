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
  switch; that switch is the control.
