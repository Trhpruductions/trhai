import { readdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";

// Keeping the logs the shell writes from growing for good.
//
// Each service the shell starts appends what it prints to a file in the app's logs
// folder. Left alone, those files only ever grew and were never removed, so a note the
// service made on the first day was still on disk years later. Now a log that has
// grown past a size is moved aside (one earlier copy is kept, so a failure just before
// the move is still there to read), and a log nobody has written to for a month is
// deleted. This runs when the app starts, before the services open their files.

/** The most a log may grow to before the next start moves it aside. */
export const maxLogBytes = 2 * 1024 * 1024;

/** How long a log is kept after it was last written to. */
export const keepLogsDays = 30;

const day = 24 * 60 * 60 * 1000;

export type TidyResult = { rotated: string[]; removed: string[] };

/**
 * Moves aside the logs in `directory` that are over the size limit and deletes the ones
 * not written to for `keepLogsDays`. A file that cannot be moved or removed (another
 * program has it open) is left, and the next start tries again. Never throws.
 */
export function tidyLogs(directory: string, now: number = Date.now()): TidyResult {
  const result: TidyResult = { rotated: [], removed: [] };
  let names: string[] = [];
  try {
    names = readdirSync(directory);
  } catch {
    return result;
  }
  for (const name of names) {
    if (!/\.(log|old)$/i.test(name)) continue;
    const file = path.join(directory, name);
    try {
      const info = statSync(file);
      if (!info.isFile()) continue;
      if (now - info.mtimeMs > keepLogsDays * day) {
        rmSync(file, { force: true });
        result.removed.push(name);
        continue;
      }
      if (/\.log$/i.test(name) && info.size > maxLogBytes) {
        const aside = file.replace(/\.log$/i, ".old");
        rmSync(aside, { force: true });
        renameSync(file, aside);
        result.rotated.push(name);
      }
    } catch {
      // Held open, or gone already: the next start will see it again.
    }
  }
  return result;
}
