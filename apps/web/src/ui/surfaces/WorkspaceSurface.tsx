import { useCallback, useEffect, useState } from "react";
import { clampPercent } from "../../dashboardStatus";
import { Surface, Empty } from "../Surface";
import "./workspace.css";

// Workspace: this machine.
//
// Projects, files, the terminal and the system widgets were four separate
// destinations before. They are all the same subject — the computer the app is
// running on — and splitting them meant four screens that were each mostly
// empty, three of which said nothing at all without the desktop bridge.
//
// Everything here needs that bridge. In a browser the screen says so once, at
// the top, instead of every panel failing separately.

type HostProject = { name: string; path: string; group: string };
type ConnectedProject = { root: string; name: string; connectedAt: string };
type ProjectEntry = { path: string; bytes: number; directory: boolean };

/** The folder above `entryPath`, or the project root. */
function parentOf(entryPath: string): string {
  const cut = entryPath.lastIndexOf("/");
  return cut === -1 ? "" : entryPath.slice(0, cut);
}
type Telemetry = { cpuPercent?: number; memoryPercent?: number; storagePercent?: number; networkPercent?: number };
type LogLine = { id: string; text: string; level: string };

export function WorkspaceSurface() {
  const bridge = window.ascendDesktop;
  const [projects, setProjects] = useState<HostProject[]>([]);
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null);
  // Bumped on every completed read, so the flash below marks a real sample
  // having landed even on a tick where every percentage happens to repeat.
  const [telemetrySeq, setTelemetrySeq] = useState(0);
  const [checks, setChecks] = useState<Array<{ name: string; label: string }>>([]);
  const [log, setLog] = useState<LogLine[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [connected, setConnected] = useState<ConnectedProject | null>(null);
  const [connecting, setConnecting] = useState(false);
  /** Folder currently being browsed, relative to the project root. "" is the root. */
  const [projectPath, setProjectPath] = useState("");
  const [projectEntries, setProjectEntries] = useState<ProjectEntry[]>([]);
  const [fileView, setFileView] = useState<{ path: string; content: string; truncated: boolean } | null>(null);

  const refresh = useCallback(async () => {
    if (!bridge?.listProjectInventory) return;
    const result = await bridge.listProjectInventory();
    setProjects(result?.projects ?? []);
  }, [bridge]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Host readings, refreshed while this screen is open and not otherwise —
  // polling telemetry from a conversation screen is work nobody asked for.
  useEffect(() => {
    if (!bridge?.getSystemTelemetry) return;
    let cancelled = false;

    async function read() {
      const result = await bridge!.getSystemTelemetry!();
      if (!cancelled && result?.ok) {
        setTelemetry(result);
        setTelemetrySeq((count) => count + 1);
      }
    }

    void read();
    const timer = window.setInterval(read, 5000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [bridge]);

  // Runtime events from a running command, streamed by the desktop shell.
  useEffect(() => {
    if (!bridge?.onRuntimeEvent) return;
    return bridge.onRuntimeEvent((event: { kind: string; line: string; level: string }) => {
      setLog((current) => [
        { id: crypto.randomUUID(), text: event.line, level: event.level },
        ...current
      ].slice(0, 200));
    });
  }, [bridge]);

  // The runnable set comes from the main process rather than being listed
  // here, so this screen cannot drift out of step with what will actually be
  // accepted — an unknown name is refused at the dispatcher either way.
  useEffect(() => {
    if (!bridge?.listWorkspaceChecks) return;
    let cancelled = false;

    void bridge.listWorkspaceChecks().then((result) => {
      if (!cancelled && result?.ok) setChecks(result.checks ?? []);
    }).catch(() => {
      // Leaves the list empty, which reads as "no checks available" rather
      // than offering a button that cannot work.
    });

    return () => { cancelled = true; };
  }, [bridge]);

  const openFolder = useCallback(async (folder: string) => {
    if (!bridge?.listProjectFiles) return;

    const result = await bridge.listProjectFiles({ subdirectory: folder || "." });
    // A refusal leaves the previous listing alone rather than blanking the
    // panel, so a rejected path does not look like an empty folder.
    if (result?.ok) {
      setProjectPath(folder);
      setProjectEntries(result.entries ?? []);
      setFileView(null);
    }
  }, [bridge]);

  const refreshConnected = useCallback(async () => {
    if (!bridge?.getConnectedProject) return;

    const result = await bridge.getConnectedProject();
    const project = result?.ok ? result.project ?? null : null;
    setConnected(project);
    if (project) await openFolder("");
  }, [bridge, openFolder]);

  useEffect(() => { void refreshConnected(); }, [refreshConnected]);

  async function connect() {
    if (!bridge?.connectProject || connecting) return;

    setConnecting(true);
    try {
      const result = await bridge.connectProject();
      // Cancelling the picker is a normal outcome, not a failure to report.
      if (result?.ok && result.project) {
        setConnected(result.project);
        await openFolder("");
      }
    } finally {
      setConnecting(false);
    }
  }

  async function disconnect() {
    if (!bridge?.disconnectProject) return;

    await bridge.disconnectProject();
    setConnected(null);
    setProjectEntries([]);
    setProjectPath("");
    setFileView(null);
  }

  async function openFile(filePath: string) {
    if (!bridge?.readProjectFile) return;

    const result = await bridge.readProjectFile({ path: filePath });
    setFileView(result?.ok
      ? { path: filePath, content: result.content ?? "", truncated: Boolean(result.truncated) }
      // Shown rather than swallowed: a file that could not be read must not
      // look like a file that was empty.
      : { path: filePath, content: result?.error ?? "That file could not be read.", truncated: false });
  }

  async function runCheck(check: string) {
    if (busy || !bridge?.runWorkspaceCheck) return;

    setBusy(check);
    try {
      const result = await bridge.runWorkspaceCheck({ check });
      // A refusal from the dispatcher is reported in the same log as real
      // output; without this a rejected check looks identical to one that ran
      // and printed nothing.
      if (result && !result.ok && result.error) {
        setLog((current) => [
          { id: crypto.randomUUID(), text: result.error!, level: "error" },
          ...current
        ].slice(0, 200));
      }
    } finally {
      setBusy(null);
    }
  }

  if (!bridge?.getSystemTelemetry) {
    return (
      <Surface title="Workspace" summary="Your projects, host readings and project checks.">
        <Empty title="Needs the desktop app">
          This screen reads your machine — project folders, disk and CPU, and project checks — which a
          browser tab cannot do. Open Vexora AI from Launch-Vexora and it appears here.
        </Empty>
      </Surface>
    );
  }

  const readings: Array<{ label: string; value: number | undefined }> = [
    { label: "CPU", value: telemetry?.cpuPercent },
    { label: "Memory", value: telemetry?.memoryPercent },
    { label: "Storage", value: telemetry?.storagePercent },
    { label: "Network", value: telemetry?.networkPercent }
  ];

  return (
    <Surface
      title="Workspace"
      summary="Your projects, live host readings and project checks — all on this machine."
      count={`${projects.length} projects`}
      readable={false}
      actions={<button type="button" className="btn btn-sm" onClick={() => void refresh()}>Refresh</button>}
    >
      <div className="readings">
        {readings.map((reading) => (
          <div key={reading.label} className="panel reading">
            <span className="label">{reading.label}</span>
            {/* A missing reading shows a dash, not a zero: "0%" is a
                measurement and would be a false one. */}
            <strong className="reading-value">
              {/* A separate layer so remounting it to replay the flash on
                  every sample never remounts the number sitting in front of
                  it — same reasoning as the stat rail on the home screen. */}
              {reading.value !== undefined ? <span key={telemetrySeq} className="live-flash" /> : null}
              {reading.value === undefined ? "—" : `${clampPercent(reading.value)}%`}
            </strong>
            <div className="reading-bar">
              <span style={{ width: `${reading.value === undefined ? 0 : clampPercent(reading.value)}%` }} />
            </div>
          </div>
        ))}
      </div>

      {/* Connected Project: a folder the user picked in the operating
          system's own dialog. Read-only by construction — the bridge has no
          write method because the main process has no write handler. */}
      <div className="col connected-project">
        <div className="row spread">
          <span className="label">Connected project</span>
          {connected ? (
            <button type="button" className="btn btn-sm" onClick={() => void disconnect()}>
              Disconnect
            </button>
          ) : (
            <button type="button" className="btn btn-sm" disabled={connecting}
              onClick={() => void connect()}>
              {connecting ? "Choosing…" : "Connect a project"}
            </button>
          )}
        </div>

        {connected ? (
          <>
            <div className="panel list-row">
              <div className="grow">
                <strong>{connected.name}</strong>
                <p className="faint list-excerpt mono">{connected.root}</p>
              </div>
              <span className="chip">read-only</span>
            </div>

            {projectPath ? (
              <button type="button" className="btn btn-ghost btn-sm project-up"
                onClick={() => void openFolder(parentOf(projectPath))}>
                ← {projectPath}
              </button>
            ) : null}

            {projectEntries.length === 0 ? (
              <p className="faint">Nothing to show in this folder.</p>
            ) : (
              <ul className="list">
                {projectEntries.map((entry) => (
                  <li key={entry.path} className="panel list-row">
                    <button type="button" className="btn btn-ghost grow project-entry"
                      onClick={() => void (entry.directory ? openFolder(entry.path) : openFile(entry.path))}>
                      {entry.directory ? "📁" : "📄"} {entry.path.split("/").pop()}
                    </button>
                    {!entry.directory ? <span className="faint">{entry.bytes} bytes</span> : null}
                  </li>
                ))}
              </ul>
            )}

            {fileView ? (
              <div className="panel project-file">
                <div className="row spread">
                  <strong className="mono">{fileView.path}</strong>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setFileView(null)}>
                    Close
                  </button>
                </div>
                {fileView.truncated ? (
                  <p className="faint">Showing the first part of this file; it is longer than displayed.</p>
                ) : null}
                <pre className="mono project-file-body">{fileView.content}</pre>
              </div>
            ) : null}
          </>
        ) : (
          <Empty title="No project connected">
            Connect a folder to browse and read its files here. You choose it in your own
            file picker, and this app can only read what is inside it — there is no way to
            write to it from this screen.
          </Empty>
        )}
      </div>

      <div className="workspace-split">
        <div className="col">
          <span className="label">Projects</span>
          {projects.length === 0 ? (
            <Empty title="No projects found">
              Nothing with a package.json under the workspace, apps, packages or generated-projects.
            </Empty>
          ) : (
            <ul className="list">
              {projects.map((project) => (
                <li key={project.path} className="panel list-row">
                  <div className="grow">
                    <strong>{project.name}</strong>
                    <p className="faint list-excerpt mono">{project.path}</p>
                  </div>
                  <button type="button" className="btn btn-sm"
                    onClick={() => void bridge.openPath?.(project.path)}>
                    Open
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="col">
          <span className="label">Checks</span>
          {/* Named checks rather than a command box. The executable and its
              arguments live in the desktop shell; this screen can only ask
              for one of them by name, so there is no command text for page
              content to influence. */}
          {checks.length === 0 ? (
            <Empty title="No checks available">
              The desktop shell reports nothing runnable. Checks run against your project
              and are defined in the app itself, not typed here.
            </Empty>
          ) : (
            <div className="row wrap">
              {checks.map((check) => (
                <button
                  key={check.name}
                  type="button"
                  className="btn"
                  disabled={busy !== null}
                  onClick={() => void runCheck(check.name)}
                >
                  {busy === check.name ? `${check.label}…` : check.label}
                </button>
              ))}
            </div>
          )}

          <div className="panel term-log">
            {log.length === 0 ? (
              <p className="faint">Output appears here as a check runs.</p>
            ) : (
              log.map((line) => (
                <p key={line.id} className={`mono term-line term-${line.level}`}>{line.text}</p>
              ))
            )}
          </div>
        </div>
      </div>
    </Surface>
  );
}
