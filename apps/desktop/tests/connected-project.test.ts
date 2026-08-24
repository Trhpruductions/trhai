import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Persistence points at a scratch file before the module is imported, so a
// test run never reads or writes a real connected-project record.
const scratch = mkdtempSync(path.join(tmpdir(), "connected-store-"));
process.env.ASCEND_CONNECTED_PROJECT_FILE = path.join(scratch, "connected-project.json");

const projectModule = await import("../src/connectedProject.js");
const {
  connectProject,
  disconnectProject,
  getConnectedProject,
  listProjectFiles,
  maxReadBytes,
  readProjectFile,
  reloadConnectedProjectFromDisk,
  resetConnectedProject
} = projectModule;

/** A small project tree to connect to. */
function makeProject(): string {
  const root = mkdtempSync(path.join(tmpdir(), "connected-project-"));
  mkdirSync(path.join(root, "src"), { recursive: true });
  mkdirSync(path.join(root, "node_modules", "left-pad"), { recursive: true });
  mkdirSync(path.join(root, ".git"), { recursive: true });
  writeFileSync(path.join(root, "README.md"), "# Project", "utf8");
  writeFileSync(path.join(root, "src", "index.ts"), "export const answer = 42;", "utf8");
  writeFileSync(path.join(root, "node_modules", "left-pad", "index.js"), "module.exports = 1;", "utf8");
  return root;
}

function linkDirectory(target: string, linkPath: string): boolean {
  try {
    symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  }
}

test("connecting records the folder and reports its name", () => {
  resetConnectedProject();
  const root = makeProject();

  const result = connectProject(root);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.project.root, path.resolve(root));
  assert.equal(result.project.name, path.basename(root));
  assert.equal(getConnectedProject()?.root, path.resolve(root));
});

test("a file, a missing folder, and a non-string are all refused", () => {
  resetConnectedProject();
  const root = makeProject();

  assert.equal(connectProject(path.join(root, "README.md")).ok, false);
  assert.equal(connectProject(path.join(root, "does-not-exist")).ok, false);
  assert.equal(connectProject("").ok, false);
  assert.equal(connectProject(undefined).ok, false);
  assert.equal(connectProject(42).ok, false);

  // None of those should have left a connection behind.
  assert.equal(getConnectedProject(), null);
});

test("nothing is readable until a project is connected", () => {
  resetConnectedProject();

  assert.equal(listProjectFiles("."), null);
  assert.equal(readProjectFile("README.md").ok, false);
});

test("listing shows the project's own files and skips the noise", () => {
  resetConnectedProject();
  const root = makeProject();
  connectProject(root);

  const entries = listProjectFiles(".");
  assert.ok(entries);

  const names = entries.map((entry) => entry.path);
  assert.ok(names.includes("README.md"));
  assert.ok(names.includes("src"));
  // node_modules would exhaust the cap before reaching anything recognisable,
  // and .git is not the user's content.
  assert.equal(names.includes("node_modules"), false);
  assert.equal(names.includes(".git"), false);

  // Folders first, so a tree reads the way people expect.
  assert.equal(entries[0].directory, true);
});

test("listing a subfolder stays relative to the project root", () => {
  resetConnectedProject();
  const root = makeProject();
  connectProject(root);

  const entries = listProjectFiles("src");
  assert.ok(entries);
  assert.deepEqual(entries.map((entry) => entry.path), ["src/index.ts"]);
});

test("a file inside the project reads back", () => {
  resetConnectedProject();
  const root = makeProject();
  connectProject(root);

  const result = readProjectFile("src/index.ts");
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.match(result.content, /answer = 42/);
  assert.equal(result.truncated, false);
});

test("a file larger than the cap is truncated and says so", () => {
  resetConnectedProject();
  const root = makeProject();
  writeFileSync(path.join(root, "big.txt"), "x".repeat(maxReadBytes + 500), "utf8");
  connectProject(root);

  const result = readProjectFile("big.txt");
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.content.length, maxReadBytes);
  assert.equal(result.truncated, true);
});

test("escaping the project is refused, however it is spelled", () => {
  resetConnectedProject();
  const root = makeProject();
  const outside = mkdtempSync(path.join(tmpdir(), "connected-outside-"));
  writeFileSync(path.join(outside, "secret.txt"), "unreachable", "utf8");
  connectProject(root);

  for (const attempt of [
    "../secret.txt",
    "../../secret.txt",
    "src/../../secret.txt",
    path.join(outside, "secret.txt"),
    "C:\\Windows\\System32\\drivers\\etc\\hosts",
    "/etc/passwd"
  ]) {
    assert.equal(readProjectFile(attempt).ok, false, `"${attempt}" must be refused`);
  }

  assert.equal(listProjectFiles(".."), null);
});

test("a link inside the project pointing outside it is refused", () => {
  // containPath carries the symlink check, so this inherits it rather than
  // re-implementing it. Junctions because a real symlink needs admin rights
  // on Windows and a junction does not.
  resetConnectedProject();
  const root = makeProject();
  const outside = mkdtempSync(path.join(tmpdir(), "connected-linked-"));
  writeFileSync(path.join(outside, "secret.txt"), "unreachable", "utf8");

  if (!linkDirectory(outside, path.join(root, "escape-hatch"))) {
    assert.fail("could not create a directory link, so this protection is untested");
  }

  connectProject(root);
  assert.equal(readProjectFile("escape-hatch/secret.txt").ok, false);
  assert.equal(listProjectFiles("escape-hatch"), null);
});

test("disconnecting stops all reading", () => {
  resetConnectedProject();
  const root = makeProject();
  connectProject(root);
  assert.ok(readProjectFile("README.md").ok);

  assert.equal(disconnectProject(), true);
  assert.equal(getConnectedProject(), null);
  assert.equal(readProjectFile("README.md").ok, false);
  assert.equal(listProjectFiles("."), null);

  // Disconnecting twice reports that there was nothing to disconnect.
  assert.equal(disconnectProject(), false);
});

test("a connection survives a restart", () => {
  resetConnectedProject();
  const root = makeProject();
  connectProject(root);

  reloadConnectedProjectFromDisk();

  assert.equal(getConnectedProject()?.root, path.resolve(root));
  assert.equal(readProjectFile("README.md").ok, true);
});

test("a stored project that has since been deleted does not come back", () => {
  resetConnectedProject();
  const root = mkdtempSync(path.join(tmpdir(), "connected-vanishing-"));
  connectProject(root);

  // Simulate the folder being moved or removed between runs.
  rmSync(root, { recursive: true, force: true });
  assert.equal(existsSync(root), false);

  reloadConnectedProjectFromDisk();
  assert.equal(getConnectedProject(), null, "a root that no longer resolves must not read as connected");
});

test("the module exposes no way to write", () => {
  // Read-only is enforced by absence, not by a flag that could be flipped or
  // a permission that could be granted. If a write function is ever added,
  // this fails and the decision has to be made deliberately.
  const exported = Object.keys(projectModule).sort();
  const writeShaped = exported.filter((name) => /write|create|delete|remove|rename|move|mkdir|save/i.test(name));

  assert.deepEqual(
    writeShaped,
    [],
    `connectedProject.ts exposes write-shaped functions: ${writeShaped.join(", ")}`
  );
});
