// Emits a generated project to disk so its output can be run and inspected.
// Usage: npx tsx scripts/generate-sample-project.ts "<request>" <output-dir>
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { planProject } from "../packages/shared/src/projectPlan.js";
import { generateProject } from "../packages/shared/src/projectGenerator.js";

const request = process.argv[2] ?? "Build a minimal incident response tracker with role controls and event timeline";
const outDir = process.argv[3] ?? path.join(process.cwd(), "generated-projects", "sample");

const spec = planProject(request);
console.log("request  :", request);
console.log("entities :", spec.entities.map((entity) => entity.name).join(", "));
console.log("features :", spec.features.join(", ") || "(none)");
console.log("fields   :", spec.entities[0].fields.map((field) => `${field.name}:${field.type}`).join(", "));

for (const file of generateProject(spec)) {
  const full = path.join(outDir, file.path);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, file.content, "utf8");
  console.log("wrote    :", file.path);
}

console.log("output   :", outDir);
