# The install story: from a checkout to an installer

Written 2026-10-12, when TRH AI could only be run from its source tree:
`npm install`, `Build-TRHAI.bat`, `npm run setup:engine`, a `.gguf` copied by
hand, and a PowerShell launcher behind a Desktop shortcut. This records what
"install it like a product" means for this app, what is built now, and what
is still to do.

## What an install is, and is not

An installed TRH AI is three things in one folder under Program Files:

| Part | Shipped as | Run by |
|---|---|---|
| Desktop shell | Electron, `apps/desktop` (asar) | Electron |
| API | **one file**, `resources/api/server.mjs` (esbuild bundle of `apps/api` + `@ascend/shared`, 4.9 MB) plus `loopbackOnly.cjs` and `frameRendererElectron.mjs` beside it | the same Electron, as Node (`ELECTRON_RUN_AS_NODE=1`) |
| Web app | Next.js **standalone** build, `resources/web/...` with `serve.mjs` so it listens on both loopback addresses | the same Electron, as Node |

So an installed copy needs **no Node, no npm and no source tree** on the PC.
The shell starts the two services from its own resources (`ensurePackagedServices`
in `main.ts`) and stops them when it quits, as it already did for the
checkout's `npm run` services.

What is **not** in the installer, on purpose: the model engine (llama.cpp,
~50 MB per build) and the models (2–5 GB each; 14 GB on a working install).
They live where they always have, `%LOCALAPPDATA%\TRHAI\runtime`, and an
install finds them there. A PC that has none needs the first-run setup below.

Where an installed copy keeps things:

| What | Where | How the API learns it |
|---|---|---|
| Data (memories, conversations, accounts, schedules…) | `%APPDATA%\TRH AI\data` | `TRHAI_DATA_DIR` |
| Settings | `%APPDATA%\TRH AI\.env` (optional; the same keys as the repo's `.env`) | `TRHAI_ENV_FILE` |
| Engine and models | `%LOCALAPPDATA%\TRHAI\runtime` | unchanged |
| Workspace (apps it builds, files it writes) | `~\Vexora\workspace` | unchanged (`ASCEND_WORKSPACE`) |
| Electron, for video frames | the app's own `electron.exe` | `TRHAI_ELECTRON_PATH` |

Nothing is written beside the program files; the loading-screen fallback goes
under userData too.

## Milestones

### M1 — an installer that runs the app (built)

- `npm run package:win` (`scripts/package-win.ps1`) builds shared → web
  standalone → API bundle → shell → `electron-builder`, and leaves
  `apps/desktop/release/TRH-AI-Setup-<version>.exe` (NSIS, choose the folder)
  and `TRH-AI-Portable-<version>.exe`.
- Code changes behind it: `TRHAI_DATA_DIR`, `TRHAI_ENV_FILE` and a
  `TRHAI_VERSION` fallback in the API; `output: "standalone"` in Next;
  `apps/api/scripts/bundle.mjs`; `ensurePackagedServices` in the shell;
  `electron-builder.json` renamed to TRH AI with `extraResources`;
  `productName` in the shell's package.json, because Electron names the
  userData folder after it (without it an installed copy kept its data
  under `%APPDATA%\@ascend\desktop`).
- One thing learned the hard way: electron-builder drops every
  `node_modules` folder from `extraResources`, with or without a filter
  naming it, and the web app's standalone build is nothing without its
  `node_modules` (that is where `next` lives). `apps/desktop/afterPack.cjs`
  copies it into place after packaging and before the installers are built.
  Do not try to fix this with a filter again.
- The second thing learned: a standalone build has no `next.config` and no
  webpack, and Next only skips loading both when
  `__NEXT_PRIVATE_STANDALONE_CONFIG` holds the resolved config, which its
  generated `server.js` sets from a JSON line of its own. `serve.mjs`, which
  starts Next itself so it can listen on both loopback addresses, now reads
  that line from the `server.js` beside it. Without it the packaged web app
  died at start with "Cannot find module next/dist/compiled/webpack/webpack-lib".
- Verified 2026-10-13 on this PC (i5-3570, 8 GB, no GPU) with the portable
  build, the checkout's services stopped first: the API answered `/health`
  39 s after launch and the web app 70 s after, both run by `TRH AI.exe` from
  its resources; the operations check reported 13 of 13 ready; data was
  written under `%APPDATA%\TRH AI\data`; the window titled "TRH AI" opened;
  quitting freed both ports. A chat through the packaged API reached the
  model but timed out at 180 s - the installed copy has none of this PC's
  `.env` tuning (`TRHAI_MODEL=qwen2.5-3b`, the 600 s timeout), which is the
  M2 work below, not a packaging fault.
- Each packaged service writes what it prints to
  `%APPDATA%\TRH AI\logs	rh-ai-api.log` and `trh-ai-web.log`, appended.
  That is where to look when an installed copy does not come up.

### M2 — first run on a PC with nothing (next)

Today a PC without an engine is told to run `npm run setup:engine`, which an
installed copy cannot do. M2 moves that into the app:

- Port `scripts/setup-engine.ps1` to the API: pick the variant (CUDA when
  `nvidia-smi` answers, else CPU), download the llama.cpp release asset,
  verify its SHA-256 against the published digest, unpack into
  `runtime\engine\<build>`. Progress goes through the execution log so the
  ACTIVITY rail shows it.
- A model picker: a short list with sizes and what each needs (the 3B for
  8 GB PCs, the 7B coder for a graphics card), downloaded with a verified
  hash into `runtime\models`, with progress. Until a model is there the app
  says so plainly in the operations panel ("Everything TRH AI needs"), whose
  fix text must stop naming npm scripts.
- A minimum spec stated in the installer and the README: 16 GB RAM or an
  8 GB graphics card for the 7B; 8 GB RAM runs the 3B slowly (see
  `21-handoff.md`, this PC's section).

### M3 — releases

- Code signing: unsigned today, so SmartScreen warns on first run. Needs a
  certificate, which is a purchase, not code.
- Auto-update: `electron-updater` against GitHub Releases of
  `Trhpruductions/trhai`; the installer is NSIS already, which is what it
  expects.
- A CI job that builds the installer on a version tag and attaches it to the
  release, and a CHANGELOG.
- `Build-TRHAI.bat` and `Launch-TRHAI.bat` stay for working from a checkout;
  they are not the product's install path any more.

## Known limits of M1

- `run_command` runs what the PC has. An installed copy has no `npm`
  unless the PC does; `node` is there (the app's own Electron) only for the
  apps TRH AI builds and runs itself, which inherit `ELECTRON_RUN_AS_NODE`.
- Document import (`unpdf` and the Office readers) is bundled but has not
  been exercised from an installed copy.
- The installer is Windows only. The shell's packaged path is platform
  neutral, but nothing else has been tried elsewhere.
