# Deploy TRHAI to another PC (e.g. a home server)

Everything runs locally — no cloud, no accounts, no API keys. Moving the app to
another machine is: get the code across, install prerequisites, build, run. The
app adapts to the new machine on its own (live readings, paths, ports); the only
per-machine setup is Node, Ollama, and a model.

Verified on 2026-09-27: full build + all 1835 tests pass, lint/typecheck clean.

---

## 1. Prerequisites on the new PC

- **Node.js ≥ 20** (24 is fine; CI uses 22) and npm — `node -v`.
- **Ollama** (https://ollama.com) — the local model host. After installing:
  - `ollama pull vexora:latest` (the app's default), **or** pull any chat/coding
    model and set `OLLAMA_MODEL` in `.env` to it, e.g. `ollama pull qwen2.5-coder:7b`.
  - Coding/`build_app` quality is best with a coding model (`qwen2.5-coder:7b`).
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
- `OLLAMA_MODEL` — the model you pulled (if not `vexora:latest`).
- `ASCEND_WORKSPACE` — where built apps/files land; unset ⇒ `<home>/Vexora/workspace`.
- `TRHAI_DATA_KEY` — optional at-rest encryption key; unset ⇒ a machine-local key
  is generated. A `.env` from one machine will **not** decrypt another's data.

## 4. Install and build

```bash
npm ci            # or: npm install
npm run build     # builds every workspace (api, trhai-web, desktop)
```

## 5. Run

- **Windows, the intended way:** run `Build-TRHAI.bat` once, then launch with
  `scripts\launch-trhai.ps1` (or the "Joint Infected"-style desktop shortcut it
  creates). It starts Ollama (if installed), the API on **4000**, the web app on
  **3210**, waits until it answers, then opens the desktop window. Ports are
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
  version, whether Ollama is reachable and the model is pulled, whether ffmpeg is
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
- **Ollama model set** — the app uses `OLLAMA_MODEL`, and falls through to
  whatever is installed if that exact model isn't present.

## Not carried over on purpose

- `.env`, `node_modules`, builds, and the workspace contents are per-machine.
- Encrypted data files (memory, conversations) only decrypt with the key of the
  machine that wrote them — start fresh, or copy `TRHAI_DATA_KEY` across too.
