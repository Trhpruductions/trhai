// How the Tool center describes TRH AI's tools: what each permission level
// means, how often a tool has run, what a search and a filter keep, and how
// the list is grouped. Pure, so the wording is testable without a screen.

export type ToolArea =
  | "Memory" | "Documents" | "Files" | "Apps" | "Web" | "Schedules" | "Time and maths" | "Media" | "Messages" | "This PC";

export type ToolUsage = {
  uses: number;
  /** Came back without a result - nothing matched, or refused, or failed; the tools do not tell these apart. */
  noResult: number;
  held: number;
  lastUsedAt: string | null;
  lastOk: boolean | null;
  lastDurationMs: number | null;
};

export type ToolEntry = {
  name: string;
  title: string;
  summary: string;
  area: ToolArea;
  instructions: string;
  level: 1 | 2 | 3 | 4;
  levelLabel: string;
  asksFirst: boolean;
  readiness: { state: "ready" | "off" | "needs-setup"; note: string | null };
  usage: ToolUsage;
};

export type ToolFilter = "all" | "used" | "asks-first" | "attention";

export const toolFilters: Array<{ id: ToolFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "used", label: "Used" },
  { id: "asks-first", label: "Asks first" },
  { id: "attention", label: "Not ready" }
];

/** The permission ladder, in what each rung lets a tool do and whether it asks. */
export const levels: Record<ToolEntry["level"], { label: string; meaning: string; tone: string }> = {
  1: { label: "Looks only", meaning: "Reads, searches and works things out. Runs on its own.", tone: "ok" },
  2: { label: "Makes changes", meaning: "Creates and changes files, documents, apps and schedules. Runs on its own.", tone: "accent" },
  3: { label: "Can't be undone", meaning: "Deletes something that cannot be brought back, or runs commands. Asks you first - except commands, while machine access is on.", tone: "warn" },
  4: { label: "Reaches outside", meaning: "Sends something from you to someone else. Always asks you first.", tone: "danger" }
};

export const areaOrder: ToolArea[] = ["Memory", "Documents", "Files", "Apps", "Web", "Schedules", "Time and maths", "Media", "Messages", "This PC"];

/** "Not used yet", or "Used 12 times · last 5m ago" - `ago` turns a time into words. */
export function usageLine(usage: ToolUsage, ago: (iso: string) => string): string {
  const parts: string[] = [];
  if (usage.uses === 0) parts.push("Not used yet");
  else {
    parts.push(`Used ${usage.uses} time${usage.uses === 1 ? "" : "s"}`);
    if (usage.lastUsedAt) parts.push(`last ${ago(usage.lastUsedAt)}`);
  }
  if (usage.held > 0) parts.push(`held for you ${usage.held} time${usage.held === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

/** How the last call that ran came back, or null when nothing has run. */
export function lastCallWords(usage: ToolUsage): string | null {
  if (usage.lastOk === null) return null;
  return usage.lastOk ? "Last call came back with a result" : "Last call came back without a result";
}

const needsAttention = (tool: ToolEntry) => tool.readiness.state !== "ready";

/** Tools a search and a filter keep: every word in the title, name, summary or area. */
export function filterTools(list: ToolEntry[], query: string, filter: ToolFilter): ToolEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return list.filter((tool) => {
    if (filter === "used" && tool.usage.uses === 0) return false;
    if (filter === "asks-first" && !tool.asksFirst) return false;
    if (filter === "attention" && !needsAttention(tool)) return false;
    const text = `${tool.title} ${tool.name} ${tool.summary} ${tool.area}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

export function countTools(list: ToolEntry[]): Record<ToolFilter, number> {
  return {
    all: list.length,
    used: list.filter((tool) => tool.usage.uses > 0).length,
    "asks-first": list.filter((tool) => tool.asksFirst).length,
    attention: list.filter(needsAttention).length
  };
}

/** The list in areas, in a fixed order, each keeping the order it came in. */
export function groupByArea(list: ToolEntry[]): Array<{ area: ToolArea; tools: ToolEntry[] }> {
  return areaOrder
    .map((area) => ({ area, tools: list.filter((tool) => tool.area === area) }))
    .filter((group) => group.tools.length > 0);
}

/** How many tools sit on each rung. */
export function countByLevel(list: ToolEntry[]): Record<ToolEntry["level"], number> {
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const tool of list) counts[tool.level] += 1;
  return counts;
}
