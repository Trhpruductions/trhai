import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  encryptJson, hasLockedProtectedFiles, lockedProtectedFiles, parseProtectedJson,
  protectedJsonLooksEncrypted, readProtectedJsonFile, writeProtectedJsonFile
} from "../src/services/protectedJson.js";

function withKey<T>(key: string, run: () => T): T {
  const prior = process.env.TRHAI_DATA_KEY;
  process.env.TRHAI_DATA_KEY = key;
  try {
    return run();
  } finally {
    if (prior === undefined) delete process.env.TRHAI_DATA_KEY;
    else process.env.TRHAI_DATA_KEY = prior;
  }
}

test("protected JSON encrypts content and decrypts with the same key", () => {
  withKey("correct horse local battery staple", () => {
    const envelope = encryptJson({ secret: "microphone passphrase", count: 3 });
    const encoded = JSON.stringify(envelope);

    assert.equal(envelope.protected, true);
    assert.equal(envelope.algorithm, "aes-256-gcm");
    assert.doesNotMatch(encoded, /microphone passphrase/);
    assert.deepEqual(parseProtectedJson(encoded), { secret: "microphone passphrase", count: 3 });
  });
});

test("protected JSON refuses the wrong key", () => {
  const encoded = withKey("right-local-key", () => JSON.stringify(encryptJson({ secret: "locked" })));

  assert.throws(
    () => withKey("wrong-local-key", () => parseProtectedJson(encoded)),
    /Unsupported state or unable to authenticate data|bad decrypt|authenticate/i
  );
});

test("legacy plaintext JSON still reads so it can migrate on the next save", () => {
  const value = parseProtectedJson(JSON.stringify({ version: 1, clear: true }));
  assert.deepEqual(value, { version: 1, clear: true });
});

test("protected JSON file writes an encrypted envelope, not raw app data", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "trhai-protected-json-"));
  try {
    const file = path.join(dir, "store.json");
    withKey("file-local-key", () => {
      writeProtectedJsonFile(file, { email: "owner@example.com", note: "private build notes" });
      const raw = readFileSync(file, "utf8");

      assert.equal(protectedJsonLooksEncrypted(raw), true);
      assert.doesNotMatch(raw, /owner@example\.com|private build notes/);
      assert.deepEqual(readProtectedJsonFile(file), {
        email: "owner@example.com",
        note: "private build notes"
      });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a wrong key read locks the encrypted file against overwrite", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "trhai-protected-json-lock-"));
  try {
    const file = path.join(dir, "store.json");
    const original = withKey("original-local-key", () => {
      writeProtectedJsonFile(file, { note: "do not replace" });
      return readFileSync(file, "utf8");
    });

    assert.throws(
      () => withKey("wrong-local-key", () => readProtectedJsonFile(file)),
      /Encrypted JSON could not be authenticated/i
    );
    assert.throws(
      () => withKey("wrong-local-key", () => writeProtectedJsonFile(file, { note: "replacement" })),
      /Refusing to overwrite encrypted data/i
    );
    assert.equal(readFileSync(file, "utf8"), original);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A lock has to be visible, not just safe.
//
// Locking protects the data and, on its own, protects it in silence. Every
// store catches the read error and carries on with empty state — right, because
// an unreadable file must not stop the API from starting — so a key that no
// longer matches becomes an assistant that has forgotten everything and will
// not remember anything new, with nothing saying why.

test("a file that fails to authenticate is reported, not just locked", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "trhai-locked-"));
  const file = path.join(dir, "store.json");

  // A well-formed envelope this key cannot open: written under one secret,
  // read under another.
  const previous = process.env.TRHAI_DATA_KEY;
  process.env.TRHAI_DATA_KEY = "the-original-key";
  writeFileSync(file, JSON.stringify(encryptJson({ kept: "something" })), "utf8");
  process.env.TRHAI_DATA_KEY = "a-different-key";

  try {
    assert.throws(() => readProtectedJsonFile(file), /could not be authenticated/i);

    // The point of the test: it is now listed, so the app can say so.
    const locked = lockedProtectedFiles();
    assert.ok(hasLockedProtectedFiles(), "the session should know something is locked");
    assert.ok(
      locked.some((entry) => entry.includes("store.json")),
      `store.json should be listed as locked, got ${JSON.stringify(locked)}`
    );

    // And it must refuse to be overwritten, so the real data survives.
    assert.throws(() => writeProtectedJsonFile(file, { kept: "replacement" }),
      /Refusing to overwrite/i);
    assert.match(readFileSync(file, "utf8"), /ciphertext/, "the original bytes must still be there");
  } finally {
    if (previous === undefined) delete process.env.TRHAI_DATA_KEY;
    else process.env.TRHAI_DATA_KEY = previous;
  }
});
