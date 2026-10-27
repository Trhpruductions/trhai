"use client";

import { useEffect, useState } from "react";
import { readEntitlements, type EntitlementView } from "../lib/access";
import { licenseEvent } from "../lib/license";

/**
 * What the person may do, read from the API: when the screen opens, whenever the
 * account changes (signing in or out is a different person), and whenever a
 * license is entered or removed or a request is refused for want of one.
 * Null until the API has answered, or when it cannot be reached.
 */
export function useEntitlements(accountId: string | null): EntitlementView | null {
  const [view, setView] = useState<EntitlementView | null>(null);

  useEffect(() => {
    let alive = true;
    const read = () => {
      void readEntitlements().then((result) => {
        if (alive) setView(result.ok ? result.data : null);
      });
    };
    read();
    window.addEventListener(licenseEvent, read);
    return () => {
      alive = false;
      window.removeEventListener(licenseEvent, read);
    };
  }, [accountId]);

  return view;
}
