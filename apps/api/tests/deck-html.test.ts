import test from "node:test";
import assert from "node:assert/strict";
import { deckHtml } from "../src/services/deckHtml.js";
import { parseDeck, type Slide } from "../src/services/deckData.js";
import { readZip } from "../src/services/documentText.js";
import { pptxFile } from "../src/services/pptxWriter.js";
import { rowHeights, type Table } from "../src/services/slideMetrics.js";
import { bodySize, titleSize } from "../src/services/slideMetrics.js";

// The PDF of a presentation is printed from this page: a page to a slide, drawn from the same slides, sizes and colours as the
// PowerPoint file, and safe to print - nothing in it can run or reach out.

const outline = (...lines: string[]) => lines.join("\n");
function slidesOf(source: string, title?: string): Slide[] {
  const read = parseDeck(source, title);
  assert.equal(read.ok, true, read.ok ? "" : read.reason);
  return read.ok ? read.deck.slides : [];
}
const page = (source: string, title?: string) => deckHtml(slidesOf(source, title), { title: title ?? "Deck", language: "en-US" });
const sections = (html: string) => [...html.matchAll(/<section class="slide( opening)?">([\s\S]*?)<\/section>/g)].map((match) => ({ opening: Boolean(match[1]), html: match[2] }));

test("a page to a slide, the first of them the dark title slide, in a page the size of a 16:9 slide", () => {
  const html = page(outline("# Deck", "Sub", "", "## One", "- a", "", "## Two", "- b"));
  const found = sections(html);
  assert.deepEqual(found.map((section) => section.opening), [true, false, false]);
  assert.match(html, /@page \{ size: 13\.333in 7\.5in; margin: 0; \}/);
  // A touch shorter than the page, so that no slide spills a blank page after it.
  assert.match(html, /\.slide \{[^}]*width: 13\.333in; height: 7\.49in;[^}]*break-after: page;/);
  assert.match(html, /\.slide:last-child \{ break-after: auto; page-break-after: auto; \}/);
  assert.match(html, /print-color-adjust: exact/, "the dark title slide prints dark");
});

test("a title slide has its title and a paragraph for each line of its subtitle; a slide has a heading and a body", () => {
  const html = page(outline("# The Deck", "First line", "", "Second line", "", "## Plan", "- a"));
  const [title, plan] = sections(html);
  assert.match(title.html, /^<h1 class="title" style="font-size:54pt">The Deck<\/h1><div class="subtitle" style="font-size:24pt"><p>First line<\/p><p>Second line<\/p><\/div>$/);
  assert.match(plan.html, /^<h2 class="title" style="font-size:36pt">Plan<\/h2><div class="body">/);
  const none = sections(page("# Alone\n\n## Next\n- x"))[0];
  assert.doesNotMatch(none.html, /subtitle/);
});

test("titles and body text are set at the sizes the PowerPoint file uses", () => {
  const long = "w".repeat(120);
  const html = page(`## ${long}\n- one\n- two`);
  const [slide] = sections(html);
  assert.ok(slide.html.includes(`style="font-size:${titleSize(long, false)}pt">${long}</h2>`));
  const content = slidesOf(`## ${long}\n- one\n- two`)[0];
  const size = bodySize(content.kind === "content" ? content.content : []);
  assert.match(slide.html, new RegExp(`<li class="top" style="padding-left:0\\.375in;font-size:${size}pt">`));
});

test("a slide with no title has no empty heading", () => {
  const html = deckHtml(slidesOf("- just text", "Named"), { title: "Named" });
  const [, untitled] = sections(html);
  assert.doesNotMatch(untitled.html, /<h2/);
  assert.match(untitled.html, /just text/);
});

test("bullets hang the way they do in the PowerPoint file: a bullet by level, a number, and a checklist item with no mark", () => {
  const html = page(outline("## L", "- top", "  - second", "    - third", "", "Then:", "", "3. three", "", "And:", "", "- [x] done"));
  const [slide] = sections(html);
  const item = (word: string) => new RegExp(`<li class="(top|sub)" style="padding-left:([\\d.]+in);font-size:(\\d+)pt">(<span class="mark" aria-hidden="true" style="left:([\\d.]+in)">([^<]*)</span>)?${word}`).exec(slide.html);
  const top = item("top")!;
  assert.deepEqual([top[1], top[2], top[5], top[6]], ["top", "0.375in", "0in", "&#8226;"]);
  const second = item("second")!;
  assert.deepEqual([second[1], second[2], second[5], second[6]], ["sub", "0.875in", "0.5in", "&#8211;"]);
  const third = item("third")!;
  assert.deepEqual([third[1], third[2], third[5], third[6]], ["sub", "1.375in", "1in", "&#8226;"]);
  const number = item("three")!;
  assert.deepEqual([number[2], number[5], number[6]], ["0.5in", "0in", "3."]);
  const done = item("☑ done")!;
  assert.equal(done[4], undefined, "a checklist item has no mark of its own");
  assert.equal(done[2], "0in");
  // Two points smaller for each level.
  assert.equal(Number(top[3]) - Number(second[3]), 2);
  assert.equal(Number(second[3]) - Number(third[3]), 2);
});

test("a nested checklist item is indented the way the PowerPoint file indents it, and has no mark", () => {
  const html = page(outline("## C", "- [x] top task", "  - [ ] nested task"));
  const [slide] = sections(html);
  assert.match(slide.html, /<li class="top" style="padding-left:0in;font-size:\d+pt">☑ top task<\/li>/);
  assert.match(slide.html, /<li class="sub" style="padding-left:0\.4375in;font-size:\d+pt">☐ nested task<\/li>/);
});

test("a table's rows are each as tall as the measures say, the header first", () => {
  // A header that wraps as well as a row that does, so that each row's own height is told apart from the others'.
  const rows = outline("## T", "| Name | " + "A header of many words ".repeat(6) + " |", "|---|---|", "| a | short |", "| b | " + "long words go on ".repeat(20) + " |", "| c | short |");
  const [slide] = sections(page(rows));
  const heights = [...slide.html.matchAll(/<tr style="height:([\d.]+)pt">/g)].map((match) => Number(match[1]));
  const first = slidesOf(rows)[0];
  const table = first.kind === "content" ? first.content[0] : undefined;
  assert.equal(table?.kind, "table");
  const wanted = rowHeights(table as Table);
  assert.deepEqual(heights, wanted.map((points) => Number(points.toFixed(1))));
  assert.equal(new Set(heights).size, 3, `the header, the row that wraps and the rows that do not: ${heights}`);
  assert.ok(heights[2] > heights[1] && heights[2] > heights[3], "the row with words that wrap is taller than its neighbours");
  assert.ok(heights[0] > heights[1], "so is the header, which wraps");
});

test("what comes before the last table is above the tables and what comes after it below, wherever it was in the outline", () => {
  const html = page(outline("## T", "| a |", "|---|", "| 1 |", "", "Between the tables.", "", "| b |", "|---|", "| 2 |", "", "After them."));
  const [slide] = sections(html);
  const at = ["Between the tables.", ">a<", ">b<", "After them."].map((marker) => slide.html.indexOf(marker));
  assert.ok(at.every((place) => place >= 0), String(at));
  assert.ok(at[0] < at[1] && at[1] < at[2] && at[2] < at[3], `in the PowerPoint file's order: ${at}`);
});

test("a nested numbered list is indented by the numbered step, not the bullet's", () => {
  const html = page(outline("## N", "1. one", "   1. nested", "      1. deeper"));
  const [slide] = sections(html);
  assert.match(slide.html, /<li class="top" style="padding-left:0\.5in;font-size:\d+pt"><span class="mark" aria-hidden="true" style="left:0in">1\.<\/span>one<\/li>/);
  assert.match(slide.html, /<li class="sub" style="padding-left:0\.9375in;font-size:\d+pt"><span class="mark" aria-hidden="true" style="left:0\.4375in">1\.<\/span>nested<\/li>/);
  assert.match(slide.html, /<li class="sub" style="padding-left:1\.375in;font-size:\d+pt"><span class="mark" aria-hidden="true" style="left:0\.875in">1\.<\/span>deeper<\/li>/);
});

test("the page and the PowerPoint file set every kind of text at the same size", () => {
  const source = outline(
    "# A Title For The Deck", "A subtitle that is a line long", "",
    "## Bullets", "- one", "  - two", "", "## Words", "A paragraph.", "", "> A quote", "", "```", "code();", "```", "",
    "## Table", "| a | b |", "|---|---|", "| 1 | 2 |",
    "", "## " + "L".repeat(120), "- long title"
  );
  const slides = slidesOf(source);
  const zip = readZip(pptxFile(slides, { title: "Same", date: new Date(Date.UTC(2026, 9, 25)) }));
  const pptx = (n: number) => zip.get(`ppt/slides/slide${n}.xml`)!().toString("utf8");
  // The size of the run that holds this text, from its own properties.
  const sizeBefore = (xml: string, text: string) => {
    const run = (xml.match(/<a:r>[\s\S]*?<\/a:r>/g) ?? []).find((candidate) => new RegExp(`<a:t>${text}</a:t>`).test(candidate));
    assert.ok(run, `no run says ${text}`);
    return Number(/ sz="(\d+)"/.exec(run)![1]) / 100;
  };
  const html = sections(deckHtml(slides, { title: "Same" }));
  const fontOf = (markup: string, pattern: RegExp) => Number(pattern.exec(markup)![1]);

  assert.equal(fontOf(html[0].html, /<h1 [^>]*font-size:(\d+)pt/), sizeBefore(pptx(1), "A Title For The Deck"));
  assert.equal(fontOf(html[0].html, /<div class="subtitle" style="font-size:(\d+)pt/), sizeBefore(pptx(1), "A subtitle that is a line long"));
  assert.equal(fontOf(html[1].html, /<h2 [^>]*font-size:(\d+)pt/), sizeBefore(pptx(2), "Bullets"));
  assert.equal(fontOf(html[1].html, /<li class="top"[^>]*font-size:(\d+)pt/), sizeBefore(pptx(2), "one"));
  assert.equal(fontOf(html[1].html, /<li class="sub"[^>]*font-size:(\d+)pt/), sizeBefore(pptx(2), "two"));
  assert.equal(fontOf(html[2].html, /<p style="font-size:(\d+)pt/), sizeBefore(pptx(3), "A paragraph\\."));
  assert.equal(fontOf(html[2].html, /<blockquote style="font-size:(\d+)pt/), sizeBefore(pptx(3), "A quote"));
  assert.equal(fontOf(html[2].html, /<pre style="font-size:(\d+)pt/), sizeBefore(pptx(3), "code\\(\\);"));
  assert.equal(fontOf(html[3].html, /<table style="font-size:(\d+)pt/), sizeBefore(pptx(4), "1"));
  assert.equal(fontOf(html[4].html, /<h2 [^>]*font-size:(\d+)pt/), sizeBefore(pptx(5), "L{120}"));
});

test("a list is one list, and text, quotes and code are set between lists", () => {
  const html = page(outline("## Mixed", "Intro.", "", "- a", "- b", "", "> A quote", "", "```", "x < y", "z", "```", "", "- c"));
  const [slide] = sections(html);
  assert.equal([...slide.html.matchAll(/<ul class="list">/g)].length, 2);
  assert.match(slide.html, /<p style="font-size:\d+pt">Intro\.<\/p><ul class="list">.*<\/ul><blockquote style="font-size:\d+pt"><p>A quote<\/p><\/blockquote><pre style="font-size:\d+pt"><code>x &lt; y\nz<\/code><\/pre><ul class="list">/s);
});

test("a table has a column for each header, with widths that make a whole, and a height for each row", () => {
  const html = page(outline("## T", "| Name | Score |", "|:--|--:|", "| Ann | 10 |", "| Bob | 200 |"));
  const [slide] = sections(html);
  const widths = [...slide.html.matchAll(/<col style="width:([\d.]+)%">/g)].map((match) => Number(match[1]));
  assert.equal(widths.length, 2);
  assert.ok(Math.abs(widths.reduce((a, b) => a + b, 0) - 100) < 0.05);
  assert.match(slide.html, /<table style="font-size:16pt">/);
  assert.match(slide.html, /<thead><tr style="height:33\.0pt"><th style="text-align:left">Name<\/th><th style="text-align:right">Score<\/th><\/tr><\/thead>/);
  assert.equal([...slide.html.matchAll(/<tr style="height:33\.0pt">/g)].length, 3);
  assert.match(slide.html, /<td style="text-align:right">200<\/td>/);
  const big = page(outline("## T", "| A | B | C | D | E |", "|---|---|---|---|---|", "| 1 | 2 | 3 | 4 | 5 |"));
  assert.match(big, /<table style="font-size:14pt">/, "five columns are set smaller");
});

test("text before a table is above it and text after it below, as in the PowerPoint file", () => {
  const html = page(outline("## T", "Above.", "", "| a | b |", "|---|---|", "| 1 | 2 |", "", "Below."));
  const [slide] = sections(html);
  const order = ["Above.", "<table", "Below."].map((marker) => slide.html.indexOf(marker));
  assert.ok(order[0] >= 0 && order[0] < order[1] && order[1] < order[2], String(order));
});

test("everything is escaped, and nothing in a slide can run or load", () => {
  const evil = outline(
    "# <script>alert(1)</script> & \"co\"",
    "<img src=x onerror=alert(1)>",
    "",
    "## <b>bold?</b>",
    "- <iframe src=\"https://evil.example\"></iframe>",
    "- [click](javascript:alert(1)) and [ok](https://example.com/?a=1&b=2)",
    "",
    "| <i>h</i> |", "|---|", "| <script>x</script> |"
  );
  const html = deckHtml(slidesOf(evil), { title: "<title> & \"x\"" });
  // Every tag in the page is one of ours, with none of the attributes that run or load something.
  const allowed = new Set(["html", "head", "meta", "title", "style", "body", "section", "h1", "h2", "div", "p", "ul", "li", "span", "blockquote", "pre", "code", "table", "colgroup", "col", "thead", "tbody", "tr", "th", "td", "a", "del", "em", "strong"]);
  const tags = [...html.matchAll(/<\/?([a-zA-Z][\w-]*)([^>]*)>/g)];
  assert.ok(tags.length > 40);
  for (const [, name, attributes] of tags) {
    assert.ok(allowed.has(name.toLowerCase()), `a <${name}> tag is in the page`);
    assert.doesNotMatch(attributes, /\bon\w+\s*=/i, `an event handler on <${name}>`);
    assert.doesNotMatch(attributes, /\b(?:src|srcset|action|formaction|data|poster|background)\s*=/i, `an address that loads on <${name}>`);
    for (const href of attributes.matchAll(/\bhref="([^"]*)"/g)) assert.match(href[1], /^(?:https?:\/\/|mailto:|tel:|#)/);
  }
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)![1];
  assert.doesNotMatch(style, /@import|url\(|expression\(/i);
  assert.match(html, /<title>&lt;title&gt; &amp; &quot;x&quot;<\/title>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;co&quot;/);
  assert.match(html, /<a href="https:\/\/example\.com\/\?a=1&amp;b=2">ok<\/a>/);
  assert.doesNotMatch(html, /javascript:/, "a link that is not to the web is text and its address is dropped");
  assert.match(html, />click and <a href=/);
});

test("the speaker's notes are not on the slides that are printed", () => {
  const html = page(outline("## A", "- shown", "", "Notes: whispered", "", "## B", "- also shown"));
  assert.doesNotMatch(html, /whispered/);
  assert.match(html, /shown/);
});

test("the page says what language it is in, and a deck of any size is one page to a slide", () => {
  const source = Array.from({ length: 30 }, (_, index) => `## S${index + 1}\n- x`).join("\n\n");
  const html = deckHtml(slidesOf(source), { title: "Thirty", language: "fr-FR" });
  assert.match(html, /^<!doctype html>\n<html lang="fr-FR">/);
  assert.equal(sections(html).length, 30);
  assert.match(deckHtml(slidesOf(source), { title: "x" }), /<html lang="en">/, "English unless told otherwise");
});
