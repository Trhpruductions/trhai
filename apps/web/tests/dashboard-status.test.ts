import test from "node:test";
import assert from "node:assert/strict";

import { buildConversationStatus, getConnectionSecurityLabel, getCoreIntegrity } from "../src/dashboardStatus.js";

test("returns offline core integrity", () => {
  assert.equal(getCoreIntegrity("offline"), "85%");
});

test("returns online connection security label", () => {
  assert.equal(getConnectionSecurityLabel("online"), "Encrypted");
});

test("builds a conversation status label", () => {
  assert.equal(buildConversationStatus("Operational", "Ready"), "Operational · Ready");
});
