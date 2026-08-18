import test from "node:test";
import assert from "node:assert/strict";
import { bootChecksFor } from "../src/bootChecks";

// The rule these all protect: a line may only claim a check passed when it
// actually did. A staged sequence on a timer would look identical on a machine
// where nothing is running, which would make it a lie told once per launch.

test("nothing is claimed before the link has answered", () => {
  const checks = bootChecksFor({ online: null, model: null, linkMs: null, storeChecked: false, stats: [] });

  assert.deepEqual(checks.map((check) => check.state), ["pending", "pending", "pending"]);
});

test("a working link reports what it measured", () => {
  const checks = bootChecksFor({ online: true, model: "llama3.2:latest", linkMs: 9, storeChecked: false, stats: [] });

  const link = checks.find((check) => check.label === "Link");
  assert.equal(link?.state, "ok");
  assert.equal(link?.detail, "9ms");
});

test("a failed link is failed, not quietly pending", () => {
  const checks = bootChecksFor({ online: false, model: null, linkMs: null, storeChecked: false, stats: [] });

  const link = checks.find((check) => check.label === "Link");
  assert.equal(link?.state, "failed");
  assert.match(link?.detail ?? "", /no service/);
});

test("no model is absent rather than failed, and says what still works", () => {
  // The app runs without one. Reporting that as a failure would be wrong.
  const checks = bootChecksFor({ online: true, model: null, linkMs: 5, storeChecked: false, stats: [] });

  const modelCheck = checks.find((check) => check.label === "Model");
  assert.equal(modelCheck?.state, "absent");
  assert.match(modelCheck?.detail ?? "", /notes and documents/);
});

test("the model is unknown, not absent, until the link answers", () => {
  const checks = bootChecksFor({ online: null, model: null, linkMs: null, storeChecked: false, stats: [] });

  assert.equal(checks.find((check) => check.label === "Model")?.state, "pending");
});

test("an empty store is a finished check, not an unfinished one", () => {
  // "no memories" and "not asked yet" are different states, and only one of
  // them is a completed check.
  const checks = bootChecksFor({
    online: true, model: "llama3.2", linkMs: 4, storeChecked: true,
    stats: [{ label: "remembered", value: "0" }, { label: "documents", value: "0" }]
  });

  const store = checks.find((check) => check.label === "Store");
  assert.equal(store?.state, "ok");
  assert.match(store?.detail ?? "", /0 remembered/);
});

test("the store reports what it actually holds", () => {
  const checks = bootChecksFor({
    online: true, model: "llama3.2", linkMs: 4, storeChecked: true,
    stats: [{ label: "remembered", value: "3" }, { label: "documents", value: "1" }]
  });

  assert.match(checks.find((check) => check.label === "Store")?.detail ?? "", /3 remembered, 1 documents/);
});

test("the model tag is trimmed the way the rest of the app trims it", () => {
  const checks = bootChecksFor({ online: true, model: "llama3.1:8b", linkMs: 4, storeChecked: true, stats: [] });
  assert.equal(checks.find((check) => check.label === "Model")?.detail, "llama3.1:8b");

  const latest = bootChecksFor({ online: true, model: "llama3.2:latest", linkMs: 4, storeChecked: true, stats: [] });
  assert.equal(latest.find((check) => check.label === "Model")?.detail, "llama3.2");
});
