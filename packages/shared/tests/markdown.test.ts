import test from "node:test";
import assert from "node:assert/strict";
import {
  inlineText,
  isSafeHref,
  parseInline,
  parseMarkdown,
  speakableText,
  type Block
} from "../src/markdown.js";

// A model writes the text this parses, and a model can be talked into writing
// anything. So the tests care about two things above all: that nothing is
// silently dropped, and that nothing dangerous survives as a link.

function first(source: string): Block {
  const blocks = parseMarkdown(source);
  assert.ok(blocks.length > 0, "expected at least one block");
  return blocks[0];
}

test("plain prose is one paragraph", () => {
  const block = first("Hello there, this is a reply.");
  assert.equal(block.kind, "paragraph");
  assert.equal(inlineText(block.kind === "paragraph" ? block.children : []), "Hello there, this is a reply.");
});

test("a blank line separates paragraphs", () => {
  const blocks = parseMarkdown("First one.\n\nSecond one.");
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].kind, "paragraph");
  assert.equal(blocks[1].kind, "paragraph");
});

test("wrapped lines join into one paragraph rather than several", () => {
  const blocks = parseMarkdown("This sentence is\nwrapped across lines.");
  assert.equal(blocks.length, 1);
  assert.equal(inlineText(blocks[0].kind === "paragraph" ? blocks[0].children : []),
    "This sentence is wrapped across lines.");
});

test("a fenced code block keeps its language and its exact text", () => {
  const block = first("```ts\nconst x = 1;\nconsole.log(x);\n```");

  assert.equal(block.kind, "code");
  if (block.kind !== "code") return;
  assert.equal(block.language, "ts");
  assert.equal(block.text, "const x = 1;\nconsole.log(x);");
});

test("code block indentation survives exactly", () => {
  // The whole point of a code block. Trimming here would silently break
  // every Python answer the model gives.
  const block = first("```python\ndef f():\n    return 1\n```");
  assert.equal(block.kind === "code" && block.text, "def f():\n    return 1");
});

test("markdown inside a code block is not interpreted", () => {
  const block = first("```\n# not a heading\n**not bold**\n```");

  assert.equal(block.kind, "code");
  assert.equal(block.kind === "code" && block.text, "# not a heading\n**not bold**");
});

test("an unclosed fence still produces a code block", () => {
  // A model that stops mid-answer should not turn the rest into prose.
  const blocks = parseMarkdown("```js\nconst a = 1;");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, "code");
  assert.equal(blocks[0].kind === "code" && blocks[0].text, "const a = 1;");
});

test("a fence with no language says so rather than guessing one", () => {
  const block = first("```\nplain\n```");
  assert.equal(block.kind === "code" && block.language, null);
});

test("headings carry their level", () => {
  for (let level = 1; level <= 6; level += 1) {
    const block = first(`${"#".repeat(level)} Title`);
    assert.equal(block.kind, "heading");
    assert.equal(block.kind === "heading" && block.level, level);
  }
});

test("a hash with no space is not a heading", () => {
  // "#1 on the list" is prose.
  const block = first("#not-a-heading");
  assert.equal(block.kind, "paragraph");
});

test("bullet lists collect their items", () => {
  const block = first("- one\n- two\n- three");

  assert.equal(block.kind, "list");
  if (block.kind !== "list") return;
  assert.equal(block.ordered, false);
  assert.equal(block.items.length, 3);
  assert.equal(inlineText(block.items[1]), "two");
});

test("numbered lists are marked ordered", () => {
  const block = first("1. first\n2. second");
  assert.equal(block.kind === "list" && block.ordered, true);
  assert.equal(block.kind === "list" && block.items.length, 2);
});

test("changing marker style starts a new list rather than merging", () => {
  const blocks = parseMarkdown("1. numbered\n- bulleted");
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].kind === "list" && blocks[0].ordered, true);
  assert.equal(blocks[1].kind === "list" && blocks[1].ordered, false);
});

test("a blockquote is its own block", () => {
  const block = first("> quoted text");
  assert.equal(block.kind, "quote");
  assert.equal(inlineText(block.kind === "quote" ? block.children : []), "quoted text");
});

test("a horizontal rule is recognised, and a bullet is not mistaken for one", () => {
  assert.equal(first("---").kind, "rule");
  assert.equal(first("***").kind, "rule");
  assert.equal(first("- item").kind, "list", "a single dash with text is a list");
});

test("inline code is kept literal", () => {
  const nodes = parseInline("Use `npm test` to run them.");
  const code = nodes.find((node) => node.kind === "code");
  assert.ok(code);
  assert.equal(code.kind === "code" && code.text, "npm test");
});

test("asterisks inside inline code are not emphasis", () => {
  // A parser that ran emphasis first would eat these out of someone's code.
  const nodes = parseInline("call `a ** b` please");
  const code = nodes.find((node) => node.kind === "code");
  assert.equal(code?.kind === "code" && code.text, "a ** b");
});

test("bold and italic are distinguished", () => {
  const bold = parseInline("**strong**");
  assert.equal(bold[0].kind, "bold");

  const italic = parseInline("*soft*");
  assert.equal(italic[0].kind, "italic");
});

test("an unmatched marker stays as literal text", () => {
  // 2 * 3 is arithmetic, not the start of emphasis.
  const nodes = parseInline("2 * 3 = 6");
  assert.equal(inlineText(nodes), "2 * 3 = 6");
});

test("nothing is dropped from text the parser does not understand", () => {
  const odd = "a ** b _ c ` d [ e ] ( f )";
  assert.equal(inlineText(parseInline(odd)), odd, "unrecognised input renders literally");
});

test("a safe link keeps its href", () => {
  const nodes = parseInline("see [the docs](https://example.com/x)");
  const link = nodes.find((node) => node.kind === "link");
  assert.ok(link);
  assert.equal(link.kind === "link" && link.href, "https://example.com/x");
  assert.equal(inlineText([link]), "the docs");
});

test("a javascript: link loses its href but keeps its words", () => {
  // The reply must still read correctly; only the link goes.
  const nodes = parseInline("click [here](javascript:alert(1))");
  assert.ok(!nodes.some((node) => node.kind === "link"), "must not be clickable");
  assert.match(inlineText(nodes), /here/);
});

test("dangerous schemes are refused however they are written", () => {
  for (const href of [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "  javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox",
    "//evil.example.com"
  ]) {
    assert.equal(isSafeHref(href), false, `${href} must not be linkable`);
  }
});

test("ordinary and relative links are allowed", () => {
  for (const href of ["https://example.com", "http://example.com", "mailto:a@b.com", "/local/page", "#anchor"]) {
    assert.equal(isSafeHref(href), true, `${href} should be fine`);
  }
});

test("a realistic reply parses into the blocks it looks like", () => {
  const reply = [
    "Here is how to do it.",
    "",
    "## Steps",
    "",
    "1. Install it",
    "2. Run `npm test`",
    "",
    "```bash",
    "npm install",
    "```",
    "",
    "> Note: this runs locally.",
    "",
    "That's **all**."
  ].join("\n");

  const kinds = parseMarkdown(reply).map((block) => block.kind);
  assert.deepEqual(kinds, ["paragraph", "heading", "list", "code", "quote", "paragraph"]);
});

test("an empty reply produces no blocks rather than an empty paragraph", () => {
  assert.deepEqual(parseMarkdown(""), []);
  assert.deepEqual(parseMarkdown("   \n\n  "), []);
});

test("windows line endings parse the same as unix ones", () => {
  const unix = parseMarkdown("# Title\n\nBody.");
  const windows = parseMarkdown("# Title\r\n\r\nBody.");
  assert.deepEqual(windows, unix);
});

// Speech. Once replies render as formatted text, hearing the raw markup is a
// plain mismatch between what is on screen and what is said.

test("emphasis markers are not read aloud", () => {
  assert.equal(speakableText("That's **all**."), "That's all.");
  assert.equal(speakableText("*soft* and _also soft_"), "soft and also soft");
});

test("headings are read as sentences rather than run into the next line", () => {
  assert.equal(speakableText("## Steps\n\nDo the thing."), "Steps. Do the thing.");
});

test("a heading that already ends in punctuation gains none", () => {
  assert.equal(speakableText("## Ready?\n\nYes."), "Ready? Yes.");
});

test("a code block is announced, not recited", () => {
  // Reading punctuation aloud is useless; saying nothing would hide that the
  // answer contained code at all.
  const spoken = speakableText("Run this:\n\n```bash\nnpm install\nnpm test\n```");

  assert.match(spoken, /Run this:/);
  assert.match(spoken, /2 lines of bash code/);
  assert.ok(!spoken.includes("npm install"), "the code itself is not read out");
});

test("a one-line code block is announced in the singular", () => {
  assert.match(speakableText("```\nls\n```"), /1 line of code/);
});

test("blank lines inside a code block are not counted as lines of code", () => {
  assert.match(speakableText("```js\nconst a = 1;\n\n\nconst b = 2;\n```"), /2 lines of js code/);
});

test("list items are separated so the voice pauses between them", () => {
  const spoken = speakableText("- first\n- second\n- third");
  assert.equal(spoken, "first. second. third.");
});

test("a link is read as its words, not its address", () => {
  const spoken = speakableText("See [the documentation](https://example.com/deep/path).");
  assert.match(spoken, /the documentation/);
  assert.ok(!spoken.includes("https"), "nobody wants a URL read out");
});

test("inline code is still read, since it is usually one short name", () => {
  assert.match(speakableText("Run `npm test` now."), /npm test/);
});

test("a horizontal rule is silent", () => {
  assert.equal(speakableText("Above.\n\n---\n\nBelow."), "Above. Below.");
});

test("an empty reply speaks nothing rather than a stray character", () => {
  assert.equal(speakableText(""), "");
  assert.equal(speakableText("```\n```"), "");
});

test("a realistic reply reads as prose", () => {
  const spoken = speakableText([
    "Here's how.",
    "",
    "## Steps",
    "1. Install it",
    "2. Run it",
    "",
    "```bash",
    "npm i",
    "```",
    "",
    "That's **it**."
  ].join("\n"));

  assert.equal(spoken, "Here's how. Steps. Install it. Run it. (1 line of bash code) That's it.");
});
