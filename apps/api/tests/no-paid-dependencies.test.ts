import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// This app must cost nothing to run.
//
// Everything it does happens on this machine: a local model, a local API, local
// storage. That is a deliberate constraint, and it is the kind of constraint
// that erodes one convenient import at a time — someone reaches for a hosted
// model to fix one stubborn answer, and from then on the app needs a paid
// account to do what it used to do for free.
//
// These tests fail when that happens. They check the source, not the running
// app, because the point is to catch it at the moment it is written.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const searchRoots = ["apps", "packages"].map((entry) => path.join(repoRoot, entry));

/** Directories that are not this project's own source. */
const skipDirectories = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  "coverage",
  // Scaffolds this app writes for the user. They are output, not source, and
  // their contents are the user's to change.
  "generated-projects"
]);

const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

/** This file names every forbidden string, so it must not scan itself. */
const selfPath = path.resolve(here, "no-paid-dependencies.test.ts");

function collectSourceFiles(directory: string, found: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return found;
  }

  for (const entry of entries) {
    if (skipDirectories.has(entry)) continue;

    const fullPath = path.join(directory, entry);
    let isDirectory: boolean;
    try {
      isDirectory = statSync(fullPath).isDirectory();
    } catch {
      continue;
    }

    if (isDirectory) {
      collectSourceFiles(fullPath, found);
    } else if (sourceExtensions.has(path.extname(entry)) && path.resolve(fullPath) !== selfPath) {
      found.push(fullPath);
    }
  }

  return found;
}

const sourceFiles = collectSourceFiles(searchRoots[0]).concat(collectSourceFiles(searchRoots[1]));

test("the source is actually being scanned", () => {
  // Without this, every test below would pass by finding nothing at all — a
  // broken walk would read as a clean bill of health.
  assert.ok(sourceFiles.length > 40, `expected to scan the source, found ${sourceFiles.length} files`);
});

test("nothing reads a paid provider's API key", () => {
  // Reading one of these is the moment the app stops being free to run.
  const forbidden = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "COHERE_API_KEY",
    "MISTRAL_API_KEY",
    "GROQ_API_KEY",
    "TOGETHER_API_KEY",
    "REPLICATE_API_TOKEN",
    "PERPLEXITY_API_KEY",
    "AZURE_OPENAI_KEY",
    "HUGGINGFACEHUB_API_TOKEN"
  ];

  const offenders: string[] = [];
  for (const file of sourceFiles) {
    const contents = readFileSync(file, "utf8");
    for (const name of forbidden) {
      if (contents.includes(name)) {
        offenders.push(`${path.relative(repoRoot, file)} references ${name}`);
      }
    }
  }

  assert.deepEqual(offenders, [], `the app must run without a paid account:\n${offenders.join("\n")}`);
});

test("no hosted model provider is a dependency", () => {
  const forbiddenPackages = [
    "@anthropic-ai/sdk",
    "openai",
    "@google/generative-ai",
    "@google-cloud/aiplatform",
    "cohere-ai",
    "@mistralai/mistralai",
    "groq-sdk",
    "replicate",
    "together-ai",
    "@azure/openai"
  ];

  const manifests = [
    path.join(repoRoot, "package.json"),
    path.join(repoRoot, "apps", "api", "package.json"),
    path.join(repoRoot, "apps", "web", "package.json"),
    path.join(repoRoot, "apps", "desktop", "package.json")
  ];

  const offenders: string[] = [];
  for (const manifest of manifests) {
    let parsed: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    try {
      parsed = JSON.parse(readFileSync(manifest, "utf8"));
    } catch {
      continue;
    }

    const declared = { ...parsed.dependencies, ...parsed.devDependencies };
    for (const name of forbiddenPackages) {
      if (name in declared) {
        offenders.push(`${path.relative(repoRoot, manifest)} depends on ${name}`);
      }
    }
  }

  assert.deepEqual(offenders, [], `no hosted provider may be required:\n${offenders.join("\n")}`);
});

test("the assistant only ever talks to this machine", () => {
  // The one place a hosted endpoint would realistically be introduced. Its
  // base URL must stay a loopback address.
  const localModel = readFileSync(
    path.join(repoRoot, "apps", "api", "src", "services", "localModel.ts"),
    "utf8"
  );

  const urls = localModel.match(/https?:\/\/[a-zA-Z0-9._:%-]+/g) ?? [];
  const remote = urls.filter((url) => !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(url));

  assert.deepEqual(remote, [], `the model client must stay local, found: ${remote.join(", ")}`);
});
