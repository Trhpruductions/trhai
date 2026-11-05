import { existsSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { isValidStart, type CalendarEvent } from "@ascend/shared";
import { dataFile } from "./dataDirectory.js";
import { recordPersistFailure, recordPersistSuccess } from "./persistenceHealth.js";
import { assertProtectedJsonWritable, readProtectedJsonFile, writeProtectedJsonFile } from "./protectedJson.js";
import { evictableKey } from "./storeEviction.js";

// The calendar behind `/v1/calendar`: things a person has on, on a day and usually at a time. Not
// the schedules, which make something happen at a time; nothing here fires. To be told about an
// event, a person asks for a reminder as well, and that is a one-time schedule.
//
// The times are the person's own wall clock, "YYYY-MM-DDTHH:mm" (see localCalendar.ts in
// @ascend/shared for why), and an event with no time is marked allDay. Scoped per session or
// account, exactly like the to-do list, so one caller cannot read another's.

export type { CalendarEvent };

/** Caps so an unauthenticated caller cannot grow storage without bound. */
export const maxEventsPerSession = 1000;
export const maxTrackedCalendarSessions = 500;

const eventsBySession = new Map<string, CalendarEvent[]>();

const calendarFilePath = process.env.ASSIST_CALENDAR_FILE ?? dataFile("assist-calendar.json");

let loaded = false;
let persistenceEnabled = process.env.ASSIST_CALENDAR_PERSIST !== "off";

type PersistedShape = {
  version: 1;
  sessions: Array<{ key: string; events: CalendarEvent[] }>;
};

function isEvent(value: unknown): value is CalendarEvent {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<CalendarEvent>;
  return typeof entry.id === "string"
    && typeof entry.title === "string"
    && typeof entry.startsAt === "string"
    && isValidStart(entry.startsAt);
}

const byStart = (left: CalendarEvent, right: CalendarEvent) => left.startsAt.localeCompare(right.startsAt);

function loadFromDisk(): void {
  if (loaded) return;
  loaded = true;
  if (!persistenceEnabled || !existsSync(calendarFilePath)) return;

  try {
    const parsed = readProtectedJsonFile(calendarFilePath) as Partial<PersistedShape>;
    if (!Array.isArray(parsed.sessions)) return;

    for (const session of parsed.sessions) {
      if (!session || typeof session.key !== "string" || !Array.isArray(session.events)) continue;
      const events = session.events.filter(isEvent).sort(byStart);
      if (events.length) eventsBySession.set(session.key, events);
    }
  } catch {
    // A corrupt file must never take the API down; start clean instead.
  }
}

function saveToDisk(): void {
  if (!persistenceEnabled) return;

  try {
    const payload: PersistedShape = {
      version: 1,
      sessions: [...eventsBySession.entries()].map(([key, events]) => ({ key, events }))
    };
    mkdirSync(path.dirname(calendarFilePath), { recursive: true });
    // Temp file then rename, so a crash mid-write cannot truncate the store.
    const tempPath = `${calendarFilePath}.tmp`;
    assertProtectedJsonWritable(calendarFilePath);
    writeProtectedJsonFile(tempPath, payload);
    renameSync(tempPath, calendarFilePath);
    recordPersistSuccess("the calendar");
  } catch (error) {
    // Losing durability is bad; taking the request down with it is worse. Reported, not swallowed.
    recordPersistFailure("the calendar", error);
  }
}

/** Every event, soonest first. */
export function listEvents(sessionKey: string): CalendarEvent[] {
  loadFromDisk();
  return [...(eventsBySession.get(sessionKey) ?? [])];
}

export function addCalendarEvent(
  sessionKey: string,
  input: { id: string; title: string; startsAt: string; notes?: string; allDay?: boolean }
): CalendarEvent | null {
  loadFromDisk();

  const title = input.title.trim();
  if (!title || !isValidStart(input.startsAt)) return null;
  const notes = input.notes?.trim();
  const event: CalendarEvent = {
    id: input.id,
    title,
    startsAt: input.startsAt,
    ...(notes ? { notes } : {}),
    ...(input.allDay ? { allDay: true } : {})
  };

  const existing = eventsBySession.get(sessionKey) ?? [];
  eventsBySession.set(sessionKey, [...existing, event].sort(byStart).slice(-maxEventsPerSession));

  // Insertion-ordered map: the least recent anonymous session goes; an account's never does (storeEviction.ts).
  while (eventsBySession.size > maxTrackedCalendarSessions) {
    const oldest = evictableKey(eventsBySession.keys());
    if (oldest === undefined) break;
    eventsBySession.delete(oldest);
  }

  saveToDisk();
  return event;
}

export function removeCalendarEvent(sessionKey: string, eventId: string): boolean {
  loadFromDisk();
  const existing = eventsBySession.get(sessionKey);
  if (!existing) return false;

  const next = existing.filter((event) => event.id !== eventId);
  if (next.length === existing.length) return false;

  eventsBySession.set(sessionKey, next);
  saveToDisk();
  return true;
}

export function resetCalendar(sessionKey?: string): void {
  loadFromDisk();
  if (sessionKey) {
    eventsBySession.delete(sessionKey);
  } else {
    eventsBySession.clear();
  }
  saveToDisk();
}

export function setCalendarPersistence(enabled: boolean): void {
  persistenceEnabled = enabled;
}

/** Forget what was loaded, so a test can read the file again. */
export function reloadCalendarForTests(): void {
  eventsBySession.clear();
  loaded = false;
}
