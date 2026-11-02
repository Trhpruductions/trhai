import test from "node:test";
import assert from "node:assert/strict";
import {
  allTextsIn, canonicalTextOf, escapeHtml, fact, isLegalDocId, legalBodyToHtml, legalToMarkdown, openItem, openItemsIn,
  parseLegalInline, plainText, sectionAnchor, type LegalDocument, type RenderOptions
} from "../src/legal/model.js";

// How the legal texts are read: open items, links between texts, and the two
// outputs (Markdown and HTML) that must never let a stray character through.

const doc: LegalDocument = {
  id: "privacy",
  title: "Privacy <Policy> & more",
  summary: `We are ${openItem("legal entity name")}.`,
  version: "2026-11-01",
  effective: "2026-11-01",
  sections: [
    {
      id: "who",
      heading: "Who we are",
      blocks: [
        { kind: "p", text: `Contact **${fact(null, "support email")}** or read the [Terms](#legal-terms), or [our site](https://example.com/a?b=1&c=2).` },
        { kind: "note", tone: "info", text: "Short version: nothing leaves this PC." },
        { kind: "note", tone: "review", text: `Check the ${openItem("governing law")} wording.` },
        { kind: "list", items: ["one `code`", `two ${fact("Utah", "state")}`] },
        { kind: "list", ordered: true, items: ["first", "second"] },
        { kind: "table", caption: "What is kept", head: ["Item", "Why"], rows: [["accounts.json", "your sign-in | and name"], ["<script>alert(1)</script>", "x"]] }
      ]
    }
  ]
};

const options = (showReviewNotes: boolean): RenderOptions => ({ showReviewNotes, link: (id) => `${id}.html` });

test("a fact that is not supplied reads as an open item that names what is missing, and one that is supplied reads as itself", () => {
  assert.equal(fact(null, "support email"), "{{open:support email}}");
  assert.equal(fact("", "support email"), "{{open:support email}}");
  assert.equal(fact("help@example.com", "support email"), "help@example.com");
  assert.equal(fact(14, "days"), "14");
  assert.equal(fact(0, "days"), "0", "zero is an answer, not a gap");
});

test("open items are found wherever they are - summary, paragraphs, notes, lists, tables - each once", () => {
  const withTable: LegalDocument = {
    ...doc,
    sections: [...doc.sections, { id: "t", heading: "More", blocks: [{ kind: "table", caption: "c", head: ["h"], rows: [[`${openItem("support email")} and ${openItem("postal address")}`]] }] }]
  };
  assert.deepEqual(openItemsIn(withTable), ["legal entity name", "support email", "governing law", "postal address"]);
  assert.deepEqual(openItemsIn({ ...doc, summary: "done", sections: [{ id: "a", heading: "A", blocks: [{ kind: "p", text: "all supplied" }] }] }), []);
});

test("text is read into spans, links and open items, and a link to another text is recognised", () => {
  const nodes = parseLegalInline("See [Terms](#legal-terms) and **ask** {{open:support email}} soon.");
  assert.deepEqual(nodes.map((node) => node.kind), ["text", "link", "text", "bold", "text", "open", "text"]);
  const link = nodes.find((node) => node.kind === "link");
  assert.equal(link && link.kind === "link" ? link.href : null, "#legal-terms");
  assert.equal(plainText("See [Terms](#legal-terms) and **ask** {{open:support email}}."), "See Terms and ask [to be supplied: support email].");
  assert.equal(plainText("a `b_c_d` e"), "a b_c_d e");
});

test("a link that is not safe keeps its words and loses its address", () => {
  const nodes = parseLegalInline("[click](javascript:void)");
  assert.deepEqual(nodes.map((node) => node.kind), ["text"]);
  assert.equal(plainText("[click](javascript:void)"), "click");
});

test("Markdown output has the title, headings, links rewritten for the place it is read, tables, and open items marked", () => {
  const markdown = legalToMarkdown(doc, options(true));
  assert.match(markdown, /^# Privacy <Policy> & more\n/);
  assert.match(markdown, /\*Version 2026-11-01\. In effect from 2026-11-01\.\*/);
  assert.match(markdown, /## Who we are/);
  assert.match(markdown, /\[Terms\]\(terms\.html\)/, "links to other texts go where the output says they live");
  assert.match(markdown, /\[our site\]\(https:\/\/example\.com\/a\?b=1&c=2\)/);
  assert.match(markdown, /\*\*\[TO BE SUPPLIED: support email\]\*\*/);
  assert.match(markdown, /> \*\*In short:\*\* Short version/);
  assert.match(markdown, /> \*\*For legal review:\*\*/);
  assert.match(markdown, /1\. first\n2\. second/);
  assert.match(markdown, /\| Item \| Why \|\n\| --- \| --- \|\n\| accounts\.json \| your sign-in \\\| and name \|/, "a pipe inside a cell is escaped");
});

test("points for the lawyer are left out once the texts are no longer a draft", () => {
  assert.doesNotMatch(legalToMarkdown(doc, options(false)), /For legal review/);
  assert.doesNotMatch(legalBodyToHtml(doc, options(false)), /For legal review/);
  assert.match(legalBodyToHtml(doc, options(true)), /For legal review/);
});

test("HTML output escapes everything a person or an owner could have typed, and keeps its structure", () => {
  const html = legalBodyToHtml(doc, options(true));
  assert.match(html, /<h1>Privacy &lt;Policy&gt; &amp; more<\/h1>/);
  assert.doesNotMatch(html, /<script>/, "a tag in a cell is text, not a tag");
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /<h2 id="privacy-who">Who we are<\/h2>/);
  assert.match(html, /<section aria-labelledby="privacy-who">/);
  assert.match(html, /<a href="terms\.html">Terms<\/a>/);
  assert.match(html, /<a href="https:\/\/example\.com\/a\?b=1&amp;c=2" rel="noopener noreferrer">our site<\/a>/);
  assert.match(html, /<mark class="open">\[To be supplied: support email\]<\/mark>/);
  assert.match(html, /<table><caption>What is kept<\/caption><thead><tr><th scope="col">Item<\/th>/);
  assert.match(html, /<th scope="row">accounts\.json<\/th><td>your sign-in \| and name<\/td>/);
  assert.match(html, /<nav aria-label="On this page"><ol><li><a href="#privacy-who">Who we are<\/a><\/li><\/ol><\/nav>/);
  assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
});

test("the words of a document fingerprint to a string that changes when any of them, or the version, does", () => {
  const before = canonicalTextOf(doc);
  assert.equal(canonicalTextOf(doc), before);
  const edited = structuredClone(doc);
  (edited.sections[0].blocks[0] as { kind: "p"; text: string }).text += " Extra.";
  assert.notEqual(canonicalTextOf(edited), before);
  assert.notEqual(canonicalTextOf({ ...doc, version: "2027-01-01" }), before, "the version is part of what is fingerprinted");
  assert.ok(allTextsIn(doc).length > 10);
});

test("ids of the texts are checked, and an anchor names its text and section", () => {
  assert.equal(isLegalDocId("privacy"), true);
  assert.equal(isLegalDocId("cookies"), false);
  assert.equal(isLegalDocId(undefined), false);
  assert.equal(sectionAnchor(doc, doc.sections[0]), "privacy-who");
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
});
