"use client";

import { useEffect, useMemo, useState } from "react";
import {
  appendNode, describeFlow, executeFlow, moveNode, nodeCapability, nodeLabels, parseFlow, removeNode, updateNodeConfig, validateFlow,
  type Flow, type NodeType, type RunResult
} from "@ascend/shared";
import { apiGet, apiPut } from "../../lib/api";
import { depths, fieldsFor, maxLiveWaitSeconds, newFlow, newNode, sameFlow, stepTypes, totalWaitSeconds } from "../../lib/automation";
import { Icon } from "../ui/Icon";
import { ViewFrame } from "../ui/ViewFrame";
import { useNav } from "../state/nav";
import { useNotify } from "../state/notify";
import { useSystem } from "../state/system";
import "./views.css";

// The saved automation flow, edited as a readable outline: steps in order,
// IF blocks indented, each step with what it does and whether it can really
// run here. A dry run says what every step would do and does nothing; a run
// here does it, in this window. Checks run through the desktop app's fixed
// list - in a plain browser there is no way to run one, and the run says so.
// Steps that need someone's account - email, APIs, images, Discord - only
// ever dry-run: this build carries no credentials, and never reports a step
// as done that sent nothing.

type DesktopBridge = {
  listWorkspaceChecks?: () => Promise<{ ok: boolean; checks?: Array<{ name: string; label: string }> }>;
  runWorkspaceCheck?: (payload: { check: string }) => Promise<{ ok: boolean; exitCode: number; error?: string }>;
};

const statusTone: Record<string, string> = { ok: "ok", skipped: "", failed: "danger", "dry-run": "accent" };
const statusWords: Record<string, string> = { ok: "Done", skipped: "Skipped", failed: "Failed", "dry-run": "Would run" };

const makeId = () => `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export function AutomationView() {
  const { schedules } = useSystem();
  const { go } = useNav();
  const { notify } = useNotify();
  const [saved, setSaved] = useState<Flow | null>(null);
  const [draft, setDraft] = useState<Flow | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [bridge, setBridge] = useState<DesktopBridge | null>(null);
  const [checks, setChecks] = useState<Array<{ name: string; label: string }>>([]);
  const [run, setRun] = useState<RunResult | null>(null);
  const [running, setRunning] = useState<"dry" | "live" | null>(null);
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    void apiGet<{ flow: unknown }>("/v1/flow").then((result) => {
      if (!result.ok) {
        setProblem(result.reason);
        return;
      }
      const stored = result.data.flow ? parseFlow(result.data.flow) : null;
      setSaved(stored);
      setDraft(stored ?? newFlow(makeId()));
    });
  }, []);

  // The desktop app's check runner, when this page is inside it.
  useEffect(() => {
    const desktop = (window as unknown as { ascendDesktop?: DesktopBridge }).ascendDesktop;
    if (!desktop?.runWorkspaceCheck) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the bridge exists only in the desktop app, unknowable before the page is in it
    setBridge(desktop);
    void desktop.listWorkspaceChecks?.().then((listed) => {
      if (listed?.ok && listed.checks) setChecks(listed.checks);
    });
  }, []);

  const issues = useMemo(() => (draft ? validateFlow(draft) : []), [draft]);
  const outline = useMemo(() => (draft ? describeFlow(draft) : []), [draft]);
  const levels = useMemo(() => (draft ? depths(draft) : []), [draft]);
  const waiting = draft ? totalWaitSeconds(draft) : 0;
  const unsaved = draft !== null && !sameFlow(draft, saved);
  const usesFlow = (schedules ?? []).filter((schedule) => schedule.actionLabel === "Runs the saved flow");
  const hasChecks = draft?.nodes.some((node) => node.type === "run-script") ?? false;

  const edit = (next: Flow) => {
    setDraft(next);
    setRun(null);
  };

  const add = (type: NodeType) => {
    if (!draft) return;
    edit(appendNode(draft, newNode(type, makeId(), checks)));
    setAdding(false);
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    const result = await apiPut<{ flow: Flow }>("/v1/flow", { flow: draft });
    setSaving(false);
    if (!result.ok) {
      notify({ level: "error", title: "The flow did not save", body: result.reason, source: "AUTOMATION" });
      return;
    }
    setSaved(result.data.flow);
    setDraft(result.data.flow);
    notify({ level: "success", title: "Flow saved", body: "Schedules that run the flow use this version.", source: "AUTOMATION" });
  };

  const start = async (dryRun: boolean) => {
    if (!draft) return;
    setRunning(dryRun ? "dry" : "live");
    const runScript = bridge?.runWorkspaceCheck
      ? async (check: string) => {
        const outcome = await bridge.runWorkspaceCheck!({ check });
        return { ok: outcome.ok, exitCode: outcome.exitCode, ...(outcome.error ? { output: outcome.error } : {}) };
      }
      : undefined;
    try {
      setRun(await executeFlow(draft, { dryRun, runScript }));
    } catch (error) {
      notify({ level: "error", title: "The run stopped", body: error instanceof Error ? error.message : "Something went wrong.", source: "AUTOMATION" });
    } finally {
      setRunning(null);
    }
  };

  const liveBlocked = issues.length > 0 ? "Fix the steps marked below first."
    : waiting > maxLiveWaitSeconds ? `It waits ${waiting} seconds in all - longer than ${maxLiveWaitSeconds} is for a schedule, not this window.`
      : null;

  return (
    <ViewFrame
      id="automation"
      actions={(
        <>
          {draft ? <span className={`os-chip ${unsaved ? "warn" : "ok"}`}>{unsaved ? "Unsaved changes" : saved ? "Saved" : "Not saved yet"}</span> : null}
          <span className={`os-chip ${bridge ? "accent" : ""}`} title={bridge ? "Checks run through TRH AI's desktop app" : "Open TRH AI's desktop app to run checks"}>
            {bridge ? "Checks: desktop app" : "Checks: desktop app only"}
          </span>
        </>
      )}
    >
      {problem ? <p className="os-task-alert" role="alert"><Icon name="alert" size={14} />Could not read the saved flow: {problem}</p> : null}
      {!draft ? <div className="os-panel"><p className="os-faint os-browser-pad">Reading the saved flow…</p></div> : (
        <div className="os-tasks-layout">
          <div className="os-tasks-main">
            <section className="os-panel" aria-label="The flow">
              <header className="os-panel-head">
                <input className="os-input os-flow-name" value={draft.name} onChange={(event) => edit({ ...draft, name: event.target.value })}
                  aria-label="Flow name" maxLength={80} />
                <div className="os-panel-tools">
                  <button type="button" className="os-btn os-btn-sm" disabled={running !== null || draft.nodes.length === 0} onClick={() => void start(true)}>
                    <Icon name="eye" size={14} />{running === "dry" ? "Running…" : "Dry run"}
                  </button>
                  <button type="button" className="os-btn os-btn-sm" disabled={running !== null || draft.nodes.length === 0 || liveBlocked !== null}
                    title={liveBlocked ?? "Runs it now, in this window"} onClick={() => void start(false)}>
                    <Icon name="play" size={14} />{running === "live" ? "Running…" : "Run here"}
                  </button>
                  <button type="button" className="os-btn os-btn-sm os-btn-primary" disabled={!unsaved || saving || issues.length > 0} onClick={() => void save()}>
                    <Icon name="check" size={14} />{saving ? "Saving…" : "Save"}
                  </button>
                </div>
              </header>
              <div className="os-panel-body os-stack">
                {liveBlocked && draft.nodes.length ? <p className="os-faint os-small">{liveBlocked}</p> : null}
                {hasChecks && !bridge ? (
                  <p className="os-task-alert"><Icon name="info" size={14} />In a browser there is nothing to run a check with. A run here skips them and says so - open TRH AI&rsquo;s desktop app to run them.</p>
                ) : null}
                {draft.nodes.length === 0 ? (
                  <div className="os-empty">
                    <strong>No steps yet</strong>
                    <p>Add a check, an IF to act on how it went, and a wait between - then dry-run it to see what it would do.</p>
                  </div>
                ) : (
                  <ol className="os-flow">
                    {draft.nodes.map((node, index) => {
                      const step = stepTypes.find((entry) => entry.type === node.type);
                      const fields = fieldsFor(node.type, checks);
                      const issue = issues.find((entry) => entry.nodeId === node.id);
                      const runsHere = nodeCapability(node.type) === "executable";
                      return (
                        <li key={node.id} className={`os-flow-step${issue ? " problem" : ""}`} style={{ marginLeft: `${Math.min(levels[index], 4) * 20}px` }}>
                          <div className="os-flow-head">
                            <span className="os-flow-label os-mono">{nodeLabels[node.type]}</span>
                            <span className="os-flow-name-label">{step?.label}</span>
                            <span className={`os-chip ${runsHere ? "ok" : ""}`} title={step?.summary}>{runsHere ? "Runs here" : "Dry run only"}</span>
                            <div className="os-flow-actions">
                              <button type="button" className="os-btn os-btn-ghost os-btn-icon os-btn-sm" aria-label={`Move ${step?.label} up`} disabled={index === 0}
                                onClick={() => edit(moveNode(draft, node.id, -1))}><Icon name="up" size={14} /></button>
                              <button type="button" className="os-btn os-btn-ghost os-btn-icon os-btn-sm" aria-label={`Move ${step?.label} down`} disabled={index === draft.nodes.length - 1}
                                onClick={() => edit(moveNode(draft, node.id, 1))}><Icon name="down" size={14} /></button>
                              <button type="button" className="os-btn os-btn-ghost os-btn-icon os-btn-sm" aria-label={`Remove ${step?.label}`}
                                onClick={() => edit(removeNode(draft, node.id))}><Icon name="trash" size={14} /></button>
                            </div>
                          </div>
                          {fields.length ? (
                            <div className="os-flow-fields">
                              {fields.map((field) => (
                                <label key={field.key} className="os-field">
                                  <span className="os-label">{field.label}</span>
                                  {field.kind === "select" ? (
                                    <select className="os-input" value={node.config[field.key] ?? ""} onChange={(event) => edit(updateNodeConfig(draft, node.id, field.key, event.target.value))}>
                                      {!node.config[field.key] ? <option value="">Choose…</option> : null}
                                      {field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                                    </select>
                                  ) : (
                                    <input className="os-input" type={field.kind === "number" ? "number" : "text"} min={field.kind === "number" ? 0 : undefined}
                                      value={node.config[field.key] ?? ""} placeholder={field.placeholder}
                                      onChange={(event) => edit(updateNodeConfig(draft, node.id, field.key, event.target.value))} />
                                  )}
                                  {field.hint ? <span className="os-faint os-small">{field.hint}</span> : null}
                                </label>
                              ))}
                            </div>
                          ) : null}
                          {issue ? <p className="os-flow-issue"><Icon name="alert" size={13} />{issue.message}</p> : null}
                        </li>
                      );
                    })}
                  </ol>
                )}
                {adding ? (
                  <div className="os-flow-add" role="group" aria-label="Add a step">
                    {stepTypes.map((step) => (
                      <button key={step.type} type="button" className="os-flow-add-option" onClick={() => add(step.type)}>
                        <strong>{step.label}</strong>
                        <span>{step.summary}</span>
                      </button>
                    ))}
                    <button type="button" className="os-btn os-btn-sm" onClick={() => setAdding(false)}>Cancel</button>
                  </div>
                ) : (
                  <button type="button" className="os-btn os-btn-sm os-flow-add-button" onClick={() => setAdding(true)}><Icon name="plus" size={14} />Add a step</button>
                )}
              </div>
            </section>

            {run ? (
              <section className="os-panel" aria-label="The last run">
                <header className="os-panel-head">
                  <h3 className="os-panel-title">{run.dryRun ? "Dry run" : "Run"}</h3>
                  <span className={`os-chip ${run.failed ? "danger" : "ok"}`}>{run.failed ? "Stopped at a failure" : run.dryRun ? "Nothing was run" : "Finished"}</span>
                </header>
                <div className="os-panel-body os-stack">
                  <ol className="os-flow-log">
                    {run.steps.map((step, index) => {
                      // IF and ELSE decide; they are taken or not, never "done".
                      const decides = step.label === "IF" || step.label === "ELSE";
                      const word = decides && step.status === "ok" ? "Taken"
                        : decides && step.status === "skipped" ? "Not taken"
                          : statusWords[step.status] ?? step.status;
                      return (
                        <li key={`${step.nodeId}-${index}`}>
                          <span className={`os-chip ${decides ? "" : statusTone[step.status] ?? ""}`}>{word}</span>
                          <span className="os-mono os-small">{step.label}</span>
                          <span className="os-flow-log-message">{step.message}</span>
                        </li>
                      );
                    })}
                  </ol>
                  {run.dryRun && run.steps.some((step) => step.label === "IF") ? (
                    <p className="os-faint os-small">In a dry run no check runs, so a condition reads its value as unset - the branch shown is the one taken when nothing has run.</p>
                  ) : null}
                  {Object.keys(run.context).length ? (
                    <p className="os-faint os-small os-mono">After the run: {Object.entries(run.context).map(([key, value]) => `${key} = ${value}`).join(" · ")}</p>
                  ) : null}
                </div>
              </section>
            ) : null}
          </div>

          <aside className="os-tasks-side">
            <section className="os-panel" aria-label="How it reads">
              <header className="os-panel-head"><h3 className="os-panel-title">How it reads</h3></header>
              <div className="os-panel-body">
                {outline.length ? <pre className="os-flow-outline">{outline.join("\n")}</pre> : <p className="os-faint os-small">The flow, as one outline, appears here.</p>}
              </div>
            </section>
            <section className="os-panel" aria-label="On a schedule">
              <header className="os-panel-head"><h3 className="os-panel-title">On a schedule</h3></header>
              <div className="os-panel-body os-stack">
                {usesFlow.length ? (
                  <ul className="os-flow-schedules">
                    {usesFlow.map((schedule) => (
                      <li key={schedule.id}>
                        <strong>{schedule.name}</strong>
                        <span className="os-faint os-small">{schedule.cadenceLabel}{schedule.enabled ? "" : " · paused"}{schedule.lastStatus ? ` · last: ${schedule.lastStatus}` : ""}</span>
                      </li>
                    ))}
                  </ul>
                ) : <p className="os-faint os-small">No schedule runs this flow.</p>}
                <p className="os-faint os-small">A schedule runs the saved version, from TRH AI&rsquo;s service - where there is no desktop app, so checks are skipped and the run log says so.</p>
                <button type="button" className="os-btn os-btn-sm" onClick={() => go("tasks")}><Icon name="clock" size={14} />Schedule it in Tasks</button>
              </div>
            </section>
          </aside>
        </div>
      )}
    </ViewFrame>
  );
}
