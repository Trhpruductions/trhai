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
  const [checks, setChecks] = useState<Array<{ name: string; label: string }>>([]);
  const [log, setLog] = useState<LogLine[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

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
