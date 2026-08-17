import test from "node:test";
import assert from "node:assert/strict";

import { buildConversationStatus, clampPercent, getConnectionSecurityLabel, getCoreIntegrity } from "../src/dashboardStatus.js";

test("returns offline core integrity", () => {
  assert.equal(getCoreIntegrity("offline"), "85%");
});

test("returns online connection security label", () => {
  assert.equal(getConnectionSecurityLabel("online"), "Encrypted");
});

test("builds a conversation status label", () => {
  assert.equal(buildConversationStatus("Operational", "Ready"), "Operational · Ready");
});

test("a telemetry reading is clamped to a whole percent", () => {
  assert.equal(clampPercent(42.4), 42);
  assert.equal(clampPercent(42.6), 43);
  assert.equal(clampPercent(-10), 0);
  assert.equal(clampPercent(140), 100);
});

test("a non-finite reading never reaches the dashboard", () => {
  // navigator.storage.estimate() reports usage and quota as optional, so a
  // browser that gives neither divides undefined by undefined. Without the
  // guard that NaN was rendered as a bar width and a label.
  assert.equal(clampPercent(NaN), 0);
  assert.equal(clampPercent(Number.NaN), 0);
  assert.equal(clampPercent(undefined as unknown as number), 0);

  // Infinity is zeroed too, and that is the right reading: an infinite ratio
  // means the denominator was zero or unknown, so the honest answer is "no
  // measurement" rather than "completely full".
  assert.equal(clampPercent(Infinity), 0);
  assert.equal(clampPercent(-Infinity), 0);
});

test("the storage-estimate shape that produced the NaN now yields zero", () => {
  const estimate: { usage?: number; quota?: number } = {};
  const ratio = ((estimate.usage as number) / (estimate.quota as number)) * 100;

  assert.ok(Number.isNaN(ratio), "precondition: this really is NaN");
  assert.equal(clampPercent(ratio), 0);
});
