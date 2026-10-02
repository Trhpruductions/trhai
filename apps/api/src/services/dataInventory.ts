import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { dataRoot } from "./dataDirectory.js";
import { dataKeyLocation } from "./protectedJson.js";
import { workspaceRoot } from "./workspace.js";

// What TRH AI keeps on this PC, file by file, for Settings > Data & privacy:
// what each store holds, how big it is, when it last changed, and whether it
// is actually encrypted - read from the file's own first bytes, not assumed
// from the code that should have written it.

export type DataFile = { name: string; about: string; bytes: number; modifiedAt: number; encrypted: boolean };

const about: Array<[RegExp, string]> = [
  [/backup/i, "A backup copy, kept from before a change to how something is stored"],
  [/^accounts\.json$/, "Accounts - passwords are kept only as salted hashes"],
  [/^assist-memory\.json$/, "What TRH AI remembers about you"],
  [/^conversations\.json$/, "Your conversations"],
  [/^assist-knowledge\.json$/, "Your documents"],
  [/^assist-schedules\.json$/, "Schedules, and every run of each"],
  [/^assist-tasks\.json$/, "Your to-dos"],
  [/^tasks\.json$/, "The work in progress \"continue\" resumes"],
  [/^task-history\.json$/, "Finished work, with the steps it took"],
  [/^tool-usage\.json$/, "How often each tool has run - counts and times only"],
  [/^assist-flow\.json$/, "The automation flow"],
  [/^preferences\.json$/, "Preferences"],
  [/^command-arm\.json$/, "The machine-access switch"]
];

function describe(name: string): string {
  return about.find(([pattern]) => pattern.test(name))?.[1] ?? "Kept by TRH AI";
}

/** Whether a stored file is the encrypted envelope protectedJson writes, from its own opening bytes. */
export function looksEncrypted(file: string): boolean {
  let handle: number | null = null;
  try {
    handle = openSync(file, "r");
    const buffer = Buffer.alloc(400);
    const read = readSync(handle, buffer, 0, buffer.length, 0);
    return /"protected"\s*:\s*true/.test(buffer.subarray(0, read).toString("utf8"));
  } catch {
    return false;
  } finally {
    if (handle !== null) closeSync(handle);
  }
}

export function dataInventory(): { directory: string; keyFile: string; workspace: string; files: DataFile[] } {
  const directory = dataRoot();
  let names: string[] = [];
  try {
    names = readdirSync(directory);
  } catch {
    // No folder yet: nothing has been saved.
  }
  const files: DataFile[] = [];
  for (const name of names) {
    // Temp files mid-write and the key itself are not stores.
    if (name.endsWith(".tmp") || name.startsWith(".trhai-data-key")) continue;
    const full = path.join(directory, name);
    try {
      const info = statSync(full);
      if (!info.isFile()) continue;
      files.push({ name, about: describe(name), bytes: info.size, modifiedAt: info.mtimeMs, encrypted: looksEncrypted(full) });
    } catch {
      continue;
    }
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  return { directory, keyFile: dataKeyLocation(), workspace: workspaceRoot(), files };
}
