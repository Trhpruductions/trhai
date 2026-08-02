import test from "node:test";
import assert from "node:assert/strict";
import { resolveDraftMessageText } from "../src/messageInput";

test("prefers an explicit override before the live DOM value", () => {
  assert.equal(resolveDraftMessageText("override", "state draft", "live draft"), "override");
});

test("falls back to the live DOM value when the component state is stale", () => {
  assert.equal(resolveDraftMessageText(undefined, "stale draft", "live draft"), "live draft");
});

test("uses component state when no live DOM value is available", () => {
  assert.equal(resolveDraftMessageText(undefined, "state draft", ""), "state draft");
});
