import { parseDate } from "./dateMath.js";

// Which day a request names, read from the user's own words.
//
// The model fills in the date for add_event and add_schedule, and it works it out as it likes:
// on the card on 2026-11-08, a Sunday, "next Friday at 2 pm" was put on the calendar as Tuesday
// the 17th by one model and Thursday the 12th by the other, and "remind me tomorrow at 3 pm" was
// saved by both as every weekday at 3. Where the request names one day plainly, the request
// decides, as the time of day already does (scheduleRequest.ts); where it names none, or more
// than one, the model's reading stands.

const weekdayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const monthNames = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const smallNumbers: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

const atMidnight = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const daysOn = (date: Date, days: number) => { const moved = atMidnight(date); moved.setDate(moved.getDate() + days); return moved; };

/** A repeating day ("every Friday", "each Monday") is a cadence, not a day, and is left to the schedule's own reading. */
const repeatingDay = /\b(?:every|each)\s+(?:other\s+|second\s+|single\s+)?(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday|day|morning|afternoon|evening|night|week)\b/gi;

/**
 * The one day a request names, as local midnight - or null when it names none, more than one
 * ("tomorrow, or Friday if that is easier"), a repeat, or a day already gone.
 *
 * Read: today, tonight, tomorrow, the day after tomorrow; a weekday, with or without on, this,
 * coming or next, meaning the coming one ("next Friday" on a Friday is a week away, on any other
 * day it is this week's); in N days, in a week, in two weeks; a date with or without a year, as
 * 12 November, November 12th, Nov 12, 11/12, 2026-11-12 or the 12th, the next time it comes round.
 */
export function dayAskedFor(request: string, now: Date): Date | null {
  const text = (request ?? "").replace(repeatingDay, " ");
  if (!text.trim()) return null;
  const today = atMidnight(now);
  const found = new Map<number, Date>();
  const note = (date: Date | null) => { if (date) found.set(date.getTime(), date); };
  // Taken out as they are read, so "the day after tomorrow" does not also read as "tomorrow",
  // and "12 November" does not also read as "the 12th".
  let rest = text;
  const take = (pattern: RegExp, read: (match: RegExpMatchArray) => Date | null) => {
    rest = rest.replace(pattern, (...args) => {
      const match = args.slice(0, -2) as unknown as RegExpMatchArray;
      note(read(match));
      return " ";
    });
  };

  take(/\b(?:the\s+)?day\s+after\s+tomorrow\b/gi, () => daysOn(today, 2));
  take(/\btomorrow\b/gi, () => daysOn(today, 1));
  take(/\b(?:today|tonight|this\s+(?:morning|afternoon|evening))\b/gi, () => today);
  take(/\bin\s+(a|an|one|two|three|four|five|six|seven|eight|nine|ten|\d{1,3})\s+(days?|weeks?)\b/gi, (match) => {
    const count = smallNumbers[match[1].toLowerCase()] ?? Number(match[1]);
    if (!Number.isFinite(count) || count < 1) return null;
    return daysOn(today, /^w/i.test(match[2]) ? count * 7 : count);
  });
  // 2026-11-12, 12 November 2026, November 12, 2026, 11/12/2026: a date with its year.
  take(/\b(\d{4}-\d{2}-\d{2}|\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*,?\s+\d{4}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{4})\b/gi,
    (match) => parseDate(match[1].replace(/\b(sept)\b/i, "sep"), today));
  // 12 November, November 12th, Nov 12: the next time that date comes round.
  take(/\b(?:(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*|(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?)\b/gi, (match) => {
    const day = Number(match[1] ?? match[4]);
    const month = monthNames.findIndex((name) => name.startsWith((match[2] ?? match[3]).toLowerCase().slice(0, 3)));
    return month === -1 ? null : nextDate(today, month, day);
  });
  // 11/12: month first, as this app's users write it.
  take(/\b(\d{1,2})\/(\d{1,2})\b(?!\/)/g, (match) => nextDate(today, Number(match[1]) - 1, Number(match[2])));
  // on the 12th: this month, or next month if it has gone.
  take(/\b(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)\b/gi, (match) => {
    const day = Number(match[1]);
    for (const monthsOn of [0, 1, 2]) {
      const date = new Date(today.getFullYear(), today.getMonth() + monthsOn, day);
      if (date.getDate() !== day) continue; // that month has no such day: the 31st in a short month
      if (date.getTime() >= today.getTime()) return date;
    }
    return null;
  });
  // A weekday: the coming one. "next Friday" on a Friday is a week away.
  take(/\b(?:(next|this|coming|on)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi, (match) => {
    const target = weekdayNames.indexOf(match[2].toLowerCase());
    let ahead = (target - today.getDay() + 7) % 7;
    if (ahead === 0 && /^next$/i.test(match[1] ?? "")) ahead = 7;
    return daysOn(today, ahead);
  });

  if (found.size !== 1) return null;
  const [day] = found.values();
  return day.getTime() < today.getTime() ? null : day;
}

/** The next time a month and day come round, this year or next; null for a day no month has. */
function nextDate(today: Date, month: number, day: number): Date | null {
  for (const year of [today.getFullYear() + Math.floor(month / 12), today.getFullYear() + Math.floor(month / 12) + 1]) {
    const date = new Date(year, ((month % 12) + 12) % 12, day);
    if (date.getMonth() !== ((month % 12) + 12) % 12 || date.getDate() !== day) return null;
    if (date.getTime() >= today.getTime()) return date;
  }
  return null;
}

/** 2026-11-12, for a day: what the stores keep. */
export function localDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
