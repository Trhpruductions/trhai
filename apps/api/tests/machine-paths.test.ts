import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  isCodeWork, isInsidePath, isProtectedWriteTarget, resolveForAccess
} from "../src/services/machinePaths.js";

// Which paths the assistant may touch, and when. The question behind each case:
// can a path be reached that the user did not agree to, or refused that they
// plainly did?

const workspace = path.resolve("D:/Vexora/workspace");

/** Stands in for the real sandbox resolver: inside returns a path, outside null. */
const insideWorkspace = (candidate: string) => {
  const resolved = path.resolve(workspace, candidate);
  return isInsidePath(workspace, resolved) ? resolved : null;
};

test("a workspace path works whether or not access is granted", () => {
  for (const granted of [true, false]) {
    const verdict = resolveForAccess("notes.md", { granted, intent: "write", insideWorkspace });
    assert.equal(verdict.ok, true, `should resolve with granted=${granted}`);
  }
});

test("without access, a path outside the workspace is refused and says why", () => {
  const verdict = resolveForAccess("D:/trhai/package.json", { granted: false, intent: "read", insideWorkspace });
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.match(verdict.reason, /machine access/i);
});

test("with access, a real project outside the workspace opens", () => {
  // The whole point: "work on my project" is not a workspace-shaped request.
  const verdict = resolveForAccess("D:/trhai/package.json", { granted: true, intent: "read", insideWorkspace });
  assert.equal(verdict.ok, true);
  if (verdict.ok) assert.equal(verdict.path, path.resolve("D:/trhai/package.json"));
});

test("with access, writing to a project outside the workspace is allowed", () => {
  const verdict = resolveForAccess("D:/trhai/src/app.ts", { granted: true, intent: "write", insideWorkspace });
  assert.equal(verdict.ok, true);
});

test("system locations are refused for writes even with access granted", () => {
  // Not a limit on the user - a limit on a small model's typos. The same model
  // wrote a server that killed itself on startup twice in three attempts.
  //
  // Only the running platform's own locations count. A POSIX path on Windows
  // resolves to an ordinary folder on the current drive (/etc/passwd becomes
  // D:\etc\passwd), so refusing it there would block a normal write while
  // protecting nothing.
  const targets = process.platform === "win32"
    ? ["C:/Windows/System32/drivers/etc/hosts", "C:/Program Files/app/thing.dll"]
    : ["/etc/passwd", "/usr/bin/node"];

  for (const target of targets) {
    const verdict = resolveForAccess(target, { granted: true, intent: "write", insideWorkspace });
    assert.equal(verdict.ok, false, `should refuse writing ${target}`);
    if (!verdict.ok) assert.match(verdict.reason, /system location/i);
  }
});

test("reading a system file is allowed - reading breaks nothing", () => {
  const target = process.platform === "win32" ? "C:/Windows/System32/drivers/etc/hosts" : "/etc/hosts";
  const verdict = resolveForAccess(target, { granted: true, intent: "read", insideWorkspace });
  assert.equal(verdict.ok, true);
});

test("a NUL byte is refused however access is set", () => {
  // A NUL truncates the path at the system call, so what is checked and what
  // is opened can differ.
  for (const granted of [true, false]) {
    assert.equal(
      resolveForAccess("notes\0.md", { granted, intent: "write", insideWorkspace }).ok,
      false
    );
  }
});

test("an empty path is refused", () => {
  assert.equal(resolveForAccess("   ", { granted: true, intent: "read", insideWorkspace }).ok, false);
});

test("containment is decided as paths, not as strings", () => {
  // The classic false positive: a sibling folder whose name starts with the
  // parent's name is not inside it.
  assert.equal(isInsidePath("D:/work", "D:/work/sub/file.txt"), true);
  assert.equal(isInsidePath("D:/work", "D:/workspace/file.txt"), false);
  assert.equal(isInsidePath("D:/work", "D:/work"), true);
  assert.equal(isInsidePath("D:/work", "D:/other"), false);
});

test("a protected prefix does not swallow a folder that merely starts the same", () => {
  // C:\WindowsApps-Backup is the user's, not the operating system's.
  if (process.platform === "win32") {
    assert.equal(isProtectedWriteTarget("C:/Windows/System32"), true);
    assert.equal(isProtectedWriteTarget("C:/Windows"), true);
    assert.equal(isProtectedWriteTarget("C:/WindowsApps-Backup/notes.txt"), false);
  } else {
    assert.equal(isProtectedWriteTarget("/etc/passwd"), true);
    assert.equal(isProtectedWriteTarget("/etcetera/notes.txt"), false);
  }
});

test("an unattended run stays in the workspace even mid-window", () => {
  // The grant is for working at the machine. A schedule firing at 3am must not
  // inherit it just because the arming window happens to still be open - the
  // same rule run_command already follows.
  const verdict = resolveForAccess("D:/trhai/package.json", {
    granted: false, // what agentTools passes when context.unattended is true
    intent: "read",
    insideWorkspace
  });
  assert.equal(verdict.ok, false);
});

test("listing follows the same rule as reading", () => {
  // The hole this closes: read_file and write_file could reach a project while
  // list_files could not, so the assistant could edit a file in a codebase but
  // never see what was in the folder - able to work on it only if told every
  // filename in advance.
  const granted = resolveForAccess("D:/trhai/apps", { granted: true, intent: "read", insideWorkspace });
  const refused = resolveForAccess("D:/trhai/apps", { granted: false, intent: "read", insideWorkspace });
  assert.equal(granted.ok, true);
  assert.equal(refused.ok, false);
});

// Which turns get the coding model.

test("an explicit code mode is code work", () => {
  for (const mode of ["build", "code", "debug", "coding", "plan"]) {
    assert.equal(isCodeWork(mode, "do the thing"), true, `${mode} should be code work`);
  }
});

test("a full path in the message is code work whatever the mode says", () => {
  // Someone asking to fix a file rarely announces that they are in code mode.
  assert.equal(isCodeWork("general", "fix D:/projects/app/src/index.ts please"), true);
  assert.equal(isCodeWork("general", "edit C:\\Users\\me\\thing.js"), true);
  assert.equal(isCodeWork("general", "look at /home/me/server.py"), true);
});

test("naming a file or a tool counts", () => {
  assert.equal(isCodeWork("general", "use edit_file to change the greeting"), true);
  assert.equal(isCodeWork("general", "refactor this"), true);
});

test("ordinary conversation is not code work", () => {
  // Sending every chat turn to the coding model would make the assistant worse
  // at the thing it does most.
  assert.equal(isCodeWork("general", "what is the weather like"), false);
  assert.equal(isCodeWork("general", "remind me what we discussed"), false);
  assert.equal(isCodeWork("general", "thanks, that is great"), false);
});
