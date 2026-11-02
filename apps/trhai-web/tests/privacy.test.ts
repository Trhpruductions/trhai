import test from "node:test";
import assert from "node:assert/strict";
import { legalFacts, legalVersions } from "@ascend/shared";
import { describeErasure, registrationConsentBody, registrationTicks, tickWording, type HeldCounts } from "../src/lib/privacy.js";

// The rules the sign-up form and the privacy screen share: which boxes there are, what a
// registration agrees to, and how an erasure is described before it is confirmed.

test("a registration form has a box for the Terms and one for the Privacy Policy, and one for the age once a minimum is set", () => {
  assert.deepEqual(registrationTicks(), ["terms", "privacy"]);
  legalFacts.minimumAge = 16;
  try {
    assert.deepEqual(registrationTicks(), ["terms", "privacy", "age"]);
    assert.equal(tickWording("age").before, "I am at least 16 years old.");
  } finally {
    legalFacts.minimumAge = null;
  }
});

test("each box says one thing, and the two texts are named so they can be opened", () => {
  assert.deepEqual(tickWording("terms"), { before: "I have read and agree to the ", link: "terms", after: "." });
  assert.equal(tickWording("privacy").link, "privacy");
  assert.match(tickWording("privacy").after, /what leaves this PC/);
  assert.equal(tickWording("age").link, null);
});

test("nothing is agreed to until every box that is shown is ticked, and then the texts are named by version", () => {
  assert.equal(registrationConsentBody({}), null);
  assert.equal(registrationConsentBody({ terms: true }), null);
  assert.equal(registrationConsentBody({ privacy: true }), null);
  assert.equal(registrationConsentBody({ terms: true, privacy: false }), null);
  assert.deepEqual(registrationConsentBody({ terms: true, privacy: true }), { terms: legalVersions.terms, privacy: legalVersions.privacy });
  assert.deepEqual(registrationConsentBody({ terms: true, privacy: true, age: true }), { terms: legalVersions.terms, privacy: legalVersions.privacy },
    "an age box that is not shown is not asked for");
  legalFacts.minimumAge = 18;
  try {
    assert.equal(registrationConsentBody({ terms: true, privacy: true }), null, "the age box is shown now, so it is needed");
    assert.deepEqual(registrationConsentBody({ terms: true, privacy: true, age: true }), { terms: legalVersions.terms, privacy: legalVersions.privacy, age: true });
  } finally {
    legalFacts.minimumAge = null;
  }
});

const held: HeldCounts = {
  conversations: 1, memories: 12, documents: 0, todos: 3, finishedWork: 40,
  thisCopy: { schedules: 2, automationFlow: true, emailAccount: true, license: true }
};

test("an erasure is described with the real numbers of what it would remove, and only what was ticked", () => {
  assert.deepEqual(describeErasure(held, { ownData: true, wholeCopy: false, license: false, account: false }), [
    "1 conversation, 12 memories, 0 documents, 3 to-dos and 40 finished tasks kept for you"
  ]);
  assert.deepEqual(describeErasure(held, { ownData: false, wholeCopy: true, license: true, account: true }), [
    "2 schedules, the automation flow, the preferences, the saved email account and its password",
    "the license key on this PC",
    "your account: the email address, name, password, recovery codes and every sign-in"
  ]);
  assert.deepEqual(describeErasure(held, { ownData: false, wholeCopy: false, license: false, account: false }), []);
});

test("without counts an erasure is still described, and parts that do not exist are not claimed", () => {
  assert.deepEqual(describeErasure(null, { ownData: true, wholeCopy: true, license: false, account: false }), [
    "the conversations, memories, documents, to-dos and finished tasks kept for you",
    "the schedules, the automation flow, the preferences and the saved email account"
  ]);
  const bare: HeldCounts = { ...held, thisCopy: { schedules: 1, automationFlow: false, emailAccount: false, license: false } };
  assert.deepEqual(describeErasure(bare, { ownData: false, wholeCopy: true, license: false, account: false }), [
    "1 schedule, the preferences"
  ]);
});
