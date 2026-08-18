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
type Telemetry = { cpuPercent?: number; memoryPercent?: number; storagePercent?: number; networkPercent?: number };
type LogLine = { id: string; text: string; level: string };

export function WorkspaceSurface() {
  const bridge = window.ascendDesktop;
  const [projects, setProjects] = useState<HostProject[]>([]);
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null);
  const [command, setCommand] = useState("");
  const [log, setLog] = useState<LogLine[]>([]);
  const [busy, setBusy] = useState(false);

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
      if (!cancelled && result?.ok) setTelemetry(result);
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

  async function runCommand() {
    const trimmed = command.trim();
    if (!trimmed || busy || !bridge?.runWorkspaceCommand) return;

    setBusy(true);
    try {
      await bridge.runWorkspaceCommand({ command: trimmed });
    } finally {
      setBusy(false);
    }
  }

  if (!bridge?.getSystemTelemetry) {
    return (
      <Surface title="Workspace" summary="Your projects, host readings and a terminal.">
        <Empty title="Needs the desktop app">
          This screen reads your machine — project folders, disk and CPU, and a shell — which a
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
      summary="Your projects, live host readings and a shell — all on this machine."
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
              {reading.value === undefined ? "—" : `${clampPercent(reading.value)}%`}
            </strong>
            <div className="reading-bar">
              <span style={{ width: `${reading.value === undefined ? 0 : clampPercent(reading.value)}%` }} />
            </div>
          </div>
        ))}
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
          <span className="label">Terminal</span>
          <div className="row">
            <input
              className="field mono grow"
              value={command}
              placeholder="npm test"
              aria-label="Command"
              onChange={(event) => setCommand(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") void runCommand(); }}
            />
            <button type="button" className="btn btn-primary" disabled={busy || !command.trim()}
              onClick={() => void runCommand()}>
              {busy ? "Running…" : "Run"}
            </button>
          </div>

          <div className="panel term-log">
            {log.length === 0 ? (
              <p className="faint">Output appears here as a command runs.</p>
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
