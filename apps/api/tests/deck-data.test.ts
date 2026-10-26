import test from "node:test";
import assert from "node:assert/strict";
import { mostSlides, parseDeck, type Deck, type Slide, type SlideContent } from "../src/services/deckData.js";
import { plainText } from "../src/services/markdown.js";
import { fits } from "../src/services/slideMetrics.js";

// A Markdown outline becomes slides: which heading is the deck's title and which start a slide, what is on a slide, what is
// a speaker's note and what is not, and how a slide with too much on it is split.

function parse(source: string, title?: string): Deck {
  const read = parseDeck(source, title);
  assert.equal(read.ok, true, read.ok ? "" : read.reason);
  if (!read.ok) throw new Error("not read");
  return read.deck;
}

const contentOf = (slide: Slide): SlideContent[] => {
  assert.equal(slide.kind, "content");
  return slide.kind === "content" ? slide.content : [];
};
const bulletTexts = (content: SlideContent) => (content.kind === "bullets" ? content.items.map((item) => plainText(item.inlines)) : []);
const outline = (...lines: string[]) => lines.join("\n");

// ---------------------------------------------------------------- the shape of a deck

test("a # heading is the deck's title, the lines under it are its subtitle, and every ## heading is a slide", () => {
  const deck = parse(outline("# Q3 Review", "A look back", "", "Prepared by Ann", "", "## Highlights", "- one", "- two", "", "## Next", "1. a", "2. b"));
  assert.equal(deck.title, "Q3 Review");
  assert.deepEqual(deck.slides.map((slide) => [slide.kind, slide.title]), [["title", "Q3 Review"], ["content", "Highlights"], ["content", "Next"]]);
  const first = deck.slides[0];
  assert.equal(first.kind === "title" && first.subtitle, "A look back\nPrepared by Ann");
  assert.deepEqual(bulletTexts(contentOf(deck.slides[1])[0]), ["one", "two"]);
  assert.deepEqual(contentOf(deck.slides[2])[0], { kind: "bullets", items: [
    { inlines: [{ kind: "text", text: "a" }], level: 0, number: 1, task: false },
    { inlines: [{ kind: "text", text: "b" }], level: 0, number: 2, task: false }
  ] });
  assert.equal(deck.notes, 0);
  assert.equal(deck.split, 0);
});

test("a deck with nothing under its title has no subtitle", () => {
  const deck = parse("# Just a Title\n\n## First\n- a");
  const first = deck.slides[0];
  assert.equal(first.kind === "title" && first.subtitle, null);
});

test("a model that writes every slide under a # heading gets slides, and the title it was given as the first one", () => {
  const source = outline("# Why now", "- the market moved", "- we are ready", "", "# The plan", "- build", "- sell");
  const without = parse(source);
  assert.deepEqual(without.slides.map((slide) => [slide.kind, slide.title]), [["content", "Why now"], ["content", "The plan"]]);
  assert.equal(without.title, "Why now", "with no title of its own, the first slide names the deck");
  const given = parse(source, "Pitch to the Board");
  assert.deepEqual(given.slides.map((slide) => [slide.kind, slide.title]), [["title", "Pitch to the Board"], ["content", "Why now"], ["content", "The plan"]]);
  assert.equal(given.title, "Pitch to the Board");
});

test("a # heading with a list, a table, code or a lot of text under it is a slide, not the deck's title", () => {
  for (const under of [outline("- a", "- b"), outline("| a | b |", "|---|---|", "| 1 | 2 |"), outline("```", "code", "```"), outline("One.", "", "Two.", "", "Three.", "", "Four.")]) {
    const deck = parse(outline("# Plan", "", under));
    assert.equal(deck.slides[0].kind, "content", under);
  }
  // Up to three lines under it are a subtitle.
  const subtitle = parse(outline("# Plan", "", "One.", "", "Two.", "", "Three.", "", "## Next", "- x"));
  const first = subtitle.slides[0];
  assert.equal(first.kind === "title" && first.subtitle, "One.\nTwo.\nThree.");
});

test("a quote of several paragraphs under the title is one subtitle line, and a # heading after the first is a slide", () => {
  const quoted = parse(outline("# Deck", "", "> First thought", ">", "> Second thought", "", "## Next", "- x"));
  const first = quoted.slides[0];
  assert.equal(first.kind === "title" && first.subtitle, "First thought Second thought");
  const later = parse(outline("# Deck", "Sub", "", "## A", "- a", "", "# Section", "", "## B", "- b"));
  assert.deepEqual(later.slides.map((slide) => [slide.kind, slide.title]), [["title", "Deck"], ["content", "A"], ["content", "Section"], ["content", "B"]]);
});

test("a paragraph that continues a list item is a line under it, a level down", () => {
  const deck = parse(outline("## L", "- first", "", "  more about first", "", "- second"));
  const items = contentOf(deck.slides[0])[0];
  assert.deepEqual(items.kind === "bullets" && items.items.map((item) => [plainText(item.inlines), item.level]), [["first", 0], ["more about first", 1], ["second", 0]]);
  const deep = parse(outline("## L", "- a", "  - b", "    - c", "", "      under c"));
  const nested = contentOf(deep.slides[0])[0];
  assert.deepEqual(nested.kind === "bullets" && nested.items.map((item) => item.level), [0, 1, 2, 2], "a line under the third level stays on it");
});

test("a quote under the title is its subtitle, and one under a slide's heading is a quote on the slide", () => {
  const deck = parse(outline("# Deck", "", "> Make it simple", "", "## Wise", "> Less is more", "", "Said by many."));
  const first = deck.slides[0];
  assert.equal(first.kind === "title" && first.subtitle, "Make it simple");
  const wise = contentOf(deck.slides[1]);
  assert.equal(wise[0].kind, "quote");
  assert.equal(wise[0].kind === "quote" && plainText(wise[0].inlines), "Less is more");
  assert.equal(wise[1].kind, "text");
});

test("what is under a heading is what is on the slide: text, lists, quotes, code and tables, in order", () => {
  const deck = parse(outline(
    "# Deck", "", "## Everything", "An opening line.", "", "- bullet", "", "> a quote", "", "```js", "const a = 1;", "", "a += 1;", "```", "",
    "| Name | Score |", "|:--|--:|", "| Ann | 10 |", "| Bob | 200 |", "", "A closing line."
  ));
  const content = contentOf(deck.slides[1]);
  assert.deepEqual(content.map((item) => item.kind), ["text", "bullets", "quote", "code", "table", "text"]);
  assert.deepEqual(content[3], { kind: "code", lines: ["const a = 1;", "", "a += 1;"] });
  const table = content[4];
  assert.equal(table.kind, "table");
  if (table.kind === "table") {
    assert.deepEqual(table.header.map((cell) => plainText(cell)), ["Name", "Score"]);
    assert.deepEqual(table.rows.map((row) => row.map((cell) => plainText(cell))), [["Ann", "10"], ["Bob", "200"]]);
    assert.deepEqual(table.align, ["left", "right"]);
  }
});

test("a heading below the second level is bold text on the slide, not a slide", () => {
  const deck = parse(outline("## Plan", "### The first part", "- a", "#### And a smaller one", "- b"));
  assert.equal(deck.slides.length, 1);
  const content = contentOf(deck.slides[0]);
  assert.deepEqual(content.map((item) => item.kind), ["text", "bullets", "text", "bullets"]);
  assert.equal(content[0].kind === "text" && content[0].inlines.every((run) => run.kind === "text" && run.bold === true), true);
});

test("rules and page breaks between slides are not on them", () => {
  const deck = parse(outline("## One", "- a", "", "---", "", "## Two", "", "\\pagebreak", "", "- b"));
  assert.equal(deck.slides.length, 2);
  assert.deepEqual(contentOf(deck.slides[0]).map((item) => item.kind), ["bullets"]);
  assert.deepEqual(contentOf(deck.slides[1]).map((item) => item.kind), ["bullets"]);
  // Before the first slide there is nothing for them to separate, and no empty slide is made for them.
  const first = parse(outline("\\pagebreak", "", "---", "", "## A", "- x"));
  assert.deepEqual(first.slides.map((slide) => slide.title), ["A"]);
});

test("a list keeps its levels to three, its numbers from where they start, and a checklist its boxes without bullets", () => {
  const deck = parse(outline("## Levels", "- a", "  - b", "    - c", "      - d", "", "Then:", "", "3. third", "4. fourth", "", "And:", "", "- [x] done", "- [ ] to do"));
  const content = contentOf(deck.slides[0]);
  const levels = content[0].kind === "bullets" ? content[0].items.map((item) => [plainText(item.inlines), item.level]) : [];
  assert.deepEqual(levels, [["a", 0], ["b", 1], ["c", 2], ["d", 2]], "no deeper than the third level");
  const numbered = content.find((item) => item.kind === "bullets" && item.items[0].number !== null);
  assert.deepEqual(numbered?.kind === "bullets" && numbered.items.map((item) => item.number), [3, 4], "numbered from where the list starts");
  const checks = content[content.length - 1];
  assert.equal(checks.kind === "bullets" && checks.items.every((item) => item.task), true);
  assert.deepEqual(checks.kind === "bullets" && checks.items.map((item) => plainText(item.inlines)), ["☑ done", "☐ to do"]);
  assert.equal(content[0].kind === "bullets" && content[0].items.some((item) => item.task), false, "an ordinary list has no checkboxes");
});

test("a numbered checklist keeps its numbers", () => {
  const deck = parse(outline("## Tasks", "1. [ ] first", "2. [x] second"));
  const list = contentOf(deck.slides[0])[0];
  assert.equal(list.kind === "bullets" && list.items.every((item) => !item.task && item.number !== null), true);
});

// ---------------------------------------------------------------- speaker's notes

test("a paragraph that begins Notes: starts the speaker's notes, which run to the next slide and are not on the slide", () => {
  const deck = parse(outline(
    "# Deck", "", "Subtitle", "", "Notes: Welcome everyone.", "",
    "## A", "- point", "", "Notes: say hello", "", "- and a list in the notes", "  - nested", "", "A closing paragraph of notes.", "",
    "## B", "- point 2", "", "Speaker notes: remember the demo", "",
    "## C", "- no notes here"
  ));
  assert.equal(deck.notes, 3);
  const [title, a, b, c] = deck.slides;
  assert.deepEqual(title.notes, ["Welcome everyone."]);
  assert.deepEqual(a.notes, ["say hello", "- and a list in the notes", "  - nested", "A closing paragraph of notes."]);
  assert.deepEqual(b.notes, ["remember the demo"]);
  assert.deepEqual(c.notes, []);
  assert.deepEqual(contentOf(a).map((item) => item.kind), ["bullets"], "none of it is on the slide");
  assert.equal(title.kind === "title" && title.subtitle, "Subtitle");
});

test("a Notes heading starts them too, and so does any case of the word", () => {
  const deck = parse(outline("## A", "- x", "", "### Speaker Notes", "First thought.", "", "Second thought.", "", "## B", "- y", "", "NOTES: shout"));
  assert.deepEqual(deck.slides[0].notes, ["First thought.", "Second thought."]);
  assert.deepEqual(deck.slides[1].notes, ["shout"]);
});

test("a sentence that begins Note: or Notes on its own stays on the slide", () => {
  const deck = parse(outline("## Small print", "Note: all prices include tax.", "", "Notes from the field are in the appendix.", "", "- x"));
  assert.deepEqual(deck.slides[0].notes, []);
  assert.deepEqual(contentOf(deck.slides[0]).map((item) => item.kind), ["text", "text", "bullets"]);
});

test("notes that hold a list do not turn the title slide into a slide of its own", () => {
  const deck = parse(outline("# Deck", "Sub", "", "Notes: first", "", "- a list in the notes", "", "## Next", "- x"));
  assert.equal(deck.slides[0].kind, "title");
  assert.deepEqual(deck.slides[0].notes, ["first", "- a list in the notes"]);
  const heading = parse(outline("# Deck", "Sub", "", "### Notes", "", "- a list in the notes", "", "## Next", "- x"));
  assert.equal(heading.slides[0].kind, "title");
  assert.deepEqual(heading.slides[0].notes, ["- a list in the notes"]);
  assert.equal(heading.slides[0].kind === "title" && heading.slides[0].subtitle, "Sub");
});

test("notes keep their lists with the levels they had, and a table, a quote or code in them as lines, without blank ones", () => {
  const deck = parse(outline(
    "## A", "- x", "", "Notes: say these", "", "1. first", "2. second", "   - nested", "", "| a | b |", "|---|---|", "| 1 | 2 |", "",
    "> a quoted line", "", "### A heading in the notes", "", "```", "code line", "", "more code", "```"
  ));
  assert.deepEqual(deck.slides[0].notes, ["say these", "1. first", "2. second", "  - nested", "a | b", "1 | 2", "a quoted line", "A heading in the notes", "code line", "more code"]);
  // A numbered list in the notes is numbered from where it starts.
  const later = parse(outline("## A", "- x", "", "Notes: from the third", "", "3. third", "4. fourth"));
  assert.deepEqual(later.slides[0].notes, ["from the third", "3. third", "4. fourth"]);
});

test("a heading that only begins with Notes is a heading on the slide, not the start of the notes", () => {
  const deck = parse(outline("## A", "### Notes on the method", "- x", "", "### Notes: and a colon", "- y"));
  assert.deepEqual(deck.slides[0].notes, []);
  assert.deepEqual(contentOf(deck.slides[0]).map((item) => item.kind), ["text", "bullets", "text", "bullets"]);
});

test("notes before any slide have nowhere to go, and do not swallow the next slide", () => {
  const deck = parse(outline("Notes: ignored", "", "and so is this", "", "## A", "- x"));
  assert.deepEqual(deck.slides.map((slide) => slide.title), ["A"]);
  assert.deepEqual(deck.slides[0].notes, []);
  assert.deepEqual(contentOf(deck.slides[0]).map((item) => item.kind), ["bullets"]);
});

// ---------------------------------------------------------------- when there is too much for a slide

const line = (index: number) => `- Point number ${index} has a few words to make it a real line of text`;

test("a list too long for a slide continues on the next, with the title carried over and the notes kept on the first", () => {
  const deck = parse(outline("## Long", ...Array.from({ length: 14 }, (_, index) => line(index + 1)), "", "Notes: the notes"));
  assert.deepEqual(deck.slides.map((slide) => slide.title), ["Long", "Long (2)"]);
  assert.deepEqual(deck.slides.map((slide) => bulletTexts(contentOf(slide)[0]).length), [9, 5]);
  assert.deepEqual(deck.slides.map((slide) => slide.notes), [["the notes"], []]);
  assert.equal(deck.split, 1);
  assert.equal(deck.notes, 1);
  for (const slide of deck.slides) assert.equal(fits(contentOf(slide)), true);
});

test("a list that fits is not split, and the ninth bullet is the last one that does", () => {
  const nine = parse(outline("## Nine", ...Array.from({ length: 9 }, (_, index) => line(index + 1))));
  assert.equal(nine.slides.length, 1);
  const ten = parse(outline("## Ten", ...Array.from({ length: 10 }, (_, index) => line(index + 1))));
  assert.deepEqual(ten.slides.map((slide) => slide.title), ["Ten", "Ten (2)"]);
});

test("long lines take the room of the lines they wrap to", () => {
  const long = `- ${"word ".repeat(40).trim()}`;
  const deck = parse(outline("## Wordy", long, long, long, long, long, long, long));
  assert.ok(deck.slides.length > 1, "seven bullets of two or three lines each do not fit on one slide");
  const sixShort = parse(outline("## Short", ...Array.from({ length: 6 }, (_, index) => `- Short point ${index + 1}`)));
  assert.equal(sixShort.slides.length, 1);
});

test("a table too long for a slide continues on the next with its header, and no row is lost or repeated", () => {
  const rows = Array.from({ length: 20 }, (_, index) => `| Row ${index + 1} | ${index * 7} |`);
  const deck = parse(outline("## Big table", "| Name | Value |", "|---|---|", ...rows));
  assert.ok(deck.slides.length >= 2);
  const seen: string[] = [];
  for (const slide of deck.slides) {
    const table = contentOf(slide)[0];
    assert.equal(table.kind, "table");
    if (table.kind !== "table") continue;
    assert.deepEqual(table.header.map((cell) => plainText(cell)), ["Name", "Value"], "the header is on every one");
    assert.equal(fits([table]), true);
    seen.push(...table.rows.map((row) => plainText(row[0])));
  }
  assert.deepEqual(seen, Array.from({ length: 20 }, (_, index) => `Row ${index + 1}`));
  assert.deepEqual(deck.slides.map((slide) => slide.title), ["Big table", ...deck.slides.slice(1).map((_, index) => `Big table (${index + 2})`)]);
});

test("code too long for a slide is split between its lines, and nothing is dropped", () => {
  const code = Array.from({ length: 40 }, (_, index) => `line_${index + 1}();`);
  const deck = parse(outline("## Code", "```", ...code, "```"));
  assert.ok(deck.slides.length >= 2);
  const lines = deck.slides.flatMap((slide) => contentOf(slide).flatMap((item) => (item.kind === "code" ? item.lines : [])));
  assert.deepEqual(lines, code);
});

test("a paragraph is never cut in the middle, and a slide with nothing on it is still a slide", () => {
  const paragraph = "Sentence after sentence goes on here. ".repeat(40).trim();
  const deck = parse(outline("## Wall of text", paragraph, "", "## Divider", "", "## After", "- x"));
  assert.deepEqual(deck.slides.map((slide) => slide.title), ["Wall of text", "Divider", "After"]);
  assert.deepEqual(contentOf(deck.slides[0]), [{ kind: "text", inlines: [{ kind: "text", text: paragraph }] }]);
  assert.deepEqual(contentOf(deck.slides[1]), []);
});

test("what comes after a long list on a slide goes on the slide it ends on", () => {
  const deck = parse(outline("## Mixed", ...Array.from({ length: 12 }, (_, index) => line(index + 1)), "", "A closing remark."));
  assert.deepEqual(deck.slides.map((slide) => contentOf(slide).map((item) => item.kind)), [["bullets"], ["bullets", "text"]]);
});

test("one bullet too long for a slide on its own is one slide, not an empty one and then the bullet", () => {
  const huge = `- ${"word ".repeat(600).trim()}`;
  const deck = parse(outline("## Huge", huge, "", "## After", "- x"));
  assert.deepEqual(deck.slides.map((slide) => slide.title), ["Huge", "After"]);
  assert.equal(bulletTexts(contentOf(deck.slides[0])[0]).length, 1);
});

test("a title slide is never split", () => {
  const title = "A".repeat(60);
  const deck = parse(`# ${title}\n\n${"Subtitle words. ".repeat(10)}\n\n## Next\n- x`);
  assert.equal(deck.slides[0].kind, "title");
  assert.equal(deck.slides.length, 2);
});

// ---------------------------------------------------------------- what cannot be a deck

test("an outline with nothing in it, or no slides in it, is refused with the reason", () => {
  for (const source of ["", "   \n\n  "]) {
    const read = parseDeck(source);
    assert.equal(read.ok, false);
    assert.match(read.ok ? "" : read.reason, /There was no outline/);
  }
  const rules = parseDeck("---\n\n---");
  assert.equal(rules.ok, false);
  assert.match(rules.ok ? "" : rules.reason, /There were no slides/);
});

test("text with no heading is one slide that takes the title it was given", () => {
  const deck = parse("- one\n- two", "My Talk");
  assert.deepEqual(deck.slides.map((slide) => [slide.kind, slide.title]), [["title", "My Talk"], ["content", ""]]);
  assert.deepEqual(bulletTexts(contentOf(deck.slides[1])[0]), ["one", "two"]);
  const untitled = parse("- one\n- two");
  assert.equal(untitled.title, "Presentation");
  assert.deepEqual(untitled.slides.map((slide) => slide.kind), ["content"], "no title to give, so no title slide");
});

test("a deck with a title that is only spaces is not given that title", () => {
  const deck = parse("## Alpha\n- a", "   ");
  assert.equal(deck.title, "Alpha");
  assert.deepEqual(deck.slides.map((slide) => slide.kind), ["content"]);
});

test("a deck of more slides than a presentation can have is refused, and the limit is exact", () => {
  const make = (count: number) => Array.from({ length: count }, (_, index) => `## Slide ${index + 1}\n- x`).join("\n\n");
  assert.equal(parseDeck(make(mostSlides)).ok, true);
  const over = parseDeck(make(mostSlides + 1));
  assert.equal(over.ok, false);
  assert.match(over.ok ? "" : over.reason, /That comes to 201 slides; a presentation can be up to 200\./);
  // Slides made by splitting count too.
  const split = parseDeck(outline("## Long", ...Array.from({ length: mostSlides * 10 }, (_, index) => line(index))));
  assert.equal(split.ok, false);
});
