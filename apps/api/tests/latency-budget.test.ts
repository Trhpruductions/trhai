import test from "node:test";
import assert from "node:assert/strict";
import { AddressInfo } from "node:net";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const budgetRoot = mkdtempSync(path.join(tmpdir(), "ascend-latency-"));
process.env.ASCEND_WORKSPACE = budgetRoot;

const { createApp } = await import("../src/server.js");

// Latency budgets for the app's own work (E14-S1).
//
// These cover routes the interface polls, not the model. Model latency is the
// model's business and varies by an order of magnitude between machines; the
// app's own overhead does not, and a regression there is invisible until the
// whole screen feels heavy.
//
// The budgets are deliberately loose — several times the observed cost rather
// than just above it. A budget set close to the measurement fails on a busy
// machine and gets deleted; one set at a multiple only fires when something
// has genuinely changed shape, which is the only failure worth waking anyone
// for. Measured on this machine, these routes answer in single-digit
// milliseconds; the budgets below are 150ms.
//
// system-telemetry is deliberately excluded. It samples CPU across a 250ms
// window on purpose, so it is slow by design, and a budget on it would be
// asserting the wrong thing.

async function startTestServer() {
  const app = createApp();
  const server = app.listen(0);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

/** Generous on purpose. See the note above. */
const budgetMs = 150;

/** Enough samples that one scheduling hiccup cannot decide the result. */
const samples = 12;

async function timeRoute(baseUrl: string, route: string): Promise<number[]> {
  const timings: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    const response = await fetch(`${baseUrl}${route}`);
    // A route that 500s fast is not within budget, it is broken.
    assert.ok(response.status < 500, `${route} returned ${response.status}`);
    await response.arrayBuffer();
    timings.push(performance.now() - started);
  }
  return timings;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

const polled = [
  "/v1/capabilities",
  "/v1/files",
  "/v1/commands",
  "/v1/speech",
  "/v1/transcribe",
  "/v1/schedules",
  "/v1/identity"
];

for (const route of polled) {
  test(`${route} answers well inside its budget`, async () => {
    const { baseUrl, close } = await startTestServer();
    try {
      const timings = await timeRoute(baseUrl, route);
      const middle = median(timings);
      // The median rather than the worst: one sample can be lost to garbage
      // collection or the OS scheduler, and failing on that would make this
      // suite noise rather than a signal.
      assert.ok(
        middle < budgetMs,
        `${route} took ${middle.toFixed(1)}ms at the median, budget is ${budgetMs}ms`
      );
    } finally {
      await close();
    }
  });
}

test("the dashboard's whole poll completes inside one frame budget", async () => {
  // The screen fetches these together every four seconds. Individually fast
  // and collectively slow is a real shape — it is what happens when someone
  // adds one synchronous disk walk to a route nobody times on its own.
  const { baseUrl, close } = await startTestServer();
  try {
    const started = performance.now();
    await Promise.all(polled.map(async (route) => {
      const response = await fetch(`${baseUrl}${route}`);
      await response.arrayBuffer();
    }));
    const elapsed = performance.now() - started;

    assert.ok(
      elapsed < budgetMs * 3,
      `the full poll took ${elapsed.toFixed(1)}ms, budget is ${budgetMs * 3}ms`
    );
  } finally {
    await close();
  }
});

test("the budget would actually catch something slow", async () => {
  // A budget that can only pass proves nothing. This checks the assertion
  // itself fires, so a future refactor cannot leave these tests green while
  // measuring nothing.
  const pretendSlow = [400, 420, 410];
  assert.throws(() => {
    const middle = median(pretendSlow);
    assert.ok(middle < budgetMs, `took ${middle}ms, budget is ${budgetMs}ms`);
  });
});
