// Visual automation engine (vision §11).
//
// The primitives the vision names: IF, ELSE, WAIT, EMAIL, OPEN WEBSITE, RUN
// SCRIPT, CALL API, GENERATE IMAGE, SEND DISCORD MESSAGE. Requirements: a
// human-readable execution graph, dry-run mode, per-node logs, and error rewind
// and replay.
//
// Two things drive the design.
//
// Only some primitives can really run here. RUN SCRIPT executes through the
// desktop command bridge, and IF/ELSE/WAIT are pure control flow, so those are
// genuinely real. EMAIL, CALL API, GENERATE IMAGE and SEND DISCORD MESSAGE all
// need third-party credentials this build deliberately does not carry — they are
// dry-run only, and in a live run they are *skipped with a stated reason* rather
// than reported as succeeded. A green check on a step that sent nothing is the
// worst failure mode an automation tool can have.
//
// Execution is a flat list with block markers rather than a node graph with
// edges. A list is what the UI can render as a readable outline, and matching
// IF/ELSE/END-IF is checkable up front, so an invalid graph is refused before it
// runs instead of half-executing.

export type NodeType =
  | "if"
  | "else"
  | "end-if"
  | "wait"
  | "run-script"
  | "open-website"
  | "email"
  | "call-api"
  | "generate-image"
  | "discord-message";

export type ComparisonOp = "==" | "!=" | "contains" | "exists";

export type FlowNode = {
  id: string;
  type: NodeType;
  /** Free-form per-type settings; see nodeSummary for what each reads. */
  config: Record<string, string>;
};

export type Flow = {
  id: string;
  name: string;
  nodes: FlowNode[];
};

/** Whether a node can actually take effect in this build. */
export type NodeCapability = "executable" | "needs-credentials";

const capabilities: Record<NodeType, NodeCapability> = {
  if: "executable",
  else: "executable",
  "end-if": "executable",
  wait: "executable",
  "run-script": "executable",
  // Opening a URL leaves the app and is outward-facing, so it stays behind the
  // same gate as the credentialed actions rather than firing unattended.
  "open-website": "needs-credentials",
  email: "needs-credentials",
  "call-api": "needs-credentials",
  "generate-image": "needs-credentials",
  "discord-message": "needs-credentials"
};

const capabilityReasons: Partial<Record<NodeType, string>> = {
  "open-website": "Opening a URL leaves the app; it runs only in a dry run here.",
  email: "Sending mail needs a connected mail account.",
  "call-api": "Calling an external API needs an endpoint and credentials.",
  "generate-image": "Image generation needs a provider credential.",
  "discord-message": "Posting to Discord needs a bot token and channel."
};

export function nodeCapability(type: NodeType): NodeCapability {
  return capabilities[type];
}

export function capabilityReason(type: NodeType): string | undefined {
  return capabilityReasons[type];
}

export const nodeLabels: Record<NodeType, string> = {
  if: "IF",
  else: "ELSE",
  "end-if": "END IF",
  wait: "WAIT",
  "run-script": "RUN SCRIPT",
  "open-website": "OPEN WEBSITE",
  email: "EMAIL",
  "call-api": "CALL API",
  "generate-image": "GENERATE IMAGE",
  "discord-message": "SEND DISCORD MESSAGE"
};

/** One readable line describing what a node will do. */
export function nodeSummary(node: FlowNode): string {
  switch (node.type) {
    case "if":
      return `IF ${node.config.left ?? "?"} ${node.config.op ?? "=="} ${node.config.right ?? ""}`.trim();
    case "else":
      return "ELSE";
    case "end-if":
      return "END IF";
    case "wait":
      return `WAIT ${node.config.seconds ?? "0"}s`;
    case "run-script":
      return `RUN SCRIPT ${node.config.check ?? "(no check)"}`;
    case "open-website":
      return `OPEN WEBSITE ${node.config.url ?? "(no url)"}`;
    case "email":
      return `EMAIL ${node.config.to ?? "(no recipient)"}`;
    case "call-api":
      return `CALL API ${node.config.method ?? "GET"} ${node.config.url ?? "(no url)"}`;
    case "generate-image":
      return `GENERATE IMAGE ${node.config.prompt ?? "(no prompt)"}`;
    case "discord-message":
      return `SEND DISCORD MESSAGE #${node.config.channel ?? "(no channel)"}`;
    default:
      return node.type;
  }
}

export type ValidationIssue = { nodeId: string | null; message: string };

/**
 * Reject a graph that cannot be executed, before anything runs.
 * Half-executing a malformed flow and failing at the broken node would leave
 * whatever ran before it already done.
 */
export function validateFlow(flow: Flow): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const stack: Array<{ nodeId: string; seenElse: boolean }> = [];

  for (const node of flow.nodes) {
    if (node.type === "if") {
      stack.push({ nodeId: node.id, seenElse: false });
      if (!node.config.left) {
        issues.push({ nodeId: node.id, message: "IF needs something to compare." });
      }
    } else if (node.type === "else") {
      const open = stack.at(-1);
      if (!open) {
        issues.push({ nodeId: node.id, message: "ELSE has no matching IF." });
      } else if (open.seenElse) {
        issues.push({ nodeId: node.id, message: "This IF already has an ELSE." });
      } else {
        open.seenElse = true;
      }
    } else if (node.type === "end-if") {
      if (stack.pop() === undefined) {
        issues.push({ nodeId: node.id, message: "END IF has no matching IF." });
      }
    } else if (node.type === "run-script" && !node.config.check) {
      issues.push({ nodeId: node.id, message: "RUN SCRIPT needs a check." });
    } else if (node.type === "wait") {
      const seconds = Number(node.config.seconds);
      if (!Number.isFinite(seconds) || seconds < 0) {
        issues.push({ nodeId: node.id, message: "WAIT needs a non-negative number of seconds." });
      }
    }
  }

  for (const open of stack) {
    issues.push({ nodeId: open.nodeId, message: "IF is never closed with END IF." });
  }

  return issues;
}

/** An indented outline of the flow — the human-readable execution graph. */
export function describeFlow(flow: Flow): string[] {
  const lines: string[] = [];
  let depth = 0;

  for (const node of flow.nodes) {
    if (node.type === "end-if") depth = Math.max(0, depth - 1);
    const isElse = node.type === "else";
    const indent = "  ".repeat(isElse ? Math.max(0, depth - 1) : depth);
    lines.push(`${indent}${nodeSummary(node)}`);
    if (node.type === "if") depth += 1;
  }

  return lines;
}

export type StepStatus = "ok" | "skipped" | "failed" | "dry-run";

export type StepLog = {
  nodeId: string;
  label: string;
  status: StepStatus;
  message: string;
};

export type RunResult = {
  flowId: string;
  dryRun: boolean;
  steps: StepLog[];
  /** Variables produced during the run, readable by IF nodes. */
  context: Record<string, string>;
  failed: boolean;
};

/**
 * Runs one named check. Takes a check name, never a command line: the
 * executable and its arguments live in the desktop main process, and a flow
 * can only ask for one of them by name.
 */
export type ScriptRunner = (check: string) => Promise<{ ok: boolean; exitCode: number; output?: string }>;

export type ExecuteOptions = {
  dryRun: boolean;
  runScript?: ScriptRunner;
  /** Injected so tests do not actually wait, and so WAIT is skippable in a dry run. */
  sleep?: (ms: number) => Promise<void>;
  /** Seed variables, e.g. from a trigger. */
  context?: Record<string, string>;
  /** Stop before this many steps; used by replay to rewind to a point. */
  stopAfter?: number;
};

export function evaluateCondition(node: FlowNode, context: Record<string, string>): boolean {
  const left = context[node.config.left ?? ""] ?? "";
  const right = node.config.right ?? "";

  switch ((node.config.op ?? "==") as ComparisonOp) {
    case "==":
      return left === right;
    case "!=":
      return left !== right;
    case "contains":
      return left.includes(right);
    case "exists":
      return Object.prototype.hasOwnProperty.call(context, node.config.left ?? "");
    default:
      return false;
  }
}

/**
 * Execute the flow.
 *
 * A dry run performs nothing: it reports what each node would do. A live run
 * executes the control flow and RUN SCRIPT for real, and skips credentialed
 * nodes with their reason — never marking them done.
 */
export async function executeFlow(flow: Flow, options: ExecuteOptions): Promise<RunResult> {
  const steps: StepLog[] = [];
  const context: Record<string, string> = { ...options.context };
  const issues = validateFlow(flow);

  if (issues.length > 0) {
    return {
      flowId: flow.id,
      dryRun: options.dryRun,
      failed: true,
      context,
      steps: issues.map((issue) => ({
        nodeId: issue.nodeId ?? "flow",
        label: "VALIDATION",
        status: "failed",
        message: issue.message
      }))
    };
  }

  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let failed = false;

  // `skipDepth` tracks how many nested blocks we are inside that are not taken.
  let index = 0;
  const branchStack: Array<{ taken: boolean }> = [];
  let skipping = 0;

  const push = (node: FlowNode, status: StepStatus, message: string) => {
    steps.push({ nodeId: node.id, label: nodeLabels[node.type], status, message });
  };

  while (index < flow.nodes.length) {
    if (typeof options.stopAfter === "number" && steps.length >= options.stopAfter) break;

    const node = flow.nodes[index];
    index += 1;

    if (node.type === "if") {
      if (skipping > 0) {
        skipping += 1;
        branchStack.push({ taken: false });
        continue;
      }
      const taken = evaluateCondition(node, context);
      branchStack.push({ taken });
      push(node, taken ? "ok" : "skipped", `${nodeSummary(node)} → ${taken}`);
      if (!taken) skipping = 1;
      continue;
    }

    if (node.type === "else") {
      const branch = branchStack.at(-1);
      if (!branch) continue;
      if (skipping > 1) continue;
      // Entering ELSE flips which side runs.
      skipping = branch.taken ? 1 : 0;
      push(node, branch.taken ? "skipped" : "ok", branch.taken ? "ELSE not taken" : "ELSE taken");
      continue;
    }

    if (node.type === "end-if") {
      branchStack.pop();
      if (skipping > 0) skipping -= 1;
      continue;
    }

    if (skipping > 0) continue;

    if (options.dryRun) {
      const reason = capabilityReason(node.type);
      push(node, "dry-run", reason ? `Would run: ${nodeSummary(node)} (${reason})` : `Would run: ${nodeSummary(node)}`);
      continue;
    }

    if (nodeCapability(node.type) === "needs-credentials") {
      push(node, "skipped", `Not run: ${capabilityReason(node.type) ?? "no credentials configured."}`);
      continue;
    }

    if (node.type === "wait") {
      const seconds = Number(node.config.seconds ?? 0);
      await sleep(seconds * 1000);
      push(node, "ok", `Waited ${seconds}s`);
      continue;
    }

    if (node.type === "run-script") {
      const check = node.config.check ?? "";
      if (!options.runScript) {
        push(node, "skipped", "No check runner available; RUN SCRIPT needs the desktop bridge.");
        continue;
      }

      const result = await options.runScript(check);
      context.exitCode = String(result.exitCode);
      context.ok = result.ok ? "true" : "false";
      if (result.output !== undefined) context.output = result.output;

      push(
        node,
        result.ok ? "ok" : "failed",
        result.ok ? `${check} → exit 0` : `${check} → exit ${result.exitCode}`
      );

      if (!result.ok) {
        failed = true;
        // Stop at the first real failure so the run can be inspected and
        // replayed from that point rather than cascading.
        break;
      }
      continue;
    }
  }

  return { flowId: flow.id, dryRun: options.dryRun, steps, context, failed };
}

/**
 * Rewind a finished run to just before the step that failed, so it can be
 * replayed from there after the cause is fixed.
 *
 * Returns the number of steps to keep, and the node the replay should resume at.
 */
export function rewindPoint(run: RunResult): { keepSteps: number; resumeNodeId: string | null } {
  const failedIndex = run.steps.findIndex((step) => step.status === "failed");
  if (failedIndex === -1) {
    return { keepSteps: run.steps.length, resumeNodeId: null };
  }
  return { keepSteps: failedIndex, resumeNodeId: run.steps[failedIndex].nodeId };
}

export function moveNode(flow: Flow, nodeId: string, direction: -1 | 1): Flow {
  const index = flow.nodes.findIndex((node) => node.id === nodeId);
  const target = index + direction;
  if (index === -1 || target < 0 || target >= flow.nodes.length) return flow;

  const nodes = [...flow.nodes];
  [nodes[index], nodes[target]] = [nodes[target], nodes[index]];
  return { ...flow, nodes };
}

export function removeNode(flow: Flow, nodeId: string): Flow {
  return { ...flow, nodes: flow.nodes.filter((node) => node.id !== nodeId) };
}

export function appendNode(flow: Flow, node: FlowNode): Flow {
  return { ...flow, nodes: [...flow.nodes, node] };
}

export function updateNodeConfig(flow: Flow, nodeId: string, key: string, value: string): Flow {
  return {
    ...flow,
    nodes: flow.nodes.map((node) =>
      node.id === nodeId ? { ...node, config: { ...node.config, [key]: value } } : node
    )
  };
}

export function parseFlow(value: unknown): Flow | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { id?: unknown; name?: unknown; nodes?: unknown };
  if (typeof raw.id !== "string" || typeof raw.name !== "string" || !Array.isArray(raw.nodes)) return null;

  const nodes: FlowNode[] = [];
  for (const entry of raw.nodes) {
    if (!entry || typeof entry !== "object") continue;
    const node = entry as { id?: unknown; type?: unknown; config?: unknown };
    if (typeof node.id !== "string") continue;
    if (typeof node.type !== "string" || !(node.type in capabilities)) continue;

    const config: Record<string, string> = {};
    if (node.config && typeof node.config === "object") {
      for (const [key, val] of Object.entries(node.config as Record<string, unknown>)) {
        if (typeof val === "string") config[key] = val;
      }
    }
    nodes.push({ id: node.id, type: node.type as NodeType, config });
  }

  return { id: raw.id, name: raw.name, nodes };
}

export function readFlow(storage: Storage | undefined, key: string): Flow | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    return raw ? parseFlow(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function writeFlow(storage: Storage | undefined, key: string, flow: Flow): void {
  try {
    storage?.setItem(key, JSON.stringify(flow));
  } catch {
    // Storage failure must not block editing a flow.
  }
}
