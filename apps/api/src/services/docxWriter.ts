import type { Block, Inline, ListItem } from "./markdown.js";
import { plainText } from "./markdown.js";
import { safeHref, type Paper } from "./documentHtml.js";
import { writeZip } from "./zipWriter.js";

// A Word document (.docx) from the same blocks the web page is made from.
//
// A .docx is a zip of XML parts. This writes the few Word needs - the document,
// its styles, the list numbering, the properties - by hand, with no library, and
// the tests read the result back with the same reader TRH AI uses on Word files
// it is given, and check every part is well-formed XML.

export type DocxOptions = {
  title: string;
  author?: string;
  paper?: Paper;
  /** BCP 47, for the spell checker: "en-GB". */
  language?: string;
  date?: Date;
};

const forbidden = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(11)}${String.fromCharCode(12)}${String.fromCharCode(14)}-${String.fromCharCode(31)}${String.fromCharCode(0xfffe)}${String.fromCharCode(0xffff)}]`, "g");

/** Text that can sit in XML: the marks escaped, and the control characters XML does not allow dropped. */
export const escapeXml = (text: string): string =>
  text.replace(forbidden, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const namespaces = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** Page sizes and the margins used, in twentieths of a point (the unit Word counts in). */
const pages = {
  A4: { width: 11906, height: 16838 },
  Letter: { width: 12240, height: 15840 }
} as const;
const margin = 1134; // two centimetres

// ---------------------------------------------------------------- runs

type Context = { links: Map<string, string>; numberings: Array<{ id: number; start: number }>; nextNumbering: number };

function runXml(run: Inline, context: Context): string {
  if (run.kind === "break") return "<w:r><w:br/></w:r>";
  const href = run.href ? safeHref(run.href) : null;
  let properties = "";
  if (href && !href.startsWith("#")) properties += '<w:rStyle w:val="Hyperlink"/>';
  else if (run.code) properties += '<w:rStyle w:val="CodeChar"/>';
  if (run.bold) properties += "<w:b/>";
  if (run.italic) properties += "<w:i/>";
  if (run.strike) properties += "<w:strike/>";
  const body = `<w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ""}<w:t xml:space="preserve">${escapeXml(run.text)}</w:t></w:r>`;
  if (!href || href.startsWith("#")) return body;
  let id = context.links.get(href);
  if (!id) { id = `rId${100 + context.links.size}`; context.links.set(href, id); }
  return `<w:hyperlink r:id="${id}" w:history="1">${body}</w:hyperlink>`;
}

const inlinesXml = (inlines: Inline[], context: Context) => inlines.map((run) => runXml(run, context)).join("");

function paragraph(inlines: Inline[], context: Context, properties = ""): string {
  return `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ""}${inlinesXml(inlines, context)}</w:p>`;
}

// ---------------------------------------------------------------- blocks

const bulletNumId = 1;

function listXml(block: Extract<Block, { kind: "list" }>, level: number, context: Context): string {
  const depth = Math.min(level, 8);
  let numId = bulletNumId;
  if (block.ordered) {
    numId = context.nextNumbering;
    context.nextNumbering += 1;
    context.numberings.push({ id: numId, start: block.start });
  }
  const numbering = `<w:numPr><w:ilvl w:val="${depth}"/><w:numId w:val="${numId}"/></w:numPr>`;
  return block.items.map((item: ListItem) => {
    const own = paragraph(item.inlines.length ? item.inlines : [{ kind: "text", text: "" }], context, `<w:pStyle w:val="ListParagraph"/>${numbering}`);
    const children = item.children.map((child) => {
      if (child.kind === "list") return listXml(child, level + 1, context);
      // A paragraph or anything else under an item lines up with the item's text.
      return blockXml(child, context, { indent: 720 + 360 * depth });
    }).join("");
    return own + children;
  }).join("");
}

function tableXml(block: Extract<Block, { kind: "table" }>, context: Context, paper: Paper): string {
  const columns = block.header.length;
  const total = pages[paper].width - 2 * margin;
  // Columns share the width in proportion to how much text they hold, within reason.
  const weights = block.header.map((header, column) => {
    const longest = Math.max(plainText(header).length, ...block.rows.map((row) => plainText(row[column] ?? []).length));
    return Math.min(40, Math.max(6, longest));
  });
  const sum = weights.reduce((a, b) => a + b, 0);
  const widths = weights.map((weight) => Math.floor((total * weight) / sum));
  const justify = (align: string | null) => (align === "center" ? '<w:jc w:val="center"/>' : align === "right" ? '<w:jc w:val="right"/>' : "");
  const cell = (inlines: Inline[], column: number, header: boolean) =>
    `<w:tc><w:tcPr><w:tcW w:w="${widths[column]}" w:type="dxa"/>${header ? '<w:shd w:val="clear" w:color="auto" w:fill="EAEFF6"/>' : ""}</w:tcPr>`
    + paragraph(header ? inlines.map((run) => (run.kind === "text" ? { ...run, bold: true } : run)) : inlines, context, `<w:spacing w:before="40" w:after="40"/>${justify(block.align[column])}`)
    + "</w:tc>";
  const rows = [
    `<w:tr><w:trPr><w:cantSplit/><w:tblHeader/></w:trPr>${block.header.map((inlines, column) => cell(inlines, column, true)).join("")}</w:tr>`,
    ...block.rows.map((row) => `<w:tr><w:trPr><w:cantSplit/></w:trPr>${Array.from({ length: columns }, (_, column) => cell(row[column] ?? [], column, false)).join("")}</w:tr>`)
  ];
  return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="${total}" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>`
    + `<w:tblGrid>${widths.map((width) => `<w:gridCol w:w="${width}"/>`).join("")}</w:tblGrid>${rows.join("")}</w:tbl>`
    // A table must be followed by a paragraph, or Word has nothing to put the cursor in.
    + '<w:p><w:pPr><w:spacing w:after="0"/></w:pPr></w:p>';
}

function blockXml(block: Block, context: Context, options: { indent?: number; paper?: Paper } = {}): string {
  const indent = options.indent ? `<w:ind w:left="${options.indent}"/>` : "";
  switch (block.kind) {
    case "heading": return paragraph(block.inlines, context, `<w:pStyle w:val="Heading${block.level}"/>`);
    case "paragraph": return paragraph(block.inlines, context, indent);
    case "list": return listXml(block, 0, context);
    case "code": {
      const lines = block.text.split("\n");
      return lines.map((line) => `<w:p><w:pPr><w:pStyle w:val="CodeBlock"/></w:pPr><w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`).join("")
        + '<w:p><w:pPr><w:spacing w:after="0" w:line="120" w:lineRule="exact"/></w:pPr></w:p>';
    }
    case "table": return tableXml(block, context, options.paper ?? "A4");
    case "quote": return block.blocks.map((inner) => {
      if (inner.kind === "paragraph") return paragraph(inner.inlines, context, '<w:pStyle w:val="Quote"/>');
      return blockXml(inner, context, { ...options, indent: 720 });
    }).join("");
    case "rule": return '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="B8C0CC"/></w:pBdr><w:spacing w:before="120" w:after="120"/></w:pPr></w:p>';
    case "pagebreak": return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
  }
}

// ---------------------------------------------------------------- parts

const heading = (level: number, size: number, before: number, after: number, color: string) =>
  `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/>`
  + `<w:pPr><w:keepNext/><w:keepLines/>${level === 1 ? '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="2" w:color="C7CED9"/></w:pBdr>' : ""}<w:spacing w:before="${before}" w:after="${after}"/><w:outlineLvl w:val="${level - 1}"/></w:pPr>`
  + `<w:rPr><w:b/><w:color w:val="${color}"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;

function stylesXml(language: string): string {
  return `${declaration}<w:styles ${namespaces}>`
    + `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="${escapeXml(language)}" w:eastAsia="en-US" w:bidi="ar-SA"/></w:rPr></w:rPrDefault>`
    + '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
    + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
    + '<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/></w:style>'
    + '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>'
    + '<w:style w:type="numbering" w:default="1" w:styleId="NoList"><w:name w:val="No List"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/></w:style>'
    + heading(1, 44, 0, 160, "14233C") + heading(2, 30, 280, 100, "14233C") + heading(3, 25, 220, 80, "14233C")
    + heading(4, 23, 180, 60, "14233C") + heading(5, 22, 160, 60, "14233C") + heading(6, 22, 160, 60, "5A6578")
    + '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="34"/><w:qFormat/><w:pPr><w:spacing w:after="40"/><w:contextualSpacing/></w:pPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="29"/><w:qFormat/><w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="9FB0C6"/></w:pBdr><w:ind w:left="360"/></w:pPr><w:rPr><w:color w:val="3D4654"/></w:rPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="Code Block"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="99"/><w:qFormat/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F5F6F8"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:ind w:left="120" w:right="120"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="19"/><w:szCs w:val="19"/></w:rPr></w:style>'
    + '<w:style w:type="character" w:styleId="CodeChar"><w:name w:val="Code Char"/><w:basedOn w:val="DefaultParagraphFont"/><w:uiPriority w:val="99"/><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="20"/><w:szCs w:val="20"/><w:shd w:val="clear" w:color="auto" w:fill="F1F2F4"/></w:rPr></w:style>'
    + '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:basedOn w:val="DefaultParagraphFont"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:rPr><w:color w:val="1A5FB4"/><w:u w:val="single"/></w:rPr></w:style>'
    + '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:uiPriority w:val="39"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:tblPr><w:tblBorders>'
    + ["top", "left", "bottom", "right", "insideH", "insideV"].map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="B8C0CC"/>`).join("")
    + "</w:tblBorders></w:tblPr></w:style>"
    + "</w:styles>";
}

const bulletSymbols = ["•", "◦", "▪"];
const orderedFormats = [["decimal", "%1."], ["lowerLetter", "%2."], ["lowerRoman", "%3."]] as const;

function numberingXml(numberings: Array<{ id: number; start: number }>): string {
  const levels = (ordered: boolean) => Array.from({ length: 9 }, (_, level) => {
    const left = 720 + 360 * level;
    const [format, text] = ordered ? orderedFormats[level % 3] : ["bullet", bulletSymbols[level % 3]];
    const shown = ordered ? text.replace(/%\d/, `%${level + 1}`) : text;
    return `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${shown}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${left}" w:hanging="360"/></w:pPr>${ordered ? "" : '<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/></w:rPr>'}</w:lvl>`;
  }).join("");
  return `${declaration}<w:numbering ${namespaces}>`
    + `<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${levels(false)}</w:abstractNum>`
    + `<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${levels(true)}</w:abstractNum>`
    + `<w:num w:numId="${bulletNumId}"><w:abstractNumId w:val="0"/></w:num>`
    + numberings.map(({ id, start }) => `<w:num w:numId="${id}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="${start}"/></w:lvlOverride></w:num>`).join("")
    + "</w:numbering>";
}

const contentTypes = `${declaration}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + '<Default Extension="xml" ContentType="application/xml"/>'
  + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
  + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
  + '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>'
  + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
  + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
  + "</Types>";

const rootRelationships = `${declaration}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
  + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
  + '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>'
  + "</Relationships>";

const w3cDate = (when: Date) => when.toISOString().replace(/\.\d{3}Z$/, "Z");

export function docxFile(blocks: Block[], options: DocxOptions): Buffer {
  const paper = options.paper ?? "A4";
  const language = options.language ?? "en-GB";
  const when = options.date ?? new Date();
  const context: Context = { links: new Map(), numberings: [], nextNumbering: bulletNumId + 1 };
  const body = blocks.map((block) => blockXml(block, context, { paper })).join("");
  const size = pages[paper];
  const document = `${declaration}<w:document ${namespaces}><w:body>${body || "<w:p/>"}`
    + `<w:sectPr><w:pgSz w:w="${size.width}" w:h="${size.height}"/><w:pgMar w:top="${margin}" w:right="${margin}" w:bottom="${margin}" w:left="${margin}" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const relationships = `${declaration}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>'
    + [...context.links].map(([href, id]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${escapeXml(href)}" TargetMode="External"/>`).join("")
    + "</Relationships>";
  const core = `${declaration}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`
    + `<dc:title>${escapeXml(options.title)}</dc:title><dc:creator>${escapeXml(options.author ?? "TRH AI")}</dc:creator><cp:lastModifiedBy>TRH AI</cp:lastModifiedBy>`
    + `<dcterms:created xsi:type="dcterms:W3CDTF">${w3cDate(when)}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${w3cDate(when)}</dcterms:modified></cp:coreProperties>`;
  const app = `${declaration}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>TRH AI</Application></Properties>`;
  return writeZip([
    { name: "[Content_Types].xml", data: contentTypes },
    { name: "_rels/.rels", data: rootRelationships },
    { name: "word/document.xml", data: document },
    { name: "word/_rels/document.xml.rels", data: relationships },
    { name: "word/styles.xml", data: stylesXml(language) },
    { name: "word/numbering.xml", data: numberingXml(context.numberings) },
    { name: "docProps/core.xml", data: core },
    { name: "docProps/app.xml", data: app }
  ], { date: when });
}
