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
    { id: "n1", type: "run-script", config: { command: "npm test" } },
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

const configFields: Partial<Record<NodeType, Array<{ key: string; label: string; placeholder: string }>>> = {
  if: [
    { key: "left", label: "Variable", placeholder: "ok" },
    { key: "op", label: "Test", placeholder: "==" },
    { key: "right", label: "Value", placeholder: "true" }
  ],
  wait: [{ key: "seconds", label: "Seconds", placeholder: "30" }],
  "run-script": [{ key: "command", label: "Command", placeholder: "npm test" }],
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
      const runner = window.ascendDesktop?.runWorkspaceCommand;
      const result = await executeFlow(flow, {
        dryRun,
        stopAfter,
        // Only a live run in the desktop app gets a real command runner. In a
        // browser RUN SCRIPT reports that it was skipped, rather than appearing
        // to have succeeded.
        runScript: !dryRun && runner
          ? async (command) => {
            const outcome = await runner({ command });
            return { ok: Boolean(outcome?.ok), exitCode: outcome?.ok ? 0 : 1, output: outcome?.error ?? "" };
          }
          : undefined
      });
      setRun(result);
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
        <span className={`chip ${run.dryRun ? "chip-live" : run.failed ? "chip-warn" : "chip-ok"}`}>
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
