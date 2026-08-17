import { useCallback, useEffect, useRef, useState } from "react";
import { webEnv } from "../../env";
import { prepareImport, summarizeImport, type ImportResult } from "../../knowledgeImport";
import { Surface, Empty } from "../Surface";

// Knowledge: documents the assistant may quote.
//
// The honesty rule this screen exists to communicate: matching is on wording,
// not meaning. A user who expects semantic search will otherwise conclude the
// feature is broken the first time a differently-worded question misses.

type Doc = { id: string; title: string; body: string; createdAt: string };

function sessionId(): string {
  return window.localStorage.getItem("ascend.assist.session.v1") ?? "";
}

export function KnowledgeSurface() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${webEnv.apiBaseUrl}/v1/knowledge?sessionId=${encodeURIComponent(sessionId())}`);
      if (!response.ok) return;
      const payload = await response.json();
      setDocs(payload?.data?.documents ?? []);
    } catch {
      setNote("Could not reach the assistant service.");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function add(nextTitle: string, nextBody: string): Promise<boolean> {
    const response = await fetch(`${webEnv.apiBaseUrl}/v1/knowledge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: sessionId(), title: nextTitle, body: nextBody })
    });
    return response.ok;
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
      for (const file of Array.from(list)) {
        const contents = await file.text().catch(() => "");
        const prepared = prepareImport(file.name, contents, file.size);
        results.push(prepared);
        if (prepared.ok) await add(prepared.title, prepared.body);
      }
      await load();
      setNote(summarizeImport(results));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    await fetch(`${webEnv.apiBaseUrl}/v1/knowledge/${encodeURIComponent(id)}?sessionId=${encodeURIComponent(sessionId())}`, {
      method: "DELETE"
    });
    await load();
    setNote("Document removed");
  }

  return (
    <Surface
      title="Knowledge"
      summary="Paste or import text and the assistant can quote it back with its source. Matching is on wording rather than meaning, so a question phrased differently to the document may miss — it will say so rather than guess."
      count={`${docs.length} document${docs.length === 1 ? "" : "s"}`}
    >
      <div className="col">
        <input
          className="field"
          value={title}
          placeholder="Document title"
          aria-label="Document title"
          onChange={(event) => setTitle(event.target.value)}
        />
        <textarea
          className="field"
          value={body}
          rows={5}
          placeholder="Paste notes, a runbook, a spec. Blank lines separate passages, and a passage is what gets quoted."
          aria-label="Document body"
          onChange={(event) => setBody(event.target.value)}
        />
        <div className="row wrap">
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
            className="sr-only"
            aria-label="Import text files"
            onChange={(event) => { void importFiles(event.target.files); event.target.value = ""; }}
          />
          <span className="faint">Text formats only — a PDF or image is refused rather than indexed as noise.</span>
        </div>
        {note ? <span className="chip">{note}</span> : null}
      </div>

      {docs.length === 0 ? (
        <Empty title="No documents yet">
          Anything added here can be quoted back when you ask a question that matches its
          wording. Nothing is uploaded — documents stay on this machine.
        </Empty>
      ) : (
        <ul className="list">
          {docs.map((doc) => (
            <li key={doc.id} className="panel list-row">
              <div className="grow">
                <strong>{doc.title}</strong>
                <p className="faint list-excerpt">
                  {doc.body.slice(0, 150)}{doc.body.length > 150 ? "…" : ""}
                </p>
              </div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void remove(doc.id)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </Surface>
  );
}
