"use client";

import { useEffect, useMemo, useState } from "react";
import { Markdown } from "../../components/Markdown";
import { apiBaseUrl, apiGet } from "../../lib/api";
import { whenUsed } from "../../lib/conversationGroups";
import {
  absolutePath, crumbs, fileKind, formatBytes, languageOf, parentOf, sortEntries,
  type FileEntry, type FileKind, type FileSort
} from "../../lib/files";
import { Icon } from "../ui/Icon";
import { ViewFrame } from "../ui/ViewFrame";
import { useAssistantState } from "../state/assistant";
import { useNav } from "../state/nav";
import { useNotify } from "../state/notify";
import { detailFromHash } from "../views";
import "./views.css";

// TRH AI's workspace on this PC, one folder at a time: browse it, search it by
// name and by what is inside, and preview anything in it - code with line
// numbers, Markdown rendered, pictures, sound and video played from the disk.
// The folder is in the address (#files/app2/src), so Back walks back up.
// Read-only on purpose: writing goes through TRH AI, which keeps the record.

type Listing = { root: string; path: string; entries: FileEntry[]; truncated: boolean; limit: number };
type Found = { query: string; names: FileEntry[]; lines: Array<{ path: string; line: number; text: string }>; truncated: boolean };
type Opened = { path: string; content: string; binary: boolean; truncated: boolean; bytes?: number; modifiedAt?: number };
/** A file to preview. Size and date only when they came from the disk - a search hit has neither until it is read. */
type PreviewTarget = { name: string; path: string; bytes?: number; modifiedAt?: number };

const sorts: Array<{ id: FileSort; label: string }> = [
  { id: "name", label: "Name" }, { id: "newest", label: "Newest" }, { id: "size", label: "Size" }
];

function ago(at: number, now: Date): string {
  const said = whenUsed(new Date(at).toISOString(), now);
  if (said === "now") return "just now";
  return /^\d+[mh]$/.test(said) ? `${said} ago` : said;
}

const rawUrl = (path: string) => `${apiBaseUrl}/v1/files/raw?path=${encodeURIComponent(path)}`;

function kindIcon(kind: FileKind): string {
  if (kind === "image") return "M4 5h16v14H4zM4 15l4.5-4.5 4 4 2.5-2.5L20 17M15.5 8.5h.01";
  if (kind === "video") return "M4 6h11v12H4zM15 10l5-3v10l-5-3";
  if (kind === "audio") return "M9 17V6l10-2v11M9 17a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0ZM19 15a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z";
  if (kind === "code") return "M8.5 8 4.5 12l4 4M15.5 8l4 4-4 4";
  return "M6 3.5h8l4 4V20.5H6zM14 3.5v4h4M9 12h6M9 15.5h6";
}

const folderIcon = "M4 7a1 1 0 0 1 1-1h4l2 2h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1Z";

/** Code and text, line by line, numbered. */
function CodeLines({ content, wrap }: { content: string; wrap: boolean }) {
  const lines = useMemo(() => content.replace(/\r\n/g, "\n").split("\n"), [content]);
  return (
    <pre className={`os-code${wrap ? " wrap" : ""}`}>
      <code>
        {lines.map((line, index) => (
          <span key={index} className="os-code-line"><span className="os-code-no" aria-hidden="true">{index + 1}</span>{line || " "}{"\n"}</span>
        ))}
      </code>
    </pre>
  );
}

function Preview({ entry, root, onAsk }: { entry: PreviewTarget; root: string; onAsk: (text: string) => void }) {
  const { notify } = useNotify();
  const kind = fileKind(entry.name);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [rendered, setRendered] = useState(true);
  const [wrap, setWrap] = useState(false);
  const textual = kind === "code" || kind === "text" || kind === "markdown" || kind === "other";

  useEffect(() => {
    if (!textual) return;
    let current = true;
    void apiGet<Opened>(`/v1/files/content?path=${encodeURIComponent(entry.path)}`).then((result) => {
      if (!current) return;
      if (result.ok) setOpened(result.data);
      else setFailed(result.reason);
    });
    return () => { current = false; };
  }, [entry.path, textual]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(absolutePath(root, entry.path));
      notify({ level: "success", title: "Path copied", body: absolutePath(root, entry.path), source: "FILES" });
    } catch {
      notify({ level: "error", title: "Could not copy", body: "The clipboard is not available here.", source: "FILES" });
    }
  };

  const language = languageOf(entry.name);
  const bytes = opened?.bytes ?? entry.bytes;
  const modifiedAt = opened?.modifiedAt ?? entry.modifiedAt;
  const facts = [
    bytes !== undefined ? formatBytes(bytes) : null,
    language,
    modifiedAt !== undefined ? `changed ${new Date(modifiedAt).toLocaleString()}` : null
  ].filter(Boolean).join(" · ");
  return (
    <section className="os-panel os-file-preview" aria-label={`Preview of ${entry.name}`}>
      <header className="os-file-preview-head">
        <div className="os-file-preview-title">
          <strong>{entry.name}</strong>
          <span className="os-faint os-small os-mono">{entry.path}</span>
          {facts ? <span className="os-faint os-small">{facts}</span> : null}
        </div>
        <div className="os-file-preview-actions">
          {kind === "markdown" ? (
            <button type="button" className={`os-btn os-btn-sm${rendered ? " on" : ""}`} aria-pressed={rendered} onClick={() => setRendered(!rendered)}>
              {rendered ? "Rendered" : "Source"}
            </button>
          ) : null}
          {(kind === "code" || kind === "text" || (kind === "markdown" && !rendered)) ? (
            <button type="button" className={`os-btn os-btn-sm${wrap ? " on" : ""}`} aria-pressed={wrap} onClick={() => setWrap(!wrap)}>Wrap lines</button>
          ) : null}
          <button type="button" className="os-btn os-btn-sm" onClick={() => void copy()}><Icon name="copy" size={14} />Copy path</button>
          <button type="button" className="os-btn os-btn-sm os-btn-primary"
            onClick={() => onAsk(kind === "document"
              ? `Summarise the document ${entry.path} in my workspace.`
              : `Look at ${entry.path} in the workspace and tell me what it is for.`)}>
            <Icon name="message" size={14} />{kind === "document" ? "Ask TRH AI to summarise it" : "Ask TRH AI about it"}
          </button>
        </div>
      </header>
      <div className="os-file-preview-body">
        {kind === "image"
          // eslint-disable-next-line @next/next/no-img-element -- a file from this PC's disk, served by the local API: nothing for Next to optimise
          ? <img className="os-file-media" src={rawUrl(entry.path)} alt={entry.name} />
          : kind === "video" ? <video className="os-file-media" src={rawUrl(entry.path)} controls preload="metadata" />
            : kind === "audio" ? <audio className="os-file-audio" src={rawUrl(entry.path)} controls preload="metadata" />
              : kind === "document" ? (
                <div className="os-empty">
                  <strong>No preview for this kind of file</strong>
                  <p>TRH AI can read PDF, Word and PowerPoint files - ask it to summarise this one.</p>
                </div>
              ) : failed ? <p className="os-task-alert"><Icon name="alert" size={14} />{failed}</p>
                : !opened ? <p className="os-faint">Reading…</p>
                  : opened.binary ? (
                    <div className="os-empty"><strong>Not a text file</strong><p>Binary data - there is nothing here to read.</p></div>
                  ) : (
                    <>
                      {opened.truncated ? <p className="os-faint os-small">Showing the first 100 KB{bytes !== undefined ? ` of ${formatBytes(bytes)}` : ""}.</p> : null}
                      {kind === "markdown" && rendered
                        ? <div className="os-file-markdown"><Markdown text={opened.content} className="os-markdown" /></div>
                        : <CodeLines content={opened.content} wrap={wrap} />}
                    </>
                  )}
      </div>
    </section>
  );
}

export function FilesView() {
  const { send } = useAssistantState();
  const { go } = useNav();
  const [path, setPath] = useState(".");
  const [listing, setListing] = useState<Listing | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [sort, setSort] = useState<FileSort>("name");
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Found | null>(null);
  const [selected, setSelected] = useState<PreviewTarget | null>(null);
  const [recent, setRecent] = useState<FileEntry[] | null>(null);
  const [now, setNow] = useState(() => new Date());

  // The folder is whatever the address says, kept in step as it changes.
  useEffect(() => {
    const read = () => setPath(detailFromHash(window.location.hash) ?? ".");
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);

  // Only the folder still open may fill the list. Caught live: arriving from
  // "Read the code", the workspace root was asked for first and the app's
  // folder a moment later, the root answered last, and the page showed the
  // root's contents under the app folder's name.
  useEffect(() => {
    let current = true;
    void apiGet<Listing>(`/v1/files/list?path=${encodeURIComponent(path)}`).then((result) => {
      if (!current) return;
      setNow(new Date());
      if (!result.ok) {
        setProblem(result.reason);
        setListing(null);
        return;
      }
      setProblem(null);
      setListing(result.data);
    });
    return () => { current = false; };
  }, [path]);

  // What changed most recently anywhere in the workspace, for the empty preview.
  useEffect(() => {
    void apiGet<{ entries: Array<{ path: string; bytes: number; directory: boolean; modifiedAt: number }> }>("/v1/files").then((result) => {
      if (!result.ok) return;
      setRecent(result.data.entries.filter((entry) => !entry.directory).slice(0, 12)
        .map((entry) => ({ ...entry, name: entry.path.split("/").pop() ?? entry.path })));
    });
  }, []);

  // Search a moment after typing stops, under the folder that is open.
  useEffect(() => {
    const words = query.trim();
    if (!words) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clearing the results when the search is cleared
      setFound(null);
      return;
    }
    // The same rule: results for a search that has since changed are dropped.
    let current = true;
    const timer = window.setTimeout(() => {
      void apiGet<Found>(`/v1/files/search?q=${encodeURIComponent(words)}&path=${encodeURIComponent(path)}`).then((result) => {
        if (current && result.ok) setFound(result.data);
      });
    }, 300);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [query, path]);

  const open = (target: string) => {
    setSelected(null);
    setQuery("");
    go("files", target === "." ? null : target);
  };

  const ask = (text: string) => {
    void send(text);
    go("chat");
  };

  const entries = useMemo(() => sortEntries(listing?.entries ?? [], sort), [listing, sort]);
  const root = listing?.root ?? "";
  const pick = (entry: FileEntry) => (entry.directory ? open(entry.path) : setSelected(entry));

  return (
    <ViewFrame
      id="files"
      actions={root ? <span className="os-chip os-mono" title="The workspace folder on this PC">{root}</span> : null}
    >
      <div className="os-files-layout">
        <section className="os-panel os-file-browser" aria-label="Folder">
          <div className="os-file-toolbar">
            <label className="os-convos-search">
              <Icon name="search" size={15} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setQuery(""); }}
                placeholder={path === "." ? "Search the workspace" : "Search this folder"} aria-label="Search files" />
            </label>
            <div className="os-choice" role="radiogroup" aria-label="Sort by">
              {sorts.map((option) => (
                <button key={option.id} type="button" role="radio" aria-checked={sort === option.id} className={sort === option.id ? "on" : ""} onClick={() => setSort(option.id)}>
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <nav className="os-crumbs" aria-label="Folder path">
            <button type="button" className={path === "." ? "on" : ""} onClick={() => open(".")}><Icon name="grid" size={13} />Workspace</button>
            {crumbs(path).map((crumb) => (
              <span key={crumb.path} className="os-crumb">
                <Icon name="chevronRight" size={12} />
                <button type="button" className={crumb.path === path ? "on" : ""} onClick={() => open(crumb.path)}>{crumb.name}</button>
              </span>
            ))}
          </nav>

          {found ? (
            <div className="os-file-results">
              {found.names.length === 0 && found.lines.length === 0 ? (
                <div className="os-empty"><strong>Nothing matches &ldquo;{found.query}&rdquo;</strong><p>Names and the text inside files are both searched.</p></div>
              ) : null}
              {found.names.length ? (
                <>
                  <span className="os-label">Names</span>
                  <ul className="os-file-list">
                    {found.names.map((entry) => (
                      <li key={entry.path}>
                        <button type="button" className="os-file-row" onClick={() => pick(entry)}>
                          <Icon path={entry.directory ? folderIcon : kindIcon(fileKind(entry.name))} size={16} className={entry.directory ? "os-file-folder" : "os-file-icon"} />
                          <span className="os-file-name">{entry.path}</span>
                          <span className="os-file-meta">{entry.directory ? "folder" : formatBytes(entry.bytes)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
              {found.lines.length ? (
                <>
                  <span className="os-label">Inside files</span>
                  <ul className="os-file-list">
                    {found.lines.map((match) => (
                      <li key={`${match.path}:${match.line}`}>
                        <button type="button" className="os-file-row os-file-hit"
                          onClick={() => setSelected({ name: match.path.split("/").pop() ?? match.path, path: match.path })}>
                          <span className="os-file-name"><span className="os-mono">{match.path}:{match.line}</span><span className="os-file-line">{match.text}</span></span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
              {found.truncated ? <p className="os-faint os-small">Showing the first matches - search for something more specific to narrow it.</p> : null}
            </div>
          ) : problem ? (
            <div className="os-empty"><strong>Could not open this folder</strong><p>{problem}</p>
              <button type="button" className="os-btn os-btn-sm" onClick={() => open(".")}>Back to the workspace</button></div>
          ) : !listing ? <p className="os-faint os-file-pad">Reading the folder…</p>
            : (
              <ul className="os-file-list">
                {path !== "." ? (
                  <li>
                    <button type="button" className="os-file-row" onClick={() => open(parentOf(path))}>
                      <Icon name="up" size={16} className="os-file-icon" />
                      <span className="os-file-name">Up to {parentOf(path) === "." ? "the workspace" : parentOf(path).split("/").pop()}</span>
                    </button>
                  </li>
                ) : null}
                {entries.length === 0 ? <li className="os-faint os-file-pad">This folder is empty.</li> : null}
                {entries.map((entry) => (
                  <li key={entry.path}>
                    <button type="button" className={`os-file-row${selected?.path === entry.path ? " on" : ""}`} aria-current={selected?.path === entry.path ? "true" : undefined}
                      onClick={() => pick(entry)}>
                      <Icon path={entry.directory ? folderIcon : kindIcon(fileKind(entry.name))} size={16} className={entry.directory ? "os-file-folder" : "os-file-icon"} />
                      <span className="os-file-name">{entry.name}</span>
                      <span className="os-file-meta">
                        {entry.directory ? (entry.items === undefined ? "folder" : `${entry.items} item${entry.items === 1 ? "" : "s"}`) : formatBytes(entry.bytes)}
                      </span>
                      <span className="os-file-when" title={new Date(entry.modifiedAt).toLocaleString()}>{ago(entry.modifiedAt, now)}</span>
                    </button>
                  </li>
                ))}
                {listing.truncated ? <li className="os-faint os-small os-file-pad">The first {listing.limit} are shown - this folder holds more.</li> : null}
              </ul>
            )}
        </section>

        <div className="os-file-side">
          {selected ? <Preview key={selected.path} entry={selected} root={root} onAsk={ask} />
            : (
              <section className="os-panel" aria-label="Recently changed">
                <header className="os-panel-head"><h3 className="os-panel-title">Recently changed</h3></header>
                <div className="os-panel-body">
                  {recent === null ? <p className="os-faint">Reading…</p>
                    : recent.length === 0 ? <p className="os-faint os-small">Nothing in the workspace yet. Ask TRH AI to build something, or to write a file.</p>
                      : (
                        <ul className="os-file-list">
                          {recent.map((entry) => (
                            <li key={entry.path}>
                              <button type="button" className="os-file-row" onClick={() => setSelected(entry)}>
                                <Icon path={kindIcon(fileKind(entry.name))} size={16} className="os-file-icon" />
                                <span className="os-file-name">{entry.path}</span>
                                <span className="os-file-when">{ago(entry.modifiedAt, now)}</span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                  <p className="os-faint os-small os-file-hint">Pick a file to preview it here.</p>
                </div>
              </section>
            )}
        </div>
      </div>
    </ViewFrame>
  );
}
