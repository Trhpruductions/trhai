// Which voice TRHAI speaks in, and how fast.
//
// This was a constant in useSpeech: en_GB-alan-medium, measured, 0.97. Picked
// on the reasoning that the voice being imitated is British and male, and that
// of the four installed voices only one is both. That reasoning still holds -
// it is a good default - but it was a guess made on someone else's behalf
// about the one thing in this app nobody else can judge for them. A voice is
// either right in your ears or it is not, and no amount of argument about
// accent settles it.
//
// So it is stored, and chosen in the app, with a button to hear each one.

export type VoiceChoice = {
  voiceId: string;
  /** 0.5 to 2. Below 1 is slower and more deliberate. */
  rate: number;
  cadence: "measured" | "brisk" | "playful" | "deliberate";
};

const storageKey = "trhai.voice.v1";

/**
 * British and male, calm and even, a touch under normal speed.
 *
 * Still the default, for the reason it always was: of the voices Piper
 * publishes there is no en_GB male at "high" quality, so this medium-quality
 * model is the best British male available. A high-quality voice with the
 * wrong accent does not sound like the thing at all.
 */
export const defaultVoice: VoiceChoice = {
  voiceId: "en_GB-alan-medium",
  rate: 0.97,
  cadence: "measured"
};

const cadences: VoiceChoice["cadence"][] = ["measured", "brisk", "playful", "deliberate"];

/** Clamped to the range the synthesiser behaves in; outside it, Piper distorts. */
export function clampRate(value: unknown): number {
  const rate = typeof value === "number" && Number.isFinite(value) ? value : defaultVoice.rate;
  return Math.min(1.4, Math.max(0.7, Math.round(rate * 100) / 100));
}

export function readStoredVoice(storage: Pick<Storage, "getItem"> | undefined): VoiceChoice {
  if (!storage) return defaultVoice;
  try {
    const raw = storage.getItem(storageKey);
    if (!raw) return defaultVoice;

    const parsed = JSON.parse(raw) as Partial<VoiceChoice>;
    return {
      // Any stored id is accepted: the installed set differs per machine, and
      // the service substitutes and reports what actually spoke. Refusing an
      // id this build does not recognise would strand anyone who installed a
      // voice the app has never heard of.
      voiceId: typeof parsed.voiceId === "string" && parsed.voiceId ? parsed.voiceId : defaultVoice.voiceId,
      rate: clampRate(parsed.rate),
      cadence: cadences.includes(parsed.cadence as VoiceChoice["cadence"])
        ? (parsed.cadence as VoiceChoice["cadence"])
        : defaultVoice.cadence
    };
  } catch {
    return defaultVoice;
  }
}

export function writeStoredVoice(storage: Pick<Storage, "setItem"> | undefined, choice: VoiceChoice): void {
  try {
    storage?.setItem(storageKey, JSON.stringify(choice));
  } catch {
    // A voice choice not persisting is not worth failing over.
  }
}
