// How the Memory workspace describes what TRH AI remembers: the kind of each
// memory, how it came to be remembered (from the rule that captured it), and
// what each entry in the history means. Pure, so the wording is testable.

export type MemoryKind = "fact" | "preference" | "decision" | "constraint";

export type MemoryRow = {
  id: string;
  title: string;
  body: string;
  kind: MemoryKind;
  rule: string;
  createdAt: string;
  pinned: boolean;
  editedAt?: string;
};

export type MemoryAuditRow = {
  id: string;
  memoryId: string | null;
  action: "recorded" | "pinned" | "unpinned" | "relabeled" | "forgotten" | "cleared";
  detail: string;
  createdAt: string;
};

export const memoryKinds: Array<{ id: MemoryKind; label: string; plural: string }> = [
  { id: "fact", label: "Fact", plural: "Facts" },
  { id: "preference", label: "Preference", plural: "Preferences" },
  { id: "decision", label: "Decision", plural: "Decisions" },
  { id: "constraint", label: "Constraint", plural: "Constraints" }
];

export function kindLabel(kind: string): string {
  return memoryKinds.find((entry) => entry.id === kind)?.label ?? "Memory";
}

/** How a memory came to be stored, in words, from the rule that captured it. */
export function howLearned(rule: string): string {
  switch (rule) {
    case "explicit-remember": return "You asked to remember this";
    case "explicit-note": return "You asked to note this";
    case "preference": return "You said you prefer this";
    case "dislike": return "You said you dislike this";
    case "favourite": return "You named a favourite";
    case "team-convention": return "A convention you described";
    case "hard-constraint": return "A must or must-not you set";
    case "requirement": return "A requirement you gave";
    case "profile":
    case "introduction": return "Something you said about yourself";
    case "named-relation": return "Someone you mentioned";
    default: return "Picked up from something you said";
  }
}

/** One line of the memory history, as a verb. */
export function auditVerb(action: MemoryAuditRow["action"]): string {
  switch (action) {
    case "recorded": return "Remembered";
    case "pinned": return "Pinned";
    case "unpinned": return "Unpinned";
    case "relabeled": return "Renamed";
    case "forgotten": return "Forgot";
    case "cleared": return "Forgot everything";
  }
}

/**
 * The history line without its machinery: the store writes "Recorded via
 * explicit-remember: <title>", and the rule name is for tracing, not reading.
 */
export function auditDetail(entry: MemoryAuditRow): string {
  return entry.detail.replace(/^Recorded via [\w-]+:\s*/, "").trim();
}

/** Memories matching a search (title or body) and a kind; order kept (pinned first, newest next). */
export function filterMemories(list: MemoryRow[], query: string, kind: MemoryKind | "all"): MemoryRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return list.filter((memory) => {
    if (kind !== "all" && memory.kind !== kind) return false;
    const text = `${memory.title} ${memory.body}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/** How many memories of each kind there are, for the filter's counts. */
export function countByKind(list: MemoryRow[]): Record<MemoryKind | "all", number> {
  const counts = { all: list.length, fact: 0, preference: 0, decision: 0, constraint: 0 };
  for (const memory of list) if (memory.kind in counts) counts[memory.kind] += 1;
  return counts;
}
