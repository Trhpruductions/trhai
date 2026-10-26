"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "../os/ui/Icon";
import { useNotify } from "../os/state/notify";
import { readSetup, requiredNotice, startRequired, stopInstall, type SetupStatus } from "../lib/setup";
import "./setup.css";

// What an update brings that has to be installed too - new models, voices and
// tools - is downloaded by TRH AI itself, a little after it opens. This is
// where that shows: a card over every screen with how far it has got, a Stop,
// and, when it was stopped or did not finish (no room on the drive, no
// connection), why, with a button to carry on. It says so once when it is
// done, and then it is gone. The words are in lib/setup.ts (requiredNotice).

export function RequiredSetupBanner() {
  const { notify } = useNotify();
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const sawRunning = useRef(false);
  const told = useRef(false);

  useEffect(() => {
    let alive = true;
    let timer = 0;
    const look = async () => {
      const next = await readSetup();
      if (!alive) return;
      if (next) setStatus(next);
      const required = next?.required;
      // Often while it downloads, now and then while it waits, and rarely when there is nothing to do.
      const again = required?.state === "running" ? 1500 : required?.applies && required.state !== "done" ? 5000 : 30000;
      timer = window.setTimeout(() => void look(), again);
    };
    void look();
    return () => { alive = false; window.clearTimeout(timer); };
  }, []);

  // Said once, and only of an install this window watched happen: opening the app to one that was
  // finished long ago is not news.
  useEffect(() => {
    const state = status?.required?.state;
    if (state === "running") sawRunning.current = true;
    if (state === "done" && sawRunning.current && !told.current) {
      told.current = true;
      notify({ level: "success", source: "Setup", title: "What this update brings is installed", body: "The new models, voices and tools are ready to use." });
    }
  }, [status, notify]);

  const notice = requiredNotice(status);
  if (!notice) return null;

  const act = async () => {
    if (!notice.action) return;
    setBusy(true);
    setRefused(null);
    const result = notice.action.kind === "stop" ? await stopInstall() : await startRequired();
    setBusy(false);
    if (result.ok) setStatus(result.status);
    else setRefused(result.reason);
  };


  return (
    <aside className={`required-bar ${notice.tone}`} role="status" aria-live="polite" aria-label="Installing what this update brings">
      <span className="required-bar-icon" aria-hidden="true"><Icon name={notice.tone === "attention" ? "alert" : "down"} size={18} /></span>
      <div className="required-bar-text">
        <strong>{notice.title}</strong>
        <span>{notice.text}</span>
        {refused ? <span className="required-bar-refused" role="alert">{refused}</span> : null}
      </div>
      {notice.percent !== null ? (
        <div className="required-bar-progress">
          <div className="setup-bar" role="progressbar" aria-label="Install progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={notice.percent}>
            <span style={{ width: `${notice.percent}%` }} />
          </div>
          <span className="os-mono">{notice.percent}%</span>
        </div>
      ) : null}
      {notice.action ? (
        <button type="button" className={`os-btn os-btn-sm${notice.action.kind === "start" ? " os-btn-primary" : ""}`} disabled={busy} onClick={() => void act()}>
          <Icon name={notice.action.kind === "stop" ? "stop" : "refresh"} size={14} />{notice.action.label}
        </button>
      ) : null}
    </aside>
  );
}
