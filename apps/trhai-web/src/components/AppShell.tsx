"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { apiBaseUrl } from "../lib/api";
import "./shell.css";

// The shell every screen shares: a rail and a status strip.
//
// Dashboard, Chat, Settings, Agents, Security and Tasks are real
// destinations in this phase — System and Files are later, and a nav entry
// that opens onto an empty promise is worse than one that says plainly it is
// not built yet. None of Agents, Security or Tasks were themselves named
// phase-4 items, but all three are real, working screens backed by data the
// API already had or a store built for exactly this: Agents by
// @ascend/shared's marketplace module, Security by GET /v1/capabilities
// wrapping the same registry runTool enforces, Tasks by taskListStore.ts (a
// plain to-do list — not to be confused with the orchestrator's own
// StoredTask, a different thing under a similar name).
//
// System and Files stay planned for a different reason than the above three
// did before this: both depend entirely on window.ascendDesktop, the
// Electron-only bridge apps/desktop provides and this Next.js app does not
// — porting either means standing up that bridge first, not writing this
// screen.

type Destination = { href: string; label: string; glyph: string; hint: string };

const live: Destination[] = [
  { href: "/", label: "Dashboard", glyph: "◈", hint: "Command centre" },
  { href: "/chat", label: "Chat", glyph: "◉", hint: "Talk to TRHAI" },
  { href: "/tasks", label: "Tasks", glyph: "▤", hint: "A plain to-do list" },
  { href: "/agents", label: "Agents", glyph: "◆", hint: "Installable lenses on the same assistant" },
  { href: "/security", label: "Security", glyph: "◐", hint: "Every tool and the permission that gates it" },
  { href: "/settings", label: "Settings", glyph: "⚙", hint: "Voice, theme and defaults" }
];

const planned: Destination[] = [
  { href: "#", label: "System", glyph: "▦", hint: "Needs the desktop bridge — not built yet" },
  { href: "#", label: "Files", glyph: "▣", hint: "Needs the desktop bridge — not built yet" }
];

function StatusFooter() {
  const [online, setOnline] = useState<boolean | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [apiMs, setApiMs] = useState<number | null>(null);
  const [clock, setClock] = useState(() => new Date());

  useEffect(() => {
    let cancelled = false;

    async function sample() {
      const startedAt = performance.now();
      try {
        const response = await fetch(`${apiBaseUrl}/v1/assist/model`);
        const elapsed = Math.round(performance.now() - startedAt);
        if (cancelled) return;
        setOnline(response.ok);
        setApiMs(response.ok ? elapsed : null);
        if (response.ok) {
          const payload = await response.json();
          setModel(payload?.data?.available ? payload?.data?.model ?? null : null);
        } else {
          setModel(null);
        }
      } catch {
        if (!cancelled) { setOnline(false); setApiMs(null); setModel(null); }
      }
    }

    void sample();
    const poller = window.setInterval(sample, 4000);
    const ticker = window.setInterval(() => setClock(new Date()), 1000);
    return () => { cancelled = true; window.clearInterval(poller); window.clearInterval(ticker); };
  }, []);

  return (
    <footer className="trhai-statusbar" aria-label="System status">
      <span className={`sb-dot${online ? " live" : ""}`} aria-hidden="true" />
      <span className="hud-label">{online === null ? "CONNECTING" : online ? "ONLINE" : "OFFLINE"}</span>
      <span className="sb-sep" aria-hidden="true" />
      <span className="mono sb-item" title="Round trip to the local API">
        API {apiMs === null ? "—" : `${apiMs}ms`}
      </span>
      <span className={`sb-item sb-model${model ? " live" : ""}`}
        title={model ? `Answers can come from ${model}` : "No local model — TRHAI cannot generate a reply yet"}>
        {model ? model.replace(/:latest$/, "") : "no model"}
      </span>
      <span className="grow" />
      <span className="mono sb-item sb-clock">
        {clock.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
      </span>
    </footer>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="trhai-shell">
      <nav className="trhai-rail" aria-label="Sections">
        <div className="rail-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="18" height="18">
            <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
            <circle cx="12" cy="12" r="3" fill="currentColor" />
          </svg>
        </div>

        {live.map((entry) => (
          <Link
            key={entry.href}
            href={entry.href}
            className={`rail-btn${pathname === entry.href ? " active" : ""}`}
            aria-label={entry.label}
            aria-current={pathname === entry.href ? "page" : undefined}
            title={`${entry.label} — ${entry.hint}`}
          >
            <span aria-hidden="true">{entry.glyph}</span>
          </Link>
        ))}

        <div className="rail-divider" aria-hidden="true" />

        {planned.map((entry) => (
          <span key={entry.label} className="rail-btn rail-btn-planned" title={`${entry.label} — ${entry.hint}`}>
            <span aria-hidden="true">{entry.glyph}</span>
          </span>
        ))}
      </nav>

      <main className="trhai-stage">{children}</main>

      <StatusFooter />
    </div>
  );
}
