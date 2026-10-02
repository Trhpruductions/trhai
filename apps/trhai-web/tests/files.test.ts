import test from "node:test";
import assert from "node:assert/strict";
import { absolutePath, crumbs, fileKind, formatBytes, languageOf, parentOf, sortEntries, type FileEntry } from "../src/lib/files.js";
import { detailFromHash, hashFor, viewFromHash } from "../src/os/views.js";

// The Files and Code workspaces' wording and ordering, and the address that
// carries a folder.

const entry = (name: string, directory: boolean, bytes: number, modifiedAt: number): FileEntry => ({ name, path: name, directory, bytes, modifiedAt });

test("sizes read in the units a person uses", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(14_540), "14.2 KB");
  assert.equal(formatBytes(3_250_000), "3.1 MB");
});

test("a path is the folders above it, each one a place to go, and its parent", () => {
  assert.deepEqual(crumbs("app2/src/lib"), [
    { name: "app2", path: "app2" }, { name: "src", path: "app2/src" }, { name: "lib", path: "app2/src/lib" }
  ]);
  assert.deepEqual(crumbs("."), []);
  assert.equal(parentOf("app2/src"), "app2");
  assert.equal(parentOf("app2"), ".");
});

test("a file's kind decides how it is shown, and SVG is never shown as a picture", () => {
  assert.equal(fileKind("shot.PNG"), "image");
  assert.equal(fileKind("video.mp4"), "video");
  assert.equal(fileKind("README.md"), "markdown");
  assert.equal(fileKind("server.js"), "code");
  assert.equal(fileKind("drawing.svg"), "code", "it can carry script");
  assert.equal(fileKind("Dockerfile"), "text");
  assert.equal(fileKind("report.pdf"), "document");
  assert.equal(fileKind("archive.zip"), "other");
  assert.equal(languageOf("index.tsx"), "TypeScript");
  assert.equal(languageOf("notes"), null);
});

test("folders come first however a folder is sorted, and names sort as a person sorts them", () => {
  const list = [entry("item10", false, 5, 3), entry("item2", false, 50, 1), entry("src", true, 0, 2)];
  assert.deepEqual(sortEntries(list, "name").map((item) => item.name), ["src", "item2", "item10"]);
  assert.deepEqual(sortEntries(list, "newest").map((item) => item.name), ["src", "item10", "item2"]);
  assert.deepEqual(sortEntries(list, "size").map((item) => item.name), ["src", "item2", "item10"]);
});

test("the path as this PC writes it", () => {
  assert.equal(absolutePath("D:\\Vexora\\workspace", "app2/server.js"), "D:\\Vexora\\workspace\\app2\\server.js");
  assert.equal(absolutePath("/home/me/workspace/", "."), "/home/me/workspace");
});

test("an address carries a folder within its view, and survives the round trip", () => {
  const hash = `#${hashFor("files", "app2/src lib")}`;
  assert.equal(viewFromHash(hash), "files");
  assert.equal(detailFromHash(hash), "app2/src lib");
  assert.equal(detailFromHash("#files"), null);
  assert.equal(hashFor("code"), "code");
  assert.equal(detailFromHash("#files/%E0%A4%A"), null, "a broken address is no place, not a crash");
});
