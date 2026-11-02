import { parseInline, type Inline } from "../markdown.js";
import type { Fact } from "../legalFacts.js";

// The legal texts as data, and how they are read.
//
// A text is a list of sections, each a list of blocks. Written as data rather than
// as screens or as files so the one text can be shown in the app, exported as a page
// for a website, exported as Markdown, fingerprinted to keep its version honest,
// and searched for what is still missing - without any of them being able to
// disagree about what it says.
//
// Inside a block's text: **bold**, *italic*, `code` and [links](#legal-privacy) are
// read as the replies are (markdown.ts, which never produces HTML). A link to
// another legal text is `#legal-<id>`. A fact the owner has not supplied is
// written {{open:what is missing}} - the screens show it as an open item, never as
// a made-up fact, and openItemsIn lists every one.

export type LegalDocId = "privacy" | "terms" | "refunds" | "storage" | "ai" | "business" | "services";

export const legalDocIds: readonly LegalDocId[] = ["privacy", "terms", "refunds", "storage", "ai", "business", "services"];

export function isLegalDocId(value: unknown): value is LegalDocId {
  return typeof value === "string" && (legalDocIds as readonly string[]).includes(value);
}

export type LegalBlock =
  | { kind: "p"; text: string }
  | { kind: "list"; ordered?: boolean; items: string[] }
  | { kind: "table"; caption: string; head: string[]; rows: string[][] }
  /** "info": a plain-words summary set apart. "review": a point for the lawyer, shown only while the texts are a draft. */
  | { kind: "note"; tone: "info" | "review"; text: string };

export type LegalSection = { id: string; heading: string; blocks: LegalBlock[] };

export type LegalDocument = {
  id: LegalDocId;
  title: string;
  /** One sentence for lists and link previews. */
  summary: string;
  /** The version a person can agree to; null for a page that only informs. */
  version: string | null;
  /** The date these words took effect (YYYY-MM-DD). */
  effective: string;
  sections: LegalSection[];
};

// ------------------------------------------------------------------ open items

export type LegalInline = Inline | { kind: "open"; label: string };

const openPattern = /\{\{open:([^}]+)\}\}/g;

/** Marks a fact as still to be supplied. */
export function openItem(label: string): string {
  return `{{open:${label}}}`;
}

/** A fact as the text should say it: its value, or an open item that names what is missing. */
export function fact(value: Fact<string | number>, label: string): string {
  return value === null || value === "" ? openItem(label) : String(value);
}

/** Text with its markers read: ordinary spans, links and open items. */
export function parseLegalInline(text: string): LegalInline[] {
  const parts: LegalInline[] = [];
  let last = 0;
  for (const match of text.matchAll(openPattern)) {
    const at = match.index ?? 0;
    if (at > last) parts.push(...parseInline(text.slice(last, at)));
    parts.push({ kind: "open", label: match[1].trim() });
    last = at + match[0].length;
  }
  if (last < text.length) parts.push(...parseInline(text.slice(last)));
  return parts;
}

function blockTexts(block: LegalBlock): string[] {
  switch (block.kind) {
    case "p": return [block.text];
    case "note": return [block.text];
    case "list": return block.items;
    case "table": return [block.caption, ...block.head, ...block.rows.flat()];
  }
}

/** Every text in a document, in order: the title, the summary, each heading and each block's words. */
export function allTextsIn(doc: LegalDocument): string[] {
  return [doc.title, doc.summary, ...doc.sections.flatMap((section) => [section.heading, ...section.blocks.flatMap(blockTexts)])];
}

/** What is still to be supplied in a document, each item once, in the order it first appears. */
export function openItemsIn(doc: LegalDocument): string[] {
  const found: string[] = [];
  for (const text of allTextsIn(doc)) {
    for (const match of text.matchAll(openPattern)) {
      const label = match[1].trim();
      if (!found.includes(label)) found.push(label);
    }
  }
  return found;
}

/** The words of a document as one string, for fingerprinting: any change to them changes it. */
export function canonicalTextOf(doc: LegalDocument): string {
  return JSON.stringify({ id: doc.id, version: doc.version, title: doc.title, sections: doc.sections });
}

// --------------------------------------------------------------------- reading

function plainOf(nodes: LegalInline[]): string {
  return nodes.map((node) => {
    if (node.kind === "text" || node.kind === "code") return node.text;
    if (node.kind === "open") return `[to be supplied: ${node.label}]`;
    return plainOf(node.children);
  }).join("");
}

/** A block's text with its markers taken out, for a place that shows plain words. */
export function plainText(text: string): string {
  return plainOf(parseLegalInline(text));
}

/** A heading's anchor within a page. */
export function sectionAnchor(doc: LegalDocument, section: LegalSection): string {
  return `${doc.id}-${section.id}`;
}

// -------------------------------------------------------------------- Markdown

function markdownOf(nodes: LegalInline[], link: (id: LegalDocId) => string): string {
  return nodes.map((node) => {
    switch (node.kind) {
      case "text": return node.text;
      case "code": return `\`${node.text}\``;
      case "bold": return `**${markdownOf(node.children, link)}**`;
      case "italic": return `*${markdownOf(node.children, link)}*`;
      case "open": return `**[TO BE SUPPLIED: ${node.label}]**`;
      case "link": {
        const id = /^#legal-(.+)$/.exec(node.href)?.[1];
        return `[${markdownOf(node.children, link)}](${id && isLegalDocId(id) ? link(id) : node.href})`;
      }
    }
  }).join("");
}

export type RenderOptions = {
  /** Points for the lawyer. Shown while the texts are a draft. */
  showReviewNotes: boolean;
  /** Where another legal text lives, in the place the output will be read. */
  link: (id: LegalDocId) => string;
};

/** A document as Markdown, for a repository, a website or a lawyer's email. */
export function legalToMarkdown(doc: LegalDocument, options: RenderOptions): string {
  const text = (value: string) => markdownOf(parseLegalInline(value), options.link);
  const lines: string[] = [`# ${doc.title}`, ""];
  lines.push(`*${doc.version ? `Version ${doc.version}. ` : ""}In effect from ${doc.effective}.*`, "", text(doc.summary), "");
  for (const section of doc.sections) {
    lines.push(`## ${section.heading}`, "");
    for (const block of section.blocks) {
      if (block.kind === "note" && block.tone === "review" && !options.showReviewNotes) continue;
      if (block.kind === "p") lines.push(text(block.text), "");
      else if (block.kind === "note") lines.push(`> **${block.tone === "review" ? "For legal review" : "In short"}:** ${text(block.text)}`, "");
      else if (block.kind === "list") {
        lines.push(...block.items.map((item, index) => `${block.ordered ? `${index + 1}.` : "-"} ${text(item)}`), "");
      } else {
        lines.push(`**${text(block.caption)}**`, "", `| ${block.head.map(text).join(" | ")} |`, `| ${block.head.map(() => "---").join(" | ")} |`);
        for (const row of block.rows) lines.push(`| ${row.map((cell) => text(cell).replace(/\|/g, "\\|")).join(" | ")} |`);
        lines.push("");
      }
    }
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

// ------------------------------------------------------------------------ HTML

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function htmlOf(nodes: LegalInline[], link: (id: LegalDocId) => string): string {
  return nodes.map((node) => {
    switch (node.kind) {
      case "text": return escapeHtml(node.text);
      case "code": return `<code>${escapeHtml(node.text)}</code>`;
      case "bold": return `<strong>${htmlOf(node.children, link)}</strong>`;
      case "italic": return `<em>${htmlOf(node.children, link)}</em>`;
      case "open": return `<mark class="open">[To be supplied: ${escapeHtml(node.label)}]</mark>`;
      case "link": {
        const id = /^#legal-(.+)$/.exec(node.href)?.[1];
        const internal = id && isLegalDocId(id);
        const href = internal ? link(id) : node.href;
        return `<a href="${escapeHtml(href)}"${internal ? "" : ` rel="noopener noreferrer"`}>${htmlOf(node.children, link)}</a>`;
      }
    }
  }).join("");
}

/** The body of a document as HTML - headings, paragraphs, lists and tables - with every string escaped. */
export function legalBodyToHtml(doc: LegalDocument, options: RenderOptions): string {
  const text = (value: string) => htmlOf(parseLegalInline(value), options.link);
  const out: string[] = [];
  out.push(`<h1>${escapeHtml(doc.title)}</h1>`);
  out.push(`<p class="meta">${doc.version ? `Version ${escapeHtml(doc.version)}. ` : ""}In effect from ${escapeHtml(doc.effective)}.</p>`);
  out.push(`<p class="summary">${text(doc.summary)}</p>`);
  out.push(`<nav aria-label="On this page"><ol>${doc.sections.map((section) => `<li><a href="#${escapeHtml(sectionAnchor(doc, section))}">${escapeHtml(section.heading)}</a></li>`).join("")}</ol></nav>`);
  for (const section of doc.sections) {
    out.push(`<section aria-labelledby="${escapeHtml(sectionAnchor(doc, section))}">`);
    out.push(`<h2 id="${escapeHtml(sectionAnchor(doc, section))}">${escapeHtml(section.heading)}</h2>`);
    for (const block of section.blocks) {
      if (block.kind === "note" && block.tone === "review" && !options.showReviewNotes) continue;
      if (block.kind === "p") out.push(`<p>${text(block.text)}</p>`);
      else if (block.kind === "note") {
        out.push(`<aside class="note ${block.tone}"><strong>${block.tone === "review" ? "For legal review" : "In short"}.</strong> ${text(block.text)}</aside>`);
      } else if (block.kind === "list") {
        const tag = block.ordered ? "ol" : "ul";
        out.push(`<${tag}>${block.items.map((item) => `<li>${text(item)}</li>`).join("")}</${tag}>`);
      } else {
        out.push(`<table><caption>${text(block.caption)}</caption><thead><tr>${block.head.map((cell) => `<th scope="col">${text(cell)}</th>`).join("")}</tr></thead>`
          + `<tbody>${block.rows.map((row) => `<tr>${row.map((cell, index) => (index === 0 ? `<th scope="row">${text(cell)}</th>` : `<td>${text(cell)}</td>`)).join("")}</tr>`).join("")}</tbody></table>`);
      }
    }
    out.push("</section>");
  }
  return out.join("\n");
}
