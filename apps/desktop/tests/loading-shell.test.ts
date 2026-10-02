import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { escapeHtml, loadingShellHtml } from "../src/loadingShell.js";

test("the window opens on the TRH AI loading screen, saying what it is waiting for", () => {
  const html = loadingShellHtml("Starting TRH AI", "Waiting for the interface at http://127.0.0.1:3210.");

  assert.match(html, /<title>TRH AI<\/title>/);
  assert.match(html, /LIVING INTELLIGENCE SYSTEM/);
  assert.match(html, /Starting TRH AI/);
  assert.match(html, /Waiting for the interface at http:\/\/127\.0\.0\.1:3210\./);
  // The old box said "Vexora AI"; this is the first thing anyone sees.
  assert.doesNotMatch(html, /Vexora/);
});

test("it reaches for nothing outside itself: it shows before anything is up", () => {
  const html = loadingShellHtml("Starting TRH AI");
  // Loaded from a file while the services it waits for are still starting.
  assert.doesNotMatch(html, /\b(?:src|href)=["']?https?:/);
  assert.doesNotMatch(html, /url\(\s*["']?https?:/);
  assert.doesNotMatch(html, /<script/);
});

test("status text is escaped, so an address cannot become markup", () => {
  assert.equal(escapeHtml(`<b>"x" & 'y'</b>`), "&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;");
  const html = loadingShellHtml("Open <script>alert(1)</script>", "http://x/?a=<b>");
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
});

test("the static fallback page is the same loading screen, not the old Vexora console", () => {
  const page = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");
  assert.match(page, /<title>TRH AI<\/title>/);
  assert.doesNotMatch(page, /Vexora|5173/, "the old console pointed at a port nothing serves");
});
