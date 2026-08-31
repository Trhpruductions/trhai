"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet } from "../lib/api";
import "./work.css";

// The split view: what was built, and what was run to build it.
//
// The backlog asks for "coding intent triggers transition to split layout".
// This triggers on the work, not the intent — the view opens when files have
// genuinely been written or a command has genuinely run, not when a request
// looked like it might involve code. Guessing intent from the wording would
// open an empty editor beside an empty terminal for anyone who said the word
// "build", and close for anyone who did not phrase it that way. Waiting for
// the first real event costs a fraction of a second and is never wrong.
//
// Files on the left, the terminal underneath. Both are read-only: this is for
// watching work happen, and an editor that could write back would be a
// different feature with a different set of things to get right.

type Entry = { path: string; bytes: number; directory: boolean; modifiedAt: number };
type CommandRun = { command: string; stdout: string; stderr: string; exitCode: number | null; timedOut: boolean };

/** Poll fast while work is live, slowly when it is not. */
const activeMs = 700;
const idleMs = 4000;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

export function WorkView({ live, onClose }: { live: boolean; onClose: () => void }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [runs, setRuns] = useState<CommandRun[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const read = useCallback(async () => {
    const [files, commands] = await Promise.all([
      apiGet<{ entries: Entry[] }>("/v1/files"),
      apiGet<{ history: CommandRun[] }>("/v1/commands")
    ]);
    if (files.ok) setEntries(files.data.entries);
    if (commands.ok) setRuns(commands.data.history);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- polls the execution log - this state comes from outside React
    void read();
    const poller = window.setInterval(() => void read(), live ? activeMs : idleMs);
    return () => window.clearInterval(poller);
  }, [read, live]);

  async function open(entry: Entry) {
    if (entry.directory) return;
    setSelected(entry.path);
    setContent(null);
    setNote(null);

    const result = await apiGet<{ content: string; binary: boolean; truncated: boolean }>(
      `/v1/files/content?path=${encodeURIComponent(entry.path)}`
    );
    if (!result.ok) { setNote(result.reason); return; }
    if (result.data.binary) {
      setNote(`${formatBytes(entry.bytes)} — a binary file, so there is nothing to read here.`);
      return;
    }
    setContent(result.data.content);
  }

  // Newest first: what just changed is what you came to look at.
  //
  // Sorted by modification time, which is the only thing that actually means
  // "newest". This used to reverse the listing and call that newest-first —
  // the listing comes back in directory-walk order, so reversing it surfaced
  // whichever project sorted last alphabetically. After building a house-plant
  // tracker the panel showed six files from an unrelated older project and not
  // one of the files it had just written, which is the exact opposite of what
  // this view is for.
  const files = [...entries]
    .filter((entry) => !entry.directory)
    .sort((left, right) => right.modifiedAt - left.modifiedAt)
    .slice(0, 40);

  return (
    <section className="work" aria-label="Work in progress">
      <header className="work-head">
        <span className="hud-label">Work</span>
        {live ? <span className="work-live">running</span> : null}
        <button type="button" className="work-close" onClick={onClose}>Close</button>
      </header>

      <div className="work-body">
        <div className="work-files">
          <span className="hud-label work-sub">Workspace · {files.length} files</span>
          <ul className="work-list">
            {files.map((entry) => (
              <li key={entry.path}>
                <button
                  type="button"
                  className={`work-file${selected === entry.path ? " selected" : ""}`}
                  onClick={() => void open(entry)}
                  title={entry.path}
                >
                  <span className="work-file-name">{entry.path}</span>
                  <span className="work-file-size">{formatBytes(entry.bytes)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="work-viewer">
          {selected ? (
            <>
              <span className="hud-label work-sub mono">{selected}</span>
              {note ? <p className="faint work-note">{note}</p>
                : content !== null ? <pre className="work-code">{content}</pre>
                  : <p className="faint work-note">Reading…</p>}
            </>
          ) : (
            <p className="faint work-note">Pick a file to read it. Everything here was written by TRHAI.</p>
          )}
        </div>
      </div>

      <div className="work-terminal">
        <span className="hud-label work-sub">Terminal</span>
        {runs.length === 0 ? (
          // Not a fake prompt waiting for input. Nothing has been run, and
          // this is the only capability here that needs switching on first.
          <p className="faint work-note">
            No commands have run. Switch machine control on to let TRHAI use this machine.
          </p>
        ) : (
          <div className="work-out">
            {runs.slice(0, 6).map((run, index) => (
              <div key={`${run.command}-${index}`} className="work-run">
                <div className="work-cmd">
                  <span className="work-prompt" aria-hidden="true">›</span>
                  <span className="mono">{run.command}</span>
                  <span className={`work-exit${run.exitCode === 0 && !run.timedOut ? " ok" : " bad"}`}>
                    {run.timedOut ? "timed out" : run.exitCode === 0 ? "ok" : `exit ${run.exitCode}`}
                  </span>
                </div>
                {/* The real output, both streams, exactly as printed. */}
                <pre className="work-stdout">
                  {(run.stdout + (run.stderr ? `\n${run.stderr}` : "")).trim() || "(printed nothing)"}
                </pre>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
