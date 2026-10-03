# Deploy TRHAI to another PC (e.g. a home server)

Everything runs locally — no cloud, no accounts, no API keys. Moving the app to
another machine is: get the code across, install prerequisites, build, run. The
app adapts to the new machine on its own (live readings, paths, ports); the only
per-machine setup is Node, the model engine, and a model.

Verified on 2026-09-27: full build + all 1835 tests pass, lint/typecheck clean.

---

## 1. Prerequisites on the new PC

- **Node.js ≥ 20** (24 is fine; CI uses 22) and npm — `node -v`.
- **The model engine and a model.** The app runs its models in llama.cpp's
  server, which it starts and stops itself — there is no separate application to
  install or keep running.
  - `npm run setup:engine` (after step 4) downloads the engine release the app
    was measured with, checks it against its published SHA-256, and unpacks it
    into `%LOCALAPPDATA%\TRHAI\runtime\engine`. That default is for an NVIDIA
    card; `npm run setup:engine -- -Variant vulkan` (or `cpu`) is for a PC
    without one. Not on Windows: put a `llama-server` build in
    `<runtime>/engine/<build>/`, or name one with `TRHAI_ENGINE_EXE`.
  - A model is a `.gguf` file in `%LOCALAPPDATA%\TRHAI\runtime\models`; its
    file name is the model's name. Copy the files across from the old PC, or
    download a GGUF build of a chat/coding model (the Q4_K_M files are the
    usual choice for an 8 GB card). A model that can see images goes in a
    folder of its own there, with its `mmproj` file beside it.
  - Coding/`build_app` quality is best with a coding model (`qwen2.5-coder-7b`).
  - Keep that folder on an SSD. Measured: a model loads in 3.5 s from an SSD
    and 38 s from a hard disk. `TRHAI_RUNTIME_DIR` moves it.
  - Without a model the app still runs — memory, files, schedules, app
    management and the machine readings all work; only generated replies need it.
- **Optional, feature-specific** (auto-discovered; the app degrades gracefully if
  absent, it does not fail): `ffmpeg` on PATH for `make_video`; Piper + whisper
  for hands-free voice.

Nothing else is machine-specific — no drive letters or usernames are baked in.

## 2. Get the code across

Copy the `trhai` folder to the new PC (recommended — a `git clone` also drags a
~420 MB export that lives in the repo's history). If you copy, **exclude
`node_modules`, `apps/*/.next`, `apps/*/dist`, and `.env`** — they are rebuilt
and machine-specific. `git clone` is fine too if you don't mind the history size.

## 3. Configure

```bash
copy .env.example .env      # (cp on POSIX)
```

The defaults are portable, so an unedited `.env` runs. Set only what you need:
- `TRHAI_MODEL` — which model answers, by its file's name without `.gguf`. Unset,
  the best of the installed ones is used.
- `ASCEND_WORKSPACE` — where built apps/files land; unset ⇒ `<home>/Vexora/workspace`.
- `TRHAI_DATA_KEY` — optional at-rest encryption key; unset ⇒ a machine-local key
  is generated. A `.env` from one machine will **not** decrypt another's data.

## 4. Install and build

```bash
npm ci                 # or: npm install
npm run build          # builds every workspace (api, trhai-web, desktop)
npm run setup:engine   # once: the model engine (see step 1)
```

## 5. Run

- **Windows, the intended way:** run `Build-TRHAI.bat` once, then launch with
  `scripts\launch-trhai.ps1` (or the "Joint Infected"-style desktop shortcut it
  creates). It starts the API on **4000** (which starts the model engine), the
  web app on **3210**, waits until it answers, then opens the desktop window. Ports are
  checked first, so launching twice opens the app you have rather than racing a
  second copy.
- **Any OS / headless server:** start the two services directly —
  ```bash
  npm run start --workspace @ascend/api
  npm run start --workspace trhai-web -- -p 3210
  ```
  then open `http://localhost:3210` (or `http://<server-ip>:3210` on the LAN).

## 6. Confirm it works on the new machine

- **Quickest check — `npm run doctor`.** A read-only preflight that reports Node
  version, whether the model engine is installed and has a model, whether ffmpeg is
  present (for `make_video`), and whether the workspace is writable — one
  glanceable pass/warn summary, ideal on a headless server before you launch.
- Open the app; the **SYSTEM** panel should show *this* machine's live CPU / GPU
  / RAM (readings are measured, never carried over — a dial shows "—" when its
  sensor can't be read here).
- Ask it something to confirm the model answers; ask "what apps have I built" to
  confirm the workspace path resolved.
- Re-run the full check any time:
  ```bash
  npm run lint && npm run typecheck && npm test && npm run build
  ```

## What adapts automatically (no action needed)

- **Paths** — the launcher derives the repo root from its own location; the
  workspace and logs use `<home>`/`%LOCALAPPDATA%`, not fixed drives.
- **Live status** — CPU/GPU/RAM/FPS are read from the machine it runs on.
- **System-path guards** (`machinePaths.ts`) apply the running OS's own rules.
- **The models** — the app uses `TRHAI_MODEL`, and falls through to whatever is
  in the models folder if that exact model isn't there. Each model is given the
  largest context window that fits this machine's graphics card.

## Not carried over on purpose

- `.env`, `node_modules`, builds, and the workspace contents are per-machine.
- Encrypted data files (memory, conversations) only decrypt with the key of the
  machine that wrote them — start fresh, or copy `TRHAI_DATA_KEY` across too.
