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

// The room behind the shell (os/shell/Backdrop): the key art with its living
// layer, the art standing still, or a plain dark field - for a slower machine,
// or for anyone who would rather nothing moved behind their work.

export type BackdropMode = "living" | "still" | "plain";

export const backdropModes: BackdropMode[] = ["living", "still", "plain"];
export const defaultBackdrop: BackdropMode = "living";

const backdropKey = "trhai.backdrop.v1";

export function isBackdropMode(value: unknown): value is BackdropMode {
  return typeof value === "string" && (backdropModes as string[]).includes(value);
}

export function readStoredBackdrop(storage: Pick<Storage, "getItem"> | undefined): BackdropMode {
  if (!storage) return defaultBackdrop;
  try {
    const value = storage.getItem(backdropKey);
    return isBackdropMode(value) ? value : defaultBackdrop;
  } catch {
    return defaultBackdrop;
  }
}

export function writeStoredBackdrop(storage: Pick<Storage, "setItem"> | undefined, mode: BackdropMode): void {
  try {
    storage?.setItem(backdropKey, mode);
  } catch {
    // Applied for now even if it cannot be remembered.
  }
}

/**
 * The inline script that applies the stored accent and background before
 * first paint.
 *
 * Reading localStorage and setting two attributes, nothing else — this exists
 * only to avoid a flash of the defaults while React hydrates (the key art
 * appearing for a moment behind a plain background, say), the same reason a
 * colour-scheme script runs this early in most dark-mode sites. Each value is
 * checked against its fixed list before it is set.
 */
export function themeBootScript(): string {
  return `(function(){try{var a=localStorage.getItem(${JSON.stringify(storageKey)});var valid=${JSON.stringify(accents)};if(valid.indexOf(a)!==-1){document.documentElement.setAttribute("data-accent",a);}`
    + `var b=localStorage.getItem(${JSON.stringify(backdropKey)});var modes=${JSON.stringify(backdropModes)};if(modes.indexOf(b)!==-1){document.documentElement.setAttribute("data-backdrop",b);}}catch(e){}})();`;
}
