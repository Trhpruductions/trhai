"use client";

import { useEffect, useState } from "react";
import { apiDelete, apiGet, apiPatch, apiPost, sessionId } from "../../lib/api";
import "./tasks.css";

// Tasks: a plain to-do list against GET/POST/PATCH/DELETE /v1/tasks.
//
// Deliberately minimal - a title and whether it is done, nothing else. The
// product vision names "Tasks" once, with no spec beyond the word itself;
// this is the smallest honest reading of it, not a guess at due dates or
// priority the vision never actually asked for.

type Task = { id: string; title: string; done: boolean; createdAt: string };

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function refresh() {
    const result = await apiGet<{ tasks: Task[] }>(`/v1/tasks?sessionId=${sessionId()}`);
    if (result.ok) {
      setTasks(result.data.tasks);
      setError(null);
    } else {
      setError(result.reason);
    }
    setLoaded(true);
  }

  useEffect(() => { void refresh(); }, []);

  async function add() {
    const title = draft.trim();
    if (!title) return;

    const result = await apiPost<{ task: Task }>("/v1/tasks", { sessionId: sessionId(), title });
    if (result.ok) {
      setTasks((current) => [...current, result.data.task]);
      setDraft("");
    } else {
      setError(result.reason);
    }
  }

  async function toggle(task: Task) {
    setBusyId(task.id);
    const result = await apiPatch<{ task: Task }>(`/v1/tasks/${task.id}`, { sessionId: sessionId(), done: !task.done });
    if (result.ok) {
      setTasks((current) => current.map((entry) => (entry.id === task.id ? result.data.task : entry)));
    } else {
      setError(result.reason);
    }
    setBusyId(null);
  }

  async function remove(task: Task) {
    setBusyId(task.id);
    const result = await apiDelete(`/v1/tasks/${task.id}?sessionId=${sessionId()}`);
    if (result.ok) {
      setTasks((current) => current.filter((entry) => entry.id !== task.id));
    } else {
      setError(result.reason);
    }
    setBusyId(null);
  }

  const open = tasks.filter((task) => !task.done);
  const done = tasks.filter((task) => task.done);

  return (
    <div className="tasks">
      <header className="tasks-head">
        <h1>Tasks</h1>
        <p className="muted">A plain list, kept on this machine against this browser's session.</p>
      </header>

      <div className="panel tasks-card">
        <div className="tasks-add-row">
          <input
            className="field"
            value={draft}
            placeholder="Add a task…"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void add(); }}
          />
          <button type="button" className="btn btn-primary" disabled={!draft.trim()} onClick={() => void add()}>
            Add
          </button>
        </div>
        {error ? <p className="faint tasks-error">{error}</p> : null}
      </div>

      {!loaded ? null : tasks.length === 0 && !error ? (
        <div className="panel tasks-card">
          <p className="muted">Nothing on the list yet.</p>
        </div>
      ) : (
        <>
          {open.length > 0 ? (
            <div className="panel tasks-card">
              <span className="hud-label">Open</span>
              <ul className="tasks-list">
                {open.map((task) => (
                  <li key={task.id} className="tasks-item">
                    <label className="tasks-item-label">
                      <input type="checkbox" checked={task.done} disabled={busyId === task.id}
                        onChange={() => void toggle(task)} />
                      <span>{task.title}</span>
                    </label>
                    <button type="button" className="btn btn-ghost btn-sm" disabled={busyId === task.id}
                      onClick={() => void remove(task)}>
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {done.length > 0 ? (
            <div className="panel tasks-card">
              <span className="hud-label">Done</span>
              <ul className="tasks-list">
                {done.map((task) => (
                  <li key={task.id} className="tasks-item tasks-item-done">
                    <label className="tasks-item-label">
                      <input type="checkbox" checked={task.done} disabled={busyId === task.id}
                        onChange={() => void toggle(task)} />
                      <span>{task.title}</span>
                    </label>
                    <button type="button" className="btn btn-ghost btn-sm" disabled={busyId === task.id}
                      onClick={() => void remove(task)}>
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
