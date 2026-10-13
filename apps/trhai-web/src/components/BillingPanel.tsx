"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Icon } from "../os/ui/Icon";
import {
  activateKey, describeLicense, licenseEvent, openCheckout, planLabel, readLicense, removeKey, type LicenseStatus
} from "../lib/license";
import "./paywall.css";

// Plan and billing, in settings: where things stand, where to buy, and the
// key. The same form the paywall screen uses, so a key can be entered from
// either place.

export function LicenseKeyForm({ onActivated, autoFocus = false }: { onActivated?: (status: LicenseStatus) => void; autoFocus?: boolean }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!key.trim()) {
      setNote({ tone: "bad", text: "Paste the key first." });
      return;
    }
    setBusy(true);
    setNote(null);
    const result = await activateKey(key);
    setBusy(false);
    if (!result.ok) {
      setNote({ tone: "bad", text: result.reason });
      return;
    }
    setKey("");
    setNote({ tone: "ok", text: `Thank you. ${planLabel(result.status.plan)} plan is active on this PC.` });
    onActivated?.(result.status);
  };

  return (
    <form className="paywall-key" onSubmit={submit}>
      <label className="paywall-key-label" htmlFor="license-key">License key</label>
      <div className="paywall-key-row">
        <input
          id="license-key"
          className="paywall-key-input"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          placeholder="TRHAI-…"
          spellCheck={false}
          autoComplete="off"
          autoFocus={autoFocus}
          aria-describedby={note ? "license-key-note" : undefined}
        />
        <button type="submit" className="os-btn os-btn-primary" disabled={busy}>
          <Icon name="check" size={15} />{busy ? "Checking…" : "Activate"}
        </button>
      </div>
      {note ? <p id="license-key-note" className={`paywall-note ${note.tone}`} role={note.tone === "bad" ? "alert" : "status"}>{note.text}</p> : null}
    </form>
  );
}

export function BuyButton({ status, primary = true }: { status: LicenseStatus; primary?: boolean }) {
  if (!status.checkoutUrl) {
    return <p className="os-faint os-small">Where to buy has not been set up on this copy yet. Ask whoever gave you TRH AI for a license key.</p>;
  }
  const label = status.state === "licensed" ? "Buy another seat" : status.state === "license_expired" ? "Renew" : "Buy a license";
  return (
    <button type="button" className={`os-btn ${primary ? "os-btn-primary" : ""}`} onClick={() => openCheckout(status.checkoutUrl as string)}>
      <Icon name="external" size={15} />{label}{status.priceText ? ` · ${status.priceText}` : ""}
    </button>
  );
}

export function BillingPanel() {
  const [status, setStatus] = useState<LicenseStatus | null>(null);
  const [failed, setFailed] = useState(false);

  // Read on open, and again whenever a key is activated or removed anywhere
  // in the app (both announce it).
  useEffect(() => {
    let alive = true;
    const read = () => {
      void readLicense().then((next) => {
        if (!alive) return;
        setStatus(next);
        setFailed(next === null);
      });
    };
    read();
    window.addEventListener(licenseEvent, read);
    return () => { alive = false; window.removeEventListener(licenseEvent, read); };
  }, []);

  const remove = async () => {
    if (!window.confirm("Remove the license key from this PC? You can enter it again at any time.")) return;
    await removeKey();
  };

  return (
    <section className="os-panel billing-panel">
      <header className="os-panel-head"><h3 className="os-panel-title">Plan and billing</h3></header>
      <div className="os-panel-body">
        {failed ? <p className="paywall-note bad">TRH AI&rsquo;s service is not answering, so the plan cannot be read right now.</p> : null}
        {!status && !failed ? <p className="os-faint">Reading…</p> : null}
        {status ? (
          <>
            <div className={`billing-status ${status.locked ? "locked" : ""}`}>
              <span className="os-label">{status.locked ? "Locked" : "Current plan"}</span>
              <strong className="billing-plan">{planLabel(status.plan)}</strong>
              <p>{describeLicense(status)}</p>
            </div>

            <dl className="os-kv">
              <div><dt>Trial began</dt><dd className="os-mono">{new Date(status.trialStartedAt).toLocaleDateString()}</dd></div>
              <div><dt>Trial ends</dt><dd className="os-mono">{new Date(status.trialEndsAt).toLocaleDateString()}</dd></div>
              {status.license ? <div><dt>Licensed to</dt><dd className="os-mono">{status.license.email}</dd></div> : null}
              {status.license ? <div><dt>Key id</dt><dd className="os-mono">{status.license.id}</dd></div> : null}
              {status.license?.seats ? <div><dt>Seats</dt><dd className="os-mono">{status.license.seats}</dd></div> : null}
            </dl>

            <div className="os-view-actions">
              <BuyButton status={status} primary={status.state !== "licensed"} />
              {status.license ? <button type="button" className="os-btn os-btn-danger" onClick={() => void remove()}><Icon name="trash" size={15} />Remove key from this PC</button> : null}
            </div>

            <p className="os-faint os-small">
              Paying happens on a web page, in your browser; TRH AI itself never sees a card. What you get back is a license key.
              Paste it below and this PC is unlocked, with no account and no internet needed afterwards.
            </p>
            <LicenseKeyForm />
          </>
        ) : null}
      </div>
    </section>
  );
}
