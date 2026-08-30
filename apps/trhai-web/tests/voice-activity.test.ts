import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultVoiceActivity, initialVoiceActivity, stepVoiceActivity,
  type VoiceActivityEvent, type VoiceActivityOptions
} from "../src/lib/voiceActivity.js";

// The judgement behind hands-free listening: when did someone start talking,
// and when did they stop. Fed recordings of numbers, because the real audio
// path is a browser AudioContext and the part likely to be wrong is the
// decision, not the wiring.

/** Play a script of [durationMs, level] through the machine at 20ms steps. */
function play(
  script: Array<[number, number]>,
  options: VoiceActivityOptions = defaultVoiceActivity
): { events: VoiceActivityEvent[]; floor: number } {
  let state = initialVoiceActivity(0);
  const events: VoiceActivityEvent[] = [];
  let now = 0;

  for (const [duration, level] of script) {
    const until = now + duration;
    while (now < until) {
      const result = stepVoiceActivity(state, level, now, options);
      state = result.state;
      if (result.event.type !== "none") events.push(result.event);
      now += 20;
    }
  }
  return { events, floor: state.floor };
}

const quiet = 0.02;
const speech = 0.45;

test("a spoken sentence in a quiet room opens and closes once", () => {
  const { events } = play([
    [1000, quiet],
    [1400, speech],
    [1500, quiet]
  ]);

  assert.deepEqual(events.map((event) => event.type), ["started", "ended"]);
  const ended = events[1];
  assert.equal(ended.type, "ended");
  if (ended.type !== "ended") return;
  // Roughly the spoken length, with the trailing silence removed.
  assert.ok(
    Math.abs(ended.durationMs - 1400) < 200,
    `utterance measured ${ended.durationMs}ms for 1400ms of speech`
  );
});

test("a pause mid-sentence does not split it in two", () => {
  // The thing that makes an assistant infuriating: being cut off at a comma.
  // 400ms is a breath, not the end of a thought.
  const { events } = play([
    [800, quiet],
    [700, speech],
    [400, quiet],
    [700, speech],
    [1400, quiet]
  ]);

  assert.deepEqual(events.map((event) => event.type), ["started", "ended"]);
});

test("a cough is not a sentence", () => {
  const { events } = play([
    [800, quiet],
    [180, 0.6],
    [1400, quiet]
  ]);

  // It may open — a sharp noise looks like speech starting — but it must not
  // be handed on as something to transcribe.
  assert.ok(!events.some((event) => event.type === "ended"), "a 180ms noise was sent for transcription");
});

test("a quiet room alone never opens an utterance", () => {
  const { events } = play([[6000, quiet]]);
  assert.deepEqual(events, []);
});

test("a noisy room raises the floor rather than hearing speech everywhere", () => {
  // A fan, a server, an air conditioner: constant and loud-ish. If the floor
  // did not learn, every second of it would look like talking.
  const { events, floor } = play([[9000, 0.20]]);

  assert.ok(floor > 0.05, `floor stayed at ${floor.toFixed(3)} in a noisy room`);
  assert.ok(
    events.filter((event) => event.type === "ended").length <= 1,
    "constant room noise was repeatedly transcribed as speech"
  );
});

test("speech is still heard over that raised floor", () => {
  // The floor must not learn so eagerly that it swallows the user.
  const { events } = play([
    [4000, 0.20],
    [1200, 0.75],
    [1500, 0.20]
  ]);

  assert.ok(
    events.some((event) => event.type === "ended"),
    "speech over a noisy background was never heard"
  );
});

test("the floor does not chase a voice upward", () => {
  // If it rose to meet the speaker it would learn them as background and go
  // deaf to them a few seconds in — the failure that makes this worth testing.
  //
  // The script is deliberately uneven. A constant tone held for eight seconds
  // is not speech, and testing against one was asking the floor to distinguish
  // two things that are genuinely identical from level alone. Real speech dips
  // between syllables and phrases, and those dips are exactly what keeps the
  // floor down.
  const script: Array<[number, number]> = [[500, quiet]];
  for (let phrase = 0; phrase < 8; phrase += 1) {
    script.push([600, speech], [120, 0.06], [500, 0.6], [140, 0.05]);
  }

  const { floor } = play(script);
  assert.ok(floor < speech, `the floor climbed to ${floor.toFixed(3)}, at or above the voice itself`);
});

test("a microphone stuck open is closed rather than recording forever", () => {
  const options = { ...defaultVoiceActivity, maxUtteranceMs: 2000 };
  const { events } = play([[600, quiet], [6000, speech]], options);

  const ended = events.filter((event) => event.type === "ended");
  assert.ok(ended.length >= 1, "continuous sound never produced a closed utterance");
  for (const event of ended) {
    if (event.type !== "ended") continue;
    assert.ok(
      event.durationMs <= options.maxUtteranceMs + 100,
      `an utterance ran to ${event.durationMs}ms past a ${options.maxUtteranceMs}ms cap`
    );
  }
});

test("two sentences with a real gap between them are two utterances", () => {
  const { events } = play([
    [700, quiet],
    [800, speech],
    [1600, quiet],
    [800, speech],
    [1600, quiet]
  ]);

  assert.equal(events.filter((event) => event.type === "started").length, 2);
  assert.equal(events.filter((event) => event.type === "ended").length, 2);
});
