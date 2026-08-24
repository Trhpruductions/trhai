import { useCallback, useEffect, useRef, useState } from "react";
import {
  cadenceFor,
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
import {
  checkNeuralVoice,
  synthesizeNeural,
  wasCancelled,
  type NeuralVoiceOption,
  type NeuralVoiceStatus
} from "../neuralSpeech";
import type { PersonalityId } from "../personalities";

// Speaking, as state the interface can trust.
//
// The one rule that shapes this: `speaking` must reflect the synthesizer, not
// the intention to use it. Setting a flag when speak() is called and clearing
// it on a timer would give a Stop button that sometimes stops nothing and
// sometimes stays lit over silence. Every transition here comes from an
// utterance event or an audio element event.
//
// Two engines sit behind one interface. The neural voice runs as a local
// process behind the API and sounds like a person; the browser's own voices
// are the fallback when it is not installed. Which one is actually speaking is
// reported rather than hidden, because they sound entirely different and a
// user hearing the robotic one deserves to know why.

const enabledStorageKey = "ascend.speech.enabled.v1";
const voiceStorageKey = "ascend.speech.voice.v1";

export type SpeechEngine = "neural" | "browser" | "none";

export type SpeechState = {
  /** Whether this machine can speak at all, and why not when it cannot. */
  availability: SpeechAvailability;
  /** The user's choice. Persisted, and irrelevant when availability is false. */
  enabled: boolean;
  setEnabled: (next: boolean) => void;
  /** True only while sound is actually being produced. */
  speaking: boolean;
  /** True while neural audio is being generated but has not started playing. */
  preparing: boolean;
  /** Which engine would speak right now. */
  engine: SpeechEngine;
  /** The local neural engine, and why it is absent when it is. */
  neural: NeuralVoiceStatus | null;
  /** Every installed neural voice, best first. Empty when there is no engine. */
  neuralVoices: NeuralVoiceOption[];
  /** The neural voice that would speak right now, or null when none would. */
  activeNeuralVoice: NeuralVoiceOption | null;
  /** True when the only voice available would send text off this machine. */
  usingRemoteVoice: boolean;
  /**
   * True when only the older browser voices are installed *and* the neural
   * voice is not available to cover for them.
   */
  onlyLegacyVoices: boolean;
  /** Every browser voice worth offering, best first. */
  voices: SpeechSynthesisVoice[];
  /**
   * The chosen voice: a neural voice id, a browser voice name, or null to
   * decide automatically. The two namespaces do not collide — neural ids look
   * like "en_GB-alan-medium" and browser names like "Microsoft Zira".
   */
  voiceName: string | null;
  setVoiceName: (next: string | null) => void;
  /** The last failure worth showing, or null. Cleared on the next attempt. */
  error: string | null;
  speak: (text: string, personality: PersonalityId) => void;
  stop: () => void;
};

/** The voice the server would pick, resolved against what is installed. */
function defaultNeuralVoice(status: NeuralVoiceStatus): NeuralVoiceOption | null {
  if (!status.available) return null;
  return status.voices.find((voice) => voice.id === status.voice) ?? status.voices[0] ?? null;
}

/** Whether a stored name belongs to the browser's own voice list. */
function isBrowserVoiceName(name: string, browserVoices: SpeechSynthesisVoice[]): boolean {
  return browserVoices.some((voice) => voice.name === name);
}

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
  const [preparing, setPreparing] = useState(false);
  const [neural, setNeural] = useState<NeuralVoiceStatus | null>(null);
  const [usingRemoteVoice, setUsingRemoteVoice] = useState(false);
  const [legacyBrowserVoices, setLegacyBrowserVoices] = useState(false);
  const [voiceList, setVoiceList] = useState<SpeechSynthesisVoice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [voiceName, setVoiceNameState] = useState<string | null>(() => {
    try { return window.localStorage.getItem(voiceStorageKey); } catch { return null; }
  });

  const voices = useRef<SpeechSynthesisVoice[]>([]);
  const audio = useRef<HTMLAudioElement | null>(null);
  const audioUrl = useRef<string | null>(null);
  const inFlight = useRef<AbortController | null>(null);

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
      setLegacyBrowserVoices(onlyLegacyVoicesAvailable(loaded));
      setVoiceList(rankedVoices(loaded));
    });

    return () => { cancelled = true; };
  }, [synth]);

  // Ask the API once whether the neural voice is installed. Not having it is a
  // normal state, so this never surfaces as an error.
  useEffect(() => {
    let cancelled = false;
    void checkNeuralVoice().then((status) => { if (!cancelled) setNeural(status); });
    return () => { cancelled = true; };
  }, []);

  /** Release the object URL behind the last clip. */
  const releaseAudio = useCallback(() => {
    if (audioUrl.current) {
      URL.revokeObjectURL(audioUrl.current);
      audioUrl.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    inFlight.current?.abort();
    inFlight.current = null;

    synth?.cancel();

    if (audio.current) {
      audio.current.pause();
      audio.current.src = "";
      audio.current = null;
    }
    releaseAudio();

    // Set directly rather than waiting for an event: neither cancel() nor
    // pause() reliably fires an end event, and a Stop button that leaves the
    // interface claiming it is still speaking is the exact dishonesty this
    // state exists to avoid.
    setSpeaking(false);
    setPreparing(false);
  }, [synth, releaseAudio]);

  // Anything still being spoken when the view goes away should stop with it.
  useEffect(() => () => {
    inFlight.current?.abort();
    synth?.cancel();
    audio.current?.pause();
    releaseAudio();
  }, [synth, releaseAudio]);

  const setEnabled = useCallback((next: boolean) => {
    setEnabledState(next);
    try { window.localStorage.setItem(enabledStorageKey, String(next)); } catch { /* not worth failing over */ }
    if (!next) stop();
  }, [stop]);

  const setVoiceName = useCallback((next: string | null) => {
    setVoiceNameState(next);
    try {
      if (next) window.localStorage.setItem(voiceStorageKey, next);
      else window.localStorage.removeItem(voiceStorageKey);
    } catch { /* a stored preference is not worth failing over */ }
    // Stop anything mid-sentence: continuing in the old voice after the user
    // picked a new one reads as the choice not having taken.
    stop();
  }, [stop]);

  const neuralVoices = neural?.available === true ? neural.voices : [];

  /**
   * The neural voice that would speak, given what is chosen and installed.
   *
   * A stored choice that is no longer installed falls back to the default
   * rather than sticking: the model may have been deleted since it was picked,
   * and a picker pointing at a missing file would produce silence.
   */
  const activeNeuralVoice: NeuralVoiceOption | null = (() => {
    if (neural?.available !== true) return null;
    if (voiceName) {
      return neuralVoices.find((voice) => voice.id === voiceName)
        ?? (isBrowserVoiceName(voiceName, voiceList) ? null : defaultNeuralVoice(neural));
    }
    return defaultNeuralVoice(neural);
  })();

  /**
   * Which engine speaks.
   *
   * An explicit browser voice wins — it was asked for. Otherwise the neural
   * engine is preferred whenever it exists, because it is both local and by
   * far the more human of the two.
   */
  const engine: SpeechEngine = activeNeuralVoice
    ? "neural"
    : availability.available ? "browser" : "none";

  /** The browser voices, as the last resort when neural synthesis fails. */
  const speakWithBrowser = useCallback((spoken: string, personality: PersonalityId) => {
    if (!synth) return false;

    // One thing at a time. Without this a fast exchange stacks utterances and
    // the assistant talks over itself.
    synth.cancel();

    const utterance = new SpeechSynthesisUtterance(spoken);
    // Only a name from the browser's own list means anything here; a neural
    // voice id would match nothing and quietly select the wrong voice.
    const requested = voiceName && isBrowserVoiceName(voiceName, voices.current) ? voiceName : undefined;
    const voice = chooseVoice(voices.current, "en", requested);
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
    return true;
  }, [synth, voiceName]);

  const speak = useCallback((text: string, personality: PersonalityId) => {
    if (!enabled) return;

    const spoken = speakableFrom(text);
    if (!spoken) return;

    stop();
    setError(null);

    const { rate } = voiceSettingsFor(personality);

    if (engine === "neural" && activeNeuralVoice) {
      const controller = new AbortController();
      inFlight.current = controller;
      setPreparing(true);

      const request = {
        voiceId: activeNeuralVoice.id,
        rate,
        // The personality's own cadence, which the browser synthesizer has no
        // way to act on and which has gone unread since personalities existed.
        cadence: cadenceFor(personality),
        signal: controller.signal
      };

      void synthesizeNeural(spoken, request).then((result) => {
        if (controller.signal.aborted) return;
        inFlight.current = null;
        setPreparing(false);

        if (!result.ok) {
          if (wasCancelled(result)) return;
          // Falling back rather than going silent: the user asked to hear the
          // reply, and the browser voice is worse but real. The reason is kept
          // so the interface can say why it sounds different.
          setError(result.reason);
          speakWithBrowser(spoken, personality);
          return;
        }

        // The server falls back when a requested voice is gone. Saying so beats
        // leaving the panel labelled with a voice that did not speak.
        if (result.voice && result.voice !== request.voiceId) {
          setError(`That voice is no longer installed, so ${result.voice} spoke instead.`);
        }

        const url = URL.createObjectURL(result.blob);
        audioUrl.current = url;

        const element = new Audio(url);
        audio.current = element;

        // Every transition below comes from the element itself, never from
        // having asked it to play.
        element.onplaying = () => setSpeaking(true);
        element.onended = () => { setSpeaking(false); releaseAudio(); };
        element.onerror = () => {
          setSpeaking(false);
          releaseAudio();
          setError("The audio could not be played.");
        };

        void element.play().catch(() => {
          // Browsers block audio until the page has been interacted with. That
          // is a real reason the user cannot hear anything, so it is said
          // rather than swallowed.
          setSpeaking(false);
          setError("The browser blocked audio playback until you interact with the page.");
        });
      });

      return;
    }

    if (engine === "browser") {
      speakWithBrowser(spoken, personality);
      return;
    }

    setError(availability.available ? "No voice is available." : availability.reason);
  }, [enabled, engine, activeNeuralVoice, stop, speakWithBrowser, releaseAudio, availability]);

  return {
    availability,
    enabled,
    setEnabled,
    speaking,
    preparing,
    engine,
    neural,
    neuralVoices,
    activeNeuralVoice,
    usingRemoteVoice,
    // The neural voice covers for legacy browser voices entirely, so the
    // "why does it sound robotic" note only applies when it is absent.
    onlyLegacyVoices: legacyBrowserVoices && engine !== "neural",
    voices: voiceList,
    voiceName,
    setVoiceName,
    error,
    speak,
    stop
  };
}
