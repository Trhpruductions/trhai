"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

// One screen for the whole app.
//
// Every part of TRHAI used to be its own route, so using it meant leaving the
// command centre and coming back — the core disappeared, the machine readings
// stopped being visible, and a running reply was somewhere behind you. For an
// interface whose whole point is that it is a live view of one machine, that
// is the wrong shape: you should never have to navigate away from the thing
// that is telling you what is happening.
//
// So the surfaces are panels on the same screen now, and the rail switches
// between them instead of routing. Nothing unmounts, nothing reloads, and the
// core, the metrics and the state rail stay where they are the entire time.
//
// The old routes still resolve, deliberately. A bookmark to /files or a link
// someone saved keeps working, and each surface is still an ordinary
// component that can be rendered on its own — this adds a way to reach them,
// rather than taking one away.

export type SurfaceId =
  | "home" | "chat" | "tasks" | "calendar" | "memory" | "knowledge"
  | "automation" | "agents" | "security" | "system" | "files" | "settings";

type SurfaceState = { active: SurfaceId; open: (id: SurfaceId) => void };

const SurfaceContext = createContext<SurfaceState | null>(null);

export function SurfaceProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<SurfaceId>("home");
  // Memoised so switching a surface does not re-render every consumer of the
  // context for a value that did not change.
  const value = useMemo<SurfaceState>(() => ({ active, open: setActive }), [active]);
  return <SurfaceContext.Provider value={value}>{children}</SurfaceContext.Provider>;
}

/**
 * The active surface, when there is a provider above.
 *
 * Returns null outside one, which is how the old routes keep working: a page
 * rendered at its own URL has no provider, renders itself, and never tries to
 * drive a switcher that is not there.
 */
export function useSurface(): SurfaceState | null {
  return useContext(SurfaceContext);
}
