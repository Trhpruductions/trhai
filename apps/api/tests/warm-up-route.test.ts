import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

// The composer asks for a warm-up whenever the chat box is clicked into. On a
// copy whose trial has ended that must not come back refused: a refusal from
// the API reopens the paywall, and clicking into the chat box after "Not now"
// would put it straight back. The license file is a temp one, set before import.

const licenseDir = mkdtempSync(path.join(tmpdir(), "trhai-warm-route-"));
process.env.TRHAI_LICENSE_FILE = path.join(licenseDir, "license.json");
process.env.TRHAI_TRIAL_MARKER = path.join(licenseDir, "elsewhere", "trial-started");
delete process.env.TRHAI_PAYWALL;

const { createApp } = await import("../src/server.js");
const { resetLicensingForTests, trialDays } = await import("../src/services/licensing.js");
const { writeProtectedJsonFile } = await import("../src/services/protectedJson.js");

const day = 24 * 60 * 60 * 1000;

test("after the trial, the warm-up is skipped quietly, while new work is still refused", async () => {
  resetLicensingForTests();
  writeProtectedJsonFile(process.env.TRHAI_LICENSE_FILE as string, { trialStartedAt: new Date(Date.now() - (trialDays + 1) * day).toISOString() });
  resetLicensingForTests();

  const server = createApp().listen(0);
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (route: string, body: string, type = "application/json") =>
    fetch(`${baseUrl}${route}`, { method: "POST", headers: { "Content-Type": type }, body });
  try {
    const warm = await post("/v1/warm-up", "{}");
    assert.equal(warm.status, 202);
    const { data } = await warm.json() as { data: { state: string; reason: string } };
    assert.equal(data.state, "skipped");
    assert.match(data.reason, /trial/);

    assert.equal((await post("/v1/assist", JSON.stringify({ message: "hello", sessionId: "s" }))).status, 402, "work itself is still refused");
    assert.equal((await post("/v1/warm-up", "{}", "text/plain")).status, 415, "JSON only, so another site's page cannot start it");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    resetLicensingForTests();
  }
});
