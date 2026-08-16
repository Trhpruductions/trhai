import test from "node:test";
import assert from "node:assert/strict";
import { buildTaskPlan, detectTaskType, extractSubject } from "../src/services/taskPlanning.js";

test("extracts the subject phrase as the user wrote it", () => {
  assert.equal(extractSubject("Build a revenue reporting dashboard"), "the revenue reporting dashboard");
  assert.equal(extractSubject("Fix the flaky checkout integration test"), "the flaky checkout integration test");
});

test("strips request framing before the subject", () => {
  assert.equal(extractSubject("I need a revenue dashboard"), "the revenue dashboard");
  assert.equal(extractSubject("Can you build the staging environment"), "the staging environment");
  assert.equal(extractSubject("Help me write the onboarding guide"), "the onboarding guide");
  assert.equal(extractSubject("Let's design the checkout flow"), "the checkout flow");
});

test("drops a dangling particle after a phrasal verb", () => {
  assert.equal(extractSubject("Set up the deployment pipeline"), "the deployment pipeline");
});

test("drops the pronoun naming who the work is for", () => {
  // "Build me a task tracker" is about the tracker, not about me. Leaving the
  // pronoun in produced "what done looks like for me a task tracker".
  assert.equal(extractSubject("Build me a task tracker"), "the task tracker");
  assert.equal(extractSubject("Show me the logs"), "the logs");
  assert.equal(extractSubject("Make us a landing page"), "the landing page");
});

test("a long request is cut at a clause boundary, not mid-phrase", () => {
  // The regression: a hard 12-word slice ended the subject on "have a", so the
  // step read "...for me a task tracker where projects have many tasks, tasks
  // have a, and the smallest version that delivers it."
  const subject = extractSubject(
    "Build me a task tracker where projects have many tasks, tasks have a title, status and due date"
  );

  assert.equal(subject, "the task tracker where projects have many tasks");
});

test("a subject never ends on a word that leaves it hanging", () => {
  const danglers = /\b(a|an|the|and|or|with|of|to|that|where|have|has|is|are|for|in|on)$/i;

  for (const request of [
    "Build me a task tracker where projects have many tasks, tasks have a title, status and due date",
    "Create a reporting service that aggregates revenue by region and by product and by month for the",
    "Design a settings page with tabs for profile, billing, notifications and the"
  ]) {
    const subject = extractSubject(request);
    assert.doesNotMatch(subject, danglers, `subject ends on a dangling word: "${subject}"`);
    assert.doesNotMatch(subject, /,$/, `subject ends on a comma: "${subject}"`);
  }
});

test("the plan step reads as a whole sentence", () => {
  const plan = buildTaskPlan(
    "Build me a task tracker where projects have many tasks, tasks have a title, status and due date",
    "general"
  );

  assert.equal(
    plan.steps[0],
    "Write down what done looks like for the task tracker where projects have many tasks, and the smallest version that delivers it."
  );
  assert.doesNotMatch(plan.steps[0], /\bfor me a\b/);
});

test("keeps the original wording rather than stemmed tokens", () => {
  const subject = extractSubject("Build a revenue reporting dashboard");

  assert.match(subject, /reporting/);
  assert.doesNotMatch(subject, /report,/);
});

test("returns an empty subject for an empty request", () => {
  assert.equal(extractSubject(""), "");
  assert.equal(extractSubject("   "), "");
});

test("classifies the kind of work", () => {
  assert.equal(detectTaskType("Fix the flaky checkout test"), "fix");
  assert.equal(detectTaskType("Migrate the database off MySQL"), "migrate");
  assert.equal(detectTaskType("Integrate the Stripe webhook"), "integrate");
  assert.equal(detectTaskType("Deploy the new release"), "deploy");
  assert.equal(detectTaskType("Write the runbook documentation"), "document");
  assert.equal(detectTaskType("Compare Postgres and MySQL for our workload"), "analyze");
  assert.equal(detectTaskType("Build a revenue dashboard"), "create");
  assert.equal(detectTaskType("Sort out the thing"), "generic");
});

test("a fix plan starts by reproducing, not by designing", () => {
  const plan = buildTaskPlan("Fix the flaky checkout integration test", "debug");

  assert.equal(plan.taskType, "fix");
  assert.match(plan.steps[0], /Reproduce the flaky checkout integration test/);
  assert.ok(plan.steps.some((step) => /regression test/i.test(step)));
  // A fix must not open with greenfield design steps.
  assert.ok(!plan.steps.some((step) => /data shape and interface/i.test(step)));
});

test("a migration plan insists on side-by-side and rollback", () => {
  const plan = buildTaskPlan("Migrate the reporting service off MySQL", "code");

  assert.equal(plan.taskType, "migrate");
  assert.ok(plan.steps.some((step) => /side by side/i.test(step)));
  assert.ok(plan.steps.some((step) => /rollback/i.test(step)));
});

test("different task types produce different plans", () => {
  const fix = buildTaskPlan("Fix the broken checkout", "code").steps.join("|");
  const create = buildTaskPlan("Build the checkout page", "code").steps.join("|");
  const deploy = buildTaskPlan("Deploy the checkout service", "code").steps.join("|");

  assert.notEqual(fix, create);
  assert.notEqual(create, deploy);
  assert.notEqual(fix, deploy);
});

test("business and creator modes shape a create plan differently", () => {
  // Subjects deliberately free of deploy/design keywords, which would otherwise
  // classify the task before mode ever gets a say.
  const business = buildTaskPlan("Build a pricing page", "business");
  const creator = buildTaskPlan("Build a brand story", "creator");

  assert.equal(business.taskType, "create");
  assert.equal(creator.taskType, "create");
  assert.ok(business.steps.some((step) => /metric that proves it/i.test(step)));
  assert.ok(creator.steps.some((step) => /creative direction/i.test(step)));
});

test("task type takes precedence over mode", () => {
  // "rollout" is deploy work even in business mode; the domain flavour of a
  // create plan must not override what the task actually is.
  const plan = buildTaskPlan("Build a pricing rollout", "business");

  assert.equal(plan.taskType, "deploy");
  assert.ok(plan.steps.some((step) => /rollback/i.test(step)));
});

test("every step references the real subject or gives concrete guidance", () => {
  const plan = buildTaskPlan("Build a revenue reporting dashboard", "code");

  assert.match(plan.steps[0], /the revenue reporting dashboard/);
  // No stemmed keyword soup anywhere in the plan.
  assert.ok(!plan.steps.some((step) => /revenue, report,/.test(step)));
});

test("falls back gracefully when there is no usable subject", () => {
  const plan = buildTaskPlan("Build", "code");

  assert.ok(plan.steps.length > 0);
  assert.ok(plan.steps.every((step) => step.trim().length > 0));
  assert.doesNotMatch(plan.steps[0], /\s{2,}/);
});
