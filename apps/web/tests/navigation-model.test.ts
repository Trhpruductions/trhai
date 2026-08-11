import test from "node:test";
import assert from "node:assert/strict";
import {
  allDestinations,
  destinationById,
  isRoutable,
  sidebarDestinations,
  topNavDestinations
} from "../src/navigationModel.js";

test("the top nav carries exactly the destinations the vision names, in order", () => {
  assert.deepEqual(
    topNavDestinations().map((entry) => entry.label),
    ["Home", "Projects", "Agents", "Automation", "Knowledge", "Marketplace", "Settings"]
  );
});

test("the sidebar carries exactly the destinations the vision names, in order", () => {
  assert.deepEqual(
    sidebarDestinations().map((entry) => entry.label),
    [
      "Home",
      "Files",
      "Projects",
      "Memory",
      "Terminal",
      "Browser",
      "Email",
      "Calendar",
      "Marketplace",
      "Plugins",
      "Settings"
    ]
  );
});

test("a destination that is not live explains why", () => {
  // §1 forbids purposeless controls. A nav item that routes nowhere and says
  // nothing is the worst version of that — it looks live until it is clicked.
  for (const entry of allDestinations()) {
    if (entry.status === "planned") {
      assert.ok(
        entry.plannedReason && entry.plannedReason.length > 20,
        `${entry.id} is planned but gives no usable reason`
      );
    } else {
      assert.equal(entry.plannedReason, undefined, `${entry.id} is live but carries a planned reason`);
    }
  }
});

test("every destination has a label and a summary", () => {
  for (const entry of allDestinations()) {
    assert.ok(entry.label.length > 0, `${entry.id} has no label`);
    assert.ok(entry.summary.length > 10, `${entry.id} has no usable summary`);
  }
});

test("destination ids are unique", () => {
  const ids = allDestinations().map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("routability follows status", () => {
  assert.equal(isRoutable("home"), true);
  assert.equal(isRoutable("email"), false);
});

test("an unknown destination fails loudly rather than rendering blank", () => {
  // A silent undefined here would render an empty pane with no explanation.
  assert.throws(() => destinationById("nope" as never), /Unknown destination/);
});
