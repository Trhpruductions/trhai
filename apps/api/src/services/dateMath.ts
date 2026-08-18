// Date arithmetic for the assistant.
//
// The same problem as plain arithmetic, and worse. A model asked how many days
// until a date counts on its fingers and gets it wrong, and it has no idea what
// today is to begin with — so the error compounds silently and the answer looks
// confident either way.
//
// Everything here works in whole days on the local calendar. Deliberately not
// in UTC milliseconds: "days between" divided out of a timestamp difference is
// off by one across a daylight-saving boundary, which is exactly the case
// nobody checks and everybody hits twice a year.

export type DateResult =
  | { ok: true; value: string }
  | { ok: false; reason: string };

const monthNames = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december"
];

/**
 * Read a date the way a person or a model writes one.
 *
 * Returns local midnight, so a difference is a count of calendar days rather
 * than of elapsed hours.
 */
export function parseDate(input: string, today: Date): Date | null {
  const text = input.trim().toLowerCase();
  if (!text) return null;

  const atMidnight = (year: number, month: number, day: number): Date | null => {
    const date = new Date(year, month, day);
    // Rejects 31 February, which JavaScript would silently roll into March.
    if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) {
      return null;
    }
    return date;
  };

  if (text === "today") return atMidnight(today.getFullYear(), today.getMonth(), today.getDate());
  if (text === "tomorrow") {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    date.setDate(date.getDate() + 1);
    return date;
  }
  if (text === "yesterday") {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    date.setDate(date.getDate() - 1);
    return date;
  }

  // 2026-08-17
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso) {
    return atMidnight(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  }

  // 17 August 2026 / August 17 2026 / 17 Aug 2026 — with an optional comma and
  // an optional ordinal suffix, both of which people write and models copy.
  const named = /^(?:(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)|([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?)[,\s]+(\d{4})$/
    .exec(text);
  if (named) {
    const day = Number(named[1] ?? named[4]);
    const monthWord = (named[2] ?? named[3]) as string;
    const month = monthNames.findIndex((name) => name.startsWith(monthWord.slice(0, 3)));
    if (month === -1) return null;
    return atMidnight(Number(named[5]), month, day);
  }

  // A bare year is not a date, and neither is a timestamp with no day. Refusing
  // is better than picking January the first on the user's behalf.
  return null;
}

/** Whole calendar days from `from` to `to`. Negative when `to` is earlier. */
export function daysBetween(from: Date, to: Date): number {
  // Each date is reduced to its calendar day and then read as UTC. Subtracting
  // local timestamps looks equivalent and is not: across a daylight-saving
  // change a local day is 23 or 25 hours, so the division lands on x.96 or
  // x.04 and rounds to the wrong count for exactly the two weeks a year nobody
  // tests. In UTC every day is 24 hours, so the division is exact.
  const start = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const end = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());

  return (end - start) / 86_400_000;
}

export function formatDate(date: Date): string {
  return date.toLocaleDateString(undefined, {
    weekday: "long", year: "numeric", month: "long", day: "numeric"
  });
}

/** How many days between two dates, described in words. */
export function describeDifference(fromInput: string, toInput: string, today: Date): DateResult {
  const from = parseDate(fromInput, today);
  if (!from) return { ok: false, reason: `"${fromInput}" is not a date I can read.` };

  const to = parseDate(toInput, today);
  if (!to) return { ok: false, reason: `"${toInput}" is not a date I can read.` };

  const days = daysBetween(from, to);
  if (days === 0) return { ok: true, value: `${formatDate(from)} and ${formatDate(to)} are the same day.` };

  const magnitude = Math.abs(days);
  const unit = magnitude === 1 ? "day" : "days";
  const direction = days > 0 ? "after" : "before";

  return {
    ok: true,
    value: `${formatDate(to)} is ${magnitude} ${unit} ${direction} ${formatDate(from)}.`
  };
}

/** The date a given number of days from another date. */
export function shiftDate(fromInput: string, days: number, today: Date): DateResult {
  const from = parseDate(fromInput, today);
  if (!from) return { ok: false, reason: `"${fromInput}" is not a date I can read.` };

  if (!Number.isFinite(days) || !Number.isInteger(days)) {
    return { ok: false, reason: "The number of days has to be a whole number." };
  }
  // A bound, since this runs on a number a model produced.
  if (Math.abs(days) > 100_000) {
    return { ok: false, reason: "That is too far away to be a useful date." };
  }

  const result = new Date(from);
  result.setDate(result.getDate() + days);

  return { ok: true, value: formatDate(result) };
}
