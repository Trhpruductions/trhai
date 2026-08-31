import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { increment, observe } from "./metrics.js";

// Running commands on this machine.
//
// This is the one capability in the app that is not bounded by the workspace.
// Everything else — write_file, build_app, the Files page — resolves through
// resolveInWorkspace and cannot reach past a directory the user chose. A
// command can do anything the user can do, which is the point of it and also
// the whole risk, so the design is about the boundary rather than about a
// blocklist of bad commands.
//
// A blocklist would be the wrong shape here for the same reason it is wrong
// in workspace.ts: the set of dangerous commands is open-ended, and one that
// blocks "rm -rf" is defeated by writing it into a .bat file and running
// that. So nothing is filtered on content. Instead:
//
//   - It can be switched off, and while it is off the tool is not offered to
//     the model at all - so a model cannot decide to use it, be talked into
//     using it, or mention that it exists as an option.
//   - It is ON by default. This used to read "off until the user turns it on,
//     and it lapses on its own", which was true when access was a thirty-minute
//     grant and is not true now; see machineAccessDefault below for why that
//     changed. Leaving the old wording here would have been worse than no
//     comment at all, because the next person to reason about the safety of
//     this file would have reasoned about a system that no longer exists.
//   - Because access is on, run_command's level-3 confirmation does not fire:
//     agentTools counts an armed machine as pre-authorisation. In practice
//     this tool runs when the model asks for it.
//   - An unattended run is refused outright and cannot be confirmed into
//     being. Nobody is watching a scheduled run, so there is no one to ask.
//   - Every command that runs is recorded with its output and exit code,
//     whether it succeeded or not.
//
// The alternative — a curated list of "safe" commands — sounds safer and is
// not: it produces an assistant that cannot do the thing it was asked to do,
// while still being able to do damage through whatever it was allowed.

export type CommandRun = {
  command: string;
  /** Whatever the process printed. Truncated, never summarised or cleaned up. */
  stdout: string;
  stderr: string;
  /** Null when the process was killed rather than exiting on its own. */
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  startedAt: string;
};

/**
 * Long enough for an install or a build; short enough not to hang forever.
 *
 * Two minutes was neither. It is under half of what `npm install` takes on a
 * cold cache, so the one command most likely to be asked for was the one most
 * likely to be killed halfway - leaving a half-populated node_modules and a
 * timeout message that says nothing about what state the folder is now in.
 * Ten minutes covers a real install or build. TRHAI_COMMAND_TIMEOUT_MS moves
 * it for anyone whose builds are slower still.
 */
export const commandTimeoutMs = Number(process.env.TRHAI_COMMAND_TIMEOUT_MS ?? 600_000);

/** Output beyond this is cut. A model cannot use more, and it crowds the turn. */
export const maxOutputBytes = 20_000;

/**
 * Where a command runs when the caller does not say.
 *
 * The home directory, which is a sensible default for "check the disk" and a
 * trap for anything about a project. The model was never told this, so asked to
 * look at an app it ran `node index.js` and got "Cannot find module
 * C:\Users\hankh\index.js" - not a wild guess, just the shell resolving a
 * relative path against a directory nobody had mentioned to it.
 *
 * Exported so projectContext can state it in the prompt from the same place the
 * runner reads it. Two copies of this would drift, and the drift would be
 * invisible: the prompt would describe one directory and commands would run in
 * another.
 */
export function commandWorkingDirectory(): string {
  return homedir() || process.cwd();
}

/**
 * How long a grant lasts, when one is made by arming.
 *
 * Retained for the API's shape and for anyone who sets an expiry deliberately,
 * but no longer how access normally works - see machineAccessDefault below.
 */
export const armDurationMs = Number(process.env.TRHAI_ARM_DURATION_MS ?? 4 * 60 * 60 * 1000);

/**
 * Whether the machine is reachable when nothing has been decided.
 *
 * On. That is a deliberate change from an app that started closed and asked to
 * be opened for thirty minutes at a time.
 *
 * The window was built on the idea that access is an exception - something
 * granted for a task and withdrawn afterwards. For this app that was simply
 * the wrong model of how it gets used. It is one person's assistant on their
 * own machine, and the thing they want from it is to work on their projects;
 * an assistant that cannot reach their files until they remember to flip a
 * switch, and then forgets again while they are still working, is one they
 * have to manage rather than use.
 *
 * The switch is still there and still means what it says. Turning it off turns
 * it off, and it stays off - the decision persists either way. What has gone
 * is the assumption that off is the natural resting state.
 *
 * TRHAI_MACHINE_ACCESS=off restores the closed default for anyone who wants
 * it, without editing this.
 */
const machineAccessDefault = process.env.TRHAI_MACHINE_ACCESS !== "off";

/**
 * What has actually been decided, as opposed to what the default is.
 *
 * null means nobody has decided, so the default stands. A boolean is a choice
 * somebody made, and it persists until they make a different one - including
 * "off", which has to survive a restart just as firmly as "on" or turning it
 * off would be undone by the next reload.
 *
 * `expiresAt` is only set when access was granted through the timed arming
 * path, which nothing does by default any more.
 */
type AccessState = { enabled: boolean; decidedAt: string; expiresAt?: number } | null;

let accessState: AccessState = null;
let accessLoaded = false;

/** Every command that has run this session, newest first. */
const history: CommandRun[] = [];
const maxHistory = 50;

/**
 * Where the decision is remembered across restarts.
 *
 * Resolved when used rather than when this module loads: as a constant it was
 * captured before a test could redirect it, so tests deleted the real file and
 * the app they were running alongside lost its access mid-task.
 */
export function accessFilePath(): string {
  if (process.env.TRHAI_ARM_FILE) return process.env.TRHAI_ARM_FILE;

  // Never the real file from inside a test process.
  //
  // tests/setup/isolate-state.ts redirects TRHAI_ARM_FILE, and that works - but
  // only when the suite is started through `npm test`, because the redirect is
  // carried by an --import flag in that script. Running one file directly
  // (`node --test tests/agent-loop.test.ts`, or the tsx equivalent) skips the
  // flag and therefore the isolation.
  //
  // Which is not hypothetical: it happened here. A direct run of one test file
  // wrote {"enabled":false} into the developer's real grant, and the app they
  // had running alongside stopped being able to open their files - the exact
  // failure isolate-state.ts was written to prevent, arriving through the one
  // door it did not cover.
  //
  // NODE_TEST_CONTEXT is set by the node test runner in every test child
  // process however it was launched, and it is set before any module loads, so
  // it is available at the moment this is asked. A throwaway path here means
  // the protection travels with the code instead of with the command line.
  if (process.env.NODE_TEST_CONTEXT) {
    testArmFile ??= path.join(mkdtempSync(path.join(tmpdir(), "trhai-arm-")), "command-arm.json");
    return testArmFile;
  }

  return path.join(process.cwd(), "data", "command-arm.json");
}

/** Cached so every call within one test process agrees on the same file. */
let testArmFile: string | undefined;

function loadAccessState(): void {
  if (accessLoaded) return;
  accessLoaded = true;

  try {
    if (!existsSync(accessFilePath())) return;
    const parsed = JSON.parse(readFileSync(accessFilePath(), "utf8")) as Partial<{
      enabled: boolean; decidedAt: string; expiresAt: number;
      // The older shape, from when access was only ever a timed grant.
      armedUntil: number; armedAt: string;
    }>;

    if (typeof parsed?.enabled === "boolean") {
      if (typeof parsed.expiresAt === "number" && Date.now() >= parsed.expiresAt) return;
      accessState = {
        enabled: parsed.enabled,
        decidedAt: typeof parsed.decidedAt === "string" ? parsed.decidedAt : new Date().toISOString(),
        ...(typeof parsed.expiresAt === "number" ? { expiresAt: parsed.expiresAt } : {})
      };
      return;
    }

    // A file written by the previous version. An unexpired grant is honoured
    // as an explicit "on" rather than discarded, so upgrading does not revoke
    // access somebody had deliberately granted.
    if (typeof parsed?.armedUntil === "number" && Date.now() < parsed.armedUntil) {
      accessState = {
        enabled: true,
        decidedAt: typeof parsed.armedAt === "string" ? parsed.armedAt : new Date().toISOString(),
        expiresAt: parsed.armedUntil
      };
    }
  } catch {
    // An unreadable file means no decision, so the default stands.
  }
}

function saveAccessState(): void {
  try {
    mkdirSync(path.dirname(accessFilePath()), { recursive: true });
    if (accessState) {
      writeFileSync(accessFilePath(), JSON.stringify(accessState), "utf8");
    } else if (existsSync(accessFilePath())) {
      rmSync(accessFilePath(), { force: true });
    }
  } catch {
    // Losing the file costs one re-decision after a restart, which is a better
    // failure than refusing to change the setting at all.
  }
}

/** Turn machine access on, permanently, until it is turned off. */
export function armCommands(now: Date = new Date()): { armedUntil: string | null } {
  accessLoaded = true;
  accessState = { enabled: true, decidedAt: now.toISOString() };
  saveAccessState();
  return { armedUntil: null };
}

/**
 * Turn it on for a fixed window instead.
 *
 * Nothing in the app calls this now. It is kept because a bounded grant is a
 * genuinely different thing from a permanent one, and deleting the ability to
 * make one would be removing a capability rather than changing a default.
 */
export function armCommandsFor(durationMs: number, now: Date = new Date()): { armedUntil: string } {
  accessLoaded = true;
  const expiresAt = now.getTime() + durationMs;
  accessState = { enabled: true, decidedAt: now.toISOString(), expiresAt };
  saveAccessState();
  return { armedUntil: new Date(expiresAt).toISOString() };
}

/** Turn it off, and keep it off across restarts. */
export function disarmCommands(now: Date = new Date()): void {
  accessLoaded = true;
  accessState = { enabled: false, decidedAt: now.toISOString() };
  saveAccessState();
}

/**
 * Whether the machine may be reached right now.
 *
 * Checked at the moment of use rather than cached, so a decision made
 * mid-conversation takes effect on the next call rather than whenever
 * something happens to re-read it.
 */
export function commandsArmed(now: Date = new Date()): boolean {
  loadAccessState();
  if (!accessState) return machineAccessDefault;

  if (accessState.expiresAt !== undefined && now.getTime() >= accessState.expiresAt) {
    // A lapsed window is not a decision to stay off; it is the absence of one,
    // so the default applies again.
    accessState = null;
    saveAccessState();
    return machineAccessDefault;
  }

  return accessState.enabled;
}

/** When a timed grant runs out, or null when access simply is or is not on. */
export function armedUntil(): string | null {
  if (!accessState?.expiresAt) return null;
  return new Date(accessState.expiresAt).toISOString();
}

export function commandHistory(): CommandRun[] {
  return history.map((entry) => ({ ...entry }));
}

/**
 * Clear everything this module is holding.
 *
 * By default nothing is re-read from disk afterwards. A test run would
 * otherwise inherit whatever the developer had set on their own machine, and a
 * test about access would pass or fail depending on whether somebody had used
 * the app that afternoon.
 *
 * `rereadFromDisk` is how a restart is simulated: the process comes back with
 * no memory of the decision and has to find it in the file, which is the only
 * way to prove a stored "off" is actually honoured rather than merely written.
 */
export function resetCommandRunner(options: { rereadFromDisk?: boolean } = {}): void {
  accessState = null;
  accessLoaded = options.rereadFromDisk !== true;
  history.length = 0;
}

export function truncateOutput(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= maxOutputBytes) return text;
  // Says it was cut rather than silently ending mid-line, so nobody reads a
  // truncated log as a complete one.
  return `${text.slice(0, maxOutputBytes)}\n… output truncated at ${maxOutputBytes} bytes.`;
}

/**
 * Run one command and report exactly what happened.
 *
 * Shell-invoked deliberately: the user asks for things like "npm install &&
 * npm test", and a version that only spawns a bare executable would not do
 * what was asked. There is no argument-injection concern to protect against
 * here that arming does not already cover — the command string is the
 * feature, and anyone who can reach this has already been granted the ability
 * to run commands.
 *
 * A non-zero exit is returned, not thrown. "It failed and here is stderr" is
 * an answer; an exception that loses the output is not.
 */
export async function runCommand(
  command: string,
  options: { cwd?: string; now?: Date } = {}
): Promise<CommandRun> {
  const startedAt = options.now ?? new Date();
  const began = Date.now();
  const cwd = options.cwd ?? commandWorkingDirectory();

  const isWindows = process.platform === "win32";
  const shell = isWindows ? "cmd.exe" : "/bin/sh";
  const args = isWindows ? ["/d", "/s", "/c", command] : ["-c", command];

  return new Promise<CommandRun>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const child = spawn(shell, args, { cwd, windowsHide: true });

    const timer = setTimeout(() => {
      timedOut = true;
      // SIGKILL rather than SIGTERM: this has already outlived its budget,
      // and a process that ignores a polite signal would hold the turn open.
      child.kill("SIGKILL");
    }, commandTimeoutMs);

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const run: CommandRun = {
        command,
        stdout: truncateOutput(stdout),
        stderr: truncateOutput(stderr),
        exitCode,
        timedOut,
        durationMs: Date.now() - began,
        startedAt: startedAt.toISOString()
      };

      increment("trhai_commands_total", {
        outcome: run.timedOut ? "timeout" : run.exitCode === 0 ? "ok" : "failed"
      });
      observe("trhai_command_duration", run.durationMs);
      history.unshift(run);
      if (history.length > maxHistory) history.length = maxHistory;
      console.warn(`[command] ${command} -> exit ${exitCode ?? "killed"} in ${run.durationMs}ms`);
      resolve(run);
    };

    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => {
      stderr += `${stderr ? "\n" : ""}${error instanceof Error ? error.message : String(error)}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}

/**
 * The run, written for whoever reads it next — the model, and then the user.
 *
 * Leads with the outcome because that is what gets acted on, and includes the
 * real output rather than a description of it. A model told only "the command
 * failed" will invent a reason; given stderr, it can report the actual one.
 */
export function describeRun(run: CommandRun): string {
  const lines: string[] = [];

  if (run.timedOut) {
    lines.push(`The command was still running after ${Math.round(commandTimeoutMs / 1000)}s and was stopped. `
      + "It may have partly completed — say what was run and that the result is unknown.");
  } else if (run.exitCode === 0) {
    lines.push(`Exit code 0 (succeeded) in ${run.durationMs}ms.`);
  } else if (run.exitCode === null) {
    lines.push("The command could not be started, or was killed before it exited.");
  } else {
    lines.push(`Exit code ${run.exitCode} (failed) after ${run.durationMs}ms. `
      + "Report this as a failure; do not describe it as done.");
  }

  if (run.stdout.trim()) lines.push(`\nOutput:\n${run.stdout.trim()}`);
  if (run.stderr.trim()) lines.push(`\nErrors:\n${run.stderr.trim()}`);
  if (!run.stdout.trim() && !run.stderr.trim()) lines.push("\nThe command printed nothing.");

  return lines.join("\n");
}
