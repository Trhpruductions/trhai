import test from "node:test";
import assert from "node:assert/strict";
import { viewTitle, views } from "../src/os/views";

// What the browser tab is called: the workspace, so a screen reader's window list and the
// taskbar tell them apart, with the product last; the product alone on Home.

test("the tab is named after the workspace, and after the product alone on Home", () => {
  assert.equal(viewTitle("home"), "TRH AI");
  assert.equal(viewTitle("settings"), "Settings · TRH AI");
  assert.equal(viewTitle("chat"), "AI Chat · TRH AI");
  for (const view of views) assert.ok(viewTitle(view.id).endsWith("TRH AI"), view.id);
});
