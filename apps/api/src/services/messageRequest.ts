import { normalizePhoneNumber, parseEmailAddresses } from "./messaging.js";

// A request to text or email someone that says everything outright - the
// number or address, and the words - read without the model.
//
// The model handles these, and in a fresh conversation it does well. A few
// turns into one it does not: live, after five unrelated questions, "text
// 555-010-0123 that I'm running 10 minutes late" got no message ready, twice,
// with send_text on offer - the earlier answers, none of which used a tool,
// were the pattern it followed. When the request names the number and the
// words, there is nothing left to decide, so nothing is left to the model.
// Anything less explicit - "text mom", "email my boss about Friday" - still
// goes to the model, which can ask for the number or compose the message.
//
// What this returns is only ever held, never sent: it is shown word for word
// and waits for a yes, exactly as a message the model wrote would.

export type DirectMessage =
  | { tool: "send_text"; arguments: { to: string; message: string } }
  | { tool: "send_email"; arguments: { to: string; subject: string; body: string } };

/** "can you", "please", "hey" - asking, not part of the message. */
const politeStart = /^\s*(?:(?:hey|hi|ok|okay|so)[,!\s]+)?(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+)?/i;
const asksAsAQuestion = /^\s*(?:(?:hey|hi|ok|okay|so)[,!\s]+)?(?:can|could|would|will)\s+you\b/i;

// A phone number written the ways people write one, tried longest first so a
// country code is not left behind as part of the message.
const phone = [
  String.raw`\+?\d{1,3}[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}`,
  String.raw`\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}`,
  String.raw`\+\d{7,15}`,
  String.raw`\d{3}[\s.-]?\d{4}`
].join("|");
const address = String.raw`[^\s@,;<>"']+@[^\s@,;<>"']+\.[A-Za-z]{2,}`;

const textTo = new RegExp(
  String.raw`^(?:text|sms|message|send\s+(?:a\s+)?(?:text|sms|message)\s+to)\s+(${phone})\b(.*)$`, "i");
const sendNumberAText = new RegExp(String.raw`^send\s+(${phone})\s+an?\s+(?:text|sms|message)\b(.*)$`, "i");
const emailTo = new RegExp(String.raw`^(?:e-?mail|send\s+(?:an\s+)?e-?mail\s+to)\s+(${address})(.*)$`, "i");
const sendAddressAnEmail = new RegExp(String.raw`^send\s+(${address})\s+an\s+e-?mail\b(.*)$`, "i");

/**
 * What joins the recipient to the words, when the words are given verbatim.
 * "about" is deliberately absent: "text her about dinner" asks for a message
 * to be written, which is the model's job, not a quotation.
 */
const verbatim = /^\s*(?:[:,-]\s*)?(?:(?:that|saying|to\s+say|and\s+say|(?:and\s+)?tell(?:ing)?\s+(?:them|him|her)|(?:and\s+)?let(?:ting)?\s+(?:them|him|her)\s+know)\s+)?/i;
const quoted = /^\s*["“'‘](.+)["”'’]\s*$/s;

/** The words of the message, or null when the request does not give them outright. */
function wordsAfter(rest: string, wasAQuestion: boolean): string | null {
  let words: string;
  const inQuotes = quoted.exec(rest);
  if (inQuotes) {
    words = inQuotes[1];
  } else {
    // Something has to join them - "that", "saying", a colon. Without it the
    // words are not plainly a quotation ("text 555-0123 10 minutes late"),
    // and a connector must end in a space: "that's fine" is the message.
    const joined = verbatim.exec(rest);
    if (!joined || joined[0].trim() === "") return null;
    words = rest.slice(joined[0].length);
    const stillQuoted = quoted.exec(words);
    if (stillQuoted) words = stillQuoted[1];
  }
  words = words.trim();
  // "can you text ... that I'm running late?" - the question mark is the
  // request's, not the message's.
  if (wasAQuestion && !inQuotes) words = words.replace(/\s*\?$/, "");
  if (words.length < 2 || !/\p{L}/u.test(words)) return null;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** An email's subject from its first sentence, cut at a word near 60 characters. */
export function subjectFrom(body: string): string {
  const first = body.split(/(?<=[.!?])\s+|\n/)[0].replace(/[.!?]+$/, "").trim();
  if (first.length <= 60) return first;
  const cut = first.slice(0, 60);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 30 ? cut.slice(0, lastSpace) : cut).trim()}...`;
}

export function parseDirectMessage(request: string): DirectMessage | null {
  const wasAQuestion = asksAsAQuestion.test(request ?? "");
  const asked = (request ?? "").replace(politeStart, "").trim();
  if (!asked) return null;

  const text = textTo.exec(asked) ?? sendNumberAText.exec(asked);
  if (text) {
    const number = normalizePhoneNumber(text[1]);
    const words = wordsAfter(text[2], wasAQuestion);
    if (!number || !words) return null;
    return { tool: "send_text", arguments: { to: text[1].trim(), message: words } };
  }

  const email = emailTo.exec(asked) ?? sendAddressAnEmail.exec(asked);
  if (email) {
    const to = parseEmailAddresses(email[1]);
    const words = wordsAfter(email[2], wasAQuestion);
    if (!to || !words) return null;
    return { tool: "send_email", arguments: { to: email[1].trim(), subject: subjectFrom(words), body: words } };
  }
  return null;
}
