import { useEffect, useState } from "react";
import {
  appendNode,
  capabilityReason,
  executeFlow,
  moveNode,
  nodeCapability,
  nodeLabels,
  readFlow,
  removeNode,
  rewindPoint,
  updateNodeConfig,
  validateFlow,
  writeFlow,
  type Flow,
  type NodeType,
  type RunResult
} from "../../automation";
import { Surface } from "../Surface";
import "./automation.css";

// Automation: flows you can actually run.
//
// The distinction this screen has to make unmistakable is which steps really
// execute here. Control flow and RUN SCRIPT do; anything needing a credential
// this build does not carry cannot, and is marked before you add it as well as
// after you run it. A green tick on a message that was never sent would be the
// worst failure this screen could have.

const storageKey = "ascend.automation.flow.v1";

const starterFlow: Flow = {
  id: "flow-1",
  name: "Test and report",
  nodes: [
    { id: "n1", type: "run-script", config: { check: "tests" } },
    { id: "n2", type: "if", config: { left: "ok", op: "==", right: "true" } },
    { id: "n3", type: "discord-message", config: { channel: "builds" } },
    { id: "n4", type: "else", config: {} },
    { id: "n5", type: "email", config: { to: "me@example.com" } },
    { id: "n6", type: "end-if", config: {} }
  ]
};

const palette: NodeType[] = [
  "if", "else", "end-if", "wait", "run-script",
  "open-website", "email", "call-api", "generate-image", "discord-message"
];

type ConfigField = {
  key: string;
  label: string;
  placeholder: string;
  /** Renders a picker of the desktop shell's named checks instead of a text box. */
  checkPicker?: true;
};

const configFields: Partial<Record<NodeType, ConfigField[]>> = {
  if: [
    { key: "left", label: "Variable", placeholder: "ok" },
    { key: "op", label: "Test", placeholder: "==" },
    { key: "right", label: "Value", placeholder: "true" }
  ],
  wait: [{ key: "seconds", label: "Seconds", placeholder: "30" }],
  "run-script": [{ key: "check", label: "Check", placeholder: "", checkPicker: true }],
  "open-website": [{ key: "url", label: "URL", placeholder: "https://example.com" }],
  email: [{ key: "to", label: "To", placeholder: "me@example.com" }],
  "call-api": [
    { key: "method", label: "Method", placeholder: "GET" },
    { key: "url", label: "URL", placeholder: "https://api.example.com" }
  ],
  "generate-image": [{ key: "prompt", label: "Prompt", placeholder: "a red bicycle" }],
  "discord-message": [{ key: "channel", label: "Channel", placeholder: "builds" }]
};

export function AutomationSurface() {
  const [flow, setFlow] = useState<Flow>(() => readFlow(window.localStorage, storageKey) ?? starterFlow);
  const [run, setRun] = useState<RunResult | null>(null);
  // Bumped on every completed run, so a status chip that reads the same as
  // the last one — "Run finished" twice in a row — still arrives as its own
  // event rather than looking like it never updated.
  const [runSeq, setRunSeq] = useState(0);
  const [running, setRunning] = useState(false);
  // Named checks the desktop shell will actually accept. Empty in a browser,
  // where RUN SCRIPT is reported as skipped rather than offered.
  const [checks, setChecks] = useState<Array<{ name: string; label: string }>>([]);

  useEffect(() => {
    const list = window.ascendDesktop?.listWorkspaceChecks;
    if (!list) return;
    let cancelled = false;

    void list().then((result) => {
      if (!cancelled && result?.ok) setChecks(result.checks ?? []);
    }).catch(() => {
      // An empty list leaves the picker showing only "Choose a check…",
      // which is accurate: nothing is runnable from here.
    });

    return () => { cancelled = true; };
  }, []);

  const issues = validateFlow(flow);
  const rewind = run ? rewindPoint(run) : null;

  function commit(next: Flow) {
    setFlow(next);
    writeFlow(window.localStorage, storageKey, next);
  }

  async function execute(dryRun: boolean, stopAfter?: number) {
    if (running) return;
    setRunning(true);

    try {
      const runner = window.ascendDesktop?.runWorkspaceCheck;
      const result = await executeFlow(flow, {
        dryRun,
        stopAfter,
        // Only a live run in the desktop app gets a real command runner. In a
        // browser RUN SCRIPT reports that it was skipped, rather than appearing
        // to have succeeded.
        runScript: !dryRun && runner
          ? async (check) => {
            const outcome = await runner({ check });
            return { ok: Boolean(outcome?.ok), exitCode: outcome?.ok ? 0 : 1, output: outcome?.error ?? "" };
          }
          : undefined
      });
      setRun(result);
      setRunSeq((count) => count + 1);
    } finally {
      setRunning(false);
    }
  }

  return (
    <Surface
      title="Automation"
      summary="Blocks that run in order. Control flow and scripts execute for real; steps needing credentials this build does not carry are dry-run only, and say so rather than reporting success."
      count={`${flow.nodes.length} steps`}
      readable={false}
      actions={
        <>
          <button type="button" className="btn btn-sm" disabled={running} onClick={() => void execute(true)}>
            Dry run
          </button>
          <button type="button" className="btn btn-primary btn-sm" disabled={running || issues.length > 0}
            title={issues.length > 0 ? "Fix the errors first" : "Runs the executable steps"}
            onClick={() => void execute(false)}>
            Run
          </button>
          {rewind?.resumeNodeId ? (
            <button type="button" className="btn btn-sm" disabled={running}
              onClick={() => void execute(false, rewind.keepSteps)}>
              Replay to failure
            </button>
          ) : null}
        </>
      }
    >
      {issues.length > 0 ? (
        <ul className="flow-issues">
          {issues.map((issue, index) => <li key={`${issue.nodeId}-${index}`}>{issue.message}</li>)}
        </ul>
      ) : null}

      {run ? (
        <span key={runSeq} className={`chip chip-arrive ${run.dryRun ? "chip-live" : run.failed ? "chip-warn" : "chip-ok"}`}>
          {run.dryRun ? "Dry run — nothing was executed" : run.failed ? "Run failed" : "Run finished"}
        </span>
      ) : null}

      <ol className="flow">
        {flow.nodes.map((node) => {
          const step = run?.steps.find((entry) => entry.nodeId === node.id);
          const gated = nodeCapability(node.type) === "needs-credentials";
          const fields = configFields[node.type] ?? [];

          return (
            <li key={node.id} className={`panel flow-node${step ? ` step-${step.status}` : ""}`}>
              <div className="row flow-node-head">
                <strong className="flow-node-label">{nodeLabels[node.type]}</strong>
                {gated ? (
                  <span className="chip chip-warn" title={capabilityReason(node.type)}>dry-run only</span>
                ) : null}
                {step ? <span className={`chip chip-${step.status === "ok" ? "ok" : step.status === "failed" ? "danger" : "warn"}`}>{step.status}</span> : null}

                <div className="row flow-node-actions">
                  <button type="button" className="btn btn-ghost btn-sm" aria-label={`Move ${nodeLabels[node.type]} up`}
                    onClick={() => commit(moveNode(flow, node.id, -1))}>↑</button>
                  <button type="button" className="btn btn-ghost btn-sm" aria-label={`Move ${nodeLabels[node.type]} down`}
                    onClick={() => commit(moveNode(flow, node.id, 1))}>↓</button>
                  <button type="button" className="btn btn-ghost btn-sm" aria-label={`Remove ${nodeLabels[node.type]}`}
                    onClick={() => commit(removeNode(flow, node.id))}>×</button>
                </div>
              </div>

              {fields.length > 0 ? (
                <div className="row wrap flow-config">
                  {fields.map((field) => (
                    <label key={field.key} className="flow-field">
                      <span className="label">{field.label}</span>
                      {field.checkPicker ? (
                        // A fixed set, not typed text: RUN SCRIPT can only name
                        // a check the desktop shell already defines, so a flow
                        // cannot carry a command line for it to run.
                        <select
                          className="field"
                          value={node.config[field.key] ?? ""}
                          aria-label={`${nodeLabels[node.type]} ${field.label}`}
                          onChange={(event) => commit(updateNodeConfig(flow, node.id, field.key, event.target.value))}
                        >
                          <option value="">
                            {checks.length === 0 ? "Needs the desktop app" : "Choose a check…"}
                          </option>
                          {checks.map((check) => (
                            <option key={check.name} value={check.name}>{check.label}</option>
                          ))}
                          {/* A saved flow opened in a browser has a check the
                              list cannot confirm, because the list only exists
                              in the desktop shell. Showing it anyway keeps the
                              stored value visible and selected — without this
                              the select falls back to the empty option and a
                              perfectly good flow reads as unconfigured. */}
                          {node.config[field.key]
                            && !checks.some((check) => check.name === node.config[field.key])
                            ? (
                              <option value={node.config[field.key]}>
                                {node.config[field.key]}
                              </option>
                            )
                            : null}
                        </select>
                      ) : (
                        <input
                          className="field"
                          value={node.config[field.key] ?? ""}
                          placeholder={field.placeholder}
                          aria-label={`${nodeLabels[node.type]} ${field.label}`}
                          onChange={(event) => commit(updateNodeConfig(flow, node.id, field.key, event.target.value))}
                        />
                      )}
                    </label>
                  ))}
                </div>
              ) : null}

              {step ? <p className="faint flow-step-log">{step.message}</p> : null}
            </li>
          );
        })}
      </ol>

      <div className="row wrap flow-palette">
        {palette.map((type) => (
          <button key={type} type="button" className="btn btn-sm" title={capabilityReason(type)}
            onClick={() => commit(appendNode(flow, { id: crypto.randomUUID(), type, config: {} }))}>
            {nodeLabels[type]}
            {/* Marked before you add it, not only after you run it. */}
            {nodeCapability(type) === "needs-credentials" ? <span className="flow-gated-mark">·</span> : null}
          </button>
        ))}
      </div>
    </Surface>
  );
}
