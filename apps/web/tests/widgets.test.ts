import test from "node:test";
import assert from "node:assert/strict";
import {
  addWidget,
  allWidgets,
  defaultLayout,
  moveWidget,
  nextSize,
  parseLayout,
  readLayout,
  removeWidget,
  resizeWidget,
  widgetById,
  widgetSpan,
  writeLayout,
  type WidgetPlacement
} from "../src/widgets.js";
import { orderWidgets } from "../src/personalities.js";

test("the widget library covers the vision's initial set", () => {
  assert.deepEqual(
    allWidgets().map((entry) => entry.label),
    [
      "GPU",
      "CPU",
      "RAM",
      "Network",
      "Recent files",
      "Calendar",
      "Stocks",
      "Weather",
      "GitHub activity",
      "Discord activity",
      "Email",
      "Running automations",
      "AI suggestions",
      "Goals",
      "Daily focus"
    ]
  );
});

test("a widget with no data source says why instead of inventing numbers", () => {
  // A dashboard is believed at a glance, so a plausible fake number is worse
  // than an empty panel.
  for (const entry of allWidgets()) {
    if (entry.source === "unavailable") {
      assert.ok(
        entry.unavailableReason && entry.unavailableReason.length > 15,
        `${entry.id} is unavailable but gives no reason`
      );
    } else {
      assert.equal(entry.unavailableReason, undefined, `${entry.id} has data but claims a reason`);
    }
  }
});

test("the default dashboard only shows widgets backed by real data", () => {
  const layout = defaultLayout();

  assert.ok(layout.length > 0);
  for (const placement of layout) {
    assert.notEqual(widgetById(placement.id)?.source, "unavailable");
  }
  assert.ok(layout.some((entry) => entry.id === "cpu"));
  assert.ok(!layout.some((entry) => entry.id === "stocks"));
});

test("resizing cycles through the sizes and returns to the start", () => {
  assert.equal(nextSize("small"), "medium");
  assert.equal(nextSize("medium"), "large");
  assert.equal(nextSize("large"), "small");

  const layout: WidgetPlacement[] = [{ id: "cpu", size: "small" }];
  assert.equal(resizeWidget(layout, "cpu")[0].size, "medium");
});

test("resizing leaves other widgets untouched", () => {
  const layout: WidgetPlacement[] = [
    { id: "cpu", size: "small" },
    { id: "ram", size: "medium" }
  ];

  assert.deepEqual(resizeWidget(layout, "cpu"), [
    { id: "cpu", size: "medium" },
    { id: "ram", size: "medium" }
  ]);
});

test("a larger widget spans more columns", () => {
  assert.ok(widgetSpan("large") > widgetSpan("medium"));
  assert.ok(widgetSpan("medium") > widgetSpan("small"));
});

test("dragging a widget reorders the layout", () => {
  const layout: WidgetPlacement[] = [
    { id: "cpu", size: "small" },
    { id: "ram", size: "small" },
    { id: "network", size: "small" }
  ];

  assert.deepEqual(
    moveWidget(layout, "network", "cpu").map((entry) => entry.id),
    ["network", "cpu", "ram"]
  );
});

test("dropping a widget on itself or on something missing changes nothing", () => {
  const layout: WidgetPlacement[] = [
    { id: "cpu", size: "small" },
    { id: "ram", size: "small" }
  ];

  assert.deepEqual(moveWidget(layout, "cpu", "cpu"), layout);
  assert.deepEqual(moveWidget(layout, "cpu", "gone"), layout);
  assert.deepEqual(moveWidget(layout, "gone", "cpu"), layout);
});

test("adding a widget is idempotent and unknown ids are refused", () => {
  const layout = addWidget([], "stocks");
  assert.equal(layout.length, 1);
  assert.deepEqual(addWidget(layout, "stocks"), layout);
  assert.deepEqual(addWidget(layout, "not-a-widget"), layout);
});

test("removing a widget drops only that one", () => {
  const layout: WidgetPlacement[] = [
    { id: "cpu", size: "small" },
    { id: "ram", size: "small" }
  ];

  assert.deepEqual(removeWidget(layout, "cpu"), [{ id: "ram", size: "small" }]);
});

test("a stale stored layout degrades instead of blanking the dashboard", () => {
  // These values outlive the code that wrote them: a widget can be renamed
  // between versions, and the entry can be hand-edited to anything.
  assert.equal(parseLayout("nonsense"), null);
  assert.equal(parseLayout([]), null);
  assert.equal(parseLayout([{ id: "removed-widget", size: "small" }]), null);

  assert.deepEqual(
    parseLayout([
      { id: "cpu", size: "small" },
      { id: "cpu", size: "large" },
      { id: "ram", size: "enormous" },
      { id: 42, size: "small" },
      null,
      { id: "network", size: "medium" }
    ]),
    [
      { id: "cpu", size: "small" },
      { id: "network", size: "medium" }
    ]
  );
});

test("an unreadable storage falls back to the default layout", () => {
  const hostile = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    }
  } as unknown as Storage;

  assert.deepEqual(readLayout(hostile, "k"), defaultLayout());
  // Writing must not throw either — a full quota cannot break the dashboard.
  assert.doesNotThrow(() => writeLayout(hostile, "k", defaultLayout()));
});

test("a saved layout round-trips", () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value)
  } as unknown as Storage;

  const layout: WidgetPlacement[] = [
    { id: "ram", size: "large" },
    { id: "cpu", size: "small" }
  ];

  writeLayout(storage, "layout", layout);
  assert.deepEqual(readLayout(storage, "layout"), layout);
});

test("personality priority reorders a real dashboard layout", () => {
  // The two systems have to agree on widget ids or the ordering silently no-ops.
  const ids = defaultLayout().map((entry) => entry.id);
  const ordered = orderWidgets(ids, "gaming");

  assert.equal(ordered.length, ids.length);
  assert.equal(ordered[0], "cpu", "gaming ranks cpu ahead of the rest of the default set");
  assert.ok(ordered.indexOf("cpu") < ordered.indexOf("recent-files"));
});
