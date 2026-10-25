import { escapeXml } from "./docxWriter.js";
import { cellName, columnLetters, isError, type Value } from "./formulas.js";
import { writeZip } from "./zipWriter.js";

// An Excel workbook (.xlsx) from sheets of cells.
//
// Like a Word file, an .xlsx is a zip of XML parts, and this writes the few a
// workbook needs by hand: the workbook, one part for each sheet, the styles, and
// the document properties. Text is written in the cell itself (inline) rather
// than in a table of shared strings, which every reader takes and which needs
// one part fewer. A formula is written with its last answer beside it, so a
// viewer that does not calculate still shows numbers, and the workbook is
// marked to be worked out again when it is opened.

export type WriteCell =
  | { kind: "empty" }
  | { kind: "text"; text: string }
  | { kind: "number"; value: number; format: string | null }
  | { kind: "boolean"; value: boolean }
  | { kind: "date"; serial: number; format: string }
  /** `format` is how its answer is shown, when it is a number: the same as the cells it is worked out from. */
  | { kind: "formula"; formula: string; cached: Value | undefined; format?: string | null };

export type WriteSheet = { name: string; rows: WriteCell[][]; header: boolean };
export type WorkbookOptions = { title: string; author?: string; date?: Date };

const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const mainNamespace = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const relationshipsNamespace = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** Sheet names a workbook accepts: up to 31 letters, none of []:*?/\ , not blank, each different from the others without regard to case. */
export function sheetNames(wanted: string[]): string[] {
  const used = new Set<string>();
  return wanted.map((name, index) => {
    const base = name.replace(/[\][:*?/\\]/g, " ").replace(/\s+/g, " ").replace(/^'+|'+$/g, "").trim().slice(0, 31).trim() || `Sheet${index + 1}`;
    let candidate = base;
    for (let number = 2; used.has(candidate.toLowerCase()); number += 1) {
      const suffix = ` (${number})`;
      candidate = `${base.slice(0, 31 - suffix.length).trim()}${suffix}`;
    }
    used.add(candidate.toLowerCase());
    return candidate;
  });
}

// ---------------------------------------------------------------- styles

/** The number formats a workbook has built in, by their code. */
const builtIn: Record<string, number> = { "0": 1, "0.00": 2, "#,##0": 3, "#,##0.00": 4, "0%": 9, "0.00%": 10 };

type Style = { format: string | null; header?: boolean; align?: "left" | "right" | "center"; wrap?: boolean };

class StyleBook {
  readonly formats = new Map<string, number>();
  readonly styles: Style[] = [{ format: null }];
  private readonly index = new Map<string, number>([[JSON.stringify({ format: null, header: false, align: null, wrap: false }), 0]]);

  /** The place of a style among the workbook's, added the first time it is asked for. */
  of(style: Style): number {
    const key = JSON.stringify({ format: style.format, header: style.header ?? false, align: style.align ?? null, wrap: style.wrap ?? false });
    const found = this.index.get(key);
    if (found !== undefined) return found;
    this.styles.push(style);
    this.index.set(key, this.styles.length - 1);
    if (style.format && builtIn[style.format] === undefined && !this.formats.has(style.format)) this.formats.set(style.format, 164 + this.formats.size);
    return this.styles.length - 1;
  }

  xml(): string {
    const numberFormat = (code: string | null) => (code === null ? 0 : builtIn[code] ?? this.formats.get(code) ?? 0);
    const custom = [...this.formats].map(([code, id]) => `<numFmt numFmtId="${id}" formatCode="${escapeXml(code)}"/>`).join("");
    const cells = this.styles.map((style) => {
      const alignment = style.align || style.wrap ? `<alignment${style.align ? ` horizontal="${style.align}"` : ""}${style.wrap ? ' wrapText="1" vertical="top"' : ""}/>` : "";
      return `<xf numFmtId="${numberFormat(style.format)}" fontId="${style.header ? 1 : 0}" fillId="${style.header ? 2 : 0}" borderId="${style.header ? 1 : 0}" xfId="0"`
        + `${style.format ? ' applyNumberFormat="1"' : ""}${style.header ? ' applyFont="1" applyFill="1" applyBorder="1"' : ""}${alignment ? ` applyAlignment="1">${alignment}</xf>` : "/>"}`;
    }).join("");
    return `${declaration}<styleSheet xmlns="${mainNamespace}">`
      + (custom ? `<numFmts count="${this.formats.size}">${custom}</numFmts>` : "")
      + '<fonts count="2"><font><sz val="11"/><color rgb="FF1C1C1E"/><name val="Calibri"/><family val="2"/></font>'
      + '<font><b/><sz val="11"/><color rgb="FF14233C"/><name val="Calibri"/><family val="2"/></font></fonts>'
      + '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
      + '<fill><patternFill patternType="solid"><fgColor rgb="FFEAEFF6"/><bgColor indexed="64"/></patternFill></fill></fills>'
      + '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>'
      + '<border><left/><right/><top/><bottom style="thin"><color rgb="FFB8C0CC"/></bottom><diagonal/></border></borders>'
      + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
      + `<cellXfs count="${this.styles.length}">${cells}</cellXfs>`
      + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
  }
}

// ---------------------------------------------------------------- what a cell shows

/** About what a cell shows, for the width of its column. */
function shown(cell: WriteCell): string {
  switch (cell.kind) {
    case "empty": return "";
    case "text": return cell.text.split("\n").reduce((longest, line) => (line.length > longest.length ? line : longest), "");
    case "boolean": return "FALSE";
    case "date": return cell.format.includes("h") ? "2026-03-04 12:00" : cell.format.includes("mmmm") ? "September 30, 2026" : "2026-03-04";
    case "number": return numberShown(cell.value, cell.format);
    case "formula": {
      const value = cell.cached;
      if (value === undefined || value === null) return "0000000000";
      if (isError(value)) return value.error;
      return typeof value === "number" ? numberShown(value, null) : typeof value === "boolean" ? "FALSE" : value;
    }
  }
}

function numberShown(value: number, format: string | null): string {
  const decimals = format?.match(/\.(0+)/)?.[1].length ?? undefined;
  if (format?.includes("%")) return `${(value * 100).toFixed(decimals ?? 0)}%`;
  if (format?.includes(",")) return value.toLocaleString("en-US", { minimumFractionDigits: decimals ?? 0, maximumFractionDigits: decimals ?? 0 }) + (format.startsWith('"') ? "$" : "");
  return decimals !== undefined ? value.toFixed(decimals) : String(Math.round(value * 1e9) / 1e9);
}

const wantsToWrap = (text: string) => text.includes("\n") || text.length > 60;

// ---------------------------------------------------------------- one sheet

function sheetXml(sheet: WriteSheet, book: StyleBook, selected: boolean): string {
  const rows = sheet.rows;
  const columns = rows[0]?.length ?? 0;
  const headerRow = sheet.header && rows.length >= 2;

  // Whether a column is numbers, for the way its heading sits above it.
  const numeric = Array.from({ length: columns }, (_, column) => {
    const body = rows.slice(headerRow ? 1 : 0).map((row) => row[column]).filter((cell) => cell.kind !== "empty");
    return body.length > 0 && body.every((cell) => cell.kind === "number" || cell.kind === "date" || (cell.kind === "formula" && typeof cell.cached === "number"));
  });

  const widths = Array.from({ length: columns }, (_, column) => {
    let longest = 0;
    rows.forEach((row, index) => {
      const text = shown(row[column]);
      longest = Math.max(longest, text.length + (headerRow && index === 0 ? 2 : 0));
    });
    return Math.min(60, Math.max(8, Math.ceil(longest * 1.1) + 2));
  });

  const rowXml = rows.map((row, rowIndex) => {
    const header = headerRow && rowIndex === 0;
    const cells = row.map((cell, column) => {
      const at = cellName(column, rowIndex);
      const style = (format: string | null, text?: string) => book.of({
        format,
        ...(header ? { header: true, align: numeric[column] ? "right" as const : "left" as const } : {}),
        ...(text !== undefined && wantsToWrap(text) ? { wrap: true } : {})
      });
      switch (cell.kind) {
        case "empty": return header ? `<c r="${at}" s="${style(null)}"/>` : "";
        case "text": {
          const index = style(null, cell.text);
          return `<c r="${at}"${index ? ` s="${index}"` : ""} t="inlineStr"><is><t xml:space="preserve">${escapeXml(cell.text)}</t></is></c>`;
        }
        case "number": {
          const index = style(cell.format);
          return `<c r="${at}"${index ? ` s="${index}"` : ""}><v>${cell.value}</v></c>`;
        }
        case "date": {
          const index = style(cell.format);
          return `<c r="${at}" s="${index}"><v>${cell.serial}</v></c>`;
        }
        case "boolean": {
          const index = style(null);
          return `<c r="${at}"${index ? ` s="${index}"` : ""} t="b"><v>${cell.value ? 1 : 0}</v></c>`;
        }
        case "formula": {
          const index = style(cell.format ?? null);
          const attributes = `${index ? ` s="${index}"` : ""}`;
          const formula = `<f>${escapeXml(cell.formula)}</f>`;
          const value = cell.cached;
          if (value === undefined) return `<c r="${at}"${attributes}>${formula}</c>`;
          if (isError(value)) return `<c r="${at}"${attributes} t="e">${formula}<v>${value.error}</v></c>`;
          if (typeof value === "string") return `<c r="${at}"${attributes} t="str">${formula}<v>${escapeXml(value)}</v></c>`;
          if (typeof value === "boolean") return `<c r="${at}"${attributes} t="b">${formula}<v>${value ? 1 : 0}</v></c>`;
          return `<c r="${at}"${attributes}>${formula}<v>${value === null ? 0 : value}</v></c>`;
        }
      }
    }).join("");
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join("");

  const last = `${columnLetters(Math.max(0, columns - 1))}${Math.max(1, rows.length)}`;
  const pane = headerRow ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/>' : "";
  return `${declaration}<worksheet xmlns="${mainNamespace}" xmlns:r="${relationshipsNamespace}">`
    + `<dimension ref="A1:${last}"/>`
    + `<sheetViews><sheetView workbookViewId="0"${selected ? ' tabSelected="1"' : ""}>${pane}</sheetView></sheetViews>`
    + '<sheetFormatPr defaultRowHeight="15"/>'
    + `<cols>${widths.map((width, column) => `<col min="${column + 1}" max="${column + 1}" width="${width}" customWidth="1"/>`).join("")}</cols>`
    + `<sheetData>${rowXml}</sheetData>`
    + (headerRow ? `<autoFilter ref="A1:${last}"/>` : "")
    + '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>'
    + "</worksheet>";
}

// ---------------------------------------------------------------- the workbook

const w3cDate = (when: Date) => when.toISOString().replace(/\.\d{3}Z$/, "Z");

export function xlsxFile(sheets: WriteSheet[], options: WorkbookOptions): Buffer {
  if (sheets.length === 0) throw new Error("A workbook needs at least one sheet.");
  const names = sheetNames(sheets.map((sheet) => sheet.name));
  const when = options.date ?? new Date();
  const book = new StyleBook();
  const parts = sheets.map((sheet, index) => sheetXml(sheet, book, index === 0));

  const contentTypes = `${declaration}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
    + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
    + "</Types>";
  const rootRelationships = `${declaration}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
    + '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>'
    + "</Relationships>";
  const workbook = `${declaration}<workbook xmlns="${mainNamespace}" xmlns:r="${relationshipsNamespace}">`
    + '<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="24000" windowHeight="12000"/></bookViews>'
    + `<sheets>${names.map((name, index) => `<sheet name="${escapeXml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets>`
    + '<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>';
  const workbookRelationships = `${declaration}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("")
    + `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
    + "</Relationships>";
  const core = `${declaration}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`
    + `<dc:title>${escapeXml(options.title)}</dc:title><dc:creator>${escapeXml(options.author ?? "TRH AI")}</dc:creator><cp:lastModifiedBy>TRH AI</cp:lastModifiedBy>`
    + `<dcterms:created xsi:type="dcterms:W3CDTF">${w3cDate(when)}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${w3cDate(when)}</dcterms:modified></cp:coreProperties>`;
  const app = `${declaration}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>TRH AI</Application></Properties>`;

  return writeZip([
    { name: "[Content_Types].xml", data: contentTypes },
    { name: "_rels/.rels", data: rootRelationships },
    { name: "xl/workbook.xml", data: workbook },
    { name: "xl/_rels/workbook.xml.rels", data: workbookRelationships },
    { name: "xl/styles.xml", data: book.xml() },
    ...parts.map((data, index) => ({ name: `xl/worksheets/sheet${index + 1}.xml`, data })),
    { name: "docProps/core.xml", data: core },
    { name: "docProps/app.xml", data: app }
  ], { date: when });
}
