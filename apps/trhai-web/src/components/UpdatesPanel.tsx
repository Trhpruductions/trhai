"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "../os/ui/Icon";
import { readUpdates, showWhatsNewEvent, type UpdateCheck } from "../lib/updates";
import { DesktopUpdateButton } from "./DesktopUpdateButton";
import "./paywall.css";

// Updates, in settings: the version running, whether a newer one is out, a
// "Check now", and the release notes of this version and the ones before it.

export function UpdatesPanel() {
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async (refresh: boolean) => {
    setBusy(true);
    const next = await readUpdates(refresh);
    setBusy(false);
    setFailed(next === null);
    if (next) setCheck(next);
  }, []);

  useEffect(() => {
    let alive = true;
    void readUpdates(false).then((next) => {
      if (!alive) return;
      setFailed(next === null);
      if (next) setCheck(next);
    });
    return () => { alive = false; };
  }, []);

  return (
    <section className="os-panel updates-panel">
      <header className="os-panel-head">
        <h3 className="os-panel-title">Updates</h3>
        <button type="button" className="os-btn os-btn-sm" onClick={() => void load(true)} disabled={busy || check?.checkDisabled}>
          <Icon name="refresh" size={14} />{busy ? "Checking…" : "Check now"}
        </button>
      </header>
      <div className="os-panel-body">
        {failed ? <p className="paywall-note bad">TRH AI&rsquo;s service is not answering, so updates cannot be checked right now.</p> : null}
        {!check && !failed ? <p className="os-faint">Reading…</p> : null}
        {check ? (
          <>
            <div className={`billing-status ${check.updateAvailable ? "fresh" : ""}`}>
              <span className="os-label">{check.updateAvailable ? "Update available" : "This version"}</span>
              <strong className="billing-plan">v{check.updateAvailable && check.latest ? check.latest.version : check.currentVersion}</strong>
              <p>
                {check.updateAvailable && check.latest
                  ? `You have v${check.currentVersion}. Install the new one over it; your data stays where it is.`
                  : check.checkError ?? "You have the newest version."}
              </p>
              {check.updateAvailable && check.latest ? (
                <div className="os-view-actions">
                  <DesktopUpdateButton version={check.latest.version} downloadUrl={check.latest.downloadUrl} releaseUrl={check.latest.url} />
                </div>
              ) : null}
            </div>

            {check.updateAvailable && check.latest?.notes ? (
              <details className="updates-remote">
                <summary>What v{check.latest.version} changes</summary>
                <pre>{check.latest.notes}</pre>
              </details>
            ) : null}

            <p className="os-faint os-small">
              {check.checkedAt ? `Last checked ${new Date(check.checkedAt).toLocaleString()}. ` : ""}
              TRH AI asks its public release page for the newest version every few hours; nothing about you is sent.
            </p>

            <h4 className="updates-heading">Release notes</h4>
            {check.notes.length === 0 ? <p className="os-faint">No notes for this version.</p> : null}
            {check.notes.map((note) => (
              <article key={note.version} className="updates-note">
                <header>
                  <strong>v{note.version}</strong> <span className="os-faint os-small">{new Date(`${note.date}T12:00:00`).toLocaleDateString()}</span>
                  <span className="updates-note-title">{note.title}</span>
                </header>
                <ul>{note.notes.map((line) => <li key={line}>{line}</li>)}</ul>
              </article>
            ))}
            {check.notes.some((note) => note.version === check.currentVersion) ? (
              <button type="button" className="os-btn os-btn-ghost os-btn-sm" onClick={() => window.dispatchEvent(new Event(showWhatsNewEvent))}>
                <Icon name="info" size={14} />Show the What&rsquo;s new notice again
              </button>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}
