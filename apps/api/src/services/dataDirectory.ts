// Where this app keeps its own files.
//
// Nine stores resolved their default with `path.join(process.cwd(), "data",
// ...)` - accounts, memories, conversations, schedules, tasks, preferences,
// knowledge, the flow and the machine-access grant. Every one of those is the
// user's actual content, and every one of them moved with the working
// directory.
//
// In practice the API has always been started from apps/api, so the data has
// stayed in one place and nothing has been lost. That is luck rather than
// design, and the luck was getting thinner: making .env load from the repo
// root makes starting the API from the repo root a reasonable thing to do,
// and the first person to do it would have found an assistant with no
// memories, no conversations and no schedules - all of it still on disk, just
// somewhere the app was no longer looking.
//
// Anchored to this package rather than to the repo root on purpose. apps/api
// is where the data already is, so this changes nothing about where anything
// is read from or written to; it only stops the answer depending on how the
// process was started. A repo-root anchor would have been just as stable and
// would have moved everything, which is a migration nobody asked for.

import path from "node:path";
import { fileURLToPath } from "node:url";

/** apps/api, found from this file rather than from the working directory. */
export function packageRoot(): string {
  // src/services/dataDirectory.ts -> src/services -> src -> apps/api
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/**
 * The absolute path of one of this app's data files.
 *
 * Callers keep their own environment override; this only replaces the
 * cwd-relative fallback behind it.
 */
export function dataFile(name: string): string {
  return path.join(packageRoot(), "data", name);
}
