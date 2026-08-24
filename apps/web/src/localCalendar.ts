// A local calendar (vision §4 sidebar, §16 widget).
//
// The right rail used to show three hardcoded events — "Team Standup ... in
// 45m" — with the relative times baked into the markup, so they read as live
// and never moved. §22 rules that out.
//
// The honest fix is either an empty panel or a real store. This is the real
// store: events live on this machine, so the calendar works with no connected
// account and no third-party credentials.
//
// Times are stored in the "YYYY-MM-DDTHH:mm" shape an <input type="datetime-local">
// produces, and parsed as local time. Day grouping compares the date portion as
// a string prefix rather than going through Date, because converting to UTC and
// back is what shifts an event onto the wrong day near midnight.

export type CalendarEvent = {
  id: string;
  title: string;
  /** Local wall-clock time, "YYYY-MM-DDTHH:mm". */
  startsAt: string;
  notes?: string;
};

const localDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

export function isValidStart(value: string): boolean {
  if (!localDateTime.test(value)) return false;
  // Rejects "2026-02-31T10:00", which matches the shape but is not a real date.
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && toLocalInput(parsed) === value;
}

/** Render a Date back into the input shape, in local time. */
export function toLocalInput(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The date portion, used for day grouping. Never parsed through Date. */
export function dayOf(event: CalendarEvent): string {
  return event.startsAt.slice(0, 10);
}

function byStart(left: CalendarEvent, right: CalendarEvent): number {
  return left.startsAt.localeCompare(right.startsAt);
}

export function addEvent(
  events: CalendarEvent[],
  input: { id: string; title: string; startsAt: string; notes?: string }
): CalendarEvent[] {
  const title = input.title.trim();
  if (!title || !isValidStart(input.startsAt)) return events;

  const notes = input.notes?.trim();
  return [...events, { id: input.id, title, startsAt: input.startsAt, ...(notes ? { notes } : {}) }].sort(
    byStart
  );
}

export function removeEvent(events: CalendarEvent[], id: string): CalendarEvent[] {
  return events.filter((event) => event.id !== id);
}

/** Events at or after `now`, soonest first. */
export function upcomingEvents(events: CalendarEvent[], now: Date, limit = 5): CalendarEvent[] {
  const cutoff = toLocalInput(now);
  return events
    .filter((event) => event.startsAt >= cutoff)
    .sort(byStart)
    .slice(0, limit);
}

export function eventsOnDay(events: CalendarEvent[], day: string): CalendarEvent[] {
  return events.filter((event) => dayOf(event) === day).sort(byStart);
}

/** "10:00 AM" */
export function formatEventTime(startsAt: string): string {
  const date = new Date(startsAt);
  if (Number.isNaN(date.getTime())) return "--:--";
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/**
 * "in 45m", "in 3h 45m", "in 2d", "now", "started".
 * Computed against a supplied `now` so it is testable and so it actually
 * changes as time passes — the previous version was a literal in the markup.
 */
export function formatRelative(startsAt: string, now: Date): string {
  const target = new Date(startsAt).getTime();
  if (Number.isNaN(target)) return "";

  const minutes = Math.round((target - now.getTime()) / 60000);
  if (minutes < 0) return "started";
  if (minutes === 0) return "now";
  if (minutes < 60) return `in ${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const remainder = minutes % 60;
    return remainder === 0 ? `in ${hours}h` : `in ${hours}h ${remainder}m`;
  }

  const days = Math.floor(hours / 24);
  return `in ${days}d`;
}

/** Within `thresholdMinutes` of starting, and not already past — worth a second look. */
export function isImminent(startsAt: string, now: Date, thresholdMinutes = 15): boolean {
  const target = new Date(startsAt).getTime();
  if (Number.isNaN(target)) return false;

  const minutes = (target - now.getTime()) / 60000;
  return minutes >= 0 && minutes <= thresholdMinutes;
}

export function parseEvents(value: unknown): CalendarEvent[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const events: CalendarEvent[] = [];

  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const { id, title, startsAt, notes } = entry as Record<string, unknown>;
    if (typeof id !== "string" || seen.has(id)) continue;
    if (typeof title !== "string" || !title.trim()) continue;
    if (typeof startsAt !== "string" || !isValidStart(startsAt)) continue;

    seen.add(id);
    events.push({
      id,
      title: title.trim(),
      startsAt,
      ...(typeof notes === "string" && notes.trim() ? { notes: notes.trim() } : {})
    });
  }

  return events.sort(byStart);
}

export function readEvents(storage: Storage | undefined, key: string): CalendarEvent[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(key);
    return raw ? parseEvents(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

export function writeEvents(storage: Storage | undefined, key: string, events: CalendarEvent[]): void {
  try {
    storage?.setItem(key, JSON.stringify(events));
  } catch {
    // Storage being full must not stop the user editing their calendar.
  }
}
