import test from "node:test";
import assert from "node:assert/strict";
import { planProject } from "../src/projectPlan.js";
import {
  buildClarifyingQuestion,
  clarifyBuildPrefix,
  findSpecGaps,
  isAwaitingRefinement,
  mergeRefinement
} from "../src/specRefinement.js";

test("flags a request with no identifiable record type", () => {
  const gaps = findSpecGaps(planProject("Build a CRM"));

  assert.ok(gaps.includes("entity"));
});

test("flags a request that names records but nothing to store", () => {
  const gaps = findSpecGaps(planProject("Build a customer tracker"));

  assert.ok(!gaps.includes("entity"));
  assert.ok(gaps.includes("fields"));
});

test("a request with fields is actionable", () => {
  const gaps = findSpecGaps(planProject("Build a customer tracker with email and phone"));

  assert.deepEqual(gaps, []);
});

test("a request with only features is actionable", () => {
  // Status and a board are enough to build something meaningful.
  const gaps = findSpecGaps(planProject("Build a task tracker with a kanban board"));

  assert.deepEqual(gaps, []);
});

test("the question names what is missing and gives a usable example", () => {
  const spec = planProject("Build a CRM");
  const question = buildClarifyingQuestion(spec, findSpecGaps(spec));

  assert.ok(question.startsWith(clarifyBuildPrefix));
  assert.match(question, /what are the records/i);
  assert.match(question, /for example/i);
});

test("the question for a known entity asks about its fields, not its identity", () => {
  const spec = planProject("Build a customer tracker");
  const question = buildClarifyingQuestion(spec, findSpecGaps(spec));

  assert.match(question, /customer tracker/i);
  assert.doesNotMatch(question, /couldn't tell what this should keep track of/i);
});

test("recognizes its own clarification when it comes back", () => {
  const spec = planProject("Build a CRM");
  const question = buildClarifyingQuestion(spec, findSpecGaps(spec));

  assert.equal(isAwaitingRefinement(question), true);
  assert.equal(isAwaitingRefinement("Here is a plan:"), false);
  assert.equal(isAwaitingRefinement(undefined), false);
});

test("merging keeps detail from both turns", () => {
  const merged = mergeRefinement("Build a CRM with a dashboard", "customers with email and phone");

  assert.match(merged, /CRM/);
  assert.match(merged, /dashboard/);
  assert.match(merged, /email and phone/);
});

test("the merged text plans the app the user actually described", () => {
  const merged = mergeRefinement("Build a CRM with a dashboard", "customers with email, phone and company");
  const spec = planProject(merged);

  assert.equal(spec.entities[0].name, "customer");
  const names = spec.entities[0].fields.map((field) => field.name);
  assert.ok(names.includes("email"));
  assert.ok(names.includes("company"));
  assert.ok(spec.features.includes("dashboard"));
});

test("merging tolerates an empty side", () => {
  assert.equal(mergeRefinement("Build a CRM", ""), "Build a CRM");
  assert.equal(mergeRefinement("", "customers with email"), "customers with email");
});
