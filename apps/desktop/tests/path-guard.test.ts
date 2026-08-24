import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { containPath, isSafeExternalUrl, isTrustedAppUrl } from "../src/pathGuard.js";

const root = path.resolve("/workspace");

test("an ordinary path resolves inside the workspace", () => {
  const result = containPath(root, "generated-projects", "notes.md");

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.path, path.resolve(root, "generated-projects", "notes.md"));
});

test("a traversal sequence is refused", () => {
  // The regression: create-scaffold resolved the renderer's path with no check,
  // so mkdir and writeFile landed outside the workspace.
  for (const segment of ["..", "../..", "../../etc", "generated-projects/../../.."]) {
    const result = containPath(root, segment, "payload.txt");
    assert.equal(result.ok, false, `"${segment}" should be refused`);
  }
});

test("an absolute path is refused even with no traversal sequence", () => {
  // path.resolve honours an absolute segment by discarding everything before
  // it, so checking the input for ".." would not have caught this.
  const absolute = process.platform === "win32" ? "C:\\Windows\\System32" : "/etc";
  const result = containPath(root, absolute, "payload.txt");

  assert.equal(result.ok, false);
});

test("the workspace root itself is inside the workspace", () => {
  const result = containPath(root, ".");

  assert.equal(result.ok, true);
});

test("a missing or empty segment is refused", () => {
  assert.equal(containPath(root, "").ok, false);
  assert.equal(containPath(root, "dir", undefined as unknown as string).ok, false);
});

test("only web schemes are handed to the operating system", () => {
  assert.equal(isSafeExternalUrl("https://example.com"), true);
  assert.equal(isSafeExternalUrl("http://example.com"), true);
  assert.equal(isSafeExternalUrl("mailto:someone@example.com"), true);

  // openExternal asks the OS to act on the string, so these must not reach it.
  assert.equal(isSafeExternalUrl("file:///C:/Windows/System32/cmd.exe"), false);
  assert.equal(isSafeExternalUrl("javascript:alert(1)"), false);
  assert.equal(isSafeExternalUrl("ms-msdt:/id"), false);
  assert.equal(isSafeExternalUrl("not a url"), false);
});

test("the window may only sit on the local app", () => {
  // Wherever this window navigates inherits a bridge that runs shell commands.
  assert.equal(isTrustedAppUrl("http://127.0.0.1:5173/"), true);
  assert.equal(isTrustedAppUrl("http://localhost:5173/dashboard"), true);
  assert.equal(isTrustedAppUrl("file:///C:/app/index.html"), true);

  assert.equal(isTrustedAppUrl("https://example.com"), false);
  assert.equal(isTrustedAppUrl("http://127.0.0.1.evil.com/"), false);
  assert.equal(isTrustedAppUrl("http://evil.com/?x=127.0.0.1"), false);
  assert.equal(isTrustedAppUrl("garbage"), false);
});

test("the same rule decides who may call in over IPC", () => {
  // handleFromAppWindow gates every channel on this, using the frame's URL.
  // ipcMain.handle answers any frame that knows a channel name, including an
  // iframe or anything injected into the page, so the rule governing where
  // the window may navigate has to be the rule governing who may call in —
  // otherwise the two can disagree and the weaker one wins.
  const senderUrls = [
    ["http://127.0.0.1:5173/", true],
    ["http://localhost:5173/", true],
    ["file:///C:/app/index.html", true],
    // An embedded frame pointed somewhere else is the case this closes.
    ["https://ads.example.com/frame.html", false],
    ["http://127.0.0.1.evil.com/", false],
    // A frame with no URL at all must fail closed, not pass by default.
    ["", false]
  ] as const;

  for (const [url, expected] of senderUrls) {
    assert.equal(isTrustedAppUrl(url), expected, `sender ${url || "(none)"}`);
  }
});

test("a project folder is inside the workspace but a sibling executable is not", () => {
  // What ascend:open-path now enforces. It used to path.resolve() whatever the
  // renderer sent and hand it to shell.openPath, which asks the OS to *act on*
  // it — running an .exe or .bat. These are the shapes that must not resolve.
  const root = path.resolve("/workspace");

  assert.equal(containPath(root, "apps/web").ok, true);
  assert.equal(containPath(root, "generated-projects/my-app").ok, true);

  assert.equal(containPath(root, "C:\\Windows\\System32\\cmd.exe").ok, false);
  assert.equal(containPath(root, "../../Windows/System32/calc.exe").ok, false);
  assert.equal(containPath(root, "\\\\evil-share\\payload.exe").ok, false);
});

// Symlink containment, the same gap that existed in the API's guard.
//
// path.resolve is lexical and never reads the disk, so a link inside the
// workspace pointing out of it resolves to a path that looks contained.
// create-scaffold writes through this guard, so the escape was a write
// primitive, not only a read one.
//
// Junctions rather than symlinks: a real symlink on Windows needs
// administrator rights, a junction needs none — so it is the escape actually
// available to an attacker, and the one worth testing.

/** Junction on Windows, directory symlink elsewhere. False when unsupported. */
function linkDirectory(target: string, linkPath: string): boolean {
  try {
    symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  }
}

test("a link inside the workspace pointing outside it is refused", () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "guard-workspace-"));
  const outside = mkdtempSync(path.join(tmpdir(), "guard-outside-"));
  writeFileSync(path.join(outside, "secret.txt"), "unreachable", "utf8");

  const linkPath = path.join(workspace, "escape-hatch");
  if (!linkDirectory(outside, linkPath)) {
    assert.fail("could not create a directory link, so this protection is untested");
  }

  // Lexically these are all inside the workspace. Only the disk disagrees.
  assert.equal(containPath(workspace, "escape-hatch").ok, false);
  assert.equal(containPath(workspace, "escape-hatch", "secret.txt").ok, false);
  // The one that matters for create-scaffold: a file that does not exist yet.
  assert.equal(containPath(workspace, "escape-hatch", "planted.txt").ok, false);
});

test("a link that stays inside the workspace still resolves", () => {
  // The fix must not simply refuse every link.
  const workspace = mkdtempSync(path.join(tmpdir(), "guard-inside-"));
  const realDir = path.join(workspace, "real-target");
  mkdirSync(realDir, { recursive: true });

  const linkPath = path.join(workspace, "inside-link");
  if (!linkDirectory(realDir, linkPath)) {
    assert.fail("could not create a directory link, so this protection is untested");
  }

  assert.equal(containPath(workspace, "inside-link", "notes.txt").ok, true);
});

test("a workspace that is itself reached through a link still passes its own check", () => {
  // The root is resolved as well as the target. Without that, a workspace
  // sitting under a linked path would fail every check it made about itself.
  const realBase = mkdtempSync(path.join(tmpdir(), "guard-realbase-"));
  const workspace = path.join(realBase, "workspace");
  mkdirSync(workspace, { recursive: true });

  const linkedBase = path.join(mkdtempSync(path.join(tmpdir(), "guard-linkbase-")), "link");
  if (!linkDirectory(realBase, linkedBase)) {
    assert.fail("could not create a directory link, so this protection is untested");
  }

  const workspaceViaLink = path.join(linkedBase, "workspace");
  assert.equal(containPath(workspaceViaLink, "notes.txt").ok, true);
});
