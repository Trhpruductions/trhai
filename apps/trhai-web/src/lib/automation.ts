// What the Automation workspace needs beyond the engine in @ascend/shared:
// the fields each kind of step is edited with, how deep each step sits in
// its IF blocks, a new step with sensible settings, and how long a run would
// spend waiting. Pure, so it is testable without a screen.

import type { Flow, FlowNode, NodeType } from "@ascend/shared";

export type NodeField = {
  key: string;
  label: string;
  kind: "text" | "number" | "select";
  placeholder?: string;
  options?: Array<{ value: string; label: string }>;
  hint?: string;
};

export type StepType = { type: NodeType; label: string; summary: string };

/** Every kind of step, in the order the add menu offers them. */
export const stepTypes: StepType[] = [
  { type: "run-script", label: "Run a check", summary: "Runs one of the desktop app's named checks - git status, typecheck, tests, build." },
  { type: "if", label: "If", summary: "Runs the steps under it only when a value matches." },
  { type: "else", label: "Else", summary: "Runs the steps under it when the IF above did not match." },
  { type: "end-if", label: "End if", summary: "Closes the IF block above." },
  { type: "wait", label: "Wait", summary: "Pauses for a number of seconds." },
  { type: "open-website", label: "Open a website", summary: "Opens a page. Shown in a dry run only." },
  { type: "email", label: "Send an email", summary: "Needs a connected mail account. Shown in a dry run only." },
  { type: "call-api", label: "Call an API", summary: "Needs an endpoint and credentials. Shown in a dry run only." },
  { type: "generate-image", label: "Generate an image", summary: "Needs an image provider. Shown in a dry run only." },
  { type: "discord-message", label: "Send a Discord message", summary: "Needs a bot token. Shown in a dry run only." }
];

/** The fields a step is edited with. Checks, when the desktop app lists them, are offered by name. */
export function fieldsFor(type: NodeType, checks: Array<{ name: string; label: string }> = []): NodeField[] {
  switch (type) {
    case "if":
      return [
        { key: "left", label: "Value", kind: "text", placeholder: "ok", hint: "ok, exitCode and output come from the last check that ran." },
        {
          key: "op", label: "Is", kind: "select",
          options: [
            { value: "==", label: "equal to" }, { value: "!=", label: "not equal to" },
            { value: "contains", label: "containing" }, { value: "exists", label: "set at all" }
          ]
        },
        { key: "right", label: "Compared with", kind: "text", placeholder: "true" }
      ];
    case "wait":
      return [{ key: "seconds", label: "Seconds", kind: "number", placeholder: "5" }];
    case "run-script":
      return checks.length
        ? [{ key: "check", label: "Check", kind: "select", options: checks.map((check) => ({ value: check.name, label: check.label })) }]
        : [{ key: "check", label: "Check", kind: "text", placeholder: "tests", hint: "The desktop app runs these: gitStatus, typecheck, tests, build." }];
    case "open-website":
      return [{ key: "url", label: "Address", kind: "text", placeholder: "https://example.com" }];
    case "email":
      return [{ key: "to", label: "To", kind: "text", placeholder: "someone@example.com" }, { key: "subject", label: "Subject", kind: "text" }];
    case "call-api":
      return [
        { key: "method", label: "Method", kind: "select", options: ["GET", "POST", "PUT", "DELETE"].map((value) => ({ value, label: value })) },
        { key: "url", label: "Address", kind: "text", placeholder: "https://api.example.com/..." }
      ];
    case "generate-image":
      return [{ key: "prompt", label: "Prompt", kind: "text" }];
    case "discord-message":
      return [{ key: "channel", label: "Channel", kind: "text", placeholder: "general" }, { key: "message", label: "Message", kind: "text" }];
    default:
      return [];
  }
}

/** A new step with settings it can run with as it stands, where it has any. */
export function newNode(type: NodeType, id: string, checks: Array<{ name: string }> = []): FlowNode {
  const defaults: Partial<Record<NodeType, Record<string, string>>> = {
    if: { left: "ok", op: "==", right: "true" },
    wait: { seconds: "5" },
    "run-script": { check: checks[0]?.name ?? "" },
    "call-api": { method: "GET" }
  };
  return { id, type, config: { ...(defaults[type] ?? {}) } };
}

export function newFlow(id: string): Flow {
  return { id, name: "My automation", nodes: [] };
}

/** How far in each step sits: inside an IF it is one deeper; ELSE and END IF line up with their IF. */
export function depths(flow: Flow): number[] {
  let depth = 0;
  return flow.nodes.map((node) => {
    if (node.type === "end-if") {
      depth = Math.max(0, depth - 1);
      return depth;
    }
    if (node.type === "else") return Math.max(0, depth - 1);
    const here = depth;
    if (node.type === "if") depth += 1;
    return here;
  });
}

/** Every second a run would wait, if every WAIT ran. */
export function totalWaitSeconds(flow: Flow): number {
  return flow.nodes
    .filter((node) => node.type === "wait")
    .reduce((sum, node) => sum + (Number.isFinite(Number(node.config.seconds)) ? Math.max(0, Number(node.config.seconds)) : 0), 0);
}

/**
 * The longest a run here may wait in all. The page has to stay open for a run
 * to finish, and a run that waits for an hour belongs on a schedule.
 */
export const maxLiveWaitSeconds = 120;

/** Whether two flows are the same, for "unsaved changes". */
export function sameFlow(a: Flow | null, b: Flow | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
