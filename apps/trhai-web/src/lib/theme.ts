// The accent, as a real (if small) working theme system — master spec §4 and
// §15 both name this as core-shell scope. Kept to a fixed set rather than a
// free colour picker: an arbitrary hex cannot be checked for contrast against
// this HUD's near-black surfaces, and a theme system that lets someone pick
// unreadable text is a worse one than a short, considered list.

export type Accent = "cyan" | "violet" | "emerald" | "amber";

export const accents: Accent[] = ["cyan", "violet", "emerald", "amber"];
export const defaultAccent: Accent = "cyan";

const storageKey = "trhai.accent.v1";

export function isAccent(value: unknown): value is Accent {
  return typeof value === "string" && (accents as string[]).includes(value);
}

export function readStoredAccent(storage: Pick<Storage, "getItem"> | undefined): Accent {
  if (!storage) return defaultAccent;
  try {
    const value = storage.getItem(storageKey);
    return isAccent(value) ? value : defaultAccent;
  } catch {
    return defaultAccent;
  }
}

export function writeStoredAccent(storage: Pick<Storage, "setItem"> | undefined, accent: Accent): void {
  try {
    storage?.setItem(storageKey, accent);
  } catch {
    // A theme choice not persisting is not worth failing over.
  }
}

/**
 * The inline script that applies a stored accent before first paint.
 *
 * Reading localStorage and setting one attribute, nothing else — this exists
 * only to avoid the flash of the default accent while React hydrates, the
 * same reason a colour-scheme script runs this early in most dark-mode sites.
 */
export function themeBootScript(): string {
  return `(function(){try{var a=localStorage.getItem(${JSON.stringify(storageKey)});var valid=${JSON.stringify(accents)};if(valid.indexOf(a)!==-1){document.documentElement.setAttribute("data-accent",a);}}catch(e){}})();`;
}
