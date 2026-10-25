import test from "node:test";
import assert from "node:assert/strict";
import { docxFile, escapeXml } from "../src/services/docxWriter.js";
import { documentHtml, escapeHtml, safeHref } from "../src/services/documentHtml.js";
import { extractDocumentText, htmlText, readZip } from "../src/services/documentText.js";
import { parseMarkdown } from "../src/services/markdown.js";
import { assertWellFormed } from "./helpers/xml.js";

const when = new Date(Date.UTC(2026, 9, 25, 12, 0, 0));

const sample = [
  "# Quarterly Report",
  "Prepared for the **board** by *TRH AI*",
  "",
  "## Summary",
  "Sales rose 12% & margins held. See [the dashboard](https://example.com/q3?a=1&b=2) or write to <mailto:ops@example.com>.",
  "",
  "### Highlights",
  "- Launched the **music video** maker",
  "- Fixed `3` bugs",
  "  - one in lyrics",
  "  - one in the \"preview\"",
  "- Hired two people",
  "",
  "1. Plan",
  "2. Build",
  "3. Ship",
  "",
  "| Region | Sales | Change |",
  "|:--|--:|:-:|",
  "| North | 1,200 | +5% |",
  "| South & East | 900 | -2% |",
  "",
  "> Measure twice, cut once.",
  "",
  "---",
  "",
  "```js",
  "const total = a < b && b > c;",
  "```",
  "",
  "\\newpage",
  "",
  "## Appendix",
  "Last words."
].join("\n");

// ---------------------------------------------------------------- the web page

test("a document becomes a page that says what it said, with nothing it did not", () => {
  const html = documentHtml(parseMarkdown(sample), { title: "Quarterly Report" });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<title>Quarterly Report<\/title>/);
  assert.match(html, /@page \{ size: A4;/);
  assert.match(html, /<h1>Quarterly Report<\/h1>/);
  assert.match(html, /<strong>board<\/strong>/);
  assert.match(html, /<a href="https:\/\/example\.com\/q3\?a=1&amp;b=2">the dashboard<\/a>/);
  assert.match(html, /<a href="mailto:ops@example\.com">ops@example\.com<\/a>/);
  assert.match(html, /<ul><li>Launched the <strong>music video<\/strong> maker<\/li>/);
  assert.match(html, /<li>Fixed <code>3<\/code> bugs<ul><li>one in lyrics<\/li><li>one in the &quot;preview&quot;<\/li><\/ul><\/li>/);
  assert.match(html, /<ol><li>Plan<\/li><li>Build<\/li><li>Ship<\/li><\/ol>/);
  assert.match(html, /<th style="text-align:left">Region<\/th><th style="text-align:right">Sales<\/th><th style="text-align:center">Change<\/th>/);
  assert.match(html, /<td style="text-align:left">South &amp; East<\/td>/);
  assert.match(html, /<blockquote><p>Measure twice, cut once\.<\/p><\/blockquote>/);
  assert.match(html, /<hr>/);
  assert.match(html, /<pre><code>const total = a &lt; b &amp;&amp; b &gt; c;<\/code><\/pre>/);
  assert.match(html, /<div class="pagebreak"><\/div>/);
  // Read back as text, the page holds the words that were written and no markup.
  const text = htmlText(html);
  for (const words of ["Quarterly Report", "Sales rose 12% & margins held.", "one in lyrics", "South & East", "Measure twice, cut once.", "const total = a < b && b > c;", "Last words."]) assert.ok(text.includes(words), words);
});

test("a checklist shows its boxes without bullets, and a numbered list of tasks keeps its numbers", () => {
  const blocks = parseMarkdown("- [x] book the venue\n- [ ] send the agenda\n- plain item\n\n1. [ ] first\n2. [x] second");
  const html = documentHtml(blocks, { title: "x" });
  assert.match(html, /<ul><li class="task">☑ book the venue<\/li><li class="task">☐ send the agenda<\/li><li>plain item<\/li><\/ul>/);
  assert.match(html, /<ol><li>☐ first<\/li><li>☑ second<\/li><\/ol>/);
  assert.match(html, /li\.task \{ list-style: none;/);
  const xml = part(docxFile(blocks, { title: "x", date: when }), "word/document.xml");
  const paragraphs = xml.split("<w:p>").filter((chunk) => /[☐☑]/.test(chunk));
  assert.equal(paragraphs.length, 4);
  // The two bulleted tasks are indented where a bullet would be and have no numbering; the numbered ones keep theirs.
  for (const chunk of paragraphs.slice(0, 2)) {
    assert.match(chunk, /<w:pStyle w:val="ListParagraph"\/><w:ind w:left="360"\/>/);
    assert.doesNotMatch(chunk, /<w:numPr>/);
  }
  for (const chunk of paragraphs.slice(2)) assert.match(chunk, /<w:numPr><w:ilvl w:val="0"\/><w:numId w:val="\d+"\/><\/w:numPr>/);
  assert.match(xml, /<w:pStyle w:val="ListParagraph"\/><w:numPr><w:ilvl w:val="0"\/><w:numId w:val="1"\/><\/w:numPr><\/w:pPr><w:r><w:t xml:space="preserve">plain item/);
});

test("a numbered list starts at its own number, and the start is only written when it is not one", () => {
  const html = documentHtml(parseMarkdown("3. three\n4. four\n\nbetween\n\n1. one\n2. two"), { title: "x" });
  assert.match(html, /<ol start="3"><li>three<\/li><li>four<\/li><\/ol>/);
  assert.match(html, /<ol><li>one<\/li><li>two<\/li><\/ol>/);
});

test("the page is Letter when asked, and the language is set", () => {
  const html = documentHtml(parseMarkdown("hi"), { title: "x", paper: "Letter", language: "en-US" });
  assert.match(html, /size: Letter;/);
  assert.match(html, /<html lang="en-US">/);
});

test("nothing written in a document can become markup, a script or a way to load something", () => {
  const nasty = [
    "# <script>alert(1)</script>",
    "<img src=x onerror=alert(2)> and <b>bold?</b>",
    "[click](javascript:alert(3)) [data](data:text/html,<script>alert(4)</script>) [file](file:///C:/secret.txt) [ok](https://example.com)",
    "```\n</pre><script>alert(5)</script>\n```",
    "| <th> | \"quoted\" |\n|--|--|\n| <td onclick=x> | & |"
  ].join("\n\n");
  const html = documentHtml(parseMarkdown(nasty), { title: '"><script>alert(6)</script>' });
  const body = html.slice(html.indexOf("<body>"));
  // Only tags a document may have, with only the attributes it may have: the words "script" and "onerror" appear, as text.
  const allowedTags = new Set(["body", "html", "h1", "h2", "h3", "h4", "h5", "h6", "p", "strong", "em", "del", "code", "a", "ul", "ol", "li", "table", "thead", "tbody", "tr", "th", "td", "pre", "blockquote", "hr", "br", "div"]);
  for (const tag of body.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g)) {
    assert.ok(allowedTags.has(tag[1].toLowerCase()), `a tag that is not for documents: ${tag[0]}`);
    for (const attribute of tag[2].matchAll(/\s([a-zA-Z-]+)=("[^"]*")/g)) {
      assert.ok(["href", "start", "style", "class"].includes(attribute[1]), `an attribute that is not for documents: ${attribute[0]}`);
      if (attribute[1] === "href") assert.match(attribute[2], /^"(?:https?:\/\/|mailto:|tel:|#)/);
    }
  }
  assert.match(html, /<title>&quot;&gt;&lt;script&gt;alert\(6\)&lt;\/script&gt;<\/title>/);
  assert.match(body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, "shown as the text it is");
  assert.match(body, /<a href="https:\/\/example\.com">ok<\/a>/, "and a real web link stays one");
  assert.equal((body.match(/<a /g) ?? []).length, 1, "and it is the only one");
});

test("which addresses a link may go to", () => {
  for (const ok of ["https://example.com", "HTTP://example.com/a", "mailto:a@b.co", "#section"]) assert.equal(safeHref(ok), ok);
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "file:///C:/x", "ftp://example.com", "//example.com", "  javascript:x", ""]) assert.equal(safeHref(bad), null, bad);
  assert.equal(escapeHtml(`<a href="x">&</a>`), "&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
});

// ---------------------------------------------------------------- the Word file

const docx = (markdown: string, options: Partial<Parameters<typeof docxFile>[1]> = {}) =>
  docxFile(parseMarkdown(markdown), { title: "Quarterly Report", date: when, ...options });
const part = (archive: Buffer, name: string) => readZip(archive).get(name)!().toString("utf8");

test("a Word file holds the parts Word needs, each one well-formed XML", () => {
  const archive = docx(sample);
  const entries = readZip(archive);
  assert.deepEqual([...entries.keys()], ["[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/_rels/document.xml.rels", "word/styles.xml", "word/numbering.xml", "docProps/core.xml", "docProps/app.xml"]);
  for (const name of entries.keys()) assertWellFormed(part(archive, name), name);
});

test("the document's own words come back out of it, in order, by the reader used on Word files people give it", async () => {
  const read = await extractDocumentText(docx(sample), "report.docx");
  assert.ok(read.ok, JSON.stringify(read));
  if (!read.ok) return;
  assert.equal(read.kind, "docx");
  const order = ["Quarterly Report", "Prepared for the board by TRH AI", "Summary", "Sales rose 12% & margins held. See the dashboard or write to ops@example.com.", "Highlights", "Launched the music video maker", "Fixed 3 bugs", "one in lyrics", "one in the \"preview\"", "Hired two people", "Plan", "Build", "Ship", "Region", "Sales", "North", "1,200", "South & East", "Measure twice, cut once.", "const total = a < b && b > c;", "Appendix", "Last words."];
  let from = 0;
  for (const words of order) {
    const at = read.text.indexOf(words, from);
    assert.ok(at >= 0, `"${words}" is missing, or out of order, in: ${read.text.slice(0, 400)}`);
    from = at + words.length;
  }
});

test("styles are used for headings, and the heading levels are kept", () => {
  const xml = part(docx("# One\n## Two\n### Three\n#### Four\n##### Five\n###### Six\ntext"), "word/document.xml");
  for (const level of [1, 2, 3, 4, 5, 6]) assert.match(xml, new RegExp(`<w:pStyle w:val="Heading${level}"/>`));
  const styles = part(docx("x"), "word/styles.xml");
  for (const id of ["Normal", "Heading1", "Heading6", "ListParagraph", "Quote", "CodeBlock", "CodeChar", "Hyperlink", "TableGrid"]) assert.match(styles, new RegExp(`w:styleId="${id}"`));
});

test("bold, italic, strike and code are runs with their marks, and a line break is a break", () => {
  const xml = part(docx("**b** *i* ***bi*** ~~s~~ `c`\nnext line"), "word/document.xml");
  assert.match(xml, /<w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve">b<\/w:t>/);
  assert.match(xml, /<w:rPr><w:i\/><\/w:rPr><w:t xml:space="preserve">i<\/w:t>/);
  assert.match(xml, /<w:rPr><w:b\/><w:i\/><\/w:rPr><w:t xml:space="preserve">bi<\/w:t>/);
  assert.match(xml, /<w:rPr><w:strike\/><\/w:rPr><w:t xml:space="preserve">s<\/w:t>/);
  assert.match(xml, /<w:rPr><w:rStyle w:val="CodeChar"\/><\/w:rPr><w:t xml:space="preserve">c<\/w:t>/);
  assert.match(xml, /<w:r><w:br\/><\/w:r>/);
});

test("web links are links Word can follow; other addresses are left as text", () => {
  const archive = docx("[site](https://example.com/a?x=1&y=2) [again](https://example.com/a?x=1&y=2) [bad](javascript:alert(1)) [mail](mailto:me@example.com)");
  const xml = part(archive, "word/document.xml");
  const rels = part(archive, "word/_rels/document.xml.rels");
  assert.equal((xml.match(/<w:hyperlink /g) ?? []).length, 3, "site, again, mail - not the script");
  assert.doesNotMatch(xml + rels, /javascript/);
  const ids = [...xml.matchAll(/<w:hyperlink r:id="(rId\d+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, 2, "the same address is one relationship");
  for (const id of ids) assert.match(rels, new RegExp(`<Relationship Id="${id}" Type="[^"]*/hyperlink" Target="[^"]+" TargetMode="External"/>`));
  assert.match(rels, /Target="https:\/\/example\.com\/a\?x=1&amp;y=2"/);
  // No relationship id is used twice: a link must never take the id of the styles or the numbering.
  const everyId = [...rels.matchAll(/<Relationship Id="(rId\d+)"/g)].map((m) => m[1]);
  assert.equal(new Set(everyId).size, everyId.length, `ids are unique: ${everyId.join(", ")}`);
  assert.ok(everyId.includes("rId1") && everyId.includes("rId2"), "the styles and numbering keep theirs");
  for (const id of ids) assert.ok(id !== "rId1" && id !== "rId2", `a link took ${id}`);
});

test("bullets and numbers: each numbered list is numbered from its own start, and levels go as deep as the lists", () => {
  const archive = docx("- a\n  - b\n    - c\n\n1. one\n2. two\n\ntext\n\n5. five\n6. six");
  const xml = part(archive, "word/document.xml");
  const numbering = part(archive, "word/numbering.xml");
  assert.match(xml, /<w:ilvl w:val="0"\/><w:numId w:val="1"\/>/);
  assert.match(xml, /<w:ilvl w:val="1"\/><w:numId w:val="1"\/>/);
  assert.match(xml, /<w:ilvl w:val="2"\/><w:numId w:val="1"\/>/);
  const numbered = [...xml.matchAll(/<w:ilvl w:val="0"\/><w:numId w:val="(\d+)"\/>/g)].map((m) => Number(m[1])).filter((id) => id !== 1);
  assert.equal(new Set(numbered).size, 2, "two numbered lists, two numberings");
  for (const id of new Set(numbered)) assert.match(numbering, new RegExp(`<w:num w:numId="${id}"><w:abstractNumId w:val="1"/>`));
  assert.match(numbering, /<w:startOverride w:val="1"\/>/);
  assert.match(numbering, /<w:startOverride w:val="5"\/>/);
  assert.equal((numbering.match(/<w:lvl w:ilvl="/g) ?? []).length, 18, "nine levels each of bullets and numbers");
  // Every numbering a paragraph names exists.
  const defined = new Set([...numbering.matchAll(/<w:num w:numId="(\d+)"/g)].map((m) => m[1]));
  for (const used of xml.matchAll(/<w:numId w:val="(\d+)"/g)) assert.ok(defined.has(used[1]), `numbering ${used[1]} is used and not defined`);
});

test("a table keeps its columns, its header row and its alignment, and is followed by a paragraph", () => {
  const xml = part(docx("| Name | Qty | Price |\n|:--|:-:|--:|\n| Tea | 2 | 3.50 |\n| Milk | 1 | 0.80 |\n\nAfter."), "word/document.xml");
  assert.equal((xml.match(/<w:gridCol /g) ?? []).length, 3);
  assert.equal((xml.match(/<w:tr>/g) ?? []).length, 3);
  assert.equal((xml.match(/<w:tc>/g) ?? []).length, 9);
  assert.equal((xml.match(/<w:tblHeader\/>/g) ?? []).length, 1, "the header repeats at the top of each page, and only that row");
  assert.equal((xml.match(/<w:b\/>/g) ?? []).length, 3, "the three header cells are bold, and nothing else in the table is");
  assert.match(xml, /<w:shd w:val="clear" w:color="auto" w:fill="EAEFF6"\/>/, "and shaded");
  assert.match(xml, /<w:jc w:val="center"\/>/);
  assert.match(xml, /<w:jc w:val="right"\/>/);
  assert.match(xml, /<\/w:tbl><w:p><w:pPr><w:spacing w:after="0"\/><\/w:pPr><\/w:p>/);
  const widths = [...xml.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map((m) => Number(m[1]));
  assert.ok(Math.abs(widths.reduce((a, b) => a + b, 0) - (11906 - 2 * 1134)) < 5, `the columns fill the page: ${widths.join(", ")}`);
});

test("paper, language, title and author are in the file", () => {
  const letter = docx("hi", { paper: "Letter", language: "en-US", title: 'A "quoted" <title> & more', author: "Jane" });
  assert.match(part(letter, "word/document.xml"), /<w:pgSz w:w="12240" w:h="15840"\/>/);
  assert.match(part(docx("hi"), "word/document.xml"), /<w:pgSz w:w="11906" w:h="16838"\/>/);
  assert.match(part(letter, "word/styles.xml"), /<w:lang w:val="en-US"/);
  const core = part(letter, "docProps/core.xml");
  assert.match(core, /<dc:title>A &quot;quoted&quot; &lt;title&gt; &amp; more<\/dc:title>/);
  assert.match(core, /<dc:creator>Jane<\/dc:creator>/);
  assert.match(core, /<dcterms:created xsi:type="dcterms:W3CDTF">2026-10-25T12:00:00Z<\/dcterms:created>/);
  assertWellFormed(core, "core.xml");
});

test("page breaks, rules, quotes and code blocks are what Word draws them as", () => {
  const xml = part(docx("before\n\n\\newpage\n\n---\n\n> quoted\n\n```\nline one\n  line two\n```"), "word/document.xml");
  assert.match(xml, /<w:br w:type="page"\/>/);
  assert.match(xml, /<w:pBdr><w:bottom w:val="single"/);
  assert.match(xml, /<w:pStyle w:val="Quote"\/>/);
  assert.equal((xml.match(/<w:pStyle w:val="CodeBlock"\/>/g) ?? []).length, 2);
  assert.match(xml, /<w:t xml:space="preserve">  line two<\/w:t>/, "indentation in code is kept");
});

test("characters XML cannot hold are dropped, and the marks it uses are escaped, so the file stays readable", async () => {
  const bell = String.fromCharCode(7);
  const archive = docx(`Fish & chips <b> "ok" ${bell}ring${String.fromCharCode(0)}${String.fromCharCode(27)} 日本語 🎵`);
  assertWellFormed(part(archive, "word/document.xml"), "document.xml");
  const read = await extractDocumentText(archive, "x.docx");
  assert.ok(read.ok && read.text === 'Fish & chips <b> "ok" ring 日本語 🎵'.replace("ring ", "ring "), read.ok ? read.text : read.reason);
  assert.equal(escapeXml(`a&b<c>"d${bell}`), "a&amp;b&lt;c&gt;&quot;d");
});

test("an empty document is still a document, and a long one is made quickly", async () => {
  const empty = docx("");
  assertWellFormed(part(empty, "word/document.xml"), "document.xml");
  assert.match(part(empty, "word/document.xml"), /<w:body><w:p\/><w:sectPr>/);
  const long = Array.from({ length: 4000 }, (_, i) => `Paragraph ${i} with **bold** and a [link](https://example.com/${i}).`).join("\n\n");
  const started = Date.now();
  const archive = docx(long);
  assert.ok(Date.now() - started < 3000, `${Date.now() - started} ms for 4000 paragraphs`);
  assertWellFormed(part(archive, "word/document.xml"), "document.xml");
  assertWellFormed(part(archive, "word/_rels/document.xml.rels"), "rels");
  const read = await extractDocumentText(archive, "long.docx");
  assert.ok(read.ok && read.text.includes("Paragraph 3999 with bold and a link."));
});
