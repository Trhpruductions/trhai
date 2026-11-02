import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { keepLogsDays, maxLogBytes, tidyLogs } from "../src/logRetention.js";

// The logs the shell writes do not grow for good and are not kept for good.

const day = 24 * 60 * 60 * 1000;
const now = Date.parse("2026-11-01T12:00:00Z");

function folder(): string {
  return mkdtempSync(path.join(tmpdir(), "trhai-logs-"));
}

function write(directory: string, name: string, bytes: number, ageDays: number): string {
  const file = path.join(directory, name);
  writeFileSync(file, "x".repeat(bytes));
  const when = new Date(now - ageDays * day);
  utimesSync(file, when, when);
  return file;
}

test("a log over the size limit is moved aside, keeping one earlier copy, and a small one is left", () => {
  const dir = folder();
  try {
    write(dir, "trh-ai-api.log", maxLogBytes + 1, 0);
    write(dir, "trh-ai-web.log", 1000, 0);
    writeFileSync(path.join(dir, "trh-ai-api.old"), "the copy from the time before");
    const result = tidyLogs(dir, now);
    assert.deepEqual(result.rotated, ["trh-ai-api.log"]);
    assert.equal(existsSync(path.join(dir, "trh-ai-api.log")), false, "the next start opens a fresh one");
    assert.equal(readFileSync(path.join(dir, "trh-ai-api.old"), "utf8").length, maxLogBytes + 1, "the older copy was replaced, so only one is kept");
    assert.equal(existsSync(path.join(dir, "trh-ai-web.log")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a log not written to for a month is deleted, one written more recently is kept, and so is a small copy that is still fresh", () => {
  const dir = folder();
  try {
    write(dir, "old.log", 100, keepLogsDays + 1);
    write(dir, "older-copy.old", 100, keepLogsDays + 40);
    write(dir, "edge.log", 100, keepLogsDays - 1);
    write(dir, "fresh.old", 100, 1);
    const result = tidyLogs(dir, now);
    assert.deepEqual(result.removed.sort(), ["old.log", "older-copy.old"]);
    assert.equal(existsSync(path.join(dir, "edge.log")), true);
    assert.equal(existsSync(path.join(dir, "fresh.old")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("only logs are touched: other files and folders in the folder are never moved or deleted", () => {
  const dir = folder();
  try {
    write(dir, "notes.txt", maxLogBytes + 10, 500);
    write(dir, "settings.json", 10, 500);
    const result = tidyLogs(dir, now);
    assert.deepEqual(result, { rotated: [], removed: [] });
    assert.equal(existsSync(path.join(dir, "notes.txt")), true);
    assert.equal(existsSync(path.join(dir, "settings.json")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a folder that is not there is not an error", () => {
  assert.deepEqual(tidyLogs(path.join(tmpdir(), "trhai-no-such-logs-folder-xyz"), now), { rotated: [], removed: [] });
});
