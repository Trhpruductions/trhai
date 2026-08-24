// The only commands the renderer may cause to run.
//
// Before this, `ascend:run-command` took a string from the page and handed it
// to `cmd.exe /c`. The working directory was confined, but the command itself
// was not checked at all, so any renderer code — or anything that reached the
// renderer — had full shell execution at user privilege, operators and
// redirection included.
//
// The fix is not to sanitise that string. Escaping a shell string correctly is
// a losing game, and a blocklist of dangerous characters is a list you can
// always add one more entry to. Instead the renderer no longer supplies a
// command at all: it names one of these, and the executable and every argument
// come from this file, which page content cannot reach.
//
// Two rules for anything added here:
//
// The argument list is fixed. No entry may take an argument from the caller —
// the moment one does, the injection surface is back, just one level down.
//
// Nothing here may be destructive. These run against the user's own project
// with no confirmation step, so a check that could delete, reset, push, or
// install does not belong in this set.

/**
 * Windows needs the .cmd shim by name; every other platform uses `npm`.
 *
 * Caught live: the first version of this ran with `shell: false`, which
 * reads as the safer setting and is not available here. Node 24 refuses to
 * spawn a .bat or .cmd without a shell — its fix for CVE-2024-27980 — so
 * `spawn("npm.cmd", args, { shell: false })` throws EINVAL and three of the
 * four checks below could never have run. The unit tests did not catch it
 * because they exercised the gate and never actually spawned anything.
 *
 * These therefore run with `shell: true`, and the safety comes from the
 * argument list instead of from the spawn flag. That is a real difference
 * from the code this replaced, not a return to it: there, the entire command
 * was a string from the renderer. Here every element of every command below
 * is a literal in this file, and `isWorkspaceCheck` guarantees the caller can
 * only choose *which* of them runs, never contribute a character to one.
 */
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

export type WorkspaceCheckDefinition = {
  /** Shown in the UI and in the run log. */
  label: string;
  /** Executable name, resolved via PATH. Never a shell. */
  command: string;
  /** Fixed and complete. Nothing is appended at call time. */
  args: readonly string[];
};

export const workspaceChecks = {
  gitStatus: {
    label: "Git status",
    command: "git",
    args: ["status", "--short", "--branch"]
  },
  typecheck: {
    label: "Typecheck",
    command: npm,
    args: ["run", "typecheck"]
  },
  tests: {
    label: "Tests",
    command: npm,
    args: ["test"]
  },
  build: {
    label: "Build",
    command: npm,
    args: ["run", "build"]
  }
} as const satisfies Record<string, WorkspaceCheckDefinition>;

export type WorkspaceCheckName = keyof typeof workspaceChecks;

/**
 * Narrow an untrusted value to a check name.
 *
 * Written against a fixed key list rather than `value in workspaceChecks`,
 * because `in` also answers true for inherited Object.prototype members —
 * "constructor", "toString", "__proto__" — and this is the gate that decides
 * whether a child process starts.
 */
export function isWorkspaceCheck(value: unknown): value is WorkspaceCheckName {
  return typeof value === "string"
    && (Object.keys(workspaceChecks) as string[]).includes(value);
}

/** Name and label only. The executable and its arguments stay in the main process. */
export function listWorkspaceChecks(): Array<{ name: WorkspaceCheckName; label: string }> {
  return (Object.keys(workspaceChecks) as WorkspaceCheckName[])
    .map((name) => ({ name, label: workspaceChecks[name].label }));
}

/**
 * The environment a check runs with.
 *
 * `env: process.env` handed the child every variable this process holds,
 * including anything secret the user had exported. These are the ones npm,
 * node and git actually need in order to resolve and run on a normal machine;
 * matching is case-insensitive because Windows treats PATH and Path as the
 * same variable while a JS object does not.
 */
const allowedEnvNames = new Set([
  "path", "pathext", "comspec", "systemroot", "systemdrive", "windir",
  "temp", "tmp", "userprofile", "homedrive", "homepath", "home",
  "appdata", "localappdata", "programdata", "programfiles", "programfiles(x86)",
  "number_of_processors", "os", "lang", "lc_all"
]);

export function checkEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed: NodeJS.ProcessEnv = {};

  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && allowedEnvNames.has(name.toLowerCase())) {
      allowed[name] = value;
    }
  }

  return allowed;
}
