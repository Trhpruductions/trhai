"use client";

import { useEffect } from "react";
import { Icon, type IconName } from "../ui/Icon";
import { useNotices, useNotify, type Notice, type NoticeLevel } from "../state/notify";
import { useNav } from "../state/nav";

const levelIcon: Record<NoticeLevel, IconName> = { info: "info", success: "ok", warning: "alert", error: "alert" };

function timeOf(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Toasts: the newest few, top right, each gone after a while unless it must stay. */
export function Toasts() {
  const { toasts } = useNotices();
  const { dismissToast } = useNotify();
  if (toasts.length === 0) return null;
  return (
    <div className="os-toasts" role="region" aria-label="Notifications" aria-live="polite">
      {toasts.map((notice) => (
        <div key={notice.id} className={`os-toast ${notice.level}`} role={notice.level === "error" ? "alert" : "status"}>
          <Icon name={levelIcon[notice.level]} size={18} className="os-toast-icon" />
          <div className="os-toast-text">
            <strong>{notice.title}</strong>
            {notice.body ? <p>{notice.body}</p> : null}
            {notice.action ? (
              <button type="button" className="os-btn os-btn-sm" onClick={() => { notice.action?.run(); dismissToast(notice.id); }}>
                {notice.action.label}
              </button>
            ) : null}
          </div>
          <button type="button" className="os-toast-close" aria-label="Dismiss" onClick={() => dismissToast(notice.id)}>
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Everything that was announced, newest first, behind the bell. */
export function NotificationCenter() {
  const { notices } = useNotices();
  const { markAllRead, clearAll } = useNotify();
  const { noticesOpen, setNoticesOpen } = useNav();

  // Opening the history is reading it.
  useEffect(() => {
    if (noticesOpen) markAllRead();
  }, [noticesOpen, notices.length, markAllRead]);

  if (!noticesOpen) return null;
  return (
    <aside className="os-notice-center" aria-label="Notification history">
      <header>
        <h3>Notifications</h3>
        <div className="os-view-actions">
          <button type="button" className="os-btn os-btn-sm os-btn-ghost" onClick={clearAll} disabled={notices.length === 0}>Clear</button>
          <button type="button" className="os-btn os-btn-sm os-btn-ghost os-btn-icon" aria-label="Close" onClick={() => setNoticesOpen(false)}>
            <Icon name="close" size={14} />
          </button>
        </div>
      </header>
      {notices.length === 0 ? (
        <div className="os-empty">
          <strong>Nothing yet</strong>
          <p>Reminders, finished replies and changes in TRH AI&apos;s services appear here as they happen.</p>
        </div>
      ) : (
        <ul>
          {notices.map((notice: Notice) => (
            <li key={notice.id} className={notice.level}>
              <Icon name={levelIcon[notice.level]} size={16} className="os-toast-icon" />
              <div>
                <div className="os-notice-meta">
                  <span className="os-label">{notice.source ?? "TRH AI"}</span>
                  <span className="os-mono os-faint">{timeOf(notice.at)}</span>
                </div>
                <strong>{notice.title}</strong>
                {notice.body ? <p>{notice.body}</p> : null}
                {notice.action ? (
                  <button type="button" className="os-btn os-btn-sm" onClick={() => { notice.action?.run(); setNoticesOpen(false); }}>{notice.action.label}</button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
