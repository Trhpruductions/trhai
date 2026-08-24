import { webEnv } from "./env";

// The neural voice, when this machine has one.
//
// The browser's own speech synthesis is genuinely local, but it can only use
// the voices the operating system has installed. On a machine with only the
// legacy SAPI voices — David, Mark, Zira — it sounds like a synthesizer from
// two decades ago, and rate and pitch cannot fix that: it is the engine.
//
// Piper is a neural engine running as a local process behind the API. Same
// promise as everything else here — no account, no key, nothing leaves the
// machine — and it sounds like a person. It is optional: when it is not
// installed the interface falls back to the browser voices and says which one
// it is using, rather than offering a voice that produces silence.

export type VoiceQuality = "x_low" | "low" | "medium" | "high";
export type VoiceGender = "male" | "female";

export type NeuralVoiceOption = {
  /** The model's file stem, e.g. "en_GB-alan-medium". */
  id: string;
  /** Just the speaker, e.g. "Alan". */
  name: string;
  /** e.g. "en_GB". */
  locale: string;
  quality: VoiceQuality;
  /** Null when this build has no confirmed gender for the speaker — see piperSpeech.ts. */
  gender: VoiceGender | null;
};

export type NeuralVoiceStatus =
  | { available: true; voice: string; voices: NeuralVoiceOption[]; maxCharacters: number }
  | { available: false; reason: string };

/** How a voice is described in a picker: "Alan · British · male · high quality". */
export function describeVoice(voice: NeuralVoiceOption): string {
  const accents: Record<string, string> = {
    en_GB: "British",
    en_US: "American",
    en_AU: "Australian",
    en_IE: "Irish",
    en_IN: "Indian"
  };

  const accent = accents[voice.locale] ?? voice.locale.replace("_", "-");
  const quality = voice.quality === "x_low" ? "lowest" : voice.quality;
  // Omitted rather than shown as "unknown" when this build has no confirmed
  // gender for the speaker — a blank is honest; a guess dressed up as a
  // label is not.
  const gender = voice.gender ? ` · ${voice.gender}` : "";

  return `${voice.name} · ${accent}${gender} · ${quality} quality`;
}

/**
 * Whether the local neural voice is installed.
 *
 * A failure to reach the API is reported as unavailable rather than thrown:
 * not having the neural voice is a normal state, and the browser voices are
 * still there to fall back to.
 */
export async function checkNeuralVoice(
  fetchImpl: typeof fetch = fetch,
  baseUrl: string = webEnv.apiBaseUrl
): Promise<NeuralVoiceStatus> {
  try {
    const response = await fetchImpl(`${baseUrl}/v1/speech`);
    if (!response.ok) {
      return { available: false, reason: "The speech service did not respond." };
    }

    const payload = await response.json();
    const data = payload?.data;

    if (data?.available === true && typeof data.voice === "string") {
      return {
        available: true,
        voice: data.voice,
        // Only entries that carry an id are usable; anything else in the list
        // would become a picker option that cannot be selected for.
        voices: Array.isArray(data.voices)
          ? (data.voices as NeuralVoiceOption[]).filter((voice) => typeof voice?.id === "string")
          : [],
        maxCharacters: typeof data.maxCharacters === "number" ? data.maxCharacters : 2000
      };
    }

    return {
      available: false,
      reason: typeof data?.reason === "string" ? data.reason : "The neural voice is not installed."
    };
  } catch {
    return { available: false, reason: "Could not reach the speech service." };
  }
}

export type NeuralAudio =
  /** `voice` is which voice actually spoke, which may not be the one asked for. */
  | { ok: true; blob: Blob; voice: string | null }
  | { ok: false; reason: string };

/**
 * Synthesize `text` and return the audio.
 *
 * `signal` lets a caller abandon a request that is no longer wanted — pressing
 * stop, or asking a second question before the first finished speaking. Without
 * it the audio would arrive late and start talking over whatever came next.
 */
export type SynthesisRequest = {
  /** Which installed voice. Omit to let the server pick the best one. */
  voiceId?: string;
  rate?: number;
  /** How much the delivery varies, 0..1 around a neutral 0.5. */
  expressiveness?: number;
  /** How the active personality carries itself. */
  cadence?: "measured" | "brisk" | "playful" | "deliberate";
  signal?: AbortSignal;
};

export async function synthesizeNeural(
  text: string,
  options: SynthesisRequest = {},
  fetchImpl: typeof fetch = fetch,
  baseUrl: string = webEnv.apiBaseUrl
): Promise<NeuralAudio> {
  try {
    const response = await fetchImpl(`${baseUrl}/v1/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        voiceId: options.voiceId,
        rate: options.rate,
        expressiveness: options.expressiveness,
        cadence: options.cadence
      }),
      signal: options.signal
    });

    if (!response.ok) {
      // The API reports why — usually that Piper is not installed — and that
      // reason is more useful than a status code.
      let reason = "Speech synthesis failed.";
      try {
        const payload = await response.json();
        if (typeof payload?.message === "string") reason = payload.message;
      } catch { /* a non-JSON error body is not worth a second failure */ }
      return { ok: false, reason };
    }

    const blob = await response.blob();
    if (blob.size === 0) {
      // Silence that claims to be speech is the failure this codebase exists
      // to avoid; it gets reported like any other.
      return { ok: false, reason: "The speech service returned no audio." };
    }

    // Which voice actually spoke. The server falls back when the requested one
    // is gone, and reading this is how the interface can say so instead of
    // labelling the audio with a voice that did not produce it.
    return { ok: true, blob, voice: response.headers?.get?.("X-Speech-Voice") ?? null };
  } catch (error) {
    // An aborted request is a deliberate cancellation, not a fault.
    if (error instanceof DOMException && error.name === "AbortError") {
      return { ok: false, reason: "cancelled" };
    }
    return { ok: false, reason: "Could not reach the speech service." };
  }
}

/** True when a failure was the caller's own cancellation rather than a fault. */
export function wasCancelled(result: NeuralAudio): boolean {
  return !result.ok && result.reason === "cancelled";
}
