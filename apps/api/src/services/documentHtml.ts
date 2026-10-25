import type { Block, Inline, ListItem } from "./markdown.js";

// A document, as a web page that prints well: what is shown on screen as HTML,
// and what the PDF is printed from. Every piece of text is escaped, and nothing
// in the Markdown can bring in a tag, a script or an address that loads
// something: links become links, and that is all.

export type Paper = "A4" | "Letter";

export const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A link is followed only if it goes to the web, to a mail address, a phone number, or within the page; anything else is left as text. */
export function safeHref(href: string): string | null {
  const trimmed = href.trim();
  return /^(?:https?:\/\/|mailto:|tel:|#)/i.test(trimmed) ? trimmed : null;
}

function inlineHtml(inlines: Inline[]): string {
  return inlines
    .map((run) => {
      if (run.kind === "break") return "<br>";
      let html = escapeHtml(run.text);
      if (run.code) html = `<code>${html}</code>`;
      if (run.bold) html = `<strong>${html}</strong>`;
      if (run.italic) html = `<em>${html}</em>`;
      if (run.strike) html = `<del>${html}</del>`;
      const href = run.href ? safeHref(run.href) : null;
      if (href) html = `<a href="${escapeHtml(href)}">${html}</a>`;
      return html;
    })
    .join("");
}

/** A checklist item in a bulleted list shows its box and no bullet; in a numbered list it keeps its number. */
const itemHtml = (ordered: boolean) => (item: ListItem): string =>
  `<li${item.task && !ordered ? ' class="task"' : ""}>${inlineHtml(item.inlines)}${blocksHtml(item.children)}</li>`;

function blocksHtml(blocks: Block[]): string {
  return blocks
    .map((block) => {
      switch (block.kind) {
        case "heading": return `<h${block.level}>${inlineHtml(block.inlines)}</h${block.level}>`;
        case "paragraph": return `<p>${inlineHtml(block.inlines)}</p>`;
        case "list": {
          const tag = block.ordered ? "ol" : "ul";
          const start = block.ordered && block.start !== 1 ? ` start="${block.start}"` : "";
          return `<${tag}${start}>${block.items.map(itemHtml(block.ordered)).join("")}</${tag}>`;
        }
        case "code": return `<pre><code>${escapeHtml(block.text)}</code></pre>`;
        case "table": {
          const cell = (tag: string, inlines: Inline[], align: string | null) => `<${tag}${align ? ` style="text-align:${align}"` : ""}>${inlineHtml(inlines)}</${tag}>`;
          const head = `<thead><tr>${block.header.map((inlines, column) => cell("th", inlines, block.align[column])).join("")}</tr></thead>`;
          const body = `<tbody>${block.rows.map((row) => `<tr>${row.map((inlines, column) => cell("td", inlines, block.align[column])).join("")}</tr>`).join("")}</tbody>`;
          return `<table>${head}${body}</table>`;
        }
        case "quote": return `<blockquote>${blocksHtml(block.blocks)}</blockquote>`;
        case "rule": return "<hr>";
        case "pagebreak": return '<div class="pagebreak"></div>';
      }
    })
    .join("\n");
}

const style = (paper: Paper) => `
@page { size: ${paper}; margin: 20mm 18mm; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0 auto; max-width: 820px; padding: 24px; font: 11pt/1.5 "Segoe UI", Calibri, "Helvetica Neue", Arial, sans-serif; color: #1c1c1e; overflow-wrap: break-word; }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.1em 0 0.35em; break-after: avoid; color: #14233c; }
h1 { font-size: 22pt; margin-top: 0; padding-bottom: 4pt; border-bottom: 1.5px solid #c7ced9; }
h2 { font-size: 15pt; } h3 { font-size: 12.5pt; } h4 { font-size: 11.5pt; } h5, h6 { font-size: 11pt; }
p { margin: 0 0 8pt; orphans: 3; widows: 3; }
ul, ol { margin: 0 0 8pt; padding-left: 20pt; }
li { margin: 0 0 2pt; } li > ul, li > ol { margin: 2pt 0 2pt; }
li.task { list-style: none; margin-left: -14pt; }
table { border-collapse: collapse; width: 100%; margin: 6pt 0 12pt; break-inside: auto; font-size: 10.5pt; }
tr { break-inside: avoid; }
th, td { border: 1px solid #b8c0cc; padding: 4pt 7pt; vertical-align: top; text-align: left; }
th { background: #eaeff6; font-weight: 600; }
code { font: 9.5pt Consolas, "Courier New", monospace; background: #f1f2f4; padding: 0 3pt; border-radius: 2pt; }
pre { background: #f5f6f8; border: 1px solid #e0e3e8; border-radius: 4pt; padding: 8pt 10pt; margin: 0 0 10pt; white-space: pre-wrap; break-inside: avoid; }
pre code { background: none; padding: 0; font-size: 9pt; line-height: 1.4; }
blockquote { margin: 0 0 8pt; padding: 2pt 12pt; border-left: 3pt solid #9fb0c6; color: #3d4654; }
hr { border: 0; border-top: 1px solid #c7ced9; margin: 12pt 0; }
a { color: #1a5fb4; }
del { color: #6b7380; }
.pagebreak { break-after: page; height: 0; }
`;

/** A whole page of HTML for a document: with its title in the tab, and the style that prints it well. */
export function documentHtml(blocks: Block[], options: { title: string; paper?: Paper; language?: string }): string {
  return `<!doctype html>
<html lang="${escapeHtml(options.language ?? "en")}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)}</title>
<style>${style(options.paper ?? "A4")}</style>
</head>
<body>
${blocksHtml(blocks)}
</body>
</html>
`;
}
