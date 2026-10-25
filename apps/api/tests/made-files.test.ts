import test from "node:test";
import assert from "node:assert/strict";
import { noteMadeFiles, takeMadeFiles } from "../src/services/madeFiles.js";

test("files noted for a conversation are handed over once, in the order they were made, without repeats", () => {
  noteMadeFiles("one", ["documents/A.docx", "documents/B.pdf"]);
  noteMadeFiles("one", ["documents/B.pdf", "documents/C.txt"]);
  assert.deepEqual(takeMadeFiles("one"), ["documents/A.docx", "documents/B.pdf", "documents/C.txt"]);
  assert.deepEqual(takeMadeFiles("one"), [], "and then they are gone");
});

test("one conversation's files are never another's", () => {
  noteMadeFiles("left", ["documents/Left.docx"]);
  noteMadeFiles("right", ["documents/Right.docx"]);
  assert.deepEqual(takeMadeFiles("right"), ["documents/Right.docx"]);
  assert.deepEqual(takeMadeFiles("left"), ["documents/Left.docx"]);
});

test("a turn with no conversation, or nothing made, notes and hands over nothing", () => {
  noteMadeFiles(undefined, ["documents/A.docx"]);
  noteMadeFiles(null, ["documents/A.docx"]);
  noteMadeFiles("empty", []);
  assert.deepEqual(takeMadeFiles(undefined), []);
  assert.deepEqual(takeMadeFiles(null), []);
  assert.deepEqual(takeMadeFiles("empty"), []);
});

test("what nobody collects cannot grow without end: few files each, few conversations at once", () => {
  noteMadeFiles("many", Array.from({ length: 80 }, (_, index) => `documents/File ${index}.docx`));
  assert.equal(takeMadeFiles("many").length, 50);
  for (let index = 0; index < 150; index += 1) noteMadeFiles(`session-${index}`, [`documents/${index}.docx`]);
  assert.deepEqual(takeMadeFiles("session-0"), [], "the oldest were let go");
  assert.deepEqual(takeMadeFiles("session-149"), ["documents/149.docx"], "the newest are kept");
  assert.deepEqual(takeMadeFiles("session-50"), ["documents/50.docx"], "and the last hundred");
  assert.deepEqual(takeMadeFiles("session-49"), []);
});
