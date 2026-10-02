"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiDelete, apiGet, apiPost } from "../../lib/api";
import { whenUsed } from "../../lib/conversationGroups";
import { formatDuration } from "../../lib/taskCenter";
import { Icon } from "../ui/Icon";
import { ViewFrame } from "../ui/ViewFrame";
import { useAssistantState } from "../state/assistant";
import { useNav } from "../state/nav";
import { useNotify } from "../state/notify";
import "./views.css";

// The apps TRH AI has built and the commands it has run. Each app with what
// it was asked to be and the changes since; start it, see it running right
// here with what its server is printing, open it in the browser, read its
// code, ask for a change, or delete it. Beside them, every command run while
// machine access was on, with its real output and exit code.

type BuiltApp = {
  name: string;
  running: boolean;
  url: string | null;
  title: string | null;
  request: string | null;
  changes: string[];
  modifiedAt: number | null;
  startedAt: string | null;
  /** The last lines the running server printed, newest last. */
  output: string[];
};

type CommandRun = { command: string; stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; durationMs: number; startedAt: string };
type Commands = { armed: boolean; armedUntil: string | null; history: CommandRun[] };

function ago(iso: string, now: Date): string {
  const said = whenUsed(iso, now);
  if (said === "now") return "just now";
  return /^\d+[mh]$/.test(said) ? `${said} ago` : said;
}

function AppRow({ app, now, previewing, onPreview, onChanged }: {
  app: BuiltApp; now: Date; previewing: boolean; onPreview: () => void; onChanged: () => void;
}) {
  const { notify } = useNotify();
  const { setDraft } = useAssistantState();
  const { go } = useNav();
  const [working, setWorking] = useState<"start" | "stop" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const label = app.title || app.name;

  const start = async () => {
    setWorking("start");
    const result = await apiPost<{ app: { url: string } }>("/v1/apps/start", { project: app.name });
    setWorking(null);
    if (result.ok) {
      notify({ level: "success", title: `${label} is running`, body: result.data.app.url, source: "CODE" });
      onPreview();
    } else {
      notify({ level: "error", title: `${label} did not start`, body: result.reason, source: "CODE" });
    }
    onChanged();
  };

  const stop = async () => {
    setWorking("stop");
    const result = await apiPost<{ stopped: boolean }>("/v1/apps/stop", { project: app.name });
    setWorking(null);
    if (!result.ok) notify({ level: "error", title: `Could not stop ${label}`, body: result.reason, source: "CODE" });
    onChanged();
  };

  const remove = async () => {
    setConfirming(false);
    const result = await apiDelete(`/v1/apps/built/${encodeURIComponent(app.name)}`);
    if (result.ok) notify({ level: "success", title: "App deleted", body: `${label} and its folder are gone.`, source: "CODE" });
    else notify({ level: "error", title: `Could not delete ${label}`, body: result.reason, source: "CODE" });
    onChanged();
  };

  return (
    <li className={`os-app${app.running ? " running" : ""}${previewing ? " on" : ""}`}>
      <div className="os-app-head">
        <span className={`os-dot ${app.running ? "ok live" : ""}`} aria-hidden="true" />
        <div className="os-app-names">
          <strong>{label}</strong>
          {app.title ? <span className="os-mono os-faint">{app.name}</span> : null}
        </div>
        <span className={`os-chip ${app.running ? "ok" : ""}`}>{app.running ? "Running" : "Stopped"}</span>
      </div>
      {app.request ? <p className="os-app-request">&ldquo;{app.request}&rdquo;</p> : null}
      <p className="os-app-meta">
        {app.changes.length ? `Changed ${app.changes.length} time${app.changes.length === 1 ? "" : "s"} since it was built` : "As first built"}
        {app.modifiedAt ? <> · files changed {ago(new Date(app.modifiedAt).toISOString(), now)}</> : null}
        {app.running && app.startedAt ? <> · started {ago(app.startedAt, now)}</> : null}
      </p>
      <div className="os-app-actions">
        {app.running ? (
          <>
            <button type="button" className={`os-btn os-btn-sm${previewing ? " on" : ""}`} aria-pressed={previewing} onClick={onPreview}><Icon name="eye" size={14} />Preview</button>
            {app.url ? <a className="os-btn os-btn-sm" href={app.url} target="_blank" rel="noreferrer"><Icon name="external" size={14} />Open</a> : null}
            <button type="button" className="os-btn os-btn-sm" disabled={working !== null} onClick={() => void stop()}><Icon name="stop" size={14} />{working === "stop" ? "Stopping…" : "Stop"}</button>
          </>
        ) : (
          <button type="button" className="os-btn os-btn-sm os-btn-primary" disabled={working !== null} onClick={() => void start()}>
            <Icon name="play" size={14} />{working === "start" ? "Starting…" : "Run"}
          </button>
        )}
        <button type="button" className="os-btn os-btn-sm os-btn-ghost" onClick={() => go("files", app.name)}><Icon name="panel" size={14} />Read the code</button>
        <button type="button" className="os-btn os-btn-sm os-btn-ghost" onClick={() => { setDraft(`Change the ${app.name} app: `); go("chat"); }}>
          <Icon name="pencil" size={14} />Ask for a change
        </button>
        <button type="button" className="os-btn os-btn-sm os-btn-ghost os-btn-icon" aria-label={`Delete ${label}`} data-tip={app.running ? "Stop it to delete it" : "Delete"} data-tip-pos="below"
          disabled={app.running} onClick={() => setConfirming(true)}>
          <Icon name="trash" size={14} />
        </button>
      </div>
      {confirming ? (
        <div className="os-mem-confirm" role="group" aria-label={`Delete ${label}`}>
          <span>Delete {label}? Its whole folder goes, and it cannot be brought back.</span>
          <button type="button" className="os-btn os-btn-sm os-btn-danger" onClick={() => void remove()}>Delete</button>
          <button type="button" className="os-btn os-btn-sm" onClick={() => setConfirming(false)}>Keep</button>
        </div>
      ) : null}
    </li>
  );
}

function CommandItem({ run, now }: { run: CommandRun; now: Date }) {
  const [open, setOpen] = useState(false);
  const output = `${run.stdout}${run.stderr ? `\n${run.stderr}` : ""}`.trim();
  const fine = !run.timedOut && run.exitCode === 0;
  return (
    <li className={`os-cmd${open ? " open" : ""}`}>
      <button type="button" className="os-cmd-row" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="os-cmd-prompt" aria-hidden="true">›</span>
        <span className="os-cmd-text os-mono">{run.command}</span>
        <span className={`os-chip ${fine ? "ok" : "danger"}`}>{run.timedOut ? "Timed out" : run.exitCode === null ? "Stopped" : run.exitCode === 0 ? "OK" : `Exit ${run.exitCode}`}</span>
      </button>
      <span className="os-cmd-meta">{ago(run.startedAt, now)} · took {formatDuration(run.durationMs)}</span>
      {open ? <pre className="os-cmd-out">{output || "(printed nothing)"}</pre> : null}
    </li>
  );
}

export function CodeView() {
  const [apps, setApps] = useState<BuiltApp[] | null>(null);
  const [commands, setCommands] = useState<Commands | null>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [runningOnly, setRunningOnly] = useState(false);
  const [frameKey, setFrameKey] = useState(0);
  const [now, setNow] = useState(() => new Date());

  const load = useCallback(async () => {
    const [built, ran] = await Promise.all([apiGet<{ apps: BuiltApp[] }>("/v1/apps/built"), apiGet<Commands>("/v1/commands")]);
    if (built.ok) setApps(built.data.apps);
    if (ran.ok) setCommands(ran.data);
    setNow(new Date());
  }, []);

  // Every four seconds while the window is visible: apps start and stop, and
  // commands run, without anyone opening this page.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load() sets state only after its request returns
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 4000);
    return () => window.clearInterval(timer);
  }, [load]);

  const running = useMemo(() => (apps ?? []).filter((app) => app.running), [apps]);
  // The app chosen to preview, or else the one started most recently.
  const shown = useMemo(() => {
    const chosen = running.find((app) => app.name === previewing);
    if (chosen) return chosen;
    return [...running].sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""))[0] ?? null;
  }, [running, previewing]);

  const listed = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return [...(apps ?? [])]
      .filter((app) => !runningOnly || app.running)
      .filter((app) => words.every((word) => `${app.name} ${app.title ?? ""} ${app.request ?? ""}`.toLowerCase().includes(word)))
      .sort((a, b) => Number(b.running) - Number(a.running) || (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0));
  }, [apps, query, runningOnly]);

  return (
    <ViewFrame
      id="code"
      actions={(
        <>
          <span className="os-chip accent">{apps === null ? "Loading…" : `${apps.length} app${apps.length === 1 ? "" : "s"}`}</span>
          {running.length ? <span className="os-chip ok"><span className="os-dot ok live" aria-hidden="true" />{running.length} running</span> : null}
        </>
      )}
    >
      <div className="os-tasks-layout">
        <div className="os-tasks-main">
          {shown ? (
            <section className="os-panel os-app-preview" aria-label={`${shown.title || shown.name}, running`}>
              <header className="os-panel-head">
                <h3 className="os-panel-title"><span className="os-dot ok live" aria-hidden="true" />{shown.title || shown.name}</h3>
                <div className="os-panel-tools">
                  {shown.url ? <span className="os-mono os-faint os-small">{shown.url}</span> : null}
                  <button type="button" className="os-btn os-btn-sm os-btn-ghost os-btn-icon" aria-label="Reload the preview" data-tip="Reload" data-tip-pos="below"
                    onClick={() => setFrameKey((key) => key + 1)}>
                    <Icon name="refresh" size={14} />
                  </button>
                  {shown.url ? <a className="os-btn os-btn-sm" href={shown.url} target="_blank" rel="noreferrer"><Icon name="external" size={14} />Open</a> : null}
                </div>
              </header>
              <div className="os-panel-body os-stack">
                {shown.url ? (
                  <iframe key={`${shown.name}-${frameKey}`} className="os-app-frame" src={shown.url} title={`${shown.title || shown.name}, running`}
                    sandbox="allow-scripts allow-forms allow-same-origin allow-popups" />
                ) : null}
                <div className="os-app-output">
                  <span className="os-label">What its server is printing</span>
                  <pre>{shown.output.length ? shown.output.join("\n") : "(nothing yet)"}</pre>
                </div>
              </div>
            </section>
          ) : null}

          <section className="os-panel" aria-label="Apps TRH AI has built">
            <header className="os-panel-head">
              <h3 className="os-panel-title">Built apps</h3>
              <div className="os-panel-tools">
                <label className="os-convos-search os-code-search">
                  <Icon name="search" size={15} />
                  <input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setQuery(""); }}
                    placeholder="Search apps" aria-label="Search apps" />
                </label>
                <button type="button" className={`os-btn os-btn-sm${runningOnly ? " on" : ""}`} aria-pressed={runningOnly} onClick={() => setRunningOnly(!runningOnly)}>Running only</button>
              </div>
            </header>
            <div className="os-panel-body">
              {apps === null ? <p className="os-faint">Reading the workspace…</p>
                : listed.length === 0 ? (
                  <div className="os-empty">
                    <strong>{apps.length === 0 ? "Nothing built yet" : "No app matches"}</strong>
                    <p>{apps.length === 0 ? "Ask TRH AI to build something - \"build me a plant tracker with a calendar\" - and it shows here, ready to run." : runningOnly ? "Nothing is running." : "Try fewer words."}</p>
                  </div>
                ) : (
                  <ul className="os-app-list">
                    {listed.map((app) => (
                      <AppRow key={app.name} app={app} now={now} previewing={shown?.name === app.name}
                        onPreview={() => setPreviewing(app.name)} onChanged={() => void load()} />
                    ))}
                  </ul>
                )}
            </div>
          </section>
        </div>

        <aside className="os-tasks-side">
          <section className="os-panel" aria-label="Commands TRH AI has run">
            <header className="os-panel-head">
              <h3 className="os-panel-title">Terminal</h3>
              {commands ? <span className={`os-chip ${commands.armed ? "warn" : ""}`}>{commands.armed ? "Machine access on" : "Machine access off"}</span> : null}
            </header>
            <div className="os-panel-body os-stack">
              {commands === null ? <p className="os-faint">Reading…</p>
                : commands.history.length === 0 ? (
                  <p className="os-faint os-small">
                    {commands.armed
                      ? "No commands since TRH AI's service last started. Commands it runs show here with their real output."
                      : "No commands have run. TRH AI can only run them while machine access is on - switch it on in Tools."}
                  </p>
                ) : (
                  <ol className="os-cmd-list">
                    {/* Kept newest first by the API itself. */}
                    {commands.history.map((run, index) => <CommandItem key={`${run.startedAt}-${index}`} run={run} now={now} />)}
                  </ol>
                )}
              {commands && commands.history.length ? <p className="os-faint os-small">Since TRH AI&rsquo;s service last started; newest first.</p> : null}
            </div>
          </section>
        </aside>
      </div>
    </ViewFrame>
  );
}
