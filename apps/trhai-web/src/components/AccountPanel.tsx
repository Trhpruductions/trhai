"use client";

import { useState, type FormEvent } from "react";
import { apiBaseUrl } from "../lib/api";
import { browserStores, minPasswordLength, readStoredAuth, writeStoredAuth, type SignedInAccount } from "../lib/auth";
import "./personality.css";

// The account, in settings: who is signed in, a new password, and signing out.
// Without an account, the way to make or use one.
//
// A password change goes through the API's own route, which signs out every
// other session and hands back a replacement token - kept here, or the very
// next request would be refused and this window signed out too.

export function AccountPanel({ account, onSignOut, onSignIn }: {
  account: SignedInAccount | null;
  onSignOut: () => void;
  onSignIn: () => void;
}) {
  const [changing, setChanging] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  if (!account) {
    return (
      <section className="hud-panel persona-pick account-panel">
        <span className="hud-label">Account</span>
        <p className="persona-summary">
          Not signed in. Everything works; your memory, documents and conversations stay in this browser.
          Sign in and they follow you to any browser on this machine.
        </p>
        <button type="button" className="account-button primary" onClick={onSignIn}>Sign in or create an account</button>
      </section>
    );
  }

  const changePassword = async (event: FormEvent) => {
    event.preventDefault();
    if (next.length < minPasswordLength) {
      setNote({ tone: "bad", text: `The new password needs at least ${minPasswordLength} characters.` });
      return;
    }
    const { local, session } = browserStores();
    const stored = readStoredAuth(local, session);
    if (!stored) {
      setNote({ tone: "bad", text: "Your session has ended. Sign in again to change the password." });
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const response = await fetch(`${apiBaseUrl}/v1/auth/password`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${stored.token}` },
        body: JSON.stringify({ currentPassword: current, newPassword: next })
      });
      const payload = await response.json().catch(() => null) as
        { data?: { token?: string; account?: SignedInAccount; expiresAt?: string }; message?: string } | null;
      if (!response.ok || !payload?.data?.token || !payload.data.account || !payload.data.expiresAt) {
        setNote({ tone: "bad", text: payload?.message ? `${payload.message.replace(/\.?$/, ".")}` : "The password was not changed." });
        return;
      }
      writeStoredAuth(local, session, {
        token: payload.data.token, account: payload.data.account, expiresAt: payload.data.expiresAt, remember: stored.remember
      });
      setCurrent("");
      setNext("");
      setChanging(false);
      setNote({ tone: "ok", text: "Password changed. Every other session was signed out." });
    } catch {
      setNote({ tone: "bad", text: "The local service did not answer, so nothing was changed." });
    } finally {
      setBusy(false);
    }
  };

  const since = new Date(account.createdAt);

  return (
    <section className="hud-panel persona-pick account-panel">
      <span className="hud-label">Account</span>
      <div className="account-who">
        <span className="account-avatar" aria-hidden="true">{account.displayName.charAt(0).toUpperCase() || "?"}</span>
        <div>
          <p className="account-name">{account.displayName}</p>
          <p className="account-email">{account.email}</p>
        </div>
      </div>
      <p className="persona-summary">
        Signed in{Number.isFinite(since.getTime()) ? ` · member since ${since.toLocaleDateString(undefined, { month: "long", year: "numeric" })}` : ""}.
        Your memory, documents and conversations follow this account.
      </p>

      {changing ? (
        <form className="account-form" onSubmit={(event) => void changePassword(event)}>
          <label className="account-field">
            <span>Current password</span>
            <input type="password" value={current} autoComplete="current-password" disabled={busy}
              onChange={(event) => setCurrent(event.target.value)} />
          </label>
          <label className="account-field">
            <span>New password</span>
            <input type="password" value={next} autoComplete="new-password" disabled={busy} placeholder={`At least ${minPasswordLength} characters`}
              onChange={(event) => setNext(event.target.value)} />
          </label>
          <div className="account-actions">
            <button type="submit" className="account-button primary" disabled={busy || !current || !next}>
              {busy ? "Changing…" : "Change password"}
            </button>
            <button type="button" className="account-button" disabled={busy} onClick={() => { setChanging(false); setNote(null); }}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="account-actions">
          <button type="button" className="account-button" onClick={() => { setChanging(true); setNote(null); }}>Change password</button>
          <button type="button" className="account-button danger" onClick={onSignOut}>Sign out</button>
        </div>
      )}

      {note ? <p className={`account-note ${note.tone}`} role={note.tone === "bad" ? "alert" : "status"}>{note.text}</p> : null}
    </section>
  );
}
