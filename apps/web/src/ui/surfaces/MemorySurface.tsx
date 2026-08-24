import { useCallback, useEffect, useState } from "react";
import { webEnv } from "../../env";
import { memoryBodyAddsInfo } from "@ascend/shared";
import { Surface, Empty } from "../Surface";

// Memory: what the assistant has been told to remember.
//
// Everything here is something the user said, extracted from their own words —
// never inferred. That is why every entry can be renamed and forgotten: it is
// the user's material, and they should be able to correct or remove it without
// asking the assistant to do it for them.

type Memory = { id: string; title: string; body: string; pinned: boolean; createdAt: string };

function sessionId(): string {
  return window.localStorage.getItem("ascend.assist.session.v1") ?? "";
}

export function MemorySurface() {
  const [items, setItems] = useState<Memory[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${webEnv.apiBaseUrl}/v1/assist/memory?sessionId=${encodeURIComponent(sessionId())}`);
      if (!response.ok) return;
      const payload = await response.json();
      setItems(payload?.data?.memories ?? []);
    } catch {
      setNote("Could not reach the assistant service.");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function patch(id: string, body: Record<string, unknown>, message: string) {
    try {
      const response = await fetch(`${webEnv.apiBaseUrl}/v1/assist/memory/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: sessionId(), ...body })
      });
      await load();
      setNote(response.ok ? message : "That change did not save — it may still show the old value.");
    } catch {
      setNote("Could not reach the assistant service — nothing changed.");
    }
  }

  async function forget(item: Memory) {
    // No undo once this fetch fires — worth a pause, not a placeholder click.
    if (!window.confirm(`Forget "${item.title}"? This cannot be undone.`)) return;

    try {
      const response = await fetch(
        `${webEnv.apiBaseUrl}/v1/assist/memory/${encodeURIComponent(item.id)}?sessionId=${encodeURIComponent(sessionId())}`,
        { method: "DELETE" }
      );
      await load();
      setNote(response.ok ? `Forgot "${item.title}"` : `Could not forget "${item.title}" — it is still saved.`);
    } catch {
      setNote("Could not reach the assistant service — nothing was forgotten.");
    }
  }

  function commitRename(item: Memory) {
    const next = draft.trim();
    setEditing(null);
    if (!next || next === item.title) return;
    void patch(item.id, { title: next }, `Renamed to "${next}"`);
  }

  return (
    <Surface
      title="Memory"
      summary="Facts you asked it to keep, in your own words. Say “remember that …” in a conversation to add one. Nothing here was inferred — if it is wrong, it is because it was told wrong."
      count={`${items.length} ${items.length === 1 ? "entry" : "entries"}`}
      actions={note ? <span key={note} className="chip chip-arrive">{note}</span> : undefined}
    >
      {items.length === 0 ? (
        <Empty title="Nothing remembered yet">
          Start a message with “remember that …” and it will be kept for later. Pinned
          entries rank first when it looks for an answer.
        </Empty>
      ) : (
        <ul className="list">
          {items.map((item) => (
            <li key={item.id} className={`panel list-row${item.pinned ? " pinned" : ""}`}>
              <div className="grow">
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
                  <button type="button" className="rename" title="Click to rename"
                    onClick={() => { setEditing(item.id); setDraft(item.title); }}>
                    {item.title}
                  </button>
                )}

                {/* The body only earns a line once it says something the title
                    does not — extraction derives the title from the body, so
                    showing both repeats the same sentence on every row. */}
                {memoryBodyAddsInfo(item) ? <p className="faint list-excerpt">{item.body}</p> : null}
              </div>

              <div className="row">
                <button type="button" className="btn btn-sm"
                  onClick={() => void patch(item.id, { pinned: !item.pinned }, item.pinned ? "Unpinned" : "Pinned")}>
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
    </Surface>
  );
}
