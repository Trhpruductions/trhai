/**
 * Deciding when someone started and stopped talking, from loudness alone.
 *
 * This is what makes the microphone hands-free. Pressing a button before every
 * sentence is the thing that stops a voice assistant feeling like one — you
 * are operating a dictaphone, not talking to something. With this the mic
 * stays open, and an utterance is whatever sits between a rise and a silence.
 *
 * Deliberately a pure state machine over (time, level) pairs. The real audio
 * path is a browser AudioContext that cannot run in a test, and the part most
 * likely to be wrong is not the wiring but the judgement: how loud counts as
 * speech, how long a pause ends a sentence, how short a noise to ignore. All
 * of that is here, where it can be fed a recording of numbers and checked.
 *
 * It is not speech recognition. It cannot tell a voice from a door slamming —
 * whisper decides that later, and returns nothing when there were no words.
 * This only decides when to hand it something.
 */

export type VoiceActivityOptions = {
  /**
   * How far above the measured noise floor counts as speech.
   *
   * A fixed threshold cannot work: the same number is silence in one room and
   * shouting in another. The floor is learned from the quiet passages, and
   * this is the margin above it.
   */
  margin: number;
  /** Speech must hold above the threshold this long before an utterance opens. */
  onsetMs: number;
  /** Silence must hold below it this long before the utterance closes. */
  hangoverMs: number;
  /** Anything shorter than this is a cough, a click, or a chair. */
  minUtteranceMs: number;
  /** A safety valve: nobody speaks one sentence for this long. */
  maxUtteranceMs: number;
};

export const defaultVoiceActivity: VoiceActivityOptions = {
  // Tuned against the meter in useMicrophone, where ordinary speech at a
  // normal distance lands around 0.3–0.7 and a quiet room sits near 0.02.
  margin: 0.08,
  onsetMs: 140,
  // Long enough to speak through a comma. Shorter and it cuts people off
  // mid-sentence, which is worse than waiting a beat.
  hangoverMs: 850,
  minUtteranceMs: 320,
  maxUtteranceMs: 30_000
};

export type VoiceActivityState = {
  /** The learned quiet level. */
  floor: number;
  /** True while an utterance is open. */
  speaking: boolean;
  /** When the current run above/below the threshold began. */
  runStartedAt: number;
  /** When the open utterance began, or null. */
  utteranceStartedAt: number | null;
};

export type VoiceActivityEvent =
  | { type: "none" }
  | { type: "started" }
  /** An utterance worth transcribing just ended. */
  | { type: "ended"; durationMs: number }
  /** It ended, but was too short to be words. */
  | { type: "discarded"; durationMs: number };

export function initialVoiceActivity(now = 0): VoiceActivityState {
  return { floor: 0.02, speaking: false, runStartedAt: now, utteranceStartedAt: null };
}

/**
 * One sample in, one decision out.
 *
 * `level` is the smoothed 0..1 loudness the microphone already computes, so
 * this adds no audio processing of its own.
 */
export function stepVoiceActivity(
  state: VoiceActivityState,
  level: number,
  now: number,
  options: VoiceActivityOptions = defaultVoiceActivity
): { state: VoiceActivityState; event: VoiceActivityEvent } {
  // The floor learns the room: fast downward, slower upward.
  //
  // The asymmetry is what separates a fan from a voice, and it is the whole
  // trick. Steady noise never dips, so it drags the floor up until it sits
  // above the noise and stops triggering. Speech dips constantly — between
  // syllables, between phrases — and every dip yanks the floor back down at
  // the fast rate, so a person talking never trains the system to ignore them.
  //
  // The upward rate was 0.0008 first, which was far too slow to be any use: a
  // room at 0.20 was only learned to 0.047 after four seconds, so the room
  // itself stayed above the threshold, an utterance opened at the first sample
  // and never closed, and a sentence spoken into it arrived already inside one.
  // At 0.02 a steady background is learned in about two seconds.
  const floor = level < state.floor
    ? state.floor + (level - state.floor) * 0.25
    : state.floor + (level - state.floor) * 0.02;

  const threshold = floor + options.margin;
  const loud = level > threshold;
  const next: VoiceActivityState = { ...state, floor };

  // A run is an unbroken stretch on one side of the threshold. Crossing it
  // restarts the clock below, which is what makes onset and hangover mean
  // "sustained" rather than "instantaneous".

  if (!state.speaking) {
    if (!loud) {
      next.runStartedAt = now;
      return { state: next, event: { type: "none" } };
    }
    if (now - state.runStartedAt >= options.onsetMs) {
      next.speaking = true;
      next.utteranceStartedAt = now - options.onsetMs;
      next.runStartedAt = now;
      return { state: next, event: { type: "started" } };
    }
    return { state: next, event: { type: "none" } };
  }

  const startedAt = state.utteranceStartedAt ?? now;

  // Runaway guard first: a stuck-open microphone in a noisy room would
  // otherwise never close, and the recording would grow until the cap in
  // useMicrophone truncated it silently.
  if (now - startedAt >= options.maxUtteranceMs) {
    return {
      state: { ...next, speaking: false, utteranceStartedAt: null, runStartedAt: now },
      event: { type: "ended", durationMs: now - startedAt }
    };
  }

  if (loud) {
    next.runStartedAt = now;
    return { state: next, event: { type: "none" } };
  }

  if (now - state.runStartedAt >= options.hangoverMs) {
    // The hangover is not part of what was said, so it comes off the length.
    const durationMs = Math.max(0, now - startedAt - options.hangoverMs);
    const closed: VoiceActivityState = {
      ...next, speaking: false, utteranceStartedAt: null, runStartedAt: now
    };
    return {
      state: closed,
      event: durationMs >= options.minUtteranceMs
        ? { type: "ended", durationMs }
        : { type: "discarded", durationMs }
    };
  }

  return { state: next, event: { type: "none" } };
}
