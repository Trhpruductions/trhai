# Handoff: what is left to finish TRHAI

Written for an agent picking this up cold. Everything under **Verified facts** was
measured on this machine, not assumed — trust it and do not re-derive it.

---

## Hard constraints — do not break these

These are the user's standing rules, reaffirmed many times. Work that violates
them is wrong even if it works.

1. **No cloud APIs and no third-party API keys.** Ever. Do not add one, do not
   suggest adding one, do not leave an `API_KEY` env fallback in the code.
2. **Everything runs locally on this machine.** Ollama, Piper, whisper.
3. **Generated apps have zero npm dependencies.** They must run with
   `node server.js` and no install step. `findForeignImport` in
   `apps/api/src/services/appAuthor.ts` enforces this — do not relax it.
4. **One screen.** No navigation, no tabs, no route surfaces. If something must
   be reachable it goes in a rail (CONSOLE left, ACTIVITY right).
5. **Never claim work that did not happen.** This codebase is built around that
   rule — see `contradictedClaims.ts`, `fabricatedOutput.ts`, `actionIntent.ts`.
   A reply saying a file was saved when it was not is the worst bug class here.

---

## Verified facts about this machine

| Thing | Value |
|---|---|
| GPU | RTX 4060 Ti, **8188 MiB total**, ~6100 MiB used while the model is loaded |
| ffmpeg | **8.0.1 full build**, on PATH |
| Hardware encoders | `h264_nvenc`, `av1_nvenc`, `h264_amf` |
| ffmpeg filters | `xfade`, `zoompan`, `drawtext`, `gblur`, `overlay` |
| Ollama models | `qwen2.5-coder:7b`, `llama3.1:8b`, `llama3.2:latest` |
| Ollama store | `D:\Ollama\models` (env `OLLAMA_MODELS`) — **C: has only ~9 GB free** |
| Node | v24.4.0 local; `package.json` declares `>=20`; CI pins 22 |
| Piper / whisper | both work; `ggml-base.en` |

### Two negative results — do not repeat this work

- **ffmpeg cannot rasterize SVG here.** The `svg_pipe` *demuxer* is listed, which
  is misleading: this build has no SVG *decoder* (no librsvg). Piping SVG frames
  fails with `no decoder found for: svg`. Do not design around SVG input.
- **`win.capturePage()` returns 1920x1032, not 1080**, because the window size
  includes chrome. Pass `useContentSize: true` to `BrowserWindow`.

### Proven working, end to end

- **Electron offscreen rendering with WebGL2.** A hidden `BrowserWindow` with
  `webPreferences: { offscreen: true, backgroundThrottling: false }` reports
  `webgl2-ok`, accepts `executeJavaScript` per frame, and
  `capturePage().toPNG()` returns real frames.
- **Frames to MP4.** 36 PNG frames at 24fps through
  `ffmpeg -framerate 24 -i f%04d.png -c:v h264_nvenc -preset p5 -pix_fmt yuv420p`
  produced a valid h264 file. NVENC works.
- **Voice round trip, no microphone needed.** Piper synthesised speech, then the
  app's own `resampleMono`/`encodeWav` from `apps/trhai-web/src/lib/wav.ts`, then
  `POST /v1/transcribe` returned `Testing 1, 2, 3.` Reuse this to test voice
  instead of asking a human to speak.

---

## Task 1 — Video studio (largest piece; nothing is built yet)

The user asked for video "like a triple-A studio". **Local generative
text-to-video is not achievable on this hardware** and should not be attempted:
those models want 8–24 GB of *free* VRAM, this machine has roughly 2 GB free
while the assistant is loaded, and the PyTorch/CUDA stack breaks constraints 1
and 3. Say that plainly if asked. Do not quietly build a poor version of it.

What **is** achievable, and what to build: a **motion-graphics studio** that
scripts, narrates, renders and encodes — entirely locally, at true 1080p.

### Pipeline

```
user request
  -> local model writes a scene script      (new: videoScript.ts)
  -> Piper narrates each scene              (exists: piperSpeech.ts)
  -> Electron offscreen renders frames      (new: frameRenderer.ts)
  -> ffmpeg encodes and muxes narration     (new: videoRender.ts)
  -> MP4 in the workspace
```

### `packages/shared/src/videoScript.ts` — pure, no I/O, unit-testable

- `type Scene = { id: string; seconds: number; narration?: string; visual: SceneVisual }`
- `type SceneVisual` — a closed discriminated union: `title`, `bullets`, `metric`,
  `code`, `coreState`, `imageFile`. Add cases deliberately.
- `type VideoScript = { title: string; fps: number; width: number; height: number; scenes: Scene[] }`
- `parseVideoScript(text)` — parse the model's output, the way
  `parseAuthoredFiles` handles `=== FILE:` blocks in `appAuthor.ts`.
- `findScriptFault(script)` — reject *before* rendering: zero scenes, a scene
  under 0.5s, total over 10 minutes, unknown visual kind. Follow `findAppFault`.
- `sceneHtml(scene, t)` — HTML for one scene at progress `t` (0..1). Reuse the
  real visual language: tokens in `apps/trhai-web/src/app/globals.css`
  (`--accent`, `--text`, `--line`, `--font-display`) and the HUD panel look. The
  output should be recognisably TRHAI, not generic slides.

### `apps/api/src/services/frameRenderer.ts` — owns the Electron child

- Spawn `apps/desktop/node_modules/.bin/electron` running a small render script.
- **One window for the whole video**, not one per scene. Electron startup will
  dominate the runtime otherwise.
- Per frame: `executeJavaScript` to set state, then `capturePage()`.
- Must time out and kill the child. A hung Electron with no window is invisible.

### `apps/api/src/services/videoRender.ts` — orchestration and ffmpeg

- Narrate first, so a scene's real audio length can extend its duration. A scene
  shorter than its narration is the most likely quality bug.
- `ffmpeg -framerate <fps> -i frame%06d.png -i narration.wav -c:v h264_nvenc -preset p5 -pix_fmt yuv420p -c:a aac -shortest out.mp4`
- Fall back to `libx264` if `h264_nvenc` fails — NVENC has a concurrent-session
  limit and can refuse while something else is encoding.
- Report real outcomes only. If ffmpeg exits non-zero, say so with its stderr;
  never report a file that was not written. Copy `verifyBuiltProject` in
  `buildVerification.ts`: "could not verify" is a third outcome, distinct from
  pass and fail.

### `make_video` tool in `apps/api/src/services/agentTools.ts`

- Permission level **2** in `toolPermissions.ts` (writes files, destroys nothing).
- Add it to `mutatingTools` in `agentLoop.ts` so its real result reaches the user
  verbatim rather than the model's retelling of it.
- Emit `beginEvent`/`endEvent` per scene so the ACTIVITY rail shows progress. A
  five-minute silent tool looks like a hang.

### Tests

- `videoScript.test.ts` — parsing, every `findScriptFault` rejection, `sceneHtml`
  containing the scene's text and surviving empty narration.
- `video-render.test.ts` — a failed ffmpeg is reported as a failure and no
  success is claimed. Stub the encoder; do not require a GPU.
- **Do not** put a real render in the suite: it needs Electron, a GPU and ~30s.
  Add it as a script the user runs (`npm run smoke:video`), like `smoke:web-stack`.

---

## Task 2 — Run the CI that was just added

`.github/workflows/ci.yml` exists on `trhai-microphone` and **has never run**. It
triggers on PRs to `master` and pushes to `master`, so pushing the branch does
not fire it. Open a PR and confirm it goes green before trusting it.

If Node 22 fails where local Node 24 passes, that is a real version difference.
Investigate it; do not just bump CI to 24.

---

## Task 3 — Decide on 1,048 lines of orphaned code

`packages/shared/src/` holds four modules with **zero consumers** in `apps/`:

| Module | Lines | Was behind |
|---|---|---|
| `automation.ts` | 448 | the deleted Automation page |
| `marketplace.ts` | 301 | the deleted Agents page |
| `localCalendar.ts` | 159 | the deleted Calendar page |
| `knowledgeImport.ts` | 140 | the deleted Knowledge page |

Plus ~70 tests. Working, tested code left behind when the app became one screen.
**This is the user's decision, not an agent's** — either wire them into a rail
(constraint 4) or delete them with their tests. Do not leave them drifting.

---

## Task 4 — Smaller known gaps

- **Hands-free voice has never been tested against real hardware.** The server
  side is proven (round trip above), but real microphone capture, real speaker
  playback, and the voice-activity detector against room noise are not. This
  needs a human at the machine — ask, do not claim it works.
- **`apps/web`** is the superseded Vite client. It still builds and is still in
  the workspace list. Decide whether it goes.

---

## How to verify anything you change

```
npm run lint          # eslint, trhai-web only - expect 0 problems
npm run typecheck     # all workspaces - expect 0 errors
npm test              # expect ~1561 tests, 0 failures
npm run build         # all workspaces
```

Run all four. They catch different things: a CSS syntax error takes the build
down while leaving lint, types and every test untouched. That has happened here.

**Test isolation:** run API tests with `npm test`, never a bare
`npx tsx --test <file>`. The isolation keeping tests off the user's real
machine-access grant is carried by an `--import` flag on the npm script. There is
a `NODE_TEST_CONTEXT` fallback in `commandRunner.ts` now, but prefer `npm test`.

**After changing `apps/trhai-web`, rebuild *and restart* the server on 3210.**
`next start` reads the build once at boot; a rebuild alone changes nothing on
screen and you will chase a phantom.
