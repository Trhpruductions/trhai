import test from "node:test";
import assert from "node:assert/strict";
import {
  increment,
  maxObservations,
  observe,
  percentile,
  resetMetrics,
  snapshot,
  timed,
  toPrometheus
} from "../src/services/metrics.js";

// Telemetry is only worth having if it is measurement. These care that
// nothing here can report a number nothing produced, and that the awkward
// cases — a failure, a clock going backwards, a very long-running process —
// are handled rather than averaged away.

test.beforeEach(() => resetMetrics());
test.after(() => resetMetrics());

test("nothing is reported before anything happens", () => {
  // No synthetic series, no gauges sitting at a default. An empty process has
  // nothing to say beyond when it started.
  const text = toPrometheus();
  assert.match(text, /trhai_process_start_seconds \d+/);
  assert.equal(text.trim().split("\n").length, 1);
});

test("counters count", () => {
  increment("trhai_tool_calls_total", { tool: "search_memory", outcome: "ok" });
  increment("trhai_tool_calls_total", { tool: "search_memory", outcome: "ok" });
  increment("trhai_tool_calls_total", { tool: "build_app", outcome: "failed" });

  const { counters } = snapshot();
  assert.equal(counters['trhai_tool_calls_total{outcome="ok",tool="search_memory"}'], 2);
  assert.equal(counters['trhai_tool_calls_total{outcome="failed",tool="build_app"}'], 1);
});

test("label order does not create two series for one thing", () => {
  // Written in either order, these are the same measurement.
  increment("m", { a: "1", b: "2" });
  increment("m", { b: "2", a: "1" });

  const keys = Object.keys(snapshot().counters);
  assert.equal(keys.length, 1);
  assert.equal(snapshot().counters[keys[0]], 2);
});

test("a label value that would break the format is escaped", () => {
  increment("m", { note: 'has "quotes" and \\ and\nnewline' });

  const text = toPrometheus();
  // Each line must stay one line, or a scraper reads the remainder as a
  // separate malformed metric.
  const metricLines = text.trim().split("\n").filter((line) => line.startsWith("m{"));
  assert.equal(metricLines.length, 1);
  assert.match(metricLines[0], /\\"quotes\\"/);
});

test("durations are observed and summarised", () => {
  for (const value of [10, 20, 30, 40, 50]) observe("trhai_tool_duration", value);

  const text = toPrometheus();
  assert.match(text, /trhai_tool_duration_count 5/);
  assert.match(text, /trhai_tool_duration_mean_ms 30/);
});

test("a percentile is the nearest rank, not an interpolation", () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentile(values, 0.5), 5);
  assert.equal(percentile(values, 0.95), 10);
  assert.equal(percentile(values, 1), 10);
});

test("an empty histogram reports zero rather than NaN", () => {
  assert.equal(percentile([], 0.95), 0);
});

test("a negative duration is dropped rather than poisoning the mean", () => {
  // A clock going backwards does not mean something took less than no time.
  observe("d", 100);
  observe("d", -50);
  observe("d", Number.NaN);

  assert.equal(snapshot().histograms.d.length, 1);
  assert.equal(snapshot().histograms.d[0], 100);
});

test("a long-running process keeps a bounded, recent window", () => {
  for (let index = 0; index < maxObservations + 50; index += 1) observe("d", index);

  const values = snapshot().histograms.d;
  assert.equal(values.length, maxObservations);
  // The newest window, which is what a percentile should describe.
  assert.equal(values[values.length - 1], maxObservations + 49);
});

test("timing records how long work took and returns its result", async () => {
  const result = await timed("work", async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return "done";
  });

  assert.equal(result, "done");
  const key = Object.keys(snapshot().histograms).find((name) => name.startsWith("work"));
  assert.ok(key?.includes('outcome="ok"'));
  assert.ok(snapshot().histograms[key!][0] >= 25);
});

test("failed work is timed too, and the error still propagates", async () => {
  // A route that fails slowly is a different problem from one that fails
  // fast, and timing only the successes hides it entirely.
  await assert.rejects(
    () => timed("work", async () => { throw new Error("nope"); }),
    /nope/
  );

  const key = Object.keys(snapshot().histograms).find((name) => name.includes('outcome="failed"'));
  assert.ok(key, "the failure should have been timed");
});

test("a snapshot is a copy, so a reader cannot rewrite the record", () => {
  observe("d", 100);
  const first = snapshot();
  first.histograms.d.push(9999);
  first.counters.invented = 42;

  assert.equal(snapshot().histograms.d.length, 1);
  assert.equal(snapshot().counters.invented, undefined);
});

test("the exposition format is scrapeable text, one metric per line", () => {
  increment("trhai_commands_total", { outcome: "ok" });
  observe("trhai_command_duration", 250);

  for (const line of toPrometheus().trim().split("\n")) {
    // name{labels} value — the shape a scraper expects.
    assert.match(line, /^[a-zA-Z_][a-zA-Z0-9_]*(\{.*\})? -?\d+(\.\d+)?$/, `bad line: ${line}`);
  }
});
