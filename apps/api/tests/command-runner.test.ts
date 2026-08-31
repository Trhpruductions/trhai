import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  accessFilePath,
  armCommands,
  armCommandsFor,
  armedUntil,
  armDurationMs,
  commandHistory,
  commandsArmed,
  describeRun,
  disarmCommands,
  maxOutputBytes,
  resetCommandRunner,
  runCommand,
  truncateOutput
} from "../src/services/commandRunner.js";
import { availableTools, runTool, toolDefinitions } from "../src/services/agentTools.js";
import { permissionLevelOf, requiresConfirmation } from "../src/services/toolPermissions.js";


// This is the only capability in the app that is not bounded by the
// workspace, so the tests care most about the boundary: that it is off by
// default, that it is not even offered while off, and that it reports what
// actually happened rather than what was hoped for.

test.beforeEach(() => resetCommandRunner());
test.after(() => resetCommandRunner());

test("the machine is reachable unless it has been switched off", () => {
  // Changed deliberately. Access used to be off until armed, for thirty
  // minutes at a time, which treated it as an exception granted for a task.
  // For one person's assistant on their own machine that was the wrong model:
  // an assistant that cannot reach their files until they flip a switch, and
  // forgets again while they are still working, is one they have to manage
  // rather than use.
  assert.equal(commandsArmed(), true, "on is the resting state now");
  assert.equal(armedUntil(), null, "nothing permanent has an expiry to report");
});

test("switching it off is honoured and has no expiry", () => {
  disarmCommands();
  assert.equal(commandsArmed(), false, "off must mean off");
  assert.equal(armedUntil(), null);
});

test("a bounded grant lasts its window and then lapses", () => {
  // armCommands is permanent now; armCommandsFor is how a time-limited grant
  // is still made. Kept because a bounded grant is a genuinely different thing
  // from a permanent one.
  const now = new Date(2026, 7, 25, 12, 0, 0);
  disarmCommands(now);
  armCommandsFor(armDurationMs, now);

  assert.equal(commandsArmed(new Date(now.getTime() + 1000)), true);
  assert.equal(commandsArmed(new Date(now.getTime() + armDurationMs - 1000)), true);

  // Past the window it falls back to the default rather than to "off": a
  // window running out is the absence of a decision, not a decision to close.
  assert.equal(commandsArmed(new Date(now.getTime() + armDurationMs + 1)), true);
  assert.equal(armedUntil(), null, "the lapsed window is cleared, not left half-true");
});

test("an expiry that passes clears the state rather than staying half-true", () => {
  const now = new Date(2026, 7, 25, 12, 0, 0);
  armCommandsFor(armDurationMs, now);
  commandsArmed(new Date(now.getTime() + armDurationMs + 1));

  // The window is gone rather than lingering: asking again with an older clock
  // must not resurrect it.
  assert.equal(armedUntil(), null);
});

test("switching off takes effect immediately", () => {
  armCommands();
  assert.equal(commandsArmed(), true);

  disarmCommands();
  assert.equal(commandsArmed(), false);
});

test("run_command is not offered to the model while switched off", () => {
  // Withheld rather than offered and refused. A model that can see a tool
  // will reason about it and try to talk its way into it.
  const names = availableTools(false).map((definition) => definition.function.name);
  assert.ok(!names.includes("run_command"), "a disarmed model must not see it exists");
  // Everything else is still there — this must not be a blunt instrument.
  assert.equal(names.length, toolDefinitions.length - 1);
});

test("run_command is offered once switched on", () => {
  const names = availableTools(true).map((definition) => definition.function.name);
  assert.ok(names.includes("run_command"));
});

test("run_command sits above the confirmation line in the ladder", () => {
  assert.ok(permissionLevelOf("run_command") >= 3);
  assert.equal(requiresConfirmation("run_command"), true);
});

test("a command runs and its real output comes back", async () => {
  const run = await runCommand("echo hello-from-trhai");

  assert.equal(run.exitCode, 0);
  assert.equal(run.timedOut, false);
  assert.match(run.stdout, /hello-from-trhai/);
});

test("a failing command reports the failure rather than swallowing it", async () => {
  // A non-zero exit is an answer, not an exception. Losing it would let a
  // reply describe a failed command as done.
  const run = await runCommand("exit 3");

  assert.equal(run.exitCode, 3);
  assert.match(describeRun(run), /failed/i);
  assert.match(describeRun(run), /do not describe it as done/i);
});

test("a command that writes to stderr has it captured", async () => {
  const run = await runCommand(
    process.platform === "win32" ? "echo trouble 1>&2" : "echo trouble >&2"
  );

  assert.match(run.stderr, /trouble/);
});

test("a command that does not exist is reported, not treated as success", async () => {
  const run = await runCommand("definitely-not-a-real-command-xyz");

  assert.notEqual(run.exitCode, 0);
  const described = describeRun(run);
  assert.ok(!/succeeded/i.test(described), `should not read as success: ${described}`);
});

test("every run is recorded with its command and exit code", async () => {
  await runCommand("echo one");
  await runCommand("exit 1");

  const history = commandHistory();
  assert.equal(history.length, 2);
  // Newest first, and the failure is kept rather than only the successes.
  assert.match(history[0].command, /exit 1/);
  assert.equal(history[0].exitCode, 1);
  assert.match(history[1].command, /echo one/);
});

test("the history is a copy, so a caller cannot rewrite the record", async () => {
  await runCommand("echo one");
  const first = commandHistory();
  first[0].command = "something else";

  assert.match(commandHistory()[0].command, /echo one/);
});

test("a run that printed nothing says so instead of looking empty", async () => {
  const run = await runCommand(process.platform === "win32" ? "cd ." : "true");
  assert.match(describeRun(run), /printed nothing/);
});

test("output is truncated with a note, not cut silently", () => {
  // A truncated log that ends mid-line reads as a complete one, so the cut
  // has to announce itself. Truncation happens at capture, which is the
  // function under test here rather than the one that formats the result.
  const truncated = truncateOutput("x".repeat(maxOutputBytes + 500));

  assert.match(truncated, /output truncated/);
  assert.ok(truncated.length < maxOutputBytes + 500, "it actually shortened the text");
});

test("output that fits is left exactly as the process printed it", () => {
  const exact = "line one\n  indented\nline three";
  assert.equal(truncateOutput(exact), exact, "never reformatted or trimmed");
});

test("a timed-out run does not claim the command finished", () => {
  const run = {
    command: "sleep forever",
    stdout: "",
    stderr: "",
    exitCode: null,
    timedOut: true,
    durationMs: 120_000,
    startedAt: new Date().toISOString()
  };

  const described = describeRun(run);
  assert.match(described, /was stopped/);
  assert.match(described, /may have partly completed/);
  assert.ok(!/succeeded/i.test(described));
});

// Arming as the authorisation. The switch has to actually mean something:
// asking again per command would make it pointless, and a prompt that appears
// on every line is one people click through without reading.

test("switching machine control on authorises run_command without asking again", async () => {
  armCommands();
  try {
    const result = await runTool(
      { name: "run_command", arguments: { command: "echo armed-path" } },
      { memories: [], knowledge: [] }
    );

    assert.ok(!result.needsConfirmation, "the switch was the confirmation");
    assert.match(result.content, /armed-path/);
  } finally {
    disarmCommands();
  }
});

test("with control off, run_command is refused and nothing runs", async () => {
  disarmCommands();
  const result = await runTool(
    { name: "run_command", arguments: { command: "echo should-not-run" } },
    { memories: [], knowledge: [] }
  );

  assert.equal(result.ok, false);
  assert.ok(!result.content.includes("should-not-run"), "it must not have executed");
  assert.equal(commandHistory().length, 0, "and must not appear in the log");
});

test("arming does not quietly authorise the other destructive tools", async () => {
  // The grant is for running commands, not a blanket lifting of the ladder.
  armCommands();
  try {
    const result = await runTool(
      { name: "forget", arguments: { id: "anything" } },
      { memories: [], knowledge: [], forgetMemory: () => true }
    );

    assert.equal(result.needsConfirmation, true, "forget still asks");
  } finally {
    disarmCommands();
  }
});

test("a command that fails is reported as not ok, not as done", async () => {
  armCommands();
  try {
    const result = await runTool(
      { name: "run_command", arguments: { command: "exit 4" } },
      { memories: [], knowledge: [] }
    );

    assert.equal(result.ok, false, "a failed command is not a successful tool call");
    assert.match(result.content, /exit code 4/i);
  } finally {
    disarmCommands();
  }
});

// Unattended runs never get command access.
//
// Found while documenting this: the scheduler calls the same orchestrator the
// chat surface does, so a schedule firing while machine control happened to
// be armed could have run commands with nobody watching. Switching machine
// control on is a grant for working at the machine — a timer must not inherit
// it because the thirty-minute window is still open when it fires.

test("a scheduled run is refused command access even while armed", async () => {
  armCommands();
  try {
    const result = await runTool(
      { name: "run_command", arguments: { command: "echo should-not-run" } },
      { memories: [], knowledge: [], unattended: true }
    );

    assert.equal(result.ok, false);
    assert.ok(!result.content.includes("should-not-run"), "it must not have executed");
    assert.match(result.content, /nobody watching/i);
    assert.equal(commandHistory().length, 0, "and must not appear in the run log");
  } finally {
    disarmCommands();
  }
});

test("an unattended turn is not offered the tool in the first place", () => {
  // Withheld at the list as well as refused at the call: a model that cannot
  // see the tool will not spend a round trying to use it.
  //
  // This test only ever asserted the attended half, despite its name. Anyone
  // reading the suite would have believed the unattended case was covered when
  // nothing checked it - the behaviour was right, the evidence was not.
  //
  // agentLoop folds the two together at the call site as
  // `availableTools(commandsArmed() && !unattended)`, so unattended arrives
  // here as armed:false. Both halves are asserted now.
  armCommands();
  try {
    assert.ok(availableTools(true).some((d) => d.function.name === "run_command"),
      "armed and attended still offers it");
    assert.ok(!availableTools(false).some((d) => d.function.name === "run_command"),
      "an unattended turn must not be offered run_command");
  } finally {
    disarmCommands();
  }
});

test("the same scheduled run keeps every other tool", async () => {
  // The gate is for commands, not a blanket refusal — a schedule still has to
  // be able to do its actual job.
  const result = await runTool(
    { name: "current_datetime", arguments: {} },
    { memories: [], knowledge: [], unattended: true }
  );

  assert.equal(result.ok, true);
});

// Where the grant is remembered, and where it must not be.

test("a test process never resolves the real grant file", () => {
  // The regression this exists for. tests/setup/isolate-state.ts redirects
  // TRHAI_ARM_FILE, but it is carried by an --import flag on the npm script, so
  // running a single test file directly skipped it - and a direct run here
  // wrote {"enabled":false} into the developer's real grant. Their assistant
  // stopped being able to open their own files, mid-task, for a reason nothing
  // on screen explained.
  //
  // The env var is unset for the length of this case so the fallback is the
  // thing under test rather than the redirect that normally hides it.
  const redirect = process.env.TRHAI_ARM_FILE;
  delete process.env.TRHAI_ARM_FILE;

  try {
    const resolved = accessFilePath();
    const real = path.join(process.cwd(), "data", "command-arm.json");
    assert.notEqual(resolved, real, "a test must not resolve the real grant file");
    assert.match(resolved, /command-arm\.json$/);
    // Stable within the process, or two calls would disagree about the state.
    assert.equal(accessFilePath(), resolved);
  } finally {
    if (redirect === undefined) delete process.env.TRHAI_ARM_FILE;
    else process.env.TRHAI_ARM_FILE = redirect;
  }
});

test("an explicit redirect still wins over the test fallback", () => {
  const redirect = process.env.TRHAI_ARM_FILE;
  process.env.TRHAI_ARM_FILE = path.join(tmpdir(), "explicit-arm.json");

  try {
    assert.equal(accessFilePath(), path.join(tmpdir(), "explicit-arm.json"));
  } finally {
    if (redirect === undefined) delete process.env.TRHAI_ARM_FILE;
    else process.env.TRHAI_ARM_FILE = redirect;
  }
});
