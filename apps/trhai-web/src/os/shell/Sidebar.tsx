"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "../ui/Icon";
import { useNav } from "../state/nav";
import { useSystem } from "../state/system";
import { useAssistantState } from "../state/assistant";
import { useHealth } from "../state/health";
import { viewGroups, views, type ViewId } from "../views";
import { coreWords } from "../core/coreWords";

// The navigation: grouped like an operating system's, collapsible to icons,
// and every badge on it is a count or a state something real produced.
//
// On a phone it becomes a bar along the bottom with the four places used most
// and a More button for the rest, which opens every workspace as a sheet.

const phoneBar: ViewId[] = ["home", "chat", "voice", "tasks"];

export function Sidebar() {
  const { view, go, slim, setSlim } = useNav();
  const { online, modelName, tasks, buildVersion } = useSystem();
  const { lastReply, replyFromThisRun, core } = useAssistantState();
  const { failing } = useHealth();
  const [moreOpen, setMoreOpen] = useState(false);
  const sheet = useRef<HTMLDivElement>(null);

  // A reply that landed while you were elsewhere marks Chat until you look.
  const [seenReplyId, setSeenReplyId] = useState<string | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- visiting chat is what marks the reply seen
    if (view === "chat" && lastReply) setSeenReplyId(lastReply.id);
  }, [view, lastReply]);

  // The sheet takes the keyboard when it opens, on the workspace you are in.
  useEffect(() => {
    if (!moreOpen) return;
    const current = sheet.current?.querySelector<HTMLButtonElement>("[aria-current=page]") ?? sheet.current?.querySelector<HTMLButtonElement>("button");
    current?.focus();
  }, [moreOpen]);

  const openTodos = tasks?.filter((task) => !task.done).length ?? 0;
  const badges: Partial<Record<ViewId, { count?: number; tone: "accent" | "warn" | "danger" }>> = {
    ...(replyFromThisRun && lastReply && lastReply.id !== seenReplyId && view !== "chat" && !lastReply.streaming
      ? { chat: { tone: "accent" as const } } : {}),
    ...(openTodos > 0 ? { tasks: { count: openTodos, tone: "accent" as const } } : {}),
    ...(failing > 0 ? { system: { count: failing, tone: "warn" as const } } : {}),
    ...(online === false ? { network: { tone: "danger" as const } } : {})
  };

  const state = coreWords(core);
  // More stands in for the workspaces off the phone's bar: lit when you are in
  // one of them, and marked when one of them has something to show.
  const inMore = !phoneBar.includes(view);
  const moreBadge = views.some((item) => !phoneBar.includes(item.id) && badges[item.id]);

  return (
    <>
      <nav className="os-sidebar" aria-label="TRH AI">
        <div className="os-brand">
          <span className="os-brand-mark" aria-hidden="true">
            <svg viewBox="0 0 32 32"><path d="M16 3 3.5 25h25L16 3Z" /><path d="M16 11.5 9.8 22.5h12.4L16 11.5Z" /><path d="M16 17.5v5" /></svg>
          </span>
          <span className="os-brand-text">
            <span className="os-brand-name">TRH AI</span>
            <span className={`os-brand-status ${online ? "ok" : online === false ? "danger" : ""}`}>
              <span className={`os-dot ${online ? "ok" : online === false ? "danger" : "warn"}`} aria-hidden="true" />
              {online === null ? "Connecting" : online ? "System online" : "System offline"}
            </span>
          </span>
        </div>

        <div className="os-nav-scroll">
          {viewGroups.map((group) => (
            <div key={group} className="os-nav-group" role="group" aria-label={group}>
              <span className="os-nav-group-label">{group}</span>
              {views.filter((item) => item.group === group).map((item) => {
                const badge = badges[item.id];
                const active = view === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`os-nav-item${active ? " active" : ""}${phoneBar.includes(item.id) ? "" : " os-nav-extra"}`}
                    aria-current={active ? "page" : undefined}
                    onClick={() => go(item.id)}
                    {...(slim ? { "data-tip": item.label } : {})}
                  >
                    <Icon path={item.icon} size={19} className="os-nav-icon" />
                    <span className="os-nav-label">{item.label}</span>
                    {badge ? (
                      <span className={`os-nav-badge ${badge.tone}${badge.count === undefined ? " dot" : ""}`} aria-label={badge.count !== undefined ? `${badge.count} open` : "new"}>
                        {badge.count ?? ""}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ))}
          <button
            type="button"
            className={`os-nav-item os-nav-more${inMore ? " active" : ""}`}
            aria-expanded={moreOpen}
            aria-controls="os-more-sheet"
            onClick={() => setMoreOpen(!moreOpen)}
          >
            <Icon name="grid" size={19} className="os-nav-icon" />
            <span className="os-nav-label">More</span>
            {moreBadge ? <span className="os-nav-badge accent dot" aria-label="new" /> : null}
          </button>
        </div>

        <div className="os-sidebar-foot">
          <div className="os-core-chip" {...(slim ? { "data-tip": `${state.word} · ${modelName ?? "no model"}` } : {})}>
            <span className={`os-core-orb ${state.tone}`} aria-hidden="true" />
            <span className="os-core-chip-text">
              <span className="os-core-chip-state">{state.word}</span>
              <span className="os-core-chip-model">{modelName ?? "No local model"} · v{buildVersion}</span>
            </span>
          </div>
          <button
            type="button"
            className="os-slim-toggle"
            onClick={() => setSlim(!slim)}
            aria-label={slim ? "Expand the sidebar" : "Collapse the sidebar"}
            data-tip={slim ? "Expand (Ctrl+B)" : "Collapse (Ctrl+B)"}
          >
            <Icon name={slim ? "chevronRight" : "chevronLeft"} size={16} />
          </button>
        </div>
      </nav>

      {moreOpen ? (
        <div className="os-more-scrim" onClick={() => setMoreOpen(false)}>
          <div
            ref={sheet}
            id="os-more-sheet"
            className="os-more-sheet"
            role="dialog"
            aria-label="All workspaces"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => { if (event.key === "Escape") setMoreOpen(false); }}
          >
            {views.map((item) => {
              const badge = badges[item.id];
              return (
                <button
                  key={item.id}
                  type="button"
                  className={view === item.id ? "active" : ""}
                  aria-current={view === item.id ? "page" : undefined}
                  onClick={() => { setMoreOpen(false); go(item.id); }}
                >
                  <Icon path={item.icon} size={20} />
                  <span>{item.label}</span>
                  {badge ? <span className={`os-nav-badge ${badge.tone}${badge.count === undefined ? " dot" : ""}`}>{badge.count ?? ""}</span> : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </>
  );
}
