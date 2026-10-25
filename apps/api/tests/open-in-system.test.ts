import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Opening a file TRH AI made, and showing where it is. What is tested: what may be opened and what may not,
// that nothing outside the workspace is reached however it is asked for, and the exact commands sent to the system.
// Nothing is really opened: a stand-in takes the place of starting a program.

const workspace = mkdtempSync(path.join(tmpdir(), "trhai-open-"));
const outside = mkdtempSync(path.join(tmpdir(), "trhai-open-outside-"));
process.env.ASCEND_WORKSPACE = workspace;
mkdirSync(path.join(workspace, "documents"), { recursive: true });
for (const name of ["Quarterly Report.docx", "report.pdf", "script.bat", "tool.exe", "page.html", "drawing.svg", "macro.docm", "notes"]) {
  writeFileSync(path.join(workspace, "documents", name), "x");
}
writeFileSync(path.join(outside, "secret.docx"), "x");

const { commandFor, openWorkspacePath, openableExtensions, useLauncher } = await import("../src/services/openInSystem.js");

const launched: Array<{ program: string; args: string[]; verbatim?: boolean }> = [];
test.beforeEach(() => {
  launched.length = 0;
  useLauncher(async (program, args, options) => { launched.push({ program, args, verbatim: options.verbatim }); return true; });
});
test.after(() => {
  useLauncher();
  rmSync(workspace, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test("what is opened is a document, a picture, sound or video - and never anything that can run, or a page that can script", () => {
  for (const extension of [".docx", ".pdf", ".xlsx", ".pptx", ".csv", ".txt", ".png", ".jpg", ".mp3", ".mp4"]) assert.ok(openableExtensions.has(extension), extension);
  for (const extension of [
    ".exe", ".bat", ".cmd", ".ps1", ".psm1", ".vbs", ".vbe", ".js", ".jse", ".wsf", ".lnk", ".msi", ".hta", ".html", ".htm", ".svg", ".jar", ".scr", ".com", ".dll",
    ".py", ".sh", ".url", ".reg", ".docm", ".xlsm", ".pptm", ".cpl", ".msc", ".appx", ".iso", ".zip"
  ]) assert.ok(!openableExtensions.has(extension), `${extension} must not be opened from here`);
});

test("each system is sent the command that opens a file, or shows it in its folder", () => {
  const file = "C:\\Users\\Sam\\Vexora\\workspace\\documents\\Q3 & Q4 Report.docx";
  assert.deepEqual(commandFor("open", file, false, "win32"), { program: "explorer.exe", args: [file] });
  assert.deepEqual(commandFor("reveal", file, false, "win32"), { program: "explorer.exe", args: [`/select,"${file}"`], verbatim: true });
  assert.deepEqual(commandFor("reveal", "C:\\Users\\Sam\\Vexora\\workspace\\documents", true, "win32"), { program: "explorer.exe", args: ["C:\\Users\\Sam\\Vexora\\workspace\\documents"] }, "a folder is opened, not selected");
  assert.deepEqual(commandFor("open", "/home/sam/a b.pdf", false, "darwin"), { program: "open", args: ["/home/sam/a b.pdf"] });
  assert.deepEqual(commandFor("reveal", "/home/sam/a b.pdf", false, "darwin"), { program: "open", args: ["-R", "/home/sam/a b.pdf"] });
  assert.deepEqual(commandFor("open", "/home/sam/a b.pdf", false, "linux"), { program: "xdg-open", args: ["/home/sam/a b.pdf"] });
  assert.deepEqual(commandFor("reveal", "/home/sam/a b.pdf", false, "linux"), { program: "xdg-open", args: ["/home/sam"] });
});

test("a document in the workspace is opened by its whole path, and shown by selecting it", async () => {
  const absolute = path.join(workspace, "documents", "Quarterly Report.docx");
  assert.deepEqual(await openWorkspacePath("documents/Quarterly Report.docx", "open", "win32"), { ok: true });
  assert.deepEqual(launched, [{ program: "explorer.exe", args: [absolute], verbatim: undefined }]);
  launched.length = 0;
  assert.deepEqual(await openWorkspacePath("documents/Quarterly Report.docx", "reveal", "win32"), { ok: true });
  assert.deepEqual(launched, [{ program: "explorer.exe", args: [`/select,"${absolute}"`], verbatim: true }]);
});

test("a folder is opened, and so is the workspace itself", async () => {
  assert.deepEqual(await openWorkspacePath("documents", "open", "win32"), { ok: true });
  assert.deepEqual(await openWorkspacePath(".", "open", "win32"), { ok: true });
  assert.deepEqual(launched.map((entry) => entry.args), [[path.join(workspace, "documents")], [path.resolve(workspace)]]);
});

test("what could run is not opened, but can still be shown in its folder", async () => {
  for (const name of ["script.bat", "tool.exe", "page.html", "drawing.svg", "macro.docm", "notes"]) {
    const outcome = await openWorkspacePath(`documents/${name}`, "open", "win32");
    assert.equal(outcome.ok, false, name);
    if (!outcome.ok) {
      assert.equal(outcome.status, 415, name);
      assert.match(outcome.reason, /is not opened from here: this opens documents, pictures, sound and video\. It can be shown in its folder instead\./);
    }
  }
  assert.equal(launched.length, 0, "nothing was started");
  assert.deepEqual(await openWorkspacePath("documents/tool.exe", "reveal", "win32"), { ok: true });
  assert.equal(launched.length, 1);
  assert.match(launched[0].args[0], /^\/select,".*tool\.exe"$/);
});

test("nothing outside the workspace is reached, however the path is written", async () => {
  const secret = path.join(outside, "secret.docx");
  const mistakes: unknown[] = [secret, "../" + path.basename(outside) + "/secret.docx", "..\\..\\Windows\\notepad.exe", "documents/../../secret.docx", "C:\\Windows\\System32\\calc.exe", "", "   ", null, undefined, 42, {}, "documents/\0.docx"];
  for (const mistake of mistakes) {
    for (const action of ["open", "reveal"] as const) {
      const outcome = await openWorkspacePath(mistake, action, "win32");
      assert.equal(outcome.ok, false, `${JSON.stringify(mistake)} ${action}`);
      if (!outcome.ok) assert.equal(outcome.status, 400, `${JSON.stringify(mistake)} ${action}`);
    }
  }
  assert.deepEqual(launched, [], "nothing was started");
});

test("a link inside the workspace that leads outside it does not open what it leads to", async (t) => {
  const link = path.join(workspace, "documents", "way-out");
  try {
    symlinkSync(outside, link, "junction");
  } catch {
    t.skip("this system would not make a link");
    return;
  }
  const outcome = await openWorkspacePath("documents/way-out/secret.docx", "open", "win32");
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.status, 400);
  assert.deepEqual(launched, []);
});

test("a file that is not there is said not to be", async () => {
  const outcome = await openWorkspacePath("documents/missing.docx", "open", "win32");
  assert.deepEqual(outcome, { ok: false, status: 404, reason: "There is no file there." });
  assert.deepEqual(launched, []);
});

test("a program that cannot be started is reported, not claimed", async () => {
  useLauncher(async () => false);
  const outcome = await openWorkspacePath("documents/report.pdf", "open", "win32");
  assert.deepEqual(outcome, { ok: false, status: 500, reason: "The program that opens files could not be started." });
});
