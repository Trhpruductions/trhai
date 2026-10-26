import test from "node:test";
import assert from "node:assert/strict";
import { parseDeck, type Slide } from "../src/services/deckData.js";
import { decodeEntities, readSlides, readZip } from "../src/services/documentText.js";
import { pptxFile } from "../src/services/pptxWriter.js";
import { rowHeights, titleSize, type Table } from "../src/services/slideMetrics.js";
import { assertWellFormed } from "./helpers/xml.js";

// The PowerPoint file's own parts: that each is well formed, that the package fits together (every part has a type and every
// link goes somewhere), that the layouts, placeholders, lists, tables and notes are what PowerPoint expects, and that what is
// written is read back as written. The file was also opened with python-pptx while building it.

const when = new Date(Date.UTC(2026, 9, 25, 12, 0, 0));
const outline = (...lines: string[]) => lines.join("\n");

function slidesOf(source: string, title?: string): Slide[] {
  const read = parseDeck(source, title);
  assert.equal(read.ok, true, read.ok ? "" : read.reason);
  return read.ok ? read.deck.slides : [];
}
function build(source: string, title?: string): Buffer {
  return pptxFile(slidesOf(source, title), { title: title ?? "Deck", date: when });
}
function partsOf(bytes: Buffer): Map<string, string> {
  const zip = readZip(bytes);
  return new Map([...zip.keys()].map((name) => [name, zip.get(name)!().toString("utf8")]));
}

const plain = outline("# Deck", "A subtitle", "", "## One", "- a", "- b", "", "## Two", "1. x", "2. y");
const withNotes = outline("# Deck", "", "Notes: hello", "", "## One", "- a", "", "Notes: say a", "", "## Two", "- b");

// ---------------------------------------------------------------- the package

test("the parts of a deck without notes are exactly the ones a presentation needs", () => {
  const names = [...partsOf(build(plain)).keys()].sort();
  assert.deepEqual(names, [
    "[Content_Types].xml", "_rels/.rels", "docProps/app.xml", "docProps/core.xml",
    "ppt/_rels/presentation.xml.rels", "ppt/presProps.xml", "ppt/presentation.xml",
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels", "ppt/slideLayouts/_rels/slideLayout2.xml.rels", "ppt/slideLayouts/slideLayout1.xml", "ppt/slideLayouts/slideLayout2.xml",
    "ppt/slideMasters/_rels/slideMaster1.xml.rels", "ppt/slideMasters/slideMaster1.xml",
    "ppt/slides/_rels/slide1.xml.rels", "ppt/slides/_rels/slide2.xml.rels", "ppt/slides/_rels/slide3.xml.rels", "ppt/slides/slide1.xml", "ppt/slides/slide2.xml", "ppt/slides/slide3.xml",
    "ppt/tableStyles.xml", "ppt/theme/theme1.xml", "ppt/viewProps.xml"
  ].sort());
});

test("speaker's notes add a notes master with its own theme, and a notes page for each slide that has them", () => {
  const names = [...partsOf(build(withNotes)).keys()];
  for (const name of ["ppt/notesMasters/notesMaster1.xml", "ppt/notesMasters/_rels/notesMaster1.xml.rels", "ppt/theme/theme2.xml", "ppt/notesSlides/notesSlide1.xml", "ppt/notesSlides/_rels/notesSlide1.xml.rels", "ppt/notesSlides/notesSlide2.xml"]) {
    assert.ok(names.includes(name), name);
  }
  assert.ok(!names.includes("ppt/notesSlides/notesSlide3.xml"), "the slide with no notes has no notes page");
  const without = [...partsOf(build(plain)).keys()];
  assert.ok(!without.some((name) => name.includes("notes") || name.includes("theme2")), "no notes, no notes parts");
});

test("every part is well formed XML", () => {
  for (const source of [plain, withNotes, outline("## T", "| a | b |", "|---|---|", "| 1 | 2 |", "", "Footnote.", "", "```", "x < y && y > z", "```", "", "> q", "", "[link](https://example.com/?a=1&b=2)")]) {
    for (const [name, xml] of partsOf(build(source, "Well & Formed <Deck>"))) {
      if (name.endsWith(".xml") || name.endsWith(".rels")) assertWellFormed(xml, name);
    }
  }
});

test("every part has a content type, every content type is for a part, and the types are the ones PowerPoint uses", () => {
  for (const source of [plain, withNotes]) {
    const parts = partsOf(build(source));
    const types = parts.get("[Content_Types].xml")!;
    const overrides = new Map([...types.matchAll(/<Override PartName="([^"]+)" ContentType="([^"]+)"\/>/g)].map((match) => [match[1].slice(1), match[2]]));
    for (const name of parts.keys()) {
      if (name === "[Content_Types].xml") continue;
      const covered = overrides.has(name) || (/\.(?:rels|xml)$/.test(name) && /<Default Extension="(?:rels|xml)"/.test(types));
      assert.ok(covered, `${name} has no content type`);
    }
    for (const name of overrides.keys()) assert.ok(parts.has(name), `${name} has a content type but is not in the file`);
    const exact: Record<string, string> = {
      "ppt/presentation.xml": "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
      "ppt/slideMasters/slideMaster1.xml": "application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml",
      "ppt/slideLayouts/slideLayout1.xml": "application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml",
      "ppt/slides/slide1.xml": "application/vnd.openxmlformats-officedocument.presentationml.slide+xml",
      "ppt/theme/theme1.xml": "application/vnd.openxmlformats-officedocument.theme+xml",
      "ppt/presProps.xml": "application/vnd.openxmlformats-officedocument.presentationml.presProps+xml",
      "ppt/viewProps.xml": "application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml",
      "ppt/tableStyles.xml": "application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml",
      "docProps/core.xml": "application/vnd.openxmlformats-package.core-properties+xml",
      "docProps/app.xml": "application/vnd.openxmlformats-officedocument.extended-properties+xml"
    };
    for (const [name, type] of Object.entries(exact)) assert.equal(overrides.get(name), type, name);
  }
  const notes = partsOf(build(withNotes)).get("[Content_Types].xml")!;
  assert.match(notes, /PartName="\/ppt\/notesMasters\/notesMaster1\.xml" ContentType="application\/vnd\.openxmlformats-officedocument\.presentationml\.notesMaster\+xml"/);
  assert.match(notes, /PartName="\/ppt\/notesSlides\/notesSlide1\.xml" ContentType="application\/vnd\.openxmlformats-officedocument\.presentationml\.notesSlide\+xml"/);
  assert.match(notes, /PartName="\/ppt\/theme\/theme2\.xml" ContentType="application\/vnd\.openxmlformats-officedocument\.theme\+xml"/);
});

/** Every relationship in the package: where it is from, its id, its type, and the part it goes to (or its address, when it leaves the file). */
function relationships(parts: Map<string, string>) {
  const out: Array<{ from: string; id: string; type: string; target: string; external: boolean; resolved: string }> = [];
  for (const [name, xml] of parts) {
    if (!name.endsWith(".rels")) continue;
    const directory = name.replace(/_rels\/[^/]*$/, "");
    for (const match of xml.matchAll(/<Relationship ([^>]*?)\/>/g)) {
      const attribute = (key: string) => decodeEntities(new RegExp(`\\b${key}="([^"]*)"`).exec(match[1])?.[1] ?? "");
      const target = attribute("Target");
      const external = attribute("TargetMode") === "External";
      const joined = external ? target : new URL(target, `http://package/${directory}`).pathname.slice(1);
      out.push({ from: name, id: attribute("Id"), type: attribute("Type").replace(/^.*\//, ""), target, external, resolved: decodeURIComponent(joined) });
    }
  }
  return out;
}

test("every relationship goes to a part that is there, ids are not repeated, and every id a part uses is one it has", () => {
  for (const source of [plain, withNotes, outline("## L", "- [one](https://example.com) and [two](https://example.org/x)")]) {
    const parts = partsOf(build(source));
    const all = relationships(parts);
    for (const link of all) if (!link.external) assert.ok(parts.has(link.resolved), `${link.from}: ${link.id} goes to ${link.resolved}`);
    for (const from of new Set(all.map((link) => link.from))) {
      const ids = all.filter((link) => link.from === from).map((link) => link.id);
      assert.equal(new Set(ids).size, ids.length, `${from} repeats an id`);
    }
    for (const [name, xml] of parts) {
      if (!name.endsWith(".xml") || name.startsWith("[")) continue;
      const own = new Set(all.filter((link) => link.from === name.replace(/([^/]*)$/, "_rels/$1.rels")).map((link) => link.id));
      for (const used of xml.matchAll(/\br:id="([^"]+)"/g)) assert.ok(own.has(used[1]), `${name} uses ${used[1]}, which it does not have`);
    }
  }
});

test("the presentation lists its master, its slides in order with their own ids, and the size of a 16:9 slide", () => {
  const parts = partsOf(build(plain));
  const presentation = parts.get("ppt/presentation.xml")!;
  assert.match(presentation, /<p:sldSz cx="12192000" cy="6858000"\/>/);
  assert.match(presentation, /<p:notesSz cx="6858000" cy="9144000"\/>/);
  assert.match(presentation, /<p:sldMasterId id="2147483648" r:id="rId1"\/>/);
  assert.doesNotMatch(presentation, /notesMasterIdLst/);
  const ids = [...presentation.matchAll(/<p:sldId id="(\d+)" r:id="(rId\d+)"\/>/g)].map((match) => [Number(match[1]), match[2]]);
  assert.deepEqual(ids.map(([id]) => id), [256, 257, 258]);
  const rels = relationships(parts).filter((link) => link.from === "ppt/_rels/presentation.xml.rels");
  assert.deepEqual(ids.map(([, rid]) => rels.find((link) => link.id === rid)?.resolved), ["ppt/slides/slide1.xml", "ppt/slides/slide2.xml", "ppt/slides/slide3.xml"], "in order");
  assert.deepEqual(rels.map((link) => link.type).sort(), ["presProps", "slide", "slide", "slide", "slideMaster", "tableStyles", "theme", "viewProps"]);
});

test("with notes the presentation names its notes master, in the place the format puts it", () => {
  const parts = partsOf(build(withNotes));
  const presentation = parts.get("ppt/presentation.xml")!;
  const named = /<p:notesMasterIdLst><p:notesMasterId r:id="(rId\d+)"\/><\/p:notesMasterIdLst>/.exec(presentation);
  assert.ok(named, "the notes master is listed");
  assert.ok(presentation.indexOf("</p:sldMasterIdLst>") < presentation.indexOf("<p:notesMasterIdLst>"), "after the slide master");
  assert.ok(presentation.indexOf("</p:notesMasterIdLst>") < presentation.indexOf("<p:sldIdLst>"), "before the slides");
  const link = relationships(parts).find((entry) => entry.from === "ppt/_rels/presentation.xml.rels" && entry.id === named[1]);
  assert.equal(link?.type, "notesMaster");
  assert.equal(link?.resolved, "ppt/notesMasters/notesMaster1.xml");
  assert.match(parts.get("docProps/app.xml")!, /<Notes>2<\/Notes>/);
});

test("a title slide uses the title layout and a slide the title and content layout, and each layout is in the master", () => {
  const parts = partsOf(build(plain));
  const layoutOf = (slide: number) => relationships(parts).find((link) => link.from === `ppt/slides/_rels/slide${slide}.xml.rels` && link.type === "slideLayout")?.resolved;
  assert.equal(layoutOf(1), "ppt/slideLayouts/slideLayout1.xml");
  assert.equal(layoutOf(2), "ppt/slideLayouts/slideLayout2.xml");
  assert.equal(layoutOf(3), "ppt/slideLayouts/slideLayout2.xml");
  assert.match(parts.get("ppt/slideLayouts/slideLayout1.xml")!, /<p:sldLayout [^>]*type="title"/);
  assert.match(parts.get("ppt/slideLayouts/slideLayout2.xml")!, /<p:sldLayout [^>]*type="obj"/);
  const master = parts.get("ppt/slideMasters/slideMaster1.xml")!;
  assert.match(master, /<p:sldLayoutId id="2147483649" r:id="rId1"\/><p:sldLayoutId id="2147483650" r:id="rId2"\/>/);
  const masterLinks = relationships(parts).filter((link) => link.from === "ppt/slideMasters/_rels/slideMaster1.xml.rels");
  assert.deepEqual(masterLinks.map((link) => [link.id, link.type, link.resolved]), [["rId1", "slideLayout", "ppt/slideLayouts/slideLayout1.xml"], ["rId2", "slideLayout", "ppt/slideLayouts/slideLayout2.xml"], ["rId3", "theme", "ppt/theme/theme1.xml"]]);
});

// ---------------------------------------------------------------- a slide's shapes

test("a title slide fills the title and subtitle placeholders, and its subtitle is a paragraph for each line", () => {
  const slide = partsOf(build(outline("# The Deck", "First line", "", "Second line"))).get("ppt/slides/slide1.xml")!;
  assert.match(slide, /<p:ph type="ctrTitle"\/>/);
  assert.match(slide, /<p:ph type="subTitle" idx="1"\/>/);
  assert.match(slide, /<a:t>The Deck<\/a:t>/);
  assert.equal([...slide.matchAll(/<a:t>(?:First|Second) line<\/a:t>/g)].length, 2);
  // No subtitle, no subtitle placeholder to leave empty.
  const bare = partsOf(build("# Alone\n\n## Next\n- x")).get("ppt/slides/slide1.xml")!;
  assert.doesNotMatch(bare, /subTitle/);
});

test("a slide fills the layout's title and its content placeholder, named the way the layout names them", () => {
  const slide = partsOf(build(plain)).get("ppt/slides/slide2.xml")!;
  assert.match(slide, /<p:ph type="title"\/>/);
  assert.match(slide, /<p:ph idx="1"\/>/, "the same as the layout's, with no type of its own");
  assert.doesNotMatch(slide, /<p:ph [^>]*type="body"/);
  assert.match(slide, /<a:normAutofit\/>/);
  // The shape ids on a slide are not repeated.
  const ids = [...slide.matchAll(/<p:cNvPr id="(\d+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length);
});

test("a title is set at the size its length calls for, and an empty one leaves an empty paragraph", () => {
  const long = "w".repeat(120);
  const slide = partsOf(build(`## ${long}\n- x\n\n## Short\n- y`)).get("ppt/slides/slide1.xml")!;
  assert.match(slide, new RegExp(`<a:rPr lang="en-US" sz="${titleSize(long, false) * 100}" dirty="0"/><a:t>${long}</a:t>`));
  const slides = slidesOf("- just text", "Named");
  const untitled = partsOf(pptxFile(slides, { title: "Named", date: when })).get("ppt/slides/slide2.xml")!;
  assert.match(untitled, /<p:ph type="title"\/>[\s\S]*?<a:p><a:endParaRPr lang="en-US" sz="3600" dirty="0"\/><\/a:p>/);
});

test("bullets keep their levels, numbers start where the list does, and a checklist has its boxes and no bullets", () => {
  const slide = partsOf(build(outline("## L", "- top", "  - second", "    - third", "", "Then:", "", "3. three", "4. four", "", "Again:", "", "1. one", "", "And:", "", "- [x] done"))).get("ppt/slides/slide1.xml")!;
  const paragraphs = [...slide.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)].map((match) => match[1]);
  const find = (word: string) => paragraphs.find((paragraph) => paragraph.includes(`<a:t>${word}</a:t>`))!;
  assert.doesNotMatch(find("top"), /<a:pPr/, "the first level takes the master's bullet");
  assert.match(find("second"), /^<a:pPr lvl="1"\/>/);
  assert.match(find("third"), /^<a:pPr lvl="2"\/>/);
  assert.match(find("three"), /<a:buAutoNum type="arabicPeriod" startAt="3"\/>/);
  assert.match(find("four"), /<a:buAutoNum type="arabicPeriod" startAt="4"\/>/);
  assert.match(find("one"), /<a:buAutoNum type="arabicPeriod"\/>/, "one is where numbering starts, so it is left to start there");
  assert.match(paragraphs.find((paragraph) => paragraph.includes("done"))!, /<a:buNone\/>/);
  assert.match(paragraphs.find((paragraph) => paragraph.includes("done"))!, /\u2611 done/);
});

test("a quote is italic and set apart, code is in Consolas with its blank lines kept, and a paragraph has no bullet", () => {
  const slide = partsOf(build(outline("## Mixed", "A paragraph.", "", "> A quote", "", "```", "a = 1;", "", "b = 2;", "```"))).get("ppt/slides/slide1.xml")!;
  assert.match(slide, /<a:pPr marL="0" indent="0"><a:spcBef><a:spcPts val="600"\/><\/a:spcBef><a:buNone\/><\/a:pPr><a:r><a:rPr lang="en-US" sz="\d+" dirty="0"\/><a:t>A paragraph\.<\/a:t>/);
  assert.match(slide, /<a:pPr marL="342900" indent="0">[\s\S]*?<a:rPr lang="en-US" sz="\d+" i="1" dirty="0"><a:solidFill><a:srgbClr val="3D4654"\/><\/a:solidFill><\/a:rPr><a:t>A quote<\/a:t>/);
  // Six points smaller than the 28 the slide's text is set at.
  assert.match(slide, /<a:rPr lang="en-US" sz="2200" dirty="0"><a:solidFill><a:srgbClr val="14233C"\/><\/a:solidFill><a:latin typeface="Consolas"\/><a:cs typeface="Consolas"\/><\/a:rPr><a:t>a = 1;<\/a:t>/);
  assert.match(slide, /<a:p><a:pPr marL="0" indent="0"><a:buNone\/><\/a:pPr><a:endParaRPr lang="en-US" sz="2200" dirty="0"\/><\/a:p>/, "the blank line between is a paragraph");
});

test("bold, italic, strike, code and links in a line are kept; a link goes through a relationship and shares one for the same address", () => {
  const source = outline("## Styles", "- **bold** *italic* ~~gone~~ `code` [site](https://example.com/a?x=1&y=2) and [again](https://example.com/a?x=1&y=2) and [other](https://example.org)");
  const parts = partsOf(build(source));
  const slide = parts.get("ppt/slides/slide1.xml")!;
  assert.match(slide, /b="1" dirty="0"\/><a:t>bold<\/a:t>/);
  assert.match(slide, /i="1" dirty="0"\/><a:t>italic<\/a:t>/);
  assert.match(slide, /strike="sngStrike" dirty="0"\/><a:t>gone<\/a:t>/);
  assert.match(slide, /<a:latin typeface="Consolas"\/><a:cs typeface="Consolas"\/><\/a:rPr><a:t>code<\/a:t>/);
  const links = relationships(parts).filter((link) => link.from === "ppt/slides/_rels/slide1.xml.rels" && link.type === "hyperlink");
  assert.deepEqual(links.map((link) => [link.target, link.external]), [["https://example.com/a?x=1&y=2", true], ["https://example.org", true]], "the same address is one relationship");
  assert.equal([...slide.matchAll(new RegExp(`<a:hlinkClick r:id="${links[0].id}"/>`, "g"))].length, 2);
  assert.match(parts.get("ppt/slides/_rels/slide1.xml.rels")!, /Target="https:\/\/example\.com\/a\?x=1&amp;y=2" TargetMode="External"/);
});

test("a link that is not to the web, a mail address, a phone number or the page is text, and so is one within the page", () => {
  const source = outline("## Links", "- [bad](javascript:alert(1)) [file](file:///C:/x) [there](#top) [mail](mailto:a@b.co)");
  const parts = partsOf(build(source));
  const slide = parts.get("ppt/slides/slide1.xml")!;
  const links = relationships(parts).filter((link) => link.type === "hyperlink");
  assert.deepEqual(links.map((link) => link.target), ["mailto:a@b.co"]);
  assert.equal([...slide.matchAll(/<a:hlinkClick /g)].length, 1);
  for (const word of ["bad", "file", "there"]) assert.match(slide, new RegExp(`<a:t>${word}</a:t>`));
});

test("a table is a graphic frame with a column for each header, a row for each row, a shaded header and the alignment it was given", () => {
  const slide = partsOf(build(outline("## Prices", "| Plan | Price | Note |", "|:--|--:|:-:|", "| Free | $0 | a |", "| Team | $12 | b |"))).get("ppt/slides/slide1.xml")!;
  assert.match(slide, /<p:graphicFrame>[\s\S]*<a:tbl><a:tblPr firstRow="1" bandRow="1"\/>/);
  assert.equal([...slide.matchAll(/<a:gridCol w="\d+"\/>/g)].length, 3);
  assert.equal([...slide.matchAll(/<a:tr h="\d+">/g)].length, 3);
  assert.equal([...slide.matchAll(/<a:tc>/g)].length, 9);
  const columns = [...slide.matchAll(/<a:gridCol w="(\d+)"\/>/g)].map((match) => Number(match[1]));
  assert.ok(columns.every((width) => width > 0));
  assert.ok(Math.abs(columns.reduce((a, b) => a + b, 0) - 10_515_600) < 4, "the columns fill the width of the body");
  assert.equal([...slide.matchAll(/<a:srgbClr val="EAEFF6"\/>/g)].length, 3, "the header cells are shaded");
  assert.equal([...slide.matchAll(/<a:pPr algn="r"\/>/g)].length, 3, "a right-aligned column is right-aligned in its three cells");
  assert.equal([...slide.matchAll(/<a:pPr algn="ctr"\/>/g)].length, 3);
  assert.match(slide, /b="1" dirty="0"><a:solidFill><a:srgbClr val="14233C"\/><\/a:solidFill><\/a:rPr><a:t>Plan<\/a:t>/, "the header is bold");
});

test("a table starts where the body placeholder does, and its rows are as tall as the measures say and add up to its frame", () => {
  const source = outline("## T", "| Name | Note |", "|---|---|", "| a | short |", "| b | " + "long words go on ".repeat(12) + " |");
  const parts = partsOf(build(source));
  const master = parts.get("ppt/slideMasters/slideMaster1.xml")!;
  const body = /<p:ph type="body" idx="1"\/><\/p:nvPr><\/p:nvSpPr><p:spPr><a:xfrm><a:off x="(\d+)" y="(\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(master)!;
  const slide = parts.get("ppt/slides/slide1.xml")!;
  const frame = /<p:xfrm><a:off x="(\d+)" y="(\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/><\/p:xfrm>/.exec(slide)!;
  assert.equal(frame[1], body[1], "the same left edge");
  assert.equal(frame[2], body[2], "the same top");
  assert.ok(Math.abs(Number(frame[3]) - Number(body[3])) < 4, "the same width, to the rounding of its columns");
  const heights = [...slide.matchAll(/<a:tr h="(\d+)">/g)].map((match) => Number(match[1]));
  const first = slidesOf(source)[0];
  const table = first.kind === "content" ? first.content[0] : undefined;
  assert.equal(table?.kind, "table");
  assert.deepEqual(heights, rowHeights(table as Table).map((points) => Math.round(points * 12_700)));
  assert.equal(heights.reduce((a, b) => a + b, 0), Number(frame[4]), "the frame is its rows");
  assert.ok(heights[2] > heights[1], "a row of words that wrap is taller");
});

test("a placeholder's own list style carries the sizes its runs are set at", () => {
  const slide = partsOf(build(outline("## Plan", "- a", "  - b", "    - c"))).get("ppt/slides/slide1.xml")!;
  const title = /<p:ph type="title"\/>[\s\S]*?<a:lstStyle><a:lvl1pPr><a:defRPr sz="(\d+)"\/><\/a:lvl1pPr><\/a:lstStyle><a:p><a:r><a:rPr lang="en-US" sz="(\d+)" dirty="0"\/>/.exec(slide)!;
  assert.equal(title[1], title[2]);
  const body = /<p:ph idx="1"\/>[\s\S]*?<a:lvl1pPr><a:defRPr sz="(\d+)"\/><\/a:lvl1pPr><a:lvl2pPr><a:defRPr sz="(\d+)"\/><\/a:lvl2pPr><a:lvl3pPr><a:defRPr sz="(\d+)"\/><\/a:lvl3pPr>/.exec(slide)!;
  const [first, second, third] = body.slice(1).map(Number);
  assert.equal(first - second, 200);
  assert.equal(second - third, 200);
  const runs = ["a", "b", "c"].map((letter) => Number(new RegExp(`<a:rPr lang="en-US" sz="(\\d+)" dirty="0"/><a:t>${letter}</a:t>`).exec(slide)![1]));
  assert.deepEqual(runs, [first, second, third]);
});

test("a link in a table cell keeps the theme's link colour, not the cell's", () => {
  const slide = partsOf(build(outline("## T", "| a |", "|---|", "| [site](https://example.com) and more |"))).get("ppt/slides/slide1.xml")!;
  assert.match(slide, /<a:rPr lang="en-US" sz="\d+" dirty="0"><a:hlinkClick r:id="rId\d+"\/><\/a:rPr><a:t>site<\/a:t>/);
  assert.match(slide, /<a:rPr lang="en-US" sz="\d+" dirty="0"><a:solidFill><a:srgbClr val="1C1C1E"\/><\/a:solidFill><\/a:rPr><a:t> and more<\/a:t>/);
});

test("the master gives each level its margin, its bullet and its size, which the slides take theirs from", () => {
  const master = partsOf(build(plain)).get("ppt/slideMasters/slideMaster1.xml")!;
  const level = (n: number) => new RegExp(`<a:lvl${n}pPr marL="(\\d+)" indent="(-?\\d+)"[^>]*><a:lnSpc><a:spcPct val="100000"/></a:lnSpc><a:spcBef><a:spcPts val="(\\d+)"/></a:spcBef><a:buFont typeface="Arial"/><a:buChar char="([^"]+)"/><a:defRPr sz="(\\d+)"`).exec(master)!.slice(1);
  assert.deepEqual(level(1), ["342900", "-342900", "1000", "&#8226;", "2800"]);
  assert.deepEqual(level(2), ["800100", "-342900", "500", "&#8211;", "2400"]);
  assert.deepEqual(level(3), ["1257300", "-342900", "500", "&#8226;", "2000"]);
  assert.match(master, /<p:titleStyle><a:lvl1pPr algn="l"[^>]*>[\s\S]*?<a:defRPr sz="3600" b="1"/);
});

test("a numbered step nested in another is indented by the step's margin, and an empty cell is an empty paragraph of its size", () => {
  const nested = partsOf(build(outline("## N", "1. one", "   1. nested"))).get("ppt/slides/slide1.xml")!;
  assert.match(nested, /<a:pPr marL="457200" indent="-457200" lvl="0">[\s\S]*?<a:t>one<\/a:t>/);
  assert.match(nested, /<a:pPr marL="857250" indent="-457200" lvl="1">[\s\S]*?<a:t>nested<\/a:t>/);
  const empty = partsOf(build(outline("## T", "| a | b |", "|---|---|", "| 1 |  |"))).get("ppt/slides/slide1.xml")!;
  assert.match(empty, /<a:tc><a:txBody><a:bodyPr\/><a:lstStyle\/><a:p><a:endParaRPr lang="en-US" sz="1600" dirty="0"\/><\/a:p><\/a:txBody>/);
});

test("the shapes on a slide, whatever is on it, each have an id of their own", () => {
  const slide = partsOf(build(outline("## Mixed", "Above.", "", "| a |", "|---|", "| 1 |", "", "| b |", "|---|", "| 2 |", "", "Below."))).get("ppt/slides/slide1.xml")!;
  const ids = [...slide.matchAll(/<p:cNvPr id="(\d+)"/g)].map((match) => match[1]);
  assert.equal(ids.length, 6, "the group, the title, the text, two tables and the text below");
  assert.equal(new Set(ids).size, ids.length, ids.join(","));
  assert.deepEqual([...slide.matchAll(/<p:cNvPr id="\d+" name="([^"]*)"/g)].map((match) => match[1]), ["", "Title 1", "Content Placeholder 2", "Table 4", "Table 5", "Text 6"]);
});

test("text after a table goes below it, in a text box that carries its own bullets", () => {
  const slide = partsOf(build(outline("## Prices", "Above the table.", "", "| a | b |", "|---|---|", "| 1 | 2 |", "", "- below one", "- below two", "", "Below too."))).get("ppt/slides/slide1.xml")!;
  const order = ["Above the table.", "<a:tbl>", "below one", "Below too."].map((marker) => slide.indexOf(marker));
  assert.ok(order.every((at, index) => at >= 0 && (index === 0 || at > order[index - 1])), `in order: ${order}`);
  assert.match(slide, /<p:cNvSpPr txBox="1"\/>/);
  assert.match(slide, /<a:buFont typeface="Arial"\/><a:buChar char="&#8226;"\/>/, "a text box has no master to take its bullets from");
  // The text above the table has a frame of its own, and the one below is placed beneath the table's.
  const offsets = [...slide.matchAll(/<a:off x="838200" y="(\d+)"\/><a:ext cx="\d+" cy="(\d+)"\/>/g)].map((match) => [Number(match[1]), Number(match[2])]);
  assert.equal(offsets.length, 3);
  assert.ok(offsets[1][0] >= offsets[0][0] + offsets[0][1], "the table is below the text");
  assert.ok(offsets[2][0] >= offsets[1][0] + offsets[1][1], "the note is below the table");
});

test("a text box after a table has the right bullet for each level, and numbers where it was numbered", () => {
  const slide = partsOf(build(outline("## T", "| a |", "|---|", "| 1 |", "", "- top", "  - second", "", "2. two"))).get("ppt/slides/slide1.xml")!;
  assert.match(slide, /<a:pPr marL="342900" indent="-342900" lvl="0"><a:spcBef><a:spcPts val="1000"\/><\/a:spcBef><a:buFont typeface="Arial"\/><a:buChar char="&#8226;"\/><\/a:pPr><a:r><a:rPr[^>]*\/><a:t>top<\/a:t>/);
  assert.match(slide, /<a:pPr marL="800100" indent="-342900" lvl="1"><a:spcBef><a:spcPts val="500"\/><\/a:spcBef><a:buFont typeface="Arial"\/><a:buChar char="&#8211;"\/><\/a:pPr><a:r><a:rPr[^>]*sz="\d+"[^>]*\/><a:t>second<\/a:t>/);
  assert.match(slide, /<a:buAutoNum type="arabicPeriod" startAt="2"\/>/);
});

// ---------------------------------------------------------------- notes pages

test("a notes page holds the notes in the notes placeholder, a paragraph to a line, and belongs to its slide and the notes master", () => {
  const parts = partsOf(build(outline("## A", "- x", "", "Notes: first line", "", "Second & third <line>")));
  const notes = parts.get("ppt/notesSlides/notesSlide1.xml")!;
  assert.match(notes, /<a:spLocks noGrp="1" noRot="1" noChangeAspect="1"\/><\/p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"\/>/, "the picture of the slide keeps its shape");
  assert.match(notes, /<p:ph type="body" sz="quarter" idx="3"\/>/);
  assert.match(notes, /<a:t>first line<\/a:t>[\s\S]*<a:t>Second &amp; third &lt;line&gt;<\/a:t>/);
  const own = relationships(parts).filter((link) => link.from === "ppt/notesSlides/_rels/notesSlide1.xml.rels");
  assert.deepEqual(own.map((link) => [link.type, link.resolved]), [["notesMaster", "ppt/notesMasters/notesMaster1.xml"], ["slide", "ppt/slides/slide1.xml"]]);
  const back = relationships(parts).find((link) => link.from === "ppt/slides/_rels/slide1.xml.rels" && link.type === "notesSlide");
  assert.equal(back?.resolved, "ppt/notesSlides/notesSlide1.xml");
  const master = parts.get("ppt/notesMasters/notesMaster1.xml")!;
  for (const placeholder of ['type="hdr"', 'type="dt"', 'type="sldImg"', 'type="body"', 'type="ftr"', 'type="sldNum"']) assert.ok(master.includes(placeholder), placeholder);
  assert.equal(relationships(parts).find((link) => link.from === "ppt/notesMasters/_rels/notesMaster1.xml.rels")?.resolved, "ppt/theme/theme2.xml");
});

test("the notes page of a slide that has links in it does not take a link's relationship id", () => {
  const parts = partsOf(build(outline("## A", "- [one](https://example.com)", "", "Notes: n")));
  const slideLinks = relationships(parts).filter((link) => link.from === "ppt/slides/_rels/slide1.xml.rels");
  assert.deepEqual(slideLinks.map((link) => link.type).sort(), ["hyperlink", "notesSlide", "slideLayout"]);
  assert.equal(new Set(slideLinks.map((link) => link.id)).size, 3);
});

// ---------------------------------------------------------------- read back

test("what is written is read back as it was, slide by slide, with the notes that go with it", () => {
  const slides = slidesOf(outline("# Deck", "Sub", "", "Notes: opening", "", "## One", "- a", "  - b", "", "Notes: for one", "", "## Two", "| h | i |", "|---|---|", "| 1 | 2 |"));
  const read = readSlides(pptxFile(slides, { title: "Deck", date: when }));
  assert.deepEqual(read.map((slide) => slide.number), [1, 2, 3]);
  assert.deepEqual(read.map((slide) => slide.text), ["Deck\nSub", "One\na\nb", "Two\nh\ni\n1\n2"]);
  assert.deepEqual(read.map((slide) => slide.notes), ["opening", "for one", ""]);
});

test("special characters, other scripts and emoji survive, and characters XML cannot hold are left out", () => {
  const tricky = `Fish & chips < "quotes" > 'apostrophes' &amp; \u00dcn\u00efc\u00f6d\u00e9 \u65e5\u672c\u8a9e \ud83d\ude80 end`;
  const slides = slidesOf(`## T\n- ${tricky}`);
  const bullet = readSlides(pptxFile(slides, { title: "T", date: when }))[0].text.split("\n")[1];
  assert.equal(bullet, tricky);
  const control = readSlides(pptxFile([{ kind: "content", title: "A\u0001B\u000bC", content: [{ kind: "text", inlines: [{ kind: "text", text: "x\u0000y\u001fz\ufffe!" }] }], notes: ["n\u0002o"] }], { title: "t", date: when }))[0];
  assert.equal(control.text, "ABC\nxyz!");
  assert.equal(control.notes, "no");
});

test("a line break inside a paragraph is a line break when it is read", () => {
  const slides = slidesOf("## T\n- first<br>second\n- third");
  assert.deepEqual(readSlides(pptxFile(slides, { title: "T", date: when }))[0].text.split("\n"), ["T", "first", "second", "third"]);
});

test("the same slides on the same day make the same file, and another day makes another", () => {
  const slides = slidesOf(withNotes);
  const same = [pptxFile(slides, { title: "Deck", date: when }), pptxFile(slides, { title: "Deck", date: when })];
  assert.ok(same[0].equals(same[1]));
  assert.ok(!same[0].equals(pptxFile(slides, { title: "Deck", date: new Date(Date.UTC(2027, 0, 2)) })));
});

test("the document's properties carry its title and author, escaped, and its date", () => {
  const parts = partsOf(pptxFile(slidesOf(plain), { title: "A & B <Plan>", author: 'Ann "the" Author', date: when }));
  const core = parts.get("docProps/core.xml")!;
  assert.match(core, /<dc:title>A &amp; B &lt;Plan&gt;<\/dc:title>/);
  assert.match(core, /<dc:creator>Ann &quot;the&quot; Author<\/dc:creator>/);
  assert.match(core, /<dcterms:created xsi:type="dcterms:W3CDTF">2026-10-25T12:00:00Z<\/dcterms:created>/);
  assert.match(parts.get("docProps/app.xml")!, /<Slides>3<\/Slides>/);
  assert.match(partsOf(pptxFile(slidesOf(plain), { title: "T", date: when })).get("docProps/core.xml")!, /<dc:creator>TRH AI<\/dc:creator>/);
});

test("a presentation with no slides cannot be written", () => {
  assert.throws(() => pptxFile([], { title: "Empty" }), /at least one slide/);
});

test("a deck of two hundred slides is written and read back whole", () => {
  const source = Array.from({ length: 200 }, (_, index) => `## Slide ${index + 1}\n- point ${index + 1}\n\nNotes: note ${index + 1}`).join("\n\n");
  const slides = slidesOf(source);
  assert.equal(slides.length, 200);
  const bytes = pptxFile(slides, { title: "Big", date: when });
  const read = readSlides(bytes);
  assert.equal(read.length, 200);
  assert.deepEqual(read[199], { number: 200, text: "Slide 200\npoint 200", notes: "note 200" });
  const parts = partsOf(bytes);
  assert.ok(parts.has("ppt/notesSlides/notesSlide200.xml"));
  assert.match(parts.get("ppt/presentation.xml")!, /<p:sldId id="455" r:id="rId201"\/>/);
});
