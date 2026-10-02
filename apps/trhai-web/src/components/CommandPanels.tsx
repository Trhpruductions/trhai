"use client";

// What memory holds, for the Memory workspace, filled from a real source.
// The health checks now live in the System workspace, and the work TRH AI is
// doing in the Task center (lib/taskCenter.ts), with the rule that was written
// here: no progress bars, because nothing in the agent knows how far through
// a request it is.

export function MemoryStatus({
  entries, pinned, documents, workspaceBytes, workspaceFiles
}: {
  entries: number | null;
  pinned: number | null;
  documents: number | null;
  workspaceBytes: number | null;
  workspaceFiles: number | null;
}) {
  // The reference shows "87% · 13.2 GB / 15.0 GB", a memory bar filling up.
  // There is no such quota: memories are small text records with no ceiling,
  // so a percentage would need a denominator invented to produce it. The
  // counts are the real quantity, and the workspace has a real size.
  const kb = workspaceBytes === null ? null : (workspaceBytes / 1024).toFixed(0);

  return (
    <section className="hud-panel">
      <span className="hud-label">Memory &amp; storage</span>
      <dl className="hud-readouts">
        <div><dt>Memories</dt><dd>{entries === null ? "—" : entries}</dd></div>
        <div><dt>Pinned</dt><dd>{pinned === null ? "—" : pinned}</dd></div>
        <div><dt>Documents</dt><dd>{documents === null ? "—" : documents}</dd></div>
        <div>
          <dt>Workspace</dt>
          <dd>{workspaceFiles === null ? "—" : `${workspaceFiles} files · ${kb} KB`}</dd>
        </div>
      </dl>
    </section>
  );
}
