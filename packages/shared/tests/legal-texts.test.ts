import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalTextOf, consentDocuments, isLegalDocId, legalDocIds, legalDocument, legalDocuments, legalFacts, legalShortTitle, legalTextsReady,
  legalToMarkdown, legalVersions, openLegalItems, type LegalDocId, type LegalFacts
} from "../src/index.js";

// The texts as a whole: that each one's version is honest, that nothing in them is a
// template gone wrong, that every open item is a fact the owner has not supplied and
// nothing else, and that the copies for the website match.

/**
 * The words of each text that a person can agree to, fingerprinted. When a text changes,
 * this fails on purpose: change the words, then raise its date in legalVersions (people who
 * agreed to the old words are asked to read the new ones), then put the new fingerprint here.
 * A fact the owner supplies changes the words too, and so is the same kind of change.
 */
const fingerprints: Record<string, string> = {
  "privacy@2026-11-05": "9459bd183d4f414e",
  "terms@2026-11-05": "2b04e7d31fb00bd2",
  "refunds@2026-11-05": "87a80f6f084661e0",
  "storage@2026-11-02": "7271483490607e74",
  "ai@2026-11-01": "3704b3d9ee920e55"
};

const fingerprint = (id: LegalDocId) => createHash("sha256").update(canonicalTextOf(legalDocument(id))).digest("hex").slice(0, 16);

test("a text a person can agree to keeps its version until its words change, and then the version changes with them", () => {
  for (const [key, version] of Object.entries(legalVersions)) {
    const id = key as LegalDocId;
    const doc = legalDocument(id);
    assert.equal(doc.version, version, `${id} carries the version legalVersions names`);
    assert.equal(
      fingerprint(id), fingerprints[`${id}@${version}`],
      `${id}'s words changed but its version (${version}) did not. Raise legalVersions.${id} to today's date and record the new fingerprint ${fingerprint(id)} in this test.`
    );
  }
  for (const doc of legalDocuments()) {
    if (!(doc.id in legalVersions)) assert.equal(doc.version, null, `${doc.id} only informs, so it has no version to agree to`);
  }
  for (const id of consentDocuments) assert.ok(id in legalVersions, `${id} is agreed to at sign-up, so it is versioned`);
});

test("no text has a template's leftovers in it", () => {
  for (const doc of legalDocuments()) {
    const text = JSON.stringify(doc);
    // A text that only informs has `version: null`, which is right; anything else null in a text is a fact gone missing.
    assert.doesNotMatch(text.replace(/"version":null/g, ""), /\$\{|undefined|\[object|NaN|null/, `${doc.id} reads cleanly`);
    assert.doesNotMatch(text, /TODO|FIXME|lorem ipsum/i, `${doc.id} has no placeholder text`);
    assert.ok(doc.sections.length >= 4, `${doc.id} has its sections`);
    for (const section of doc.sections) assert.ok(section.blocks.length > 0, `${doc.id}/${section.id} is not empty`);
  }
});

test("every link between texts points at a text that exists, and every text has a short title", () => {
  for (const doc of legalDocuments()) {
    for (const match of JSON.stringify(doc).matchAll(/#legal-([a-z]+)/g)) assert.ok(isLegalDocId(match[1]), `${doc.id} links to ${match[1]}`);
  }
  for (const id of legalDocIds) assert.ok(legalShortTitle(id).length > 3);
});

test("the open items are exactly the facts the owner has not supplied, and supplying them all closes the list", () => {
  const open = openLegalItems();
  assert.ok(open.length > 0, "the facts are not all supplied yet");
  assert.ok(open.includes("minimum age"));
  assert.ok(open.includes("legal entity name"));
  assert.ok(open.includes("the law that governs these terms"));
  assert.equal(legalTextsReady(), false);

  const supplied: LegalFacts = {
    ...legalFacts,
    legalEntityName: "Example Co",
    registrationNumber: "No registration: a sole trader",
    postalAddress: "1 Example Street, Example Town",
    jurisdiction: "Utah, United States",
    website: "https://example.com",
    supportEmail: "help@example.com",
    privacyEmail: "privacy@example.com",
    businessEmail: "hello@example.com",
    governingLaw: "the laws of the State of Utah",
    disputeVenue: "the courts of Utah",
    minimumAge: 18,
    keyRecordRetentionYears: 7
  };
  assert.deepEqual(openLegalItems(supplied), [], "every open item was a fact");
  assert.equal(legalTextsReady(supplied), false, "supplied is not the same as reviewed");
  assert.equal(legalTextsReady({ ...supplied, status: "reviewed" }), true);
  assert.equal(legalTextsReady({ ...legalFacts, status: "reviewed" }), false, "reviewed with gaps is still not ready");
  const terms = JSON.stringify(legalDocument("terms", supplied));
  assert.match(terms, /at least 18 years old/);
  assert.match(terms, /laws of the State of Utah/);
  assert.match(JSON.stringify(legalDocument("refunds", supplied)), /help@example.com/);
});

test("the texts say TRH AI is free, and none still describes buying it", () => {
  // The owner's decision of 2026-11-05. If the paywall comes back (paidEdition in the API's
  // licenseConfig.ts), this fails until the texts have been written for it again.
  for (const doc of legalDocuments()) {
    const words = canonicalTextOf(doc);
    for (const sold of [/checkout page/i, /buy a license/i, /payment provider/i, /free trial of 14/i, /price paid/i, /refund window/i, /seats/i, /paid product/i]) {
      assert.doesNotMatch(words, sold, doc.id);
    }
  }
  assert.match(canonicalTextOf(legalDocument("terms")), /TRH AI is free\.\*\* There is no trial that ends, no license to buy and nothing to pay/);
  assert.match(canonicalTextOf(legalDocument("refunds")), /so there is nothing to refund/);
  assert.match(canonicalTextOf(legalDocument("business")), /TRH AI is free: TRH Development charges nothing for it/);
  // And the owner is no longer asked for facts about selling it.
  assert.deepEqual(openLegalItems().filter((item) => /payment|refund|provider/i.test(item)), []);
});

test("the notice that answers are not professional advice stays where it binds", () => {
  assert.match(canonicalTextOf(legalDocument("terms")), /not professional advice/);
  assert.match(canonicalTextOf(legalDocument("ai")), /medical, legal, financial, tax, safety or other professional advice/);
});

test("the copies for the website under docs/legal match the texts", () => {
  const folder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "docs", "legal");
  const draft = !legalTextsReady();
  for (const doc of legalDocuments()) {
    const file = path.join(folder, `${doc.id}.md`);
    assert.ok(existsSync(file), `${file} exists - run node scripts/legal/export-legal.mjs`);
    const expected = legalToMarkdown(doc, { showReviewNotes: draft, link: (id) => `${id}.md` });
    assert.equal(readFileSync(file, "utf8").replace(/\r\n/g, "\n"), expected, `docs/legal/${doc.id}.md is stale - rebuild @ascend/shared and run node scripts/legal/export-legal.mjs`);
    assert.ok(existsSync(path.join(folder, `${doc.id}.html`)), `the page for ${doc.id} exists`);
  }
});
