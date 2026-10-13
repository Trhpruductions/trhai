"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../os/ui/Icon";
import {
  dismissUpdate, markVersionSeen, noticeToShow, openReleaseLink, readDismissedUpdate, readSeenVersion, readUpdates,
  showWhatsNewEvent, type Notice, type ReleaseNote, type UpdateCheck
} from "../lib/updates";
import "./paywall.css";

// The notices everyone using the app sees: "What's new" once per version, and
// "Update available" once per newer release. Mounted in the app shell, so it
// is there on every screen. The rules are in lib/updates.ts.

const recheckMs = 6 * 60 * 60 * 1000;

function store(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function WhatsNewDialog({ note, onClose }: { note: ReleaseNote; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="paywall-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="paywall whatsnew" role="dialog" aria-modal="true" aria-labelledby="whatsnew-title">
        <span className="os-label">What&rsquo;s new in v{note.version}</span>
        <h2 id="whatsnew-title">{note.title}</h2>
        <ul className="whatsnew-list">
          {note.notes.map((line) => <li key={line}><Icon name="bolt" size={15} />{line}</li>)}
        </ul>
        <div className="os-view-actions">
          <button type="button" className="os-btn os-btn-primary" onClick={onClose} autoFocus><Icon name="check" size={15} />Got it</button>
        </div>
      </section>
    </div>
  );
}

export function UpdateNotices() {
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  // The latest check, for the "show it again" listener, without making the
  // effect below depend on it (it would fetch again every time it stored one).
  const latestCheck = useRef<UpdateCheck | null>(null);

  const decide = useCallback((next: UpdateCheck | null) => {
    const local = store();
    latestCheck.current = next;
    setCheck(next);
    setNotice(noticeToShow(next, local ? readSeenVersion(local) : null, local ? readDismissedUpdate(local) : null));
  }, []);

  useEffect(() => {
    let alive = true;
    const run = () => { void readUpdates().then((next) => { if (alive) decide(next); }); };
    run();
    // A window left open for days still hears about a release.
    const timer = window.setInterval(run, recheckMs);
    // Settings can ask for the notes again.
    const reopen = () => {
      const known = latestCheck.current;
      const current = known?.notes.find((note) => note.version === known.currentVersion);
      if (current) setNotice({ kind: "whatsnew", note: current });
    };
    window.addEventListener(showWhatsNewEvent, reopen);
    return () => { alive = false; window.clearInterval(timer); window.removeEventListener(showWhatsNewEvent, reopen); };
  }, [decide]);

  const closeWhatsNew = useCallback(() => {
    const local = store();
    if (local && check) markVersionSeen(local, check.currentVersion);
    // An update may be waiting behind it.
    setNotice(noticeToShow(check, check?.currentVersion ?? null, local ? readDismissedUpdate(local) : null));
  }, [check]);

  if (!notice) return null;
  if (notice.kind === "whatsnew") return <WhatsNewDialog note={notice.note} onClose={closeWhatsNew} />;

  const later = () => {
    const local = store();
    if (local) dismissUpdate(local, notice.latest.version);
    setNotice(null);
  };
  return (
    <aside className="update-card" role="status" aria-live="polite" aria-label="Update available">
      <span className="update-card-icon" aria-hidden="true"><Icon name="down" size={18} /></span>
      <div className="update-card-text">
        <strong>TRH AI v{notice.latest.version} is out</strong>
        <span>You have v{check?.currentVersion}. Install it over this one; your data stays where it is.</span>
        <div className="os-view-actions">
          <button type="button" className="os-btn os-btn-primary os-btn-sm" onClick={() => openReleaseLink(notice.latest.downloadUrl ?? notice.latest.url)}>
            <Icon name="external" size={14} />{notice.latest.downloadUrl ? "Download" : "See the release"}
          </button>
          <button type="button" className="os-btn os-btn-ghost os-btn-sm" onClick={later}>Later</button>
        </div>
      </div>
      <button type="button" className="os-btn os-btn-icon update-card-close" onClick={later} aria-label="Close"><Icon name="close" size={14} /></button>
    </aside>
  );
}
