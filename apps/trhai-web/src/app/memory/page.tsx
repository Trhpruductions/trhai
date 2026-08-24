"use client";

import { useCallback, useEffect, useState } from "react";
import { memoryBodyAddsInfo } from "@ascend/shared";
import { apiDelete, apiGet, apiPatch, sessionId } from "../../lib/api";
import "./memory.css";

// Memory: what TRHAI has been told to remember, against the existing
// GET/PATCH/DELETE /v1/assist/memory routes - the same ones Vexora's own
// Memory panel already uses. Everything here is something the user said,
// extracted from their own words, never inferred - which is why every entry
// can be renamed and forgotten rather than only viewed.

type Memory = { id: string; title: string; body: string; pinned: boolean; createdAt: string };

export default function MemoryPage() {
  const [items, setItems] = useState<Memory[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const result = await apiGet<{ memories: Memory[] }>(`/v1/assist/memory?sessionId=${sessionId()}`);
    if (result.ok) setItems(result.data.memories);
    setLoaded(true);
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function patch(item: Memory, body: Record<string, unknown>, message: string) {
    const result = await apiPatch<{ memory: Memory }>(`/v1/assist/memory/${item.id}`, { sessionId: sessionId(), ...body });
    await load();
    setNote(result.ok ? message : "That change did not save — it may still show the old value.");
  }

  async function forget(item: Memory) {
    // No undo once this fires — worth a pause, not a placeholder click.
    if (!window.confirm(`Forget "${item.title}"? This cannot be undone.`)) return;

    const result = await apiDelete(`/v1/assist/memory/${item.id}?sessionId=${sessionId()}`);
    await load();
    setNote(result.ok ? `Forgot "${item.title}"` : `Could not forget "${item.title}" — it is still saved.`);
  }

  function commitRename(item: Memory) {
    const next = draft.trim();
    setEditing(null);
    if (!next || next === item.title) return;
    void patch(item, { title: next }, `Renamed to "${next}"`);
  }

  return (
    <div className="memory">
      <header className="memory-head">
        <h1>Memory</h1>
        <p className="muted">
          Facts you asked TRHAI to keep, in your own words. Say &ldquo;remember that &hellip;&rdquo; in
          chat to add one — nothing here was inferred.
        </p>
        {note ? <span key={note} className="chip memory-note">{note}</span> : null}
      </header>

      {!loaded ? null : items.length === 0 ? (
        <div className="panel memory-card">
          <p className="muted">Nothing remembered yet.</p>
        </div>
      ) : (
        <ul className="memory-list">
          {items.map((item) => (
            <li key={item.id} className={`panel memory-item${item.pinned ? " memory-item-pinned" : ""}`}>
              <div className="memory-item-body">
                {editing === item.id ? (
                  <input
                    className="field"
                    value={draft}
                    autoFocus
                    aria-label={`Rename ${item.title}`}
                    onChange={(event) => setDraft(event.target.value)}
                    onBlur={() => commitRename(item)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") { event.preventDefault(); commitRename(item); }
                      if (event.key === "Escape") setEditing(null);
                    }}
                  />
                ) : (
                  <button type="button" className="memory-rename" title="Click to rename"
                    onClick={() => { setEditing(item.id); setDraft(item.title); }}>
                    {item.title}
                  </button>
                )}
                {memoryBodyAddsInfo(item) ? <p className="faint">{item.body}</p> : null}
              </div>

              <div className="memory-item-actions">
                <button type="button" className="btn btn-sm"
                  onClick={() => void patch(item, { pinned: !item.pinned }, item.pinned ? "Unpinned" : "Pinned")}>
                  {item.pinned ? "Unpin" : "Pin"}
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void forget(item)}>
                  Forget
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
