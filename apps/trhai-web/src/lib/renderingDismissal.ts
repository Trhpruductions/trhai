// Which rendering the user last dismissed, kept across reloads.
//
// The home screen shows the newest mockup or diagram over the core until it
// is dismissed. The dismissal lived only in component state, so every reload
// and every launch brought the same rendering back: a "Settings" mockup from
// eleven days earlier sat over the core each time the app opened, however
// many times it had been closed.
//
// Keyed by name and creation time together, not by name alone: rendering
// something new under a name used before ("settings" again) is a new
// rendering, and has to show.

const storageKey = "trhai.rendering.dismissed.v1";

/** The identity a dismissal is recorded against. */
export function renderingKey(rendering: { name: string; createdAt: string }): string {
  return `${rendering.name}@${rendering.createdAt}`;
}

export function readDismissedRendering(storage: Pick<Storage, "getItem"> | undefined): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(storageKey);
  } catch {
    return null;
  }
}

export function writeDismissedRendering(storage: Pick<Storage, "setItem"> | undefined, key: string): void {
  try {
    storage?.setItem(storageKey, key);
  } catch {
    // A dismissal not persisting only means the rendering shows again.
  }
}
