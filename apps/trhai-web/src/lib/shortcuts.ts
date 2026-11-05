// The one shortcut made of a single printable key, and its off switch.
//
// "/" from anywhere that is not a text field puts the keyboard in the command bar
// (CommandBar.tsx). A single-key shortcut is a hazard for anyone whose speech recognition
// or hands produce stray keys (WCAG 2.1.4), so it can be turned off under Settings,
// Keyboard. The choice is kept with the settings the app needs, not the optional ones: an
// instruction to stop doing something has to hold on the next visit whatever was answered
// about remembered choices.

export const singleKeyShortcutKey = "trhai.keys.single.v1";

/** Fired on the window when the switch changes, so every screen that shows it follows. */
export const shortcutsEvent = "trhai:shortcuts";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function local(): Store | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

// When the storage refuses, the switch still holds for this page.
let unstored: boolean | null = null;

/** Whether "/" moves the keyboard to the command bar. On unless it was turned off. */
export function singleKeyShortcutOn(store: Store | undefined = local()): boolean {
  try {
    return store?.getItem(singleKeyShortcutKey) !== "off";
  } catch {
    return unstored ?? true;
  }
}

/** Turns the single-key shortcut on or off. Nothing is stored while it is on, the default. */
export function setSingleKeyShortcut(on: boolean, store: Store | undefined = local()): void {
  try {
    if (on) store?.removeItem(singleKeyShortcutKey);
    else store?.setItem(singleKeyShortcutKey, "off");
    unstored = null;
  } catch {
    unstored = on;
  }
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(shortcutsEvent, { detail: { on } }));
}
