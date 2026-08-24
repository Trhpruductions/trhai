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
import { Surface, Empty } from "../Surface";

// Calendar: events kept on this machine.
//
// No connected account, so nothing here is synced from anywhere — which also
// means nothing here is invented. The relative times are computed against a
// clock that ticks, rather than written once and left to go stale.

const storageKey = "ascend.calendar.events.v1";

export function CalendarSurface() {
  const [events, setEvents] = useState<CalendarEvent[]>(() => readEvents(window.localStorage, storageKey));
  const [title, setTitle] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());

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
    <Surface
      title="Calendar"
      summary="Your schedule, stored on this machine. No account is connected, so nothing appears here that you did not add."
      count={`${events.length} ${events.length === 1 ? "event" : "events"}`}
    >
      <div className="row wrap calendar-form">
        <input className="field grow" value={title} placeholder="Event title" aria-label="Event title"
          onChange={(event) => setTitle(event.target.value)} />
        <input className="field" type="datetime-local" value={startsAt} aria-label="Event start"
          onChange={(event) => setStartsAt(event.target.value)} />
        <button type="button" className="btn btn-primary" onClick={submit} disabled={!title.trim() || !startsAt}>
          Add
        </button>
      </div>
      {note ? <span key={note} className="chip chip-warn chip-arrive">{note}</span> : null}

      {upcoming.length > 0 ? (
        <div className="col">
          <span className="label">Next up</span>
          {upcoming.map((event) => {
            // A countdown that never changes its own urgency is just a label;
            // this is the same clock formatRelative already reads, not a
            // separate guess at how soon "soon" is.
            const imminent = isImminent(event.startsAt, now);
            return (
              <div key={event.id} className="row spread panel list-row">
                <div className="row">
                  <span className="mono">{formatEventTime(event.startsAt)}</span>
                  <strong>{event.title}</strong>
                </div>
                <span className={`chip chip-live${imminent ? " chip-imminent" : ""}`}>
                  {formatRelative(event.startsAt, now)}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}

      {events.length === 0 ? (
        <Empty title="Nothing scheduled">
          Add an event above. It stays on this machine and needs no connected calendar.
        </Empty>
      ) : (
        <div className="col">
          <span className="label">All events</span>
          <ul className="list">
            {events.map((event) => (
              <li key={event.id} className="panel list-row">
                <div className="grow">
                  <strong>{event.title}</strong>
                  <p className="faint list-excerpt">
                    {event.startsAt.slice(0, 10)} · {formatEventTime(event.startsAt)} · {formatRelative(event.startsAt, now)}
                  </p>
                </div>
                <button type="button" className="btn btn-ghost btn-sm"
                  onClick={() => commit(removeEvent(events, event.id))}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Surface>
  );
}
