"use client";

import { useEffect, useState } from "react";
import {
  addEvent,
  formatEventTime,
  formatRelative,
  isImminent,
  readEvents,
  removeEvent,
  upcomingEvents,
  writeEvents,
  type CalendarEvent
} from "@ascend/shared";
import "./calendar.css";

// Calendar: events kept on this machine, against the same localCalendar.ts
// logic Vexora's own Calendar panel uses. No connected account, so nothing
// here is synced from anywhere — which also means nothing here is invented.

const storageKey = "trhai.calendar.events.v1";

export default function CalendarPage() {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [title, setTitle] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setEvents(readEvents(window.localStorage, storageKey));
    setLoaded(true);
  }, []);

  // Once a minute, so "in 45m" counts down instead of freezing at whatever it
  // said when the screen was opened.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60000);
    return () => window.clearInterval(timer);
  }, []);

  function commit(next: CalendarEvent[]) {
    setEvents(next);
    writeEvents(window.localStorage, storageKey, next);
  }

  function submit() {
    const next = addEvent(events, { id: crypto.randomUUID(), title, startsAt });
    if (next === events) {
      setNote("An event needs a title and a real date and time.");
      return;
    }
    commit(next);
    setTitle("");
    setStartsAt("");
    setNote(null);
  }

  const upcoming = upcomingEvents(events, now, 5);

  return (
    <div className="calendar">
      <header className="calendar-head">
        <h1>Calendar</h1>
        <p className="muted">Your schedule, stored on this machine. No account is connected.</p>
      </header>

      <div className="panel calendar-card">
        <div className="calendar-form">
          <input className="field calendar-title-field" value={title} placeholder="Event title"
            aria-label="Event title" onChange={(event) => setTitle(event.target.value)} />
          <input className="field" type="datetime-local" value={startsAt} aria-label="Event start"
            onChange={(event) => setStartsAt(event.target.value)} />
          <button type="button" className="btn btn-primary" onClick={submit} disabled={!title.trim() || !startsAt}>
            Add
          </button>
        </div>
        {note ? <p className="faint calendar-note">{note}</p> : null}
      </div>

      {!loaded ? null : (
        <>
          {upcoming.length > 0 ? (
            <div className="panel calendar-card">
              <span className="hud-label">Next up</span>
              {upcoming.map((event) => (
                <div key={event.id} className="calendar-upcoming-row">
                  <span className="mono">{formatEventTime(event.startsAt)}</span>
                  <strong className="grow">{event.title}</strong>
                  <span className={`chip chip-live${isImminent(event.startsAt, now) ? " chip-warn" : ""}`}>
                    {formatRelative(event.startsAt, now)}
                  </span>
                </div>
              ))}
            </div>
          ) : null}

          {events.length === 0 ? (
            <div className="panel calendar-card">
              <p className="muted">Nothing scheduled. Add an event above.</p>
            </div>
          ) : (
            <div className="panel calendar-card">
              <span className="hud-label">All events</span>
              <ul className="calendar-list">
                {events.map((event) => (
                  <li key={event.id} className="calendar-item">
                    <div className="grow">
                      <strong>{event.title}</strong>
                      <p className="faint">
                        {event.startsAt.slice(0, 10)} · {formatEventTime(event.startsAt)} · {formatRelative(event.startsAt, now)}
                      </p>
                    </div>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => commit(removeEvent(events, event.id))}>
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
