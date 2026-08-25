# Local transcription

TRHAI can hear you, using
[whisper.cpp](https://github.com/ggml-org/whisper.cpp) — an open-source
speech-to-text engine that runs as a local process.

It is **optional**. Without it the microphone still opens and drives the core
and the waveform as a level meter, and the interface says plainly that
transcription is not installed rather than offering a button that would hear
nothing. Nothing here needs an account, an API key, or a network connection at
listening time.

## Why it exists, and why not the browser's own

Every browser ships `SpeechRecognition`. It is free, it needs no key, and it
would have been perhaps thirty lines instead of this. It was rejected on
purpose.

Chrome implements `SpeechRecognition` by **streaming the microphone to
Google's servers**. It would have passed every test in this repository —
including `no-paid-dependencies`, which looks for API keys and hosted SDKs and
would have found neither — while quietly breaking the single promise the rest
of the build keeps: that nothing leaves this machine.

whisper.cpp is the same shape as Piper next door: an open-source binary, run
locally, nothing uploaded. The install is manual for the same reason Piper's
is — the models are large and the app does not download things on your behalf.

## Installing it

Neither the binary nor the models are in this repository, and nothing in the
app fetches them for you.

1. Get a `whisper.cpp` build. Either download a prebuilt release from the
   [releases page](https://github.com/ggml-org/whisper.cpp/releases), or build
   from source. Put it so the executable ends up at either:
   - `%USERPROFILE%\Vexora\whisper\whisper-cli.exe`, or
   - `%USERPROFILE%\Vexora\whisper\build\bin\whisper-cli.exe` (an unmodified
     build tree works as-is)

   Older builds name the executable `main` instead of `whisper-cli`; both names
   are recognised, so an install from either era works without you having to
   know which one you have.

2. Download at least one model from
   [ggerganov/whisper.cpp on Hugging Face](https://huggingface.co/ggerganov/whisper.cpp)
   and put it next to the binary, or in a `models\` subdirectory beside it.
   Models are named `ggml-<size>[.en].bin`.

   **`ggml-base.en.bin` (~150 MB) is the recommended starting point.**

Restart the API after installing. `GET /v1/transcribe` reports what it found.

## Which model gets picked

Best-first, but *not* simply biggest-first — which is the obvious ordering and
the wrong one here. This transcribes short spoken commands on whatever CPU you
have, and a `large` model can take longer to transcribe a sentence than it took
to say it: accurate and useless.

The order is `small`, `base`, `medium`, `tiny`, `large` — the sizes that are
fast enough to feel like voice input while still getting ordinary speech right.
Among equal sizes the `.en` build wins, being more accurate on the English this
app is spoken to in.

Set `VEXORA_WHISPER_MODEL` to a model id (e.g. `ggml-small.en`) to override.
An id that is not actually installed falls back to the default rather than
failing silently — a configured choice that did not take should not look like
it did.

## Configuration

| Variable | Meaning |
| --- | --- |
| `VEXORA_WHISPER_DIR` | Where the binary and models live. Defaults to `%USERPROFILE%\Vexora\whisper`. |
| `VEXORA_WHISPER_MODEL` | A specific model id to prefer, e.g. `ggml-small.en`. |

## How the audio gets there

whisper.cpp accepts 16 kHz mono 16-bit PCM WAV and nothing else. Browsers
record at the device's own rate — usually 44.1 or 48 kHz — and `MediaRecorder`
produces WebM/Opus, which whisper cannot read at all.

The conversion happens **in the browser** (`apps/trhai-web/src/lib/wav.ts`):
raw samples are captured from the audio graph, resampled by linear
interpolation, and encoded as WAV. The obvious alternative was ffmpeg on the
server, and this avoids it — the point is that the only thing you have to
install is whisper itself.

The server validates the WAV header before spawning anything, so a format
mismatch is reported in words you can act on rather than as an exit code.

## What it does with what you said

The transcript is put **in the command box** for you to check and send. It is
not sent automatically.

A transcript is a guess at speech, and firing a request off a guess the user
has not seen is how a voice feature does something they did not ask for.

whisper's own non-speech markers — `[BLANK_AUDIO]`, `[MUSIC]`,
`(wind blowing)` — are stripped, since they describe the recording rather than
being words anyone said. If nothing intelligible was heard, that is reported as
such rather than leaving an empty box that looks broken.

## Security

The executable and its flags are fixed. The audio goes in as a file this code
wrote to a temp directory it created, and the model is a path resolved from a
directory listing — no part of a request ever reaches the command line, so the
injection question does not arise rather than being defended against. The temp
directory is removed after every call.
