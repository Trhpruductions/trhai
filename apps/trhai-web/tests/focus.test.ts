import test from "node:test";
import assert from "node:assert/strict";
import { isolate, nextFocusIndex, radioTabIndex, stepIndex, type IsolatableNode } from "../src/lib/focus";

// The keyboard rules behind dialogs, menus and radio groups, apart from any screen.

test("the arrows step and wrap, Home and End jump, and any other key is left alone", () => {
  assert.equal(stepIndex(3, 0, "ArrowDown"), 1);
  assert.equal(stepIndex(3, 2, "ArrowDown"), 0);
  assert.equal(stepIndex(3, 0, "ArrowUp"), 2);
  assert.equal(stepIndex(3, 1, "ArrowLeft"), 0);
  assert.equal(stepIndex(3, 1, "ArrowRight"), 2);
  assert.equal(stepIndex(3, 2, "Home"), 0);
  assert.equal(stepIndex(3, 0, "End"), 2);
  assert.equal(stepIndex(3, -1, "ArrowDown"), 0, "from outside, down enters at the first");
  assert.equal(stepIndex(3, -1, "ArrowUp"), 2, "from outside, up enters at the last");
  assert.equal(stepIndex(3, 1, "Enter"), null);
  assert.equal(stepIndex(0, 0, "ArrowDown"), null);
  assert.equal(nextFocusIndex(1, 0, false), 0);
});

test("a radio group has one tab stop: the checked button, or the first when none is", () => {
  assert.deepEqual([0, 1, 2].map((index) => radioTabIndex(1, index)), [-1, 0, -1]);
  assert.deepEqual([0, 1, 2].map((index) => radioTabIndex(-1, index)), [0, -1, -1]);
});

type Fake = IsolatableNode & { name: string; children: Fake[]; inert: boolean };

function node(name: string, children: Fake[] = [], tagName = "DIV"): Fake {
  const self: Fake = { name, tagName, inert: false, parentElement: null, children };
  for (const child of children) child.parentElement = self;
  return self;
}

test("everything outside a dialog goes inert, and only what was taken is given back", () => {
  const dialog = node("dialog");
  const scrim = node("scrim", [dialog]);
  const main = node("main");
  const already = node("already");
  already.inert = true;
  const app = node("app", [main, scrim, already]);
  const toasts = node("toasts");
  const script = node("script", [], "SCRIPT");
  const body = node("body", [app, toasts, script], "BODY");
  const head = node("head", [], "HEAD");
  node("html", [head, body], "HTML");

  const release = isolate(dialog);
  assert.equal(main.inert, true, "a sibling of the dialog's scrim");
  assert.equal(toasts.inert, true, "a sibling of an ancestor");
  assert.equal(script.inert, false, "a script is not part of the page");
  assert.equal(head.inert, false);
  assert.equal(already.inert, true);
  for (const live of [dialog, scrim, app, body]) assert.equal(live.inert, false, `${live.name} stays live: it holds the dialog`);

  release();
  assert.equal(main.inert, false);
  assert.equal(toasts.inert, false);
  assert.equal(already.inert, true, "what was inert before is left as it was");
});

test("a dialog over a dialog takes only the rest, and gives back in order", () => {
  const first = node("first");
  const second = node("second");
  const page = node("page");
  node("body", [page, first, second], "BODY");

  const releaseFirst = isolate(first);
  assert.deepEqual([page.inert, second.inert], [true, true]);
  const releaseSecond = isolate(second);
  assert.equal(second.inert, false, "the second dialog is live, although the first had put it behind");
  assert.equal(first.inert, true, "the first dialog is behind the second now");
  releaseSecond();
  assert.deepEqual([page.inert, first.inert, second.inert], [true, false, true], "the first dialog is live again; the page, and the closed second, behind it as before");
  releaseFirst();
  assert.deepEqual([page.inert, first.inert, second.inert], [false, false, false]);
});
