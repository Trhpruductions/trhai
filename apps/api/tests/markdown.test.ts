import test from "node:test";
import assert from "node:assert/strict";
import { firstHeading, parseInlines, parseMarkdown, plainText, type Block, type Inline } from "../src/services/markdown.js";

/** Runs of text as short strings: B bold, I italic, S strike, C code, @url a link, a line break as a return sign. */
const show = (inlines: Inline[]) =>
  inlines.map((run) => (run.kind === "break" ? "⏎" : `${run.bold ? "B" : ""}${run.italic ? "I" : ""}${run.strike ? "S" : ""}${run.code ? "C" : ""}${run.href ? `@${run.href}` : ""}:${run.text}`));

const kinds = (blocks: Block[]) => blocks.map((block) => block.kind);

test("emphasis: bold, italic, both, strike and code, alone and together", () => {
  assert.deepEqual(show(parseInlines("plain **bold** and *italic* and ***both*** and ~~gone~~ and `code`")), [
    ":plain ", "B:bold", ": and ", "I:italic", ": and ", "BI:both", ": and ", "S:gone", ": and ", "C:code"
  ]);
  assert.deepEqual(show(parseInlines("__bold__ and _italic_")), ["B:bold", ": and ", "I:italic"]);
  assert.deepEqual(show(parseInlines("**bold with *italic* inside** after")), ["B:bold with ", "BI:italic", "B: inside", ": after"]);
  assert.deepEqual(show(parseInlines("*italic with **bold** inside*")), ["I:italic with ", "BI:bold", "I: inside"]);
});

test("a star or underscore that is not emphasis stays as it was written", () => {
  assert.deepEqual(show(parseInlines("snake_case_name and 2*3*4 and a * b")), [":snake_case_name and 2*3*4 and a * b"]);
  assert.deepEqual(show(parseInlines("an **unclosed bold")), [":an **unclosed bold"]);
  assert.deepEqual(show(parseInlines("5 * 6 = 30 and ** nothing **")), [":5 * 6 = 30 and ** nothing **"]);
  assert.deepEqual(show(parseInlines("a literal \\*star\\* and \\_under\\_")), [":a literal *star* and _under_"]);
});

test("code is taken as it is: no emphasis inside it, and backticks can be inside double backticks", () => {
  assert.deepEqual(show(parseInlines("`**not bold**` and `` a `tick` inside ``")), ["C:**not bold**", ": and ", "C:a `tick` inside"]);
  assert.deepEqual(show(parseInlines("an unmatched ` backtick")), [":an unmatched ` backtick"]);
});

test("links, with their text styled, and addresses in angle brackets", () => {
  assert.deepEqual(show(parseInlines("see [the **docs**](https://example.com/a?b=1) now")), [":see ", "@https://example.com/a?b=1:the ", "B@https://example.com/a?b=1:docs", ": now"]);
  assert.deepEqual(show(parseInlines("write to <mailto:me@example.com> or <https://example.org>")), [":write to ", "@mailto:me@example.com:me@example.com", ": or ", "@https://example.org:https://example.org"]);
  assert.deepEqual(show(parseInlines("[not a link] (and this)")), [":[not a link] (and this)"]);
  // A bracket in the address belongs to the address: the ")" that ends the link is the unmatched one.
  assert.deepEqual(show(parseInlines("see [Foo](https://en.wikipedia.org/wiki/Foo_(bar)) here")), [":see ", "@https://en.wikipedia.org/wiki/Foo_(bar):Foo", ": here"]);
  assert.deepEqual(show(parseInlines("[click](javascript:alert(3)) after")), ["@javascript:alert(3):click", ": after"], "the whole address is read, so no stray bracket is left behind");
  assert.deepEqual(show(parseInlines("[titled](https://example.com \"A title\")")), ["@https://example.com:titled"]);
});

test("a line break is kept inside a paragraph, and the ends of a paragraph have none", () => {
  assert.deepEqual(show(parseInlines("Jane Doe\n12 High Street\nLondon")), [":Jane Doe", "⏎", ":12 High Street", "⏎", ":London"]);
  assert.deepEqual(show(parseInlines("ends with two spaces  \nnext")), [":ends with two spaces", "⏎", ":next"]);
  assert.deepEqual(show(parseInlines("a backslash\\\nbreak")), [":a backslash", "⏎", ":break"]);
  assert.deepEqual(show(parseInlines("\ntrimmed\n")), [":trimmed"]);
});

test("text in any language and symbols pass through untouched", () => {
  assert.deepEqual(show(parseInlines("日本語 — café ♪ 🎵 <b>not a tag</b> & more")), [":日本語 — café ♪ 🎵 <b>not a tag</b> & more"]);
});

test("headings of every level, with or without closing marks, and not without a space", () => {
  const blocks = parseMarkdown("# One\n## Two ##\n### Three\n#### Four\n##### Five\n###### Six\n####### Seven\n#NoSpace");
  assert.deepEqual(blocks.slice(0, 6).map((b) => (b.kind === "heading" ? [b.level, plainText(b.inlines)] : null)), [[1, "One"], [2, "Two"], [3, "Three"], [4, "Four"], [5, "Five"], [6, "Six"]]);
  assert.equal(kinds(blocks.slice(6)).join(), "paragraph", "seven marks is a paragraph, and so is a hash with no space after it (both lines together)");
  assert.equal(firstHeading(parseMarkdown("intro\n\n## The **Title**\n# Later")), "The Title");
  assert.equal(firstHeading(parseMarkdown("no headings here")), null);
});

test("paragraphs are separated by blank lines, and a heading ends a paragraph without one", () => {
  const blocks = parseMarkdown("First line\nsecond line\n\nSecond paragraph\n# Heading right after\nthird");
  assert.deepEqual(kinds(blocks), ["paragraph", "paragraph", "heading", "paragraph"]);
  assert.deepEqual(show((blocks[0] as { inlines: Inline[] }).inlines), [":First line", "⏎", ":second line"]);
});

test("bullet lists and numbered lists, and what carries on a list item", () => {
  const blocks = parseMarkdown("- one\n- two\n  carries on\n* three\n\n1. first\n2. second\n10) tenth");
  assert.deepEqual(kinds(blocks), ["list", "list"], "dashes and stars are one list of bullets, and the numbers another");
  const first = blocks[0] as Extract<Block, { kind: "list" }>;
  assert.equal(first.ordered, false);
  assert.deepEqual(first.items.map((entry) => show(entry.inlines)), [[":one"], [":two", "⏎", ":carries on"], [":three"]]);
  const numbered = blocks[1] as Extract<Block, { kind: "list" }>;
  assert.deepEqual([numbered.ordered, numbered.start, numbered.items.length], [true, 1, 3]);
  assert.deepEqual(numbered.items.map((entry) => plainText(entry.inlines)), ["first", "second", "tenth"]);
});

test("a numbered list that starts at another number says so", () => {
  const list = parseMarkdown("3. three\n4. four")[0] as Extract<Block, { kind: "list" }>;
  assert.deepEqual([list.ordered, list.start, list.items.length], [true, 3, 2]);
});

test("lists inside lists, as deep as they go, and a paragraph under an item", () => {
  const blocks = parseMarkdown("- fruit\n  - apple\n  - pear\n    - green\n- veg\n\n  A note about veg.\n- done");
  assert.equal(blocks.length, 1);
  const list = blocks[0] as Extract<Block, { kind: "list" }>;
  assert.deepEqual(list.items.map((entry) => plainText(entry.inlines)), ["fruit", "veg", "done"]);
  const nested = list.items[0].children[0] as Extract<Block, { kind: "list" }>;
  assert.equal(nested.kind, "list");
  assert.deepEqual(nested.items.map((entry) => plainText(entry.inlines)), ["apple", "pear"]);
  const deeper = nested.items[1].children[0] as Extract<Block, { kind: "list" }>;
  assert.deepEqual(deeper.items.map((entry) => plainText(entry.inlines)), ["green"]);
  assert.deepEqual(kinds(list.items[1].children), ["paragraph"]);
  assert.equal(plainText((list.items[1].children[0] as Extract<Block, { kind: "paragraph" }>).inlines), "A note about veg.");
});

test("blank lines between items do not split a list", () => {
  const blocks = parseMarkdown("- a\n\n- b\n\n- c");
  assert.deepEqual(kinds(blocks), ["list"]);
  assert.equal((blocks[0] as Extract<Block, { kind: "list" }>).items.length, 3);
});

test("a list directly after a paragraph, and a paragraph directly after a list", () => {
  assert.deepEqual(kinds(parseMarkdown("Here are the steps:\n1. Mix\n2. Bake\nEnjoy.")), ["paragraph", "list", "paragraph"]);
});

test("tables: header, alignment, cells with emphasis, short and long rows, and a pipe that is escaped", () => {
  const blocks = parseMarkdown("| Name | Qty | Price |\n|:-----|:---:|------:|\n| **Tea** | 2 | £3.50 |\n| Milk | 1 |\n| Cake | 4 | £2 | extra |\n| a \\| b | `x|y` | z |");
  assert.deepEqual(kinds(blocks), ["table"]);
  const table = blocks[0] as Extract<Block, { kind: "table" }>;
  assert.deepEqual(table.align, ["left", "center", "right"]);
  assert.deepEqual(table.header.map(plainText), ["Name", "Qty", "Price"]);
  assert.equal(table.rows.length, 4);
  assert.deepEqual(show(table.rows[0][0]), ["B:Tea"]);
  assert.deepEqual(table.rows[1].map(plainText), ["Milk", "1", ""], "a short row is filled");
  assert.deepEqual(table.rows[2].map(plainText), ["Cake", "4", "£2"], "a long row is cut");
  assert.deepEqual(table.rows[3].map(plainText), ["a | b", "x|y", "z"]);
});

test("a table with no outer pipes, and a line with a pipe that is not a table", () => {
  const table = parseMarkdown("A | B\n--|--\n1 | 2")[0] as Extract<Block, { kind: "table" }>;
  assert.equal(table.kind, "table");
  assert.deepEqual(table.rows[0].map(plainText), ["1", "2"]);
  assert.deepEqual(kinds(parseMarkdown("use a | b to pipe\nand more")), ["paragraph"]);
});

test("code blocks keep their text exactly, whatever is in it, with their language", () => {
  const blocks = parseMarkdown("before\n```js\nconst a = '**not bold**';\n# not a heading\n\n- not a list\n```\nafter\n\n~~~\nplain\n~~~");
  assert.deepEqual(kinds(blocks), ["paragraph", "code", "paragraph", "code"]);
  assert.deepEqual([(blocks[1] as { language: string }).language, (blocks[1] as { text: string }).text], ["js", "const a = '**not bold**';\n# not a heading\n\n- not a list"]);
  assert.equal((blocks[3] as { text: string }).text, "plain");
  assert.equal((parseMarkdown("```\nnever closed\nstill code")[0] as { text: string }).text, "never closed\nstill code", "an unclosed fence runs to the end");
});

test("quotes hold blocks of their own, and rules and page breaks are blocks", () => {
  const blocks = parseMarkdown("> A quote\n> - with a list\n> - of two\n\n---\n\n***\n\n\\newpage\n\n<!-- pagebreak -->\n\n___");
  assert.deepEqual(kinds(blocks), ["quote", "rule", "rule", "pagebreak", "pagebreak", "rule"]);
  assert.deepEqual(kinds((blocks[0] as Extract<Block, { kind: "quote" }>).blocks), ["paragraph", "list"]);
});

test("whatever is given, it is read: odd input is paragraphs, not errors", () => {
  assert.deepEqual(parseMarkdown(""), []);
  assert.deepEqual(parseMarkdown("   \n\n  "), []);
  assert.deepEqual(kinds(parseMarkdown("﻿with a mark and\r\nwindows endings\r\n\r\nand a second\ttabbed paragraph")), ["paragraph", "paragraph"]);
  for (const nasty of ["|", "||||", "- ", "> ", "#", "```", "[", "](", "**", "*a*b*c*", "\\", "<", "1.", "| a |\n|---|\n", "- [ ] task", "text\n---\n---"]) {
    assert.doesNotThrow(() => parseMarkdown(nasty), JSON.stringify(nasty));
  }
  const crowd = Array.from({ length: 3000 }, (_, i) => `- item ${i} with **bold ${i}** and [link](http://x/${i})`).join("\n");
  const started = Date.now();
  assert.equal((parseMarkdown(crowd)[0] as Extract<Block, { kind: "list" }>).items.length, 3000);
  assert.ok(Date.now() - started < 2000, "a long list is read quickly");
});

test("a document as a model writes one comes out as its parts", () => {
  const blocks = parseMarkdown([
    "# Jane Doe",
    "jane@example.com | 07700 900123",
    "",
    "## Experience",
    "**Senior Engineer**, Acme Ltd (2020 - now)",
    "- Led a team of *five*",
    "- Cut build times by 40%",
    "",
    "## Skills",
    "| Skill | Level |",
    "|---|---|",
    "| TypeScript | Expert |"
  ].join("\n"));
  assert.deepEqual(kinds(blocks), ["heading", "paragraph", "heading", "paragraph", "list", "heading", "table"]);
});

test("a byte-order mark at the start is not text, and a tab indents like four spaces", () => {
  const mark = String.fromCharCode(0xfeff);
  assert.deepEqual(kinds(parseMarkdown(`${mark}# Title\n\nBody`)), ["heading", "paragraph"], "a heading that starts the file is still one");
  const [list] = parseMarkdown("- parent\n\t- child\n\t- other child\n- next") as Array<Extract<Block, { kind: "list" }>>;
  assert.equal(list.items.length, 2, "the tab-indented lines are inside the first item");
  assert.deepEqual(list.items[0].children.map((child) => child.kind), ["list"]);
});

test("a <br> is a line break, even in a table cell, and any other tag is shown as the text it is", () => {
  assert.deepEqual(show(parseInlines("first<br>second<br/>third<BR />fourth")), [":first", "⏎", ":second", "⏎", ":third", "⏎", ":fourth"]);
  assert.deepEqual(show(parseInlines("a <b>tag</b> and <brother> stay")), [":a <b>tag</b> and <brother> stay"]);
  const [table] = parseMarkdown("| A | B |\n|---|---|\n| one<br>two | x |") as Array<Extract<Block, { kind: "table" }>>;
  assert.deepEqual(show(table.rows[0][0]), [":one", "⏎", ":two"]);
});

test("a checklist item shows its box, ticked or not, and a link that starts with x is still a link", () => {
  const [list] = parseMarkdown("- [ ] pack the charger\n- [x] book the flights\n- [X] renew the passport\n- [x](https://example.com) a link\n- [x]no space\n1. [ ] numbered too") as Array<Extract<Block, { kind: "list" }>>;
  assert.deepEqual(list.items.map((entry) => plainText(entry.inlines)), ["☐ pack the charger", "☑ book the flights", "☑ renew the passport", "x a link", "[x]no space"]);
  assert.deepEqual(show(list.items[3].inlines), ["@https://example.com:x", ": a link"]);
});
