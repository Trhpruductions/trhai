"use client";

import { useEffect, useState } from "react";
import { Icon } from "../os/ui/Icon";
import {
  describeHardware, formatBytes, initialSelection, initialToolSelection, jobPercent, plannedBytes, readSetup, removeInstalledModel,
  startInstall, stepText, stopInstall, type SetupStatus
} from "../lib/setup";
import "./setup.css";

// The engine and the models: what this PC has, what to install, and the
// install itself with its progress. Shown on its own the first time TRH AI
// runs without them (SetupScreen), and in Settings > Engine and models.

/** Reads the setup status, every second while an install runs and every 15 s otherwise. */
export function useSetupStatus(): { status: SetupStatus | null; failed: boolean; replace: (next: SetupStatus) => void } {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const running = status?.job?.state === "running";

  useEffect(() => {
    let alive = true;
    const read = () => {
      void readSetup().then((next) => {
        if (!alive) return;
        setFailed(next === null);
        if (next) setStatus(next);
      });
    };
    read();
    const timer = window.setInterval(read, running ? 1000 : 15000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [running]);

  return { status, failed, replace: setStatus };
}

/** `focus="tools"` leaves out the engine and the models, for a PC that can already answer and is only being offered the tools. */
export function SetupPanel({ mode, focus = "everything", onDone }: { mode: "first-run" | "settings"; focus?: "everything" | "tools"; onDone?: () => void }) {
  const { status, failed, replace } = useSetupStatus();
  const [picked, setPicked] = useState<string[] | null>(null);
  const [pickedTools, setPickedTools] = useState<string[] | null>(null);
  const [note, setNote] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  if (failed && !status) return <p className="setup-note bad">TRH AI&rsquo;s service is not answering, so setup cannot start yet. It usually takes a few seconds after opening.</p>;
  if (!status) return <p className="os-faint">Looking at this PC…</p>;

  // With the models out of sight none is installed by this screen, whatever would have been ticked.
  const selected = focus === "tools" ? [] : picked ?? initialSelection(status);
  // Every tool that is not installed starts ticked, so that one click installs everything.
  const selectedTools = pickedTools ?? initialToolSelection(status);
  const toolsToInstall = selectedTools.filter((id) => status.tools?.some((tool) => tool.id === id && !tool.installed));
  const job = status.job;
  const running = job?.state === "running";
  const needed = plannedBytes(status, selected, selectedTools);
  const nothingToDo = status.engine.installed
    && selected.every((id) => status.catalog.find((model) => model.id === id)?.installed)
    && toolsToInstall.length === 0;
  const tooBig = status.freeBytes !== null && needed > 0 && status.freeBytes < needed * 1.1 + 1024 ** 3;

  const toggle = (id: string) => setPicked(selected.includes(id) ? selected.filter((entry) => entry !== id) : [...selected, id]);
  const toggleTool = (id: string) => setPickedTools(selectedTools.includes(id) ? selectedTools.filter((entry) => entry !== id) : [...selectedTools, id]);

  const install = async () => {
    setBusy(true);
    setNote(null);
    const result = await startInstall({ engine: !status.engine.installed, models: selected, tools: toolsToInstall });
    setBusy(false);
    if (!result.ok) {
      setNote({ tone: "bad", text: result.reason });
      return;
    }
    // The selection stays as it was: ticked while it installs, and still
    // there for "Try again" if it is stopped or fails.
    replace(result.status);
    setPicked(selected);
    setPickedTools(selectedTools);
  };

  const stop = async () => {
    const result = await stopInstall();
    if (result.ok) replace(result.status);
  };

  const remove = async (id: string) => {
    if (!window.confirm(`Remove ${id} from this PC? It can be installed again from here.`)) return;
    setBusy(true);
    const result = await removeInstalledModel(id);
    setBusy(false);
    if (result.ok) replace(result.status);
    else setNote({ tone: "bad", text: result.reason });
  };

  const others = status.installed.filter((model) => !model.inCatalog);

  return (
    <div className="setup">
      {focus === "everything" ? <p className="setup-pc"><Icon name="info" size={15} />This PC: {describeHardware(status.hardware)}.</p> : null}

      {focus === "everything" ? (
        <>
          <section className="setup-block" aria-label="Model engine">
            <header>
              <strong>Model engine</strong>
              <span className={`setup-tag ${status.engine.installed ? "ok" : "todo"}`}>
                {status.engine.installed ? `Installed${status.engine.build ? ` · llama.cpp ${status.engine.build}` : ""}` : `Needed · ${formatBytes(status.engine.downloadBytes)}`}
              </span>
            </header>
            <p className="os-faint os-small">
              {status.engine.installed
                ? status.engine.running ? "Running." : status.engine.reason ?? "Not running."
                : `llama.cpp, the program that runs the models, built ${status.engine.recommendedVariant === "cpu" ? "for this PC's processor" : "for the NVIDIA card"}. It comes from llama.cpp's own releases.`}
            </p>
          </section>

          <section className="setup-block" aria-label="Models">
            <header><strong>Models</strong><span className="os-faint os-small">Pick at least one that can chat.</span></header>
            <ul className="setup-models">
              {status.catalog.map((model) => {
                const installing = running && Boolean(job?.steps.some((step) => step.kind === "model" && step.id === model.id && step.state !== "done"));
                const checked = model.installed || installing || selected.includes(model.id);
                return (
                  <li key={model.id} className={`${model.recommended ? "recommended" : ""} ${model.installed ? "installed" : ""}`}>
                    <label>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={model.installed || running}
                        onChange={() => toggle(model.id)}
                      />
                      <span className="setup-model-text">
                        <span className="setup-model-head">
                          <strong>{model.label}</strong>
                          {model.recommended ? <span className="setup-tag rec">Recommended for this PC</span> : null}
                          {model.installed ? <span className="setup-tag ok">Installed</span>
                            : installing ? <span className="setup-tag rec">Installing</span>
                              : <span className="os-faint os-small">{formatBytes(model.sizeBytes)}</span>}
                        </span>
                        <span>{model.summary}</span>
                        <span className="os-faint os-small">
                          Needs {model.needs}. Licence: <a href={model.license.url} target="_blank" rel="noreferrer">{model.license.name}</a>.
                        </span>
                      </span>
                    </label>
                    {mode === "settings" && model.installed ? (
                      <button type="button" className="os-btn os-btn-ghost os-btn-sm" disabled={busy || running} onClick={() => void remove(model.id)}>
                        <Icon name="trash" size={14} />Remove
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {mode === "settings" && others.length ? (
              <div className="setup-others">
                <span className="os-label">Also installed</span>
                <ul>
                  {others.map((model) => (
                    <li key={model.id}>
                      <span className="os-mono">{model.id}</span> <span className="os-faint os-small">{formatBytes(model.sizeBytes)}{model.vision ? " · pictures" : ""}</span>
                      <button type="button" className="os-btn os-btn-ghost os-btn-sm" disabled={busy || running} onClick={() => void remove(model.id)}><Icon name="trash" size={14} />Remove</button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>
        </>
      ) : null}

      {(status.tools ?? []).length > 0 ? (
        <section className="setup-block" aria-label="Voice, listening and video">
          <header>
            <strong>Voice, listening and video</strong>
            <span className="os-faint os-small">Optional. Each one switches on a part of TRH AI.</span>
          </header>
          <ul className="setup-models">
            {status.tools.map((tool) => {
              const installing = running && Boolean(job?.steps.some((step) => step.kind === "tool" && step.id === tool.id && step.state !== "done"));
              const checked = tool.installed || installing || selectedTools.includes(tool.id);
              return (
                <li key={tool.id} className={tool.installed ? "installed" : ""}>
                  <label>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={tool.installed || running || !tool.supported}
                      onChange={() => toggleTool(tool.id)}
                    />
                    <span className="setup-model-text">
                      <span className="setup-model-head">
                        <strong>{tool.label}</strong>
                        {tool.installed ? <span className="setup-tag ok">Installed</span>
                          : installing ? <span className="setup-tag rec">Installing</span>
                            : !tool.supported ? <span className="setup-tag todo">Windows only</span>
                              : <span className="os-faint os-small">{formatBytes(tool.sizeBytes)}</span>}
                      </span>
                      <span>{tool.summary}</span>
                      <span className="os-faint os-small">
                        Needs {tool.needs}. Licence: <a href={tool.license.url} target="_blank" rel="noreferrer">{tool.license.name}</a>.
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {job && job.steps.length > 0 && (running || job.state !== "done" || mode === "first-run") ? (
        <section className="setup-block setup-progress" aria-label="Install progress" aria-live="polite">
          <header>
            <strong>{running ? "Installing" : job.state === "done" ? "Installed" : job.state === "cancelled" ? "Stopped" : "Did not finish"}</strong>
            <span className="os-mono">{jobPercent(job)}%</span>
          </header>
          <div className="setup-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={jobPercent(job)}>
            <span style={{ width: `${jobPercent(job)}%` }} />
          </div>
          <ul className="setup-steps">
            {job.steps.map((step) => (
              <li key={`${step.kind}-${step.id}`} className={step.state}>
                <Icon name={step.state === "done" ? "check" : step.state === "failed" ? "alert" : "down"} size={14} />
                <span>{step.label}</span>
                <span className="os-faint os-small">{stepText(step)}</span>
              </li>
            ))}
          </ul>
          {job.state === "failed" && job.error ? <p className="setup-note bad" role="alert">{job.error}</p> : null}
        </section>
      ) : null}

      {note ? <p className={`setup-note ${note.tone}`} role={note.tone === "bad" ? "alert" : "status"}>{note.text}</p> : null}
      {tooBig ? <p className="setup-note bad">That needs about {formatBytes(needed * 1.1 + 1024 ** 3)} free, and the drive has {formatBytes(status.freeBytes ?? 0)}.</p> : null}

      <div className="os-view-actions">
        {running ? (
          <button type="button" className="os-btn" onClick={() => void stop()}><Icon name="stop" size={15} />Stop</button>
        ) : mode === "first-run" && !status.needsSetup && nothingToDo ? null : (
          <button type="button" className="os-btn os-btn-primary" disabled={busy || nothingToDo || tooBig || selected.length + toolsToInstall.length + (status.engine.installed ? 0 : 1) === 0} onClick={() => void install()}>
            <Icon name="down" size={15} />
            {job?.state === "failed" || job?.state === "cancelled" ? "Try again" : "Download and install"}{needed > 0 ? ` · ${formatBytes(needed)}` : ""}
          </button>
        )}
        {mode === "first-run" && !status.needsSetup && onDone ? (
          <button type="button" className="os-btn os-btn-primary" onClick={onDone}><Icon name="check" size={15} />Start using TRH AI</button>
        ) : null}
      </div>
      <p className="os-faint os-small">
        Everything comes from its makers&rsquo; own releases, and each file is checked against the fingerprint they published before it is used.
        A download that stops carries on from where it stopped. Stored in {status.runtimeDir}
        {status.freeBytes !== null ? `, which has ${formatBytes(status.freeBytes)} free` : ""}.
      </p>
    </div>
  );
}
