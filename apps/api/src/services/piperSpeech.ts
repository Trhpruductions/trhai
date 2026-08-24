import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

// Neural speech, running on this machine.
//
// The browser's own speech synthesis works and is genuinely local, but it can
// only use the voices Windows has installed, and on a machine with just the
// legacy SAPI voices it sounds like a speech synthesizer from 2003. Piper is
// an open-source neural engine: no account, no key, no network at runtime,
// and it sounds like a person.
//
// It is optional by design. Nothing here downloads or installs anything — if
// the binary and a voice model are not present, this reports that plainly and
// the interface falls back to the browser's own voices. An app that silently
// did nothing, or claimed to speak while producing no sound, would be the
// failure this codebase is built to avoid.
//
// The command is fixed and the text goes in over stdin, never on the command
// line. That is the same rule the desktop workspace checks follow: the caller
// chooses *whether* to synthesize and picks from voices found on disk, never
// any part of what is executed.

export type VoiceQuality = "x_low" | "low" | "medium" | "high";

export type NeuralVoice = {
  /** The model's file stem, e.g. "en_GB-alan-medium". Stable, and the id clients send. */
  id: string;
  /** Just the speaker, e.g. "Alan". */
  name: string;
  /** e.g. "en_GB". */
  locale: string;
  quality: VoiceQuality;
  modelPath: string;
};

export type PiperStatus =
  | { available: true; voice: NeuralVoice; voices: NeuralVoice[]; binaryPath: string }
  | { available: false; reason: string };

/** Where an install is expected. Overridable, so a different layout still works. */
export function piperRoot(): string {
  const configured = process.env.VEXORA_PIPER_DIR;
  if (configured) return configured;

  const home = homedir();
  return home ? path.join(home, "Vexora", "piper", "piper") : path.join(process.cwd(), "piper");
}

function binaryPath(): string {
  return path.join(piperRoot(), process.platform === "win32" ? "piper.exe" : "piper");
}

/**
 * How good a voice is likely to sound.
 *
 * Piper publishes each voice at several quality tiers, and the tier is the
 * single biggest factor in whether it sounds like a person. Higher wins.
 */
const qualityRank: Record<VoiceQuality, number> = { high: 4, medium: 3, low: 2, x_low: 1 };

function parseQuality(value: string): VoiceQuality {
  if (value === "high" || value === "medium" || value === "low" || value === "x_low") return value;
  // An unfamiliar tier is more likely to be a new high one than an old low
  // one, but guessing upward would promote it over a known-good voice. Medium
  // is the honest middle.
  return "medium";
}

/**
 * Read a voice out of a model filename.
 *
 * Piper names models `locale-speaker-quality.onnx`, and the speaker part may
 * itself contain hyphens or underscores. Returns null for anything that does
 * not parse, rather than inventing a name for it.
 */
export function describeVoiceFile(fileName: string): Omit<NeuralVoice, "modelPath"> | null {
  if (!fileName.endsWith(".onnx")) return null;

  const stem = fileName.slice(0, -".onnx".length);
  const parts = stem.split("-");
  if (parts.length < 3) return null;

  const locale = parts[0];
  const quality = parts[parts.length - 1];
  const speaker = parts.slice(1, -1).join("-");
  if (!locale || !speaker) return null;

  return {
    id: stem,
    // "northern_english_male" reads better as words than as a filename.
    name: speaker
      .split(/[_-]/)
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" "),
    locale,
    quality: parseQuality(quality)
  };
}

/**
 * Every usable voice on disk, best first.
 *
 * A model without its companion JSON is skipped rather than listed: piper
 * cannot load one, so offering it would mean a voice in the picker that
 * produces nothing.
 */
export function installedVoices(): NeuralVoice[] {
  const root = piperRoot();

  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }

  const voices: NeuralVoice[] = [];
  for (const entry of entries) {
    const described = describeVoiceFile(entry);
    if (!described) continue;

    const modelPath = path.join(root, entry);
    // The companion JSON carries the sample rate and phoneme map.
    if (!existsSync(`${modelPath}.json`)) continue;

    voices.push({ ...described, modelPath });
  }

  return voices.sort((left, right) => {
    const byQuality = qualityRank[right.quality] - qualityRank[left.quality];
    if (byQuality !== 0) return byQuality;
    // Among equals, the British voices first: this is an assistant, and that
    // is the register the user asked for. Stable beyond that so the default
    // does not move around between reads.
    const leftBritish = left.locale === "en_GB" ? 0 : 1;
    const rightBritish = right.locale === "en_GB" ? 0 : 1;
    if (leftBritish !== rightBritish) return leftBritish - rightBritish;
    return left.id.localeCompare(right.id);
  });
}

/** What is actually installed, and what is missing when it is not. */
export function piperStatus(): PiperStatus {
  const binary = binaryPath();
  if (!existsSync(binary)) {
    return { available: false, reason: "Piper is not installed on this machine." };
  }

  const voices = installedVoices();
  if (voices.length === 0) {
    return { available: false, reason: "Piper is installed but no voice model was found." };
  }

  // An explicit preference wins, but only if it is actually there — falling
  // back silently to a different voice would make a configured choice look
  // like it took when it did not.
  const preferred = process.env.VEXORA_PIPER_VOICE;
  const chosen = preferred ? voices.find((voice) => voice.id === preferred) : undefined;

  return { available: true, voice: chosen ?? voices[0], voices, binaryPath: binary };
}

export type SynthesisResult =
  | { ok: true; audio: Buffer; format: "wav"; voice: string }
  | { ok: false; reason: string };

/** Long enough for an answer, short enough that nothing hangs on a runaway reply. */
export const maxSynthesisCharacters = 2000;
/** Generous even for a high-quality model, and still bounded. */
const synthesisTimeoutMs = 60_000;

/** How a personality carries itself. Drives pacing and expression, not words. */
export type Cadence = "measured" | "brisk" | "playful" | "deliberate";

export type SynthesisOptions = {
  /** Which installed voice. Falls back to the best available when unknown. */
  voiceId?: string;
  /**
   * Speaking speed, 1 being the voice's own pace.
   *
   * Applied inside the model rather than by changing playback speed in the
   * browser, which would shift the pitch and undo the reason for using a
   * neural voice at all.
   */
  rate?: number;
  /** How much the delivery varies. Higher is livelier; lower is flatter. */
  expressiveness?: number;
  cadence?: Cadence;
};

/**
 * Convert a rate to Piper's length scale.
 *
 * Length scale is duration, so it runs the other way: a higher rate means
 * shorter phonemes. Clamped, and always formatted by this function — the
 * number reaches the command line as something this module produced, never as
 * caller text.
 */
export function lengthScaleFor(rate: number | undefined): string {
  const safe = typeof rate === "number" && Number.isFinite(rate) ? rate : 1;
  const clamped = Math.min(2, Math.max(0.5, safe));
  return (1 / clamped).toFixed(3);
}

/**
 * How a cadence sounds.
 *
 * Every personality has carried a cadence since personalities were added, and
 * nothing ever read it. This is what reads it — and it is the difference
 * between a voice that is merely clear and one that sounds like it means
 * something. A flat delivery is most of what people are hearing when they call
 * a synthetic voice robotic.
 *
 * `expression` is the run-to-run variation in the generated audio, and `rhythm`
 * the variation in how long each sound is held. Real speech has both; a
 * synthesizer with neither is what a robot sounds like.
 */
export function deliveryFor(cadence: Cadence | undefined): {
  expression: number;
  rhythm: number;
  sentencePause: number;
} {
  switch (cadence) {
    // Lively and varied, with little air between sentences.
    case "playful": return { expression: 0.82, rhythm: 0.95, sentencePause: 0.2 };
    // Quick and light on pauses, without becoming sing-song.
    case "brisk": return { expression: 0.7, rhythm: 0.85, sentencePause: 0.18 };
    // Precise and unhurried: the register for careful subjects, where varying
    // the delivery would read as unseriousness.
    case "deliberate": return { expression: 0.6, rhythm: 0.75, sentencePause: 0.42 };
    // Calm and even. The default, and a touch more varied than Piper's own
    // defaults, which err toward flat.
    case "measured":
    default: return { expression: 0.72, rhythm: 0.87, sentencePause: 0.32 };
  }
}

/**
 * Scale a cadence's expression by an explicit setting.
 *
 * `expressiveness` is 0..1 around a neutral 0.5, so leaving it unset keeps the
 * cadence exactly as written. Clamped to the range Piper behaves in: past
 * roughly 1.0 the variation stops sounding like inflection and starts sounding
 * like a fault.
 */
export function expressionScale(base: number, expressiveness: number | undefined): string {
  const safe = typeof expressiveness === "number" && Number.isFinite(expressiveness)
    ? Math.min(1, Math.max(0, expressiveness))
    : 0.5;

  // 0 → two thirds of the cadence's expression, 1 → four thirds of it.
  const scaled = base * (2 / 3 + (2 / 3) * safe);
  return Math.min(1, Math.max(0.1, scaled)).toFixed(3);
}

/**
 * Speak `text`, returning WAV audio.
 *
 * The text is written to stdin rather than passed as an argument. Piper takes
 * text on stdin natively, and it means no part of the user's words is ever
 * parsed as a command-line token — the injection question does not arise
 * rather than being defended against.
 */
export async function synthesize(
  text: string,
  options: SynthesisOptions = {}
): Promise<SynthesisResult> {
  const status = piperStatus();
  if (!status.available) return { ok: false, reason: status.reason };

  const spoken = typeof text === "string" ? text.trim() : "";
  if (!spoken) return { ok: false, reason: "There was nothing to say." };
  if (spoken.length > maxSynthesisCharacters) {
    return { ok: false, reason: "That is too long to speak in one go." };
  }

  // A requested voice must be one found on disk. An unknown id falls back to
  // the default rather than failing: the reply is worth hearing in some voice.
  // This is also what keeps a client-supplied string from reaching the command
  // line — the value used is always a path this module built from a directory
  // listing, never the request.
  const voice = (options.voiceId
    ? status.voices.find((candidate) => candidate.id === options.voiceId)
    : undefined) ?? status.voice;

  const delivery = deliveryFor(options.cadence);

  // A temp file per call, removed afterwards. Piper can stream raw samples to
  // stdout, but a WAV on disk carries its own header and sample rate, which
  // is what a browser can play without the client having to know the model's
  // rate.
  const workDir = mkdtempSync(path.join(tmpdir(), "vexora-speech-"));
  const outputPath = path.join(workDir, "speech.wav");

  try {
    const failure = await new Promise<string | null>((resolve) => {
      const child = spawn(
        status.binaryPath,
        [
          "--model", voice.modelPath,
          "--output_file", outputPath,
          "--length_scale", lengthScaleFor(options.rate),
          // Variation in the audio and in how long each sound is held. Without
          // these a multi-sentence reply comes out flat and evenly clipped,
          // which is most of what "sounds robotic" actually means.
          "--noise_scale", expressionScale(delivery.expression, options.expressiveness),
          "--noise_w", delivery.rhythm.toFixed(3),
          // Sentence-by-sentence pauses. Without this a reply of several
          // sentences runs together in one breath.
          "--sentence_silence", delivery.sentencePause.toFixed(3)
        ],
        {
          // Fixed executable, fixed flags, and the only variable parts are a
          // path this module resolved and numbers it formatted itself.
          shell: false,
          windowsHide: true,
          cwd: piperRoot()
        }
      );

      const timer = setTimeout(() => {
        child.kill();
        resolve("Speech synthesis took too long and was stopped.");
      }, synthesisTimeoutMs);

      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

      child.on("error", (error) => {
        clearTimeout(timer);
        resolve(`Piper could not be started: ${error.message}`);
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        // Piper logs progress to stderr on success, so a non-zero exit is the
        // signal, not the presence of stderr output.
        resolve(code === 0 ? null : `Piper exited with code ${code}. ${stderr.slice(-200)}`.trim());
      });

      child.stdin.end(spoken, "utf8");
    });

    if (failure) return { ok: false, reason: failure };

    if (!existsSync(outputPath)) {
      // Reported rather than returned as empty audio: silence that claims to
      // be speech is exactly the kind of quiet failure this app refuses.
      return { ok: false, reason: "Piper reported success but produced no audio." };
    }

    return { ok: true, audio: readFileSync(outputPath), format: "wav", voice: voice.id };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "Speech synthesis failed." };
  } finally {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* a temp file is not worth failing over */ }
  }
}
