// Clock arithmetic for the shift_time tool: "3pm plus 2 hours 30 minutes".
//
// Exists because a small local model gets this wrong on its own - asked when
// a train leaving at 3pm arrives after 2 hours 30 minutes, it said 3:30 PM -
// and the date tools were the wrong shape for it: shift_date moves by whole
// days. Structured arguments are what a local model fills in reliably, so the
// arithmetic lives here and the model only names the time and the amount.

const minutesPerDay = 24 * 60;

/**
 * Minutes since midnight for "3pm", "3:15 PM", "15:00", "noon", "midnight".
 * Null for anything else - a model that is told "not a clock time" retries
 * with one; a model handed a guess builds on it.
 */
export function parseClockTime(text: string): number | null {
  const value = text.trim().toLowerCase().replace(/\./g, "").replace(/\s+/g, " ");
  if (value === "noon" || value === "midday" || value === "12 noon") return 12 * 60;
  if (value === "midnight" || value === "12 midnight") return 0;

  const match = value.match(/^(\d{1,2})(?::(\d{2}))?(?: ?(am|pm))?$/);
  if (!match) return null;

  let hours = Number(match[1]);
  const minutes = match[2] === undefined ? 0 : Number(match[2]);
  const meridiem = match[3];
  if (minutes > 59) return null;

  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    if (meridiem === "pm" && hours < 12) hours += 12;
    if (meridiem === "am" && hours === 12) hours = 0;
  } else if (hours > 23) {
    return null;
  }

  return hours * 60 + minutes;
}

/** "5:30 PM" - twelve-hour, because that is how the question was asked. */
export function formatClock(minutesSinceMidnight: number): string {
  const total = ((minutesSinceMidnight % minutesPerDay) + minutesPerDay) % minutesPerDay;
  const hours24 = Math.floor(total / 60);
  const minutes = total % 60;
  const meridiem = hours24 >= 12 ? "PM" : "AM";
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return `${hours12}:${String(minutes).padStart(2, "0")} ${meridiem}`;
}

export type ShiftedClock = { ok: true; value: string } | { ok: false; reason: string };

/** The clock time some hours and minutes after (negative: before) a given time. */
export function shiftClock(time: string, hours: number, minutes: number): ShiftedClock {
  const start = parseClockTime(time);
  if (start === null) {
    return {
      ok: false,
      reason: `"${time}" is not a clock time. Give one like 3pm, 3:15 PM, 15:00, noon or midnight.`
    };
  }
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return { ok: false, reason: "hours and minutes must be numbers; use negative numbers to go backwards." };
  }

  const delta = Math.round(hours * 60 + minutes);
  const end = start + delta;
  const days = Math.floor(end / minutesPerDay);
  const dayNote = days === 0
    ? ""
    : days === 1
      ? " the next day"
      : days === -1
        ? " the day before"
        : days > 1
          ? ` ${days} days later`
          : ` ${-days} days earlier`;

  const direction = delta >= 0 ? "after" : "before";
  return {
    ok: true,
    value: `${describeDuration(Math.abs(delta))} ${direction} ${formatClock(start)} is ${formatClock(end)}${dayNote}.`
  };
}

function describeDuration(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  if (minutes > 0 || parts.length === 0) parts.push(`${minutes} minute${minutes === 1 ? "" : "s"}`);
  return parts.join(" ");
}
