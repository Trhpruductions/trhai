"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet } from "../lib/api";
import { newRuns, type Reminder, type ScheduleRun } from "../lib/reminders";

// Reminders, shown when they fire: on screen, and as a system notification so
// one reaches the user with the window in the background or minimised.
//
// A separate, light poll from the dashboard's: that one stops while the window
// is hidden, and a reminder that waits for the window to come back is not one.
// /v1/schedules reads a list - no sensors - so every 30 seconds costs nothing.

const pollMs = 30_000;
/** On screen at once; older ones give way. */
const shownAtOnce = 3;

function notifySystem(reminder: Reminder): void {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    // A reminder's name is usually its own words; the heading says what it is instead.
    const heading = reminder.title === reminder.body ? "Reminder" : reminder.title;
    new Notification(heading, { body: reminder.body, tag: reminder.key });
  } catch {
    // Some browsers allow notifications only from a service worker; the
    // on-screen one still shows.
  }
}

export function useReminders(onReminder?: (reminder: Reminder) => void) {
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [hasSchedules, setHasSchedules] = useState(false);
  const seen = useRef<Map<string, string> | null>(null);
  // Read through a ref so the poll is set up once, not on every render.
  const announce = useRef(onReminder);
  useEffect(() => {
    announce.current = onReminder;
  }, [onReminder]);

  useEffect(() => {
    let stopped = false;
    const read = async () => {
      const result = await apiGet<{ schedules: ScheduleRun[] }>("/v1/schedules");
      if (stopped || !result.ok) return;
      setHasSchedules(result.data.schedules.length > 0);
      const { fresh, next } = newRuns(seen.current, result.data.schedules);
      seen.current = next;
      if (fresh.length === 0) return;
      setReminders((prior) => [...fresh, ...prior].slice(0, shownAtOnce));
      for (const reminder of fresh) {
        notifySystem(reminder);
        announce.current?.(reminder);
      }
    };
    void read();
    const timer = window.setInterval(() => void read(), pollMs);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);

  // A browser shows its permission prompt only in answer to a click, so it is
  // asked on the first one - and only once there is a schedule to be reminded
  // by. The desktop app has permission already and never asks.
  useEffect(() => {
    if (!hasSchedules || typeof Notification === "undefined" || Notification.permission !== "default") return;
    const ask = () => { void Notification.requestPermission(); };
    window.addEventListener("pointerdown", ask, { once: true });
    return () => window.removeEventListener("pointerdown", ask);
  }, [hasSchedules]);

  const dismiss = useCallback((key: string) => {
    setReminders((prior) => prior.filter((reminder) => reminder.key !== key));
  }, []);

  return { reminders, dismiss };
}
