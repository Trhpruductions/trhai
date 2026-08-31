// Where the work lives, told to the model rather than left to be guessed.
//
// The model was never told the workspace's path or what was in it. The prompt
// says "the workspace" a dozen times and never once says where that is, so the
// model filled the gap the way models do - by inventing something plausible.
// Asked to list "the calculator folder" it called list_files on
// D:/projects/calculator, a directory that has never existed on this machine;
// another turn reached for C:\Users\hankh\index.js. Both failed, and the reply
// then asked the user to supply the full path.
//
// That is precisely the friction the product spec calls out: the assistant
// should not force someone to re-explain where their own project is. And the
// tools were never the problem - `read calculator/server.js` worked first time.
// Only the knowledge of what to pass them was missing.
//
// Names only, never contents. A directory listing is cheap and stays true; a
// summary of what each project does would be a second copy of the truth, and
// the stale one.

import { commandWorkingDirectory } from "./commandRunner.js";
import { listWorkspace, workspaceRoot } from "./workspace.js";

/**
 * How many project names to name outright.
 *
 * The workspace on this machine holds sixty-odd directories, most of them
 * built and forgotten. Listing every one would crowd the prompt with noise and
 * push the instructions that matter further from the model's attention, so the
 * most recent are named and the rest are counted.
 */
export const namedProjectLimit = 12;

export type ProjectSummary = {
  root: string;
  /** Where run_command starts, which is not the workspace. */
  commandCwd: string;
  /** Directory names, most recently modified first. */
  projects: string[];
  /** How many exist in total, named or not. */
  total: number;
};

/**
 * The workspace as it is right now.
 *
 * Read per turn rather than cached: an app built earlier in the same
 * conversation has to be referable by name in the next message, and a cache
 * would answer with the workspace as it looked before the build.
 */
export function summariseWorkspace(): ProjectSummary {
  const entries = listWorkspace(".") ?? [];
  const directories = entries
    .filter((entry) => entry.directory)
    .sort((left, right) => right.modifiedAt - left.modifiedAt)
    .map((entry) => entry.path);

  return {
    root: workspaceRoot(),
    commandCwd: commandWorkingDirectory(),
    projects: directories.slice(0, namedProjectLimit),
    total: directories.length
  };
}

/**
 * The lines to add to the system prompt.
 *
 * Empty when the workspace has nothing in it - an empty list would read as
 * "there are no projects", which is true but not worth the tokens, and the
 * root is still worth stating so a first write lands somewhere sensible.
 */
export function describeWorkspace(summary: ProjectSummary, working?: string | null): string {
  const lines = [
    `The workspace is at ${summary.root}. Every path you pass to list_files, read_file,`,
    "write_file or edit_file is relative to it unless it is already absolute. Never invent",
    "a path outside it and never guess at one like D:/projects or C:/Users."
  ];

  if (summary.projects.length > 0) {
    const rest = summary.total - summary.projects.length;
    lines.push(
      "",
      `Projects in it right now, most recent first${rest > 0 ? ` (${rest} older ones not listed)` : ""}:`,
      summary.projects.map((name) => `- ${name}`).join("\n"),
      "",
      "When the user names one of these, use that directory. \"the calculator app\" means",
      "the calculator directory, so read_file(\"calculator/server.js\") - do not ask them for",
      "a full path when the name is already enough to find it."
    );
  }

  // Commands do not start in the workspace, and the model had no way to know.
  // Asked about an app it ran `node index.js` and got "Cannot find module
  // C:\Users\hankh\index.js" - the shell resolving a relative path against a
  // directory nobody had mentioned to it.
  //
  // Stated rather than changed. The home directory is a reasonable default for
  // "check the disk", and moving it would be a behaviour change to fix what was
  // only ever a gap in what the model had been told.
  lines.push(
    "",
    `run_command does NOT start in the workspace - it runs in ${summary.commandCwd}.`,
    "To run something inside a project, cd into it first or use an absolute path:",
    `cd ${summary.root}/<project> && npm start`
  );

  // Which one the conversation is actually in.
  //
  // The list above lets the model find a project when it is named. This is
  // what lets "fix the router" work without naming one - the spec's own
  // example, and the friction it asks to remove: "It should not force me to
  // repeatedly explain the same project."
  //
  // Only stated when a tool in this session has genuinely worked inside a
  // project. Guessing a current project from nothing would be worse than
  // having none: the model would confidently edit the wrong app.
  if (working) {
    lines.push(
      "",
      `You are currently working in ${working}. When the user says "the router", "this`,
      `project" or names a file with no directory, they mean ${working} unless they say`,
      "otherwise."
    );
  }

  return lines.join("\n");
}

/**
 * Paths that look like what was asked for, when a read misses.
 *
 * A miss used to end the turn. `There is no file at
 * "calculator/public/server.js".` is true and useless: it names what is absent
 * and nothing about what is there, so the model either gave up or guessed
 * again. Seen live - it guessed the public/ subdirectory, was told no, said
 * "let's try the main directory instead", and then stopped.
 *
 * Matching is on the file name alone. The model gets the directory wrong far
 * more often than the name, because the name is the part the user actually
 * said out loud.
 */
/** Windows and POSIX separators both appear here; compare on one of them. */
function slashes(value: string): string {
  return value.split("\\").join("/");
}

/** The file name alone - the part the user actually said out loud. */
function basename(value: string): string {
  const parts = slashes(value).split("/");
  return (parts[parts.length - 1] ?? "").toLowerCase();
}

export function suggestPaths(missing: string, limit = 3): string[] {
  const wanted = basename(missing);
  if (!wanted) return [];

  const asked = slashes(missing).split("/").slice(0, -1);

  const entries = listWorkspace(".") ?? [];
  const matches = entries
    .filter((entry) => !entry.directory)
    .map((entry) => entry.path)
    .filter((candidate) => basename(candidate) === wanted)
    // The one that was already tried is not a suggestion.
    .filter((candidate) => slashes(candidate) !== slashes(missing));

  // Nearest first, by how much of the path they already agree on.
  //
  // Without this the answer was whatever had been written most recently:
  // asked about calculator/public/server.js it offered app-17/server.js,
  // which is a different project entirely. Every generated app has a
  // server.js, so the name alone cannot choose between them - the directory
  // the user was already talking about is what makes one of them the answer.
  const shared = (candidate: string): number => {
    const parts = slashes(candidate).split("/").slice(0, -1);
    let same = 0;
    while (same < parts.length && same < asked.length && parts[same] === asked[same]) same += 1;
    return same;
  };

  return matches
    .sort((left, right) => shared(right) - shared(left))
    .slice(0, limit);
}

/** The miss, plus anywhere that name really does exist. */
export function explainMiss(reason: string, missing: string): string {
  const found = suggestPaths(missing);
  if (found.length === 0) return reason;

  return `${reason} That name does exist here: ${found.join(", ")}. `
    + "Read one of those instead of guessing another directory.";
}
