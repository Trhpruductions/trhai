import { existsSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { dataFile } from "./dataDirectory.js";
import { assertProtectedJsonWritable, readProtectedJsonFile, writeProtectedJsonFile } from "./protectedJson.js";
import { recordPersistFailure, recordPersistSuccess } from "./persistenceHealth.js";

// How often each tool has run, and how its last run went.
//
// Counts and times only - never a tool's arguments or what it returned. This
// is kept for the whole machine, like schedules, because the tools act on the
// machine; what a tool was asked to do belongs to whoever asked, and the task
// history keeps that, per account.
//
// Written by runTool, the one function every tool call passes through, so a
// tool cannot run without being counted here.

export type ToolUsage = {
  /** Calls that ran, whatever they came back with. */
  uses: number;
  /**
   * Calls that came back without a result: nothing matched, or the tool
   * refused or failed. The tools report these alike - a search that finds
   * nothing returns the same "not ok" as a write that was refused - so they
   * are counted alike, and never called failures.
   */
  noResult: number;
  /** Calls held for the user's approval instead of run. */
  held: number;
  lastUsedAt: string | null;
  /** Whether the last call that ran came back with a result. */
  lastOk: boolean | null;
  /** Measured, for the last call that ran. */
  lastDurationMs: number | null;
};

export type ToolOutcome = "ok" | "no-result" | "held";

const usageFilePath = process.env.ASSIST_TOOL_USAGE_FILE
  ?? dataFile("tool-usage.json");

const persistenceEnabled = process.env.ASSIST_TOOL_USAGE_PERSIST !== "off";
let loaded = false;
const usageByTool = new Map<string, ToolUsage>();

const empty = (): ToolUsage => ({ uses: 0, noResult: 0, held: 0, lastUsedAt: null, lastOk: null, lastDurationMs: null });

const isCount = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 0;

function isUsage(value: unknown): value is ToolUsage {
  if (!value || typeof value !== "object") return false;
  const usage = value as Partial<ToolUsage>;
  return isCount(usage.uses) && isCount(usage.noResult) && isCount(usage.held)
    && (usage.lastUsedAt === null || typeof usage.lastUsedAt === "string")
    && (usage.lastOk === null || typeof usage.lastOk === "boolean")
    && (usage.lastDurationMs === null || isCount(usage.lastDurationMs));
}

function loadFromDisk(): void {
  if (loaded) return;
  loaded = true;
  if (!persistenceEnabled || !existsSync(usageFilePath)) return;

  try {
    const parsed = readProtectedJsonFile(usageFilePath) as { tools?: Array<{ name?: unknown; usage?: unknown }> };
    for (const entry of parsed.tools ?? []) {
      if (entry && typeof entry.name === "string" && isUsage(entry.usage)) usageByTool.set(entry.name, { ...entry.usage });
    }
  } catch {
    // A corrupt file must not take the API down; the counts start again.
  }
}

function saveToDisk(): void {
  if (!persistenceEnabled) return;
  try {
    const payload = { version: 1, tools: [...usageByTool.entries()].map(([name, usage]) => ({ name, usage })) };
    mkdirSync(path.dirname(usageFilePath), { recursive: true });
    const tempPath = `${usageFilePath}.tmp`;
    assertProtectedJsonWritable(usageFilePath);
    writeProtectedJsonFile(tempPath, payload);
    renameSync(tempPath, usageFilePath);
    recordPersistSuccess("tool usage");
  } catch (error) {
    // Reported, and never allowed to fail the tool call it was counting.
    recordPersistFailure("tool usage", error);
  }
}

export function recordToolUse(name: string, outcome: ToolOutcome, durationMs: number, now: Date = new Date()): void {
  loadFromDisk();
  const usage = usageByTool.get(name) ?? empty();
  if (outcome === "held") {
    usage.held += 1;
  } else {
    usage.uses += 1;
    if (outcome === "no-result") usage.noResult += 1;
    usage.lastUsedAt = now.toISOString();
    usage.lastOk = outcome === "ok";
    usage.lastDurationMs = Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : null;
  }
  usageByTool.set(name, usage);
  saveToDisk();
}

export function toolUsage(name: string): ToolUsage {
  loadFromDisk();
  return { ...(usageByTool.get(name) ?? empty()) };
}

/** Test seam. */
export function resetToolUsage(): void {
  loaded = true;
  usageByTool.clear();
  saveToDisk();
}

/** Test seam: drop in-process state and read the file again, as a restart would. */
export function reloadToolUsageFromDisk(): void {
  usageByTool.clear();
  loaded = false;
  loadFromDisk();
}
