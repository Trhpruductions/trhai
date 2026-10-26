import test from "node:test";
import assert from "node:assert/strict";
import { compareVersions, isRequiredReleaseText, releaseNotes, releasePageText, requiredUpdateLine, type ReleaseNote } from "../src/releaseNotes.js";

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

test("a required release's page carries the one fixed line, under the title, and an ordinary one does not", () => {
  const text = releasePageText("2.3.4", {}, [{ ...note, required: true }]);
  assert.ok(text);
  const lines = text.split("\n");
  assert.equal(lines[0], "A title for people");
  assert.equal(lines[1], "");
  assert.equal(lines[2], requiredUpdateLine);
  assert.equal(lines[3], "");
  assert.equal(isRequiredReleaseText(text), true);
  assert.equal(isRequiredReleaseText(releasePageText("2.3.4", {}, [note]) ?? ""), false);
  // A release candidate is a pre-release that no installed copy is offered, so it does not promise the download.
  const candidate = releasePageText("2.3.4", { candidate: true }, [{ ...note, required: true }]) ?? "";
  assert.equal(isRequiredReleaseText(candidate), false);
  assert.match(candidate, /release candidate/i);
});

test("the line is found on a line of its own, whatever the line ends, and nowhere else", () => {
  assert.equal(isRequiredReleaseText(`Title\r\n\r\n${requiredUpdateLine}\r\n- A change`), true);
  assert.equal(isRequiredReleaseText(`  ${requiredUpdateLine}  `), true);
  assert.equal(isRequiredReleaseText(`- ${requiredUpdateLine}`), false, "a bullet that quotes it is not it");
  assert.equal(isRequiredReleaseText("This is a required update for everyone."), false);
  assert.equal(isRequiredReleaseText(requiredUpdateLine.toLowerCase()), false);
  assert.equal(isRequiredReleaseText(requiredUpdateLine.slice(0, -1)), false);
  assert.equal(isRequiredReleaseText(""), false);
});

test("no note is required until its version is one that a copy can be forced to, or its page would promise what the copy will not do", () => {
  for (const entry of releaseNotes) {
    // 0.1.8 is the first version that reads the line; a copy on 0.1.7 or before ignores it.
    if (compareVersions(entry.version, "0.1.8") <= 0) assert.notEqual(entry.required, true, entry.version);
  }
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
