import test from "node:test";
import assert from "node:assert/strict";
import { filterSections, isSectionId, sections } from "../src/lib/settings.js";

// The Settings app's sections and search.

test("every section has a summary, and an id the address can carry", () => {
  for (const section of sections) {
    assert.match(section.summary, /\.$/);
    assert.equal(isSectionId(section.id), true);
  }
  assert.equal(isSectionId("nonsense"), false);
});

test("a search finds a setting by what people call it, not only by its section's name", () => {
  assert.deepEqual(filterSections("encrypted").map((section) => section.id), ["data"]);
  assert.deepEqual(filterSections("smtp").map((section) => section.id), ["messaging"]);
  assert.deepEqual(filterSections("colour").map((section) => section.id), ["assistant"]);
  assert.deepEqual(filterSections("license key").map((section) => section.id), ["billing"]);
  assert.deepEqual(filterSections("buy").map((section) => section.id), ["billing"]);
  assert.deepEqual(filterSections("release notes").map((section) => section.id), ["updates"]);
  assert.equal(filterSections("").length, sections.length);
  assert.deepEqual(filterSections("nothing like this"), []);
});
