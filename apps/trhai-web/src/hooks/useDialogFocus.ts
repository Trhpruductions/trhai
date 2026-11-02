"use client";

import { useEffect, useRef } from "react";
import { focusableSelector, nextFocusIndex } from "../lib/focus";

/**
 * Makes an element behave as a modal dialog for the keyboard: focus moves into it when it
 * opens, Tab and Shift+Tab stay inside it, Escape closes it, and focus goes back to what had
 * it before when it closes. Attach the returned ref to the dialog's element.
 */
export function useDialogFocus<T extends HTMLElement>(open: boolean, onClose?: () => void) {
  const ref = useRef<T | null>(null);
  // Held in a ref so a parent that makes a new function every render does not restart the effect and steal focus.
  const closer = useRef(onClose);
  useEffect(() => {
    closer.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const node = ref.current;
    if (!node) return;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const controls = () => Array.from(node.querySelectorAll<HTMLElement>(focusableSelector)).filter((item) => item.offsetParent !== null || item === document.activeElement);
    (controls()[0] ?? node).focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && closer.current) {
        event.preventDefault();
        event.stopPropagation();
        closer.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = controls();
      if (items.length === 0) {
        event.preventDefault();
        node.focus();
        return;
      }
      const at = items.indexOf(document.activeElement as HTMLElement);
      const target = items[nextFocusIndex(items.length, at, event.shiftKey)];
      // Only steered at the edges (or from outside): inside, the browser's own order is the right one.
      if (at === -1 || (event.shiftKey && at === 0) || (!event.shiftKey && at === items.length - 1)) {
        event.preventDefault();
        target.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      before?.focus?.();
    };
  }, [open]);

  return ref;
}
