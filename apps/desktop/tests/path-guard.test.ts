import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
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
