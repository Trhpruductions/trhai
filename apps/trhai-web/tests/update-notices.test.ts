import test from "node:test";
import assert from "node:assert/strict";
import { dismissUpdate, markVersionSeen, noticeToShow, readDismissedUpdate, readSeenVersion, type UpdateCheck } from "../src/lib/updates.js";

// Which notice everyone using the app sees, and when it stops showing.

const note = (version: string) => ({ version, date: "2026-10-13", title: `v${version}`, notes: ["Something changed."] });
const latest = (version: string) => ({ version, url: `https://example.com/v${version}`, downloadUrl: null, publishedAt: null, notes: "" });

function check(overrides: Partial<UpdateCheck> = {}): UpdateCheck {
  return {
    currentVersion: "0.1.5", notes: [note("0.1.5"), note("0.1.4")], latest: null, updateAvailable: false,
    checkedAt: null, checkError: null, checkDisabled: false, ...overrides
  };
}

function memoryStore() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

test("a version not yet seen in this browser shows its What's new, once", () => {
  const shown = noticeToShow(check(), null, null);
  assert.equal(shown?.kind, "whatsnew");
  assert.equal(shown?.kind === "whatsnew" && shown.note.version, "0.1.5");
  assert.equal(noticeToShow(check(), "0.1.5", null), null, "seen: nothing");
  assert.equal(noticeToShow(check(), "0.1.4", null)?.kind, "whatsnew", "updated from an older version: shown");
});

test("no notes for exactly this version means no What's new, rather than an older version's", () => {
  assert.equal(noticeToShow(check({ currentVersion: "0.1.6" }), null, null), null);
});

test("a newer release shows the update card until that release is dismissed; the next release shows again", () => {
  const available = check({ updateAvailable: true, latest: latest("0.1.6") });
  assert.equal(noticeToShow(available, "0.1.5", null)?.kind, "update");
  assert.equal(noticeToShow(available, "0.1.5", "0.1.6"), null);
  const later = check({ updateAvailable: true, latest: latest("0.1.7") });
  assert.equal(noticeToShow(later, "0.1.5", "0.1.6")?.kind, "update");
});

test("What's new comes before the update card when both apply", () => {
  const both = check({ updateAvailable: true, latest: latest("0.1.6") });
  assert.equal(noticeToShow(both, null, null)?.kind, "whatsnew");
  assert.equal(noticeToShow(both, "0.1.5", null)?.kind, "update");
});

test("no answer from the service shows nothing", () => {
  assert.equal(noticeToShow(null, null, null), null);
});

test("what was seen and dismissed is remembered, and a store that throws does not break anything", () => {
  const store = memoryStore();
  markVersionSeen(store, "0.1.5");
  dismissUpdate(store, "0.1.6");
  assert.equal(readSeenVersion(store), "0.1.5");
  assert.equal(readDismissedUpdate(store), "0.1.6");
  const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  assert.equal(readSeenVersion(broken), null);
  assert.doesNotThrow(() => markVersionSeen(broken, "0.1.5"));
});
