import test from "node:test";
import assert from "node:assert/strict";
import { applyEdit, describeEdit, placeholderIn, replacesMostOf } from "../src/services/fileEdit.js";

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

// ---- write_file's guards -----------------------------------------------------

const serverFile = Array.from({ length: 233 }, (_, index) => `line ${index + 1};`).join("\n") + "\n";

test("a write that would keep a line or two of a long file is caught", () => {
  // The live case: one line asked to be appended to a 233-line server.js, then
  // write_file with that line alone as the whole file.
  const shrink = replacesMostOf(serverFile, "\n// Additional line added\n", undefined);
  assert.deepEqual(shrink, { before: 233, kept: 0 });
  assert.ok(replacesMostOf(serverFile, "<new_content>", "Append this exact line to the end of server.js: // x"));
});

test("a small file is protected too: what counts is what survives, not the size", () => {
  // Live: one phrase replaced in a two-line notes file, then an invented line
  // written over both.
  assert.deepEqual(
    replacesMostOf(
      "first note (edited)\nsecond note\n",
      "Notes for the battery project.",
      "in battery-tmp/notes.txt, replace 'first note' with 'first note (edited)'"
    ),
    { before: 2, kept: 0 }
  );
});

test("a write that reproduces the file with a change in it goes through", () => {
  const changed = serverFile.replace("line 117;", "line 117; // tuned");
  assert.equal(replacesMostOf(serverFile, changed, undefined), null);
  // Re-indenting is not losing a line.
  assert.equal(replacesMostOf("a\nb\nc\n", "  a\n  b\n  c\n", undefined), null);
});

test("one new line does not vouch for every copy of it in the old file", () => {
  const braces = Array.from({ length: 12 }, () => "}").join("\n") + "\n";
  assert.deepEqual(replacesMostOf(braces, "}\n", undefined), { before: 12, kept: 1 });
});

test("a rewrite the request asked for in so many words goes through", () => {
  for (const request of [
    "rewrite server.js as a minimal express server",
    "overwrite notes.txt with hello",
    "replace the contents of server.js with a hello world",
    "make notes.txt only say hi",
    "clear notes.txt",
    "start over on server.js from scratch",
    // A transformation of the whole file, asked for.
    "sort the lines in notes.txt",
    "convert notes.txt to uppercase",
    "translate notes.txt into French"
  ]) {
    assert.equal(replacesMostOf(serverFile, "hi\n", request), null, `should allow: ${request}`);
  }
});

test("a replacement of one passage is not a request to replace the file", () => {
  assert.ok(replacesMostOf(serverFile, "hi\n", "replace foo with bar in server.js"));
});

test("a request that only adds keeps every line, even in a one-line file", () => {
  // Live: "add a line saying second note to the end of notes.txt" went to
  // write_file with "\nsecond note" and the file's one line was gone.
  const request = "add a line saying second note to the end of rg-tmp/notes.txt";
  assert.deepEqual(replacesMostOf("first note\n", "\nsecond note\n", request), { before: 1, kept: 0 });
  // Writing the file back with the line added is fine.
  assert.equal(replacesMostOf("first note\n", "first note\nsecond note\n", request), null);
  // Half is not enough when the request only adds.
  assert.deepEqual(replacesMostOf("a\nb\nc\nd\n", "a\nb\nc\nnew\n", "append a line saying new to list.txt"), { before: 4, kept: 3 });
  // A new file, or one asked to be rewritten, is not held to it.
  assert.equal(replacesMostOf("", "second note\n", request), null);
  assert.equal(replacesMostOf("first note\n", "second note\n", "rewrite notes.txt and add a line saying second note"), null);
});

test("one-line and empty files, and writes that keep half or more, are not second-guessed", () => {
  assert.equal(replacesMostOf("hello\n", "goodbye\n", undefined), null, "a single line is an ordinary write");
  const twenty = Array.from({ length: 20 }, (_, index) => `${index}`).join("\n");
  const ten = Array.from({ length: 10 }, (_, index) => `${index}`).join("\n");
  assert.equal(replacesMostOf(twenty, ten, undefined), null, "half is kept");
  assert.equal(replacesMostOf("", "anything\n", undefined), null, "an empty file");
});

test("a template left unfilled is recognised, in the content or the path", () => {
  assert.match(placeholderIn("app/server.js", "<new_content>") ?? "", /placeholder/);
  assert.match(placeholderIn("app/server.js", "  <your code here>\n") ?? "", /placeholder/);
  assert.match(placeholderIn("path/to/file", "hello") ?? "", /placeholder, not a real path/);
  assert.match(placeholderIn("D:\\ws\\path\\to\\file.txt", "hello") ?? "", /not a real path/);
  assert.match(placeholderIn("<path>", "hello") ?? "", /not a real path/);
});

test("real content that happens to use angle brackets is left alone", () => {
  assert.equal(placeholderIn("index.html", "<br>"), null);
  assert.equal(placeholderIn("index.html", "<!DOCTYPE html>\n<html></html>"), null);
  assert.equal(placeholderIn("notes/paths-to-check.md", "path to glory"), null);
});
