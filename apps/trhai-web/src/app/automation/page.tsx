"use client";

import { useState } from "react";
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
} from "@ascend/shared";
import { Schedules } from "../../components/Schedules";
import "./automation.css";

// Automation: flows you can actually run, against @ascend/shared's
// automation.ts - the same engine Vexora's own Automation panel uses.
//
// TRHAI has no window.ascendDesktop at all, so RUN SCRIPT has no runner to
// pass in here - executeFlow already handles that honestly on its own,
// reporting the step "skipped ... needs the desktop bridge" rather than
// this screen needing to fake or hide the gap. Control flow (IF/ELSE/WAIT)
// still executes for real; anything needing a credential this build does
// not carry is dry-run only and says so before you add it, not only after
// you run it.

const storageKey = "trhai.automation.flow.v1";

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

type ConfigField = { key: string; label: string; placeholder: string };

const configFields: Partial<Record<NodeType, ConfigField[]>> = {
  if: [
    { key: "left", label: "Variable", placeholder: "ok" },
    { key: "op", label: "Test", placeholder: "==" },
    { key: "right", label: "Value", placeholder: "true" }
  ],
  wait: [{ key: "seconds", label: "Seconds", placeholder: "30" }],
  "run-script": [{ key: "check", label: "Check", placeholder: "tests" }],
  "open-website": [{ key: "url", label: "URL", placeholder: "https://example.com" }],
  email: [{ key: "to", label: "To", placeholder: "me@example.com" }],
  "call-api": [
    { key: "method", label: "Method", placeholder: "GET" },
    { key: "url", label: "URL", placeholder: "https://api.example.com" }
  ],
  "generate-image": [{ key: "prompt", label: "Prompt", placeholder: "a red bicycle" }],
  "discord-message": [{ key: "channel", label: "Channel", placeholder: "builds" }]
};

function readStoredFlow(): Flow {
  if (typeof window === "undefined") return starterFlow;
  return readFlow(window.localStorage, storageKey) ?? starterFlow;
}

export default function AutomationPage() {
  const [flow, setFlow] = useState<Flow>(readStoredFlow);
  const [run, setRun] = useState<RunResult | null>(null);
  const [runSeq, setRunSeq] = useState(0);
  const [running, setRunning] = useState(false);

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
      // No runScript passed — TRHAI has no desktop bridge, so a live run
      // reports RUN SCRIPT as skipped for the same honest reason a browser
      // tab of Vexora does.
      const result = await executeFlow(flow, { dryRun, stopAfter });
      setRun(result);
      setRunSeq((count) => count + 1);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="automation">
      <header className="automation-head">
        <h1>Automation</h1>
        <p className="muted">
          Blocks that run in order. Control flow executes for real; steps needing credentials
          this build does not carry are dry-run only, and say so rather than reporting success.
        </p>
        <div className="automation-actions">
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
        </div>
      </header>

      {issues.length > 0 ? (
        <ul className="automation-issues">
          {issues.map((issue, index) => <li key={`${issue.nodeId}-${index}`}>{issue.message}</li>)}
        </ul>
      ) : null}

      {run ? (
        <span key={runSeq} className={`chip ${run.dryRun ? "chip-live" : run.failed ? "chip-warn" : "chip-ok"}`}>
          {run.dryRun ? "Dry run — nothing was executed" : run.failed ? "Run failed" : "Run finished"}
        </span>
      ) : null}

      <ol className="automation-flow">
        {flow.nodes.map((node) => {
          const step = run?.steps.find((entry) => entry.nodeId === node.id);
          const gated = nodeCapability(node.type) === "needs-credentials";
          const fields = configFields[node.type] ?? [];

          return (
            <li key={node.id} className={`panel automation-node${step ? ` automation-step-${step.status}` : ""}`}>
              <div className="automation-node-head">
                <strong className="automation-node-label">{nodeLabels[node.type]}</strong>
                {gated ? (
                  <span className="chip chip-warn" title={capabilityReason(node.type)}>dry-run only</span>
                ) : null}
                {step ? (
                  <span className={`chip ${step.status === "ok" ? "chip-ok" : step.status === "failed" ? "chip-danger" : "chip-warn"}`}>
                    {step.status}
                  </span>
                ) : null}

                <div className="automation-node-actions">
                  <button type="button" className="btn btn-ghost btn-sm" aria-label={`Move ${nodeLabels[node.type]} up`}
                    onClick={() => commit(moveNode(flow, node.id, -1))}>↑</button>
                  <button type="button" className="btn btn-ghost btn-sm" aria-label={`Move ${nodeLabels[node.type]} down`}
                    onClick={() => commit(moveNode(flow, node.id, 1))}>↓</button>
                  <button type="button" className="btn btn-ghost btn-sm" aria-label={`Remove ${nodeLabels[node.type]}`}
                    onClick={() => commit(removeNode(flow, node.id))}>×</button>
                </div>
              </div>

              {fields.length > 0 ? (
                <div className="automation-config">
                  {fields.map((field) => (
                    <label key={field.key} className="automation-field">
                      <span className="hud-label">{field.label}</span>
                      <input
                        className="field"
                        value={node.config[field.key] ?? ""}
                        placeholder={field.placeholder}
                        aria-label={`${nodeLabels[node.type]} ${field.label}`}
                        onChange={(event) => commit(updateNodeConfig(flow, node.id, field.key, event.target.value))}
                      />
                    </label>
                  ))}
                </div>
              ) : null}

              {step ? <p className="faint automation-step-log">{step.message}</p> : null}
            </li>
          );
        })}
      </ol>

      <div className="automation-palette">
        {palette.map((type) => (
          <button key={type} type="button" className="btn btn-sm" title={capabilityReason(type)}
            onClick={() => commit(appendNode(flow, { id: crypto.randomUUID(), type, config: {} }))}>
            {nodeLabels[type]}
            {nodeCapability(type) === "needs-credentials" ? <span className="automation-gated-mark">·</span> : null}
          </button>
        ))}
      </div>

      {/* Separate from the flow above on purpose. A flow is a thing you run
          by hand from this page; a schedule is a thing the API runs on a
          timer without anyone here. They are not yet connected — a schedule
          asks TRHAI a question, it cannot trigger the flow — and pretending
          otherwise by putting them in one box would be the wrong shape. */}
      <Schedules />
    </div>
  );
}
