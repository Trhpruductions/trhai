import test from "node:test";
import assert from "node:assert/strict";
import { answerClockQuestion } from "../src/services/clockQuestion.js";

// The date and the time are read off the clock, not asked of the model. Asked
// of the model on a PC with no graphics card, "what's today's date" took 113
// seconds in the live check, because it had to call current_datetime first.

// Thursday, October 15, 2026, 1:35 PM, on the PC's own clock.
const afternoon = new Date(2026, 9, 15, 13, 35, 7);
const says = (message: string, now: Date = afternoon) => answerClockQuestion(message, now, "en-US");

test("the date, asked the usual ways, is read off the clock", () => {
  for (const message of [
    "What's today's date?", "what is the date", "what is the date today", "what's the current date", "whats the date",
    "today's date", "what date is it", "what date is it today?", "what day is it", "what day is it today?",
    "what day is today", "what is today", "whats today", "what the date is", "tell me the date",
    "give me today's date", "can you tell me what day it is", "Hey, what's the date?", "What’s the date?"
  ]) {
    assert.equal(says(message), "Today is Thursday, October 15, 2026.", message);
  }
});

test("the time, asked the usual ways, is read off the clock", () => {
  for (const message of [
    "what time is it", "What time is it?", "what time is it now", "what time is it right now?", "what's the time",
    "what is the time", "what is the current time", "whats the time right now", "what the time is", "current time",
    "time now", "do you have the time", "do you know the time", "tell me the time", "give me the current time",
    "can you tell me what time it is", "what time is it please", "What’s the time?"
  ]) {
    assert.equal(says(message), "It is 1:35 PM.", message);
  }
});

test("both at once", () => {
  for (const message of [
    "what's the date and time", "what is the time and date", "what's the current date and time right now",
    "what day and time is it", "what time and day is it now", "tell me the date and time"
  ]) {
    assert.equal(says(message), "It is 1:35 PM on Thursday, October 15, 2026.", message);
  }
});

test("the hours read as on a clock face, across midnight and noon", () => {
  assert.equal(says("what time is it", new Date(2026, 9, 15, 0, 5)), "It is 12:05 AM.");
  assert.equal(says("what time is it", new Date(2026, 9, 15, 9, 7)), "It is 9:07 AM.");
  assert.equal(says("what time is it", new Date(2026, 9, 15, 12, 0)), "It is 12:00 PM.");
  assert.equal(says("what time is it", new Date(2026, 9, 15, 23, 59)), "It is 11:59 PM.");
  assert.equal(says("what's the date", new Date(2027, 0, 1, 0, 0)), "Today is Friday, January 1, 2027.");
});

test("a narrow no-break space before AM or PM, which some ICU versions write, comes out as an ordinary space", () => {
  // This Node does not write one, so the formatter is made to: the line that turns it into a space has to be proved, not trusted.
  const narrow = String.fromCharCode(0x202f);
  const proto = Date.prototype as { toLocaleTimeString: (...args: unknown[]) => string };
  const original = proto.toLocaleTimeString;
  proto.toLocaleTimeString = () => `1:35${narrow}PM`;
  try {
    assert.equal(says("what time is it"), "It is 1:35 PM.");
    assert.equal(says("what's the date and time"), "It is 1:35 PM on Thursday, October 15, 2026.");
  } finally {
    proto.toLocaleTimeString = original;
  }
});

test("anything that is not purely a date or time question is left to the model", () => {
  for (const message of [
    "what time is it in Tokyo", "what time does the store open", "what time is the meeting tomorrow",
    "what's the date of the meeting", "what is the date of birth of Einstein", "what day is christmas",
    "what day is it, and what is 2+2", "what time is it and remind me to call mom", "what's the weather",
    "what is time", "what is a date", "set the time to 5pm", "what time zone am I in", "how long ago was 2020",
    "what's today's date in Japan", "what day is it on Mars", "what day of the week is December 25, 2026"
  ]) {
    assert.equal(says(message), null, message);
  }
});

test("a single word, or a bare noun with nothing asking for it, is not a question", () => {
  for (const message of ["time", "date", "the time", "the date", "today"]) {
    assert.equal(says(message), null, message);
  }
});

test("an empty message, and no message at all", () => {
  assert.equal(says(""), null);
  assert.equal(says("   "), null);
  assert.equal(answerClockQuestion(undefined as unknown as string, afternoon, "en-US"), null);
});

test("a question broken over two lines is still the question", () => {
  assert.equal(says("what time\nis it"), "It is 1:35 PM.");
});

test("a very long message is turned down at once, not read", () => {
  // Every message reaches this reader before the model. Taking the trailing
  // punctuation off a long run of it costs time in the square of its length:
  // 50,000 question marks and a letter held the API for 3 to 5 seconds.
  const flood = `${"?".repeat(50_000)}x`;
  const started = performance.now();
  assert.equal(says(flood), null);
  assert.ok(performance.now() - started < 250, `took ${Math.round(performance.now() - started)} ms`);
  assert.equal(says(`what time is it${"?".repeat(300)}`), null);
  // The longest way of asking that is answered is far inside the limit.
  assert.equal(
    says("Hey, could you please tell me the current date and time right now?"),
    "It is 1:35 PM on Thursday, October 15, 2026."
  );
});
