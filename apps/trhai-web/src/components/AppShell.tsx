"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { apiBaseUrl } from "../lib/api";
import "./shell.css";

// The shell every screen shares: a rail and a status strip.
//
// Dashboard, Chat, Settings, Agents, Security, Tasks, Memory, Knowledge,
// Calendar and Automation are real destinations in this phase — System and
// Files are later, and a nav entry that opens onto an empty promise is worse
// than one that says plainly it is not built yet. None of the seven added
// after Settings were themselves named phase-4 items, but all seven are
// real, working screens backed by data the API already had or a store built
// for exactly this: Agents by @ascend/shared's marketplace module, Security
// by GET /v1/capabilities wrapping the same registry runTool enforces, Tasks
// by taskListStore.ts (a plain to-do list — not to be confused with the
// orchestrator's own StoredTask, a different thing under a similar name),
// Memory and Knowledge by the GET/PATCH/DELETE /v1/assist/memory and
// /v1/knowledge routes that already existed for the chat surface to use,
// Calendar by @ascend/shared's localCalendar.ts, and Automation by
// @ascend/shared's automation.ts — each only gives an existing capability a
// screen of its own. Automation's one desktop-dependent step, RUN SCRIPT,
// already reports itself honestly as skipped with no runner configured,
// rather than needing this screen to hide or fake that gap.
//
// System and Files were listed here as needing window.ascendDesktop, the
// Electron-only bridge this Next.js app does not have. That was true of the
// browser and false of the app: the local API is a Node process on this
// machine, so it can read os.cpus() and the workspace directly, and both
// screens are built against it rather than against a bridge. Nothing is
// waiting on Electron — the desktop app remains the only way to reach
// anything outside the workspace, which is a deliberate boundary rather than
// a missing feature.

type Destination = { href: string; label: string; glyph: string; hint: string };

const live: Destination[] = [
  { href: "/", label: "Dashboard", glyph: "◈", hint: "Command centre" },
  { href: "/chat", label: "Chat", glyph: "◉", hint: "Talk to TRHAI" },
  { href: "/tasks", label: "Tasks", glyph: "▤", hint: "A plain to-do list" },
  { href: "/calendar", label: "Calendar", glyph: "▧", hint: "Your schedule, on this machine" },
  { href: "/memory", label: "Memory", glyph: "◍", hint: "Facts you've asked TRHAI to keep" },
  { href: "/knowledge", label: "Knowledge", glyph: "▥", hint: "Documents TRHAI can quote" },
  { href: "/automation", label: "Automation", glyph: "◇", hint: "Flows you can actually run" },
  { href: "/agents", label: "Agents", glyph: "◆", hint: "Installable lenses on the same assistant" },
  { href: "/security", label: "Security", glyph: "◐", hint: "Every tool and the permission that gates it" },
  { href: "/system", label: "System", glyph: "▦", hint: "What is running, and which build this is" },
  { href: "/files", label: "Files", glyph: "▣", hint: "The workspace, read straight from disk" },
  { href: "/settings", label: "Settings", glyph: "⚙", hint: "Voice, theme and defaults" }
];

// There is no `planned` list any more. It held System and Files, and an
// empty one left a rail divider with nothing under it — three lines to bring
// back if something is genuinely pending again.

function StatusFooter() {
  const [online, setOnline] = useState<boolean | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [apiMs, setApiMs] = useState<number | null>(null);
  // Null until mounted, deliberately. Reading the clock during render makes
  // the server and the browser disagree by whatever fraction of a second sat
  // between them, which React reports as a hydration mismatch on every single
  // load — the time is genuinely unknowable server-side, so it is not
  // rendered there at all.
  const [clock, setClock] = useState<Date | null>(null);

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
    setClock(new Date());
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
        {/* Em dashes rather than a blank until the first tick: the strip has a
            fixed layout, and an empty slot that suddenly fills reads as a
            glitch where a placeholder reads as a reading not yet taken. */}
        {clock
          ? clock.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })
          : "--:--:--"}
      </span>
    </footer>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  // The dashboard is the command centre: it carries its own labelled rail,
  // its own status strip, and the core at the middle of the screen. Wrapping
  // it in this shell would put a second rail beside its rail and a second
  // status bar under its status bar, which is exactly the "navigating a
  // website" feeling that screen exists to avoid. Every other route is an
  // ordinary page and keeps the shell.
  if (pathname === "/") return <>{children}</>;

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
      </nav>

      <main className="trhai-stage">{children}</main>

      <StatusFooter />
    </div>
  );
}
