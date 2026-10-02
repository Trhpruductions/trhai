"use client";

import { useEffect, useState, type RefObject } from "react";

/**
 * An element's rendered width in CSS pixels, kept current as the layout
 * changes. Null until it has been measured.
 *
 * For anything drawn at a pixel size inside a box that CSS sizes: the core's
 * canvas was a fixed 440px inside a box of min(52vh, 460px), so on any window
 * shorter than about 850px it overflowed to the right and down, off-centre
 * from the mark drawn over it.
 */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number | null {
  const [width, setWidth] = useState<number | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const next = Math.round(entries[0]?.contentRect.width ?? 0);
      if (next > 0) setWidth((current) => (current === next ? current : next));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return width;
}
