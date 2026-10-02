"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "../ui/Icon";
import { useNav } from "../state/nav";
import { useSystem } from "../state/system";
import { useNotices } from "../state/notify";
import { useVoice } from "../state/assistant";
import { useAccount } from "../../components/AppGate";
import { viewById } from "../views";

/** An account name as a person is addressed - read from the OS, never invented. */
function displayName(username: string): string {
  const trimmed = username.trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1) : "";
}

export function TopBar() {
  const { view, go, setPaletteOpen, noticesOpen, setNoticesOpen } = useNav();
  const { online, modelName, identity } = useSystem();
  const { unread } = useNotices();
  const { mic, speech } = useVoice();
  const account = useAccount();
  const current = viewById(view);

  // The clock fills in on the client; a server-rendered time disagrees a second later.
  const [clock, setClock] = useState<Date | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only clock
    setClock(new Date());
    const ticker = window.setInterval(() => setClock(new Date()), 15_000);
    return () => window.clearInterval(ticker);
  }, []);

  const [menuOpen, setMenuOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menuOpen]);

  const signedIn = account.account;
  const name = signedIn ? signedIn.displayName : identity ? displayName(identity.username) : "";
  const initials = (name || "?").split(/\s+/).map((part) => part.charAt(0)).join("").slice(0, 2).toUpperCase();

  return (
    <header className="os-topbar">
      <div className="os-topbar-title">
        <span className="os-label">{current.group}</span>
        <h2>{current.label}</h2>
      </div>

      <button type="button" className="os-search-trigger" onClick={() => setPaletteOpen(true)} aria-label="Search or run a command (Ctrl+K)">
        <Icon name="search" size={16} />
        <span>Search, or run a command…</span>
        <span className="os-search-keys"><kbd className="os-kbd">Ctrl</kbd><kbd className="os-kbd">K</kbd></span>
      </button>

      <div className="os-topbar-right">
        <div className="os-status-cluster" aria-label="System status">
          <span className={`os-chip ${online ? "ok" : online === false ? "danger" : ""}`} title={online ? "The local API is answering" : "The local API is not answering"}>
            <span className={`os-dot ${online ? "ok" : online === false ? "danger" : "warn"}`} aria-hidden="true" />
            {online === null ? "Connecting" : online ? "Online" : "Offline"}
          </span>
          <span className={`os-chip ${modelName ? "accent" : "warn"} os-chip-model`} title={modelName ? `Chat model: ${modelName}` : "No local model is loaded"}>
            {modelName ?? "No model"}
          </span>
          {mic.listening ? <span className="os-chip accent"><span className="os-dot accent live" aria-hidden="true" />Listening</span> : null}
          {speech.speaking ? <span className="os-chip violet">Speaking</span> : null}
        </div>

        <button
          type="button"
          className={`os-btn os-btn-ghost os-btn-icon os-bell${noticesOpen ? " on" : ""}`}
          aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
          aria-expanded={noticesOpen}
          data-tip="Notifications"
          data-tip-pos="below"
          onClick={() => setNoticesOpen(!noticesOpen)}
        >
          <Icon name="bell" size={18} />
          {unread > 0 ? <span className="os-bell-count">{unread > 9 ? "9+" : unread}</span> : null}
        </button>

        <span className="os-clock os-mono" aria-label="Time">
          {clock ? clock.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "--:--"}
        </span>

        <div className="os-identity" ref={menu}>
          <button type="button" className="os-identity-btn" onClick={() => setMenuOpen(!menuOpen)} aria-expanded={menuOpen} aria-haspopup="menu">
            <span className="os-avatar" aria-hidden="true">{initials}</span>
            <span className="os-identity-text">
              <span className="os-identity-name">{name || "…"}</span>
              <span className="os-identity-role">{signedIn ? "Signed in" : "Owner"}</span>
            </span>
            <Icon name="chevronDown" size={14} />
          </button>
          {menuOpen ? (
            <div className="os-menu" role="menu">
              <div className="os-menu-head">
                <strong>{name || "This PC"}</strong>
                <span>{signedIn ? signedIn.email : identity ? `${identity.username} on ${identity.hostname}` : "Local owner access"}</span>
              </div>
              <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); go("settings"); }}>
                <Icon name="sliders" size={16} />Settings
              </button>
              {signedIn ? (
                <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); void account.signOut(); }}>
                  <Icon name="logout" size={16} />Sign out
                </button>
              ) : (
                <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); account.openSignIn(); }}>
                  <Icon name="user" size={16} />Sign in to an account
                </button>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}
