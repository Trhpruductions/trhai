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
~50 MB per build), the models (2–5 GB each; 14 GB on a working install) and
the three optional tools beside them, the voice, listening and video (about
390 MiB together). The engine and models live where they always have,
`%LOCALAPPDATA%\TRHAI\runtime`, and an install finds them there. A PC that has
none needs the first-run setup below, which fetches the tools too (M2b).

Where an installed copy keeps things:

| What | Where | How the API learns it |
|---|---|---|
| Data (memories, conversations, accounts, schedules…) | `%APPDATA%\TRH AI\data` | `TRHAI_DATA_DIR` |
| Settings | `%APPDATA%\TRH AI\.env` (optional; the same keys as the repo's `.env`) | `TRHAI_ENV_FILE` |
| Engine and models | `%LOCALAPPDATA%\TRHAI\runtime` | unchanged |
| Voice: Piper and its voice | `~\Vexora\piper\piper` | `VEXORA_PIPER_DIR` |
| Listening: whisper.cpp and its model | `~\Vexora\whisper` | `VEXORA_WHISPER_DIR` |
| Video: ffmpeg | `%LOCALAPPDATA%\TRHAI\runtime\tools\ffmpeg` | `TRHAI_FFMPEG_PATH` names a different one; used before an `ffmpeg` on PATH |
| Workspace (apps it builds, files it writes) | `~\Vexora\workspace` | unchanged (`ASCEND_WORKSPACE`) |
| Electron, for video frames | the app's own `electron.exe` | `TRHAI_ELECTRON_PATH` |

Nothing is written beside the program files; the loading-screen fallback goes
under userData too.

## Milestones

### M1 — an installer that runs the app (built)

- `npm run package:win` (`scripts/package-win.ps1`) builds shared → web
  standalone → API bundle → shell → `electron-builder`, and leaves
  `apps/desktop/release/TRH-AI-Setup-<version>.exe` (one-click NSIS, per
  user: it installs to `%LOCALAPPDATA%\Programs\trh-ai` without asking for
  admin rights) and `TRH-AI-Portable-<version>.exe`.
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
  `%APPDATA%\TRH AI\logs\trh-ai-api.log` and `trh-ai-web.log`, appended.
  That is where to look when an installed copy does not come up.

### M2 — first run on a PC with nothing (built)

Built 2026-10-13 in `apps/api/src/services/modelSetup.ts`, with the screens in
`SetupScreen.tsx` and `SetupPanel.tsx`:

- The first time the app opens without an engine or a chat model, a setup
  screen offers to download them. *Settings → Engine and models* does the same
  later, and removes models.
- The engine is chosen from the PC: the CUDA 13.4 build for an NVIDIA card on a
  580 or newer driver, CUDA 12.4 on an older driver, otherwise the CPU build.
- The recommended model is Qwen3 4B Instruct 2507 for a PC with less than
  16 GB and no 8 GB card, otherwise Qwen2.5 Coder 7B. Both are Apache 2.0.
  (Since 0.1.8 the recommended models are their no-refusals builds, with a
  picture model beside each: see M2c.)
- Every file is pinned: a llama.cpp release tag or a Hugging Face commit, its
  size and its SHA-256. A file that does not match is deleted, not installed.
  A stopped download keeps its `.part` file and continues with a Range request.
  Nothing reaches `engine\` or `models\` until it is whole and verified, and
  the engine is restarted afterwards because it reads the model list only at
  start.
- On a PC without a graphics card, settings the `.env` does not set are filled
  in at start: an 8,192-token window, a 600 s reply limit, a 30-minute idle
  unload, and the small model first. These are the values this PC needed
  (`21-handoff.md`).
- Licences: Qwen2.5 3B and Qwen2.5 VL 3B are under Qwen's research licence,
  which does not allow commercial use. The VL 3B download page says Apache
  2.0; the model it was made from does not. They stay in the list, labelled,
  and are never recommended.
- Verified on this PC: the real CPU engine archive downloaded, verified and
  unpacked with Windows' `tar` in under 3 s, and `llama-server --version`
  ran. Through the first-run screen, the 4B model downloaded at about 7 MB/s;
  stopping it at 278 MB kept the `.part` file, and starting again continued
  from there. The engine restarted with it and answered "Hello! How can I
  assist you today?" after 409 s cold (3,784 prompt tokens at 10.4 a second).
- That first answer exposed a limit in Node's own fetch: it abandons a
  response that has not begun within 300 s, so every cold reply longer than
  that had been failing on slow PCs. `engineFetch.ts` fixes it for every
  engine request (see `21-handoff.md`, negative results).

What was planned for M2, kept for reference:

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

### M2b — the voice, listening and video tools (built 2026-10-24)

After M2 an installed copy could chat and do nothing else: the voice, listening
and video screens said "not installed", and the fix was a hand install of
Piper, a voice, whisper.cpp, a model and ffmpeg. Those three now install from
the same screens as the engine and the models. `toolCatalog.ts` lists them and
`modelSetup.ts` runs them as a third kind of step beside the engine and the
models.

| Tool | Installs | Left to download | Licence |
|---|---|---|---|
| Voice | Piper 2023.11.14-2 and five voices: Alan, Amy, Cori, Ryan and Jarvis (the four after Cori added 2026-10-25) | 475.1 MiB | Piper is MIT; each voice has a licence of its own, see below |
| Listening | whisper.cpp b4938 and `ggml-base.en` | 149.1 MiB | MIT |
| Video | ffmpeg 9.0.2, the gyan.dev "essentials" build | 109.5 MiB | GPL 3; run as its own program, not linked |

- The first-run screen offers all three, ticked; *Settings → Engine and models*
  does the same later. Any can be unticked. One that is already there, whether
  hand-installed or an `ffmpeg` on PATH, shows as installed and is left alone,
  and a tool missing only a part (Piper with no voice) fetches only that part.
  A tool install does not restart the engine; the engine and a model do.
- A copy installed before these tools existed would never see that screen, as it
  already has an engine and a model. So the first time one opens with all of
  that in place and the tools missing, the screen opens once more with only the
  tools ticked (`setupReason`, `lib/setup.ts`; remembered in the browser's
  storage under `trhai.setup.tools-offered.v1`). After it is closed, however it
  is closed, the tools are in Settings only.
- Pinned like the engine and the models: a release tag or a Hugging Face
  commit, the exact size and the SHA-256, and a file that does not match is
  deleted, not installed. Where each lands is in the table under "What an
  install is, and is not". ffmpeg keeps only `bin\ffmpeg.exe` and its licence under the
  runtime folder, and is used before an `ffmpeg` on PATH, so TRH AI neither
  depends on the PC's own copy nor changes it.
- **Five voices, from 2026-10-25.** The owner asked for every voice on their own
  PC to be installed for everyone else, and for the Jarvis voice besides. Until
  then the tool installed Cori alone, because her licence allows what the rest of
  the app allows and the most used Piper voice, Ryan, is CC BY-NC-SA
  (non-commercial). The five do not share a licence, so the tool is no longer
  labelled free to use commercially (`commercialUse` is false on it), and the
  install screen lists each voice with its licence as its makers state it:

  | Voice | Id | From | Licence, as its makers state it | Size |
  |---|---|---|---|---|
  | Alan | `en_GB-alan-medium` | rhasspy/piper-voices | "All Rights Reserved", Mycroft AI (the voice's own LICENSE file in the Mimic 3 collection) | 60.3 MiB |
  | Cori | `en_GB-cori-high` | rhasspy/piper-voices | public domain (LibriVox recordings) | 108.9 MiB |
  | Jarvis | `en_GB-jarvis-high` | jgkawell/jarvis, its maker's own repository; kept under the app's id, not its makers' file name | a fan-made imitation of a film character's voice, tagged MIT by its maker, which cannot cover the voice | 108.9 MiB |
  | Ryan | `en_US-ryan-high` | rhasspy/piper-voices | CC BY-NC-SA 4.0, non-commercial | 115.2 MiB |
  | Amy | `en_US-amy-medium` | rhasspy/piper-voices | none stated: the model card says "See URL" and points at the Mimic 3 collection, which is CC BY-SA 4.0 overall but does not list her | 60.3 MiB |

  Only Cori is plainly free to use in anything; whether to ship the others in a
  paid app is the owner's decision, made on 2026-10-25 and flagged to them then.
  Dropping one is deleting its entry in `piperVoices` (`toolCatalog.ts`); nothing
  else changes. Alan is the default (`defaultVoiceId` in `piperSpeech.ts`, the
  same as the interface's `defaultVoice`): it is named, because the ranking
  (quality, male first, British first) would put Jarvis ahead of it.
- A copy that already has Piper and a voice - every 0.1.7 - is brought up to all
  five: the tool lists each voice file that is not on disk, whether or not Piper
  already speaks. A voice a person put there themselves stays, and does not stand
  in for the five. `ToolStatus.missingBytes` says what is still to fetch for a tool
  that works, and Settings offers it ("400 MB more to add").
- Verified 2026-10-25 on this PC through the app's own installer: only the two
  missing Jarvis files were fetched (109 MiB), they matched their pinned SHA-256,
  Piper then listed five voices with Alan as the default, and Jarvis spoke a
  sentence (22,050 Hz, 16-bit, 3.9 s, speech and pauses by the numbers). The audio
  was measured, not listened to.
- Verified 2026-10-24 on this PC, through the API's own install route, into empty
  scratch folders with no `ffmpeg` on PATH. All six files downloaded in 20 s and
  matched their pinned size and SHA-256. The operations check then reported the
  voice ("1 voice, speaking as Cori"), listening (`ggml-base.en`) and ffmpeg
  ("Installed by TRH AI") as ready. The installed voice spoke a sentence and the
  installed whisper.cpp heard it back word for word. Asking for the same install
  again did nothing, and an unknown tool name was refused ("Not a tool TRH AI
  can install"). Then the app's own `renderVideo` made an 8 s video with the
  installed Piper and ffmpeg: H.264 and AAC, all 64 frames, the first frame red
  and the last blue as drawn, and whisper.cpp heard the narration in the video's
  own audio track. Plain colour frames stood in for Electron, and the hardware
  encoder was refused on purpose, so the graphics card was not used and the
  software encoder did the work, as it would on a PC without an NVIDIA card.
- That check found a fault in `videoRender.ts` that predates it. Each scene's
  audio was only its narration, the scenes' audio was joined end to end, and a
  scene lasts longer than its narration whenever the script gives it more time
  than the sentence needs. The second sentence then played over the first
  scene's pictures, and ffmpeg's `-shortest` cut the video where the audio ended:
  two 5 s scenes with a 2 s sentence each came out 3.98 s long, 31 of 80 frames.
  Each narrated scene's audio is now padded with silence to the scene's length,
  so the second sentence starts at 5.0 s, when its scene does, and the video is
  10.00 s with all 80 frames.
- Verified in a browser, against a copy of the service with scratch folders and
  the model engine switched off: the first-run screen with the three tools
  ticked; an install from it of the engine and the tools (939 MB, about a
  minute, each step shown and then marked Installed); the one-time offer on a PC
  that already had an engine and a model, with only the tools shown; its
  install, 389 MB; and that closing it once keeps it from coming back.
- Tests: `tool-setup.test.ts` (24, with fake downloads, including a same-length
  file with one letter changed and an install that placed something the app
  cannot use) and the screen logic in `setup.test.ts`. Breaking the installer in
  29 specific ways (which ffmpeg wins, what is remembered, what counts as
  missing, what is put where, the engine restart, the refusal off Windows) each
  fails a test, and so does each of 6 ways of breaking the offer.
- Not verified: the same screens inside the packaged Electron window, the real
  Electron frame renderer with the installed ffmpeg (it uses the graphics
  card), and a PC with no graphics card at all.

### M2c — what an update brings: models without refusals, and an install that does itself (built 2026-10-25)

The owner asked for three things in one message: models for conversation and for
reading ("and everything along those lines"); that none of them has guard rails;
and that the update force all of it onto everyone else's PC, as it had not been:
only the owner's PC had the other voices, and the models were whatever each
person had ticked.

**The models.** Four were added to `modelCatalog` (`modelSetup.ts`), and are now
the ones recommended. Each is an original model "abliterated" by huihui-ai - the
direction in the model that makes it refuse is taken out of its weights - and
nothing else changed: the same families, chat templates and Apache 2.0 licence.

| Model | Id | For | Download | From |
|---|---|---|---|---|
| Qwen2.5 Coder 7B (no refusals) | `qwen2.5-coder-7b-abliterated` | 16 GB of memory, or an 8 GB card | 4.4 GiB | bartowski/Qwen2.5-Coder-7B-Instruct-abliterated-GGUF |
| Qwen3 4B Instruct (no refusals) | `qwen3-4b-instruct-2507-abliterated` | smaller PCs | 2.3 GiB | mradermacher/Huihui-Qwen3-4B-Instruct-2507-abliterated-GGUF |
| Qwen3 VL 8B (pictures, no refusals) | `qwen3-vl-8b-abliterated` | 16 GB, or an 8 GB card | 5.4 GiB (model 4.7 and picture part 0.7) | mradermacher/Huihui-Qwen3-VL-8B-Instruct-abliterated-GGUF |
| Qwen3 VL 4B (pictures, no refusals) | `qwen3-vl-4b-abliterated` | smaller PCs | 2.7 GiB | mradermacher/Huihui-Qwen3-VL-4B-Instruct-abliterated-GGUF |

- Pinned like the rest (commit, size, SHA-256). The picture parts are kept under
  a name that starts with `mmproj`, which is how `discoverModels` finds a
  model's picture part: the quantiser names them `<model>.mmproj-Q8_0.gguf`.
- `recommendedModel` and the new `recommendedVisionModel` pick the pair for the
  PC; both are flagged in the setup status, and the first-run screen ticks both.
  `preferredModels` (`localModel.ts`) names the two chat builds ahead of the
  originals, because the family names in it match both and the engine lists the
  original first. `defaultVisionModel` is the 8B; a small PC is given the 4B by
  `hardwareDefaults`, as it is given the small chat model. A named model
  (`TRHAI_MODEL`) is never overruled, and naming the original gets the original.
- The originals stay in the catalogue for anyone who wants the refusals. The
  tools' own limits (permission levels, confirmations, the machine-access switch,
  the workspace sandbox) are about what the assistant may do to a PC, are not
  part of a model, and were not touched. The only wording of the app's own that
  reads as a guard rail is the professional-advice note on the Medical, Legal and
  Cyber-security personalities, which is a separate decision (left in place).
- The 7B coder's source repository (huihui-ai/Qwen2.5-Coder-7B-Instruct-
  abliterated) answered 401 on 2026-10-25; the quantised file is in a public
  repository and is pinned by hash.
- Verified 2026-10-25 on this PC (Ryzen 5 7600, 31 GB, RTX 4060 Ti 8 GB). All four
  were downloaded through the app's own installer, 15.9 GB in about 11 minutes,
  and each file matched its pinned size and SHA-256. Each was then started on
  the CPU alone (the card hidden) with the engine TRH AI ships, and asked to
  answer, to call a tool, to use the tool's result, and - the picture models - to
  read a picture of an invoice, and was asked eight low-severity requests that
  models are usually trained to turn down (a fake review, profanity, an insult, a
  dirty joke, a bank-style password request, lock picking, a villain explaining
  hotwiring, manipulation tips). Only whether each reply *began* as a refusal was
  recorded; the replies were neither kept nor read.

  | | Loaded in | Tool call | Read the picture | Began as a refusal |
  |---|---|---|---|---|
  | 4B chat | 6 s | `get_weather({"city": "Paris"})`, then answered from the result | - | 0 of 8 |
  | 4B pictures | 6 s | the same | "INVOICE 4821 / Total due: 129.50 EUR", word for word | 0 of 8 |
  | 7B coder | 8 s | written as text inside `<tools>` tags | - | 0 of 8 |
  | 7B coder, the original | 7 s | written as text inside `<xml>` tags | - | **6 of 8** |
  | 8B pictures | 12 s | the same as the 4B | word for word | 0 of 8 |

  The coder writes its tool call as text, with or without the refusals, which
  `parseTextToolCalls` in the agent loop reads; it is the model the loop was
  measured with. Not verified: any of them on the graphics card (a rule of this
  project is to ask before each run there), or in a long session with the whole
  tool set.

**The install that does itself** (`requiredSetup.ts`). An update replaces the
program and nothing else, so what a version needs beside it was left for each
person to find and tick. On a copy that is already set up, the service now
brings it up to the bundle by itself a little after it opens (15 s, so the
window is up first): the engine, the recommended chat and picture models for
the PC, and every tool - the same installer as the first-run screen, with the
same checks.

- Not on a new install (its first-run screen asks, with both models and every
  tool ticked), and not where `TRHAI_REQUIRED_SETUP=off`.
- Recorded in `runtime\required-setup.json` against a generation number
  (`requiredSetupGeneration`, 1 for 0.1.8). A copy that finished a generation is
  left alone until the bundle changes, so a model or voice a person removes
  afterwards stays removed. A job that fails or is stopped starts again the next
  time TRH AI opens, three times at most by itself; after that it waits for the
  banner's button. A job cut short by closing the app counts the same way.
- Order: engine, chat model, picture model, then the tools. Only what is missing
  is fetched. A drive without room is told so in numbers (needs about 14.3 GB,
  has 9.0 GB) and the failure is kept for the banner; Settings, Engine and
  models, still lets a person install less.
- The engine is restarted at the end - it reads its models only when it starts -
  but not under a reply: it waits until nobody has asked the engine anything for
  three seconds (`engineRequestsInFlight`), and if that does not happen in half
  an hour leaves it for the next start.
- A retry reuses what was fetched. `downloadVerified` used to start a file over
  whenever a `.part` was not there, so a picture model (two files) that failed on
  the second began the first again; a file already in place, whole and as
  published, is now kept.
- On screen: a bar under the top bar on every screen (`RequiredSetupBanner`)
  with how far it has got, Stop, and, when it stopped or failed, why and a button
  to carry on. It says once when it is done. While it runs, the setup screen does
  not also offer the tools. `GET /v1/setup` carries a `required` object;
  `POST /v1/setup/required` starts it by hand.
- Looked at for real, against a copy of the service with a runtime folder that was
  set up and short of the bundle, and downloads stood in for by a stream that
  never ends: the bar showed 10.4 GB to download, then progress, Stop made it
  "stopped" with Continue, a failed record showed the no-room message with Try
  again, Settings listed the new models and each voice's licence, and the bar
  wrapped on a phone-width screen.

### M3 — releases

- Code signing: unsigned today, so SmartScreen warns on first run. Needs a
  certificate, which is a purchase, not code.
- Auto-update (built 2026-10-13): `electron-updater` against GitHub Releases
  of `Trhpruductions/trhai`, in `apps/desktop/src/updater.ts`. The owner's
  side is in `24-paywall-and-updates.md`.
  - The installer became **one-click** for it. The assisted installer, which
    let people pick a folder, showed its "install for whom" page during a
    silent update and gave up.
  - Neither installer reopens the app after a silent update, whatever
    `--force-run` says. So the app starts a hidden helper before it quits,
    and the helper waits for the installer, then starts the app. The helper
    must be detached, because Node ends non-detached children with their
    parent. Detached PowerShell has no console and exits at once, so it runs
    under `conhost --headless`, with `cmd /c start /min` as the fallback.
  - Verified on this PC: 0.1.5 was installed one-click. Its own buttons found
    a local 0.1.6, downloaded it, quit and installed it. The helper reopened
    it about 80 s later, reporting 0.1.6. Uninstalling then removed the
    program, its shortcut and its Windows entry, and left the user's own
    `TRHAI.lnk` alone.
- A CI job that builds the installer on a version tag and attaches it to the
  release (`release.yml`, built with the paywall work), and a CHANGELOG
  (`releaseNotes.ts` is the in-app one).
- `Build-TRHAI.bat` and `Launch-TRHAI.bat` stay for working from a checkout;
  they are not the product's install path any more.

## Known limits of M1

- `run_command` runs what the PC has. An installed copy has no `npm`
  unless the PC does; `node` is there (the app's own Electron) only for the
  apps TRH AI builds and runs itself, which inherit `ELECTRON_RUN_AS_NODE`.
- Document import was exercised from an installed copy on 2026-10-13. A
  PDF (2 pages), a Word file and a PowerPoint deck were read, and a question
  about the Word file was answered from it in 1 s. That run also did
  first-run setup from an empty runtime folder with no `.env`, and answered
  "487 times 263" with the calculator after 531 s.
- The installer is Windows only. The shell's packaged path is platform
  neutral, but nothing else has been tried elsewhere.
