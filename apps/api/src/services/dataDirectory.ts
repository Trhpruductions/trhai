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

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
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
  return path.join(dataRoot(), name);
}

/** Cached so every store in one test process agrees on the same directory. */
let testDataRoot: string | undefined;

/**
 * The data directory, which is never the real one from inside a test.
 *
 * Caught by diffing the folder across a suite run: `npm test` was modifying
 * apps/api/data/tasks.json - the developer's real task store, five hundred
 * entries of their own work. Tests were writing live data.
 *
 * That is a bug on its own, and a strong candidate for the intermittent
 * failure this suite has shown roughly once in twenty runs: stores shared
 * between tests, and shared with any API process running alongside them, is
 * precisely the shape that fails occasionally and passes on the retry.
 *
 * Same guard as commandRunner's arm file, and for the same reason: it has to
 * be in the code rather than in an --import flag on the npm script, because
 * running one test file directly skips the flag. NODE_TEST_CONTEXT is set by
 * node's runner in every test child process however it was launched.
 */
function dataRoot(): string {
  if (process.env.NODE_TEST_CONTEXT) {
    testDataRoot ??= mkdtempSync(path.join(tmpdir(), "trhai-test-data-"));
    return testDataRoot;
  }

  return path.join(packageRoot(), "data");
}
