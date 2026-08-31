import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseFlow, type Flow } from "@ascend/shared";

// The saved automation flow, kept where the scheduler can reach it.
//
// It used to live only in the browser's localStorage, which was fine while a
// flow was something a person ran by hand on the page that held it. It stops
// being fine the moment something else needs to run it: the API process has
// no localStorage, so a scheduled flow would have been a schedule pointing at
// something the scheduler could not see.
//
// One flow per machine, matching the editor, which edits one. Multiple named
// flows would be a better model and a bigger change to that screen; this is
// the smallest move that makes the connection real rather than implied.

const flowFilePath = process.env.ASSIST_FLOW_FILE
  ?? path.join(process.cwd(), "data", "assist-flow.json");

let flow: Flow | null = null;
let loaded = false;
let persistenceEnabled = process.env.ASSIST_FLOW_PERSIST !== "off";

function loadFromDisk(): void {
  if (loaded) return;
  loaded = true;
  if (!persistenceEnabled || !existsSync(flowFilePath)) return;

  try {
    // Parsed through the same validator the browser uses, so a hand-edited
    // or truncated file is refused rather than half-loaded.
    flow = parseFlow(JSON.parse(readFileSync(flowFilePath, "utf8")));
  } catch {
    // A corrupt file must never take the API down.
  }
}

function saveToDisk(): void {
  if (!persistenceEnabled) return;

  const tempPath = `${flowFilePath}.tmp`;
  try {
    mkdirSync(path.dirname(flowFilePath), { recursive: true });
    writeFileSync(tempPath, JSON.stringify(flow, null, 2), "utf8");
    renameSync(tempPath, flowFilePath);
  } catch (error) {
    console.error(`flow could not be saved: ${error instanceof Error ? error.message : String(error)}`);
    try { rmSync(tempPath, { force: true }); } catch { /* nothing more to do */ }
  }
}

export function getFlow(): Flow | null {
  loadFromDisk();
  return flow ? { ...flow, nodes: flow.nodes.map((node) => ({ ...node })) } : null;
}

/** Store a flow, or null to clear it. Returns what was stored. */
export function saveFlow(candidate: unknown): Flow | null {
  loadFromDisk();
  const parsed = parseFlow(candidate);
  if (!parsed) return null;

  flow = parsed;
  saveToDisk();
  return getFlow();
}
