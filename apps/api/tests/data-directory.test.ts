import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dataFile, packageRoot } from "../src/services/dataDirectory.js";

// Where the user's own content lives, decided by this package and not by the
// shell that started it.
//
// Nine stores defaulted to path.join(process.cwd(), "data", ...) - accounts,
// memories, conversations, schedules, tasks, preferences, knowledge, the flow
// and the machine-access grant. All of that is the user's actual content, and
// all of it moved with the working directory.
//
// It never split, because the API had only ever been started from apps/api.
// That was luck, and the luck was thinning: making .env load from the repo
// root makes starting from the repo root reasonable, and the first person to
// do it would have met an assistant with no memories and no conversations -
// every byte still on disk, just somewhere it was no longer looking.

const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(here, "..");

test("the package root is this package, wherever the process started", () => {
  // The anchor that replaced process.cwd(). It does not move with the shell.
  assert.equal(path.resolve(packageRoot()), path.resolve(apiDir));
});

test("a test process never resolves the real data directory", () => {
  // Caught by diffing apps/api/data across a suite run: npm test was modifying
  // tasks.json, the developer's real task store with five hundred entries of
  // their own work. Tests were writing live data, and sharing it with any API
  // process running alongside them.
  //
  // This assertion used to require the real path, which was right before the
  // isolation existed and wrong the moment it did - so this test failed on the
  // very change that fixed the bug it should have been guarding against.
  const resolved = path.resolve(dataFile("accounts.json"));
  assert.notEqual(resolved, path.resolve(apiDir, "data", "accounts.json"),
    "a test must not resolve the real data file");
  assert.match(resolved, /accounts\.json$/);

  // Stable within the process, or two stores would disagree about where they live.
  assert.equal(path.resolve(dataFile("accounts.json")), resolved);
});

test("no store resolves its data path against the working directory", () => {
  // The specific mistake, caught by shape rather than by memory of which files
  // had it. A new store copying the old pattern fails here.
  const services = path.join(apiDir, "src", "services");
  const offenders: string[] = [];

  for (const file of readdirSync(services).filter((name) => name.endsWith(".ts"))) {
    const source = readFileSync(path.join(services, file), "utf8");
    // dataDirectory itself explains the pattern in prose; commandRunner names
    // it in a comment about the home directory. Only real calls matter.
    const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    if (/path\.join\(\s*process\.cwd\(\)\s*,\s*["']data["']/.test(withoutComments)) {
      offenders.push(file);
    }
  }

  assert.deepEqual(offenders, [], `these resolve data against cwd: ${offenders.join(", ")}`);
});
