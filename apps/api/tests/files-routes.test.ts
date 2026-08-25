import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import path from "node:path";

// The workspace is reachable over HTTP now, which means the sandbox has a
// second caller that is not the model. A browser can send "../../.ssh/id_rsa"
// exactly as easily as a model can, so these tests aim at the routes rather
// than at the workspace service the routes call — the question is whether the
// check is actually applied on this path, not whether it works in isolation.

const root = mkdtempSync(path.join(tmpdir(), "trhai-files-"));
process.env.ASCEND_WORKSPACE = root;

// A file inside, and a secret outside that nothing served should ever reach.
const outside = mkdtempSync(path.join(tmpdir(), "trhai-outside-"));
writeFileSync(path.join(outside, "secret.txt"), "do not serve this");
mkdirSync(path.join(root, "notes"), { recursive: true });
writeFileSync(path.join(root, "notes", "hello.txt"), "hello from the workspace");
writeFileSync(path.join(root, "top.txt"), "top level");

const { createApp } = await import("../src/server.js");
const server = createApp().listen(0);
await once(server, "listening");
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

test.after(() => {
  server.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

type Entry = { path: string; bytes: number; directory: boolean };

type Payload = {
  message?: string;
  data?: {
    root: string;
    path: string;
    entries: Entry[];
    content: string;
    truncated: boolean;
    limit: number;
    binary: boolean;
  };
};

async function get(pathAndQuery: string) {
  const response = await fetch(`${baseUrl}${pathAndQuery}`);
  const payload = (await response.json().catch(() => ({}))) as Payload;
  return { status: response.status, payload };
}

/** A request expected to succeed. Fails the test if it did not. */
async function getData(pathAndQuery: string) {
  const { status, payload } = await get(pathAndQuery);
  assert.equal(status, 200, `expected 200 from ${pathAndQuery}`);
  assert.ok(payload.data, "a 200 response must carry data");
  return payload.data;
}

/** A request expected to be refused. A refusal with no reason is a failure. */
async function getRefusal(pathAndQuery: string) {
  const { status, payload } = await get(pathAndQuery);
  assert.ok(status >= 400, `expected ${pathAndQuery} to be refused, got ${status}`);
  assert.ok(payload.message, "a refusal must say why");
  return { status, message: payload.message, body: JSON.stringify(payload) };
}

test("the workspace lists over http, with its root named", async () => {
  const data = await getData("/v1/files");

  const paths = data.entries.map((entry) => entry.path);
  assert.ok(paths.includes("top.txt"), `expected top.txt in ${JSON.stringify(paths)}`);
  assert.ok(paths.includes("notes"));
  assert.ok(paths.includes("notes/hello.txt"), "listing walks into directories");
  assert.equal(data.root, root, "the page can say where these files actually are");
});

test("directories are marked as directories, and files carry their size", async () => {
  const data = await getData("/v1/files");

  const notes = data.entries.find((entry) => entry.path === "notes");
  const file = data.entries.find((entry) => entry.path === "top.txt");
  assert.equal(notes?.directory, true);
  assert.equal(file?.directory, false);
  assert.equal(file?.bytes, Buffer.byteLength("top level"));
});

test("a small workspace is not reported as truncated", async () => {
  const data = await getData("/v1/files");
  assert.equal(data.truncated, false, "three files is not a capped listing");
  assert.ok(data.limit > 0, "the cap is stated so a page can explain itself");
});

test("a listing that hits the cap says so rather than looking complete", async () => {
  // A capped listing is indistinguishable from a complete one unless it is
  // labelled, and the page would then imply "this is everything" about a
  // directory it only partly read.
  const many = path.join(root, "many");
  mkdirSync(many, { recursive: true });
  for (let index = 0; index < 205; index += 1) {
    writeFileSync(path.join(many, `file-${index}.txt`), "x");
  }

  try {
    const data = await getData("/v1/files");
    assert.equal(data.truncated, true);
    assert.equal(data.entries.length, data.limit, "it stops at the cap it reports");
  } finally {
    rmSync(many, { recursive: true, force: true });
  }
});

test("a file reads back over http", async () => {
  const data = await getData("/v1/files/content?path=notes/hello.txt");

  assert.equal(data.content, "hello from the workspace");
  assert.equal(data.truncated, false);
});

test("an extensionless text file is readable, not called binary", async () => {
  // The case that exposed the original flaw: a name-based check reported
  // .git/config, HEAD and COMMIT_EDITMSG as "not a text file" when all three
  // are plainly readable.
  mkdirSync(path.join(root, ".git"), { recursive: true });
  writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/master\n");
  writeFileSync(path.join(root, ".git", "COMMIT_EDITMSG"), "a commit message\n");

  for (const name of [".git/HEAD", ".git/COMMIT_EDITMSG"]) {
    const data = await getData(`/v1/files/content?path=${encodeURIComponent(name)}`);
    assert.equal(data.binary, false, `${name} is text`);
    assert.ok(data.content.length > 0, `${name} should read back`);
  }
});

test("a genuinely binary file is reported as binary and its bytes withheld", async () => {
  // A PNG header: a NUL byte in the first few bytes, which no text has.
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
  writeFileSync(path.join(root, "image.png"), png);

  const data = await getData("/v1/files/content?path=image.png");
  assert.equal(data.binary, true);
  assert.equal(data.content, "", "noise is not sent to be rendered as mojibake");
});

test("an empty file is text, not binary", async () => {
  writeFileSync(path.join(root, "empty.txt"), "");

  const data = await getData("/v1/files/content?path=empty.txt");
  assert.equal(data.binary, false, "nothing in it is not the same as unreadable");
  assert.equal(data.content, "");
});

test("text with accents and emoji is not mistaken for binary", async () => {
  writeFileSync(path.join(root, "unicode.txt"), "café · naïve · 日本語 · 🎉\n", "utf8");

  const data = await getData("/v1/files/content?path=unicode.txt");
  assert.equal(data.binary, false);
  assert.match(data.content, /café/);
  assert.match(data.content, /日本語/);
});

test("a path climbing out of the workspace is refused, not served", async () => {
  for (const attempt of ["../secret.txt", "../../etc/passwd", "notes/../../escape.txt"]) {
    const refusal = await getRefusal(`/v1/files/content?path=${encodeURIComponent(attempt)}`);
    assert.equal(refusal.status, 400, `${attempt} should be refused`);
    assert.match(refusal.message, /outside the workspace/);
  }
});

test("an absolute path is refused even when it exists", async () => {
  const absolute = path.join(outside, "secret.txt");
  const refusal = await getRefusal(`/v1/files/content?path=${encodeURIComponent(absolute)}`);

  assert.equal(refusal.status, 400);
  assert.ok(!refusal.body.includes("do not serve this"), "the secret must not appear anywhere in the response");
});

test("listing outside the workspace is refused too, not just reading", async () => {
  const refusal = await getRefusal(`/v1/files?path=${encodeURIComponent("..")}`);
  assert.equal(refusal.status, 400);
});

test("a refused path and a missing file are told apart", async () => {
  // Conflating them would answer "does this path exist outside the
  // workspace?" for anyone probing, which is exactly what the sandbox is for.
  const missing = await getRefusal("/v1/files/content?path=nope.txt");
  assert.equal(missing.status, 404);

  const refused = await getRefusal("/v1/files/content?path=../secret.txt");
  assert.equal(refused.status, 400);
});

test("a link pointing out of the workspace is not followed", async (t) => {
  // A junction on Windows, a symlink elsewhere. workspace.ts calls the
  // junction out by name because it is the same escape and, unlike a
  // symlink, needs no privileges at all to create — so on the platform this
  // is most likely to run on, the attack is available to anyone.
  const link = path.join(root, "escape-link");
  const kind = process.platform === "win32" ? "junction" : "dir";
  try {
    symlinkSync(outside, link, kind);
  } catch {
    t.skip(`this machine does not permit creating a ${kind}`);
    return;
  }

  const refusal = await getRefusal("/v1/files/content?path=escape-link/secret.txt");
  assert.equal(refusal.status, 400, "a link out of the workspace is still out of the workspace");
  assert.ok(!refusal.body.includes("do not serve this"));

  // And it must not be reachable by listing either, which is a separate code
  // path from reading and could easily have been left open.
  const listed = await getRefusal("/v1/files?path=escape-link");
  assert.equal(listed.status, 400, "listing through the link is refused too");
});

test("reading a directory says so rather than returning something odd", async () => {
  const refusal = await getRefusal("/v1/files/content?path=notes");
  assert.equal(refusal.status, 400);
  assert.match(refusal.message, /is a directory/);
});
