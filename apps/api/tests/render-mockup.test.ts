import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// A workspace of its own so saved renderings never touch the real one.
process.env.ASCEND_WORKSPACE = mkdtempSync(path.join(tmpdir(), "ascend-render-"));

const {
  inferKind, renderMockupPrompt, extractRendering, findRenderFault, slugify,
  saveRendering, listRenderings, readRendering, latestRendering
} = await import("../src/services/renderMockup.js");
const { wantsRendering } = await import("../src/services/actionIntent.js");
const { runTool } = await import("../src/services/agentTools.js");

const sampleDoc = "<!doctype html><html><head><style>body{background:#05070d;color:#eaf6ff}</style></head>"
  + "<body><h1>Sign in</h1><input placeholder='email'><button>Log in</button></body></html>";

test("inferKind tells a diagram from a mockup", () => {
  assert.equal(inferKind("a flowchart of the build pipeline"), "diagram");
  assert.equal(inferKind("architecture of the system"), "diagram");
  assert.equal(inferKind("a login screen for a banking app"), "mockup");
});

test("the prompt insists on a self-contained, offline document", () => {
  const prompt = renderMockupPrompt("a login screen", "mockup");
  assert.match(prompt, /self-contained/i);
  assert.match(prompt, /no http:\/\/ or https:\/\//i);
  assert.match(prompt, /UI MOCKUP/);
  assert.match(renderMockupPrompt("x", "diagram"), /DIAGRAM/);
});

test("extractRendering pulls the title and document out of fenced output", () => {
  const text = "Here you go:\n```html\n<!-- TITLE: Login Screen -->\n" + sampleDoc + "\n```";
  const out = extractRendering(text);
  assert.ok(out);
  assert.equal(out!.title, "Login Screen");
  assert.match(out!.html, /^<!doctype html>/i);
  assert.match(out!.html, /Sign in/);
});

test("extractRendering wraps a bare <svg> into a document", () => {
  const out = extractRendering("<!-- TITLE: Flow -->\n<svg viewBox='0 0 10 10'><rect/></svg>");
  assert.ok(out);
  assert.match(out!.html, /<!doctype html>/i);
  assert.match(out!.html, /<svg/);
});

test("extractRendering returns null when there is no document", () => {
  assert.equal(extractRendering("I can't do that."), null);
});

test("findRenderFault rejects a document that loads from the internet", () => {
  assert.match(findRenderFault(sampleDoc.replace("<h1>", "<img src=\"https://x/y.png\"><h1>"))!, /internet/);
  assert.match(findRenderFault("<html><link href='https://fonts.example/x.css'></html>")!, /internet/);
  assert.match(findRenderFault("<style>@import url(https://x)</style>")!, /internet/);
});

test("findRenderFault passes a clean, self-contained document", () => {
  assert.equal(findRenderFault(sampleDoc), null);
});

test("findRenderFault rejects something too small to be a real document", () => {
  assert.match(findRenderFault("<html></html>")!, /real HTML document/);
});

test("slugify is filesystem-safe and never empty", () => {
  assert.equal(slugify("Login Screen!"), "login-screen");
  assert.equal(slugify("   "), "rendering");
});

test("a saved rendering can be listed and read back with its title and kind", () => {
  const saved = saveRendering("Login Screen", "mockup", sampleDoc);
  assert.equal(saved.name, "login-screen");

  const list = listRenderings();
  assert.ok(list.some((r) => r.name === "login-screen" && r.title === "Login Screen" && r.kind === "mockup"));

  const read = readRendering("login-screen");
  assert.ok(read);
  assert.match(read!.html, /Sign in/);
  assert.equal(read!.title, "Login Screen");
});

test("latestRendering returns the most recently saved one", async () => {
  saveRendering("First Thing", "mockup", sampleDoc);
  await new Promise((r) => setTimeout(r, 10));
  saveRendering("Second Thing", "diagram", "<!doctype html><html><body><svg><rect/></svg> a longer diagram body here for size</body></html>");
  const latest = latestRendering();
  assert.ok(latest);
  assert.equal(latest!.title, "Second Thing");
  assert.equal(latest!.kind, "diagram");
});

// --- gating ---------------------------------------------------------------

test("wantsRendering fires on a request to see a visual", () => {
  for (const message of [
    "mock up a login screen",
    "show me a mockup of the dashboard",
    "render a diagram of the build pipeline",
    "wireframe a settings page",
    "draw the architecture",
    "design a landing page"
  ]) {
    assert.equal(wantsRendering(message), true, message);
  }
});

test("wantsRendering stays out of data and file requests", () => {
  for (const message of [
    "show me my files",
    "what is the weather today",
    "remember that I use postgres",
    "build a task tracker app"
  ]) {
    assert.equal(wantsRendering(message), false, message);
  }
});

// --- dispatch -------------------------------------------------------------

test("render_mockup authors a visual, validates it and saves it", async () => {
  const result = await runTool(
    { name: "render_mockup", arguments: { description: "a login screen" } },
    { memories: [], knowledge: [], authorApp: async () => ({ ok: true, text: "<!-- TITLE: Login Screen -->\n" + sampleDoc }) }
  );
  assert.equal(result.ok, true, result.content);
  assert.match(result.content, /Rendered "Login Screen"/);
  assert.ok(readRendering("login-screen"));
});

test("render_mockup refuses a document that reaches the internet", async () => {
  const result = await runTool(
    { name: "render_mockup", arguments: { description: "a page with a hero image" } },
    { memories: [], knowledge: [], authorApp: async () => ({ ok: true, text: "<!-- TITLE: Hero -->\n" + sampleDoc.replace("<h1>", "<img src=\"https://cdn.example/hero.jpg\"><h1>") }) }
  );
  assert.equal(result.ok, false);
  assert.match(result.content, /self-contained/);
});

test("render_mockup without the local model says so rather than pretending", async () => {
  const result = await runTool(
    { name: "render_mockup", arguments: { description: "a login screen" } },
    { memories: [], knowledge: [] }
  );
  assert.equal(result.ok, false);
  assert.match(result.content, /local model/);
});

test("render_mockup needs a description", async () => {
  const result = await runTool(
    { name: "render_mockup", arguments: {} },
    { memories: [], knowledge: [], authorApp: async () => ({ ok: true, text: sampleDoc }) }
  );
  assert.equal(result.ok, false);
  assert.match(result.content, /needs a description/);
});
