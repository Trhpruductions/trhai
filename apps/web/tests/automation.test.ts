import test from "node:test";
import assert from "node:assert/strict";
import {
  appendNode,
  capabilityReason,
  describeFlow,
  evaluateCondition,
  executeFlow,
  moveNode,
  nodeCapability,
  nodeSummary,
  parseFlow,
  readFlow,
  removeNode,
  rewindPoint,
  updateNodeConfig,
  validateFlow,
  writeFlow,
  type Flow,
  type FlowNode,
  type NodeType
} from "../src/automation.js";

function node(id: string, type: NodeType, config: Record<string, string> = {}): FlowNode {
  return { id, type, config };
}

function flow(...nodes: FlowNode[]): Flow {
  return { id: "f1", name: "Test flow", nodes };
}

const noSleep = async () => {};

test("every primitive the vision names is present", () => {
  const types: NodeType[] = [
    "if", "else", "end-if", "wait", "run-script",
    "open-website", "email", "call-api", "generate-image", "discord-message"
  ];

  for (const type of types) {
    assert.ok(nodeCapability(type), `${type} has no capability`);
    assert.ok(nodeSummary(node("n", type)).length > 0, `${type} has no summary`);
  }
});

test("primitives needing credentials are marked, and say why", () => {
  // The list that cannot really run in this build. Each must carry a reason,
  // because a step that silently does nothing is worse than one that explains.
  for (const type of ["email", "call-api", "generate-image", "discord-message", "open-website"] as NodeType[]) {
    assert.equal(nodeCapability(type), "needs-credentials", `${type} should be gated`);
    assert.ok((capabilityReason(type) ?? "").length > 10, `${type} has no reason`);
  }

  for (const type of ["if", "else", "end-if", "wait", "run-script"] as NodeType[]) {
    assert.equal(nodeCapability(type), "executable", `${type} should be executable`);
  }
});

test("an unbalanced flow is refused before anything runs", () => {
  assert.deepEqual(
    validateFlow(flow(node("a", "if", { left: "ok" }))).map((issue) => issue.message),
    ["IF is never closed with END IF."]
  );

  assert.match(validateFlow(flow(node("a", "end-if")))[0].message, /no matching IF/);
  assert.match(validateFlow(flow(node("a", "else")))[0].message, /no matching IF/);
});

test("a second ELSE on one IF is refused", () => {
  const issues = validateFlow(
    flow(
      node("a", "if", { left: "ok" }),
      node("b", "else"),
      node("c", "else"),
      node("d", "end-if")
    )
  );

  assert.match(issues[0].message, /already has an ELSE/);
});

test("nodes missing required settings are refused", () => {
  assert.match(validateFlow(flow(node("a", "run-script")))[0].message, /needs a command/);
  assert.match(validateFlow(flow(node("a", "wait", { seconds: "-1" })))[0].message, /non-negative/);
  assert.match(validateFlow(flow(node("a", "wait", { seconds: "soon" })))[0].message, /non-negative/);
  assert.match(validateFlow(flow(node("a", "if", {})))[0].message, /needs something to compare/);
});

test("an invalid flow produces no execution steps at all", async () => {
  // Half-running a broken flow would leave whatever came before the bad node
  // already done, with no way to tell what happened.
  const result = await executeFlow(flow(node("a", "run-script", { command: "" })), {
    dryRun: false,
    runScript: async () => {
      throw new Error("must not run");
    }
  });

  assert.equal(result.failed, true);
  assert.equal(result.steps.every((step) => step.label === "VALIDATION"), true);
});

test("the flow renders as a readable indented outline", () => {
  const outline = describeFlow(
    flow(
      node("a", "run-script", { command: "npm test" }),
      node("b", "if", { left: "exitCode", op: "==", right: "0" }),
      node("c", "discord-message", { channel: "builds" }),
      node("d", "else"),
      node("e", "email", { to: "me@example.com" }),
      node("f", "end-if")
    )
  );

  assert.deepEqual(outline, [
    "RUN SCRIPT npm test",
    "IF exitCode == 0",
    "  SEND DISCORD MESSAGE #builds",
    "ELSE",
    "  EMAIL me@example.com",
    "END IF"
  ]);
});

test("conditions compare against variables produced by the run", () => {
  const context = { exitCode: "0", output: "all tests passed" };

  assert.equal(evaluateCondition(node("n", "if", { left: "exitCode", op: "==", right: "0" }), context), true);
  assert.equal(evaluateCondition(node("n", "if", { left: "exitCode", op: "!=", right: "0" }), context), false);
  assert.equal(evaluateCondition(node("n", "if", { left: "output", op: "contains", right: "passed" }), context), true);
  assert.equal(evaluateCondition(node("n", "if", { left: "missing", op: "exists" }), context), false);
  assert.equal(evaluateCondition(node("n", "if", { left: "output", op: "exists" }), context), true);
});

test("a dry run performs nothing and reports what would happen", async () => {
  let ran = false;
  const result = await executeFlow(
    flow(node("a", "run-script", { command: "rm -rf /" }), node("b", "email", { to: "x@y.z" })),
    {
      dryRun: true,
      runScript: async () => {
        ran = true;
        return { ok: true, exitCode: 0 };
      }
    }
  );

  assert.equal(ran, false, "a dry run must not execute anything");
  assert.equal(result.steps.every((step) => step.status === "dry-run"), true);
  assert.match(result.steps[0].message, /Would run/);
  // The dry run still discloses which steps could never really run.
  assert.match(result.steps[1].message, /mail account/i);
});

test("a live run executes a script and records its result", async () => {
  const commands: string[] = [];
  const result = await executeFlow(flow(node("a", "run-script", { command: "npm test" })), {
    dryRun: false,
    sleep: noSleep,
    runScript: async (command) => {
      commands.push(command);
      return { ok: true, exitCode: 0, output: "done" };
    }
  });

  assert.deepEqual(commands, ["npm test"]);
  assert.equal(result.failed, false);
  assert.equal(result.steps[0].status, "ok");
  assert.equal(result.context.exitCode, "0");
  assert.equal(result.context.output, "done");
});

test("a credentialed node in a live run is skipped, never reported as done", async () => {
  // The failure this prevents: a green check on a message that was never sent.
  const result = await executeFlow(flow(node("a", "discord-message", { channel: "builds" })), {
    dryRun: false,
    sleep: noSleep
  });

  assert.equal(result.steps[0].status, "skipped");
  assert.notEqual(result.steps[0].status, "ok");
  assert.match(result.steps[0].message, /Not run/);
  assert.match(result.steps[0].message, /bot token/i);
});

test("RUN SCRIPT without a runner is skipped rather than silently passing", async () => {
  const result = await executeFlow(flow(node("a", "run-script", { command: "npm test" })), {
    dryRun: false,
    sleep: noSleep
  });

  assert.equal(result.steps[0].status, "skipped");
  assert.match(result.steps[0].message, /desktop bridge/);
});

test("only the taken branch runs", async () => {
  const ran: string[] = [];
  const runScript = async (command: string) => {
    ran.push(command);
    return { ok: true, exitCode: 0 };
  };

  const taken = flow(
    node("a", "if", { left: "ok", op: "==", right: "true" }),
    node("b", "run-script", { command: "then-branch" }),
    node("c", "else"),
    node("d", "run-script", { command: "else-branch" }),
    node("e", "end-if")
  );

  await executeFlow(taken, { dryRun: false, sleep: noSleep, runScript, context: { ok: "true" } });
  assert.deepEqual(ran, ["then-branch"]);

  ran.length = 0;
  await executeFlow(taken, { dryRun: false, sleep: noSleep, runScript, context: { ok: "false" } });
  assert.deepEqual(ran, ["else-branch"]);
});

test("a nested IF inside a skipped branch stays skipped", async () => {
  // The bug this guards: tracking "am I skipping" as a boolean rather than a
  // depth lets the inner END IF re-enable a branch that must stay off.
  const ran: string[] = [];

  await executeFlow(
    flow(
      node("a", "if", { left: "outer", op: "==", right: "yes" }),
      node("b", "if", { left: "inner", op: "==", right: "yes" }),
      node("c", "run-script", { command: "inner-then" }),
      node("d", "end-if"),
      node("e", "run-script", { command: "after-inner" }),
      node("f", "end-if"),
      node("g", "run-script", { command: "after-outer" })
    ),
    {
      dryRun: false,
      sleep: noSleep,
      context: { outer: "no", inner: "yes" },
      runScript: async (command) => {
        ran.push(command);
        return { ok: true, exitCode: 0 };
      }
    }
  );

  assert.deepEqual(ran, ["after-outer"]);
});

test("a nested ELSE inside a skipped branch does not switch it back on", async () => {
  const ran: string[] = [];

  await executeFlow(
    flow(
      node("a", "if", { left: "outer", op: "==", right: "yes" }),
      node("b", "if", { left: "inner", op: "==", right: "yes" }),
      node("c", "run-script", { command: "inner-then" }),
      node("d", "else"),
      node("e", "run-script", { command: "inner-else" }),
      node("f", "end-if"),
      node("g", "end-if")
    ),
    {
      dryRun: false,
      sleep: noSleep,
      context: { outer: "no", inner: "no" },
      runScript: async (command) => {
        ran.push(command);
        return { ok: true, exitCode: 0 };
      }
    }
  );

  assert.deepEqual(ran, [], "nothing inside a skipped outer branch may run");
});

test("a script result steers the branch taken next", async () => {
  const ran: string[] = [];

  await executeFlow(
    flow(
      node("a", "run-script", { command: "npm test" }),
      node("b", "if", { left: "ok", op: "==", right: "true" }),
      node("c", "run-script", { command: "deploy" }),
      node("d", "end-if")
    ),
    {
      dryRun: false,
      sleep: noSleep,
      runScript: async (command) => {
        ran.push(command);
        return { ok: command === "npm test", exitCode: command === "npm test" ? 0 : 1 };
      }
    }
  );

  assert.deepEqual(ran, ["npm test", "deploy"]);
});

test("a failing script stops the run at the failure", async () => {
  const ran: string[] = [];
  const result = await executeFlow(
    flow(
      node("a", "run-script", { command: "failing" }),
      node("b", "run-script", { command: "should-not-run" })
    ),
    {
      dryRun: false,
      sleep: noSleep,
      runScript: async (command) => {
        ran.push(command);
        return { ok: false, exitCode: 2 };
      }
    }
  );

  assert.deepEqual(ran, ["failing"]);
  assert.equal(result.failed, true);
  assert.equal(result.steps.at(-1)?.status, "failed");
});

test("a failed run rewinds to the failing step so it can be replayed", async () => {
  const result = await executeFlow(
    flow(
      node("a", "run-script", { command: "ok-one" }),
      node("b", "run-script", { command: "boom" }),
      node("c", "run-script", { command: "never" })
    ),
    {
      dryRun: false,
      sleep: noSleep,
      runScript: async (command) => ({ ok: command !== "boom", exitCode: command === "boom" ? 1 : 0 })
    }
  );

  const rewind = rewindPoint(result);
  assert.equal(rewind.resumeNodeId, "b");
  assert.equal(rewind.keepSteps, 1, "the successful step before the failure is kept");
});

test("a clean run has nothing to rewind to", async () => {
  const result = await executeFlow(flow(node("a", "wait", { seconds: "0" })), {
    dryRun: false,
    sleep: noSleep
  });

  assert.equal(rewindPoint(result).resumeNodeId, null);
});

test("a replay can stop after a given number of steps", async () => {
  const result = await executeFlow(
    flow(
      node("a", "wait", { seconds: "0" }),
      node("b", "wait", { seconds: "0" }),
      node("c", "wait", { seconds: "0" })
    ),
    { dryRun: false, sleep: noSleep, stopAfter: 2 }
  );

  assert.equal(result.steps.length, 2);
});

test("WAIT waits for the configured time", async () => {
  const waited: number[] = [];
  await executeFlow(flow(node("a", "wait", { seconds: "3" })), {
    dryRun: false,
    sleep: async (ms) => void waited.push(ms)
  });

  assert.deepEqual(waited, [3000]);
});

test("editing a flow moves, removes, appends and updates nodes", () => {
  const base = flow(node("a", "wait", { seconds: "1" }), node("b", "wait", { seconds: "2" }));

  assert.deepEqual(moveNode(base, "b", -1).nodes.map((n) => n.id), ["b", "a"]);
  assert.deepEqual(moveNode(base, "a", 1).nodes.map((n) => n.id), ["b", "a"]);
  // Moving off either end is a no-op rather than an error.
  assert.deepEqual(moveNode(base, "a", -1).nodes.map((n) => n.id), ["a", "b"]);
  assert.deepEqual(moveNode(base, "b", 1).nodes.map((n) => n.id), ["a", "b"]);

  assert.deepEqual(removeNode(base, "a").nodes.map((n) => n.id), ["b"]);
  assert.deepEqual(appendNode(base, node("c", "end-if")).nodes.map((n) => n.id), ["a", "b", "c"]);
  assert.equal(updateNodeConfig(base, "a", "seconds", "9").nodes[0].config.seconds, "9");
  // Editing must not mutate the original.
  assert.equal(base.nodes[0].config.seconds, "1");
});

test("a stored flow is narrowed against the current primitives", () => {
  // A saved flow outlives the code that wrote it.
  const parsed = parseFlow({
    id: "f",
    name: "Saved",
    nodes: [
      { id: "a", type: "wait", config: { seconds: "1" } },
      { id: "b", type: "teleport", config: {} },
      { id: "c", type: "wait", config: { seconds: 5 } },
      null
    ]
  });

  assert.deepEqual(parsed?.nodes.map((n) => n.id), ["a", "c"]);
  // A non-string config value is dropped rather than trusted.
  assert.deepEqual(parsed?.nodes[1].config, {});
  assert.equal(parseFlow("nope"), null);
  assert.equal(parseFlow({ id: "f", name: "x" }), null);
});

test("a flow round-trips through storage and a hostile storage never throws", () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value)
  } as unknown as Storage;

  const saved = flow(node("a", "wait", { seconds: "1" }));
  writeFlow(storage, "flow", saved);
  assert.deepEqual(readFlow(storage, "flow"), saved);

  const hostile = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    }
  } as unknown as Storage;

  assert.equal(readFlow(hostile, "flow"), null);
  assert.doesNotThrow(() => writeFlow(hostile, "flow", saved));
});
