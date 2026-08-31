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
// Level 2 runs automatically. Requiring a click before every file write would
// make the assistant useless for the thing it is mainly for.
//
// What bounds a level 2 write has changed, and the old reasoning here was left
// behind by it. This used to say the workspace guard meant "a level 2 tool
// cannot reach outside it, so the blast radius is a directory the user chose,
// not the machine". That stopped being true when file access started following
// the machine-access switch: with it on, write_file and edit_file reach the
// whole disk.
//
// The bound is now that switch. It is off by default, granted deliberately for
// a fixed window, not inherited by unattended runs, and refuses writes to
// system locations even when on. That is a real boundary — but it is a
// different one, and a comment claiming the old guarantee would be describing
// an app that no longer exists.
//
// Level 3 is about recoverability, not importance. write_file overwrites and
// is still level 2, because overwriting is the ordinary way of working on
// files. forget and delete_document destroy the only copy of something the
// user deliberately saved, and nothing in this app can bring it back.

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

  // 2 — creates or changes something. Bounded by the workspace on its own, or
  // by the machine-access switch when that has been granted.
  remember: 2,
  pin_memory: 2,
  write_document: 2,
  update_document: 2,
  write_file: 2,
  // Targeted rather than wholesale, so if anything it is the safer of the two:
  // it changes the text it was given and cannot silently drop the rest of a file.
  edit_file: 2,
  build_app: 2,

  // 3 — destroys the only copy of something the user chose to keep, or
  // reaches outside the workspace entirely.
  forget: 3,
  delete_document: 3,
  // The only tool here not bounded by the workspace: it runs as the user and
  // can do anything they can.
  //
  // Level 3 here is NOT a confirmation prompt in practice, and it is worth
  // being exact about that rather than leaving a comfortable-sounding comment
  // in place. agentTools treats machine access being on as pre-authorisation
  // (`preAuthorised`), and access now defaults to on - so this tool runs
  // without asking. That is the behaviour the user asked for: an assistant
  // that has to beg before every command is one they have to manage.
  //
  // This entry still matters for everything else that reads the ladder -
  // changesSomething, the interface labels - and it becomes a real
  // confirmation again the moment access is switched off. What actually
  // constrains this tool day to day is elsewhere: an unattended run is refused
  // outright and cannot be confirmed into being, the tool is not offered to the
  // model at all while access is off, and every command is recorded with its
  // output and exit code whether it succeeded or not.
  run_command: 3
};

/**
 * Whether running this tool can have changed something.
 *
 * Read off the ladder rather than kept as a second list. agentLoop has a
 * `mutatingTools` set for a different job - whose output gets repeated verbatim
 * in the reply - and it does not contain edit_file. Reusing it as the record of
 * "did anything get written" would have called a real, successful edit a lie,
 * because edit_file's absence from that set is correct for its actual purpose.
 *
 * Level 2 is defined above as "creates or changes something" and level 3 as
 * destroying or escaping the workspace, so both count. Unknown tools land on 3
 * and count too, which is the right way to be wrong here: a guard that accuses
 * the model of claiming a change it never made must never fire on a change that
 * really happened, since that replaces a true reply with a false denial.
 */
export function changesSomething(toolName: string): boolean {
  return permissionLevelOf(toolName) >= 2;
}

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
