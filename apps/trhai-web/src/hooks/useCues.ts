"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Sound cues for real events.
//
// Every cue is fired by something that actually happened — the microphone
// opening, a turn being sent, a tool finishing, an error arriving. None of
// them is on a timer, so the app is silent when nothing is going on. That is
// the same rule the visuals follow: a sound that plays regardless of state
// tells the user nothing and becomes noise within a minute.
//
// The tones are synthesised rather than shipped as files. Six short WAVs would
// be about a megabyte of assets to hand-author, and a two-oscillator envelope
// is both smaller and easier to keep subtle — the brief here is a system
// acknowledging you, not a game HUD.
//
// Off by default. Sound is the one channel a user cannot look away from, so it
// is opt-in and the choice is remembered.

export type Cue = "listen" | "send" | "done" | "error" | "arm" | "warn";

const storageKey = "trhai.cues.enabled.v1";

/**
 * Each cue as a short two-note gesture.
 *
 * Rising intervals read as opening or succeeding, falling ones as closing or
 * failing — the same convention a lift chime and an error beep already use, so
 * it needs no learning. Volumes are deliberately low; these sit under speech.
 */
const cues: Record<Cue, { notes: number[]; duration: number; gain: number; type: OscillatorType }> = {
  // Opening the microphone: a soft rise, quiet enough not to be captured as
  // the first thing the microphone hears.
  listen: { notes: [523.25, 783.99], duration: 0.1, gain: 0.05, type: "sine" },
  send: { notes: [659.25], duration: 0.06, gain: 0.045, type: "sine" },
  done: { notes: [659.25, 987.77], duration: 0.11, gain: 0.055, type: "sine" },
  error: { notes: [311.13, 233.08], duration: 0.16, gain: 0.07, type: "triangle" },
  // Arming machine control is the one genuinely consequential toggle in the
  // app, so its cue is the most distinct: a low, deliberate pair.
  arm: { notes: [392, 523.25], duration: 0.13, gain: 0.06, type: "triangle" },
  warn: { notes: [440, 440], duration: 0.09, gain: 0.055, type: "triangle" }
};

function readStored(): boolean {
  try {
    return window.localStorage.getItem(storageKey) === "on";
  } catch {
    // localStorage throws in a private window with storage blocked. Silence is
    // the safe default when the preference cannot be read.
    return false;
  }
}

export function useCues() {
  const [enabled, setEnabled] = useState(false);
  const context = useRef<AudioContext | null>(null);

  useEffect(() => {
    setEnabled(readStored());
  }, []);

  const toggle = useCallback(() => {
    setEnabled((on) => {
      const next = !on;
      try {
        window.localStorage.setItem(storageKey, next ? "on" : "off");
      } catch {
        // Not being able to remember the choice is not a reason to ignore it
        // for this session.
      }
      return next;
    });
  }, []);

  const play = useCallback((cue: Cue) => {
    if (!enabled) return;

    try {
      // Created on first use, not on mount: an AudioContext opened before any
      // user gesture starts suspended in every current browser, and some log a
      // warning about it. By the time a cue fires the user has interacted.
      if (!context.current) context.current = new AudioContext();
      const audio = context.current;
      if (audio.state === "suspended") void audio.resume();

      const { notes, duration, gain, type } = cues[cue];
      const start = audio.currentTime;

      notes.forEach((frequency, index) => {
        const at = start + index * duration * 0.72;
        const oscillator = audio.createOscillator();
        const envelope = audio.createGain();

        oscillator.type = type;
        oscillator.frequency.setValueAtTime(frequency, at);

        // A ramped envelope rather than a raw start/stop: switching a
        // full-amplitude oscillator on instantly produces a click, which is
        // audible and sounds broken.
        envelope.gain.setValueAtTime(0, at);
        envelope.gain.linearRampToValueAtTime(gain, at + 0.012);
        envelope.gain.exponentialRampToValueAtTime(0.0001, at + duration);

        oscillator.connect(envelope);
        envelope.connect(audio.destination);
        oscillator.start(at);
        oscillator.stop(at + duration + 0.02);
      });
    } catch {
      // A cue failing must never interrupt the thing it was announcing.
    }
  }, [enabled]);

  useEffect(() => () => {
    void context.current?.close().catch(() => { /* already closed */ });
    context.current = null;
  }, []);

  return { enabled, toggle, play };
}
