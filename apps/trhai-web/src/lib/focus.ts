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

/**
 * Where an arrow key, Home or End moves among the items, given where focus is now: the
 * arrows step and wrap, Home and End jump. Null for any other key, so the caller leaves
 * it alone. One rule for a menu's items and a radio group's buttons alike.
 */
export function stepIndex(count: number, current: number, key: string): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowDown":
    case "ArrowRight":
      return nextFocusIndex(count, current, false);
    case "ArrowUp":
    case "ArrowLeft":
      return nextFocusIndex(count, current, true);
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** A radio group has one tab stop: its checked button, or its first when none is checked. */
export function radioTabIndex(checkedIndex: number, index: number): 0 | -1 {
  return (checkedIndex < 0 ? index === 0 : index === checkedIndex) ? 0 : -1;
}

/** The little of an element this needs, so the rule can be tested without a browser. */
export type IsolatableNode = {
  parentElement: IsolatableNode | null;
  children: ArrayLike<IsolatableNode>;
  tagName?: string;
  inert?: boolean;
};

/**
 * Makes everything outside a node inert - out of reach of the keyboard, a screen reader and
 * the mouse - until the returned function is called. On the way up to the root, each
 * ancestor's other children are marked; what was inert already is left alone and not
 * undone, so a dialog opened over another dialog gives back exactly what it took. The
 * node and its ancestors are made live for the duration, whatever an earlier dialog did
 * to them, and put back as they were.
 */
export function isolate(node: IsolatableNode): () => void {
  const marked: IsolatableNode[] = [];
  const revived: IsolatableNode[] = [];
  for (let self: IsolatableNode | null = node; self; self = self.parentElement) {
    if (self.inert) {
      self.inert = false;
      revived.push(self);
    }
  }
  let child = node;
  let parent = node.parentElement;
  while (parent) {
    for (const sibling of Array.from(parent.children)) {
      if (sibling === child || sibling.inert || /^(SCRIPT|STYLE|LINK|HEAD)$/i.test(sibling.tagName ?? "")) continue;
      sibling.inert = true;
      marked.push(sibling);
    }
    child = parent;
    parent = parent.parentElement;
  }
  return () => {
    for (const element of marked) element.inert = false;
    for (const element of revived) element.inert = true;
  };
}
