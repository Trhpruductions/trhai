// Which of the settings TRH AI keeps in its window may be kept, and where the optional
// ones go when they may not.
//
// TRH AI sets no cookies. It keeps a short list of named items in the window's storage:
// those the app cannot work, or behave, without (the sign-in, the id that stands for a
// browser with no account, the guard against a restart loop, the notices a person has put
// away so they are not shown the same one again, and the answer to this very question),
// and the rest remembered choices - a colour, a voice, how the screen is arranged. The
// second kind is kept only once the person has said so. Until then, and after a
// no, those choices live in memory for the session and are gone when the window closes.
//
// The list below is the same list the "Cookies and browser storage" text shows; a test
// keeps the two together.

export const storageConsentKey = "trhai.storage-consent.v1";

/** What the app cannot work, or behave, without. Always kept. */
export const essentialStorageKeys = [
  "trhai.auth.v1",
  "trhai.guest.v1",
  "trhai.session.v1",
  "trhai.update.install-tried.v1",
  "trhai.whatsnew.seen.v1",
  "trhai.update.dismissed.v1",
  "trhai.setup.dismissed.v1",
  "trhai.setup.tools-offered.v1",
  "trhai.rendering.dismissed.v1",
  // The single-key shortcut switch (shortcuts.ts): an instruction, kept whatever was answered below.
  "trhai.keys.single.v1",
  storageConsentKey
] as const;

/** Remembered choices. Kept only with a yes. */
export const optionalStorageKeys = [
  "trhai.chat.conversation.v1",
  "trhai.accent.v1",
  "trhai.backdrop.v1",
  "trhai.os.slim.v1",
  "trhai.home.layout.v1",
  "trhai.personality.v1",
  "trhai.marketplace.v1",
  "trhai.voice.v1",
  "trhai.speech.enabled.v1",
  "trhai.cues.enabled.v1"
] as const;

export type StorageDecision = "all" | "essential";

export type StorageConsent = {
  decision: StorageDecision;
  /** The version of the "Cookies and browser storage" text that was shown. */
  version: string;
  at: string;
};

/** Fired on window when the answer changes, so the banner and the settings screen agree. */
export const storageConsentEvent = "trhai:storage-consent";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function safely<T>(run: () => T, fallback: T): T {
  try {
    return run();
  } catch {
    return fallback;
  }
}

export function readStorageConsent(local: Store | undefined): StorageConsent | null {
  const raw = safely(() => local?.getItem(storageConsentKey) ?? null, null);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StorageConsent>;
    if ((value.decision !== "all" && value.decision !== "essential") || typeof value.version !== "string" || typeof value.at !== "string") return null;
    return { decision: value.decision, version: value.version, at: value.at };
  } catch {
    return null;
  }
}

/** Every optional item, removed from both stores. */
export function clearOptionalStorage(local: Store | undefined, session: Store | undefined): void {
  for (const key of optionalStorageKeys) {
    safely(() => local?.removeItem(key), undefined);
    safely(() => session?.removeItem(key), undefined);
  }
}

/** Records the answer. A no also removes what a yes had let be kept. */
export function writeStorageConsent(
  local: Store | undefined, session: Store | undefined, decision: StorageDecision, version: string, now: Date = new Date()
): StorageConsent {
  const consent: StorageConsent = { decision, version, at: now.toISOString() };
  safely(() => local?.setItem(storageConsentKey, JSON.stringify(consent)), undefined);
  if (decision === "essential") clearOptionalStorage(local, session);
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(storageConsentEvent, { detail: consent }));
  return consent;
}

/** Whether remembered choices may be kept: only after a yes. */
export function optionalStorageAllowed(local: Store | undefined): boolean {
  return readStorageConsent(local)?.decision === "all";
}

/** A Storage that lives in memory: the home of the optional items until, or unless, they may be kept. */
export class MemoryStorage implements Storage {
  private items = new Map<string, string>();
  get length(): number { return this.items.size; }
  clear(): void { this.items.clear(); }
  getItem(key: string): string | null { return this.items.get(key) ?? null; }
  key(index: number): string | null { return [...this.items.keys()][index] ?? null; }
  removeItem(key: string): void { this.items.delete(key); }
  setItem(key: string, value: string): void { this.items.set(key, String(value)); }
}

const memoryLocal = new MemoryStorage();
const memorySession = new MemoryStorage();

/** This window's own stores, or nothing during server rendering or when storage is blocked. */
export function browserStorage(): { local: Storage | undefined; session: Storage | undefined } {
  if (typeof window === "undefined") return { local: undefined, session: undefined };
  return { local: safely(() => window.localStorage, undefined), session: safely(() => window.sessionStorage, undefined) };
}

/**
 * Where a remembered choice goes: the window's own local storage once the person has said
 * yes, and a store in memory otherwise. Read at each call, so an answer takes effect at once.
 */
export function optionalStorage(): Storage {
  const { local } = browserStorage();
  return local && optionalStorageAllowed(local) ? local : memoryLocal;
}

/** The same, for a choice that only ever lasts the session. */
export function optionalSessionStorage(): Storage {
  const { local, session } = browserStorage();
  return session && local && optionalStorageAllowed(local) ? session : memorySession;
}
