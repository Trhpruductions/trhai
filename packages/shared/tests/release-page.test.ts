import test from "node:test";
import assert from "node:assert/strict";
import { releaseNotes, releasePageText, type ReleaseNote } from "../src/releaseNotes.js";

const note: ReleaseNote = {
  version: "2.3.4",
  date: "2026-01-02",
  title: "A title for people",
  notes: ["The first change.", "The second change."]
};

test("the release page is the version's own note, with the files named after it", () => {
  const text = releasePageText("2.3.4", {}, [note]);
  assert.ok(text);
  assert.equal(text.split("\n")[0], "A title for people");
  assert.match(text, /^- The first change\.$/m);
  assert.match(text, /^- The second change\.$/m);
  assert.match(text, /TRH-AI-Setup-2\.3\.4\.exe/);
  assert.match(text, /TRH-AI-Portable-2\.3\.4\.exe/);
  assert.match(text, /SHA256SUMS\.txt/);
  assert.doesNotMatch(text, /release candidate/i);
});

test("a release candidate says so", () => {
  assert.match(releasePageText("2.3.4", { candidate: true }, [note]) ?? "", /release candidate/i);
});

test("a version without a note has no page, so the workflow will not publish it", () => {
  assert.equal(releasePageText("2.3.5", {}, [note]), null);
  assert.equal(releasePageText("2.3", {}, [note]), null);
});

// The installed app shows the page as plain text and keeps 4,000 characters.
test("every version's page reads as plain text and fits what the app shows", () => {
  for (const entry of releaseNotes) {
    const text = releasePageText(entry.version, { candidate: true });
    assert.ok(text, entry.version);
    assert.ok(text.length <= 4000, `${entry.version}: ${text.length} characters`);
    assert.doesNotMatch(text, /\*\*|`|#\d|https?:\/\//, entry.version);
  }
});
