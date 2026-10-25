import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { fakeEngine } from "./helpers/fakeEngine.js";

// The screen opens a file the assistant made through this route, and the reply that made it carries the file. What is
// tested here is who may ask, what they must send, what comes back - and that the reply to "make me a Word document"
// names the file. Nothing is really opened: a stand-in takes the place of starting a program.

const workspace = mkdtempSync(path.join(tmpdir(), "trhai-open-routes-"));
const dataDir = mkdtempSync(path.join(tmpdir(), "trhai-open-routes-data-"));
const licenseDir = mkdtempSync(path.join(tmpdir(), "trhai-open-routes-license-"));
process.env.ASCEND_WORKSPACE = workspace;
process.env.ASSIST_MEMORY_FILE = path.join(dataDir, "memory.json");
process.env.ASSIST_ACCOUNTS_FILE = path.join(dataDir, "accounts.json");
process.env.ASSIST_CONVERSATION_FILE = path.join(dataDir, "conversations.json");
process.env.ASSIST_KNOWLEDGE_FILE = path.join(dataDir, "knowledge.json");
process.env.ASCEND_PREFERENCES_FILE = path.join(dataDir, "preferences.json");
process.env.TRHAI_LICENSE_FILE = path.join(licenseDir, "license.json");
process.env.TRHAI_TRIAL_MARKER = path.join(licenseDir, "elsewhere", "trial-started");
delete process.env.TRHAI_PAYWALL;
mkdirSync(path.join(workspace, "documents"), { recursive: true });
writeFileSync(path.join(workspace, "documents", "Report.docx"), "x");
writeFileSync(path.join(workspace, "documents", "tool.exe"), "x");

const { createApp } = await import("../src/server.js");
const { registerFileOpenRoutes } = await import("../src/fileOpenRoutes.js");
const { useLauncher } = await import("../src/services/openInSystem.js");
const { resetLicensingForTests, trialDays } = await import("../src/services/licensing.js");
const { writeProtectedJsonFile } = await import("../src/services/protectedJson.js");

const server = createApp().listen(0, "127.0.0.1");
await once(server, "listening");
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const launched: string[][] = [];
test.beforeEach(() => {
  // A trial that one test ended is not the next test's.
  rmSync(process.env.TRHAI_LICENSE_FILE as string, { force: true });
  rmSync(process.env.TRHAI_TRIAL_MARKER as string, { force: true });
  resetLicensingForTests();
  launched.length = 0;
  useLauncher(async (_program, args) => { launched.push(args); return true; });
});
test.after(async () => {
  useLauncher();
  resetLicensingForTests();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(workspace, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(licenseDir, { recursive: true, force: true });
});

type Reply = { status: number; body: Record<string, any> };
async function post(route: string, payload: unknown, type: string | null = "application/json", base = baseUrl): Promise<Reply> {
  const response = await fetch(`${base}${route}`, { method: "POST", headers: type ? { "Content-Type": type } : {}, body: typeof payload === "string" ? payload : JSON.stringify(payload) });
  return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, any> };
}

test("a file is opened, and shown in its folder, when this PC asks", async () => {
  const opened = await post("/v1/files/open", { path: "documents/Report.docx" });
  assert.equal(opened.status, 200);
  assert.deepEqual(opened.body.data, { action: "open", path: "documents/Report.docx" });
  const shown = await post("/v1/files/open", { path: "documents/Report.docx", action: "reveal" });
  assert.equal(shown.status, 200);
  assert.equal(shown.body.data.action, "reveal");
  assert.equal(launched.length, 2);
  assert.equal(launched[0][0], path.join(workspace, "documents", "Report.docx"));
  assert.equal(launched[1][0], `/select,"${path.join(workspace, "documents", "Report.docx")}"`);
});

test("it must arrive as JSON, so that a page on another site cannot send it", async () => {
  for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", null]) {
    const reply = await post("/v1/files/open", JSON.stringify({ path: "documents/Report.docx" }), type);
    assert.equal(reply.status, 415, String(type));
    assert.equal(reply.body.code, "UNSUPPORTED_MEDIA_TYPE");
  }
  assert.deepEqual(launched, []);
});

test("only this PC may ask, because the file appears on this PC's screen", async () => {
  const other = express();
  other.use(express.json());
  registerFileOpenRoutes(other, { isThisPc: () => false });
  const listener = other.listen(0, "127.0.0.1");
  await once(listener, "listening");
  try {
    const reply = await post("/v1/files/open", { path: "documents/Report.docx" }, "application/json", `http://127.0.0.1:${(listener.address() as AddressInfo).port}`);
    assert.equal(reply.status, 403);
    assert.equal(reply.body.code, "FORBIDDEN");
    assert.deepEqual(launched, []);
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
});

test("a request that is not a place in the workspace, a file that is not there and a file that could run are each refused plainly", async () => {
  const cases: Array<[unknown, number, string]> = [
    [{}, 400, "INVALID_REQUEST"],
    [{ path: "" }, 400, "INVALID_REQUEST"],
    [{ path: 42 }, 400, "INVALID_REQUEST"],
    [{ path: "x".repeat(1001) }, 400, "INVALID_REQUEST"],
    [{ path: "documents/Report.docx", action: "delete" }, 400, "INVALID_REQUEST"],
    [{ path: "../outside.docx" }, 400, "INVALID_REQUEST"],
    [{ path: "C:\\Windows\\System32\\calc.exe" }, 400, "INVALID_REQUEST"],
    [{ path: "documents/missing.docx" }, 404, "NOT_FOUND"],
    [{ path: "documents/tool.exe" }, 415, "UNSUPPORTED_MEDIA_TYPE"]
  ];
  for (const [payload, status, code] of cases) {
    const reply = await post("/v1/files/open", payload);
    assert.equal(reply.status, status, JSON.stringify(payload).slice(0, 60));
    assert.equal(reply.body.code, code, JSON.stringify(payload).slice(0, 60));
    assert.equal(typeof reply.body.message, "string");
  }
  assert.deepEqual(launched, []);
});

test("a program that will not start is a server error, not a success", async () => {
  useLauncher(async () => false);
  const reply = await post("/v1/files/open", { path: "documents/Report.docx" });
  assert.equal(reply.status, 500);
  assert.equal(reply.body.code, "OPEN_FAILED");
});

test("opening a file the person already has is not work: it still opens when the trial is over", async () => {
  writeProtectedJsonFile(process.env.TRHAI_LICENSE_FILE as string, { trialStartedAt: new Date(Date.now() - (trialDays + 1) * 24 * 60 * 60 * 1000).toISOString() });
  resetLicensingForTests();
  const refused = await post("/v1/music-video/cancel", {});
  assert.equal(refused.status, 402, "the paywall is on, so the next is not open by accident");
  const reply = await post("/v1/files/open", { path: "documents/Report.docx" });
  assert.equal(reply.status, 200);
});

test("and so does the streamed reply, in the event that ends it", async () => {
  const notes = "# Streamed Notes\n\n- one\n- two\n\nThe end.";
  const model = await fakeEngine({
    reply: [
      { message: { content: "", tool_calls: [{ function: { name: "make_document", arguments: { title: "Streamed Notes", content: notes } } }] } },
      { message: { content: "Done." } }
    ]
  });
  const previous = process.env.TRHAI_ENGINE_URL;
  process.env.TRHAI_ENGINE_URL = model.baseUrl;
  try {
    const response = await fetch(`${baseUrl}/v1/assist/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "general", sessionId: "session-open-files-stream", message: "Make me a Word document of these notes: one, two." })
    });
    assert.equal(response.status, 200);
    const events = (await response.text()).split("\n\n").map((chunk) => chunk.trim()).filter(Boolean);
    const finished = events.find((chunk) => chunk.startsWith("event: done"));
    assert.ok(finished, `a done event: ${events.map((chunk) => chunk.split("\n")[0]).join(", ")}`);
    const data = JSON.parse(finished.split("\n").find((line) => line.startsWith("data: "))!.slice("data: ".length));
    assert.deepEqual(data.files, ["documents/Streamed Notes.docx"]);
  } finally {
    if (previous === undefined) delete process.env.TRHAI_ENGINE_URL; else process.env.TRHAI_ENGINE_URL = previous;
    model.server.close();
  }
});

test("the reply that made a document says which file, as a path in the workspace", async () => {
  const notes = "# Meeting Notes\n\n- Budget approved\n- Hiring paused\n\nNext meeting on Friday.";
  const model = await fakeEngine({
    reply: [
      { message: { content: "", tool_calls: [{ function: { name: "make_document", arguments: { title: "Meeting Notes", content: notes } } }] } },
      { message: { content: "Done." } }
    ]
  });
  const previous = process.env.TRHAI_ENGINE_URL;
  process.env.TRHAI_ENGINE_URL = model.baseUrl;
  try {
    const reply = await post("/v1/assist", { mode: "general", sessionId: "session-open-files", message: "Make me a Word document of the meeting notes: budget approved, hiring paused." });
    assert.equal(reply.status, 200, JSON.stringify(reply.body).slice(0, 300));
    assert.deepEqual(reply.body.data.files, ["documents/Meeting Notes.docx"]);
    assert.match(reply.body.data.assistantMessage, /documents\/Meeting Notes\.docx/);
    // Said once: a following turn that makes nothing carries nothing.
    const quiet = await post("/v1/assist", { mode: "general", sessionId: "session-open-files", message: "What is two plus two?" });
    assert.equal(quiet.status, 200);
    assert.deepEqual(quiet.body.data.files, []);
  } finally {
    if (previous === undefined) delete process.env.TRHAI_ENGINE_URL; else process.env.TRHAI_ENGINE_URL = previous;
    model.server.close();
  }
});
