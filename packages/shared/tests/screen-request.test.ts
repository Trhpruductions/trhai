import test from "node:test";
import assert from "node:assert/strict";
import { asksAboutTheScreen } from "../src/screenRequest.js";

test("a question about what is on the screen is recognised", () => {
  for (const asked of [
    "what's on my screen?",
    "What is on my screen right now",
    "look at my screen",
    "can you look at my monitor and tell me what's wrong",
    "read my screen",
    "can you see my screen?",
    "describe my screen",
    "what does the error on my screen mean?",
    "read the text on my screen",
    "explain what's on my other monitor",
    "what's on the second screen",
    "what am I looking at?",
    "check my screen and tell me if the download finished",
    "summarize the article on my screen"
  ]) {
    assert.equal(asksAboutTheScreen(asked), true, asked);
  }
});

test("talk about screens that is not about what they show takes no picture", () => {
  for (const asked of [
    "how do I make the text bigger on my screen?",
    "how to change the resolution on my monitor",
    "check my screen time",
    "save it on my desktop",
    "put the file on the desktop",
    "take a screenshot",
    "my screen is broken, where can I get it repaired?",
    "what's the best screen protector?",
    "turn off the screen saver",
    "set my display brightness to 50",
    "look at the display settings",
    "what's the weather",
    "",
    "what is a computer monitor"
  ]) {
    assert.equal(asksAboutTheScreen(asked), false, asked);
  }
});
