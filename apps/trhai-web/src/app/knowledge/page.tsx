"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { prepareImport, summarizeImport, type ImportResult } from "@ascend/shared";
import { apiDelete, apiGet, apiPost, sessionId } from "../../lib/api";
import "./knowledge.css";

// Knowledge: documents TRHAI may quote, against the existing
// GET/POST/DELETE /v1/knowledge routes. Matching is on wording, not
// meaning — a question phrased differently to the document may miss it,
// and this screen says so rather than implying semantic search it does
// not have.

type Doc = { id: string; title: string; body: string; createdAt: string };

export default function KnowledgePage() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const result = await apiGet<{ documents: Doc[] }>(`/v1/knowledge?sessionId=${sessionId()}`);
    if (result.ok) setDocs(result.data.documents);
    setLoaded(true);
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function add(nextTitle: string, nextBody: string): Promise<boolean> {
    const result = await apiPost<{ document: Doc }>("/v1/knowledge", { sessionId: sessionId(), title: nextTitle, body: nextBody });
    return result.ok;
  }

  async function submitPasted() {
    if (!title.trim() || !body.trim() || busy) return;
    setBusy(true);
    try {
      const ok = await add(title, body);
      setNote(ok ? `Added ${title.trim()}` : "A document needs a title and a body.");
      if (ok) { setTitle(""); setBody(""); await load(); }
    } finally {
      setBusy(false);
    }
  }

  /** Import files. Every file is judged before any is sent. */
  async function importFiles(list: FileList | null) {
    if (!list || list.length === 0 || busy) return;
    setBusy(true);

    try {
      const results: ImportResult[] = [];
      let saveFailures = 0;
      for (const file of Array.from(list)) {
        const contents = await file.text().catch(() => "");
        const prepared = prepareImport(file.name, contents, file.size);
        results.push(prepared);
        if (prepared.ok && !(await add(prepared.title, prepared.body))) saveFailures += 1;
      }
      await load();
      const summary = summarizeImport(results);
      setNote(saveFailures > 0 ? `${summary} · ${saveFailures} could not be saved` : summary);
    } finally {
      setBusy(false);
    }
  }

  async function remove(doc: Doc) {
    // No undo once this fires — worth a pause, not a placeholder click.
    if (!window.confirm(`Remove "${doc.title}"? This cannot be undone.`)) return;

    const result = await apiDelete(`/v1/knowledge/${doc.id}?sessionId=${sessionId()}`);
    await load();
    setNote(result.ok ? "Document removed" : "Could not remove the document — it may still be there.");
  }

  return (
    <div className="knowledge">
      <header className="knowledge-head">
        <h1>Knowledge</h1>
        <p className="muted">
          Paste or import text and TRHAI can quote it back with its source. Matching is on
          wording, not meaning — a document is text on this machine, not a search index.
        </p>
      </header>

      <div className="panel knowledge-card">
        <input
          className="field"
          value={title}
          placeholder="Document title"
          aria-label="Document title"
          onChange={(event) => setTitle(event.target.value)}
        />
        <textarea
          className="field knowledge-textarea"
          value={body}
          rows={5}
          placeholder="Paste notes, a runbook, a spec. Blank lines separate passages, and a passage is what gets quoted."
          aria-label="Document body"
          onChange={(event) => setBody(event.target.value)}
        />
        <div className="knowledge-actions">
          <button type="button" className="btn btn-primary" disabled={busy || !title.trim() || !body.trim()}
            onClick={() => void submitPasted()}>
            {busy ? "Working…" : "Add document"}
          </button>
          <button type="button" className="btn" onClick={() => fileRef.current?.click()} disabled={busy}>
            Import files…
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            className="knowledge-file-input"
            aria-label="Import text files"
            onChange={(event) => { void importFiles(event.target.files); event.target.value = ""; }}
          />
        </div>
        <p className="faint">Text formats only — a PDF or image is refused rather than indexed as noise.</p>
        {note ? <span key={note} className="chip knowledge-note">{note}</span> : null}
      </div>

      {!loaded ? null : docs.length === 0 ? (
        <div className="panel knowledge-card">
          <p className="muted">Nothing added yet. Documents stay on this machine — nothing is uploaded.</p>
        </div>
      ) : (
        <ul className="knowledge-list">
          {docs.map((doc) => (
            <li key={doc.id} className="panel knowledge-item">
              <div className="grow">
                <strong>{doc.title}</strong>
                <p className="faint">{doc.body.slice(0, 150)}{doc.body.length > 150 ? "…" : ""}</p>
              </div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void remove(doc)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
