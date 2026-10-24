# The neural voice

Vexora can read replies aloud in a voice that sounds like a person, using
[Piper](https://github.com/rhasspy/piper) — an open-source neural
text-to-speech engine that runs as a local process.

It is **optional**. Without it the app falls back to the browser's own speech
synthesis and says which engine it is using. Nothing here needs an account, an
API key, or a network connection at speaking time.

## Why it exists

The browser's `speechSynthesis` is genuinely local, but it can only use the
voices the operating system has installed. A Windows machine with only the
legacy SAPI voices — David, Mark, Zira — has no better option available, and
no amount of rate and pitch adjustment fixes it: that is the engine, not the
settings. Piper replaces the engine.

## Installing it

Neither the binary nor the voice models are in this repository — the models are
60–120 MB each.

**On Windows, TRH AI installs them for you.** The first-run screen offers the
voice ticked, and *Settings → Engine and models* installs it at any time: Piper
2023.11.14-2 and the Cori voice (British English, high quality), 130 MiB
together, each file checked against a pinned size and SHA-256 before it is used.
It needs no restart; `GET /v1/speech` reports the voice straight away. Cori is
public domain and Piper is MIT, so both may be used commercially. The most used
Piper voice, Ryan, is CC BY-NC-SA, so it is not offered. See
`23-install-story.md`, M2b.

By hand, which is also how to add another voice:

1. Download `piper_windows_amd64.zip` from the
   [Piper releases page](https://github.com/rhasspy/piper/releases) and extract
   it so that `piper.exe` ends up at `%USERPROFILE%\Vexora\piper\piper\`.
2. Download at least one voice from
   [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices). Each
   voice is **two** files that must sit next to `piper.exe`:
   - `<voice>.onnx`
   - `<voice>.onnx.json`

   A model without its companion `.json` cannot be loaded, so the app skips it
   rather than offering a voice that would produce silence.

Voices are published at several quality tiers (`x_low`, `low`, `medium`,
`high`). The tier is the single biggest factor in how human it sounds. `high`
takes roughly five times longer to generate than `medium` and is still far
faster than real time.

No administrator rights are needed, and nothing is installed system-wide.

## Configuration

All optional:

| Variable | Meaning |
| --- | --- |
| `VEXORA_PIPER_DIR` | Where the binary and models live. Defaults to `%USERPROFILE%\Vexora\piper\piper`. |
| `VEXORA_PIPER_VOICE` | Which voice id to prefer, e.g. `en_GB-alan-medium`. |

When `VEXORA_PIPER_VOICE` names a voice that is not installed, the app falls
back to the best available one — it never reports the requested voice as having
been used.

## How voices are ranked

`GET /v1/speech` lists every usable voice, best first: quality tier descending,
then British locales ahead of others, then by id so the default does not move
around between reads. The user can override the ranking from Settings, and the
choice persists.

## How it sounds

Speed, expression and pausing are applied **inside the model**, not by changing
playback speed in the browser — that would shift the pitch and undo the reason
for using a neural voice at all.

Each personality carries a `cadence`, and it drives the delivery:

| Cadence | Character |
| --- | --- |
| `playful` | Lively and varied, little air between sentences |
| `brisk` | Quick and light on pauses |
| `measured` | Calm and even — the default |
| `deliberate` | Precise and unhurried, longer pauses |

A flat, evenly-clipped delivery is most of what people mean when they call a
synthetic voice robotic, so every cadence keeps some variation in both
expression and rhythm. There is a test asserting exactly that.

## Safety notes

- The Piper executable and its arguments are fixed. The text to speak is
  written to **stdin**, never onto the command line, so no part of a reply is
  ever parsed as a command-line token.
- A requested voice id is matched against models found on disk; the path that
  reaches the process is always one the server built from a directory listing,
  never a string from the request.
- Synthesis is bounded by both a character limit and a timeout.

## API

`GET /v1/speech` — what is installed:

```json
{ "data": { "available": true, "voice": "en_GB-cori-high",
            "voices": [{ "id": "en_GB-cori-high", "name": "Cori",
                         "locale": "en_GB", "quality": "high" }],
            "maxCharacters": 2000 } }
```

`POST /v1/speech` — `{ text, voiceId?, rate?, expressiveness?, cadence? }`
returns `audio/wav`, with an `X-Speech-Voice` header naming the voice that
actually spoke. When Piper is not installed it returns **503** with the reason,
which is a state of the machine rather than a fault in the request.
