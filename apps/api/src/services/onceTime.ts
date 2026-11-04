import { calendarWords } from "./scheduleStore.js";

// The moment a one-time schedule is for, from what the model wrote.
//
// Local time, as the rest of the scheduler: "2026-11-04 15:00" is three in the afternoon
// where the user is. The model works relative words out itself - it has current_datetime,
// shift_date and shift_time - so this reads only a plain date and time, or an ISO instant
// with its zone, and says what it could not read rather than guessing at it.

/** A year and a day: further than that is a diary, not a reminder, and more likely a wrong year. */
export const farthestAheadDays = 366;

export type OnceTime = { ok: true; at: Date } | { ok: false; reason: string };

const plainForm = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::\d{2})?$/;
const instantForm = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;

export function parseOnceTime(text: string, now: Date): OnceTime {
  const given = text.trim();
  const plain = plainForm.exec(given);
  let at: Date;
  if (plain) {
    const [year, month, day, hours, minutes] = plain.slice(1).map(Number);
    if (month < 1 || month > 12 || day < 1 || day > 31 || hours > 23 || minutes > 59) {
      return { ok: false, reason: `"${given}" is not a date and time: give it as YYYY-MM-DD HH:MM.` };
    }
    at = new Date(year, month - 1, day, hours, minutes, 0, 0);
    // The Date API rolls 30 February into March; that is not the date that was given.
    if (at.getMonth() !== month - 1 || at.getDate() !== day) return { ok: false, reason: `"${given}" is not a real date.` };
  } else if (instantForm.test(given)) {
    at = new Date(given);
    if (Number.isNaN(at.getTime())) return { ok: false, reason: `"${given}" is not a date and time.` };
  } else {
    return {
      ok: false,
      reason: `"${given}" is not a date and time this can read: give it as YYYY-MM-DD HH:MM in the user's local time, `
        + "working \"tomorrow\" or \"in two hours\" out from current_datetime."
    };
  }
  if (at.getTime() <= now.getTime()) return { ok: false, reason: `${calendarWords(at)} has already passed.` };
  if (at.getTime() - now.getTime() > farthestAheadDays * 24 * 60 * 60 * 1000) {
    return { ok: false, reason: `${calendarWords(at)} is more than a year away.` };
  }
  return { ok: true, at };
}
