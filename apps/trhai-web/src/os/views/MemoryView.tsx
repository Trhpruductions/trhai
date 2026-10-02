"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { DocumentsPanel } from "../../components/DocumentsPanel";
import { MemoryStatus } from "../../components/CommandPanels";
import { apiDelete, apiGet, apiPatch, apiPost, sessionId } from "../../lib/api";
import { whenUsed } from "../../lib/conversationGroups";
import {
  auditDetail, auditVerb, countByKind, filterMemories, howLearned, kindLabel, memoryKinds,
  type MemoryAuditRow, type MemoryKind, type MemoryRow
} from "../../lib/memoryLabels";
import { Icon } from "../ui/Icon";
import { ViewFrame } from "../ui/ViewFrame";
import { useNotify } from "../state/notify";
import { useSystem } from "../state/system";
import "./views.css";

// What TRH AI remembers about you, all of it, and what you can do about it:
// search it, sort it by kind, pin what matters, rename what it got slightly
// wrong, forget what it should not keep - and tell it something on purpose.
// The documents it can read sit below. Nothing here is a copy: every change
// is made by the same store the assistant reads from.

const kindTone: Record<MemoryKind, string> = { fact: "accent", preference: "ok", decision: "violet", constraint: "warn" };

function MemoryItem({ memory, now, onChanged }: { memory: MemoryRow; now: Date; onChanged: () => void }) {
  const { notify } = useNotify();
  const [renaming, setRenaming] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const change = async (patch: { pinned?: boolean; title?: string }) => {
    const result = await apiPatch(`/v1/assist/memory/${encodeURIComponent(memory.id)}`, { sessionId: sessionId(), ...patch });
    if (!result.ok) notify({ level: "error", title: "That change did not save", body: result.reason, source: "MEMORY" });
    onChanged();
  };

  const forget = async () => {
    setConfirming(false);
    const result = await apiDelete(`/v1/assist/memory/${encodeURIComponent(memory.id)}?sessionId=${encodeURIComponent(sessionId())}`);
    if (result.ok) notify({ level: "success", title: "Forgotten", body: memory.title, source: "MEMORY" });
    else notify({ level: "error", title: "Could not forget that", body: result.reason, source: "MEMORY" });
    onChanged();
  };

  const rename = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const title = new FormData(event.currentTarget).get("title");
    setRenaming(false);
    if (typeof title === "string" && title.trim() && title.trim() !== memory.title) void change({ title: title.trim() });
  };

  return (
    <li className={`os-mem${memory.pinned ? " pinned" : ""}`}>
      <div className="os-mem-head">
        <span className={`os-chip ${kindTone[memory.kind] ?? ""}`}>{kindLabel(memory.kind)}</span>
        {renaming ? (
          <form className="os-mem-rename" onSubmit={rename}>
            <input name="title" className="os-input" defaultValue={memory.title} maxLength={120} aria-label="Memory name" autoFocus
              onFocus={(event) => event.currentTarget.select()}
              onKeyDown={(event) => { if (event.key === "Escape") setRenaming(false); }}
              onBlur={(event) => event.currentTarget.form?.requestSubmit()} />
          </form>
        ) : (
          <strong className="os-mem-title">
            {memory.pinned ? <Icon name="pin" size={13} className="os-convo-pin" /> : null}
            {memory.title}
          </strong>
        )}
        <div className="os-mem-actions">
          <button type="button" className="os-btn os-btn-ghost os-btn-icon os-btn-sm" aria-pressed={memory.pinned}
            aria-label={memory.pinned ? `Unpin ${memory.title}` : `Pin ${memory.title}`} data-tip={memory.pinned ? "Unpin" : "Pin - always kept, used first"} data-tip-pos="below"
            onClick={() => void change({ pinned: !memory.pinned })}>
            <Icon name="pin" size={14} />
          </button>
          <button type="button" className="os-btn os-btn-ghost os-btn-icon os-btn-sm" aria-label={`Rename ${memory.title}`} data-tip="Rename" data-tip-pos="below"
            onClick={() => setRenaming(true)}>
            <Icon name="pencil" size={14} />
          </button>
          <button type="button" className="os-btn os-btn-ghost os-btn-icon os-btn-sm" aria-label={`Forget ${memory.title}`} data-tip="Forget" data-tip-pos="below"
            onClick={() => setConfirming(true)}>
            <Icon name="trash" size={14} />
          </button>
        </div>
      </div>
      {memory.body && memory.body !== memory.title ? <p className="os-mem-body">{memory.body}</p> : null}
      <footer className="os-mem-meta">
        <span>{howLearned(memory.rule)}</span>
        <span aria-hidden="true">·</span>
        <span title={new Date(memory.createdAt).toLocaleString()}>{whenUsed(memory.createdAt, now) === "now" ? "just now" : whenUsed(memory.createdAt, now)}</span>
        {memory.editedAt ? <><span aria-hidden="true">·</span><span>renamed</span></> : null}
      </footer>
      {confirming ? (
        <div className="os-mem-confirm" role="group" aria-label={`Forget ${memory.title}`}>
          <span>Forget this? TRH AI will stop using it straight away.</span>
          <button type="button" className="os-btn os-btn-sm os-btn-danger" onClick={() => void forget()}>Forget</button>
          <button type="button" className="os-btn os-btn-sm" onClick={() => setConfirming(false)}>Keep</button>
        </div>
      ) : null}
    </li>
  );
}

export function MemoryView() {
  const { memories: stats, documents, workspace, refresh } = useSystem();
  const { notify } = useNotify();
  const [list, setList] = useState<MemoryRow[] | null>(null);
  const [audit, setAudit] = useState<MemoryAuditRow[]>([]);
  const [limit, setLimit] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<MemoryKind | "all">("all");
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const [now, setNow] = useState(() => new Date());

  const load = useCallback(async () => {
    const result = await apiGet<{ memories: MemoryRow[]; audit: MemoryAuditRow[]; limit?: number }>(`/v1/assist/memory?sessionId=${encodeURIComponent(sessionId())}`);
    if (!result.ok) return;
    setList(result.data.memories);
    setAudit(result.data.audit ?? []);
    if (typeof result.data.limit === "number") setLimit(result.data.limit);
    setNow(new Date());
  }, []);

  // After any change: this list, and the counts the rest of the app shows.
  const changed = useCallback(() => {
    void load();
    void refresh();
  }, [load, refresh]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load() sets state only after its request returns
    void load();
  }, [load]);

  const shown = useMemo(() => filterMemories(list ?? [], query, kind), [list, query, kind]);
  const counts = useMemo(() => countByKind(list ?? []), [list]);

  const remember = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || saving) return;
    setSaving(true);
    const result = await apiPost<{ status: "saved" | "duplicate" }>("/v1/assist/memory", { sessionId: sessionId(), text });
    setSaving(false);
    if (!result.ok) {
      notify({ level: "error", title: "Could not remember that", body: result.reason, source: "MEMORY" });
      return;
    }
    setDraft("");
    notify(result.data.status === "saved"
      ? { level: "success", title: "Remembered", body: text, source: "MEMORY" }
      : { level: "info", title: "Already remembered", body: "TRH AI already has that.", source: "MEMORY" });
    changed();
  };

  const forgetEverything = async () => {
    setConfirmAll(false);
    const result = await apiDelete(`/v1/assist/memory/all?sessionId=${encodeURIComponent(sessionId())}`);
    if (result.ok) notify({ level: "success", title: "Forgot everything", body: "Every memory is gone. Documents are kept.", source: "MEMORY" });
    changed();
  };

  const total = list?.length ?? stats?.total ?? null;

  return (
    <ViewFrame
      id="memory"
      actions={(
        <>
          <span className="os-chip accent">{total === null ? "Loading…" : `${total}${limit ? ` of ${limit}` : ""} memories`}</span>
          {confirmAll ? (
            <>
              <span className="os-faint os-small">Forget every memory? Documents stay. This cannot be undone.</span>
              <button type="button" className="os-btn os-btn-sm os-btn-danger" onClick={() => void forgetEverything()}>Forget everything</button>
              <button type="button" className="os-btn os-btn-sm" onClick={() => setConfirmAll(false)}>Keep</button>
            </>
          ) : (
            <button type="button" className="os-btn os-btn-sm" disabled={!list?.length} onClick={() => setConfirmAll(true)}>
              <Icon name="trash" size={14} />Forget everything
            </button>
          )}
        </>
      )}
    >
      <div className="os-memory-layout">
        <section className="os-panel os-memory-main" aria-label="What TRH AI remembers">
          <header className="os-panel-head">
            <h3 className="os-panel-title">What TRH AI remembers</h3>
            {limit && total !== null ? <span className="os-faint os-small">{total} of {limit} kept · the oldest unpinned make room</span> : null}
          </header>
          <div className="os-panel-body os-stack">
            <form className="os-mem-add" onSubmit={(event) => void remember(event)}>
              <span className="os-mem-add-lead">Remember that</span>
              <input className="os-input" value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={500}
                placeholder="the server restarts at 4am every night" aria-label="Something for TRH AI to remember" />
              <button type="submit" className="os-btn os-btn-primary" disabled={!draft.trim() || saving}>
                <Icon name="plus" size={15} />{saving ? "Saving…" : "Remember"}
              </button>
            </form>

            <div className="os-mem-toolbar">
              <label className="os-convos-search os-mem-search">
                <Icon name="search" size={15} />
                <input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setQuery(""); }}
                  placeholder="Search memories" aria-label="Search memories" />
              </label>
              <div className="os-choice" role="radiogroup" aria-label="Kind of memory">
                {[{ id: "all" as const, plural: "All" }, ...memoryKinds].map((option) => (
                  <button key={option.id} type="button" role="radio" aria-checked={kind === option.id} className={kind === option.id ? "on" : ""}
                    onClick={() => setKind(option.id)}>
                    {option.plural} <span className="os-faint">{counts[option.id]}</span>
                  </button>
                ))}
              </div>
            </div>

            {list === null ? (
              <p className="os-faint">Reading memory…</p>
            ) : shown.length === 0 ? (
              <div className="os-empty">
                <strong>{list.length === 0 ? "Nothing remembered yet" : "Nothing matches"}</strong>
                <p>{list.length === 0
                  ? "Tell TRH AI something above, or say \"remember that…\" in chat. Preferences and facts you mention are picked up too."
                  : "Try fewer words, or another kind."}</p>
              </div>
            ) : (
              <ul className="os-mem-list">
                {shown.map((memory) => <MemoryItem key={memory.id} memory={memory} now={now} onChanged={changed} />)}
              </ul>
            )}
          </div>
        </section>

        <aside className="os-memory-side">
          <MemoryStatus
            entries={stats?.total ?? null}
            pinned={stats?.pinned ?? null}
            documents={documents}
            workspaceBytes={workspace?.bytes ?? null}
            workspaceFiles={workspace?.files ?? null}
          />
          <section className="os-panel" aria-label="Memory history">
            <header className="os-panel-head"><h3 className="os-panel-title">History</h3></header>
            <div className="os-panel-body">
              {audit.length === 0 ? (
                <p className="os-faint os-small">Every memory saved, pinned, renamed or forgotten is listed here.</p>
              ) : (
                <ol className="os-mem-history">
                  {audit.map((entry) => (
                    <li key={entry.id}>
                      <span className={`os-mem-verb ${entry.action}`}>{auditVerb(entry.action)}</span>
                      <span className="os-mem-history-detail">{auditDetail(entry)}</span>
                      <span className="os-faint os-mono os-small">{whenUsed(entry.createdAt, now)}</span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </section>
        </aside>
      </div>

      <DocumentsPanel onChange={() => void refresh()} />
    </ViewFrame>
  );
}
