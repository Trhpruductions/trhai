import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The config file has to load from wherever the process starts.
//
// `dotenv.config({ path: ".env" })` resolves that against process.cwd(). The
// file lives at the repo root, and npm runs a workspace script with cwd set to
// the workspace - so `npm start` ran the API from apps/api and loaded nothing.
// dotenv said so on every boot, "injected env (0) from .env", and (0) was the
// whole story.
//
// Seven settings were ignored in normal operation. The visible symptom was the
// model: .env pins qwen2.5-coder:7b, that model is installed, and the app was
// answering on vexora:latest - 1.9GB instead of 4.7GB - because with
// OLLAMA_MODEL unset the preference list picks for itself. Output that looked
// like a weak model was a config file nobody had loaded.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const apiDir = path.resolve(here, "..");

test("the repo root .env is found from the workspace directory", () => {
  const envFile = path.join(repoRoot, ".env");
  if (!existsSync(envFile)) return;   // a fresh clone has none; nothing to prove

  // Run the same resolution the API does, with cwd set to where npm puts it.
  const script = [
    'import { existsSync } from "node:fs";',
    'import path from "node:path";',
    'let d = process.argv[1];',
    'let found = "";',
    'for (let i = 0; i < 6; i += 1) {',
    '  const c = path.join(d, ".env");',
    '  if (existsSync(c)) { found = c; break; }',
    '  const p = path.dirname(d); if (p === d) break; d = p;',
    '}',
    'console.log(found);'
  ].join("\n");

  const found = execFileSync(process.execPath, ["--input-type=module", "-e", script, path.join(apiDir, "src")],
    { cwd: apiDir, encoding: "utf8" }).trim();

  assert.ok(found, "walking up from src must reach the repo root .env");
  assert.equal(path.resolve(found), path.resolve(envFile));
});

test("index.ts does not resolve .env against the working directory", () => {
  // The specific mistake: a bare relative path handed to dotenv.
  const source = readFileSync(path.join(apiDir, "src", "index.ts"), "utf8");
  assert.doesNotMatch(
    source,
    /dotenv\.config\(\{\s*path:\s*process\.env\.NODE_ENV/,
    "the cwd-relative form is back; it loads nothing when npm sets cwd to apps/api"
  );
  assert.match(source, /findEnvFile/, "resolution should walk up from this file");
});
