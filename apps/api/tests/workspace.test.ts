import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = mkdtempSync(path.join(tmpdir(), "ascend-workspace-"));
process.env.ASCEND_WORKSPACE = root;

const {
  listWorkspace,
  maxListedFiles,
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

// Symlink containment.
//
// path.resolve is lexical and never reads the disk, so a link inside the
// workspace pointing out of it resolves to a path that looks perfectly
// contained. This file asserted containment for years while nothing checked
// for it, and a comment in workspace.ts claimed the protection existed.
//
// Junctions rather than symlinks: creating a real symlink on Windows needs
// administrator rights or developer mode, while a junction needs neither —
// which makes it the escape an unprivileged attacker would actually reach
// for, and the one worth testing.

const outsideRoot = mkdtempSync(path.join(tmpdir(), "ascend-outside-"));
writeFileSync(path.join(outsideRoot, "secret.txt"), "should never be reachable", "utf8");

/** Junction on Windows, directory symlink elsewhere. Null when unsupported. */
function linkDirectory(target: string, linkPath: string): boolean {
  try {
    symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  }
}

test("a link inside the workspace pointing outside it is refused", () => {
  const linkPath = path.join(root, "escape-hatch");
  if (!linkDirectory(outsideRoot, linkPath)) {
    assert.fail("could not create a directory link, so this protection is untested");
  }

  // Every one of these is lexically inside the workspace. Only reading the
  // disk reveals that they are not.
  assert.equal(resolveInWorkspace("escape-hatch"), null);
  assert.equal(resolveInWorkspace("escape-hatch/secret.txt"), null);
  assert.equal(resolveInWorkspace("escape-hatch/newly-written.txt"), null);
});

test("reading and writing through such a link both fail", () => {
  // The guard is only useful if the operations that depend on it stop too.
  const read = readWorkspaceFile("escape-hatch/secret.txt");
  assert.equal(read.ok, false);

  const write = writeWorkspaceFile("escape-hatch/planted.txt", "should not land");
  assert.equal(write.ok, false);

  // And nothing was created outside on the way to failing.
  assert.equal(existsSync(path.join(outsideRoot, "planted.txt")), false);
});

test("a link that stays inside the workspace still works", () => {
  // The check must not refuse every link, only ones that leave. Without this
  // the fix could be "return null more often" and still pass everything else.
  const realDir = path.join(root, "real-target");
  mkdirSync(realDir, { recursive: true });
  writeFileSync(path.join(realDir, "inside.txt"), "reachable", "utf8");

  const linkPath = path.join(root, "inside-link");
  if (!linkDirectory(realDir, linkPath)) {
    assert.fail("could not create a directory link, so this protection is untested");
  }

  assert.ok(resolveInWorkspace("inside-link/inside.txt"));
  const read = readWorkspaceFile("inside-link/inside.txt");
  assert.equal(read.ok, true);
});

test("a listing carries modification times, so newest-first is answerable", async () => {
  // Inside the suite's own workspace rather than a fresh one: reassigning
  // ASCEND_WORKSPACE mid-file would leak into every test that ran after this.
  const folder = path.join(root, "mtime-check");
  mkdirSync(folder, { recursive: true });

  // Written oldest-first, but named so alphabetical order is the reverse of
  // chronological order. That is the exact shape that made the work view show
  // an unrelated older project: reversing a directory walk is not the same as
  // sorting by time, and with these names the two disagree completely.
  writeFileSync(path.join(folder, "zebra.txt"), "written first");
  await new Promise((resolve) => setTimeout(resolve, 20));
  writeFileSync(path.join(folder, "apple.txt"), "written second");

  const entries = listWorkspace("mtime-check");
  assert.ok(entries);

  const byName = Object.fromEntries(entries.map((entry) => [entry.path, entry]));
  const zebra = byName["mtime-check/zebra.txt"];
  const apple = byName["mtime-check/apple.txt"];
  assert.ok(zebra && apple, `expected both files, got ${Object.keys(byName).join(", ")}`);
  assert.equal(typeof zebra.modifiedAt, "number");

  // The newer file really is newer by the number the client sorts on.
  assert.ok(
    apple.modifiedAt > zebra.modifiedAt,
    "the file written second did not report a later modification time"
  );

  // And sorting by it disagrees with reversing the walk, which is the point.
  const newestFirst = entries
    .filter((entry) => !entry.directory)
    .sort((left, right) => right.modifiedAt - left.modifiedAt);
  assert.equal(newestFirst[0].path, "mtime-check/apple.txt");
});

test("a truncated listing keeps the newest files, not the first ones walked", async () => {
  const folder = path.join(root, "truncation-check");
  mkdirSync(folder, { recursive: true });

  // More files than a listing returns, written oldest-first with names that
  // put the newest last in directory order. Before the server sorted ahead of
  // truncating, the response was simply the first N the walk reached — so a
  // project created a minute ago could be absent from the listing entirely
  // while a year-old one filled it, and the work view showed the wrong app.
  const count = maxListedFiles + 30;
  for (let index = 0; index < count; index += 1) {
    writeFileSync(path.join(folder, `f${String(index).padStart(4, "0")}.txt`), `file ${index}`);
  }

  const entries = listWorkspace("truncation-check");
  assert.ok(entries);
  assert.ok(entries.length <= maxListedFiles, `listing returned ${entries.length}`);

  // The last file written must survive truncation.
  const newestName = `truncation-check/f${String(count - 1).padStart(4, "0")}.txt`;
  assert.ok(
    entries.some((entry) => entry.path === newestName),
    "the most recently written file was truncated out of the listing"
  );

  // And the listing is ordered newest-first, so the client does not have to
  // guess at it either.
  for (let index = 1; index < entries.length; index += 1) {
    assert.ok(
      entries[index - 1].modifiedAt >= entries[index].modifiedAt,
      `listing was not newest-first at index ${index}`
    );
  }
});
