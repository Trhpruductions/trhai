# Handoff: what is left to finish TRHAI

Written for an agent picking this up cold. Everything under **Verified facts** was
measured on this machine, not assumed — trust it and do not re-derive it.

---

## Hard constraints — do not break these

These are the user's standing rules, reaffirmed many times. Work that violates
them is wrong even if it works.

1. **No cloud APIs and no third-party API keys.** Ever. Do not add one, do not
   suggest adding one, do not leave an `API_KEY` env fallback in the code.
2. **Everything runs locally on this machine.** The model engine (llama.cpp's
   server, started by the API), Piper, whisper.
3. **Generated apps have zero npm dependencies.** They must run with
   `node server.js` and no install step. `findForeignImport` in
   `apps/api/src/services/appAuthor.ts` enforces this — do not relax it.
4. **One screen.** No navigation, no tabs, no route surfaces. If something must
   be reachable it goes in a rail (CONSOLE left, ACTIVITY right).
5. **Never claim work that did not happen.** This codebase is built around that
   rule — see `contradictedClaims.ts`, `fabricatedOutput.ts`, `actionIntent.ts`.
   A reply saying a file was saved when it was not is the worst bug class here.
6. **App-owned data is key-protected at rest.** Persistent API stores write
  encrypted JSON envelopes through `protectedJson.ts`. `TRHAI_DATA_KEY` may
  provide the key; otherwise the API creates a machine-local key outside the
  repo. Existing plaintext JSON can still be read and migrates on the next save.
  If an encrypted file cannot be authenticated with the current key, the helper
  locks that file against overwrite so a wrong key cannot silently wipe data.

---

## Verified facts about the machines

TRH AI has run on two PCs. The first table is the original one, where most of
the measurements below were taken. The second is the PC it was moved to on
2026-10-08, which has no graphics card and changes what to expect.

### The original PC (graphics card)

| Thing | Value |
|---|---|
| GPU | RTX 4060 Ti, **8188 MiB total**, ~6100 MiB used while the model is loaded |
| ffmpeg | **8.0.1 full build**, on PATH |
| Hardware encoders | `h264_nvenc`, `av1_nvenc`, `h264_amf` |
| ffmpeg filters | `xfade`, `zoompan`, `drawtext`, `gblur`, `overlay` |
| Models | `qwen2.5-coder-7b` (pinned in `.env`, answers chat and authors apps), `qwen3-8b`, `qwen2.5-3b`, and `qwen2.5-vl-3b` for images - **this list changes; check `curl 127.0.0.1:4040/models` while the app runs, or the models folder, before assuming** |
| Model engine | llama.cpp `b11366` (CUDA), started by the API on port 4040; the engine and the models are in `%LOCALAPPDATA%\TRHAI\runtime`, on the SSD |
| Node | v24.4.0 local; `package.json` declares `>=20`; CI pins 22 |
| Piper / whisper | both work; `ggml-base.en` |

### This PC (no graphics card) — measured 2026-10-12

| Thing | Value |
|---|---|
| CPU / RAM | Intel i5-3570, 4 cores, **7.9 GB RAM**, no GPU. Nine other services run here under pm2 (Discord bots, MariaDB, Free City RP), plus Discord, Steam and Chrome: **7.3 GB in use, 4.5 GB in the pagefile** while TRH AI runs |
| Engine | llama.cpp `b11366` **CPU build** (`engine\b11366`); the CUDA build is kept as `engine\b11366-cuda` |
| Model | `TRHAI_MODEL=qwen2.5-3b` in `.env`, because it is the one that fits. The 7B coder and the 8B **cannot load**: each attempt is a 300 s timeout |
| Window | `TRHAI_CONTEXT_TOKENS=8192`. Without it the engine's `fit` mode gave the 3B its full 32k window (`n_ctx 32768`), a ~1.2 GB KV cache in system RAM |
| Timeout | `TRHAI_MODEL_TIMEOUT_MS=600000`, and `TRHAI_IDLE_UNLOAD_SECONDS=1800` so the prompt cache survives between questions |
| Speed | Raw engine, 8192 window, 961 MB free: **8.5–9.8 prompt tokens/s cold, 0.4–2.3 generated tokens/s** (the original PC: ~40/s). The app's prompt is ~3,000 tokens, so a cold reply is 1.5–4.5 minutes; a repeat question with a warm cache answers in seconds |
| Live battery | 13 of 13 pass with these settings: greeting 264 s, calculate 133 s, date 113 s, file write 232 s (file verified on disk), file read 204 s, web fetch 95 s; memory remember/recall/forget instant |
| Node | v24.19.0 |
| Voice / video | Piper (4 voices), whisper `ggml-base.en`, ffmpeg on PATH: all pass their smoke checks; video renders with the CPU encoder in ~20 s |

**The speed here is the hardware, not the app.** The engine is paging. What
helps, in order: more RAM (16 GB of DDR3 ends the paging), a smaller model
(`qwen2.5-1.5b`), closing memory-heavy programs while using it. Do not spend
time tuning the prompt loop for this PC before one of those is done.

### First replies: the warm-up (measured 2026-10-18)

Almost all of a cold reply's wait here is the model reading its prompt, not
writing the answer. The engine keeps what it has read and reuses whatever
front the next prompt shares, so the API has it read the front every turn
shares before anyone asks (`apps/api/src/services/warmUp.ts`):

- What it reads: the system message (`systemMessageFor`) and the eleven
  tools offered with every turn (`alwaysOfferedTools`, which now come first
  in every tool list so that they are shared).
- When: once the API's own engine is up, and when the chat box is clicked
  into (`POST /v1/warm-up`, at most once a minute from the app) if the
  engine has since let the model go. Never while the trial has ended, and
  never by pushing out another loaded model.
- It gives way to real work: any reply the engine is asked for stops it
  (`loadEngineModel` calls `stopWarmUp`), and the engine keeps what it had
  read. `GET /v1/warm-up` says where it is; `TRHAI_WARM_UP=off` turns it off.

On this PC, 3B model, "Write a one-line Python function that reverses a
string." sent as the chat box sends it:

| | Prompt read before the first word | Whole turn |
|---|---|---|
| master, cold | 3,564 tokens, 261 s | 413 s |
| warm-up branch, warmed at start | 663 tokens, 51 s | 293 s (more tool rounds) |

The warm-up itself read 2,957 tokens in 201 s, starting 13 s after launch.
After a turn that used up its tool rounds, the last round has no tools, so
the next question shares only the system message (about 57%) - uncommon,
and noted here so it is not mistaken for the warm-up failing.

The live battery on the branch passed 12 of 13 (greeting 7 s, calculate
94 s, file write 177 s, file read 159 s, web fetch 67 s). The one failure is
not the warm-up's: after "forget my favourite colour", the model read the
colour back out of the conversation history, where the earlier "remember"
turn still is.

### Negative results — do not repeat this work

- **Node's fetch gives up at 300 s, whatever the model timeout says.**
  Found 2026-10-13: undici, inside Node's built-in fetch, drops a request
  whose response has not begun within 300 s, and nothing passed to `fetch()`
  changes that. The engine answers nothing until it has read the whole
  prompt, so on this PC every cold reply over five minutes failed as "the
  request failed" while `TRHAI_MODEL_TIMEOUT_MS=600000` was set - and the
  engine log shows the model finishing anyway, for nobody. Engine requests
  now go through `engineFetch.ts` (Node's `http`, no limit of its own; the
  caller's deadline decides). The 4B model's 409 s first reply works since.
  The note above that the 7B coder and the 8B "cannot load" here because
  "each attempt is a 300 s timeout" was this limit: try them again before
  believing it.
- **One connection per engine request.** The first version of
  `engineFetch.ts` used Node's default agent, which keeps connections open
  for reuse. The engine closes its side after each answer, so the model's
  second turn after a tool call went out on a dead connection and failed in
  0 ms with "socket hang up". It now uses a non-keep-alive agent and sends
  `Connection: close`; `engine-fetch.test.ts` has a server that closes like
  llama.cpp does.

- **Gating a tool out of the offer is not enough; enforce it at dispatch.**
  With `calculate` withheld for "what comes next: 2, 6, 12, 20, 30, ?", the
  model returned a `calculate` tool_call anyway - from habit, not from the
  list - and the loop ran it and answered 36. The dispatcher now refuses any
  call not in the turn's offered set (`offeredNames` in `agentLoop.ts`). Any
  new per-turn gate gets that enforcement for free; do not add a gate that
  only shapes the `tools` array.

- **Do not let the model run a memory deletion.** "forget that my printer is
  on the second floor" reached the model, which called `forget` with an empty
  fact, was told to fill it in, and answered with a call to every one of the
  twenty tools on offer, in listing order. The loop ran them: it built an app
  called "Forget", rendered a video and installed a global npm package through
  `run_command`, on a request to delete one sentence. Forgetting is now
  deterministic in `orchestrator.ts` (`resolveForget` + `forgetRequest.ts`):
  the request names a memory, the offer is held in `pendingConfirmation`, and
  "yes" deletes it - no model, no tools. Two caps in `agentLoop.ts` bound the
  failure class for everything else: a reply asking for more than
  `maxCallsPerRound` tools runs none of them, and only the first change
  (permission level 2+) in a reply is made - the rest wait for its result.
- **Deleting the memory is not the whole of forgetting it.** With the memory
  gone, "what is my api port?" was answered from the transcript ("You mentioned
  this earlier in our conversation: my api port is 9090"). The store now keeps
  what each session asked to forget (`listForgottenFacts`), and the composer
  drops those turns from its transcript search until the fact is stated again.
- **A tool refusal is read as the next instruction.** "forget was called with
  nothing to act on. Say exactly what it should apply to" made the model *state*
  the fact - through `remember` - in reply to a request to delete it. Refusals
  name the tool and the argument and say to call the same tool again.
- **Memory housekeeping never goes to the model.** Forget, pin/unpin, "what
  do you know about me", and "what did I just ask you" are all answered from
  the store or the transcript in `orchestrator.ts` (`resolveForget`,
  `resolvePin`, `resolveListMemories`, `resolveLastAsk`; parsers in
  `memoryRequests.ts`). Each was a live failure through the model: "mark the
  server room code as important" got "Got it." and nothing marked; "what do
  you know about me?" was read as a capability question, then answered "I
  don't have any specific information about you" with the facts in the
  session. "remember X, then list ..." now stores only X and answers the
  trailing clause (`trailingRequest` in `replyComposer.ts`).
- **Clock arithmetic is a tool.** qwen answered "3pm plus 2 hours 30 minutes"
  with 3:30 PM, and the date tools were the wrong shape (whole days). `shift_time`
  in `clockMath.ts` does it; it and the date tools are offered only when the
  request names a clock time / a date (`looksLikeClockMath`, `looksLikeDateMath`).
- **A sum is read out of the message, not handed to the model.** "What is 487
  times 263?" went to the model, which had to call `calculate` and say what came
  back: 377 s, then 531 s, on the PC with no graphics card. `answerArithmeticQuestion`
  (`arithmeticQuestion.ts`, tried in the orchestrator after unit conversions) answers a
  message that is a sum and nothing else, through the same evaluator the tool uses, in
  about 100 ms with no model running. It reads symbols and words ("times", "15% of
  80", "square root of 144", "subtract 5 from 12"), and leaves to the model anything
  with a unit, a date, a variable or a list ("2, 6, 12, 20"). A bare `3-5`, `4/5` or
  `3x4` is a range, a score or a size until the message asks for a calculation. The
  answer is strategy `arithmetic`, labelled "Worked out on this PC".
- **Today's date and the time are read off the clock, not asked of the model.**
  "What's today's date?" took 113 s on the PC with no graphics card, because the model
  had to call `current_datetime` first, and it has called it twice and then answered
  "Today's date is not recorded". `answerClockQuestion` (`clockQuestion.ts`, tried in the
  orchestrator after the weekday lookup) answers a message that is a date or time question
  and nothing else: "what time is it", "what day is it", "tell me the date and time". It
  says "It is 1:35 PM." and "Today is Thursday, October 15, 2026." in the PC's own way of
  writing a date, with strategy `calendar`. "What time is it in Tokyo" and "what day is
  it, and what is 2+2" still go to the model whole.
- **A request to open a page, or to play something on a service, is done off the model.**
  "Open spotify.com, and stream all the songs from the band Shadows of Ruin" came back, on a
  PC whose model did not take it, as the composer's four-step plan ("Clarify the end state for
  open spotify.com ..."). `parseOpenRequest` (`openSiteRequest.ts`, tried in the orchestrator
  after the saved-page lookup) reads a message that names the place outright: a domain with a web
  ending ("open github.com", "go to https://www.example.com:8080/a"), or a service's search
  ("play Shadows of Ruin on Spotify", "go to youtube.com and play some metal"). It builds the
  address itself from what was typed, so nothing a page or a model says can send the browser
  elsewhere, and `openInBrowser.ts` hands it to the system as one argument, never through a shell,
  and only if it is http or https. The reply is honest about the limit: playing is the person's
  button to press, because this has no way into their account on any service (and no key, by
  design), so it says "I can't press play for you" and opens the service's search. Not read as a
  request: "open the door", "open notes.txt" (an ending that is also a file extension - py, sh,
  md, pl, rs, zip - is not a web ending), "open spotify" (that could be the app), "play it on
  spotify" (names nothing), a question about a site. A schedule firing on a timer opens no window.
  Strategy `open`, labelled "Opened on this PC". `TRHAI_OPEN_BROWSER=off` makes the launcher
  refuse; the test setup sets it, so a test that forgets its stand-in cannot open a browser.
- **When no model can take a request, that is said; the generic plan is only for a request for a
  plan.** The composer's "Clarify the end state for ..." plan was the reply whenever the model
  attempt was "unavailable" - no engine, no model installed, or every installed model coming back
  with an empty reply - and the chat showed it as an answer ("Answered on this PC") under a status
  bar that says Online, which only means the API is up. For the generic plan (`planTaskType`
  "generic") on a message that does not ask for a plan (`asksForAPlan`), the reply is now strategy
  `failed` ("Not answered", with Retry): "I couldn't answer that just now. No local model: ...
  Nothing was changed, and I did not make a plan in its place. Try again in a moment; the model
  may still be starting." It carries the reason the attempt gave, and leaves out "try again" when
  the reason is that no model is installed. A request that asks for a plan, and one with a plan of
  its own kind (fix, migrate, test, ...), still gets its plan.
- **A tool that replaces a whole document is a tool that loses it.** Asked to
  add one line to a note, the model did not read the note and sent a body it
  made up; the user's text was gone. `update_document` now takes `append`, or
  `old_text`/`new_text`, and a whole replacement only with
  `replace_everything: true` (refused otherwise, with the current text handed
  back). `write_document` refuses a title that already exists.
- **A repeated change is not a second change.** One request produced four
  `add_schedule` calls across four rounds and four schedules. The loop now
  refuses a change with the same tool and arguments twice in a turn, and
  `add_schedule`/`build_app`/`make_video` once per turn; `add_schedule` also
  refuses a duplicate (same cadence and same name or prompt).
- **A request is a request whatever it opens with.** "now add a line...",
  "every weekday at 8am ask me...", "convert 5 miles to km" and "send an email
  to..." were all statements ("Got it."). `requestAnalysis.ts` steps over a
  leading connective, treats a cadence opener as a command, and knows the
  ordinary imperatives; recall phrases still win ("remind me what we decided").
  Email, messages, calls and purchases get a plain "I can't" from the composer.
- **Tools are offered by what the request is about.** `fetch_url` was called
  on a file path, `build_app` on "add a line to it", `current_datetime` twice
  on a question about ports. Offers now follow `mentionsWeb`, `mentionsTime`,
  and scaffolding only for a generate request or one naming no action.
- **A killed smoke test orphans the app's server.** `buildVerification.ts` now
  kills the whole tree (`taskkill /T` on Windows); a leaked `node server.js`
  had held a workspace folder open for hours.
- **"it" is resolved mechanically, at the orchestrator.** "read notes.txt"
  then "now add a line saying omega to the end of it": the model was told the
  path in the prompt and still called read_file on `D:\Vexora
otes.txt`,
  then `D:\Vexora\workspace
otes.txt`, or fell back to write_document.
  `activeProject.ts` tracks the last file each session touched
  (`noteFileTouched`/`resolveFilePronoun`), the orchestrator resolves the
  pronoun before the composer's plan check, and `context.impliedFile` lets the
  file tools correct a same-name-wrong-place path (`impliedFileFor`). Also:
  the composer's create plan appended "Do not stop at explaining what it would
  contain" to the request, and "contain" made `classifyIntent` read it as a
  request for a file's contents - so the tools that write were withheld from a
  request to write. Plan instructions are now gated on the resolved text.
- **`edit_file` takes `append`.** Adding a line was tried as a replacement
  three times (old_text "beta
", "omega
", "") and failed each time.
- **An invented tool call is a reply in disguise.** `{"name":"send_message",
  "arguments":{"text":"..."}}` reached the user verbatim; `unwrapPseudoReply`
  in `agentLoop.ts` takes the sentence out. A text-written tool call on the
  final round is "kept searching", not "empty reply" - the latter switched
  models and the second model did the work again.
- **Trace with `ASSIST_DEBUG=1`.** The loop logs each round's calls, text,
  dispatch decisions and tool results as `[agent]` lines. Three failures in
  this round were misdiagnosed from replies alone before the trace existed.
- **`add_schedule` supports `weekdays_only`** (cadence `weekdaysOnly`); a
  duplicate schedule is reported as already done (`ok: true`), because refused
  as a duplicate the model reworded the prompt until one got past the check.
- **An app is changed by rebuilding it from its spec, never by the model
  editing generated code.** "add a 'notes' text field to the plants" right
  after a build made a second app called "Notes Text Field". `change_app`
  (`packages/shared/src/projectChange.ts` + the tool in `agentTools.ts`)
  reads `.vexora-app.json` in the app folder (request, title, changes),
  applies the change to the plan (field add/remove, feature add) and
  regenerates the same folder with `data/` untouched. The README is for
  people and the model overwrote it three times in one turn - do not store
  anything the app depends on there. `build_app` did not even record the
  active project (a bare folder name was not "inside a project"); fixed in
  `projectForPath`. Requests that say "it"/"its"/"the app"/"add X" with a
  project active are spelled out by `resolveProjectReference`.
- **A question gets no tool that writes.** "which file defines
  classifyIntent?" led read_file to miss and write_file to CREATE
  `classifyIntent.js` in the source tree. `availableTools({ writes: false })`
  withholds the writers from a question; `run_command` stays, because "is
  anything listening on port 4000?" is answered by the machine. `remember`
  is offered only when the request asks to remember (`asksToRemember`); the
  model had saved a note to itself as the user's fact.
- **cmd.exe does not change drive on `cd D:\...`.** `cd D:\app && npm test`
  from C: ran in the home folder ("Missing script: test"). `crossDrive` in
  `commandRunner.ts` inserts `/d`; `forShell` wraps a bare PowerShell cmdlet
  (`Get-PSDrive D`) in `powershell -NoProfile -Command`. `wmic` is gone on
  this Windows; the prompt says so. Generated apps now have `npm test`.
- **`search_files` exists** because `findstr` with forward slashes printed
  nothing and the model went to `search_memory` for code. `list_files` lists
  a folder's own entries (folders first, alphabetical) unless
  `recursive: true`; the old newest-first deep listing answered "list the
  top-level folders in D:/trhai" with `apps/api/data/tasks.json`.
- **A narrated command is pushed to be run** (`narratesACommand`), except
  after a build, where "you can run it with npm start" is for the user; the
  loop refuses `npm start`/`node server.js` and any write into the app in
  the turn that built it. A bare `run_command <command>` line is parsed as
  the call; a prompt example path (`D:/projects`) was removed because the
  model read three files under it.
- **ffmpeg cannot rasterize SVG here.** The `svg_pipe` *demuxer* is listed, which
  is misleading: this build has no SVG *decoder* (no librsvg). Piping SVG frames
  fails with `no decoder found for: svg`. Do not design around SVG input.
- **`win.capturePage()` returns 1920x1032, not 1080**, because the window size
  includes chrome. Pass `useContentSize: true` to `BrowserWindow`.
- **The front of the prompt must not change between questions.** The engine
  reuses whatever prefix two prompts share, and that is the difference between
  a reply in seconds and one in minutes on a CPU. The system message carried
  the date *and the minute*, so the front changed every 60 s and nothing was
  ever reused. The clock now goes with the question, and only when the
  question is about the time (#99). Measured: the same 1,316-token prompt took
  88 s cold and 2.8 s reused.
- **`fit` mode assumes a graphics card.** With none, the engine hands a model
  its full training window and the KV cache lands in system RAM. Set
  `TRHAI_CONTEXT_TOKENS` on a CPU-only PC; the preset floors it at 8192.
- **`TRHAI_MODEL` was not winning for code work.** Anything that looked like
  code work (build/code modes, a path, "the file") put the coding model in
  front of the pin, and `build_app` picked the coder outright. On a PC where
  the coder cannot load that is a 300 s timeout before the pinned model is
  asked at all. `pinnedModel`/`withCoderFirst` in `localModel.ts` keep the
  env pin first with the coder right behind it (#104). A model a *conversation*
  chose is deliberately not treated the same: file work still goes to the
  coder ahead of it (`web-address.test.ts` says so).
- **A timed-out request can leave the next one queued.** The engine has one
  slot; the live battery saw a cold start time out and the warm request
  behind it time out too. The 600 s limit on this PC is there so a slow reply
  stays a slow reply.

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

## Task 1 — Video studio (implemented; real smoke passed)

The user asked for video "like a triple-A studio". **Local generative
text-to-video is not achievable on this hardware** and should not be attempted:
those models want 8–24 GB of *free* VRAM, this machine has roughly 2 GB free
while the assistant is loaded, and the PyTorch/CUDA stack breaks constraints 1
and 3. Say that plainly if asked. Do not quietly build a poor version of it.

What **is** achievable, and what is built now: a **motion-graphics studio** that
scripts, narrates, renders and encodes — entirely locally, at true 1080p.

Status as of 2026-09-01: the pipeline exists in
`packages/shared/src/videoScript.ts`, `apps/api/src/services/frameRenderer.ts`,
and `apps/api/src/services/videoRender.ts`; `make_video` is registered in the
agent tool loop, permissioned as level 2, and reported through
`/v1/capabilities` as `videoRendering`. The user-facing capability reply also
names the local motion-graphics tool.

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

Real smoke result on 2026-09-01: `npm run smoke:video` passed in 25.1s and
rendered 59 frames / 4.9s / 119011 bytes to a temporary MP4 through the real
local stack.

---

## Task 2 — CI (done)

`.github/workflows/ci.yml` runs on every PR to `master` and has been green on
every one since #97 (install, build, lint, typecheck, tests, PowerShell parse).
The actions are on v7 (#106). Node 22 in CI has not differed from local Node 24
so far. Pushing a workflow change needs the `workflow` OAuth scope on the
`gh` sign-in; it has it on this PC now.

---

## Task 3 — Decide on the orphaned code (mostly resolved)

Two of the four modules this task listed are wired now: `automation.ts` is
behind the Automation view (`flowStore`, `scheduler`), and `marketplace.ts` is
the agent catalogue (chosen in Settings; also read by TRH World). Still with
no consumer in `apps/`:

| Module | Lines |
|---|---|
| `localCalendar.ts` | 159 |
| `knowledgeImport.ts` | 140 (three helpers are used; `prepareImport`/`summarizeImport` are not) |

**This is the user's decision, not an agent's** — wire them in or delete them
with their tests. Do not leave them drifting.

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
npm test              # expect ~2,429 tests, 0 failures
npm run build         # all workspaces
```

Run all four. They catch different things: a CSS syntax error takes the build
down while leaving lint, types and every test untouched. That has happened here.

**Everything TRH AI needs, checked live:** `GET /v1/system/operations` (and the
"Everything TRH AI needs" panel in the System view) reads API, web app,
desktop shell, engine and model, Piper, Whisper, ffmpeg, workspace, saved
data, schedules, free memory and disk, with a fix for anything not ok (#100).
`npm run doctor` is the offline version. `npm run smoke:web-stack` and
`npm run smoke:video` exercise the real stack.

**TRH World** is a separate project (`D:\trhworld`, repo
`Trhpruductions/trhworld`), not part of this repo (#102, #103). It reads only
`GET /v1/world`, which this API computes from the execution log and the
agent the last request named (`services/worldState.ts`, rules in
`@ascend/shared` `agentWorld`). Keep that endpoint: it is the World's only
data.

**Test isolation:** run API tests with `npm test`, never a bare
`npx tsx --test <file>`. The isolation keeping tests off the user's real
machine-access grant is carried by an `--import` flag on the npm script. There is
a `NODE_TEST_CONTEXT` fallback in `commandRunner.ts` now, but prefer `npm test`.

**After changing `apps/trhai-web`, rebuild *and restart* the server on 3210.**
`npm run start` (scripts/serve.mjs, Next's own handler) reads the build once at
boot; a rebuild alone changes nothing on screen and you will chase a phantom.

**Only this PC can reach TRH AI.** The API, the web app and every app TRH AI runs
listen on 127.0.0.1 and ::1, never on every address: the API answers anyone who
can reach it, and with machine access on it runs commands without asking. Both
loopback addresses, because `localhost` resolves to ::1 first on Windows and a
refused connection there costs about 2 s per request. Apps are kept local by a
`--require` preload (`apps/api/src/services/loopbackOnly.cjs`) as well as by the
generator, because older apps in the workspace name no address.
`ASCEND_NETWORK_ACCESS=on` lets other devices reach the API, each request then
carrying the access key shown under Network.
