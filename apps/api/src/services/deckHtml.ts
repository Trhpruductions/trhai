import type { Bullet, Slide, SlideContent } from "./deckData.js";
import { escapeHtml, inlineHtml } from "./documentHtml.js";
import type { Inline } from "./markdown.js";
import { colors, splitContent } from "./pptxWriter.js";
import { bodySize, columnWeights, rowHeights, subtitleSize, tableFont, titleSize } from "./slideMetrics.js";

// A presentation as a web page that prints as slides: one 16:9 page to a slide, drawn from
// the same slides, sizes and colours as the PowerPoint file, so that the PDF of a
// presentation and its .pptx look like each other. Every piece of text is escaped, and
// nothing can bring in a tag, a script or an address that loads something.

const inches = (value: number) => `${Math.round(value * 10_000) / 10_000}in`;

function bulletHtml(bullet: Bullet, size: number): string {
  const level = bullet.level;
  // The same margins as the PowerPoint file: a bullet hangs 0.375in, a number 0.5in, and a checklist item has no mark.
  const [textAt, markAt] = bullet.task ? [level * 0.4375, 0] : bullet.number !== null ? [0.5 + level * 0.4375, level * 0.4375] : [0.375 + level * 0.5, level * 0.5];
  const mark = bullet.task ? "" : `<span class="mark" aria-hidden="true" style="left:${inches(markAt)}">${bullet.number !== null ? `${bullet.number}.` : level === 1 ? "&#8211;" : "&#8226;"}</span>`;
  return `<li class="${level === 0 ? "top" : "sub"}" style="padding-left:${inches(textAt)};font-size:${size - level * 2}pt">${mark}${inlineHtml(bullet.inlines)}</li>`;
}

function contentHtml(content: SlideContent[], size: number): string {
  const out: string[] = [];
  let list: string[] = [];
  const flush = () => { if (list.length > 0) { out.push(`<ul class="list">${list.join("")}</ul>`); list = []; } };
  for (const item of content) {
    if (item.kind === "bullets") { for (const bullet of item.items) list.push(bulletHtml(bullet, size)); continue; }
    flush();
    switch (item.kind) {
      case "text": out.push(`<p style="font-size:${size}pt">${inlineHtml(item.inlines)}</p>`); break;
      case "quote": out.push(`<blockquote style="font-size:${size}pt"><p>${inlineHtml(item.inlines)}</p></blockquote>`); break;
      case "code": out.push(`<pre style="font-size:${Math.max(14, size - 6)}pt"><code>${escapeHtml(item.lines.join("\n"))}</code></pre>`); break;
      case "table": {
        const weights = columnWeights(item);
        const sum = weights.reduce((a, b) => a + b, 0);
        const font = tableFont(item);
        const heights = rowHeights(item);
        const cell = (tag: string, inlines: Inline[], column: number) => {
          const align = item.align[column];
          return `<${tag}${align ? ` style="text-align:${align}"` : ""}>${inlineHtml(inlines)}</${tag}>`;
        };
        out.push(`<table style="font-size:${font}pt"><colgroup>${weights.map((weight) => `<col style="width:${((weight / sum) * 100).toFixed(2)}%">`).join("")}</colgroup>`
          + `<thead><tr style="height:${heights[0].toFixed(1)}pt">${item.header.map((inlines, column) => cell("th", inlines, column)).join("")}</tr></thead>`
          + `<tbody>${item.rows.map((row, index) => `<tr style="height:${heights[index + 1].toFixed(1)}pt">${item.header.map((_, column) => cell("td", row[column] ?? [], column)).join("")}</tr>`).join("")}</tbody></table>`);
        break;
      }
      default: break;
    }
  }
  flush();
  return out.join("");
}

function slideHtml(slide: Slide): string {
  if (slide.kind === "title") {
    const size = titleSize(slide.title, true);
    const sub = slide.subtitle ? subtitleSize(slide.subtitle) : 0;
    return `<section class="slide opening"><h1 class="title" style="font-size:${size}pt">${escapeHtml(slide.title)}</h1>`
      + (slide.subtitle ? `<div class="subtitle" style="font-size:${sub}pt">${slide.subtitle.split("\n").map((line) => `<p>${escapeHtml(line)}</p>`).join("")}</div>` : "")
      + "</section>";
  }
  const size = bodySize(slide.content);
  const title = titleSize(slide.title, false);
  // In the order the PowerPoint file places them.
  const { texts, tables, tail } = splitContent(slide.content);
  return `<section class="slide">${slide.title ? `<h2 class="title" style="font-size:${title}pt">${escapeHtml(slide.title)}</h2>` : ""}<div class="body">${contentHtml([...texts, ...tables, ...tail], size)}</div></section>`;
}

const style = `
@page { size: 13.333in 7.5in; margin: 0; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; background: #e6e9ee; font-family: Calibri, Carlito, "Segoe UI", "Helvetica Neue", Arial, sans-serif; color: #${colors.ink}; }
.slide { position: relative; width: 13.333in; height: 7.49in; overflow: hidden; background: #fff; break-after: page; page-break-after: always; }
.slide:last-child { break-after: auto; page-break-after: auto; }
.slide:not(.opening)::before { content: ""; position: absolute; left: 0; top: 0; width: 100%; height: 0.1in; background: #${colors.accent}; }
.slide.opening { background: #${colors.navy}; }
.slide.opening::before { content: ""; position: absolute; left: 0.9167in; top: 3.894in; width: 2in; height: 0.06in; background: #${colors.glow}; }
.title { position: absolute; left: 0.9167in; width: 11.5in; margin: 0; padding: 0 0.1in; font-weight: 700; line-height: 0.9; display: flex; overflow: hidden; }
h2.title { top: 0.399in; height: 1.269in; align-items: center; color: #${colors.navy}; }
h1.title { top: 1.64in; height: 2.133in; align-items: flex-end; color: #fff; }
.subtitle { position: absolute; left: 0.9167in; top: 4.11in; width: 11.5in; height: 1.31in; padding: 0.05in 0.1in; color: #${colors.subtitle}; overflow: hidden; }
.subtitle p { margin: 0; }
.body { position: absolute; left: 0.9167in; top: 1.849in; width: 11.5in; height: 4.906in; padding: 0.05in 0.1in; overflow: hidden; }
.body > p { margin: 6pt 0 0; }
.list { list-style: none; margin: 0; padding: 0; }
.list li { position: relative; margin: 0; line-height: normal; }
.list li.top { margin-top: 10pt; }
.list li.sub { margin-top: 5pt; }
.list li:first-child { margin-top: 0; }
.mark { position: absolute; top: 0; }
blockquote { margin: 6pt 0 0; padding: 0 0 0 0.375in; font-style: italic; color: #${colors.quote}; }
blockquote p { margin: 0; }
pre { margin: 6pt 0 0; white-space: pre-wrap; color: #${colors.navy}; }
code { font-family: Consolas, "Courier New", monospace; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; margin: 0.12in 0; }
th, td { padding: 0.05in 0.1in; border-bottom: 1pt solid #${colors.rule}; vertical-align: middle; text-align: left; overflow-wrap: anywhere; }
th { background: #${colors.mist}; color: #${colors.navy}; font-weight: 700; }
a { color: #${colors.accent}; }
del { opacity: 0.7; }
@media screen { .slide { margin: 0.25in auto; box-shadow: 0 1px 6px rgba(0, 0, 0, 0.25); } }
`;

/** A whole page of HTML for a presentation: a page to a slide, with the style that prints it so. */
export function deckHtml(slides: Slide[], options: { title: string; language?: string }): string {
  return `<!doctype html>
<html lang="${escapeHtml(options.language ?? "en")}">
<head>
<meta charset="utf-8">
<title>${escapeHtml(options.title)}</title>
<style>${style}</style>
</head>
<body>
${slides.map(slideHtml).join("\n")}
</body>
</html>
`;
}
