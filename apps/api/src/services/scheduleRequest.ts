// Which days and what time a schedule request asks for, read from the user's
// own words.
//
// The model fills add_schedule's arguments, and it reads "every day" as it
// likes: live, "every day at 9:15 am remind me to drink water" was saved as
// every weekday - in one run of two, with the request saying "every day"
// outright. Where the request says it plainly, the request decides; where it
// says nothing, or says two things, the model's reading stands.

export type DaysAsked = "every day" | "weekdays";

const exceptWeekends = /\b(?:except|excluding|not\s+on|but\s+not|skip(?:ping)?)\s+(?:the\s+)?weekends?\b/i;
const weekdayWords = /\bweek\s?days?\b|\bwork\s?days?\b|\bmonday\s+(?:through|thru|to|-)\s+friday\b|\bmon(?:day)?\s*-\s*fri(?:day)?\b/i;
const everyDayWords = /\bevery\s*day\b|\bdaily\b|\beach\s+day\b|\bevery\s+(?:morning|afternoon|evening|night)\b|\b(?:7|seven)\s+days\s+a\s+week\b/i;

export function daysAskedFor(request: string): DaysAsked | null {
  const text = request ?? "";
  if (exceptWeekends.test(text)) return "weekdays";
  const weekdays = weekdayWords.test(text);
  const everyDay = everyDayWords.test(text);
  if (weekdays && !everyDay) return "weekdays";
  if (everyDay && !weekdays) return "every day";
  return null;
}

/** A recurring reminder a request asks for outright: what to say, and when. */
export type ReminderRequest = {
  text: string;
  cadence: { kind: "daily"; minuteOfDay: number; weekdaysOnly?: true } | { kind: "interval"; minutes: number };
};

// Everything in a request that says when, so what is left is what to say.
const whenWords = [
  /\b(?:every|each)\s+(?:single\s+)?(?:day|weekday|work\s?day|morning|afternoon|evening|night)\b/gi,
  /\bevery\s*day\b|\beveryday\b|\bdaily\b/gi,
  /\b(?:on\s+)?(?:week\s?days|work\s?days)\b/gi,
  /\b(?:monday\s+(?:through|thru|to|-)\s+friday|mon(?:day)?\s*-\s*fri(?:day)?)\b/gi,
  /\b(?:except|excluding|not\s+on|but\s+not|skip(?:ping)?)\s+(?:the\s+)?weekends?\b/gi,
  /\bevery\s+\d+\s*(?:minutes?|mins?|hours?|hrs?)\b/gi,
  // Clock times only - with am/pm or minutes - so "standup is at 9" in the
  // words of the reminder keeps its "at 9".
  /\b(?:at|around|by)\s+(?:\d{1,2}:[0-5]\d(?:\s*[ap]\.?\s*m\b\.?)?|\d{1,2}\s*[ap]\.?\s*m\b\.?)/gi,
  /\b(?:at\s+)?(?:noon|midday|midnight)\b/gi
];

/**
 * "every day at 9:15 am remind me to drink water", "remind me every 30
 * minutes to stretch" - a reminder whose words and timing are all there, or
 * null for anything less: no "remind me", a time with no days ("remind me at
 * 9 to call mom" is once, and schedules here repeat), or days with no time.
 */
export function parseReminderRequest(request: string): ReminderRequest | null {
  const asked = (request ?? "").trim();
  // The timing may sit before "to" as well as after the words: "remind me
  // every 30 minutes to stretch", "remind me to stretch every 30 minutes".
  const reminder = /\bremind\s+me\s+(?:(.+?)\s+)?(?:to|that|about|of)\s+(.+)$/i.exec(asked);
  if (!reminder) return null;

  let cadence: ReminderRequest["cadence"] | null = null;
  const every = /\bevery\s+(\d+)\s*(minutes?|mins?|hours?|hrs?)\b/i.exec(asked);
  if (every) {
    const minutes = Number(every[1]) * (/^h/i.test(every[2]) ? 60 : 1);
    if (minutes >= 1 && minutes <= 24 * 60) cadence = { kind: "interval", minutes };
  } else {
    const days = daysAskedFor(asked);
    const at = timeAskedFor(asked);
    if (days && at !== null) cadence = days === "weekdays" ? { kind: "daily", minuteOfDay: at, weekdaysOnly: true } : { kind: "daily", minuteOfDay: at };
  }
  if (!cadence) return null;

  let text = reminder[2];
  for (const pattern of whenWords) text = text.replace(pattern, " ");
  text = text.replace(/\s{2,}/g, " ").replace(/^[\s,;:-]+|[\s,;:.!?-]+$/g, "").replace(/\s+(?:and|then)$/i, "").trim();
  if (text.length < 2 || !/\p{L}/u.test(text)) return null;
  return { text: text.charAt(0).toUpperCase() + text.slice(1), cadence };
}

/**
 * The one time of day a request names, as minutes after midnight - or null
 * when it names none, or more than one ("at 9 am and 5 pm" is two schedules,
 * and which is which is the model's to sort out).
 */
export function timeAskedFor(request: string): number | null {
  const text = request ?? "";
  const found = new Set<number>();
  for (const match of text.matchAll(/\b(\d{1,2})(?::([0-5]\d))?\s*([ap])\.?\s*m\b\.?/gi)) {
    let hours = Number(match[1]);
    if (hours < 1 || hours > 12) continue;
    const afternoon = match[3].toLowerCase() === "p";
    if (afternoon && hours !== 12) hours += 12;
    if (!afternoon && hours === 12) hours = 0;
    found.add(hours * 60 + Number(match[2] ?? 0));
  }
  // 24-hour times, but not the "9:15" of "9:15 am", read above.
  for (const match of text.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b(?!\s*[ap]\.?\s*m\b)/gi)) {
    found.add(Number(match[1]) * 60 + Number(match[2]));
  }
  if (/\b(?:noon|midday)\b/i.test(text)) found.add(12 * 60);
  if (/\bmidnight\b/i.test(text)) found.add(0);
  return found.size === 1 ? [...found][0] : null;
}
