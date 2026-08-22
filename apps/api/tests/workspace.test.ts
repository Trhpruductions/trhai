import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = mkdtempSync(path.join(tmpdir(), "ascend-workspace-"));
process.env.ASCEND_WORKSPACE = root;

const {
  listWorkspace,
  maxReadBytes,
  readWorkspaceFile,
  resolveInWorkspace,
  writeWorkspaceFile
} = await import("../src/services/workspace.js");

test("an ordinary relative path resolves inside the workspace", () => {
  const resolved = resolveInWorkspace("notes/todo.txt");
  assert.ok(resolved);
  assert.ok(resolved!.startsWith(path.resolve(root)));
});

test("escaping the workspace is refused, however it is spelled", () => {
  // This is the security boundary. Every one of these is a real technique, and
  // the check is "resolve it and see where it landed" rather than a blocklist
  // of patterns — a blocklist is a list you can always add one more entry to.
  for (const attempt of [
    "../secrets.txt",
    "../../etc/passwd",
    "notes/../../escape.txt",
    "./../../escape.txt",
    "..",
    "../",
    "foo/../../..",
    "\0evil"
  ]) {
    assert.equal(resolveInWorkspace(attempt), null, attempt);
  }
});

test("an absolute path is refused", () => {
  // String.raw, because a Windows path written with ordinary escapes is not
  // the path it looks like: "C:\Windows" is read by the compiler as
  // "C:Windows", which is drive-relative rather than absolute. An earlier
  // version of this test asserted on that and was testing nothing.
  assert.equal(resolveInWorkspace("/etc/passwd"), null);
  assert.equal(resolveInWorkspace(String.raw`C:\Windows\System32\config\SAM`), null);
  assert.equal(resolveInWorkspace(String.raw`\server\shareile`), null);
});

test("a drive-relative path is contained rather than escaping", () => {
  // "C:Windows" with no separator means "the Windows directory on C:, relative
  // to the current directory on C:" — which is not an escape, and resolving it
  // inside the workspace is the right outcome. Worth stating, because it looks
  // like an absolute path at a glance.
  const resolved = resolveInWorkspace("C:WindowsSystem32");
  assert.ok(resolved);
  assert.ok(resolved!.startsWith(path.resolve(root)));
});

test("a sibling directory with the same prefix is not inside", () => {
  // startsWith(root) alone would let "/workspace-evil" through, because it
  // does start with "/workspace". The separator is what makes it a child.
  assert.equal(resolveInWorkspace(`../${path.basename(root)}-evil/file.txt`), null);
});

test("an empty or non-string path is refused", () => {
  assert.equal(resolveInWorkspace(""), null);
  assert.equal(resolveInWorkspace("   "), null);
  assert.equal(resolveInWorkspace(undefined as unknown as string), null);
  assert.equal(resolveInWorkspace(42 as unknown as string), null);
});

test("a file can be written and read back", () => {
  const written = writeWorkspaceFile("notes/hello.txt", "hello there");
  assert.equal(written.ok, true);

  const read = readWorkspaceFile("notes/hello.txt");
  assert.equal(read.ok, true);
  if (read.ok) {
    assert.equal(read.content, "hello there");
    assert.equal(read.truncated, false);
  }
});

test("writing outside the workspace is refused and writes nothing", () => {
  const result = writeWorkspaceFile("../escaped.txt", "should not exist");
  assert.equal(result.ok, false);

  const readBack = readWorkspaceFile("../escaped.txt");
  assert.equal(readBack.ok, false);
});

test("reading a file that is not there says so", () => {
  const result = readWorkspaceFile("nothing/here.txt");
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /no file/);
});

test("reading a directory is refused rather than returning nonsense", () => {
  mkdirSync(path.join(root, "somedir"), { recursive: true });
  const result = readWorkspaceFile("somedir");

  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /directory/);
});

test("a large file is truncated and says it was", () => {
  // Silently returning the first 100KB would have the assistant answer about a
  // file it has only partly seen, with no way for the reader to know.
  writeFileSync(path.join(root, "big.txt"), "x".repeat(maxReadBytes + 5000));
  const result = readWorkspaceFile("big.txt");

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.truncated, true);
    assert.equal(result.content.length, maxReadBytes);
  }
});

test("an oversized write is refused", () => {
  const result = writeWorkspaceFile("huge.txt", "x".repeat(600_000));
  assert.equal(result.ok, false);
});

test("listing reports files under the workspace with sizes", () => {
  const written = writeWorkspaceFile("listed/one.txt", "abc");
  assert.equal(written.ok, true, written.ok ? "" : written.reason);

  const entries = listWorkspace("listed");

  assert.ok(entries);
  const one = entries!.find((entry) => entry.path === "listed/one.txt");
  assert.ok(one, "expected listed/one.txt in the listing");
  assert.equal(one!.bytes, 3);
  assert.equal(one!.directory, false);
});
 const written = writeWorkspaceFile("listed/one.txt", "abc");

test("listing outside the workspace is refused", () => {
  assert.equal(listWorkspace(".."), null);
  assert.equal(listWorkspace("/etc"), null);
});

test("listing a directory that does not exist is empty, not an error", () => {
  assert.deepEqual(listWorkspace("never-created"), []);
});

test("the default workspace is outside the repo", async () => {
  // It used to be <cwd>/workspace, which put every app the assistant built
  // inside the project's own source tree — gitignored to stay out of commits,
  // destroyed by a clean checkout, and in a place nobody would think to look
  // for the app they asked for.
  const previous = process.env.ASCEND_WORKSPACE;
  delete process.env.ASCEND_WORKSPACE;

  try {
    const { workspaceRoot } = await import("../src/services/workspace.js");
    const resolved = path.resolve(workspaceRoot());

    assert.ok(
      !resolved.startsWith(path.resolve(process.cwd())),
      `the workspace must not live inside the project: ${resolved}`
    );
    assert.match(resolved, /Vexora/);
  } finally {
    if (previous === undefined) delete process.env.ASCEND_WORKSPACE;
    else process.env.ASCEND_WORKSPACE = previous;
  }
});
