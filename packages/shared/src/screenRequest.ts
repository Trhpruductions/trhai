// Whether a message asks about what is on the user's screen right now: "what's
// on my screen", "read the error on my screen", "look at my monitor".
//
// The web client shares the screen when it sees one - it is the only side that
// can, through the desktop app or the browser's own share prompt - and sends
// the picture with the question. The API answers one that arrives without a
// picture by saying how to share it, rather than letting a model that cannot
// see describe a screen it has never looked at. Shared, so the two cannot
// disagree about which messages these are.
//
// Deliberately narrow, because a match takes a picture of the screen. "Save it
// on my desktop" is a folder, "check my screen time" is a setting, and "how do
// I make the text bigger on my screen" is a how-to that a picture of the
// screen does not answer: none of those should start a capture.

/** Things a screen has that are not what is on it. */
const notTheContents = "(?!\\s*(?:time|saver|savers|recording|recordings|recorder|resolution|brightness|settings|size|sizes|driver|drivers|cable|cables|protector|protectors|lock|share|sharing|name|names|refresh|rate|scaling)\\b)";
const screen = `(?:screen|screens|monitor|monitors|display|displays)\\b${notTheContents}`;
const which = "(?:(?:other|second|main|left|right|first)\\s+)?";

const lookAtIt = new RegExp(
  `\\b(?:look(?:ing)?\\s+at|glance\\s+at|read|check|see|scan|describe|explain|view|analy[sz]e)\\s+(?:my|the|this|that)\\s+${which}${screen}`,
  "i"
);
const onIt = new RegExp(`\\bon\\s+(?:my|the|this|that)\\s+${which}${screen}`, "i");
const howTo = /^\s*(?:how\s+(?:do|can|could|would|should|to)\b|how's\s+(?:one|someone)\b)/i;

export function asksAboutTheScreen(message: string): boolean {
  const text = message ?? "";
  if (lookAtIt.test(text)) return true;
  if (/\bwhat\s+am\s+i\s+(?:looking\s+at|seeing)\b/i.test(text)) return true;
  // "what's on my screen", "the error on my screen" - but not a how-to.
  return onIt.test(text) && !howTo.test(text);
}
