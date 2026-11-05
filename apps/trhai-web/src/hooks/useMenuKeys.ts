"use client";

import { useEffect, useRef } from "react";
import { stepIndex } from "../lib/focus";

/**
 * The keyboard a menu needs (the menu-button pattern): focus moves to its first item when
 * it opens, the arrows, Home and End move between the items, Escape closes it and puts the
 * keyboard back on the button that opened it, and Tab does the same so the page's own order
 * carries on from there. Attach the returned ref to the element with role="menu".
 */
export function useMenuKeys<T extends HTMLElement>(open: boolean, close: () => void) {
  const ref = useRef<T | null>(null);
  // Held in a ref so a parent that makes a new function every render does not restart the effect.
  const closer = useRef(close);
  useEffect(() => {
    closer.current = close;
  }, [close]);

  useEffect(() => {
    if (!open) return;
    const node = ref.current;
    if (!node) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const items = () => Array.from(node.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])'));
    items()[0]?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Tab") {
        event.preventDefault();
        event.stopPropagation();
        closer.current();
        opener?.focus();
        return;
      }
      const list = items();
      const next = stepIndex(list.length, list.indexOf(document.activeElement as HTMLElement), event.key);
      if (next === null) return;
      event.preventDefault();
      list[next]?.focus();
    };
    node.addEventListener("keydown", onKey);
    return () => node.removeEventListener("keydown", onKey);
  }, [open]);

  return ref;
}
