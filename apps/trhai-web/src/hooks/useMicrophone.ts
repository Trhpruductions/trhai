"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// The microphone, read locally and nowhere else.
//
// This captures loudness only: getUserMedia into an AnalyserNode, RMS per
// frame, and nothing is recorded, buffered beyond the analyser's own window,
// uploaded, or sent anywhere. That is the whole point — a "listening" state
// in this app has to mean a real microphone is genuinely open, and the
// waveform on screen has to be this machine's actual audio rather than a
// sine wave dressed up as one.
//
// It deliberately does NOT transcribe. The browser's own SpeechRecognition
// is free and needs no key, but Chrome's implementation streams the audio to
// Google's servers to do it — which would quietly break the promise the rest
// of this build keeps (a local model, local storage, nothing leaving the
// machine). Speech-to-text belongs behind the same door the neural voice
// went through: a local binary, installed deliberately, documented. Until
// that exists, this hook makes the listening state honest and stops there.

export type MicrophoneState = {
  /** False when the browser has no getUserMedia at all (or an insecure origin). */
  supported: boolean;
  listening: boolean;
  /** Smoothed RMS loudness, 0..1. Zero whenever the microphone is closed. */
  amplitude: number;
  /** Why the microphone could not open, in the user's words rather than an error code. */
  error: string | null;
  start: () => Promise<void>;
  stop: () => void;
};

/** Rises fast so a word registers immediately, falls slowly so it does not flicker. */
const attack = 0.5;
const release = 0.12;

export function useMicrophone(): MicrophoneState {
  const [listening, setListening] = useState(false);
  const [amplitude, setAmplitude] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [supported, setSupported] = useState(false);

  const stream = useRef<MediaStream | null>(null);
  const context = useRef<AudioContext | null>(null);
  const frame = useRef<number | null>(null);
  const smoothed = useRef(0);

  useEffect(() => {
    setSupported(typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia));
  }, []);

  const stop = useCallback(() => {
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    // Every track stopped explicitly: without this the browser's recording
    // indicator stays lit after the user has stopped talking to the app,
    // which is exactly the kind of thing that makes a microphone feature
    // feel untrustworthy.
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    void context.current?.close().catch(() => { /* already closed */ });
    context.current = null;
    smoothed.current = 0;
    setAmplitude(0);
    setListening(false);
  }, []);

  const start = useCallback(async () => {
    if (listening) return;
    setError(null);

    if (!navigator.mediaDevices?.getUserMedia) {
      setError("This browser cannot open a microphone.");
      return;
    }

    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.current = media;

      const audio = new AudioContext();
      context.current = audio;
      const source = audio.createMediaStreamSource(media);
      const analyser = audio.createAnalyser();
      // Small window: this is a level meter, not a spectrogram, and a short
      // buffer keeps the reading responsive to speech.
      analyser.fftSize = 512;
      source.connect(analyser);

      const samples = new Uint8Array(analyser.fftSize);
      setListening(true);

      const read = () => {
        analyser.getByteTimeDomainData(samples);

        // RMS around the 128 midpoint of unsigned 8-bit PCM.
        let sum = 0;
        for (let index = 0; index < samples.length; index += 1) {
          const centred = (samples[index] - 128) / 128;
          sum += centred * centred;
        }
        const rms = Math.sqrt(sum / samples.length);

        // Scaled so ordinary speech uses most of the range: raw RMS for a
        // voice at a normal distance sits well under 0.2, and an unscaled
        // meter would look broken.
        const level = Math.min(1, rms * 3.2);
        const rate = level > smoothed.current ? attack : release;
        smoothed.current += (level - smoothed.current) * rate;

        setAmplitude(Math.round(smoothed.current * 100) / 100);
        frame.current = requestAnimationFrame(read);
      };

      frame.current = requestAnimationFrame(read);
    } catch (caught) {
      // Refusing the permission prompt is an ordinary choice, not a fault,
      // and it reads differently from a machine with no microphone at all.
      const name = caught instanceof DOMException ? caught.name : "";
      setError(
        name === "NotAllowedError"
          ? "Microphone access was declined. Allow it in the browser to use voice."
          : name === "NotFoundError"
            ? "No microphone was found on this machine."
            : "The microphone could not be opened."
      );
      stop();
    }
  }, [listening, stop]);

  // Closing the tab or navigating away must release the device.
  useEffect(() => stop, [stop]);

  return { supported, listening, amplitude, error, start, stop };
}
