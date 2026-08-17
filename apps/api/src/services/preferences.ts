import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

// Machine preferences.
//
// Personality lived in the browser's local storage, which meant the desktop
// window and a browser tab each kept their own — set it in one and the other
// still disagreed. Moving it here makes it one setting for one machine.
//
// Deliberately not keyed by session or account. The session id is itself held
// in local storage, so keying by it would reproduce exactly the split this is
// meant to close; and there is no sign-in in the interface to key by an account.
// This is a single-user app running on someone's own computer, so the machine is
// the right owner. If accounts ever reach the UI, this becomes a per-account
// record and the file below becomes the signed-out default.

export type Preferences = {
  /** Personality id; validated against the client's list by the caller. */
  personality: string;
};

export const defaultPreferences: Preferences = { personality: "professional" };

const preferencesFile = process.env.ASCEND_PREFERENCES_FILE
  ?? path.join(process.cwd(), "data", "preferences.json");

let persistenceEnabled = process.env.ASCEND_PREFERENCES_PERSIST !== "off";
let loaded = false;
let current: Preferences = { ...defaultPreferences };

/**
 * Narrow whatever is on disk.
 *
 * A hand-edited or outdated file must not be able to put the app into a state
 * the UI cannot render, so anything unrecognised falls back to the default
 * rather than being trusted.
 */
export function parsePreferences(value: unknown): Preferences {
  if (!value || typeof value !== "object") return { ...defaultPreferences };

  const raw = value as { personality?: unknown };
  return {
    personality: typeof raw.personality === "string" && raw.personality.trim()
      ? raw.personality.trim()
      : defaultPreferences.personality
  };
}

function load(): void {
  if (loaded) return;
  loaded = true;
  if (!persistenceEnabled || !existsSync(preferencesFile)) return;

  try {
    current = parsePreferences(JSON.parse(readFileSync(preferencesFile, "utf8")));
  } catch {
    // A corrupt file must never stop the API starting; the default is fine.
    current = { ...defaultPreferences };
  }
}

function save(): void {
  if (!persistenceEnabled) return;

  try {
    mkdirSync(path.dirname(preferencesFile), { recursive: true });
    // Temp file then rename, so a crash mid-write cannot truncate the file.
    const tempPath = `${preferencesFile}.tmp`;
    writeFileSync(tempPath, JSON.stringify(current, null, 2), "utf8");
    renameSync(tempPath, preferencesFile);
  } catch {
    // Losing durability is bad; failing the request is worse.
  }
}

export function readPreferences(): Preferences {
  load();
  return { ...current };
}

/**
 * Apply a partial update.
 *
 * Returns the full resulting preferences so a caller never has to guess what
 * the new state is, and only writes when something actually changed.
 */
export function updatePreferences(patch: Partial<Preferences>): Preferences {
  load();

  const next: Preferences = {
    personality: typeof patch.personality === "string" && patch.personality.trim()
      ? patch.personality.trim()
      : current.personality
  };

  if (next.personality !== current.personality) {
    current = next;
    save();
  }

  return { ...current };
}

export function resetPreferences(): void {
  current = { ...defaultPreferences };
  loaded = true;
  save();
}

export function setPreferencesPersistence(enabled: boolean): void {
  persistenceEnabled = enabled;
}
