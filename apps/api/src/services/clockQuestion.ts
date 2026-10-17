// The date and the time of day, read off the clock and not asked of the model.
//
// "What's today's date?" is a reading, not a question. Asked of the model it
// had to call current_datetime and say what came back: 113 seconds in the live
// check on the PC with no graphics card. On any PC it has gone wrong in ways a
// clock cannot: the tool called twice and the answer "Today's date is not
// recorded", and the date half of a two-part question dropped without a word.
//
// Only a message that is a date or time question and nothing else is answered
// here, the way arithmeticQuestion.ts and unitConversion.ts do it. "what time
// is it in Tokyo", "what time does the store open" and "what day is it, and
// what is 2+2" still go to the model whole.

/** What can come before the question. Group 1 is a plain request ("tell me ..."), which can be followed by a bare "the time". */
const lead = /^(?:(?:please|pls|hey|hi|ok|okay|so|and|just)[ ,]+)*(?:(?:can|could|would|will) you (?:please )?)?((?:tell me|let me know|give me)[ ,]+)?/;

const atTheMoment = String.raw`(?: (?:today|now|right now|currently|at the moment|please))?`;
const whatIs = String.raw`(?:what(?:'s| is)|whats)`;

const dateQuestions = [
  new RegExp(String.raw`^${whatIs} (?:the )?(?:today'?s |todays |current )?date${atTheMoment}$`),
  new RegExp(String.raw`^what (?:the |today'?s |todays |the current )date is${atTheMoment}$`),
  /^(?:today'?s|todays|the current|current) date$/,
  new RegExp(String.raw`^what date (?:is it|it is)${atTheMoment}$`),
  new RegExp(String.raw`^what day (?:is it|it is|is today|today is)${atTheMoment}$`),
  new RegExp(String.raw`^${whatIs} today$`)
];

const timeQuestions = [
  new RegExp(String.raw`^what time (?:is it|it is)${atTheMoment}$`),
  new RegExp(String.raw`^${whatIs} the (?:current )?time${atTheMoment}$`),
  new RegExp(String.raw`^what the (?:current )?time is${atTheMoment}$`),
  /^(?:the )?(?:current time|time now|time right now)$/,
  /^do you (?:have|know) the time$/
];

const bothQuestions = [
  new RegExp(String.raw`^${whatIs} the (?:current )?(?:date and time|time and date)${atTheMoment}$`),
  new RegExp(String.raw`^what (?:day and time|time and day) (?:is it|it is)${atTheMoment}$`)
];

function matches(patterns: RegExp[], text: string): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/** "Thursday, October 15, 2026", in the PC's own way of writing a date. */
function dateText(now: Date, locale?: string): string {
  return now.toLocaleDateString(locale, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

/** "1:35 PM". Newer ICU puts a narrow no-break space before the AM or PM; a reply reads better with an ordinary one. */
function timeText(now: Date, locale?: string): string {
  return now.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" }).replace(/\u202f/g, " ");
}

/**
 * The answer to a message that asks for today's date, the time, or both and
 * nothing else, or null for any other message. `locale` is for the tests; the
 * app leaves it to the PC.
 */
export function answerClockQuestion(message: string, now: Date, locale?: string): string | null {
  const raw = (message ?? "").replace(/\u2019/g, "'").trim();
  // No date or time question is this long, and every message passes through
  // here: taking the trailing punctuation off a long run of it costs time in
  // the square of its length (50,000 characters held the API for seconds).
  if (raw.length > 200) return null;
  const text = raw.toLowerCase().replace(/\s+/g, " ").replace(/[?!.\s]+$/, "").trim();
  const head = lead.exec(text);
  let body = text.slice(head ? head[0].length : 0).trim();
  // "tell me the time", "give me today's date": a request, so a bare noun is the question.
  if (head?.[1] && /^(?:the|today|todays|current)\b/.test(body)) body = `what is ${body}`;

  if (matches(bothQuestions, body)) return `It is ${timeText(now, locale)} on ${dateText(now, locale)}.`;
  if (matches(dateQuestions, body)) return `Today is ${dateText(now, locale)}.`;
  if (matches(timeQuestions, body)) return `It is ${timeText(now, locale)}.`;
  return null;
}
