import test from "node:test";
import assert from "node:assert/strict";
import {
  clearInstallTried, dismissUpdate, installTriedKey, markInstallTried, markVersionSeen, noticeToShow, readDismissedUpdate,
  readInstallTried, readSeenVersion, requiredUpdate, type UpdateCheck
} from "../src/lib/updates.js";

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

test("a required release is not put off: it shows although 'Later' was pressed for it", () => {
  const required = check({ updateAvailable: true, latest: { ...latest("0.1.6"), required: true } });
  assert.equal(noticeToShow(required, "0.1.5", null)?.kind, "update");
  assert.equal(noticeToShow(required, "0.1.5", "0.1.6")?.kind, "update");
  // An ordinary one, and one a service says is not required, can be put off.
  assert.equal(noticeToShow(check({ updateAvailable: true, latest: latest("0.1.6") }), "0.1.5", "0.1.6"), null);
  assert.equal(noticeToShow(check({ updateAvailable: true, latest: { ...latest("0.1.6"), required: false } }), "0.1.5", "0.1.6"), null);
});

test("the release every copy has to move to is the latest, when it is newer than this copy and marked required", () => {
  assert.equal(requiredUpdate(null), null);
  assert.equal(requiredUpdate(check({ updateAvailable: true, latest: latest("0.1.6") })), null);
  const marked = { ...latest("0.1.6"), required: true };
  assert.equal(requiredUpdate(check({ updateAvailable: true, latest: marked }))?.version, "0.1.6");
  assert.equal(requiredUpdate(check({ updateAvailable: false, latest: marked })), null, "not newer than this copy: nothing to move to");
  assert.equal(requiredUpdate(check({ updateAvailable: true, latest: null })), null);
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

test("the restart that was asked for is noted, can be cleared, and a store that throws does not break anything", () => {
  const values = new Map<string, string>();
  const store = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); }
  };
  assert.equal(readInstallTried(store), null, "nothing tried yet");
  markInstallTried(store, "0.1.9");
  assert.equal(readInstallTried(store), "0.1.9");
  assert.equal(values.get(installTriedKey), "0.1.9", "kept under its own key, apart from What's new and Later");
  assert.equal(readSeenVersion(store), null);
  assert.equal(readDismissedUpdate(store), null);
  clearInstallTried(store);
  assert.equal(readInstallTried(store), null, "cleared by the person's own Try again");

  const refuses = () => { throw new Error("blocked"); };
  assert.equal(readInstallTried({ getItem: refuses }), null);
  assert.doesNotThrow(() => markInstallTried({ setItem: refuses }, "0.1.9"));
  assert.doesNotThrow(() => clearInstallTried({ removeItem: refuses }));
});
