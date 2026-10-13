import test from "node:test";
import assert from "node:assert/strict";
import { compareVersions, notesUpTo, releaseNotes } from "@ascend/shared";
import { checkForUpdates, parseRelease, resetUpdatesForTests } from "../src/services/updates.js";

process.env.TRHAI_VERSION = "0.1.4";
delete process.env.TRHAI_UPDATE_CHECK;

const release = (version: string, extra: Record<string, unknown> = {}) => ({
  tag_name: `v${version}`,
  html_url: `https://github.com/Trhpruductions/trhai/releases/tag/v${version}`,
  published_at: "2026-10-20T12:00:00Z",
  body: "Fixes and improvements.",
  assets: [
    { name: `TRH-AI-Portable-${version}.exe`, browser_download_url: `https://github.com/x/TRH-AI-Portable-${version}.exe` },
    { name: `TRH-AI-Setup-${version}.exe`, browser_download_url: `https://github.com/x/TRH-AI-Setup-${version}.exe` }
  ],
  ...extra
});

function fetcherAnswering(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
}

test("versions compare numerically, not as text", () => {
  assert.ok(compareVersions("0.1.10", "0.1.9") > 0);
  assert.ok(compareVersions("v0.2.0", "0.1.99") > 0);
  assert.equal(compareVersions("1.0", "1.0.0"), 0);
  assert.ok(compareVersions("0.1.4", "0.1.5") < 0);
});

test("the notes shown are for the running version and older ones, newest first", () => {
  const notes = notesUpTo("0.1.4", 5, releaseNotes);
  assert.ok(notes.length >= 1);
  assert.equal(notes[0].version, "0.1.4");
  assert.ok(notes.every((note) => compareVersions(note.version, "0.1.4") <= 0));
  assert.equal(notesUpTo("0.0.1", 5, releaseNotes).length, 0, "an older build has no notes it has not earned");
});

test("every release note has a version, a date and at least one sentence", () => {
  for (const note of releaseNotes) {
    assert.match(note.version, /^\d+\.\d+\.\d+$/);
    assert.match(note.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(note.title.length > 0);
    assert.ok(note.notes.length > 0);
  }
});

test("a GitHub release is read into the installer link and its notes; drafts and junk are not", () => {
  const parsed = parseRelease(release("0.1.5"));
  assert.ok(parsed);
  assert.equal(parsed.version, "0.1.5");
  assert.equal(parsed.downloadUrl, "https://github.com/x/TRH-AI-Setup-0.1.5.exe", "the Setup build, not the portable one");
  assert.equal(parsed.notes, "Fixes and improvements.");
  assert.equal(parseRelease(release("0.1.5", { draft: true })), null);
  assert.equal(parseRelease(release("0.1.5", { html_url: "javascript:alert(1)" })), null);
  assert.equal(parseRelease({ tag_name: "nightly" }), null);
  assert.equal(parseRelease(null), null);
  assert.equal(parseRelease(release("0.1.5", { assets: [{ name: "x.exe", browser_download_url: "ftp://bad" }] }))?.downloadUrl, null);
});

test("a newer release means an update is available; the same or older does not", async () => {
  resetUpdatesForTests();
  const newer = await checkForUpdates({ fetcher: fetcherAnswering(200, release("0.1.5")) });
  assert.equal(newer.currentVersion, "0.1.4");
  assert.equal(newer.updateAvailable, true);
  assert.equal(newer.latest?.version, "0.1.5");
  assert.equal(newer.checkError, null);

  resetUpdatesForTests();
  const same = await checkForUpdates({ fetcher: fetcherAnswering(200, release("0.1.4")) });
  assert.equal(same.updateAvailable, false);
  resetUpdatesForTests();
  const older = await checkForUpdates({ fetcher: fetcherAnswering(200, release("0.1.3")) });
  assert.equal(older.updateAvailable, false);
});

test("the answer is cached for hours, and refresh asks again", async () => {
  resetUpdatesForTests();
  let calls = 0;
  const counting: typeof fetch = (async () => { calls += 1; return new Response(JSON.stringify(release("0.1.5")), { status: 200 }); }) as unknown as typeof fetch;
  await checkForUpdates({ fetcher: counting });
  await checkForUpdates({ fetcher: counting });
  assert.equal(calls, 1);
  await checkForUpdates({ fetcher: counting, refresh: true });
  assert.equal(calls, 2);
  await checkForUpdates({ fetcher: counting, now: new Date(Date.now() + 7 * 60 * 60 * 1000) });
  assert.equal(calls, 3, "after six hours it checks again on its own");
});

test("a feed that fails or is missing is reported in a sentence, and the notes still show", async () => {
  resetUpdatesForTests();
  const missing = await checkForUpdates({ fetcher: fetcherAnswering(404, { message: "Not Found" }) });
  assert.equal(missing.updateAvailable, false);
  assert.match(missing.checkError ?? "", /No release/);
  assert.ok(missing.notes.length >= 1);

  resetUpdatesForTests();
  const down: typeof fetch = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
  const unreachable = await checkForUpdates({ fetcher: down });
  assert.match(unreachable.checkError ?? "", /could not be reached/);

  resetUpdatesForTests();
  process.env.TRHAI_UPDATE_CHECK = "off";
  const off = await checkForUpdates({ fetcher: fetcherAnswering(200, release("9.9.9")) });
  assert.equal(off.checkDisabled, true);
  assert.equal(off.updateAvailable, false);
  assert.equal(off.latest, null);
  delete process.env.TRHAI_UPDATE_CHECK;
});
