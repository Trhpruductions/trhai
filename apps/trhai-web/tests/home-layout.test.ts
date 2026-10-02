import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultLayout, inZone, moveWithinZone, normalizeLayout, placeWidget, toggleExpanded, toggleHidden, togglePinned, widgetIds,
  type HomeLayout
} from "../src/os/home/layout.js";

// Home's widgets can be hidden, pinned, expanded and moved, and the result is
// kept in localStorage - so a stored layout can be old, edited by hand or
// broken, and Home has to come up whole regardless.

const ids = (layout: HomeLayout, zone: "left" | "right") => inZone(layout, zone).map((widget) => widget.id);

test("the default layout shows every widget, split across both sides", () => {
  const layout = defaultLayout();
  assert.deepEqual([...layout.widgets.map((widget) => widget.id)].sort(), [...widgetIds].sort());
  assert.deepEqual(ids(layout, "left"), ["vitals", "health", "modules"]);
  assert.deepEqual(ids(layout, "right"), ["activity", "tasks", "upcoming", "voice"]);
});

test("a stored layout that is not one falls back to the default", () => {
  for (const junk of [null, undefined, 42, "layout", {}, { version: 2, widgets: [] }, { version: 1, widgets: "no" }]) {
    assert.deepEqual(normalizeLayout(junk), defaultLayout());
  }
});

test("a stored layout is repaired rather than trusted", () => {
  const repaired = normalizeLayout({
    version: 1,
    widgets: [
      { id: "voice", zone: "left", hidden: true, pinned: "yes", expanded: 1 },
      { id: "voice", zone: "right" },
      { id: "not-a-widget", zone: "left" },
      { id: "tasks", zone: "sideways" }
    ]
  });
  // Unknown and repeated entries are dropped, odd values made safe, and every
  // widget missing from what was stored comes back where it belongs.
  assert.deepEqual([...repaired.widgets.map((widget) => widget.id)].sort(), [...widgetIds].sort());
  const voice = repaired.widgets.find((widget) => widget.id === "voice");
  assert.deepEqual(voice, { id: "voice", zone: "left", hidden: true, pinned: false, expanded: false });
  assert.equal(repaired.widgets.find((widget) => widget.id === "tasks")?.zone, "left");
  assert.equal(repaired.widgets.find((widget) => widget.id === "health")?.zone, "left");
});

test("hidden widgets leave their side, and come back where they were", () => {
  const hidden = toggleHidden(defaultLayout(), "health");
  assert.deepEqual(ids(hidden, "left"), ["vitals", "modules"]);
  assert.deepEqual(ids(toggleHidden(hidden, "health"), "left"), ["vitals", "health", "modules"]);
});

test("a pinned widget leads its side; expanding changes only that widget", () => {
  const pinned = togglePinned(defaultLayout(), "modules");
  assert.deepEqual(ids(pinned, "left"), ["modules", "vitals", "health"]);
  const expanded = toggleExpanded(pinned, "vitals");
  assert.equal(expanded.widgets.find((widget) => widget.id === "vitals")?.expanded, true);
  assert.deepEqual(expanded.widgets.filter((widget) => widget.expanded).map((widget) => widget.id), ["vitals"]);
});

test("moving steps among the widgets you can see, and stops at the ends", () => {
  const layout = defaultLayout();
  assert.deepEqual(ids(moveWithinZone(layout, "modules", -1), "left"), ["vitals", "modules", "health"]);
  assert.deepEqual(moveWithinZone(layout, "vitals", -1), layout);
  assert.deepEqual(moveWithinZone(layout, "voice", 1), layout);
  // A hidden widget in between is stepped over, not swapped with.
  const withHidden = toggleHidden(layout, "health");
  assert.deepEqual(ids(moveWithinZone(withHidden, "modules", -1), "left"), ["modules", "vitals"]);
});

test("a widget can be placed on the other side, before another or at the end", () => {
  const layout = defaultLayout();
  const before = placeWidget(layout, "health", "right", "tasks");
  assert.deepEqual(ids(before, "left"), ["vitals", "modules"]);
  assert.deepEqual(ids(before, "right"), ["activity", "health", "tasks", "upcoming", "voice"]);
  const atEnd = placeWidget(layout, "health", "right", null);
  assert.deepEqual(ids(atEnd, "right"), ["activity", "tasks", "upcoming", "voice", "health"]);
});

test("placing a hidden widget shows it, and nonsense placements change nothing", () => {
  const hidden = toggleHidden(defaultLayout(), "voice");
  assert.ok(ids(placeWidget(hidden, "voice", "left", null), "left").includes("voice"));
  const layout = defaultLayout();
  assert.deepEqual(placeWidget(layout, "voice", "left", "voice"), layout);
  assert.deepEqual(placeWidget(layout, "nope" as never, "left", null), layout);
});
