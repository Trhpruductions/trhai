import { decodeEntities, readZip } from "./documentText.js";
import { columnNumber } from "./formulas.js";
import { dateOfSerial } from "./sheetData.js";

// What is in an Excel workbook (.xlsx), as a person would see it in each cell: text
// as it is written, a number as it is formatted (a date as a date, a percentage as
// a percentage), and beside it the formula when there is one. Read from the
// workbook's own parts - the sheets' names, the table of shared strings, the
// styles that say which numbers are dates - with no library, as Word and PowerPoint
// files are read in documentText.ts. Used for the text the assistant is given from
// a spreadsheet, and to read back a workbook TRH AI has just made.

/** `value` is the number a number, a percentage or a date is stored as; `text` is what is shown. */
export type ReadCell = { kind: "empty" | "text" | "number" | "date" | "boolean" | "error"; text: string; value?: number; formula?: string };
export type ReadSheet = { name: string; hidden: boolean; rows: ReadCell[][] };
export type Workbook = { sheets: ReadSheet[] };

const empty: ReadCell = { kind: "empty", text: "" };

const attribute = (tag: string, name: string): string | undefined => {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag);
  return match ? decodeEntities(match[1] ?? match[2] ?? "") : undefined;
};

/** The text inside `<t>` elements, leaving out the phonetic guides a workbook can carry beside Japanese text. */
const textRuns = (xml: string): string =>
  [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((match) => decodeEntities(match[1])).join("");

/** Whether a number format, by its id and its code, shows a date or a time. */
function showsADate(id: number, code: string | undefined): boolean {
  if ((id >= 14 && id <= 22) || (id >= 27 && id <= 36) || (id >= 45 && id <= 47) || (id >= 50 && id <= 58)) return true;
  if (!code) return false;
  const bare = code.replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "").replace(/\\./g, "");
  return /[dyhs]/i.test(bare);
}

type Look = { date: boolean; percent: boolean };

function readStyles(xml: string | undefined): Look[] {
  if (!xml) return [];
  const codes = new Map<number, string>();
  for (const match of xml.matchAll(/<numFmt\b[^>]*>/g)) {
    const id = Number(attribute(match[0], "numFmtId"));
    const code = attribute(match[0], "formatCode");
    if (Number.isFinite(id) && code !== undefined) codes.set(id, code);
  }
  const block = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? "";
  return [...block.matchAll(/<xf\b[^>]*?(?:\/>|>)/g)].map((match) => {
    const id = Number(attribute(match[0], "numFmtId") ?? 0);
    const code = codes.get(id);
    return { date: showsADate(id, code), percent: id === 9 || id === 10 || (code?.includes("%") ?? false) };
  });
}

/** A number as it is shown, without the dust the arithmetic leaves: 0.30000000000000004 is 0.3. */
const plain = (value: number): string => String(Number(value.toPrecision(15)));

function resolveTarget(target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = `xl/${target}`.split("/");
  const out: string[] = [];
  for (const part of parts) { if (part === "..") out.pop(); else if (part !== ".") out.push(part); }
  return out.join("/");
}

/**
 * Read a workbook. Throws, with the reason in words, when it is not one that can
 * be read: not a zip, no workbook in it, or locked with a password.
 */
export function readWorkbook(bytes: Buffer, limits: { rows?: number; columns?: number } = {}): Workbook {
  const mostRows = limits.rows ?? 100_000;
  const mostColumns = limits.columns ?? 500;
  const zip = readZip(bytes);
  const part = (name: string): string | undefined => zip.get(name)?.().toString("utf8");
  const workbookXml = part("xl/workbook.xml");
  if (!workbookXml) throw new Error("this .xlsx has no workbook in it");

  const relationships = new Map<string, string>();
  for (const match of (part("xl/_rels/workbook.xml.rels") ?? "").matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attribute(match[0], "Id");
    const target = attribute(match[0], "Target");
    if (id && target) relationships.set(id, resolveTarget(target));
  }

  const shared = [...(part("xl/sharedStrings.xml") ?? "").matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((match) => textRuns(match[1]));
  const looks = readStyles(part("xl/styles.xml"));

  const sheets: ReadSheet[] = [];
  for (const match of workbookXml.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attribute(match[0], "name") ?? `Sheet${sheets.length + 1}`;
    const id = attribute(match[0], "r:id") ?? attribute(match[0], "id");
    const target = id ? relationships.get(id) : undefined;
    const xml = target ? part(target) : undefined;
    const rows: ReadCell[][] = [];
    for (const cell of (xml ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const reference = /^([A-Za-z]{1,3})(\d+)$/.exec(attribute(cell[1], "r") ?? "");
      if (!reference) continue;
      const column = columnNumber(reference[1]);
      const row = Number(reference[2]) - 1;
      if (row >= mostRows || column >= mostColumns) continue;
      const body = cell[2] ?? "";
      const type = attribute(cell[1], "t");
      const look = looks[Number(attribute(cell[1], "s") ?? 0)] ?? { date: false, percent: false };
      const formulaMatch = /<f\b[^>]*>([\s\S]*?)<\/f>/.exec(body);
      const formula = formulaMatch ? decodeEntities(formulaMatch[1]) : undefined;
      const value = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let read: ReadCell;
      if (type === "inlineStr") read = { kind: "text", text: textRuns(body) };
      else if (type === "s") read = { kind: "text", text: shared[Number(value)] ?? "" };
      else if (type === "str") read = { kind: "text", text: decodeEntities(value ?? "") };
      else if (type === "b") read = { kind: "boolean", text: value === "1" ? "TRUE" : "FALSE" };
      else if (type === "e") read = { kind: "error", text: decodeEntities(value ?? "") };
      else if (type === "d") read = { kind: "date", text: decodeEntities(value ?? "").replace("T", " ").replace(/:00$/, "") };
      else if (value === undefined || value === "") read = formula ? { kind: "empty", text: "" } : empty;
      else {
        const number = Number(value);
        if (!Number.isFinite(number)) read = { kind: "text", text: decodeEntities(value) };
        else if (look.date) read = { kind: "date", text: dateOfSerial(number), value: number };
        else if (look.percent) read = { kind: "number", text: `${plain(number * 100)}%`, value: number };
        else read = { kind: "number", text: plain(number), value: number };
      }
      if (formula !== undefined && formula !== "") read = { ...read, formula };
      while (rows.length <= row) rows.push([]);
      const cells = rows[row];
      while (cells.length <= column) cells.push(empty);
      cells[column] = read;
    }
    sheets.push({ name, hidden: /state\s*=\s*"(?:hidden|veryHidden)"/.test(match[0]), rows });
  }
  if (sheets.length === 0) throw new Error("this .xlsx has no sheets in it");
  return { sheets };
}

/**
 * A workbook as text: a heading for each sheet, then its rows with the cells
 * separated by tabs and a formula shown after the value it came to. Long sheets
 * are cut, and the cut is said.
 */
export function workbookText(book: Workbook, limits: { rows?: number } = {}): string {
  const mostRows = limits.rows ?? 2000;
  const parts: string[] = [];
  for (const sheet of book.sheets) {
    const lines: string[] = [];
    let shown = 0;
    let left = 0;
    for (const row of sheet.rows) {
      let end = row.length;
      while (end > 0 && row[end - 1].kind === "empty" && !row[end - 1].formula) end -= 1;
      if (end === 0) continue;
      if (shown >= mostRows) { left += 1; continue; }
      lines.push(row.slice(0, end).map((cell) => (cell.formula ? `${cell.text} [=${cell.formula}]` : cell.text).replace(/[\t\r\n]+/g, " ")).join("\t"));
      shown += 1;
    }
    if (lines.length === 0) { parts.push(`Sheet: ${sheet.name}${sheet.hidden ? " (hidden)" : ""}\n(empty)`); continue; }
    if (left > 0) lines.push(`[... ${left.toLocaleString("en-US")} more row${left === 1 ? "" : "s"} not shown]`);
    parts.push(`Sheet: ${sheet.name}${sheet.hidden ? " (hidden)" : ""}\n${lines.join("\n")}`);
  }
  return parts.join("\n\n");
}
