// Keeping the keyboard inside a dialog.
//
// A dialog that is open must hold the keyboard: Tab from its last control goes to its
// first, Shift+Tab from its first goes to its last, and neither ever reaches the page
// behind it. The rule is here, apart from any element, so it can be tested.

/** What can take the keyboard's focus. */
export const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

/**
 * Where Tab or Shift+Tab goes next among `count` controls, given where focus is now.
 * `current` is the index of the focused control, or -1 when focus is outside them.
 */
export function nextFocusIndex(count: number, current: number, backwards: boolean): number {
  if (count <= 0) return -1;
  if (current < 0) return backwards ? count - 1 : 0;
  if (backwards) return current === 0 ? count - 1 : current - 1;
  return current === count - 1 ? 0 : current + 1;
}
