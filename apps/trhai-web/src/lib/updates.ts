// Updates, from the interface's side: what the API says is new and whether a
// newer version is out, and the one decision of which notice (if any) to put
// in front of whoever is using the app.
//
// Two notices, both shown to everyone who opens the app, signed in or not:
//
// - "What's new": the first time a version runs in this browser, its release
//   notes, once. Closing it remembers the version.
// - "Update available": when the release feed has a newer version, with the
//   download. Closing it remembers that version, so the same release does
//   not come back every launch; the next one does.
//
// What's new wins when both apply: the person has just been updated and
// should hear about that first. The Updates section in Settings shows both at
// any time.

import { apiGet } from "./api";

export type ReleaseNote = { version: string; date: string; title: string; notes: string[] };

export type LatestRelease = {
  version: string;
  url: string;
  downloadUrl: string | null;
  publishedAt: string | null;
  notes: string;
};

export type UpdateCheck = {
  currentVersion: string;
  notes: ReleaseNote[];
  latest: LatestRelease | null;
  updateAvailable: boolean;
  checkedAt: string | null;
  checkError: string | null;
  checkDisabled: boolean;
};

export const seenVersionKey = "trhai.whatsnew.seen.v1";
export const dismissedUpdateKey = "trhai.update.dismissed.v1";

/** Fired on window to open the What's new notice on demand, from Settings. */
export const showWhatsNewEvent = "trhai:whatsnew";

type Store = Pick<Storage, "getItem" | "setItem">;

function safely<T>(run: () => T, fallback: T): T {
  try {
    return run();
  } catch {
    return fallback;
  }
}

export async function readUpdates(refresh = false): Promise<UpdateCheck | null> {
  const result = await apiGet<UpdateCheck>(`/v1/updates${refresh ? "?refresh=1" : ""}`);
  return result.ok ? result.data : null;
}

export type Notice =
  | { kind: "whatsnew"; note: ReleaseNote }
  | { kind: "update"; latest: LatestRelease }
  | null;

/**
 * Which notice to show now. Pure: the check and what this browser remembers
 * go in, the answer comes out.
 *
 * A browser that has never seen any version is treated as having just been
 * updated to this one, so a fresh install greets people with what the app
 * does now - but only when there are notes for exactly this version.
 */
export function noticeToShow(check: UpdateCheck | null, seenVersion: string | null, dismissedUpdate: string | null): Notice {
  if (!check) return null;
  const current = check.notes.find((note) => note.version === check.currentVersion);
  if (current && seenVersion !== check.currentVersion) return { kind: "whatsnew", note: current };
  if (check.updateAvailable && check.latest && dismissedUpdate !== check.latest.version) {
    return { kind: "update", latest: check.latest };
  }
  return null;
}

export function readSeenVersion(store: Store): string | null {
  return safely(() => store.getItem(seenVersionKey), null);
}

export function markVersionSeen(store: Store, version: string): void {
  safely(() => store.setItem(seenVersionKey, version), undefined);
}

export function readDismissedUpdate(store: Store): string | null {
  return safely(() => store.getItem(dismissedUpdateKey), null);
}

export function dismissUpdate(store: Store, version: string): void {
  safely(() => store.setItem(dismissedUpdateKey, version), undefined);
}

/** Opens a release or download link; the desktop shell hands web links to the OS. */
export function openReleaseLink(url: string): void {
  if (!/^https:\/\//i.test(url)) return;
  window.open(url, "_blank", "noopener,noreferrer");
}
