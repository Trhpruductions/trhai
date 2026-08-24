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
    if (audio.current) {
      audio.current.pause();
      audio.current.src = "";
      audio.current = null;
    }
    releaseAudio();
    setSpeaking(false);
    setPreparing(false);
  }, [synth, releaseAudio]);

  useEffect(() => () => { synth?.cancel(); audio.current?.pause(); releaseAudio(); }, [synth, releaseAudio]);

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

          element.onplaying = () => setSpeaking(true);
          element.onended = () => { setSpeaking(false); releaseAudio(); };
          element.onerror = () => { setSpeaking(false); releaseAudio(); setError("The audio could not be played."); };

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
  }, [engine, synth, stop, releaseAudio]);

  return { enabled, setEnabled, engine, neural, speaking, preparing, error, speak, stop };
}
