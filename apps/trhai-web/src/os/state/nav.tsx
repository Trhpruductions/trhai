"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { detailFromHash, hashFor, viewFromHash, type ViewId } from "../views";

// Where the user is in TRH AI, and the shell's own open/closed state.
//
// The workspace is kept in the address (#chat, #memory), so reloading stays
// where you were and the back button goes back - in the browser and in the
// desktop app alike, since a hash change never leaves the page.

type Nav = {
  view: ViewId;
  /** Open a view - and, given a detail, somewhere within it ("#files/app2"). */
  go: (view: ViewId, detail?: string | null) => void;
  /** The sidebar in its icon-only form. */
  slim: boolean;
  setSlim: (slim: boolean) => void;
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  noticesOpen: boolean;
  setNoticesOpen: (open: boolean) => void;
};

const NavContext = createContext<Nav | null>(null);
const slimKey = "trhai.os.slim.v1";

export function NavProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<ViewId>("home");
  const [slim, setSlimState] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [noticesOpen, setNoticesOpen] = useState(false);

  // Read after mount: the server has no address hash and no storage, and a
  // first render that disagreed with it would fail hydration.
  useEffect(() => {
    const read = () => setView(viewFromHash(window.location.hash));
    read();
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- a stored preference, unknowable on the server
      setSlimState(window.localStorage.getItem(slimKey) === "1");
    } catch {
      // Storage can be unavailable; the full sidebar is the default anyway.
    }
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);

  const go = useCallback((next: ViewId, detail?: string | null) => {
    setPaletteOpen(false);
    // Already exactly there - the same view, the same place in it: no new entry.
    if (viewFromHash(window.location.hash) === next && detailFromHash(window.location.hash) === (detail || null)) {
      setView(next);
      return;
    }
    // A history entry per workspace, so Back returns to the last one.
    window.location.hash = hashFor(next, detail);
  }, []);

  const setSlim = useCallback((next: boolean) => {
    setSlimState(next);
    try {
      window.localStorage.setItem(slimKey, next ? "1" : "0");
    } catch {
      // Not remembered, still applied.
    }
  }, []);

  const value = useMemo<Nav>(() => ({
    view, go, slim, setSlim, paletteOpen, setPaletteOpen, noticesOpen, setNoticesOpen
  }), [view, go, slim, setSlim, paletteOpen, noticesOpen]);

  return <NavContext.Provider value={value}>{children}</NavContext.Provider>;
}

export function useNav(): Nav {
  const nav = useContext(NavContext);
  if (!nav) throw new Error("useNav needs NavProvider");
  return nav;
}
