import type { Slide, SlideContent } from "./deckData.js";
import { escapeXml } from "./docxWriter.js";
import { safeHref } from "./documentHtml.js";
import type { Inline } from "./markdown.js";
import { bodySize, heightOf, rowHeights, subtitleSize, tableFont, titleSize, columnWeights, type Table } from "./slideMetrics.js";
import { writeZip } from "./zipWriter.js";

// A PowerPoint presentation (.pptx) from slides.
//
// Like Word and Excel files, a .pptx is a zip of XML parts, and this writes the ones
// a presentation needs by hand: the presentation, a slide master with two layouts (a
// title slide and a slide with a title and a body), a theme, one part for each slide,
// and - when there are speaker's notes - a notes master and a notes page for each.
// Text goes into the layouts' own placeholders, so that PowerPoint's outline view, its
// slide sorter and a screen reader see titles and bullets rather than loose boxes of
// words. 16:9, a dark title slide, white content slides.

export type DeckFileOptions = { title: string; author?: string; date?: Date };

const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const ns = {
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  p: "http://schemas.openxmlformats.org/presentationml/2006/main"
};
const namespaces = `xmlns:a="${ns.a}" xmlns:r="${ns.r}" xmlns:p="${ns.p}"`;
const relNamespace = "http://schemas.openxmlformats.org/package/2006/relationships";
const relType = (name: string) => `http://schemas.openxmlformats.org/officeDocument/2006/relationships/${name}`;
const contentType = (name: string) => `application/vnd.openxmlformats-officedocument.presentationml.${name}+xml`;

/** 13.333 by 7.5 inches, in the unit a presentation counts in (914,400 to the inch). */
export const slideWidth = 12_192_000;
export const slideHeight = 6_858_000;
const bodyBox = { x: 838_200, y: 1_690_688, width: 10_515_600, height: 4_486_275 };

/** The deck's colours, which the web page and PDF of a presentation use too. */
export const colors = { navy: "14233C", ink: "1C1C1E", accent: "1A5FB4", mist: "EAEFF6", rule: "B8C0CC", quote: "3D4654", glow: "5B9BEA", subtitle: "C9D6EA" };

// ---------------------------------------------------------------- text

type Links = { ids: Map<string, string>; next: number };

function runXml(run: Inline, links: Links, size: number | undefined, color?: string): string {
  if (run.kind === "break") return '<a:br><a:rPr lang="en-US"/></a:br>';
  const href = run.href ? safeHref(run.href) : null;
  const attributes = ['lang="en-US"', size ? `sz="${size * 100}"` : "", run.bold ? 'b="1"' : "", run.italic ? 'i="1"' : "", run.strike ? 'strike="sngStrike"' : "", 'dirty="0"'].filter(Boolean).join(" ");
  let id = "";
  if (href && !href.startsWith("#")) {
    id = links.ids.get(href) ?? `rId${links.next}`;
    if (!links.ids.has(href)) { links.ids.set(href, id); links.next += 1; }
  }
  // A link takes the theme's link colour, and is not given another.
  const fill = color && !id ? `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>` : "";
  const font = run.code ? '<a:latin typeface="Consolas"/><a:cs typeface="Consolas"/>' : "";
  const link = id ? `<a:hlinkClick r:id="${id}"/>` : "";
  const children = `${fill}${font}${link}`;
  return `<a:r>${children ? `<a:rPr ${attributes}>${children}</a:rPr>` : `<a:rPr ${attributes}/>`}<a:t>${escapeXml(run.text)}</a:t></a:r>`;
}

const runsXml = (inlines: Inline[], links: Links, size?: number, color?: string) => inlines.map((run) => runXml(run, links, size, color)).join("");

const endOfParagraph = (size: number) => `<a:endParaRPr lang="en-US" sz="${size * 100}" dirty="0"/>`;

const plainParagraph = (text: string, size?: number) =>
  `<a:p><a:r><a:rPr lang="en-US"${size ? ` sz="${size * 100}"` : ""} dirty="0"/><a:t>${escapeXml(text)}</a:t></a:r></a:p>`;

/**
 * The paragraphs of a slide's body: bullets with their levels and numbers, plain text, quotes, code. A body
 * placeholder takes its bullets from the master; `explicit` is for a text box, which has none to take.
 */
function bodyParagraphs(content: SlideContent[], links: Links, size: number, explicit = false): string {
  const out: string[] = [];
  for (const item of content) {
    switch (item.kind) {
      case "bullets":
        for (const bullet of item.items) {
          const level = bullet.level;
          // A checklist item has its box and no bullet; a numbered one is numbered by the program, from the number it was given.
          const properties = bullet.task
            ? `<a:pPr marL="${level * 400_050}" indent="0" lvl="${level}"><a:buNone/></a:pPr>`
            : bullet.number !== null
              ? `<a:pPr marL="${457_200 + level * 400_050}" indent="-457200" lvl="${level}"><a:buFont typeface="+mj-lt"/><a:buAutoNum type="arabicPeriod"${bullet.number !== 1 ? ` startAt="${bullet.number}"` : ""}/></a:pPr>`
              : explicit
                ? `<a:pPr marL="${342_900 + level * 457_200}" indent="-342900" lvl="${level}"><a:spcBef><a:spcPts val="${level === 0 ? 1000 : 500}"/></a:spcBef><a:buFont typeface="Arial"/><a:buChar char="${level === 1 ? "&#8211;" : "&#8226;"}"/></a:pPr>`
                : level > 0 ? `<a:pPr lvl="${level}"/>` : "";
          out.push(`<a:p>${properties}${runsXml(bullet.inlines, links, size - level * 2)}</a:p>`);
        }
        break;
      case "text":
        out.push(`<a:p><a:pPr marL="0" indent="0"><a:spcBef><a:spcPts val="600"/></a:spcBef><a:buNone/></a:pPr>${runsXml(item.inlines, links, size)}</a:p>`);
        break;
      case "quote":
        out.push(`<a:p><a:pPr marL="342900" indent="0"><a:spcBef><a:spcPts val="600"/></a:spcBef><a:buNone/></a:pPr>${runsXml(item.inlines.map((run) => (run.kind === "text" ? { ...run, italic: true } : run)), links, size, colors.quote)}</a:p>`);
        break;
      case "code": {
        const codeSize = Math.max(14, size - 6);
        for (const line of item.lines) {
          const text = line
            ? `<a:r><a:rPr lang="en-US" sz="${codeSize * 100}" dirty="0"><a:solidFill><a:srgbClr val="${colors.navy}"/></a:solidFill><a:latin typeface="Consolas"/><a:cs typeface="Consolas"/></a:rPr><a:t>${escapeXml(line)}</a:t></a:r>`
            : endOfParagraph(codeSize);
          out.push(`<a:p><a:pPr marL="0" indent="0"><a:buNone/></a:pPr>${text}</a:p>`);
        }
        break;
      }
      default: break;
    }
  }
  return out.join("");
}

// ---------------------------------------------------------------- the slides

const group = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

type PlaceholderOptions = { frame?: string; lstStyle?: string };

/** A shape that fills one of the layout's placeholders, which `ph` names the way the layout does. */
const placeholder = (id: number, name: string, ph: string, paragraphs: string, options: PlaceholderOptions = {}) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph ${ph}/></p:nvPr></p:nvSpPr><p:spPr>${options.frame ?? ""}</p:spPr>`
  + `<p:txBody><a:bodyPr><a:normAutofit/></a:bodyPr>${options.lstStyle ?? "<a:lstStyle/>"}${paragraphs}</p:txBody></p:sp>`;

const titleParagraph = (title: string, size: number) => (title ? plainParagraph(title, size) : `<a:p>${endOfParagraph(size)}</a:p>`);

const sizeStyle = (...sizes: number[]) => `<a:lstStyle>${sizes.map((size, level) => `<a:lvl${level + 1}pPr><a:defRPr sz="${size * 100}"/></a:lvl${level + 1}pPr>`).join("")}</a:lstStyle>`;

/** A table as a graphic frame, and how tall it came out: each row as tall as its words need (slideMetrics.ts). */
function tableXml(id: number, table: Table, links: Links, top: number): { xml: string; height: number } {
  const columns = table.header.length;
  const weights = columnWeights(table);
  const sum = weights.reduce((a, b) => a + b, 0);
  const widths = weights.map((weight) => Math.floor((bodyBox.width * weight) / sum));
  const heights = rowHeights(table).map((points) => Math.round(points * 12_700));
  const height = heights.reduce((a, b) => a + b, 0);
  const size = tableFont(table);
  const cell = (inlines: Inline[], column: number, header: boolean) => {
    const align = table.align[column] === "right" ? ' algn="r"' : table.align[column] === "center" ? ' algn="ctr"' : "";
    const runs = runsXml(header ? inlines.map((run) => (run.kind === "text" ? { ...run, bold: true } : run)) : inlines, links, size, header ? colors.navy : colors.ink);
    const border = `<a:lnB w="12700"><a:solidFill><a:srgbClr val="${colors.rule}"/></a:solidFill></a:lnB>`;
    const fill = header ? `<a:solidFill><a:srgbClr val="${colors.mist}"/></a:solidFill>` : "<a:noFill/>";
    return `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p>${align ? `<a:pPr${align}/>` : ""}${runs || endOfParagraph(size)}</a:p></a:txBody><a:tcPr marL="91440" marR="91440" marT="45720" marB="45720" anchor="ctr">${border}${fill}</a:tcPr></a:tc>`;
  };
  const rows = [
    `<a:tr h="${heights[0]}">${table.header.map((inlines, column) => cell(inlines, column, true)).join("")}</a:tr>`,
    ...table.rows.map((row, index) => `<a:tr h="${heights[index + 1]}">${Array.from({ length: columns }, (_, column) => cell(row[column] ?? [], column, false)).join("")}</a:tr>`)
  ].join("");
  const xml = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table ${id}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>`
    + `<p:xfrm><a:off x="${bodyBox.x}" y="${top}"/><a:ext cx="${widths.reduce((a, b) => a + b, 0)}" cy="${height}"/></p:xfrm>`
    + `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"/><a:tblGrid>${widths.map((width) => `<a:gridCol w="${width}"/>`).join("")}</a:tblGrid>${rows}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
  return { xml, height };
}

/**
 * Where a content slide's things go. Tables stay where they were in the outline: what comes before the last one
 * is above it (the text first, then the tables), and what comes after it is below.
 */
export function splitContent(content: SlideContent[]): { texts: SlideContent[]; tables: Table[]; tail: SlideContent[] } {
  const lastTable = content.map((item) => item.kind).lastIndexOf("table");
  const head = lastTable < 0 ? content : content.slice(0, lastTable + 1);
  return {
    texts: head.filter((item) => item.kind !== "table"),
    tables: head.filter((item): item is Table => item.kind === "table"),
    tail: lastTable < 0 ? [] : content.slice(lastTable + 1)
  };
}

function slideXml(slide: Slide, links: Links): string {
  let shapes: string;
  if (slide.kind === "title") {
    const size = titleSize(slide.title, true);
    shapes = placeholder(2, "Title 1", 'type="ctrTitle"', titleParagraph(slide.title, size), { lstStyle: sizeStyle(size) });
    if (slide.subtitle) {
      const sub = subtitleSize(slide.subtitle);
      shapes += placeholder(3, "Subtitle 2", 'type="subTitle" idx="1"', slide.subtitle.split("\n").map((line) => plainParagraph(line, sub)).join(""), { lstStyle: sizeStyle(sub) });
    }
  } else {
    const { texts, tables, tail } = splitContent(slide.content);
    const size = bodySize(slide.content);
    // A box is as tall as the words in it, in the unit a presentation counts in.
    const boxFor = (content: SlideContent[]) => Math.ceil((heightOf(content, size) + 8) * 12_700);
    const titlePoints = titleSize(slide.title, false);
    shapes = placeholder(2, "Title 1", 'type="title"', titleParagraph(slide.title, titlePoints), { lstStyle: sizeStyle(titlePoints) });
    const gap = 150_000;
    let top = bodyBox.y;
    if (texts.length > 0) {
      // With a table below it, the text is given a box of its own, no taller than it needs.
      const height = Math.min(bodyBox.height, boxFor(texts));
      const frame = tables.length > 0 ? xfrm(bodyBox.x, top, bodyBox.width, height) : "";
      shapes += placeholder(3, "Content Placeholder 2", 'idx="1"', bodyParagraphs(texts, links, size), { frame, lstStyle: sizeStyle(size, size - 2, size - 4) });
      top += height + gap;
    }
    tables.forEach((table, index) => {
      const placed = tableXml(4 + index, table, links, top);
      shapes += placed.xml;
      top += placed.height + gap;
    });
    if (tail.length > 0) {
      shapes += `<p:sp><p:nvSpPr><p:cNvPr id="${4 + tables.length}" name="Text ${4 + tables.length}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(bodyBox.x, top, bodyBox.width, boxFor(tail))}${rectangle}<a:noFill/></p:spPr>`
        + `<p:txBody><a:bodyPr wrap="square" rtlCol="0"><a:normAutofit/></a:bodyPr><a:lstStyle/>${bodyParagraphs(tail, links, size, true)}</p:txBody></p:sp>`;
    }
  }
  return `${declaration}<p:sld ${namespaces}><p:cSld><p:spTree>${group}${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

// ---------------------------------------------------------------- the master, layouts and theme

const xfrm = (x: number, y: number, width: number, height: number) => `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${width}" cy="${height}"/></a:xfrm>`;
const rectangle = '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>';
const emptyText = '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody>';

function levelStyle(level: number, size: number, bullet: string | null): string {
  const margin = 342_900 + level * 457_200;
  return `<a:lvl${level + 1}pPr marL="${margin}" indent="-342900" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:lnSpc><a:spcPct val="100000"/></a:lnSpc><a:spcBef><a:spcPts val="${level === 0 ? 1000 : 500}"/></a:spcBef>`
    + (bullet ? `<a:buFont typeface="Arial"/><a:buChar char="${bullet}"/>` : "<a:buNone/>")
    + `<a:defRPr sz="${size}" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl${level + 1}pPr>`;
}

const masterXml = `${declaration}<p:sldMaster ${namespaces}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${group}`
  + `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr>${xfrm(838_200, 365_125, 10_515_600, 1_160_000)}${rectangle}</p:spPr>`
  + '<p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0" anchor="ctr"><a:normAutofit/></a:bodyPr><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Click to edit Master title style</a:t></a:r></a:p></p:txBody></p:sp>'
  + `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Text Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr>${xfrm(bodyBox.x, bodyBox.y, bodyBox.width, bodyBox.height)}${rectangle}</p:spPr>`
  + '<p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0"><a:normAutofit/></a:bodyPr><a:lstStyle/><a:p><a:pPr lvl="0"/><a:r><a:rPr lang="en-US"/><a:t>Click to edit Master text styles</a:t></a:r></a:p></p:txBody></p:sp>'
  + '</p:spTree></p:cSld>'
  + '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'
  + '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/><p:sldLayoutId id="2147483650" r:id="rId2"/></p:sldLayoutIdLst>'
  + `<p:txStyles><p:titleStyle><a:lvl1pPr algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:spcBef><a:spcPct val="0"/></a:spcBef><a:buNone/><a:defRPr sz="3600" b="1" kern="1200"><a:solidFill><a:srgbClr val="${colors.navy}"/></a:solidFill><a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/><a:cs typeface="+mj-cs"/></a:defRPr></a:lvl1pPr></p:titleStyle>`
  + `<p:bodyStyle>${levelStyle(0, 2800, "&#8226;")}${levelStyle(1, 2400, "&#8211;")}${levelStyle(2, 2000, "&#8226;")}${levelStyle(3, 1800, "&#8211;")}${levelStyle(4, 1800, "&#8226;")}</p:bodyStyle>`
  + '<p:otherStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr><a:lvl1pPr marL="0" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>';

const bar = (id: number, geometry: string, color: string) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Accent bar"/><p:cNvSpPr/><p:nvPr userDrawn="1"/></p:nvSpPr><p:spPr>${geometry}${rectangle}<a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr>${emptyText}</p:sp>`;

const titleLayoutXml = `${declaration}<p:sldLayout ${namespaces} type="title" preserve="1"><p:cSld name="Title Slide"><p:bg><p:bgPr><a:solidFill><a:srgbClr val="${colors.navy}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>${group}`
  + bar(4, xfrm(838_200, 3_560_000, 1_828_800, 54_864), colors.glow)
  + `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr><p:spPr>${xfrm(838_200, 1_500_000, 10_515_600, 1_950_000)}</p:spPr><p:txBody><a:bodyPr anchor="b"><a:normAutofit/></a:bodyPr><a:lstStyle><a:lvl1pPr algn="l"><a:defRPr sz="5400" b="1"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:defRPr></a:lvl1pPr></a:lstStyle><a:p><a:r><a:rPr lang="en-US"/><a:t>Click to edit Master title style</a:t></a:r></a:p></p:txBody></p:sp>`
  + `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Subtitle 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="subTitle" idx="1"/></p:nvPr></p:nvSpPr><p:spPr>${xfrm(838_200, 3_760_000, 10_515_600, 1_200_000)}</p:spPr><p:txBody><a:bodyPr><a:normAutofit/></a:bodyPr><a:lstStyle><a:lvl1pPr marL="0" indent="0" algn="l"><a:buNone/><a:defRPr sz="2400"><a:solidFill><a:srgbClr val="${colors.subtitle}"/></a:solidFill></a:defRPr></a:lvl1pPr></a:lstStyle><a:p><a:r><a:rPr lang="en-US"/><a:t>Click to edit Master subtitle style</a:t></a:r></a:p></p:txBody></p:sp>`
  + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>';

const contentLayoutXml = `${declaration}<p:sldLayout ${namespaces} type="obj" preserve="1"><p:cSld name="Title and Content"><p:spTree>${group}`
  + bar(4, xfrm(0, 0, slideWidth, 91_440), colors.accent)
  + '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Click to edit Master title style</a:t></a:r></a:p></p:txBody></p:sp>'
  + '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Content Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr lvl="0"/><a:r><a:rPr lang="en-US"/><a:t>Click to edit Master text styles</a:t></a:r></a:p></p:txBody></p:sp>'
  + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>';

const themeXml = `${declaration}<a:theme xmlns:a="${ns.a}" name="TRH AI"><a:themeElements>`
  + `<a:clrScheme name="TRH AI"><a:dk1><a:srgbClr val="${colors.ink}"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="${colors.navy}"/></a:dk2><a:lt2><a:srgbClr val="${colors.mist}"/></a:lt2>`
  + `<a:accent1><a:srgbClr val="${colors.accent}"/></a:accent1><a:accent2><a:srgbClr val="2E8B6E"/></a:accent2><a:accent3><a:srgbClr val="D98E1F"/></a:accent3><a:accent4><a:srgbClr val="8F80FF"/></a:accent4><a:accent5><a:srgbClr val="C9485B"/></a:accent5><a:accent6><a:srgbClr val="${colors.glow}"/></a:accent6>`
  + `<a:hlink><a:srgbClr val="${colors.accent}"/></a:hlink><a:folHlink><a:srgbClr val="6B4FA0"/></a:folHlink></a:clrScheme>`
  + '<a:fontScheme name="TRH AI"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>'
  + '<a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>'
  + '<a:lnStyleLst><a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln><a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln><a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln></a:lnStyleLst>'
  + '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>'
  + '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>'
  + '</a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>';

// ---------------------------------------------------------------- speaker's notes

// A notes page shows the slide above the speaker's notes. The notes master says where each goes (the slide at
// 16:9, as PowerPoint draws it on a portrait page), and the page for each slide fills in the notes.

const notesPlaceholder = (id: number, name: string, ph: string, box: string, body: string, extra = "") =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"${ph.startsWith('type="sldImg"') ? ' noRot="1" noChangeAspect="1"' : ""}/></p:cNvSpPr><p:nvPr><p:ph ${ph}/></p:nvPr></p:nvSpPr><p:spPr>${box}${rectangle}${extra}</p:spPr>${body}</p:sp>`;

const notesLevel = (level: number) =>
  `<a:lvl${level}pPr marL="${(level - 1) * 457_200}" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1200" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl${level}pPr>`;

/** The text box of a notes-page placeholder that has no text of its own (a header, a footer), or a field in it. */
const smallText = (align: string, anchor = "", field = '<a:endParaRPr lang="en-US"/>') =>
  `<p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0"${anchor}/><a:lstStyle><a:lvl1pPr algn="${align}"><a:defRPr sz="1200"/></a:lvl1pPr></a:lstStyle><a:p>${field}</a:p></p:txBody>`;

const field = (id: string, type: string, text: string) => `<a:fld id="${id}" type="${type}"><a:rPr lang="en-US"/><a:t>${text}</a:t></a:fld><a:endParaRPr lang="en-US"/>`;

const notesMasterXml = `${declaration}<p:notesMaster ${namespaces}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${group}`
  + notesPlaceholder(2, "Header Placeholder 1", 'type="hdr" sz="quarter"', xfrm(0, 0, 2_971_800, 458_788), smallText("l"))
  + notesPlaceholder(3, "Date Placeholder 2", 'type="dt" idx="1"', xfrm(3_884_613, 0, 2_971_800, 458_788), smallText("r", "", field("{0F89C1C7-3DCD-1040-A9CF-14679D8B5DDD}", "datetimeFigureOut", "1/1/2026")))
  + notesPlaceholder(4, "Slide Image Placeholder 3", 'type="sldImg" idx="2"', xfrm(685_800, 1_143_000, 5_486_400, 3_086_100),
    '<p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0" anchor="ctr"/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody>',
    '<a:noFill/><a:ln w="12700"><a:solidFill><a:prstClr val="black"/></a:solidFill></a:ln>')
  + notesPlaceholder(5, "Notes Placeholder 4", 'type="body" sz="quarter" idx="3"', xfrm(685_800, 4_400_550, 5_486_400, 3_600_450),
    '<p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0"/><a:lstStyle/>'
    + ["Click to edit Master text styles", "Second level", "Third level", "Fourth level", "Fifth level"].map((text, level) => `<a:p><a:pPr lvl="${level}"/><a:r><a:rPr lang="en-US"/><a:t>${text}</a:t></a:r></a:p>`).join("")
    + "</p:txBody>")
  + notesPlaceholder(6, "Footer Placeholder 5", 'type="ftr" sz="quarter" idx="4"', xfrm(0, 8_685_213, 2_971_800, 458_787), smallText("l", ' anchor="b"'))
  + notesPlaceholder(7, "Slide Number Placeholder 6", 'type="sldNum" sz="quarter" idx="5"', xfrm(3_884_613, 8_685_213, 2_971_800, 458_787), smallText("r", ' anchor="b"', field("{BB5E49A5-4136-284D-997B-48E1D791AD67}", "slidenum", "&#8249;#&#8250;")))
  + '</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'
  + `<p:notesStyle>${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(notesLevel).join("")}</p:notesStyle></p:notesMaster>`;

function notesSlideXml(notes: string[]): string {
  return `${declaration}<p:notes ${namespaces}><p:cSld><p:spTree>${group}`
    + '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>'
    + `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" sz="quarter" idx="3"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${notes.map((text) => plainParagraph(text)).join("")}</p:txBody></p:sp>`
    + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>';
}

// ---------------------------------------------------------------- the presentation

const w3cDate = (when: Date) => when.toISOString().replace(/\.\d{3}Z$/, "Z");
const rels = (entries: Array<[string, string, string, boolean?]>) =>
  `${declaration}<Relationships xmlns="${relNamespace}">${entries.map(([id, type, target, external]) => `<Relationship Id="${id}" Type="${type}" Target="${escapeXml(target)}"${external ? ' TargetMode="External"' : ""}/>`).join("")}</Relationships>`;

export function pptxFile(slides: Slide[], options: DeckFileOptions): Buffer {
  if (slides.length === 0) throw new Error("A presentation needs at least one slide.");
  const when = options.date ?? new Date();
  const withNotes = slides.filter((slide) => slide.notes.length > 0).length;

  const parts = slides.map((slide, index) => {
    const links: Links = { ids: new Map(), next: 2 };
    const xml = slideXml(slide, links);
    const entries: Array<[string, string, string, boolean?]> = [
      ["rId1", relType("slideLayout"), `../slideLayouts/slideLayout${slide.kind === "title" ? 1 : 2}.xml`],
      ...[...links.ids].map(([href, id]) => [id, relType("hyperlink"), href, true] as [string, string, string, boolean])
    ];
    const notes = slide.notes.length > 0 ? notesSlideXml(slide.notes) : null;
    if (notes) entries.push([`rId${links.next}`, relType("notesSlide"), `../notesSlides/notesSlide${index + 1}.xml`]);
    return { xml, relationships: rels(entries), notes };
  });

  const slideIds = slides.map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`).join("");
  const tail = slides.length + 2;
  const notesMasterId = `rId${tail + 4}`;
  const presentation = `${declaration}<p:presentation ${namespaces} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>`
    + (withNotes > 0 ? `<p:notesMasterIdLst><p:notesMasterId r:id="${notesMasterId}"/></p:notesMasterIdLst>` : "")
    + `<p:sldIdLst>${slideIds}</p:sldIdLst><p:sldSz cx="${slideWidth}" cy="${slideHeight}"/><p:notesSz cx="6858000" cy="9144000"/>`
    + '<p:defaultTextStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr></p:defaultTextStyle></p:presentation>';
  const presentationRels = rels([
    ["rId1", relType("slideMaster"), "slideMasters/slideMaster1.xml"],
    ...slides.map((_, index) => [`rId${index + 2}`, relType("slide"), `slides/slide${index + 1}.xml`] as [string, string, string]),
    [`rId${tail}`, relType("presProps"), "presProps.xml"],
    [`rId${tail + 1}`, relType("viewProps"), "viewProps.xml"],
    [`rId${tail + 2}`, relType("theme"), "theme/theme1.xml"],
    [`rId${tail + 3}`, relType("tableStyles"), "tableStyles.xml"],
    ...(withNotes > 0 ? [[notesMasterId, relType("notesMaster"), "notesMasters/notesMaster1.xml"] as [string, string, string]] : [])
  ]);

  const override = (part: string, type: string) => `<Override PartName="${part}" ContentType="${type}"/>`;
  const themeType = "application/vnd.openxmlformats-officedocument.theme+xml";
  const contentTypes = `${declaration}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
    + override("/ppt/presentation.xml", contentType("presentation.main"))
    + override("/ppt/slideMasters/slideMaster1.xml", contentType("slideMaster"))
    + override("/ppt/slideLayouts/slideLayout1.xml", contentType("slideLayout"))
    + override("/ppt/slideLayouts/slideLayout2.xml", contentType("slideLayout"))
    + slides.map((_, index) => override(`/ppt/slides/slide${index + 1}.xml`, contentType("slide"))).join("")
    + override("/ppt/theme/theme1.xml", themeType)
    + override("/ppt/presProps.xml", contentType("presProps"))
    + override("/ppt/viewProps.xml", contentType("viewProps"))
    + override("/ppt/tableStyles.xml", contentType("tableStyles"))
    + (withNotes > 0 ? override("/ppt/notesMasters/notesMaster1.xml", contentType("notesMaster")) + override("/ppt/theme/theme2.xml", themeType) : "")
    + parts.map((part, index) => (part.notes ? override(`/ppt/notesSlides/notesSlide${index + 1}.xml`, contentType("notesSlide")) : "")).join("")
    + override("/docProps/core.xml", "application/vnd.openxmlformats-package.core-properties+xml")
    + override("/docProps/app.xml", "application/vnd.openxmlformats-officedocument.extended-properties+xml")
    + "</Types>";
  const rootRels = rels([
    ["rId1", relType("officeDocument"), "ppt/presentation.xml"],
    ["rId2", "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties", "docProps/core.xml"],
    ["rId3", relType("extended-properties"), "docProps/app.xml"]
  ]);
  const core = `${declaration}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`
    + `<dc:title>${escapeXml(options.title)}</dc:title><dc:creator>${escapeXml(options.author ?? "TRH AI")}</dc:creator><cp:lastModifiedBy>TRH AI</cp:lastModifiedBy>`
    + `<dcterms:created xsi:type="dcterms:W3CDTF">${w3cDate(when)}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${w3cDate(when)}</dcterms:modified></cp:coreProperties>`;
  const app = `${declaration}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>TRH AI</Application><Slides>${slides.length}</Slides>${withNotes > 0 ? `<Notes>${withNotes}</Notes>` : ""}</Properties>`;
  const viewProps = `${declaration}<p:viewPr ${namespaces}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:slideViewPr><p:cSldViewPr><p:cViewPr varScale="1"><p:scale><a:sx n="100" d="100"/><a:sy n="100" d="100"/></p:scale><p:origin x="0" y="0"/></p:cViewPr></p:cSldViewPr></p:slideViewPr><p:notesTextViewPr><p:cViewPr><p:scale><a:sx n="1" d="1"/><a:sy n="1" d="1"/></p:scale><p:origin x="0" y="0"/></p:cViewPr></p:notesTextViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`;
  const masterRels = rels([["rId1", relType("slideLayout"), "../slideLayouts/slideLayout1.xml"], ["rId2", relType("slideLayout"), "../slideLayouts/slideLayout2.xml"], ["rId3", relType("theme"), "../theme/theme1.xml"]]);
  const layoutRels = rels([["rId1", relType("slideMaster"), "../slideMasters/slideMaster1.xml"]]);

  return writeZip([
    { name: "[Content_Types].xml", data: contentTypes },
    { name: "_rels/.rels", data: rootRels },
    { name: "ppt/presentation.xml", data: presentation },
    { name: "ppt/_rels/presentation.xml.rels", data: presentationRels },
    { name: "ppt/slideMasters/slideMaster1.xml", data: masterXml },
    { name: "ppt/slideMasters/_rels/slideMaster1.xml.rels", data: masterRels },
    { name: "ppt/slideLayouts/slideLayout1.xml", data: titleLayoutXml },
    { name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels", data: layoutRels },
    { name: "ppt/slideLayouts/slideLayout2.xml", data: contentLayoutXml },
    { name: "ppt/slideLayouts/_rels/slideLayout2.xml.rels", data: layoutRels },
    { name: "ppt/theme/theme1.xml", data: themeXml },
    { name: "ppt/presProps.xml", data: `${declaration}<p:presentationPr ${namespaces}/>` },
    { name: "ppt/viewProps.xml", data: viewProps },
    { name: "ppt/tableStyles.xml", data: `${declaration}<a:tblStyleLst xmlns:a="${ns.a}" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>` },
    ...parts.flatMap((part, index) => [
      { name: `ppt/slides/slide${index + 1}.xml`, data: part.xml },
      { name: `ppt/slides/_rels/slide${index + 1}.xml.rels`, data: part.relationships },
      ...(part.notes ? [
        { name: `ppt/notesSlides/notesSlide${index + 1}.xml`, data: part.notes },
        { name: `ppt/notesSlides/_rels/notesSlide${index + 1}.xml.rels`, data: rels([["rId1", relType("notesMaster"), "../notesMasters/notesMaster1.xml"], ["rId2", relType("slide"), `../slides/slide${index + 1}.xml`]]) }
      ] : [])
    ]),
    ...(withNotes > 0 ? [
      { name: "ppt/notesMasters/notesMaster1.xml", data: notesMasterXml },
      { name: "ppt/notesMasters/_rels/notesMaster1.xml.rels", data: rels([["rId1", relType("theme"), "../theme/theme2.xml"]]) },
      { name: "ppt/theme/theme2.xml", data: themeXml }
    ] : []),
    { name: "docProps/core.xml", data: core },
    { name: "docProps/app.xml", data: app }
  ], { date: when });
}
