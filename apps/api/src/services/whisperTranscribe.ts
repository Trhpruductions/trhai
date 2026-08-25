import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

// Speech to text, running on this machine.
//
// The browser has its own SpeechRecognition, it is free, and it needs no key —
// which is exactly why it is a trap. Chrome implements it by streaming the
// microphone to Google's servers. Using it would have cost nothing and passed
// every test in this repo, while quietly breaking the one promise the rest of
// the build keeps: that nothing leaves this machine.
//
// whisper.cpp is the honest answer, and it is the same shape as Piper next
// door: an open-source binary, run locally, no account, no key, no network at
// runtime. Optional by design — nothing here downloads or installs anything.
// If the binary or a model is missing this says so plainly and the interface
// keeps the microphone as a level meter rather than pretending to hear words.
//
// The command is fixed. The audio goes in as a file this module wrote to a
// temp directory it created, and the model is a path resolved from a
// directory listing — no part of a request ever reaches the command line.

export type WhisperModel = {
  /** The model's file stem, e.g. "ggml-base.en". Stable, and the id clients send. */
  id: string;
  /** e.g. "base". */
  size: string;
  /** True for the English-only builds, which are more accurate on English. */
  englishOnly: boolean;
  modelPath: string;
};

export type WhisperStatus =
  | { available: true; model: WhisperModel; models: WhisperModel[]; binaryPath: string }
  | { available: false; reason: string };

/** Where an install is expected. Overridable, so a different layout still works. */
export function whisperRoot(): string {
  const configured = process.env.VEXORA_WHISPER_DIR;
  if (configured) return configured;

  const home = homedir();
  return home ? path.join(home, "Vexora", "whisper") : path.join(process.cwd(), "whisper");
}

/**
 * The executable, whichever name this build uses.
 *
 * whisper.cpp renamed its CLI from `main` to `whisper-cli` in 2024 and ships
 * both names in some packagings. Checking for both means an install from
 * either era works without the user having to know which one they have.
 */
export function binaryPath(): string | null {
  const root = whisperRoot();
  const executables = process.platform === "win32"
    ? ["whisper-cli.exe", "main.exe"]
    : ["whisper-cli", "main"];

  for (const name of executables) {
    // Some builds put the binary in a build/bin subdirectory rather than the
    // root; both are checked so an unmodified upstream build tree works.
    for (const candidate of [path.join(root, name), path.join(root, "build", "bin", name)]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * How each model size ranks for this particular job.
 *
 * Deliberately NOT "bigger is better", which is the obvious ordering and the
 * wrong one here. This transcribes short spoken commands on whatever CPU the
 * user has, and a large model can take longer to transcribe a sentence than
 * it took to say it — accurate and useless. Small and base are the sizes that
 * are fast enough to feel like voice input while still getting ordinary
 * speech right. VEXORA_WHISPER_MODEL overrides all of this when someone wants
 * a specific tradeoff.
 */
const sizeRank: Record<string, number> = {
  small: 5,
  base: 4,
  medium: 3,
  tiny: 2,
  large: 1
};

/**
 * Read a model out of a filename.
 *
 * whisper.cpp names models `ggml-<size>[.en][-<variant>].bin`, e.g.
 * "ggml-base.en.bin" or "ggml-large-v3.bin". Returns null for anything that
 * does not parse rather than inventing a name for it.
 */
export function describeModelFile(fileName: string): Omit<WhisperModel, "modelPath"> | null {
  if (!fileName.startsWith("ggml-") || !fileName.endsWith(".bin")) return null;

  const stem = fileName.slice(0, -".bin".length);
  const rest = stem.slice("ggml-".length);
  if (!rest) return null;

  // "large-v3" and "base.en" both need the leading size word, which is
  // whatever comes before the first dot or hyphen.
  const size = rest.split(/[.-]/)[0];
  if (!size) return null;

  return { id: stem, size, englishOnly: rest.includes(".en") };
}

/** Every usable model on disk, best first. */
export function installedModels(): WhisperModel[] {
  const root = whisperRoot();
  const searchDirs = [root, path.join(root, "models")];

  const models: WhisperModel[] = [];
  const seen = new Set<string>();

  for (const directory of searchDirs) {
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const described = describeModelFile(entry);
      if (!described || seen.has(described.id)) continue;
      seen.add(described.id);
      models.push({ ...described, modelPath: path.join(directory, entry) });
    }
  }

  return models.sort((left, right) => {
    const bySize = (sizeRank[right.size] ?? 0) - (sizeRank[left.size] ?? 0);
    if (bySize !== 0) return bySize;
    // Among equal sizes the English-only build is more accurate on English,
    // which is what this app is being spoken to in.
    if (left.englishOnly !== right.englishOnly) return left.englishOnly ? -1 : 1;
    return left.id.localeCompare(right.id);
  });
}

/** What is actually installed, and what is missing when it is not. */
export function whisperStatus(): WhisperStatus {
  const binary = binaryPath();
  if (!binary) {
    return { available: false, reason: "whisper.cpp is not installed on this machine." };
  }

  const models = installedModels();
  if (models.length === 0) {
    return { available: false, reason: "whisper.cpp is installed but no model was found." };
  }

  // An explicit preference wins, but only if it is actually there — falling
  // back silently would make a configured choice look like it took when it
  // did not.
  const preferred = process.env.VEXORA_WHISPER_MODEL;
  const chosen = preferred ? models.find((model) => model.id === preferred) : undefined;

  return { available: true, model: chosen ?? models[0], models, binaryPath: binary };
}

export type TranscriptionResult =
  | { ok: true; text: string; model: string }
  | { ok: false; reason: string };

/** A spoken command, not a podcast. Bounded so nothing runs away. */
export const maxAudioBytes = 10 * 1024 * 1024;
/** Generous on a slow CPU, still bounded. */
const transcribeTimeoutMs = 120_000;

/** What whisper.cpp requires, and what the client is expected to send. */
export const requiredSampleRate = 16_000;
export const requiredChannels = 1;

export type WavHeader = { sampleRate: number; channels: number; bitsPerSample: number };

/**
 * Read a WAV header, or explain why this is not one.
 *
 * whisper.cpp accepts 16 kHz mono PCM and nothing else, and its own error for
 * the wrong format is obscure. Checking here means a mismatch is reported in
 * words the caller can act on rather than as an exit code.
 */
export function readWavHeader(audio: Buffer): WavHeader | null {
  // "RIFF" .... "WAVE" — 12 bytes before any chunk, then chunks of
  // (4-byte id, 4-byte size, payload).
  if (audio.length < 44) return null;
  if (audio.toString("ascii", 0, 4) !== "RIFF") return null;
  if (audio.toString("ascii", 8, 12) !== "WAVE") return null;

  let offset = 12;
  while (offset + 8 <= audio.length) {
    const id = audio.toString("ascii", offset, offset + 4);
    const size = audio.readUInt32LE(offset + 4);

    if (id === "fmt ") {
      if (offset + 8 + 16 > audio.length) return null;
      return {
        channels: audio.readUInt16LE(offset + 10),
        sampleRate: audio.readUInt32LE(offset + 12),
        bitsPerSample: audio.readUInt16LE(offset + 22)
      };
    }

    // Chunks are word-aligned: an odd size is followed by a pad byte.
    offset += 8 + size + (size % 2);
  }

  return null;
}

/**
 * Strip whisper.cpp's own decorations from a transcript.
 *
 * Even with timestamps off it emits bracketed non-speech markers — [BLANK_AUDIO],
 * [MUSIC], (wind blowing) — which are descriptions of the recording, not words
 * the user said. Passing them through would put "[BLANK_AUDIO]" in the command
 * box as though it had been spoken.
 */
export function cleanTranscript(raw: string): string {
  return raw
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Transcribe WAV audio, returning what was said.
 *
 * The audio is written to a temp file rather than piped, because whisper.cpp
 * takes a path and seeks within it. Nothing about the request reaches the
 * command line: the input path is one this function generated, and the model
 * path came from a directory listing.
 */
export async function transcribe(audio: Buffer): Promise<TranscriptionResult> {
  const status = whisperStatus();
  if (!status.available) return { ok: false, reason: status.reason };

  if (!Buffer.isBuffer(audio) || audio.length === 0) {
    return { ok: false, reason: "There was no audio to transcribe." };
  }
  if (audio.length > maxAudioBytes) {
    return { ok: false, reason: "That recording is too long to transcribe in one go." };
  }

  const header = readWavHeader(audio);
  if (!header) {
    return { ok: false, reason: "That audio is not a WAV file this can read." };
  }
  if (header.sampleRate !== requiredSampleRate || header.channels !== requiredChannels) {
    return {
      ok: false,
      reason: `Audio must be ${requiredSampleRate / 1000} kHz mono; this is `
        + `${Math.round(header.sampleRate / 100) / 10} kHz with ${header.channels} channel(s).`
    };
  }

  const workDir = mkdtempSync(path.join(tmpdir(), "vexora-listen-"));
  const inputPath = path.join(workDir, "speech.wav");
  const outputPrefix = path.join(workDir, "transcript");

  try {
    writeFileSync(inputPath, audio);

    const failure = await new Promise<string | null>((resolve) => {
      const child = spawn(
        status.binaryPath,
        [
          "-m", status.model.modelPath,
          "-f", inputPath,
          // Plain text out, no timestamps: this becomes a typed command, not
          // a subtitle track.
          "-otxt",
          "-of", outputPrefix,
          "-nt",
          // Threads left to whisper.cpp's own default, which reads the machine.
          // Language forced to English only for the .en builds, which cannot
          // do anything else anyway; a multilingual model is left to detect.
          ...(status.model.englishOnly ? ["-l", "en"] : [])
        ],
        {
          // Fixed executable, fixed flags, and every variable part is a path
          // this module built itself.
          shell: false,
          windowsHide: true,
          cwd: whisperRoot()
        }
      );

      const timer = setTimeout(() => {
        child.kill();
        resolve("Transcription took too long and was stopped.");
      }, transcribeTimeoutMs);

      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

      child.on("error", (error) => {
        clearTimeout(timer);
        resolve(`whisper.cpp could not be started: ${error.message}`);
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        // whisper.cpp logs its progress to stderr on success, so a non-zero
        // exit is the signal, not the presence of stderr output.
        resolve(code === 0 ? null : `whisper.cpp exited with code ${code}. ${stderr.slice(-200)}`.trim());
      });
    });

    if (failure) return { ok: false, reason: failure };

    const transcriptPath = `${outputPrefix}.txt`;
    if (!existsSync(transcriptPath)) {
      return { ok: false, reason: "whisper.cpp reported success but produced no transcript." };
    }

    const text = cleanTranscript(readFileSync(transcriptPath, "utf8"));
    if (!text) {
      // A real outcome, not a fault: the microphone was open and nothing
      // intelligible was said. Reported as such so the caller can say so
      // rather than showing an empty box and looking broken.
      return { ok: false, reason: "No speech was recognised in that recording." };
    }

    return { ok: true, text, model: status.model.id };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "Transcription failed." };
  } finally {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* a temp file is not worth failing over */ }
  }
}
