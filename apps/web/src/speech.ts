import { personalityById, resolvePersonality, type PersonalityId } from "./personalities";

// Speaking replies aloud.
//
// Every personality has carried a voice profile — tone, cadence, rate, pitch —
// since personalities were added, and nothing has ever read it. This is what
// reads it.
//
// Output only. Speech *synthesis* in the browser is genuinely local: the
// voices come from the operating system, nothing is uploaded, and no account
// or key is involved. Speech *recognition* is a different matter and is
// deliberately not here — see the note in `speechRecognitionIsLocal` below.
//
// The rule the rest of this codebase runs on applies here too: never claim to
// have done something that did not happen. A browser with no voices installed
// cannot speak, and the interface has to say so rather than offer a button
// that quietly does nothing.

export type SpeechAvailability =
  | { available: true; voiceCount: number }
  | { available: false; reason: string };

/**
 * Whether this browser can actually speak, and with what.
 *
 * The voice list loads asynchronously in some browsers, so an empty list is
 * not proof of absence until `voiceschanged` has fired — `waitForVoices`
 * exists for that. This reports what is true at the moment it is asked.
 */
export function speechAvailability(
  synth: SpeechSynthesis | undefined = typeof window === "undefined" ? undefined : window.speechSynthesis
): SpeechAvailability {
  if (!synth) {
    return { available: false, reason: "This browser has no speech synthesis." };
  }

  const voices = synth.getVoices();
  if (voices.length === 0) {
    return { available: false, reason: "No voices are installed on this machine." };
  }

  return { available: true, voiceCount: voices.length };
}

/**
 * Resolve the voice list, which several browsers populate asynchronously.
 *
 * Returns whatever exists after the event or the timeout, whichever comes
 * first — a browser that never fires `voiceschanged` must not leave the
 * caller waiting forever.
 */
export function waitForVoices(
  synth: SpeechSynthesis,
  timeoutMs = 2000
): Promise<SpeechSynthesisVoice[]> {
  const existing = synth.getVoices();
  if (existing.length > 0) return Promise.resolve(existing);

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(synth.getVoices());
    };

    synth.addEventListener?.("voiceschanged", finish, { once: true });
    setTimeout(finish, timeoutMs);
  });
}

/**
 * How human a voice is likely to sound, by generation.
 *
 * Windows ships two eras of voice under the same API. The neural ones —
 * "Natural", and the Aria/Guy/Jenny/Ryan family — sound like a person. The
 * older SAPI ones (David, Mark, Zira) sound like a speech synthesizer, and no
 * amount of rate or pitch adjustment changes that: it is the engine, not the
 * settings.
 *
 * Ranked rather than hardcoded to one name so that installing better voices
 * is all it takes — the app picks them up with no further change. Higher wins.
 */
function voiceQuality(voice: SpeechSynthesisVoice): number {
  const name = voice.name.toLowerCase();

  // Neural, and the reason this ranking exists.
  if (name.includes("natural")) return 100;
  if (/\b(aria|guy|jenny|ryan|sonia|libby|michelle|roger)\b/.test(name)) return 90;

  // Legacy SAPI, least bad first. David is the flattest of the three.
  if (name.includes("zira")) return 30;
  if (name.includes("mark")) return 25;
  if (name.includes("david")) return 20;

  // Something unrecognised is more likely to be a modern addition than an
  // older built-in, so it outranks the known-old ones.
  return 50;
}

/**
 * Prefer a voice that runs on this machine, and the most human of those.
 *
 * `localService` false means the browser streams the text to a remote service
 * to have it spoken. That would quietly send the assistant's replies —
 * including anything quoted from the user's own notes — off the machine, in
 * an app whose whole premise is that it does not do that. A remote voice is
 * used only when there is no local one at all, and the caller is told.
 *
 * Locality outranks quality: a better-sounding voice is not worth sending the
 * user's own notes off the machine to hear.
 */
export function chooseVoice(
  voices: SpeechSynthesisVoice[],
  preferredLanguage = "en",
  preferredName?: string
): SpeechSynthesisVoice | null {
  if (voices.length === 0) return null;

  // An explicit choice wins outright — including a remote one, because at
  // that point it was asked for rather than picked.
  if (preferredName) {
    const chosen = voices.find((voice) => voice.name === preferredName);
    if (chosen) return chosen;
  }

  const local = voices.filter((voice) => voice.localService);
  const pool = local.length > 0 ? local : voices;

  const spoken = pool.filter((voice) => voice.lang?.toLowerCase().startsWith(preferredLanguage));
  const candidates = spoken.length > 0 ? spoken : pool;

  return [...candidates].sort((left, right) => voiceQuality(right) - voiceQuality(left))[0] ?? null;
}

/** Every voice worth offering, best first, for a picker. */
export function rankedVoices(
  voices: SpeechSynthesisVoice[],
  preferredLanguage = "en"
): SpeechSynthesisVoice[] {
  const spoken = voices.filter((voice) => voice.lang?.toLowerCase().startsWith(preferredLanguage));
  const pool = spoken.length > 0 ? spoken : voices;

  return [...pool].sort((left, right) => {
    // Local first, then quality: the same ordering chooseVoice applies.
    if (left.localService !== right.localService) return left.localService ? -1 : 1;
    return voiceQuality(right) - voiceQuality(left);
  });
}

/**
 * True when only the older synthesizer voices are installed.
 *
 * Not a failure, and not something the app can fix for the user: better
 * voices are a Windows setting, not a download this app controls. Worth
 * surfacing so "it sounds robotic" has an answer other than silence.
 */
export function onlyLegacyVoicesAvailable(voices: SpeechSynthesisVoice[]): boolean {
  const local = voices.filter((voice) => voice.localService);
  const pool = local.length > 0 ? local : voices;
  return pool.length > 0 && pool.every((voice) => voiceQuality(voice) <= 30);
}

/** True when every voice available would send text off this machine to speak it. */
export function onlyRemoteVoicesAvailable(voices: SpeechSynthesisVoice[]): boolean {
  return voices.length > 0 && voices.every((voice) => !voice.localService);
}

/** Longer than this is a document being read at someone, not an answer. */
export const maxSpokenCharacters = 700;

/**
 * The reply, as something worth hearing.
 *
 * The vision's rule is that voice is concise while the screen carries the
 * detail, and the difference is not length alone: a fenced code block, a file
 * path and a URL are all unlistenable read aloud, and reading them is worse
 * than saying they are on screen.
 *
 * Nothing here softens or omits an outcome. The mutation results this app
 * appends — "Deleted from memory: ...", "Nothing saved matches ..." — are the
 * honest part of a reply and are spoken like any other sentence.
 */
export function speakableFrom(text: string): string {
  if (typeof text !== "string") return "";

  let spoken = text
    // Fenced code, replaced rather than dropped: silence would misrepresent
    // the reply as not having contained any.
    .replace(/```[\s\S]*?```/g, " (code is on screen) ")
    .replace(/`([^`]+)`/g, "$1")
    // Markdown emphasis is punctuation to the eye and noise to the ear.
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|\s)\*([^*]+)\*/g, "$1$2")
    .replace(/^#{1,6}\s+/gm, "")
    // A URL read character by character is unusable.
    .replace(/https?:\/\/\S+/g, " a link on screen ")
    // Bullets and numbering: the pause carries the structure.
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();

  if (spoken.length > maxSpokenCharacters) {
    // Cut at a sentence end where possible, so it stops rather than breaks
    // off mid-thought, and say plainly that there is more.
    const cut = spoken.slice(0, maxSpokenCharacters);
    const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
    spoken = (lastStop > maxSpokenCharacters / 2 ? cut.slice(0, lastStop + 1) : cut).trim();
    spoken += " The rest is on screen.";
  }

  return spoken;
}

/** Rate and pitch for a personality, clamped to what the API accepts. */
export function voiceSettingsFor(personality: PersonalityId): { rate: number; pitch: number } {
  const { voice } = personalityById(resolvePersonality(personality));

  // The Web Speech API accepts 0.1..10 for rate and 0..2 for pitch, and
  // silently misbehaves outside that. The profiles sit near 1, but clamping
  // means a future profile cannot break speech by being ambitious.
  return {
    rate: Math.min(2, Math.max(0.5, voice.rate)),
    pitch: Math.min(2, Math.max(0, voice.pitch))
  };
}

/**
 * Why speech *recognition* is not here.
 *
 * The browser exposes SpeechRecognition, and it would have been easy to wire
 * up. In Chromium it is not local: it streams captured audio to a remote
 * speech service. This app tells the user, on its own home screen, that
 * answers come from a local model and that nothing is uploaded — and there is
 * a test asserting the model client only ever talks to loopback.
 *
 * That test inspects `localModel.ts` for URLs, so it would not have caught a
 * browser API doing the same thing by other means. Shipping recognition
 * quietly would have broken the promise without breaking the build, which is
 * the worst combination.
 *
 * Exported as a constant rather than left as a comment so the decision is
 * visible from the code that would otherwise reach for it.
 */
export const speechRecognitionIsLocal = false;
