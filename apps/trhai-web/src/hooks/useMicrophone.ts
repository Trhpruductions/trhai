"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiBaseUrl } from "../lib/api";
import { concatSamples, encodeWav, resampleMono } from "../lib/wav";

// The microphone, read and transcribed locally and nowhere else.
//
// Two things happen while listening: an AnalyserNode gives the RMS level that
// drives the core and the waveform, and the raw samples are kept so they can
// be transcribed when the user stops. Both stay on this machine.
//
// The browser's own SpeechRecognition would have been far less code, is free,
// and needs no key — and Chrome implements it by streaming the microphone to
// Google's servers. That would have passed every test in this repo while
// quietly breaking the one promise the rest of the build keeps. So the audio
// goes to whisper.cpp behind the local API instead (see
// whisperTranscribe.ts), which is the same door the neural voice went
// through: an open-source binary, installed deliberately, no account.
//
// Transcription is optional at runtime. When whisper is not installed the
// microphone still works as a level meter and says so, rather than the button
// silently doing nothing.

export type MicrophoneState = {
  /** False when the browser has no getUserMedia at all (or an insecure origin). */
  supported: boolean;
  listening: boolean;
  /** True while captured audio is being transcribed. */
  transcribing: boolean;
  /** Smoothed RMS loudness, 0..1. Zero whenever the microphone is closed. */
  amplitude: number;
  /** Why the microphone failed, in the user's words rather than an error code. */
  error: string | null;
  /** Whether local speech-to-text is installed. Null until checked. */
  transcriptionAvailable: boolean | null;
  /** Why transcription is unavailable, when it is. */
  transcriptionReason: string | null;
  start: () => Promise<void>;
  /** Stops the microphone and resolves with what was said, or null. */
  stop: () => Promise<string | null>;
  /** Hands-free: mark where the current utterance began. */
  markUtteranceStart: () => void;
  /** Hands-free: transcribe since the mark, leaving the microphone open. */
  takeUtterance: () => Promise<string | null>;
};

/** Rises fast so a word registers immediately, falls slowly so it does not flicker. */
const attack = 0.5;
const release = 0.12;

/** Long enough for a spoken command, short enough that nothing runs away. */
const maxCaptureSeconds = 60;

export function useMicrophone(): MicrophoneState {
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [amplitude, setAmplitude] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [supported, setSupported] = useState(false);
  const [transcriptionAvailable, setTranscriptionAvailable] = useState<boolean | null>(null);
  const [transcriptionReason, setTranscriptionReason] = useState<string | null>(null);

  const stream = useRef<MediaStream | null>(null);
  const context = useRef<AudioContext | null>(null);
  const processor = useRef<ScriptProcessorNode | null>(null);
  const frame = useRef<number | null>(null);
  const smoothed = useRef(0);
  const captured = useRef<Float32Array[]>([]);
  const capturedRate = useRef(0);
  const capturedLength = useRef(0);
  /**
   * Where the current hands-free utterance began, as a sample offset.
   *
   * Hands-free keeps one audio graph open for the whole conversation and cuts
   * utterances out of it. Calling start()/stop() per sentence would reacquire
   * the device each time — slow, and it flashes the browser's recording
   * indicator on and off, which makes a microphone feel untrustworthy.
   */
  const utteranceStart = useRef<number | null>(null);

  useEffect(() => {
    setSupported(typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia));
  }, []);

  // Whether whisper.cpp is installed, asked once. The button's wording depends
  // on this: offering "speak your request" when nothing can hear words would
  // be the exact overclaim this feature exists to avoid.
  useEffect(() => {
    let cancelled = false;
    fetch(`${apiBaseUrl}/v1/transcribe`)
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (cancelled) return;
        const data = payload?.data;
        setTranscriptionAvailable(data?.available === true);
        setTranscriptionReason(
          data?.available === true
            ? null
            : typeof data?.reason === "string" ? data.reason : "Local speech-to-text is not installed."
        );
      })
      .catch(() => {
        if (cancelled) return;
        setTranscriptionAvailable(false);
        setTranscriptionReason("Could not reach the transcription service.");
      });
    return () => { cancelled = true; };
  }, []);

  /** Tears down the audio graph. Returns what was captured, for transcription. */
  const teardown = useCallback((): { samples: Float32Array; rate: number } => {
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    processor.current?.disconnect();
    processor.current = null;
    // Every track stopped explicitly: without this the browser's recording
    // indicator stays lit after the user has stopped talking to the app,
    // which is exactly the kind of thing that makes a microphone feature
    // feel untrustworthy.
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    void context.current?.close().catch(() => { /* already closed */ });
    context.current = null;

    const samples = concatSamples(captured.current);
    const rate = capturedRate.current;
    captured.current = [];
    capturedLength.current = 0;
    smoothed.current = 0;
    setAmplitude(0);
    setListening(false);
    return { samples, rate };
  }, []);

  /**
   * Stop listening and transcribe what was captured.
   *
   * Resolves with the text, or null when there was nothing to transcribe,
   * whisper is not installed, or the audio held no recognisable speech. Null
   * is a real outcome rather than a failure — the caller leaves the command
   * box alone and the reason is shown separately.
   */
  const stop = useCallback(async (): Promise<string | null> => {
    if (!listening) {
      teardown();
      return null;
    }

    const { samples, rate } = teardown();
    if (samples.length === 0 || rate === 0) return null;
    if (transcriptionAvailable !== true) return null;

    setTranscribing(true);
    setError(null);
    try {
      // Resampled and encoded here rather than on the server, so the install
      // stays one binary instead of whisper plus ffmpeg.
      const wav = encodeWav(resampleMono(samples, rate));

      const response = await fetch(`${apiBaseUrl}/v1/transcribe`, {
        method: "POST",
        headers: { "Content-Type": "audio/wav" },
        body: wav
      });

      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        setError(typeof payload?.message === "string" ? payload.message : "Transcription failed.");
        return null;
      }

      const text = typeof payload?.data?.text === "string" ? payload.data.text.trim() : "";
      return text || null;
    } catch {
      setError("Could not reach the transcription service.");
      return null;
    } finally {
      setTranscribing(false);
    }
  }, [listening, teardown, transcriptionAvailable]);

  /** Mark the start of an utterance at the current position in the capture. */
  const markUtteranceStart = useCallback(() => {
    utteranceStart.current = capturedLength.current;
  }, []);

  /**
   * Transcribe everything captured since the mark, leaving the mic open.
   *
   * Returns null when there is nothing usable — no mark, no audio, whisper not
   * installed, or no recognisable words in it. Null is an ordinary outcome
   * here: hands-free listening hands over every noise that looked like speech,
   * and most rooms produce a few that are not.
   */
  const takeUtterance = useCallback(async (): Promise<string | null> => {
    const from = utteranceStart.current;
    utteranceStart.current = null;
    if (from === null || transcriptionAvailable !== true) return null;

    const rate = capturedRate.current;
    if (!rate) return null;

    const all = concatSamples(captured.current);
    const slice = all.subarray(Math.min(from, all.length));
    if (slice.length === 0) return null;

    // The buffer is trimmed to what has not been transcribed yet, so a long
    // conversation does not grow one array until the cap silently truncates it.
    captured.current = [all.subarray(all.length)];
    capturedLength.current = 0;

    setTranscribing(true);
    try {
      const wav = encodeWav(resampleMono(slice, rate));
      const response = await fetch(`${apiBaseUrl}/v1/transcribe`, {
        method: "POST",
        headers: { "Content-Type": "audio/wav" },
        body: wav
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) return null;
      const text = typeof payload?.data?.text === "string" ? payload.data.text.trim() : "";
      return text || null;
    } catch {
      return null;
    } finally {
      setTranscribing(false);
    }
  }, [transcriptionAvailable]);

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

      // Raw samples, kept for transcription. ScriptProcessorNode is formally
      // deprecated in favour of AudioWorklet, and is used anyway: a worklet
      // needs a separate module file fetched at runtime, which Next's bundler
      // would have to be taught to emit, for a node that only copies floats
      // into an array. Every current browser still supports this, and the
      // deprecation has no removal date.
      captured.current = [];
      capturedLength.current = 0;
      capturedRate.current = audio.sampleRate;
      const capture = audio.createScriptProcessor(4096, 1, 1);
      processor.current = capture;

      const maxSamples = audio.sampleRate * maxCaptureSeconds;
      capture.onaudioprocess = (event) => {
        if (capturedLength.current >= maxSamples) return;
        // Copied, not referenced: the event's buffer is reused by the audio
        // thread on the next callback, so keeping it would give a recording
        // of the same fraction of a second repeated end to end.
        const chunk = new Float32Array(event.inputBuffer.getChannelData(0));
        captured.current.push(chunk);
        capturedLength.current += chunk.length;
      };

      source.connect(capture);
      // Connected to the destination because a ScriptProcessorNode does not
      // run otherwise. A zero gain keeps it silent — without this the user
      // hears themselves echoed back through their own speakers.
      const mute = audio.createGain();
      mute.gain.value = 0;
      capture.connect(mute);
      mute.connect(audio.destination);

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
      teardown();
    }
  }, [listening, teardown]);

  // Closing the tab or navigating away must release the device. Tears the
  // graph down directly rather than going through stop(), which would try to
  // transcribe on the way out of a page that is already leaving.
  useEffect(() => () => { teardown(); }, [teardown]);

  return {
    markUtteranceStart,
    takeUtterance,
    supported,
    listening,
    transcribing,
    amplitude,
    error,
    transcriptionAvailable,
    transcriptionReason,
    start,
    stop
  };
}
