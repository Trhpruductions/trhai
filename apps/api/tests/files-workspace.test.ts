import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { once } from "node:events";

// The Files workspace: one folder at a time with nothing silently left out,
// search by name and by content, and media previews that can never run code.

const workspace = mkdtempSync(path.join(tmpdir(), "ascend-files-ws-"));
const outside = mkdtempSync(path.join(tmpdir(), "ascend-files-outside-"));
process.env.ASCEND_WORKSPACE = workspace;
const dataDir = mkdtempSync(path.join(tmpdir(), "ascend-files-data-"));
process.env.ASSIST_MEMORY_FILE = path.join(dataDir, "memory.json");
process.env.ASSIST_CONVERSATION_FILE = path.join(dataDir, "conversations.json");
process.env.ASSIST_ACCOUNTS_FILE = path.join(dataDir, "accounts.json");
process.env.ASSIST_KNOWLEDGE_FILE = path.join(dataDir, "knowledge.json");
process.env.ASCEND_PREFERENCES_FILE = path.join(dataDir, "preferences.json");

const write = (relative: string, content: string | Buffer, ageMinutes = 0) => {
  const full = path.join(workspace, relative);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
  const when = new Date(Date.now() - ageMinutes * 60_000);
  utimesSync(full, when, when);
};

write("notes.md", "# Notes\nThe server listens on port 4000.\n", 30);
write("app2/server.js", "server.listen(3000);\n", 20);
write("app2/node_modules/dep/index.js", "module.exports = 'listen here too';\n", 10);
write("app10/README.md", "A second app.\n", 5);
write("app2/.vexora-app.json", JSON.stringify({ request: "a plant tracker", title: "Plant tracker", changes: ["add a notes field"] }), 25);
write("pic.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
write("clip.mp4", Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]));
write("page.html", "<script>alert(1)</script>");
write("drawing.svg", "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
writeFileSync(path.join(outside, "secret.txt"), "not yours");
let junction = false;
try {
  symlinkSync(outside, path.join(workspace, "escape"), "junction");
  junction = true;
} catch {
  // Some machines cannot make one; the containment test says so and skips.
}

const { createApp } = await import("../src/server.js");
const { findByName, listDirectory, newestChange } = await import("../src/services/workspace.js");

test.after(() => {
  for (const dir of [workspace, outside, dataDir]) rmSync(dir, { recursive: true, force: true });
});

test("a folder lists folders first, then files, in the order a person sorts them, with how much each folder holds", () => {
  const listed = listDirectory(".");
  assert.ok(listed && listed.kind === "ok");
  const names = listed.entries.map((entry) => entry.name);
  assert.deepEqual(names.filter((name) => name.startsWith("app")), ["app2", "app10"], "app2 before app10");
  assert.ok(names.indexOf("app10") < names.indexOf("notes.md"), "folders before files");
  assert.equal(listed.entries.find((entry) => entry.name === "app2")?.items, 3, "server.js, node_modules and the manifest");
  assert.equal(listed.entries.find((entry) => entry.name === "notes.md")?.path, "notes.md");
  assert.equal(listed.truncated, false);
});

test("a link out of the workspace is not listed, and cannot be opened", { skip: !junction && "could not create a junction here" }, () => {
  const listed = listDirectory(".");
  assert.ok(listed && listed.kind === "ok");
  assert.ok(!listed.entries.some((entry) => entry.name === "escape"));
  assert.equal(listDirectory("escape"), null);
});

test("a file, a missing folder and a path outside are each answered as what they are", () => {
  assert.deepEqual(listDirectory("notes.md"), { kind: "not-a-folder" });
  assert.deepEqual(listDirectory("no-such-folder"), { kind: "missing" });
  assert.equal(listDirectory("../"), null);
});

test("names are found anywhere below, newest first, without wading into dependencies", () => {
  const found = findByName(".", "READ");
  assert.deepEqual(found?.entries.map((entry) => entry.path), ["app10/README.md"]);
  assert.deepEqual(findByName(".", "index")?.entries, [], "node_modules is not searched");
  const apps = findByName(".", "app")?.entries ?? [];
  assert.deepEqual(apps.map((entry) => entry.path).sort(), ["app10", "app2", "app2/.vexora-app.json"]);
  assert.ok(apps.every((entry, index) => index === 0 || apps[index - 1].modifiedAt >= entry.modifiedAt), "newest first");
});

async function withServer(run: (baseUrl: string) => Promise<void>) {
  const server = createApp().listen(0);
  await once(server, "listening");
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("GET /v1/files/list reads one folder, and refuses what it should", async () => {
  await withServer(async (baseUrl) => {
    const root = await (await fetch(`${baseUrl}/v1/files/list`)).json() as any;
    assert.ok(root.data.entries.some((entry: { name: string }) => entry.name === "app2"));
    const inner = await (await fetch(`${baseUrl}/v1/files/list?path=app2`)).json() as any;
    const inside = inner.data.entries.map((entry: { path: string }) => entry.path);
    assert.equal(inside[0], "app2/node_modules", "the folder first");
    assert.deepEqual(inside.slice(1).sort(), ["app2/.vexora-app.json", "app2/server.js"]);
    assert.equal((await fetch(`${baseUrl}/v1/files/list?path=../`)).status, 400);
    assert.equal((await fetch(`${baseUrl}/v1/files/list?path=notes.md`)).status, 400);
    assert.equal((await fetch(`${baseUrl}/v1/files/list?path=nothing-here`)).status, 404);
  });
});

test("GET /v1/files/search finds names and lines, as workspace paths, outside dependencies", async () => {
  await withServer(async (baseUrl) => {
    const found = await (await fetch(`${baseUrl}/v1/files/search?q=listen`)).json() as any;
    assert.deepEqual(found.data.lines.map((line: { path: string; line: number }) => `${line.path}:${line.line}`).sort(),
      ["app2/server.js:1", "notes.md:2"]);
    assert.ok(found.data.lines.every((line: { path: string }) => !path.isAbsolute(line.path)), "no absolute paths");
    const byName = await (await fetch(`${baseUrl}/v1/files/search?q=notes`)).json() as any;
    assert.deepEqual(byName.data.names.map((entry: { path: string }) => entry.path), ["notes.md"]);
    assert.equal((await fetch(`${baseUrl}/v1/files/search?q=`)).status, 400);
    assert.equal((await fetch(`${baseUrl}/v1/files/search?q=x&path=../`)).status, 400);
  });
});

test("GET /v1/files/raw serves pictures and video, sandboxed and same-site, and nothing that could run", async () => {
  await withServer(async (baseUrl) => {
    const picture = await fetch(`${baseUrl}/v1/files/raw?path=pic.png`);
    assert.equal(picture.status, 200);
    assert.equal(picture.headers.get("content-type"), "image/png");
    assert.equal(picture.headers.get("cross-origin-resource-policy"), "same-site");
    assert.match(picture.headers.get("content-security-policy") ?? "", /sandbox/);
    assert.equal(picture.headers.get("x-content-type-options"), "nosniff");
    assert.equal((await picture.arrayBuffer()).byteLength, 8);

    const video = await fetch(`${baseUrl}/v1/files/raw?path=clip.mp4`, { headers: { Range: "bytes=0-3" } });
    assert.equal(video.status, 206, "a video can be sought through");

    assert.equal((await fetch(`${baseUrl}/v1/files/raw?path=page.html`)).status, 415);
    assert.equal((await fetch(`${baseUrl}/v1/files/raw?path=drawing.svg`)).status, 415, "SVG can carry script");
    assert.equal((await fetch(`${baseUrl}/v1/files/raw?path=missing.png`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/v1/files/raw?path=../secret.png`)).status, 400);
  });
});

test("when a folder last changed is its newest file, not the folder, and dependencies do not count", () => {
  const changed = newestChange("app2");
  assert.ok(changed !== null);
  // server.js was written 20 minutes ago, the manifest 25; node_modules (10 minutes) is skipped.
  const minutesAgo = (Date.now() - changed) / 60_000;
  assert.ok(minutesAgo > 19 && minutesAgo < 21, `${minutesAgo.toFixed(1)} minutes ago`);
  assert.equal(newestChange("../"), null);
});

test("GET /v1/apps/built lists each app with what it was asked to be, and DELETE removes one", async () => {
  await withServer(async (baseUrl) => {
    const listed = await (await fetch(`${baseUrl}/v1/apps/built`)).json() as any;
    const plant = listed.data.apps.find((entry: { name: string }) => entry.name === "app2");
    assert.ok(plant, "a folder with a server is an app");
    assert.equal(plant.title, "Plant tracker");
    assert.equal(plant.request, "a plant tracker");
    assert.deepEqual(plant.changes, ["add a notes field"]);
    assert.equal(plant.running, false);
    assert.equal(typeof plant.modifiedAt, "number");
    assert.ok(!listed.data.apps.some((entry: { name: string }) => entry.name === "app10"), "a folder without one is not");

    assert.equal((await fetch(`${baseUrl}/v1/apps/built/app10`, { method: "DELETE" })).status, 404);
    assert.equal((await fetch(`${baseUrl}/v1/apps/built/app2`, { method: "DELETE" })).status, 204);
    const after = await (await fetch(`${baseUrl}/v1/apps/built`)).json() as any;
    assert.ok(!after.data.apps.some((entry: { name: string }) => entry.name === "app2"));
  });
});
