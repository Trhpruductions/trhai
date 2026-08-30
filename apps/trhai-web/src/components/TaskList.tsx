"use client";

import { useState } from "react";
import "./tasks.css";

// The to-do list, with the controls that make it a list rather than a readout.
//
// The API has had the whole of this since it was written - create, mark done,
// remove, all per session - and the surface that used it was deleted with the
// rest of them. What was left behind was a panel counting "0 done · 0 open"
// under an invitation to add one from a page that no longer existed, which
// could never show anything else because nothing could put a task in.
//
// The counts stayed, because seeing how much is outstanding without reading
// the list is the thing the readout was actually good at. They are now the
// header of the list rather than a second panel saying the same thing twice.

export type TaskItem = { id: string; title: string; done: boolean; createdAt: string };

export function TaskList({ tasks, onAdd, onToggle, onRemove }: {
  tasks: TaskItem[] | null;
  onAdd: (title: string) => void;
  onToggle: (id: string, done: boolean) => void;
  onRemove: (id: string) => void;
}) {
  const [draft, setDraft] = useState("");

  const done = tasks?.filter((task) => task.done).length ?? null;
  const open = tasks?.filter((task) => !task.done).length ?? null;

  const submit = () => {
    const title = draft.trim();
    if (!title) return;
    onAdd(title);
    setDraft("");
  };

  return (
    <section className="hud-panel tasks">
      <div className="tasks-head">
        <span className="hud-label">Tasks</span>
        {/* Em dashes until the list has actually been read, rather than a
            confident "0 done" for a list nobody has fetched yet. */}
        <span className="tasks-count">
          {done === null ? "—" : `${done} done · ${open} open`}
        </span>
      </div>

      <div className="tasks-add">
        <input
          className="tasks-input"
          value={draft}
          placeholder="Add a task"
          aria-label="Add a task"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") submit(); }}
        />
        <button
          type="button"
          className="tasks-add-go"
          onClick={submit}
          disabled={draft.trim().length === 0}
          aria-label="Add task"
        >
          +
        </button>
      </div>

      {tasks === null ? (
        <p className="faint tasks-empty">Reading the list…</p>
      ) : tasks.length === 0 ? (
        <p className="faint tasks-empty">Nothing on the list.</p>
      ) : (
        <ul className="tasks-list">
          {tasks.map((task) => (
            <li key={task.id} className={`tasks-row${task.done ? " done" : ""}`}>
              <label className="tasks-check">
                <input
                  type="checkbox"
                  checked={task.done}
                  onChange={(event) => onToggle(task.id, event.target.checked)}
                />
                <span className="tasks-title">{task.title}</span>
              </label>
              <button
                type="button"
                className="tasks-remove"
                onClick={() => onRemove(task.id)}
                aria-label={`Remove ${task.title}`}
                title="Remove"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
