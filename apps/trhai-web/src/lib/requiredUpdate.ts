// A release every copy has to move to (a note with `required: true`, see
// docs/24-paywall-and-updates.md): on the installed app it is not offered, it
// is downloaded by itself, and the app restarts into it. This is what the
// window does at each point, from what the release says and what the app's own
// updater reports. Pure, so it is tested without a window or an updater.

import type { DesktopUpdateStatus } from "./desktopUpdates";
import type { LatestRelease } from "./updates";

/** How long the window waits, once the update is ready, before the app restarts by itself. */
export const restartCountdownSeconds = 120;

export type RequiredUpdateStep =
  /** Nothing is forced: no required release, no installed app to do it, or nothing for it to download. */
  | { kind: "none" }
  /** The updater has not looked yet, or is looking. */
  | { kind: "checking" }
  /** The updater has found it and has not started downloading. */
  | { kind: "download" }
  | { kind: "downloading"; percent: number }
  | { kind: "restart"; version: string }
  | { kind: "failed"; message: string };

export function requiredUpdateStep(release: LatestRelease | null, status: DesktopUpdateStatus | null): RequiredUpdateStep {
  // A browser, the portable build and a copy run from source have no updater: they keep the ordinary card.
  if (!release || !status) return { kind: "none" };
  switch (status.state) {
    case "unsupported": return { kind: "none" };
    // Its own feed has nothing: the release page is ahead of the files, and the card offers the link meanwhile.
    case "not-available": return { kind: "none" };
    case "idle":
    case "checking": return { kind: "checking" };
    case "available": return { kind: "download" };
    case "downloading": return { kind: "downloading", percent: Math.max(0, Math.min(100, Math.round(status.percent))) };
    case "downloaded": return { kind: "restart", version: status.version || release.version };
    case "error": return { kind: "failed", message: status.message };
  }
}

/** "1:05", for the seconds left before the restart. */
export function countdownText(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}
