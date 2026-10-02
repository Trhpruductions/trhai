"use client";

import { useEffect, useState, type FormEvent } from "react";
import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from "../lib/api";
import { describeTexting, needsServer, phoneChoices, providerHint, type EmailAccountView, type MessagingStatus, type PhoneKind } from "../lib/messaging";
import "./personality.css";

// Texts and email, in settings.
//
// Texts go out from the user's own phone through Phone Link, so this says
// whether Phone Link was found - and asks which phone is linked, because with
// an iPhone a text cannot arrive in Phone Link already written. Email
// sends from the user's own account once it is added - an address and an app
// password, with the server filled in for the providers the API knows. The
// password goes to the local API, which keeps it encrypted, and is never sent
// back: the form only ever learns that one is saved.

export function MessagingPanel() {
  const [status, setStatus] = useState<MessagingStatus | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [editing, setEditing] = useState(false);
  const [address, setAddress] = useState("");
  const [password, setPassword] = useState("");
  const [fromName, setFromName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void apiGet<MessagingStatus>("/v1/messaging").then((result) => {
      if (cancelled) return;
      if (result.ok) setStatus(result.data);
      else setUnreachable(true);
    });
    return () => { cancelled = true; };
  }, []);

  const email: EmailAccountView = status?.email ?? { configured: false };
  const phone = status?.texts.phone ?? null;
  const texting = describeTexting(status?.texts.phoneLink ?? "missing", phone);

  const choosePhone = async (next: PhoneKind) => {
    setBusy(true);
    setNote(null);
    const result = await apiPatch<{ phone: PhoneKind | null }>("/v1/preferences", { phone: next });
    setBusy(false);
    if (!result.ok) {
      setNote({ tone: "bad", text: result.reason });
      return;
    }
    setStatus((prior) => (prior ? { ...prior, texts: { ...prior.texts, phone: result.data.phone } } : prior));
  };
  const providers = status?.providers ?? [];
  const hint = providerHint(address, providers);
  const askServer = needsServer(address, providers);

  const startEditing = () => {
    setAddress(email.configured ? email.address : "");
    setFromName(email.configured ? email.fromName ?? "" : "");
    setHost(email.configured && !email.provider ? email.host : "");
    setPort(email.configured && !email.provider ? String(email.port) : "");
    setPassword("");
    setNote(null);
    setEditing(true);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setNote(null);
    const result = await apiPut<{ email: EmailAccountView }>("/v1/messaging/email", {
      address,
      ...(password ? { password } : {}),
      ...(fromName.trim() ? { fromName } : {}),
      ...(askServer && host.trim() ? { host } : {}),
      ...(askServer && port.trim() ? { port } : {})
    });
    setBusy(false);
    if (!result.ok) {
      setNote({ tone: "bad", text: result.reason });
      return;
    }
    setPassword("");
    setStatus((prior) => (prior ? { ...prior, email: result.data.email } : prior));
    setEditing(false);
    setNote({ tone: "ok", text: "Saved. Send a test email to check it works." });
  };

  const sendTest = async () => {
    setBusy(true);
    setNote(null);
    const result = await apiPost<{ ok: boolean; message: string }>("/v1/messaging/email/test", {});
    setBusy(false);
    setNote(result.ok
      ? { tone: result.data.ok ? "ok" : "bad", text: result.data.message }
      : { tone: "bad", text: result.reason });
  };

  const remove = async () => {
    setBusy(true);
    const result = await apiDelete("/v1/messaging/email");
    setBusy(false);
    if (!result.ok) {
      setNote({ tone: "bad", text: result.reason });
      return;
    }
    setStatus((prior) => (prior ? { ...prior, email: { configured: false } } : prior));
    setNote({ tone: "ok", text: "Removed. Emails will open in your mail app instead." });
  };

  return (
    <section className="hud-panel persona-pick account-panel messaging-panel">
      <span className="hud-label">Texts and email</span>

      {unreachable ? (
        <p className="persona-summary">The local service did not answer, so this could not be checked.</p>
      ) : !status ? (
        <p className="persona-summary">Checking…</p>
      ) : (
        <>
          <div className="messaging-row">
            <span className={`messaging-dot ${texting.ready ? "ok" : "off"}`} aria-hidden="true" />
            <p className="persona-summary">{texting.text}</p>
          </div>
          {status.texts.phoneLink === "linked" ? (
            <div className="account-actions" role="group" aria-label="The phone linked in Phone Link">
              {phoneChoices.map((choice) => (
                <button key={choice.id} type="button" className={`account-button${phone === choice.id ? " primary" : ""}`}
                  aria-pressed={phone === choice.id} disabled={busy} onClick={() => void choosePhone(choice.id)}>
                  {choice.label}
                </button>
              ))}
            </div>
          ) : null}

          {email.configured && !editing ? (
            <>
              <div className="messaging-row">
                <span className="messaging-dot ok" aria-hidden="true" />
                <p className="persona-summary">
                  Email sends from <strong>{email.address}</strong>{email.provider ? ` (${email.provider})` : ` via ${email.host}`}.
                </p>
              </div>
              <div className="account-actions">
                <button type="button" className="account-button primary" disabled={busy} onClick={() => void sendTest()}>
                  {busy ? "Working…" : "Send a test email"}
                </button>
                <button type="button" className="account-button" disabled={busy} onClick={startEditing}>Change</button>
                <button type="button" className="account-button danger" disabled={busy} onClick={() => void remove()}>Remove</button>
              </div>
            </>
          ) : editing ? (
            <form className="account-form" onSubmit={(event) => void save(event)}>
              <label className="account-field">
                <span>Your email address</span>
                <input type="email" value={address} autoComplete="off" spellCheck={false} disabled={busy}
                  placeholder="you@gmail.com" onChange={(event) => setAddress(event.target.value)} />
              </label>
              <label className="account-field">
                <span>App password{email.configured && email.address.toLowerCase() === address.trim().toLowerCase() ? " (leave empty to keep the saved one)" : ""}</span>
                <input type="password" value={password} autoComplete="off" disabled={busy}
                  onChange={(event) => setPassword(event.target.value)} />
              </label>
              {hint ? <p className="messaging-hint">{hint.name}: {hint.passwordHelp}</p> : null}
              {askServer ? (
                <div className="messaging-server">
                  <label className="account-field">
                    <span>SMTP server</span>
                    <input type="text" value={host} autoComplete="off" spellCheck={false} disabled={busy}
                      placeholder="smtp.example.com" onChange={(event) => setHost(event.target.value)} />
                  </label>
                  <label className="account-field">
                    <span>Port</span>
                    <input type="text" inputMode="numeric" value={port} autoComplete="off" disabled={busy}
                      placeholder="587" onChange={(event) => setPort(event.target.value)} />
                  </label>
                </div>
              ) : null}
              <label className="account-field">
                <span>Name on your emails (optional)</span>
                <input type="text" value={fromName} autoComplete="off" disabled={busy} maxLength={80}
                  placeholder="Your name" onChange={(event) => setFromName(event.target.value)} />
              </label>
              <div className="account-actions">
                <button type="submit" className="account-button primary" disabled={busy || !address.trim()}>
                  {busy ? "Saving…" : "Save"}
                </button>
                <button type="button" className="account-button" disabled={busy} onClick={() => { setEditing(false); setNote(null); }}>
                  Cancel
                </button>
              </div>
              <p className="messaging-fine">Kept encrypted on this PC and only ever sent to your own mail server.</p>
            </form>
          ) : (
            <>
              <div className="messaging-row">
                <span className="messaging-dot off" aria-hidden="true" />
                <p className="persona-summary">
                  Emails open in your mail app, ready to send. Add your email account and TRH AI can send them itself.
                </p>
              </div>
              <div className="account-actions">
                <button type="button" className="account-button primary" onClick={startEditing}>Add your email account</button>
              </div>
            </>
          )}
          <p className="messaging-fine">Every message is shown to you first and only goes when you say yes.</p>
        </>
      )}

      {note ? <p className={`account-note ${note.tone}`} role={note.tone === "bad" ? "alert" : "status"}>{note.text}</p> : null}
    </section>
  );
}
