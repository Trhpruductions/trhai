"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiBaseUrl } from "../lib/api";
import { speakableFrom } from "../lib/speech";

// Voice, local by construction.
//
// Two engines: a neural voice running as a local process behind the API (see
// docs/13-neural-voice.md in this repo), and the browser's own speechSynthesis
// as a fallback when it is not installed. Neither ever sends the reply
// anywhere — the whole reason the neural voice exists is to avoid the paid,
// cloud alternative, not to reach for one.
//
// `speaking` is driven only by real element/utterance events, never by a
// timer standing in for them — a Stop control that sometimes stops nothing is
// worse than no control.

const enabledKey = "trhai.speech.enabled.v1";

/**
 * How far to scale the neural voice's RMS to fill 0..1.
 *
 * Measured rather than guessed, against real Piper output in the browser: a
 * spoken reply runs a median RMS of 0.107 and peaks at 0.426, so 2.3 puts the
 * loudest moment just under the ceiling and leaves ordinary speech using most
 * of the range.
 *
 * Deliberately different from the microphone's 3.2 in useMicrophone.ts, and
 * that first version reused it — at which point a fifth of the frames pinned
 * to a flat maximum, flattening exactly the loud moments the core should be
 * reacting to most. Two different sources at two different levels need two
 * different numbers; one constant shared between them was quietly wrong.
 */
const speechScale = 2.3;

export type SpeechEngine = "neural" | "browser" | "none";

type NeuralStatus =
  | { available: true; voice: string }
  | { available: false; reason: string };

export function useSpeech() {
  const synth = typeof window === "undefined" ? undefined : window.speechSynthesis;

  const [enabled, setEnabledState] = useState(() => {
    try {
      return window.localStorage.getItem(enabledKey) === "true";
    } catch {
      return false;
    }
  });
  const [neural, setNeural] = useState<NeuralStatus | null>(null);
  const [browserVoiceCount, setBrowserVoiceCount] = useState(0);
  const [speaking, setSpeaking] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const audio = useRef<HTMLAudioElement | null>(null);
  const audioUrl = useRef<string | null>(null);
  const inFlight = useRef<AbortController | null>(null);

  // Metering the neural voice's own playback, so the core moves with what is
  // actually being said rather than to a canned rhythm.
  //
  // Only the neural engine can be read this way: it plays through an <audio>
  // element, which Web Audio can tap. The browser fallback (speechSynthesis)
  // exposes no stream at all — there is nothing to analyse — so amplitude
  // stays undefined there and the core keeps its own breathing animation.
  // Inventing a level for it would be exactly the decoration the core exists
  // to refuse.
  const [amplitude, setAmplitude] = useState<number | undefined>(undefined);
  const meterContext = useRef<AudioContext | null>(null);
  const meterFrame = useRef<number | null>(null);
  const smoothed = useRef(0);

  const stopMeter = useCallback(() => {
    if (meterFrame.current !== null) {
      cancelAnimationFrame(meterFrame.current);
      meterFrame.current = null;
    }
    void meterContext.current?.close().catch(() => { /* already closed */ });
    meterContext.current = null;
    smoothed.current = 0;
    setAmplitude(undefined);
  }, []);

  /**
   * Route an element through an analyser and read its level each frame.
   *
   * Connecting to the context's destination is not optional: once an element
   * is tapped by createMediaElementSource its audio flows through the graph,
   * so a graph that ends nowhere plays silence.
   */
  const startMeter = useCallback((element: HTMLAudioElement) => {
    try {
      const context = new AudioContext();
      meterContext.current = context;
      // Playback follows a user gesture, but a context can still start
      // suspended; resuming is harmless when it is already running.
      void context.resume().catch(() => { /* nothing to do */ });

      const source = context.createMediaElementSource(element);
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      analyser.connect(context.destination);

      const samples = new Uint8Array(analyser.fftSize);
      const read = () => {
        analyser.getByteTimeDomainData(samples);

        let sum = 0;
        for (let index = 0; index < samples.length; index += 1) {
          const centred = (samples[index] - 128) / 128;
          sum += centred * centred;
        }
        const level = Math.min(1, Math.sqrt(sum / samples.length) * speechScale);
        // Rises fast so a syllable lands, falls slower so it does not flicker.
        smoothed.current += (level - smoothed.current) * (level > smoothed.current ? 0.6 : 0.15);

        setAmplitude(Math.round(smoothed.current * 100) / 100);
        meterFrame.current = requestAnimationFrame(read);
      };

      meterFrame.current = requestAnimationFrame(read);
    } catch {
      // Metering is an enhancement, never a reason for the reply not to be
      // heard: on failure the audio still plays and the core simply falls
      // back to its own animation.
      stopMeter();
    }
  }, [stopMeter]);

  useEffect(() => {
    let cancelled = false;
    fetch(`${apiBaseUrl}/v1/speech`)
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (cancelled) return;
        const data = payload?.data;
        setNeural(data?.available === true && typeof data.voice === "string"
          ? { available: true, voice: data.voice }
          : { available: false, reason: typeof data?.reason === "string" ? data.reason : "The neural voice is not installed." });
      })
      .catch(() => { if (!cancelled) setNeural({ available: false, reason: "Could not reach the speech service." }); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!synth) return;
    const read = () => setBrowserVoiceCount(synth.getVoices().length);
    read();
    synth.addEventListener?.("voiceschanged", read);
    return () => synth.removeEventListener?.("voiceschanged", read);
  }, [synth]);

  const engine: SpeechEngine = neural?.available ? "neural" : browserVoiceCount > 0 ? "browser" : "none";

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
    stopMeter();
    if (audio.current) {
      audio.current.pause();
      audio.current.src = "";
      audio.current = null;
    }
    releaseAudio();
    setSpeaking(false);
    setPreparing(false);
  }, [synth, releaseAudio, stopMeter]);

  useEffect(() => () => {
    synth?.cancel();
    audio.current?.pause();
    releaseAudio();
    stopMeter();
  }, [synth, releaseAudio, stopMeter]);

  const setEnabled = useCallback((next: boolean) => {
    setEnabledState(next);
    try { window.localStorage.setItem(enabledKey, String(next)); } catch { /* not worth failing over */ }
    if (!next) stop();
  }, [stop]);

  // Not gated on `enabled` here: a click on a button that says "Hear it" is a
  // direct request to hear something right now, distinct from "read future
  // replies aloud automatically". Whether an automatic reply should speak is
  // the caller's decision — see the auto-speak effect in the chat page, which
  // checks `enabled` before ever calling this.
  const speak = useCallback((text: string) => {
    const spoken = speakableFrom(text);
    if (!spoken) return;

    stop();
    setError(null);

    if (engine === "neural") {
      const controller = new AbortController();
      inFlight.current = controller;
      setPreparing(true);

      fetch(`${apiBaseUrl}/v1/speech`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: spoken }),
        signal: controller.signal
      })
        .then(async (response) => {
          if (controller.signal.aborted) return;
          inFlight.current = null;
          setPreparing(false);

          if (!response.ok) {
            const body = await response.json().catch(() => null);
            throw new Error(typeof body?.message === "string" ? body.message : "Speech synthesis failed.");
          }

          const blob = await response.blob();
          if (blob.size === 0) throw new Error("The speech service returned no audio.");

          const url = URL.createObjectURL(blob);
          audioUrl.current = url;
          const element = new Audio(url);
          audio.current = element;

          element.onplaying = () => { setSpeaking(true); startMeter(element); };
          element.onended = () => { setSpeaking(false); stopMeter(); releaseAudio(); };
          element.onerror = () => {
            setSpeaking(false);
            stopMeter();
            releaseAudio();
            setError("The audio could not be played.");
          };

          void element.play().catch(() => {
            setSpeaking(false);
            setError("The browser blocked audio playback until you interact with the page.");
          });
        })
        .catch((err) => {
          if (controller.signal.aborted) return;
          inFlight.current = null;
          setPreparing(false);
          setError(err instanceof Error ? err.message : "Speech synthesis failed.");
        });
      return;
    }

    if (engine === "browser" && synth) {
      const utterance = new SpeechSynthesisUtterance(spoken);
      utterance.onstart = () => setSpeaking(true);
      utterance.onend = () => setSpeaking(false);
      utterance.onerror = () => setSpeaking(false);
      synth.speak(utterance);
      return;
    }

    setError("No voice is available on this machine.");
  }, [engine, synth, stop, releaseAudio, startMeter, stopMeter]);

  return {
    enabled,
    setEnabled,
    engine,
    neural,
    speaking,
    preparing,
    error,
    /**
     * The neural voice's own live loudness, 0..1, while it is speaking.
     * Undefined for the browser fallback, which exposes no audio to read —
     * consumers pass it straight to Core, where undefined means "use the
     * canned animation" rather than "silent".
     */
    amplitude,
    speak,
    stop
  };
}
