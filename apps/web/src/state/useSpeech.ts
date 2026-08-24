import { useCallback, useEffect, useRef, useState } from "react";
import {
  chooseVoice,
  onlyLegacyVoicesAvailable,
  onlyRemoteVoicesAvailable,
  rankedVoices,
  speakableFrom,
  speechAvailability,
  voiceSettingsFor,
  waitForVoices,
  type SpeechAvailability
} from "../speech";
import type { PersonalityId } from "../personalities";

// Speaking, as state the interface can trust.
//
// The one rule that shapes this: `speaking` must reflect the synthesizer, not
// the intention to use it. Setting a flag when speak() is called and clearing
// it on a timer would give a Stop button that sometimes stops nothing and
// sometimes stays lit over silence. Every transition here comes from an
// utterance event.

const enabledStorageKey = "ascend.speech.enabled.v1";
const voiceStorageKey = "ascend.speech.voice.v1";

export type SpeechState = {
  /** Whether this machine can speak at all, and why not when it cannot. */
  availability: SpeechAvailability;
  /** The user's choice. Persisted, and irrelevant when availability is false. */
  enabled: boolean;
  setEnabled: (next: boolean) => void;
  /** True only while the synthesizer is actually producing sound. */
  speaking: boolean;
  /** True when the only voice available would send text off this machine. */
  usingRemoteVoice: boolean;
  /**
   * True when only the older synthesizer voices are installed.
   *
   * Not a fault the app can fix — better voices are a Windows setting — but
   * the honest answer to "why does it sound robotic".
   */
  onlyLegacyVoices: boolean;
  /** Every voice worth offering, best first. */
  voices: SpeechSynthesisVoice[];
  /** The chosen voice name, or null to let the ranking decide. */
  voiceName: string | null;
  setVoiceName: (next: string | null) => void;
  speak: (text: string, personality: PersonalityId) => void;
  stop: () => void;
};

function readEnabled(): boolean {
  try {
    // Off unless chosen. A page that starts talking on its own is a worse
    // default than one that waits to be asked.
    return window.localStorage.getItem(enabledStorageKey) === "true";
  } catch {
    return false;
  }
}

export function useSpeech(): SpeechState {
  const synth = typeof window === "undefined" ? undefined : window.speechSynthesis;

  const [availability, setAvailability] = useState<SpeechAvailability>(
    () => speechAvailability(synth)
  );
  const [enabled, setEnabledState] = useState<boolean>(readEnabled);
  const [speaking, setSpeaking] = useState(false);
  const [usingRemoteVoice, setUsingRemoteVoice] = useState(false);
  const [onlyLegacyVoices, setOnlyLegacyVoices] = useState(false);
  const [voiceList, setVoiceList] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceName, setVoiceNameState] = useState<string | null>(() => {
    try { return window.localStorage.getItem(voiceStorageKey); } catch { return null; }
  });
  const voices = useRef<SpeechSynthesisVoice[]>([]);

  // Voices load asynchronously in several browsers, so the first read is
  // often empty and is not proof that nothing is installed.
  useEffect(() => {
    if (!synth) return;
    let cancelled = false;

    void waitForVoices(synth).then((loaded) => {
      if (cancelled) return;
      voices.current = loaded;
      setAvailability(speechAvailability(synth));
      setUsingRemoteVoice(onlyRemoteVoicesAvailable(loaded));
      setOnlyLegacyVoices(onlyLegacyVoicesAvailable(loaded));
      setVoiceList(rankedVoices(loaded));
    });

    return () => { cancelled = true; };
  }, [synth]);

  // Anything still being spoken when the view goes away should stop with it.
  useEffect(() => () => { synth?.cancel(); }, [synth]);

  const setEnabled = useCallback((next: boolean) => {
    setEnabledState(next);
    try { window.localStorage.setItem(enabledStorageKey, String(next)); } catch { /* not worth failing over */ }
    if (!next) {
      synth?.cancel();
      setSpeaking(false);
    }
  }, [synth]);

  const setVoiceName = useCallback((next: string | null) => {
    setVoiceNameState(next);
    try {
      if (next) window.localStorage.setItem(voiceStorageKey, next);
      else window.localStorage.removeItem(voiceStorageKey);
    } catch { /* a stored preference is not worth failing over */ }
    // Stop anything mid-sentence: continuing in the old voice after the user
    // picked a new one reads as the choice not having taken.
    synth?.cancel();
    setSpeaking(false);
  }, [synth]);

  const stop = useCallback(() => {
    synth?.cancel();
    // Set directly rather than waiting for an event: cancel() does not
    // reliably fire `end` in every browser, and a Stop button that leaves the
    // interface claiming it is still speaking is the exact dishonesty this
    // state exists to avoid.
    setSpeaking(false);
  }, [synth]);

  const speak = useCallback((text: string, personality: PersonalityId) => {
    if (!synth || !enabled) return;

    const spoken = speakableFrom(text);
    if (!spoken) return;

    // One thing at a time. Without this a fast exchange stacks utterances and
    // the assistant talks over itself.
    synth.cancel();

    const utterance = new SpeechSynthesisUtterance(spoken);
    const voice = chooseVoice(voices.current, "en", voiceName ?? undefined);
    if (voice) utterance.voice = voice;

    const { rate, pitch } = voiceSettingsFor(personality);
    utterance.rate = rate;
    utterance.pitch = pitch;

    utterance.onstart = () => setSpeaking(true);
    utterance.onend = () => setSpeaking(false);
    // An error leaves nothing being spoken, so the state must say so rather
    // than staying lit forever.
    utterance.onerror = () => setSpeaking(false);

    synth.speak(utterance);
  }, [synth, enabled, voiceName]);

  return {
    availability, enabled, setEnabled, speaking, usingRemoteVoice,
    onlyLegacyVoices, voices: voiceList, voiceName, setVoiceName, speak, stop
  };
}
