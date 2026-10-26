"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../os/ui/Icon";
import { desktopUpdater, type DesktopUpdateStatus } from "../lib/desktopUpdates";
import { countdownText, requiredUpdateStep, restartCountdownSeconds } from "../lib/requiredUpdate";
import { clearInstallTried, markInstallTried, readInstallTried, readUpdates, recheckUpdatesEvent, requiredUpdate, type UpdateCheck } from "../lib/updates";
import "./paywall.css";
import "./setup.css";

// A release marked required is not offered, it is installed. On the installed
// app this downloads it as soon as the release is seen, shows a window over
// everything with how far it has got, and restarts into it two minutes after
// it is ready (or at once, from the button). It cannot be closed - but if the
// download fails it says why and lets the person carry on (the update is still
// installed when the app quits, as any downloaded one is).
//
// Elsewhere (a browser, the portable build, a copy run from source) there is
// nothing to install over, and the update card is shown as usual, without
// "Later". What it does at each point is in lib/requiredUpdate.ts.
//
// The restart comes by itself once per version. It is noted the moment it is
// asked for; a copy that comes back still on the old version is not restarted
// again, it is told the install did not take and asked.

const recheckMs = 6 * 60 * 60 * 1000;

/** The version this copy last restarted to install, or null: nothing noted, or a browser that will not say. */
function installTriedBefore(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return readInstallTried(window.localStorage);
  } catch {
    return null;
  }
}

export function RequiredUpdate() {
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [status, setStatus] = useState<DesktopUpdateStatus | null>(null);
  const [tried, setTried] = useState<string | null>(installTriedBefore);
  // When the update became ready, and the clock the countdown reads (ticking only while one runs).
  const [readyAt, setReadyAt] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const [notNow, setNotNow] = useState(false);
  // What the updater was last asked, so that each step is asked for once however often the window redraws.
  const asked = useRef("");

  /** Every report from the updater comes through here, so the moment it became ready is noted once. */
  const receive = (next: DesktopUpdateStatus) => {
    setStatus(next);
    setReadyAt((at) => (next.state === "downloaded" ? at ?? Date.now() : null));
  };

  // The release page: now, every few hours, and whenever Settings has just looked at it again.
  useEffect(() => {
    let alive = true;
    const run = () => { void readUpdates().then((next) => { if (alive) setCheck(next); }); };
    run();
    const timer = window.setInterval(run, recheckMs);
    window.addEventListener(recheckUpdatesEvent, run);
    return () => { alive = false; window.clearInterval(timer); window.removeEventListener(recheckUpdatesEvent, run); };
  }, []);

  // The app's own updater, when this is the installed app. Looked for again when the page is read, so one that appears late is found.
  useEffect(() => {
    const updater = desktopUpdater();
    if (!updater) return;
    let alive = true;
    void updater.status().then((next) => { if (alive) receive(next); }).catch(() => undefined);
    const stop = updater.onStatus((next) => { if (alive) receive(next); });
    return () => { alive = false; stop(); };
  }, [check]);

  const release = requiredUpdate(check);
  const step = notNow ? { kind: "none" as const } : requiredUpdateStep(release, status, tried);
  const stepKind = step.kind;
  const statusState = status?.state;
  const version = release?.version;

  // Each step is asked of the updater once: look, then download.
  useEffect(() => {
    const updater = desktopUpdater();
    if (!updater || !version) return;
    const key = `${version}:${stepKind}`;
    if (stepKind === "checking" && statusState === "idle" && asked.current !== key) {
      asked.current = key;
      void updater.check().then(receive).catch(() => undefined);
    } else if (stepKind === "download" && asked.current !== key) {
      asked.current = key;
      void updater.download().then(receive).catch(() => undefined);
    }
  }, [stepKind, statusState, version]);

  // Once it is ready, the restart comes by itself after the countdown.
  const ready = step.kind === "restart" && readyAt !== null;
  useEffect(() => {
    if (!ready) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [ready]);
  const elapsed = readyAt !== null && now > readyAt ? Math.floor((now - readyAt) / 1000) : 0;
  const secondsLeft = Math.max(0, restartCountdownSeconds - elapsed);

  /** Asks the app to restart into the update - after noting that it has, so that a restart which does not take is not repeated by itself. */
  const restartInto = useCallback((releaseVersion: string) => {
    try { markInstallTried(window.localStorage, releaseVersion); } catch { /* the restart goes ahead without the note */ }
    void desktopUpdater()?.install();
  }, []);
  useEffect(() => {
    if (ready && secondsLeft === 0 && version) restartInto(version);
  }, [ready, secondsLeft, version, restartInto]);

  if (step.kind === "none" || !release) return null;

  const retry = () => {
    asked.current = "";
    void desktopUpdater()?.download().then(receive).catch(() => undefined);
  };
  const restartNow = () => restartInto(release.version);
  // One more automatic restart, from the person's own word: the note is cleared, and the window carries on as it would have.
  const tryInstallAgain = () => {
    try { clearInstallTried(window.localStorage); } catch { /* nothing to clear */ }
    setTried(null);
  };

  return (
    <div className="paywall-scrim required-update-scrim">
      <section className="paywall" role="alertdialog" aria-modal="true" aria-labelledby="required-update-title" aria-describedby="required-update-text">
        <span className="os-label">Required update</span>
        <h2 id="required-update-title">{step.kind === "retry" ? `TRH AI v${release.version} did not finish installing` : `TRH AI v${release.version} is installing`}</h2>
        <p id="required-update-text">
          {step.kind === "restart"
            ? `v${step.version} is ready. TRH AI restarts to finish updating in ${countdownText(secondsLeft)}; finish what you are doing first.`
            : step.kind === "retry"
              ? `TRH AI restarted to install v${step.version}, but this copy is still on v${check?.currentVersion}, so it will not restart by itself again. Try again, or install it from the update card whenever you like. Nothing of yours was touched.`
              : step.kind === "failed"
                ? step.message
                : step.kind === "downloading"
                  ? `Downloading v${release.version}, which every copy of TRH AI needs. Nothing of yours is touched.`
                  : `TRH AI is getting v${release.version}, which every copy of it needs.`}
        </p>
        {step.kind === "downloading" ? (
          <div className="required-update-progress">
            <div className="setup-bar" role="progressbar" aria-label="Download progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={step.percent}>
              <span style={{ width: `${step.percent}%` }} />
            </div>
            <span className="os-mono">{step.percent}%</span>
          </div>
        ) : null}
        <div className="os-view-actions">
          {step.kind === "restart" ? (
            <button type="button" className="os-btn os-btn-primary" onClick={restartNow} autoFocus><Icon name="refresh" size={15} />Restart now</button>
          ) : null}
          {step.kind === "retry" ? (
            <>
              <button type="button" className="os-btn os-btn-primary" onClick={tryInstallAgain} autoFocus><Icon name="refresh" size={15} />Try again</button>
              <button type="button" className="os-btn os-btn-ghost" onClick={() => setNotNow(true)}>Not now</button>
            </>
          ) : null}
          {step.kind === "failed" ? (
            <>
              <button type="button" className="os-btn os-btn-primary" onClick={retry} autoFocus><Icon name="refresh" size={15} />Try again</button>
              <button type="button" className="os-btn os-btn-ghost" onClick={() => setNotNow(true)}>Not now</button>
            </>
          ) : null}
        </div>
      </section>
    </div>
  );
}
