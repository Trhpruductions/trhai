// What each tool is allowed to do without being asked.
//
// The ladder from the product vision, applied to the tools that actually
// exist rather than to a hypothetical set:
//
//   1 safe        reading, searching, analysing        runs automatically
//   2 development creating and modifying in the        runs automatically
//                 workspace
//   3 destructive deleting, or overwriting something   confirmation required
//                 that cannot be recovered
//   4 external    publishing, sending, spending        confirmation required
//
// Two decisions worth stating, because both could reasonably have gone the
// other way.
//
// Level 2 runs automatically. Requiring a click before every file write
// would make the assistant useless for the thing it is mainly for, and the
// workspace guard already bounds where a write can land — a level 2 tool
// cannot reach outside it, so the blast radius is a directory the user
// chose, not the machine.
//
// Level 3 is about recoverability, not importance. write_file overwrites and
// is still level 2, because the workspace is the user's own scratch space and
// an overwrite there is the ordinary way of working. forget and
// delete_document destroy the only copy of something the user deliberately
// saved, and nothing in this app can bring it back.

export type PermissionLevel = 1 | 2 | 3 | 4;

export const permissionLabels: Record<PermissionLevel, string> = {
  1: "safe",
  2: "development",
  3: "destructive",
  4: "external"
};

/**
 * Every registered tool, with the level it runs at.
 *
 * Exhaustive by construction: a test asserts this covers exactly the tools
 * in the registry, so a new tool cannot be added without deciding what it is
 * allowed to do. An unlisted tool is treated as level 3 rather than level 1,
 * so the failure mode of forgetting is a refusal, not silent permission.
 */
export const toolPermissions: Record<string, PermissionLevel> = {
  // 1 — reads nothing but what is already stored, changes nothing.
  search_memory: 1,
  search_documents: 1,
  search_conversation: 1,
  list_memories: 1,
  list_documents: 1,
  read_document: 1,
  list_files: 1,
  read_file: 1,
  calculate: 1,
  current_datetime: 1,
  days_between: 1,
  shift_date: 1,
  // plan_app only describes what would be built; build_app is what builds it.
  plan_app: 1,
  // The one exception to "reads nothing but what is already stored": it
  // reads a page from the internet instead. Still level 1 by this ladder's
  // own definition — it changes nothing on this machine — but see
  // webFetch.ts for why that exception is safe to make at all.
  fetch_url: 1,

  // 2 — creates or changes something, inside a bounded workspace.
  remember: 2,
  pin_memory: 2,
  write_document: 2,
  update_document: 2,
  write_file: 2,
  build_app: 2,

  // 3 — destroys the only copy of something the user chose to keep, or
  // reaches outside the workspace entirely.
  forget: 3,
  delete_document: 3,
  // The only tool here not bounded by the workspace: it runs as the user and
  // can do anything they can. Gated twice over — this level, and an arming
  // window without which it is never offered to the model at all.
  run_command: 3
};

/** Unknown tools are treated as destructive, so forgetting to classify is safe. */
export function permissionLevelOf(toolName: string): PermissionLevel {
  return toolPermissions[toolName] ?? 3;
}

export function requiresConfirmation(toolName: string): boolean {
  return permissionLevelOf(toolName) >= 3;
}

/**
 * What to tell the model when a tool is refused for want of confirmation.
 *
 * Addressed to the model, because that is who reads it, and written so the
 * only sensible next move is to ask the user rather than to try a different
 * tool that happens to have the same effect.
 */
export function describeConfirmationNeeded(toolName: string): string {
  const level = permissionLevelOf(toolName);
  return `"${toolName}" is a ${permissionLabels[level]} action and needs the user's confirmation `
    + "before it can run. Nothing has been changed. Tell the user plainly what it would do and "
    + "ask them to confirm; do not attempt it another way.";
}
