import test from "node:test";
import assert from "node:assert/strict";
import { applyEdit, describeEdit } from "../src/services/fileEdit.js";

// Targeted editing exists because whole-file rewriting lost things. Asked to
// add an exclamation mark to a greeting, the model returned one line for a file
// that had also contained `module.exports = { greet }`. The exclamation mark was
// right; the module was destroyed; the write reported success.

const source = [
  "function greet(name) {",
  '  return "Hello " + name;',
  "}",
  "module.exports = { greet };"
].join("\n");

test("the rest of the file survives an edit", () => {
  // The whole point: nothing outside old_text can be lost, because nothing
  // outside it is ever sent.
  const result = applyEdit(source, '"Hello " + name', '"Hello " + name + "!"');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(result.content, /module\.exports = \{ greet \};/);
  assert.match(result.content, /\+ "!"/);
});

test("text that is not there is refused, with advice that helps", () => {
  const result = applyEdit(source, "return 'Hello ' + name;", "x");
  assert.equal(result.ok, false);
  // Single vs double quotes is the usual cause, so the message says to copy
  // verbatim rather than just "not found".
  if (!result.ok) assert.match(result.reason, /verbatim/i);
});

test("ambiguous text is refused rather than guessed at", () => {
  // Editing an arbitrary one of several matches and reporting success is worse
  // than refusing: the file changes somewhere nobody looked.
  const repeated = "const a = 1;\nconst b = 2;\nconst a = 1;";
  const result = applyEdit(repeated, "const a = 1;", "const a = 9;");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /appears 2 times/);
    assert.match(result.reason, /surrounding lines/i);
  }
});

test("a no-op edit is refused rather than reported as done", () => {
  // Reporting success for an unchanged file is how a bug survives a fix that
  // never happened.
  const result = applyEdit(source, "greet", "greet");
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /identical/i);
});

test("empty old_text is refused", () => {
  // It matches at position zero, so it would silently prepend.
  assert.equal(applyEdit(source, "", "x").ok, false);
});

test("an edit may delete text", () => {
  const result = applyEdit(source, "module.exports = { greet };", "");
  assert.equal(result.ok, true);
  if (result.ok) assert.doesNotMatch(result.content, /module\.exports/);
});

test("a match may start mid-line, which is how part of a line gets changed", () => {
  // Matching is by substring, not by whole lines. That is deliberate - changing
  // one expression inside a line is a normal edit - and it means a request with
  // less indentation than the file still matches, starting after the extra
  // space. Worth stating rather than assuming: the alternative, refusing
  // anything not line-aligned, would reject ordinary edits.
  const result = applyEdit(source, '"Hello "', '"Hi "');
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.match(result.content, /return "Hi " \+ name;/);
    // The indentation the file had is untouched, because it was never inside
    // the matched text.
    assert.match(result.content, /^ {2}return/m);
  }
});

test("a multi-line replacement works", () => {
  const result = applyEdit(source, "function greet(name) {", "function greet(name = 'world') {\n  // defaulted");
  assert.equal(result.ok, true);
  if (result.ok) assert.match(result.content, /defaulted/);
});

test("the description reports what actually changed", () => {
  assert.equal(describeEdit("a", "b"), "1 line changed");
  assert.equal(describeEdit("a\nb", "c\nd"), "2 lines changed");
  assert.equal(describeEdit("a", "b\nc\nd"), "1 line replaced with 3");
});

// Whitespace that differs is not a different edit.
//
// Live: asked to edit a file, the model read it, called edit_file, was told
// the text was not there, read it again, and gave up - the file unchanged. The
// file was pure LF, so this was never a line-ending problem; the model had
// re-indented what it quoted back. That is a difference it cannot reliably
// avoid and one that changes nothing about which text is meant.

test("an edit still applies when the quoted indentation differs", () => {
  const source = 'function greet(name) {\n  return "Hello " + name;\n}\n';
  const result = applyEdit(source, 'function greet(name) {\nreturn "Hello " + name;\n}',
    'function greet(name) {\n  if (!name) throw new Error("name is required");\n  return "Hello " + name;\n}');

  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  if (!result.ok) return;
  assert.match(result.content, /throw new Error/);
  assert.match(result.content, /module|Hello/);
});

test("the real span is replaced, not the normalised one", () => {
  // The file keeps its own formatting everywhere the edit did not touch.
  const source = 'const a = 1;\n\nfunction f() {\n    return 2;\n}\n';
  const result = applyEdit(source, "function f() {\n  return 2;\n}", "function f() {\n  return 3;\n}");

  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  if (!result.ok) return;
  assert.match(result.content, /const a = 1;/, "untouched text must survive verbatim");
  assert.match(result.content, /return 3;/);
});

test("a loose match that is ambiguous is still refused", () => {
  // Relaxing the search must not relax the guarantee that an edit changes one
  // known span.
  const source = "call( a );\n\ncall(  a  );\n";
  const result = applyEdit(source, "call(a)", "call(b)");
  assert.equal(result.ok, false, "two loose candidates must not be guessed between");
});

test("text that is genuinely absent is still refused", () => {
  const result = applyEdit("const a = 1;\n", "const b = 2;", "const b = 3;");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /not in the file/);
});
