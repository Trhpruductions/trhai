import { toLocalInput, type CalendarEvent } from "@ascend/shared";
import { addCalendarEvent, listEvents, removeCalendarEvent } from "./calendarStore.js";

// The assistant's hands on the calendar (calendarStore.ts), scoped to the caller's session or
// account exactly as the screen is. What a person does with a calendar: read it, put something on
// it, take something off it.
//
// An event is named by its number in the list as it was last shown, or by its words. The number
// is the place in the whole calendar, past events included, so reading just one day of it does
// not change any number.

/** What the tools are given: the calendar behind /v1/calendar for one caller, the key kept out of here. */
export type CalendarAccess = {
  list: () => CalendarEvent[];
  add: (input: { title: string; startsAt: string; notes?: string; allDay?: boolean }) => CalendarEvent | null;
  remove: (id: string) => boolean;
};

export function calendarAccessFor(sessionKey: string): CalendarAccess {
  return {
    list: () => listEvents(sessionKey),
    add: (input) => addCalendarEvent(sessionKey, { id: `event-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ...input }),
    remove: (id) => removeCalendarEvent(sessionKey, id)
  };
}

export const maxEventTitleLength = 200;
export const maxEventNotesLength = 1000;

const plainDate = /^(\d{4})-(\d{2})-(\d{2})$/;
const plainDateTime = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::\d{2})?$/;

export type ReadMoment = { ok: true; startsAt: string; allDay: boolean } | { ok: false; reason: string };

/**
 * When an event is, from what the model wrote: a date and a time, or a date alone for something
 * that lasts the day. The model works "Friday" out itself from the date it was given; this reads
 * only what is plain, and says what it could not read rather than guessing at it.
 */
export function readEventMoment(text: string): ReadMoment {
  const given = text.trim();
  const dated = plainDateTime.exec(given) ?? plainDate.exec(given);
  if (!dated) {
    return { ok: false, reason: `"${given.slice(0, 40)}" is not a date this can read: give it as YYYY-MM-DD HH:MM, or YYYY-MM-DD for all day, working "Friday" out from today's date.` };
  }
  const [year, month, day] = dated.slice(1, 4).map(Number);
  const hours = dated[4] === undefined ? 0 : Number(dated[4]);
  const minutes = dated[5] === undefined ? 0 : Number(dated[5]);
  const real = new Date(year, month - 1, day, hours, minutes);
  if (hours > 23 || minutes > 59 || real.getMonth() !== month - 1 || real.getDate() !== day) {
    return { ok: false, reason: `"${given}" is not a real date and time.` };
  }
  return { ok: true, startsAt: toLocalInput(real), allDay: dated[4] === undefined };
}

/** "Fri 6 Nov 2026 at 3:00 PM", or "Fri 6 Nov 2026, all day". */
export function eventWhen(event: Pick<CalendarEvent, "startsAt" | "allDay">): string {
  const at = new Date(event.startsAt);
  const day = at.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" }).replace(",", "");
  return event.allDay ? `${day}, all day` : `${day} at ${at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}

/** Still to come: an all-day event for the whole of its day, the rest until they start. */
export function isUpcoming(event: CalendarEvent, now: Date): boolean {
  const today = toLocalInput(now);
  return event.allDay ? event.startsAt.slice(0, 10) >= today.slice(0, 10) : event.startsAt >= today;
}

export type EventScope = "upcoming" | "all" | { on: string };

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** The calendar as a list the model can read back: numbered by its place in the whole calendar. */
export function describeEvents(events: CalendarEvent[], now: Date, scope: EventScope = "upcoming"): string {
  if (events.length === 0) return "The calendar is empty.";
  const numbered = events.map((event, index) => ({ event, number: index + 1 }));
  const shown = numbered.filter(({ event }) => scope === "all" || (scope === "upcoming" ? isUpcoming(event, now) : event.startsAt.slice(0, 10) === scope.on));
  if (shown.length === 0) {
    if (scope === "upcoming") return `Nothing is coming up. The calendar has ${plural(events.length, "past event")}.`;
    return `Nothing is on the calendar on ${eventWhen({ startsAt: `${(scope as { on: string }).on}T00:00`, allDay: true }).replace(", all day", "")}.`;
  }
  const heading = scope === "upcoming" ? `${plural(shown.length, "event")} coming up:` : scope === "all" ? `${plural(shown.length, "event")}:` : `${plural(shown.length, "event")} that day:`;
  const lines = shown.map(({ event, number }) => `${number}. ${eventWhen(event)}: ${event.title}${event.notes ? ` (${event.notes})` : ""}`);
  return [heading, ...lines].join("\n");
}

export type EventLookup =
  | { kind: "none" }
  | { kind: "one"; event: CalendarEvent; number: number }
  | { kind: "several"; matches: Array<{ event: CalendarEvent; number: number }> };

const flatten = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** An event by its number in the calendar, or its words: exactly, then the one that contains them. Never guessed between several. */
export function findEvent(events: CalendarEvent[], reference: string): EventLookup {
  const ref = reference.trim();
  if (!ref) return { kind: "none" };
  const numbered = events.map((event, index) => ({ event, number: index + 1 }));
  const asNumber = /^#?(\d{1,4})\.?$/.exec(ref);
  if (asNumber) {
    const hit = numbered[Number(asNumber[1]) - 1];
    return hit ? { kind: "one", ...hit } : { kind: "none" };
  }
  const wanted = flatten(ref);
  if (!wanted) return { kind: "none" };
  const exact = numbered.filter(({ event }) => flatten(event.title) === wanted);
  if (exact.length === 1) return { kind: "one", ...exact[0] };
  if (exact.length > 1) return { kind: "several", matches: exact };
  const partial = numbered.filter(({ event }) => flatten(event.title).includes(wanted));
  if (partial.length === 1) return { kind: "one", ...partial[0] };
  if (partial.length > 1) return { kind: "several", matches: partial };
  return { kind: "none" };
}
