"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiGet } from "../../lib/api";
import "./files.css";

// Files: the workspace, as a thing you can look at directly.
//
// Everything the assistant writes already went somewhere real on disk, but
// until now the only way to see it was to ask the model to list it — which is
// a strange way to look at your own files, and puts a language model between
// you and the truth about what is on your disk. This reads the same directory
// over /v1/files.
//
// The scope is exactly the workspace and nothing else. This is not a file
// manager for the machine: the API refuses any path that resolves outside the
// workspace root, and that refusal is the same one the assistant's own tools
// go through rather than a second, weaker check written for the browser. So
// the page cannot show you your home directory, and that is the intended
// behaviour rather than a missing feature.
//
// It reads. There is no delete, rename or move here — those are destructive,
// and a first version of a file browser is the wrong place to earn that
// trust. Writing already exists where it belongs, in the assistant's tools,
// behind the permission ladder.

type Entry = { path: string; bytes: number; directory: boolean };

type Listing = { root: string; path: string; entries: Entry[]; truncated: boolean; limit: number };

// Whether a file is text is decided by the API from its actual content, not
// here from its name. An earlier version of this page kept a list of known
// extensions and would have reported ".git/config", "HEAD" and
// "COMMIT_EDITMSG" as "not a text file" — all three are plainly readable and
// have no extension at all.

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

/**
 * Group a flat listing into a tree.
 *
 * The API walks the whole workspace and returns relative paths, so the
 * nesting is already implied by the strings — this only makes it visible.
 * Depth is computed from the path rather than tracked separately so a listing
 * and its indentation can never disagree.
 */
export function depthOf(relativePath: string): number {
  return relativePath.split("/").length - 1;
}

export default function FilesPage() {
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<{ text: string; truncated: boolean } | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [filter, setFilter] = useState("");

  const load = useCallback(async () => {
    const result = await apiGet<Listing>("/v1/files");
    if (result.ok) {
      setListing(result.data);
      setError(null);
    } else {
      setError(result.reason);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function open(entry: Entry) {
    if (entry.directory) return;
    setSelected(entry.path);
    setContent(null);
    setContentError(null);

    setLoadingFile(true);
    try {
      const result = await apiGet<{ content: string; truncated: boolean; binary: boolean }>(
        `/v1/files/content?path=${encodeURIComponent(entry.path)}`
      );
      if (!result.ok) {
        setContentError(result.reason);
        return;
      }
      if (result.data.binary) {
        // Not an error, and not an empty pane either. A binary file is a real
        // file; this says what it is rather than rendering its bytes as
        // mojibake and letting it look corrupted.
        setContentError(`${formatBytes(entry.bytes)} — this is a binary file, so there is nothing to read here.`);
        return;
      }
      setContent({ text: result.data.content, truncated: result.data.truncated });
    } finally {
      setLoadingFile(false);
    }
  }

  const visible = useMemo(() => {
    if (!listing) return [];
    const needle = filter.trim().toLowerCase();
    if (!needle) return listing.entries;
    return listing.entries.filter((entry) => entry.path.toLowerCase().includes(needle));
  }, [listing, filter]);

  const fileCount = listing?.entries.filter((entry) => !entry.directory).length ?? 0;
  const totalBytes = listing?.entries.reduce((sum, entry) => sum + entry.bytes, 0) ?? 0;

  return (
    <div className="files">
      <header className="files-head">
        <h1>Files</h1>
        <p className="muted">
          The assistant&rsquo;s workspace, read straight from disk. This is the only directory it can
          reach — anything resolving outside it is refused by the same check its own tools go through.
        </p>
        {listing ? (
          <p className="faint files-root mono" title={listing.root}>{listing.root}</p>
        ) : null}
      </header>

      {error ? (
        <p className="files-error">{error}</p>
      ) : !listing ? (
        <p className="faint">Reading the workspace&hellip;</p>
      ) : listing.entries.length === 0 ? (
        <div className="panel files-empty">
          <p>Nothing here yet.</p>
          <p className="faint">
            This fills up when the assistant writes a file or builds an app. It is a real directory
            on this machine — you can open it in a file browser at the path above.
          </p>
        </div>
      ) : (
        <div className="files-body">
          <section className="panel files-list-panel">
            <div className="files-toolbar">
              <input
                className="field files-filter"
                value={filter}
                placeholder="Filter by name…"
                aria-label="Filter files by name"
                onChange={(event) => setFilter(event.target.value)}
              />
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void load()}>
                Refresh
              </button>
            </div>

            <p className="faint files-count">
              {fileCount} {fileCount === 1 ? "file" : "files"} · {formatBytes(totalBytes)}
              {filter.trim() ? ` · ${visible.length} shown` : ""}
            </p>

            {/* A capped listing looks identical to a complete one. Saying so
                is the difference between "this is your workspace" and "this
                is the first 200 things in it". */}
            {listing.truncated ? (
              <p className="faint files-truncated">
                Showing the first {listing.limit} entries — there are more on disk.
              </p>
            ) : null}

            <ul className="files-list">
              {visible.map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    className={`files-entry${entry.directory ? " is-dir" : ""}${selected === entry.path ? " selected" : ""}`}
                    // Indented by the path's own depth, so the tree shown can
                    // never drift from the paths the API actually returned.
                    style={{ paddingLeft: `${8 + depthOf(entry.path) * 14}px` }}
                    onClick={() => void open(entry)}
                    aria-current={selected === entry.path ? "true" : undefined}
                  >
                    <span className="files-glyph" aria-hidden="true">{entry.directory ? "▸" : "·"}</span>
                    <span className="files-name">{entry.path.split("/").pop()}</span>
                    {entry.directory ? null : <span className="files-size">{formatBytes(entry.bytes)}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section className="panel files-view">
            {!selected ? (
              <p className="faint">Choose a file to read it.</p>
            ) : (
              <>
                <div className="files-view-head">
                  <b className="mono">{selected}</b>
                  {content?.truncated ? (
                    <span className="chip chip-warn" title="The rest is on disk; only the first part was sent.">
                      truncated
                    </span>
                  ) : null}
                </div>
                {loadingFile ? (
                  <p className="faint">Reading&hellip;</p>
                ) : contentError ? (
                  <p className="faint">{contentError}</p>
                ) : content ? (
                  content.text.length === 0 ? (
                    <p className="faint">This file is empty.</p>
                  ) : (
                    <pre className="files-content">{content.text}</pre>
                  )
                ) : null}
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
