import { spawn } from "node:child_process";
import { homedir } from "node:os";
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
//   - It is off until the user turns it on. The tool is not offered to the
//     model at all while disarmed, so a model cannot decide to use it, be
//     talked into using it, or mention that it exists as an option.
//   - Arming is a decision with a horizon, not a permanent grant. It lapses
//     on its own, so forgetting to turn it off is not the same as leaving the
//     machine open indefinitely.
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

/** Long enough for an install or a build; short enough not to hang forever. */
export const commandTimeoutMs = 120_000;

/** Output beyond this is cut. A model cannot use more, and it crowds the turn. */
export const maxOutputBytes = 20_000;

/**
 * How long arming lasts.
 *
 * A grant that never expires is one nobody remembers making. Thirty minutes
 * is long enough to work through a task and short enough that walking away
 * from the machine closes it again.
 */
export const armDurationMs = 30 * 60 * 1000;

type ArmState = { armedUntil: number; armedAt: string } | null;

let armState: ArmState = null;
const history: CommandRun[] = [];
const maxHistory = 50;

export function armCommands(now: Date = new Date()): { armedUntil: string } {
  armState = { armedUntil: now.getTime() + armDurationMs, armedAt: now.toISOString() };
  return { armedUntil: new Date(armState.armedUntil).toISOString() };
}

export function disarmCommands(): void {
  armState = null;
}

/**
 * Whether commands may run right now.
 *
 * Checked at the moment of use rather than cached, so an expiry that passes
 * mid-conversation takes effect on the next command instead of whenever
 * something happens to re-read it.
 */
export function commandsArmed(now: Date = new Date()): boolean {
  if (!armState) return false;
  if (now.getTime() >= armState.armedUntil) {
    // Cleared on read so the expiry is a real state change, not a condition
    // that keeps evaluating true-then-false depending on who asks.
    armState = null;
    return false;
  }
  return true;
}

export function armedUntil(): string | null {
  return armState ? new Date(armState.armedUntil).toISOString() : null;
}

export function commandHistory(): CommandRun[] {
  return history.map((entry) => ({ ...entry }));
}

export function resetCommandRunner(): void {
  armState = null;
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
  const cwd = options.cwd ?? homedir() ?? process.cwd();

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
