import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseDeck, type Slide } from "../src/services/deckData.js";
import { readSlides } from "../src/services/documentText.js";
import type { renderPdfs } from "../src/services/frameRenderer.js";
import { describeMadePresentation, makePresentation, parsePresentationFormats, slideLines } from "../src/services/presentationMaker.js";
import { pptxFile } from "../src/services/pptxWriter.js";
import { pagedPdf, tinyPdf } from "./helpers/pdf.js";

// Making a presentation: what is asked for and how a model words it, the files made and their names, and above all the check -
// each file read back and compared with what was meant, so that nothing that is wrong is called right.

const folder = mkdtempSync(path.join(tmpdir(), "trhai-presentation-maker-"));
let counter = 0;
const fresh = () => path.join(folder, `case-${(counter += 1)}`, "documents");
process.on("exit", () => rmSync(folder, { recursive: true, force: true }));

const outline = (...lines: string[]) => lines.join("\n");
const sample = outline(
  "# Board Update", "Q3 numbers", "",
  "## Highlights", "- Revenue up 12%", "- Churn down to 2.1%", "", "Notes: open with revenue", "",
  "## Pricing", "| Plan | Price |", "|---|--:|", "| Free | $0 |", "| Team | $12 |", "", "Prices exclude tax.", "",
  "## Next steps", "1. Ship the beta", "2. Launch the product to everyone in March"
);
const slidesOf = (source: string): Slide[] => { const read = parseDeck(source); assert.ok(read.ok); return read.ok ? read.deck.slides : []; };

/** The lines of text in some HTML, a line to each tag. */
const linesOf = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, "\n").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&").split("\n").map((line) => line.trim()).filter(Boolean);

/** A stand-in for printing that writes a real, readable PDF with a page for each slide of the page it was handed, holding that slide's own text. */
const printing = (change?: (pages: string[][]) => string[][]): typeof renderPdfs => async (jobs) => {
  for (const job of jobs) {
    const pages = [...job.html.matchAll(/<section class="slide[^"]*">([\s\S]*?)<\/section>/g)].map((match) => linesOf(match[1]));
    writeFileSync(job.outputPath, pagedPdf(change ? change(pages) : pages));
  }
  return { ok: true, rendered: jobs.length };
};

// ---------------------------------------------------------------- what was asked for

test("the formats asked for are understood the way a model says them, and nothing asked for is PowerPoint", () => {
  const formats = (value: unknown) => { const parsed = parsePresentationFormats(value); return parsed.ok ? parsed.formats : parsed.reason; };
  assert.deepEqual(formats(undefined), ["pptx"]);
  assert.deepEqual(formats(""), ["pptx"]);
  for (const word of ["pptx", "PPTX", ".pptx", "ppt", "PowerPoint", "Power Point", "power-point", "Microsoft PowerPoint", "slides", "slideshow", "slide show", "slide-show", "a slide deck", "presentation", "keynote", "deck"]) assert.deepEqual(formats(word), ["pptx"], word);
  assert.deepEqual(formats("PDF"), ["pdf"]);
  assert.deepEqual(formats("powerpoint and pdf"), ["pptx", "pdf"]);
  assert.deepEqual(formats("a PowerPoint file and a PDF"), ["pptx", "pdf"]);
  assert.deepEqual(formats("pdf, pptx"), ["pdf", "pptx"]);
  assert.deepEqual(formats(["pptx", "PDF", "pptx"]), ["pptx", "pdf"]);
  assert.deepEqual(formats("both"), ["pptx"], "a word of filler alone is not a format");
});

test("a format that does not exist is refused with the ones that do, not guessed at", () => {
  const refused = parsePresentationFormats("odp");
  assert.equal(refused.ok, false);
  assert.match((refused as { reason: string }).reason, /"odp" is not a format I can make a presentation in\. I can make pptx \(PowerPoint presentation\) and pdf \(PDF\)\./);
  assert.equal(parsePresentationFormats("pptx and html").ok, false);
  assert.equal(parsePresentationFormats(42).ok, false);
  assert.equal(parsePresentationFormats({}).ok, false);
});

test("the lines on a slide are its title, then what is above its tables, the tables, and what is below, and never its notes", () => {
  const slides = slidesOf(sample);
  assert.deepEqual(slides.map(slideLines), [
    ["Board Update", "Q3 numbers"],
    ["Highlights", "Revenue up 12%", "Churn down to 2.1%"],
    ["Pricing", "Plan", "Price", "Free", "$0", "Team", "$12", "Prices exclude tax."],
    ["Next steps", "Ship the beta", "Launch the product to everyone in March"]
  ]);
  const mixed = slidesOf(outline("## M", "Intro.", "", "| a | b |", "|---|---|", "| 1 | 2 |", "", "Between?", "", "| c |", "|---|", "| 3 |", "", "After."));
  assert.deepEqual(slideLines(mixed[0]), ["M", "Intro.", "Between?", "a", "b", "1", "2", "c", "3", "After."]);
  assert.deepEqual(slideLines({ kind: "content", title: "", content: [], notes: ["n"] }), []);
  assert.deepEqual(slidesOf("# Deck\nline one\n\nline two\n\n## A\n- x").map(slideLines)[0], ["Deck", "line one", "line two"], "a subtitle is a line for each of its lines");
});

// ---------------------------------------------------------------- making files

test("a presentation is made in PowerPoint unless another format is asked for, named for its title, and read back", async () => {
  const directory = fresh();
  const result = await makePresentation({ content: sample, language: "en-US" }, directory);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.title, "Board Update");
  assert.equal(result.slides, 4);
  assert.equal(result.notes, 1);
  assert.equal(result.split, 0);
  assert.deepEqual(result.problems, []);
  assert.equal(result.files.length, 1);
  const [file] = result.files;
  assert.equal(file.format, "pptx");
  assert.equal(file.name, "Board Update.pptx");
  assert.equal(file.path, path.join(directory, "Board Update.pptx"));
  assert.equal(file.checked, true);
  assert.ok(file.bytes > 5000);
  assert.deepEqual(readdirSync(directory), ["Board Update.pptx"]);
  const read = readSlides(readFileSync(file.path));
  assert.deepEqual(read.map((slide) => slide.text.split("\n")[0]), ["Board Update", "Highlights", "Pricing", "Next steps"]);
  assert.equal(read[1].notes, "open with revenue");
});

test("PowerPoint and a PDF are made together under the same name, and the PDF has a page for each slide", async () => {
  const directory = fresh();
  const result = await makePresentation({ content: sample, formats: ["pdf", "pptx"], language: "en-US" }, directory, { renderPdfsFn: printing() });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.files.map((file) => file.name), ["Board Update.pdf", "Board Update.pptx"], "in the order asked");
  assert.ok(result.files.every((file) => file.checked));
  assert.equal(result.files[0].pages, 4);
  assert.equal(result.files[1].pages, undefined);
  assert.deepEqual(result.problems, []);
});

test("the page handed to the printer is the deck's own, with the language it was made in", async () => {
  let seen: { html: string; outputPath: string } | null = null;
  const watching: typeof renderPdfs = async (jobs, options) => {
    seen = { html: jobs[0].html, outputPath: jobs[0].outputPath };
    assert.equal(jobs.length, 1);
    assert.equal(options?.timeoutMs, 180_000);
    return printing()(jobs, options);
  };
  const directory = fresh();
  await makePresentation({ content: sample, formats: ["pdf"], language: "fr-FR" }, directory, { renderPdfsFn: watching });
  assert.ok(seen);
  const handed = seen as { html: string; outputPath: string };
  assert.match(handed.html, /<html lang="fr-FR">/);
  assert.match(handed.html, /<title>Board Update<\/title>/);
  assert.equal([...handed.html.matchAll(/<section class="slide/g)].length, 4);
  assert.equal(handed.outputPath, path.join(directory, "Board Update.pdf"));
});

test("a title that was given names the file and the deck, over the heading the outline has", async () => {
  const given = await makePresentation({ content: sample, title: "  Board   Pitch  " }, fresh());
  assert.ok(given.ok);
  if (given.ok) {
    assert.equal(given.title, "Board Pitch");
    assert.equal(given.files[0].name, "Board Pitch.pptx");
  }
  const untitled = await makePresentation({ content: "## Alpha\n- a" }, fresh());
  assert.ok(untitled.ok);
  if (untitled.ok) assert.equal(untitled.files[0].name, "Alpha.pptx", "the first slide's title when there is nothing else");
  const named = await makePresentation({ content: "## Alpha\n- a", title: "Named" }, fresh());
  assert.ok(named.ok);
  if (named.ok) assert.equal(named.slides, 2, "a title that was given adds the title slide the outline had none of");
});

test("a file is never replaced: the next is numbered, and the files of one deck share a number", async () => {
  const directory = fresh();
  await makePresentation({ content: sample, formats: ["pdf"] }, directory, { renderPdfsFn: printing() });
  const before = readFileSync(path.join(directory, "Board Update.pdf"));
  const second = await makePresentation({ content: sample, formats: ["pptx", "pdf"] }, directory, { renderPdfsFn: printing() });
  assert.ok(second.ok);
  if (!second.ok) return;
  assert.deepEqual(second.files.map((file) => file.name), ["Board Update (2).pptx", "Board Update (2).pdf"]);
  assert.equal(existsSync(path.join(directory, "Board Update.pptx")), false, "the number was not spent on a lone PowerPoint file");
  assert.deepEqual(readFileSync(path.join(directory, "Board Update.pdf")), before);
  const third = await makePresentation({ content: sample }, directory);
  assert.ok(third.ok);
  assert.deepEqual(readdirSync(directory).sort(), ["Board Update (2).pdf", "Board Update (2).pptx", "Board Update.pdf", "Board Update.pptx"], "a file alone takes the first name that is free for its own kind");
});

test("presentations made at the same moment are never given the same name", async () => {
  const directory = fresh();
  const results = await Promise.all(Array.from({ length: 6 }, () => makePresentation({ content: sample, formats: ["pptx", "pdf"] }, directory, { renderPdfsFn: printing() })));
  assert.ok(results.every((result) => result.ok));
  const names = results.flatMap((result) => (result.ok ? result.files.map((file) => file.name) : []));
  assert.equal(new Set(names).size, 12, names.join(", "));
  assert.equal(readdirSync(directory).length, 12);
});

test("a slide that was split says so, and the file has the slides it was split into", async () => {
  const content = outline("## Long", ...Array.from({ length: 14 }, (_, index) => `- Point number ${index + 1} has a few words to make it a real line of text`));
  const result = await makePresentation({ content, title: "Splits" }, fresh());
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.slides, 3, "the title slide and two");
  assert.equal(result.split, 1);
  const told = describeMadePresentation(result, (absolute) => path.basename(absolute));
  assert.match(told, /Note: 1 slide was added because some of the slides had more on them than fits on one; each is named after the slide it continues, like "Plan \(2\)"\./);
  assert.equal(readSlides(readFileSync(result.files[0].path))[2].text.split("\n")[0], "Long (2)");
});

// ---------------------------------------------------------------- what is wrong with a file is not passed over

test("a PowerPoint file with a slide missing is kept, and said to have one, and is not called checked", async () => {
  const directory = fresh();
  const result = await makePresentation({ content: sample }, directory, { writePptx: (slides, options) => pptxFile(slides.slice(0, -1), options) });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.files[0].checked, false);
  assert.equal(existsSync(result.files[0].path), true);
  assert.deepEqual(result.problems, ["The PowerPoint presentation Board Update.pptx: it has 3 slides where 4 were written; open it and look before relying on it."]);
  assert.doesNotMatch(describeMadePresentation(result), /read each file back to check every slide/, "the all-clear is not given");
});

test("a word that is different on a slide is named, with the slide and the words around it", async () => {
  const changed = (slides: Slide[]) => slides.map((slide) => (slide.kind === "content" && slide.title === "Highlights"
    ? { ...slide, content: [{ kind: "text" as const, inlines: [{ kind: "text" as const, text: "Revenue up 13%" }] }] }
    : slide));
  const result = await makePresentation({ content: sample }, fresh(), { writePptx: (slides, options) => pptxFile(changed(slides), options) });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.files[0].checked, false);
  assert.match(result.problems[0], /^The PowerPoint presentation Board Update\.pptx: slide 2 \("Highlights"\) was written as "Revenue up 12% Churn down to" and read back as "Revenue up 13%"; open it and look/);
});

test("a file with a slide too many is not passed either, and a long title is named by its first forty letters", async () => {
  const extra = await makePresentation({ content: sample }, fresh(), { writePptx: (slides, options) => pptxFile([...slides, { kind: "content", title: "Surprise", content: [], notes: [] }], options) });
  assert.ok(extra.ok);
  if (extra.ok) {
    assert.equal(extra.files[0].checked, false);
    assert.match(extra.problems[0], /it has 5 slides where 4 were written/);
  }
  const longTitle = "A very long title that goes on well past forty letters in all";
  const altered = (slides: Slide[]) => slides.map((slide) => (slide.title === longTitle ? { ...slide, content: [{ kind: "text" as const, inlines: [{ kind: "text" as const, text: "changed" }] }] } : slide));
  const named = await makePresentation({ content: `## ${longTitle}\n- original`, title: "Long" }, fresh(), { writePptx: (slides, options) => pptxFile(altered(slides), options) });
  assert.ok(named.ok);
  if (named.ok) assert.match(named.problems[0], /slide 2 \("A very long title that goes on well past"\) was written as/);
});

test("the speaker's notes are checked as well, and a file that lost them is not passed", async () => {
  const result = await makePresentation({ content: sample }, fresh(), { writePptx: (slides, options) => pptxFile(slides.map((slide) => ({ ...slide, notes: [] })), options) });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.files[0].checked, false);
  assert.match(result.problems[0], /the speaker's notes on slide 2 \("Highlights"\) were written as "open with revenue" and read back as "nothing"/);
});

test("a slide that has an extra word, a missing word or the words in another order is not passed", async () => {
  const withText = (text: string) => (slides: Slide[]) => slides.map((slide) => (slide.kind === "content" && slide.title === "Next steps" ? { ...slide, content: [{ kind: "text" as const, inlines: [{ kind: "text" as const, text }] }] } : slide));
  for (const text of ["Ship the beta Launch the product to everyone in March now", "Ship the beta Launch the product to everyone in", "Launch the product to everyone in March Ship the beta"]) {
    const result = await makePresentation({ content: sample }, fresh(), { writePptx: (slides, options) => pptxFile(withText(text)(slides), options) });
    assert.ok(result.ok);
    if (result.ok) assert.equal(result.files[0].checked, false, text);
  }
  // The same words as one line or as two are the same words.
  const joined = await makePresentation({ content: sample }, fresh(), { writePptx: (slides, options) => pptxFile(withText("Ship the beta\nLaunch the product to everyone in March")(slides), options) });
  assert.ok(joined.ok && joined.files[0].checked);
});

test("a PowerPoint file that cannot be read back is removed, not handed over", async () => {
  const directory = fresh();
  const result = await makePresentation({ content: sample, formats: ["pptx", "pdf"] }, directory, { writePptx: () => Buffer.from("this is not a zip"), renderPdfsFn: printing() });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.files.map((file) => file.format), ["pdf"]);
  assert.match(result.problems[0], /^The PowerPoint presentation could not be made: it was written but could not be read back \(.+\), so it was removed\.$/);
  assert.deepEqual(readdirSync(directory), ["Board Update.pdf"]);
});

test("a writer that fails is reported and the other format is still made; when nothing can be made, it is a failure with nothing left behind", async () => {
  const directory = fresh();
  const boom = () => { throw new Error("boom"); };
  const some = await makePresentation({ content: sample, formats: ["pptx", "pdf"] }, directory, { writePptx: boom, renderPdfsFn: printing() });
  assert.ok(some.ok);
  if (some.ok) {
    assert.deepEqual(some.files.map((file) => file.name), ["Board Update.pdf"]);
    assert.deepEqual(some.problems, ["The PowerPoint presentation could not be made: boom"]);
  }
  const empty = fresh();
  const none = await makePresentation({ content: sample }, empty, { writePptx: boom });
  assert.equal(none.ok, false);
  assert.match((none as { reason: string }).reason, /The PowerPoint presentation could not be made: boom/);
  assert.deepEqual(readdirSync(empty), []);
  assert.equal(describeMadePresentation(none), `${(none as { reason: string }).reason} Nothing was made.`);
});

test("a PDF that cannot be printed is reported and the PowerPoint file is still made", async () => {
  const directory = fresh();
  const failing: typeof renderPdfs = async () => ({ ok: false, reason: "Electron exited with code 1.", rendered: 0 });
  const result = await makePresentation({ content: sample, formats: ["pptx", "pdf"] }, directory, { renderPdfsFn: failing });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.files.map((file) => file.name), ["Board Update.pptx"]);
  assert.deepEqual(result.problems, ["The PDF could not be made: Electron exited with code 1."]);
  assert.deepEqual(readdirSync(directory), ["Board Update.pptx"], "no empty PDF is left behind");
  assert.match(describeMadePresentation(result, (absolute) => path.basename(absolute)), /Note: The PDF could not be made: Electron exited with code 1\./);
  const alone = fresh();
  const only = await makePresentation({ content: sample, formats: ["pdf"] }, alone, { renderPdfsFn: failing });
  assert.equal(only.ok, false);
  assert.deepEqual(readdirSync(alone), []);
});

test("a PDF that cannot be read back is removed, and so is one that is empty or gone", async () => {
  const broken: typeof renderPdfs = async (jobs) => { for (const job of jobs) writeFileSync(job.outputPath, "%PDF-1.4\nthis is not a real document\n"); return { ok: true, rendered: jobs.length }; };
  const directory = fresh();
  const result = await makePresentation({ content: sample, formats: ["pptx", "pdf"] }, directory, { renderPdfsFn: broken });
  assert.ok(result.ok);
  if (result.ok) {
    assert.deepEqual(result.files.map((file) => file.format), ["pptx"]);
    assert.match(result.problems[0], /^The PDF could not be made: it was written but could not be read back \(.+\), so it was removed\.$/);
  }
  assert.deepEqual(readdirSync(directory), ["Board Update.pptx"]);
  const nothing: typeof renderPdfs = async (jobs) => ({ ok: true, rendered: jobs.length });
  const empty = await makePresentation({ content: sample, formats: ["pdf"] }, fresh(), { renderPdfsFn: nothing });
  assert.equal(empty.ok, false);
  assert.match((empty as { reason: string }).reason, /could not be read back \(The file is empty\)/);
  const vanishing: typeof renderPdfs = async (jobs) => { for (const job of jobs) rmSync(job.outputPath); return { ok: true, rendered: jobs.length }; };
  const gone = fresh();
  const vanished = await makePresentation({ content: sample, formats: ["pdf"] }, gone, { renderPdfsFn: vanishing });
  assert.equal(vanished.ok, false);
  assert.match((vanished as { reason: string }).reason, /The PDF could not be made: it was written but could not be opened again/);
  assert.deepEqual(readdirSync(gone), []);
});

test("a PDF with the wrong number of pages is kept and said to have them", async () => {
  const onePage: typeof renderPdfs = async (jobs) => { for (const job of jobs) writeFileSync(job.outputPath, tinyPdf(linesOf(job.html))); return { ok: true, rendered: jobs.length }; };
  const result = await makePresentation({ content: sample, formats: ["pdf"] }, fresh(), { renderPdfsFn: onePage });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.files[0].checked, false);
  assert.equal(result.files[0].pages, 1);
  assert.match(result.problems[0], /^The PDF Board Update\.pdf: it has 1 page for 4 slides; open it and look before sending it on\.$/);
  const manyPages = await makePresentation({ content: "## A\n- x", title: "One", formats: ["pdf"] }, fresh(), { renderPdfsFn: printing((pages) => [...pages, ["extra"]]) });
  assert.ok(manyPages.ok);
  if (manyPages.ok) assert.match(manyPages.problems[0], /it has 3 pages for 2 slides/);
});

test("a PDF that does not show the words on the slides is kept and said so, with the words that are missing", async () => {
  const without = (gone: string) => printing((pages) => pages.map((page) => page.filter((line) => line !== gone)));
  const result = await makePresentation({ content: sample, formats: ["pdf"] }, fresh(), { renderPdfsFn: without("Churn down to 2.1%") });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.files[0].checked, false);
  assert.match(result.problems[0], /^The PDF Board Update\.pdf: the words "Churn down to 2\.1%" were not found when it was read back; open it and look/);
  for (const gone of ["Board Update", "Q3 numbers", "Highlights", "Prices exclude tax.", "Ship the beta"]) {
    const missing = await makePresentation({ content: sample, formats: ["pdf"] }, fresh(), { renderPdfsFn: without(gone) });
    assert.ok(missing.ok);
    if (missing.ok) assert.equal(missing.files[0].checked, false, gone);
  }
});

test("a quote that is missing from the PDF is noticed like any other running text, and so is a second line of a subtitle", async () => {
  const content = outline("# Deck", "First subtitle line", "", "Second subtitle line", "", "## Wise", "> Less is more", "", "- a point");
  for (const gone of ["Less is more", "Second subtitle line"]) {
    const result = await makePresentation({ content, formats: ["pdf"] }, fresh(), { renderPdfsFn: printing((pages) => pages.map((page) => page.filter((line) => line !== gone))) });
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.files[0].checked, false, gone);
      assert.match(result.problems[0], new RegExp(`the words "${gone}" were not found`));
    }
  }
  const whole = await makePresentation({ content, formats: ["pdf"] }, fresh(), { renderPdfsFn: printing() });
  assert.ok(whole.ok && whole.files[0].checked);
});

test("a PDF of a deck of one slide that has two pages is said to have two pages for one slide", async () => {
  const result = await makePresentation({ content: "# Only a Title" , formats: ["pdf"] }, fresh(), { renderPdfsFn: printing((pages) => [...pages, ["extra"]]) });
  assert.ok(result.ok);
  if (result.ok) assert.match(result.problems[0], /it has 2 pages for 1 slide;/);
});

test("a title is kept to two hundred letters", async () => {
  const result = await makePresentation({ content: "## A\n- x", title: "T".repeat(300) }, fresh());
  assert.ok(result.ok);
  if (result.ok) assert.equal(result.title, "T".repeat(200));
  const own = await makePresentation({ content: `# ${"U".repeat(300)}\n\n## A\n- x` }, fresh());
  assert.ok(own.ok);
  if (own.ok) assert.equal(own.title, "U".repeat(200), "the same for the deck's own heading");
});

test("a PDF whose last slide is cut off at the end is not passed, though its start is there", async () => {
  const cut = printing((pages) => pages.map((page) => page.map((line) => (line === "Launch the product to everyone in March" ? "Launch the product to everyo" : line))));
  const result = await makePresentation({ content: sample, formats: ["pdf"] }, fresh(), { renderPdfsFn: cut });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.files[0].checked, false);
  assert.match(result.problems[0], /the end of the last slide, "Launch the product to everyone in March", was not found when it was read back/);
});

test("words woven together in a table do not fail a PDF, since a reader may return a table's cells in any order", async () => {
  const woven = printing((pages) => pages.map((page) => (page.includes("Plan") ? [...page.filter((line) => !["Plan", "Price", "Free", "$0", "Team", "$12"].includes(line)), "Plan Free Team Price $0 $12"] : page)));
  const result = await makePresentation({ content: sample, formats: ["pdf"] }, fresh(), { renderPdfsFn: woven });
  assert.ok(result.ok);
  if (result.ok) assert.equal(result.files[0].checked, true, result.problems.join(" "));
});

// ---------------------------------------------------------------- what cannot be made

test("an outline with nothing in it, with no slides in it, or too long is refused before anything is written", async () => {
  const directory = fresh();
  const cases: Array<[string, RegExp]> = [
    ["", /There was no outline to make a presentation from\./],
    ["   \n  ", /There was no outline/],
    ["---", /There were no slides in that outline\./],
    [`## Big\n${"- word\n".repeat(40_000)}`, /That is [\d,]+ letters; a presentation can be made from up to 200,000\./],
    [Array.from({ length: 201 }, (_, index) => `## S${index}`).join("\n"), /That comes to 201 slides; a presentation can be up to 200\./]
  ];
  for (const [content, pattern] of cases) {
    const result = await makePresentation({ content }, directory);
    assert.equal(result.ok, false, content.slice(0, 20));
    assert.match((result as { reason: string }).reason, pattern);
    assert.deepEqual((result as { problems: string[] }).problems, []);
  }
  assert.equal(existsSync(directory), false, "not even the folder was made");
});

test("a folder that cannot be made is said so", async () => {
  const blocker = path.join(folder, "blocker");
  mkdirSync(folder, { recursive: true });
  writeFileSync(blocker, "a file where a folder should be");
  const result = await makePresentation({ content: sample }, path.join(blocker, "documents"));
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /^The folder could not be made: /);
});

test("characters a file made of XML cannot hold are left out of it, and not mistaken for a difference when it is checked", async () => {
  // A bell and a NUL are dropped; a vertical tab and a form feed are spaces, since they were a break between words.
  const odd = outline("## A\u0001B", "- x\u000by\u000cz", "", "Notes: n\u0002o\u0000p");
  const result = await makePresentation({ content: odd, title: "Odd\u0003 Deck" }, fresh());
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.files[0].checked, true, result.problems.join(" "));
  assert.equal(result.title, "Odd Deck");
  const read = readSlides(readFileSync(result.files[0].path));
  assert.deepEqual(read[1], { number: 2, text: "AB\nx y z", notes: "nop" });
});

test("newlines sent as the letters backslash and n are made real, as for documents", async () => {
  const sent = "# Sent\\n\\nSub\\n\\n## One\\n\\n- a\\n- b";
  const result = await makePresentation({ content: sent }, fresh());
  assert.ok(result.ok);
  if (result.ok) assert.equal(result.slides, 2);
});

// ---------------------------------------------------------------- what to tell the person

test("what the person is told is each file by where it is, and the all-clear only when every file was checked", async () => {
  const result = await makePresentation({ content: sample, formats: ["pptx", "pdf"] }, fresh(), { renderPdfsFn: printing() });
  assert.ok(result.ok);
  if (!result.ok) return;
  const told = describeMadePresentation(result, (absolute) => `documents/${path.basename(absolute)}`);
  assert.equal(told, [
    'Made "Board Update", 4 slides, 1 slide with speaker notes, and read each file back to check every slide:',
    "- documents/Board Update.pptx (PowerPoint presentation, 4 slides)",
    "- documents/Board Update.pdf (PDF, 4 pages)"
  ].join("\n"));
  const one = await makePresentation({ content: "## Only\n- x", title: "Single" }, fresh());
  assert.ok(one.ok);
  if (one.ok) {
    assert.match(describeMadePresentation(one), /^Made "Single", 2 slides, and read each file back/);
    assert.doesNotMatch(describeMadePresentation(one), /speaker notes/);
  }
  const unchecked = { ...result, files: result.files.map((file, index) => ({ ...file, checked: index === 0 })), problems: ["something to look at"] };
  const doubt = describeMadePresentation(unchecked);
  assert.match(doubt, /^Made "Board Update", 4 slides, 1 slide with speaker notes:\n/);
  assert.match(doubt, /\nNote: something to look at$/);
});
