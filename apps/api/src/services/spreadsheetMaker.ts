import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { systemLocale } from "./documentMaker.js";
import { withoutForbiddenCharacters } from "./docxWriter.js";
import { evaluate, isError, NotCalculated, parseFormula, type Node, type Resolver, type Value, cellName } from "./formulas.js";
import { claimNames, fileStem } from "./madeFileNames.js";
import { dateOfSerial, formatNumber, parseDelimited, parseSheetContent, type SheetData } from "./sheetData.js";
import { readWorkbook } from "./xlsxReader.js";
import { sheetNames, xlsxFile, type WriteCell, type WriteSheet } from "./xlsxWriter.js";

// Spreadsheets made on request: an Excel workbook, a CSV file, or both, from data
// the assistant writes as CSV, as Markdown tables or as JSON rows.
//
// The cells are read for what they are (sheetData.ts), a formula is read and
// worked out so that its answer is written beside it (formulas.ts), and a
// formula that cannot be read - or would reach out of the file - is kept as
// text with a note, rather than written into a file that a spreadsheet program
// would complain about. Every file is read back and compared with what was meant
// to be in it, cell by cell.

export const spreadsheetFormats = ["xlsx", "csv"] as const;
export type SpreadsheetFormat = (typeof spreadsheetFormats)[number];

export const spreadsheetFormatNames: Record<SpreadsheetFormat, string> = { xlsx: "Excel workbook", csv: "CSV file" };

const formatWords: Array<[RegExp, SpreadsheetFormat]> = [
  [/^(?:xlsx?|excel|workbook|spreadsheet|spreadsheets|sheet|sheets|msexcel|ms-?excel|microsoft)$/, "xlsx"],
  [/^(?:csv|comma|separated|values|delimited)$/, "csv"]
];

/** The formats asked for, as a model words them: "xlsx", "Excel", "excel and csv". Nothing asked for is Excel. */
export function parseSpreadsheetFormats(value: unknown): { ok: true; formats: SpreadsheetFormat[] } | { ok: false; reason: string } {
  const given = Array.isArray(value) ? value.map(String) : typeof value === "string" ? [value] : value === undefined || value === null ? [] : null;
  if (given === null) return { ok: false, reason: `format must be xlsx or csv, or a list of them.` };
  const tokens = given.flatMap((entry) => entry.toLowerCase().replace(/^\.+/, "").split(/[\s,;/&+]+|\band\b/).map((word) => word.replace(/^\.+/, "")).filter(Boolean));
  const formats: SpreadsheetFormat[] = [];
  for (const token of tokens) {
    if (/^(?:a|an|the|file|files|document|documents|format|both|as|in|also|or|then|page|pages|file\.)$/.test(token)) continue;
    const match = formatWords.find(([pattern]) => pattern.test(token));
    if (!match) return { ok: false, reason: `"${token}" is not a format I can make a spreadsheet in. I can make xlsx (Excel workbook) and csv (CSV file).` };
    if (!formats.includes(match[1])) formats.push(match[1]);
  }
  return { ok: true, formats: formats.length > 0 ? formats : ["xlsx"] };
}

// ---------------------------------------------------------------- formulas worked out

type Worked = { sheets: WriteSheet[]; problems: string[]; formulas: number };

/**
 * Turn the cells read from the text into cells to write: each formula read and worked
 * out, or - when it cannot be read - kept as the text it was, with a note. Worked out
 * across sheets, so one sheet's total can use another's cells.
 */
export function workOutFormulas(data: SheetData[], names: string[], header: boolean | undefined): Worked {
  const problems: string[] = [];
  const grids = new Map(names.map((name, index) => [name.toLowerCase(), data[index].rows.map((row) => row.slice())]));
  const parsed = new Map<string, Node>();
  let formulas = 0;

  // Every formula read first: one that cannot be read becomes text before anything refers to it.
  names.forEach((name, index) => {
    data[index].rows.forEach((row, rowIndex) => row.forEach((cell, column) => {
      if (cell.kind !== "formula") return;
      const read = parseFormula(cell.formula);
      if (read.ok) { parsed.set(`${name.toLowerCase()}|${column}|${rowIndex}`, read.ast); formulas += 1; return; }
      problems.push(`${name}!${cellName(column, rowIndex)}: the formula =${cell.formula.slice(0, 60)} could not be used (${read.reason}), so it is kept as text.`);
      grids.get(name.toLowerCase())![rowIndex][column] = { kind: "text", text: `=${cell.formula}` };
    }));
  });

  const answers = new Map<string, { value: Value } | { notCalculated: true }>();
  const working = new Set<string>();
  const circular = new Set<string>();

  const resolver: Resolver = {
    value(sheet, column, row) {
      const key = `${(sheet ?? "").toLowerCase()}|${column}|${row}`;
      const cell = grids.get((sheet ?? "").toLowerCase())?.[row]?.[column];
      if (!cell) return null;
      switch (cell.kind) {
        case "empty": return null;
        case "text": return cell.text;
        case "number": return cell.value;
        case "boolean": return cell.value;
        case "date": return cell.serial;
        case "formula": {
          const known = answers.get(key);
          if (known) { if ("notCalculated" in known) throw new NotCalculated("a cell this one uses"); return known.value; }
          if (working.has(key)) { circular.add(`${sheet}!${cellName(column, row)}`); return { error: "#REF!" }; }
          const ast = parsed.get(key);
          if (!ast) return null;
          working.add(key);
          try {
            const value = evaluate(ast, resolver, sheet);
            answers.set(key, { value });
            return value;
          } catch (error) {
            if (error instanceof NotCalculated) { answers.set(key, { notCalculated: true }); throw error; }
            throw error;
          } finally {
            working.delete(key);
          }
        }
      }
    },
    extent(sheet) {
      const rows = grids.get((sheet ?? "").toLowerCase()) ?? [];
      return { rows: rows.length, columns: rows[0]?.length ?? 0 };
    },
    hasSheet: (name) => grids.has(name.toLowerCase())
  };

  // How a formula's answer is shown: as the cells it adds up or multiplies are shown, when they are all shown the same way - a
  // total of amounts of money is money, a total of percentages is a percentage - as a spreadsheet program does when a formula is typed in.
  const shownAs = new Map<string, string | null>();
  const formatOfCell = (sheet: string, column: number, row: number): string | null => {
    const cell = grids.get(sheet.toLowerCase())?.[row]?.[column];
    if (!cell) return null;
    if (cell.kind === "number") return cell.format;
    if (cell.kind !== "formula") return null;
    const key = `${sheet.toLowerCase()}|${column}|${row}`;
    if (shownAs.has(key)) return shownAs.get(key) ?? null;
    shownAs.set(key, null); // a formula that refers to itself inherits nothing
    const ast = parsed.get(key);
    const found = ast ? formatsUsedBy(ast, sheet) : null;
    const format = found && found.size === 1 ? [...found][0] : null;
    shownAs.set(key, format);
    return format;
  };
  const adds = new Set(["SUM", "AVERAGE", "MIN", "MAX", "MEDIAN", "PRODUCT", "ROUND", "ROUNDUP", "ROUNDDOWN", "ABS", "SUMIF", "SUMPRODUCT"]);
  /** The formats of the cells a formula adds up or multiplies, or null when it does something else with them (a ratio, a comparison, text). */
  function formatsUsedBy(node: Node, sheet: string): Set<string> | null {
    const out = new Set<string>();
    const take = (from: Node): boolean => {
      switch (from.kind) {
        case "number": case "text": case "boolean": return true;
        case "ref": { const format = formatOfCell(from.sheet ?? sheet, from.at.column, from.at.row); if (format) out.add(format); return true; }
        case "range": {
          const grid = grids.get((from.sheet ?? sheet).toLowerCase()) ?? [];
          for (let row = from.from.row; row <= Math.min(from.to.row, grid.length - 1); row += 1) {
            for (let column = from.from.column; column <= from.to.column; column += 1) { const format = formatOfCell(from.sheet ?? sheet, column, row); if (format) out.add(format); }
          }
          return true;
        }
        case "unary": return take(from.operand);
        case "binary": return (from.op === "+" || from.op === "-" || from.op === "*") && take(from.left) && take(from.right);
        case "call": return adds.has(from.name) && from.args.every(take);
        default: return false;
      }
    };
    return take(node) ? out : null;
  }

  const sheets: WriteSheet[] = names.map((name) => {
    const grid = grids.get(name.toLowerCase())!;
    const rows: WriteCell[][] = grid.map((row, rowIndex) => row.map((cell, column): WriteCell => {
      if (cell.kind !== "formula") return cell;
      let cached: Value | undefined;
      try {
        cached = resolver.value(name, column, rowIndex);
      } catch (error) {
        if (!(error instanceof NotCalculated)) throw error;
        cached = undefined;
      }
      if (cached !== undefined && isError(cached)) problems.push(`${name}!${cellName(column, rowIndex)} comes to ${cached.error}.`);
      return { kind: "formula", formula: cell.formula, cached, format: typeof cached === "number" ? formatOfCell(name, column, rowIndex) : null };
    }));
    const first = rows[0] ?? [];
    const looksLikeAHeader = rows.length >= 2 && first.some((cell) => cell.kind === "text") && first.every((cell) => cell.kind === "text" || cell.kind === "empty");
    return { name, rows, header: header ?? looksLikeAHeader };
  });
  for (const place of circular) problems.push(`${place} refers to itself, directly or through other cells.`);
  return { sheets, problems, formulas };
}

// ---------------------------------------------------------------- CSV

/** What a cell holds in a CSV file: what a spreadsheet program shows, with nothing that would be run when the file is opened. */
export function csvValue(cell: WriteCell): string {
  const safe = (text: string) => (/^[=+\-@\t\r]/.test(text) ? `'${text}` : text);
  switch (cell.kind) {
    case "empty": return "";
    case "text": return safe(cell.text);
    case "number": return formatNumber(cell.value, cell.format);
    case "boolean": return cell.value ? "TRUE" : "FALSE";
    case "date": return dateOfSerial(cell.serial);
    case "formula": {
      const value = cell.cached;
      if (value === undefined) return `'=${cell.formula}`;
      if (value === null) return "0";
      if (isError(value)) return value.error;
      return typeof value === "number" ? formatNumber(value, cell.format ?? null) : typeof value === "boolean" ? (value ? "TRUE" : "FALSE") : safe(value);
    }
  }
}

const byteOrderMark = String.fromCharCode(0xfeff);
const csvField = (text: string) => (/[",\r\n]|^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);

/** One sheet as a CSV file, as Excel itself saves one: UTF-8 with a mark at the start so that it knows, and line ends of its own. */
export function csvFile(rows: WriteCell[][]): string {
  return `${byteOrderMark}${rows.map((row) => row.map((cell) => csvField(csvValue(cell))).join(",")).join("\r\n")}\r\n`;
}

// ---------------------------------------------------------------- making one

export type SpreadsheetRequest = {
  /** The data: CSV, Markdown tables (a heading above each names its sheet) or JSON rows. */
  content: string;
  title?: string;
  /** Nothing asked for is Excel. */
  formats?: SpreadsheetFormat[];
  /** Whether the first row is a header. Left out, it is one when it is all words. */
  header?: boolean;
  language?: string;
};

export type MadeSpreadsheetFile = {
  format: SpreadsheetFormat;
  name: string;
  path: string;
  bytes: number;
  /** Whether it was read back and every cell found as it was meant to be. */
  checked: boolean;
};

export type MakeSpreadsheetResult =
  | { ok: true; title: string; sheets: number; cells: number; formulas: number; files: MadeSpreadsheetFile[]; problems: string[] }
  | { ok: false; reason: string; problems: string[] };

const usesMonthFirst = (locale: string): boolean => {
  try { return new Intl.Locale(locale).maximize().region === "US"; } catch { return false; }
};

const fileSize = (file: string): number => {
  try { return statSync(file).size; } catch { return 0; }
};

/** The first thing a cell read back from an .xlsx does not match, as a sentence, or null when all of them do. */
function firstDifference(sheets: WriteSheet[], names: string[], bytes: Buffer): string | null {
  let book;
  try { book = readWorkbook(bytes); } catch (error) { return `it could not be read back (${error instanceof Error ? error.message : String(error)})`; }
  if (book.sheets.length !== sheets.length) return `it has ${book.sheets.length} sheets where ${sheets.length} were written`;
  for (const [index, sheet] of sheets.entries()) {
    const read = book.sheets[index];
    if (read.name !== names[index]) return `sheet ${index + 1} is called "${read.name}" where "${names[index]}" was written`;
    for (const [rowIndex, row] of sheet.rows.entries()) for (const [column, cell] of row.entries()) {
      const got = read.rows[rowIndex]?.[column] ?? { kind: "empty" as const, text: "" };
      const where = `${names[index]}!${cellName(column, rowIndex)}`;
      const wrong = (wrote: string) => `${where} was written as ${wrote} and read back as "${got.text}"`;
      switch (cell.kind) {
        case "empty": if (got.kind !== "empty") return wrong("empty"); break;
        // A file made of XML cannot hold some control characters, so what is expected is what it can hold.
        case "text": if (got.kind !== "text" || got.text !== withoutForbiddenCharacters(cell.text)) return wrong(`"${cell.text.slice(0, 40)}"`); break;
        case "number": if (got.kind !== "number" || got.value !== cell.value) return wrong(String(cell.value)); break;
        case "date": if (got.kind !== "date" || got.value !== cell.serial) return wrong(dateOfSerial(cell.serial)); break;
        case "boolean": if (got.kind !== "boolean" || got.text !== (cell.value ? "TRUE" : "FALSE")) return wrong(cell.value ? "TRUE" : "FALSE"); break;
        case "formula": {
          if (got.formula !== cell.formula) return `${where} was written as the formula =${cell.formula} and read back as ${got.formula === undefined ? "no formula" : `=${got.formula}`}`;
          const value = cell.cached;
          if (value === undefined) break;
          if (typeof value === "number") { if (got.value !== value) return wrong(`${value} (=${cell.formula})`); }
          else if (value === null) { if (got.value !== 0) return wrong("0"); }
          else if (isError(value)) { if (got.text !== value.error) return wrong(value.error); }
          else if (typeof value === "boolean") { if (got.text !== (value ? "TRUE" : "FALSE")) return wrong(String(value)); }
          else if (got.text !== withoutForbiddenCharacters(value)) return wrong(`"${value.slice(0, 40)}"`);
          break;
        }
      }
    }
  }
  return null;
}

/** Make a spreadsheet into `directory`, in every format asked for, and say what was made. */
export async function makeSpreadsheet(
  request: SpreadsheetRequest,
  directory: string,
  // `writeXlsx` is for a test to hand in a writer that gets something wrong, to see that the check notices.
  options: { now?: Date; writeXlsx?: typeof xlsxFile } = {}
): Promise<MakeSpreadsheetResult> {
  const language = request.language ?? systemLocale();
  const read = parseSheetContent(request.content, { usDates: usesMonthFirst(language) });
  if (!read.ok) return { ok: false, reason: read.reason, problems: [] };
  const formats = request.formats && request.formats.length > 0 ? [...new Set(request.formats)] : (["xlsx"] as SpreadsheetFormat[]);
  const names = sheetNames(read.sheets.map((sheet) => sheet.name));
  const worked = workOutFormulas(read.sheets, names, request.header);
  const title = request.title?.replace(/\s+/g, " ").trim().slice(0, 200) || (read.sheets.length === 1 && names[0] !== "Sheet1" ? names[0] : "Spreadsheet");

  try {
    mkdirSync(directory, { recursive: true });
  } catch (error) {
    return { ok: false, reason: `The folder could not be made: ${error instanceof Error ? error.message : String(error)}.`, problems: [] };
  }
  let claimed: ReturnType<typeof claimNames<SpreadsheetFormat>>;
  try {
    claimed = claimNames(directory, fileStem(title, "Spreadsheet"), formats);
  } catch (error) {
    return { ok: false, reason: `Nothing could be written in that folder: ${error instanceof Error ? error.message : String(error)}.`, problems: [] };
  }
  if (!claimed) return { ok: false, reason: "There are too many files with that name already.", problems: [] };

  const problems = [...worked.problems];
  const files: MadeSpreadsheetFile[] = [];
  const giveUp = (format: SpreadsheetFormat, reason: string) => {
    try { rmSync(claimed!.files.get(format)!, { force: true }); } catch { /* an empty claim is not worth a second failure */ }
    problems.push(`The ${spreadsheetFormatNames[format]} could not be made: ${reason}`);
  };

  for (const format of formats) {
    const file = claimed.files.get(format)!;
    try {
      if (format === "xlsx") {
        const bytes = (options.writeXlsx ?? xlsxFile)(worked.sheets, { title, author: "TRH AI", date: options.now });
        writeFileSync(file, bytes);
        const different = firstDifference(worked.sheets, names, readFileSync(file));
        if (different) { problems.push(`The Excel workbook ${path.basename(file)}: ${different}; open it and look before relying on it.`); }
        files.push({ format, name: path.basename(file), path: file, bytes: fileSize(file), checked: different === null });
      } else {
        const first = worked.sheets[0];
        const text = csvFile(first.rows);
        writeFileSync(file, text, "utf8");
        const written = readFileSync(file, "utf8");
        const back = parseDelimited((written.startsWith(byteOrderMark) ? written.slice(1) : written).replace(/\r?\n$/, ""), ",");
        let different: string | null = null;
        if (back.length !== first.rows.length) different = `it has ${back.length} rows where ${first.rows.length} were written`;
        else {
          for (const [rowIndex, row] of first.rows.entries()) {
            for (const [column, cell] of row.entries()) {
              if ((back[rowIndex][column] ?? "") !== csvValue(cell)) { different = `${cellName(column, rowIndex)} was written as "${csvValue(cell).slice(0, 40)}" and read back as "${(back[rowIndex][column] ?? "").slice(0, 40)}"`; break; }
            }
            if (different) break;
          }
        }
        if (different) problems.push(`The CSV file ${path.basename(file)}: ${different}; open it and look before relying on it.`);
        if (worked.sheets.length > 1) problems.push(`A CSV file holds one sheet, so ${path.basename(file)} has the first, "${names[0]}"; the other ${worked.sheets.length - 1} are in the Excel workbook only.`);
        files.push({ format, name: path.basename(file), path: file, bytes: fileSize(file), checked: different === null });
      }
    } catch (error) {
      giveUp(format, error instanceof Error ? error.message : String(error));
    }
  }

  if (files.length === 0) return { ok: false, reason: problems.join(" ") || "Nothing was made.", problems };
  files.sort((a, b) => formats.indexOf(a.format) - formats.indexOf(b.format));
  const cells = worked.sheets.reduce((sum, sheet) => sum + sheet.rows.reduce((inRows, row) => inRows + row.filter((cell) => cell.kind !== "empty").length, 0), 0);
  return { ok: true, title, sheets: worked.sheets.length, cells, formulas: worked.formulas, files, problems };
}

/** What to tell the person, from what was made: each file by where it is. */
export function describeMadeSpreadsheet(result: MakeSpreadsheetResult, show: (absolute: string) => string = (absolute) => absolute): string {
  if (!result.ok) return `${result.reason} Nothing was made.`;
  const plural = (count: number, word: string) => `${count.toLocaleString("en-US")} ${word}${count === 1 ? "" : "s"}`;
  const lines = result.files.map((file) => {
    const detail = [spreadsheetFormatNames[file.format], file.format === "xlsx" ? plural(result.sheets, "sheet") : null].filter(Boolean).join(", ");
    return `- ${show(file.path)} (${detail})`;
  });
  const checked = result.files.every((file) => file.checked);
  const what = [plural(result.cells, "cell"), result.formulas > 0 ? plural(result.formulas, "formula") : null].filter(Boolean).join(", ");
  return [
    `Made "${result.title}", ${what}${checked ? ", and read each file back to check every cell" : ""}:`,
    ...lines,
    ...result.problems.map((problem) => `Note: ${problem}`)
  ].join("\n");
}
