"use client";

import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { apiBaseUrl, apiDelete, apiGet, requestHeaders, sessionId } from "../lib/api";
import {
  acceptedDocumentTypes, describeImport, describeLength, refuseBeforeSending, type ImportResult, type StoredDocument
} from "../lib/documents";
import "./personality.css";

// The knowledge base's documents, in the Memory view: what is there, adding a
// file (a button or a drop), and removing one. A file goes to the local API
// as itself and is read there - nothing leaves this machine.

export function DocumentsPanel({ onChange }: { onChange?: () => void }) {
  const [documents, setDocuments] = useState<StoredDocument[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [notes, setNotes] = useState<Array<{ tone: "ok" | "bad"; text: string }>>([]);
  const picker = useRef<HTMLInputElement>(null);

  const fetchDocuments = useCallback(async () => {
    const result = await apiGet<{ documents: StoredDocument[] }>(`/v1/knowledge?sessionId=${encodeURIComponent(sessionId())}`);
    // Newest first.
    return result.ok ? [...result.data.documents].reverse() : [];
  }, []);

  const load = useCallback(async () => setDocuments(await fetchDocuments()), [fetchDocuments]);

  // Loaded once on open; adding and removing reload it.
  useEffect(() => {
    let cancelled = false;
    void fetchDocuments().then((found) => {
      if (!cancelled) setDocuments(found);
    });
    return () => { cancelled = true; };
  }, [fetchDocuments]);

  const send = async (files: File[]) => {
    if (files.length === 0) return;
    setBusy(true);
    const results: Array<{ tone: "ok" | "bad"; text: string }> = [];
    for (const file of files) {
      const refused = refuseBeforeSending(file);
      if (refused) {
        results.push({ tone: "bad", text: refused });
        continue;
      }
      try {
        const response = await fetch(
          `${apiBaseUrl}/v1/knowledge/import?sessionId=${encodeURIComponent(sessionId())}&name=${encodeURIComponent(file.name)}`,
          { method: "POST", headers: requestHeaders({ "Content-Type": "application/octet-stream" }), body: file }
        );
        const payload = await response.json().catch(() => null) as { data?: ImportResult; message?: string } | null;
        results.push(response.ok && payload?.data
          ? { tone: "ok", text: describeImport(payload.data) }
          : { tone: "bad", text: payload?.message ?? `"${file.name}" could not be added (the service answered ${response.status}).` });
      } catch {
        results.push({ tone: "bad", text: "The local service did not answer, so nothing was added." });
      }
    }
    setNotes(results);
    setBusy(false);
    await load();
    onChange?.();
  };

  const remove = async (document: StoredDocument) => {
    setBusy(true);
    const result = await apiDelete(`/v1/knowledge/${encodeURIComponent(document.id)}?sessionId=${encodeURIComponent(sessionId())}`);
    setBusy(false);
    setNotes([result.ok ? { tone: "ok", text: `Removed "${document.title}".` } : { tone: "bad", text: result.reason }]);
    await load();
    onChange?.();
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (!busy) void send([...event.dataTransfer.files]);
  };

  return (
    <section
      className={`hud-panel persona-pick account-panel documents-panel${dragging ? " dragging" : ""}`}
      onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <span className="hud-label">Documents</span>
      <p className="persona-summary">
        Add a PDF, Word, PowerPoint or text file and ask about it in chat - &ldquo;what does the Q3 report say about
        costs?&rdquo; It is read on this PC; nothing is uploaded anywhere.
      </p>

      <div className="account-actions">
        <button type="button" className="account-button primary" disabled={busy} onClick={() => picker.current?.click()}>
          {busy ? "Reading…" : "Add a document"}
        </button>
        <span className="documents-drop-hint">or drop files here</span>
      </div>
      <input
        ref={picker}
        type="file"
        multiple
        accept={acceptedDocumentTypes}
        hidden
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = "";
          void send(files);
        }}
      />

      {notes.map((note, index) => (
        <p key={index} className={`account-note ${note.tone}`} role={note.tone === "bad" ? "alert" : "status"}>{note.text}</p>
      ))}

      {documents === null ? (
        <p className="messaging-fine">Loading…</p>
      ) : documents.length === 0 ? (
        <p className="messaging-fine">No documents yet.</p>
      ) : (
        <ul className="documents-list">
          {documents.map((document) => (
            <li key={document.id}>
              <div>
                <p className="documents-title">{document.title}</p>
                <p className="documents-meta">
                  {describeLength(document.body.length)} · added {new Date(document.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                </p>
              </div>
              <button type="button" className="account-button danger" disabled={busy} onClick={() => void remove(document)}>Remove</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
