import { closeSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { dataRoot } from "./dataDirectory.js";
import { dataKeyLocation, parseProtectedJson, protectedJsonLooksEncrypted, writeProtectedJsonFile } from "./protectedJson.js";
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
  [/^command-arm\.json$/, "The machine-access switch"],
  [/^network-access\.json$/, "The key other devices need, when they are let in"]
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

/**
 * Every store in the data folder still held as plain JSON, rewritten encrypted.
 *
 * Found 2026-10-02: accounts.json had been plain since August. Its store
 * writes encrypted, but only on a sign-in or an account change, and none had
 * happened since - signed out, it is never even read. preferences.json and
 * command-arm.json were the same. A store that is not saved again is never
 * encrypted, so this does it at startup, for every one.
 *
 * A file is replaced only once its encrypted copy has been read back and
 * matches what was there. Backups are left exactly as they are: whether to
 * keep a plain copy is the user's call, not this sweep's.
 */
export function encryptPlainStores(directory: string = dataRoot()): { encrypted: string[]; failed: Array<{ name: string; reason: string }> } {
  const encrypted: string[] = [];
  const failed: Array<{ name: string; reason: string }> = [];
  let names: string[] = [];
  try {
    names = readdirSync(directory);
  } catch {
    // No folder yet: nothing has been saved.
  }
  for (const name of names.sort()) {
    if (!name.endsWith(".json") || /backup/i.test(name)) continue;
    const file = path.join(directory, name);
    try {
      if (!statSync(file).isFile() || looksEncrypted(file)) continue;
    } catch {
      continue;
    }
    const temp = `${file}.encrypting.tmp`;
    try {
      const text = readFileSync(file, "utf8");
      if (protectedJsonLooksEncrypted(text)) continue;
      const value = JSON.parse(text) as unknown;
      writeProtectedJsonFile(temp, value);
      if (JSON.stringify(parseProtectedJson(readFileSync(temp, "utf8"))) !== JSON.stringify(value)) {
        throw new Error("the encrypted copy did not read back the same");
      }
      renameSync(temp, file);
      encrypted.push(name);
    } catch (error) {
      rmSync(temp, { force: true });
      failed.push({ name, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { encrypted, failed };
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
