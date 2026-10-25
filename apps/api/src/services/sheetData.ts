// The data of a spreadsheet, read from the text a model writes for one: CSV (or
// semicolons, tabs, bars), Markdown tables with a heading above each for the
// sheet's name, or JSON rows. Each cell is read for what it is - a number, a
// percentage, an amount of money, a date, a true or false, a formula - so that
// the file holds numbers a spreadsheet can add up and not text that looks like
// them; and what only looks like a number (a zip code, an order number, a
// phone number) stays the text it is.

export type Cell =
  | { kind: "empty" }
  | { kind: "text"; text: string }
  | { kind: "number"; value: number; format: string | null }
  | { kind: "boolean"; value: boolean }
  | { kind: "date"; serial: number; format: string }
  | { kind: "formula"; formula: string };

export type SheetData = { name: string; rows: Cell[][] };

export type SheetsRead = { ok: true; sheets: SheetData[] } | { ok: false; reason: string };

export const mostRows = 50_000;
export const mostColumns = 200;
export const mostCells = 200_000;
/** What a spreadsheet program holds in one cell. */
export const longestCellText = 32_767;

const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** A date's number the way a spreadsheet counts: days since 30 December 1899 (right for every date from March 1900 on). */
export function serialOf(year: number, month: number, day: number, hours = 0, minutes = 0, seconds = 0): number | null {
  if (year < 1900 || year > 9999 || month < 1 || month > 12 || day < 1) return null;
  const when = Date.UTC(year, month - 1, day);
  const check = new Date(when);
  // A day that does not exist (the 31st of April) spills into the next month, which is how it is found out.
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1) return null;
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  const serial = (when - Date.UTC(1899, 11, 30)) / 86_400_000;
  if (serial < 61) return null; // before March 1900 a spreadsheet's calendar is wrong on purpose; those stay text
  return serial + (hours * 3600 + minutes * 60 + seconds) / 86_400;
}

/** A number as a spreadsheet shows it in a format of the kinds read here: 0.00, #,##0, 0%, "$"#,##0.00 - or plain when there is none. */
export function formatNumber(value: number, code: string | null): string {
  if (code === null) return String(Number(value.toPrecision(15)));
  const percent = code.endsWith("%");
  const symbol = /^"([^"]+)"/.exec(code)?.[1] ?? "";
  const decimals = code.match(/\.(0+)/)?.[1].length ?? 0;
  const scaled = percent ? value * 100 : value;
  const factor = 10 ** decimals;
  // Half away from zero, as a spreadsheet rounds, even where the arithmetic is a hair off.
  const rounded = Math.round(Math.abs(scaled) * factor + 1e-9) / factor;
  const [whole, fraction] = rounded.toFixed(decimals).split(".");
  const grouped = code.includes("#,##0") ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : whole;
  const sign = scaled < 0 && rounded !== 0 ? "-" : "";
  return `${sign}${symbol}${grouped}${fraction ? `.${fraction}` : ""}${percent ? "%" : ""}`;
}

/** The date and time a spreadsheet number stands for, in the form a date is written in a file: 2026-03-04 or 2026-03-04 09:30. */
export function dateOfSerial(serial: number): string {
  const whole = Math.floor(serial);
  const rest = Math.round((serial - whole) * 86_400);
  const when = new Date(Date.UTC(1899, 11, 30) + whole * 86_400_000 + rest * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  const day = `${when.getUTCFullYear()}-${pad(when.getUTCMonth() + 1)}-${pad(when.getUTCDate())}`;
  return rest === 0 ? day : `${day} ${pad(when.getUTCHours())}:${pad(when.getUTCMinutes())}${when.getUTCSeconds() ? `:${pad(when.getUTCSeconds())}` : ""}`;
}

const digitsAfterPoint = (text: string) => text.split(".")[1]?.length ?? 0;

/** Zeros after the decimal point, as a number format wants them: 2 is "0.00". */
const places = (count: number) => (count > 0 ? `.${"0".repeat(Math.min(count, 6))}` : "");

/**
 * What one cell's text is. `usDates` says a date written 3/4/2026 is the fourth of March,
 * as it is in the United States, rather than the third of April.
 */
export function inferCell(raw: string, options: { usDates?: boolean } = {}): Cell {
  const text = raw.replace(/\r\n?/g, "\n").trim();
  if (text === "") return { kind: "empty" };
  // A leading apostrophe says "this is text", as it does in a spreadsheet program.
  if (text.startsWith("'")) return { kind: "text", text: text.slice(1) };
  if (text.startsWith("=") && text.length > 1) return { kind: "formula", formula: text.slice(1).trim() };
  if (/^(?:true|false)$/i.test(text)) return { kind: "boolean", value: text.toLowerCase() === "true" };

  // A number, with the thousands separators a person writes, or plain.
  const grouped = /^([-+]?)(\d{1,3}(?:,\d{3})+)(\.\d+)?$/.exec(text);
  if (grouped) {
    const value = Number(`${grouped[1]}${grouped[2].replace(/,/g, "")}${grouped[3] ?? ""}`);
    return { kind: "number", value, format: `#,##0${places(digitsAfterPoint(grouped[3] ?? ""))}` };
  }
  if (/^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(text)) {
    const digits = text.replace(/^[-+]/, "").replace(".", "");
    const looksLikeAnId = /^[-+]?0\d/.test(text) || digits.length > 15 || (text.startsWith("+") && /^\+\d{7,}$/.test(text));
    if (looksLikeAnId) return { kind: "text", text };
    const value = Number(text);
    if (!Number.isFinite(value)) return { kind: "text", text };
    const decimals = digitsAfterPoint(text);
    if (decimals > 0 && text.endsWith("0")) return { kind: "number", value, format: `0${places(decimals)}` };
    return { kind: "number", value, format: Math.abs(value) >= 1e11 && Number.isInteger(value) ? "0" : null };
  }
  if (/^[-+]?\d+(?:\.\d+)?[eE][-+]?\d+$/.test(text)) {
    const value = Number(text);
    if (Number.isFinite(value)) return { kind: "number", value, format: null };
  }
  const percent = /^([-+]?(?:\d+\.?\d*|\.\d+))%$/.exec(text);
  if (percent) return { kind: "number", value: Number(percent[1]) / 100, format: `0${places(digitsAfterPoint(percent[1]))}%` };

  // An amount of money: $1,200.50, -$5, ($5.00), £1,000.
  const money = /^(\(?)\s*([-+]?)\s*([$€£¥₹])\s*([-+]?)\s*(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s*(\)?)$/.exec(text);
  if (money && (money[1] === "") === (money[7] === "")) {
    const negative = money[1] === "(" || money[2] === "-" || money[4] === "-";
    const value = Number(`${money[5].replace(/,/g, "")}${money[6] ?? ""}`) * (negative ? -1 : 1);
    return { kind: "number", value, format: `"${money[3]}"#,##0${places(digitsAfterPoint(money[6] ?? ""))}` };
  }

  // A date, ISO or the way a person writes one out.
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (iso) {
    const serial = serialOf(Number(iso[1]), Number(iso[2]), Number(iso[3]), Number(iso[4] ?? 0), Number(iso[5] ?? 0), Number(iso[6] ?? 0));
    if (serial !== null) return { kind: "date", serial, format: iso[4] === undefined ? "yyyy-mm-dd" : iso[6] === undefined ? "yyyy-mm-dd hh:mm" : "yyyy-mm-dd hh:mm:ss" };
  }
  const named = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(text) ?? null;
  const namedFirst = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(text) ?? null;
  const monthOf = (word: string) => months.indexOf(word.slice(0, 3).toLowerCase()) + 1;
  if (named && monthOf(named[2]) > 0) {
    const serial = serialOf(Number(named[3]), monthOf(named[2]), Number(named[1]));
    if (serial !== null) return { kind: "date", serial, format: "d mmmm yyyy" };
  }
  if (namedFirst && monthOf(namedFirst[1]) > 0) {
    const serial = serialOf(Number(namedFirst[3]), monthOf(namedFirst[1]), Number(namedFirst[2]));
    if (serial !== null) return { kind: "date", serial, format: "mmmm d, yyyy" };
  }
  const slashed = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (slashed) {
    const a = Number(slashed[1]), b = Number(slashed[2]);
    const monthFirst = a > 12 ? false : b > 12 ? true : options.usDates === true;
    const serial = serialOf(Number(slashed[3]), monthFirst ? a : b, monthFirst ? b : a);
    if (serial !== null) return { kind: "date", serial, format: monthFirst ? "m/d/yyyy" : "dd/mm/yyyy" };
  }
  return { kind: "text", text };
}

// ---------------------------------------------------------------- reading the text

/** A table as RFC 4180 writes it: quotes round a field with the separator, a quote or a line break in it, and "" for a quote. */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let atStartOfField = true;
  const finishField = () => { row.push(field); field = ""; atStartOfField = true; };
  const finishRow = () => { finishField(); rows.push(row); row = []; };
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (quoted) {
      if (char === '"') {
        if (text[at + 1] === '"') { field += '"'; at += 1; } else quoted = false;
      } else field += char;
      continue;
    }
    // A formula written into a CSV without quotes has commas of its own - =IF(A2>0,"x","y") - and its own quotes. It ends at the
    // separator that is outside its brackets and its text, or at the end of the line, and is kept exactly as it was written.
    if (char === "=" && atStartOfField) {
      let depth = 0;
      let inText = false;
      let end = at;
      for (; end < text.length; end += 1) {
        const next = text[end];
        if (next === "\n" || next === "\r") break;
        if (inText) { if (next === '"') inText = false; continue; }
        if (next === '"') inText = true;
        else if (next === "(") depth += 1;
        else if (next === ")") depth = Math.max(0, depth - 1);
        else if (depth === 0 && next === delimiter) break;
      }
      field = text.slice(at, end);
      atStartOfField = false;
      at = end - 1;
      continue;
    }
    if (char === '"' && atStartOfField) { quoted = true; atStartOfField = false; continue; }
    if (char === delimiter) { finishField(); continue; }
    if (char === "\n") { finishRow(); continue; }
    if (char === "\r") { if (text[at + 1] !== "\n") finishRow(); continue; }
    field += char;
    atStartOfField = false;
  }
  if (field !== "" || row.length > 0 || quoted) finishRow();
  return rows;
}

/** The separator a text uses: the one that gives the most lines the same number of fields, more than one. */
export function detectDelimiter(text: string): string {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "").slice(0, 12);
  let best = ",";
  let bestScore = 0;
  for (const delimiter of [",", "\t", ";", "|"]) {
    const tally = new Map<number, number>();
    for (const line of lines) {
      const fields = parseDelimited(line, delimiter)[0]?.length ?? 1;
      tally.set(fields, (tally.get(fields) ?? 0) + 1);
    }
    let modal = 1;
    let times = 0;
    for (const [fields, seen] of tally) if (fields > 1 && (seen > times || (seen === times && fields > modal))) { modal = fields; times = seen; }
    const score = modal > 1 ? times * 100 + modal : 0;
    if (score > bestScore) { best = delimiter; bestScore = score; }
  }
  return best;
}

const cellsOfTableRow = (line: string): string[] => {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  for (let at = 0; at < text.length; at += 1) {
    if (text[at] === "\\" && text[at + 1] === "|") { cell += "|"; at += 1; continue; }
    if (text[at] === "|") { cells.push(cell); cell = ""; continue; }
    cell += text[at];
  }
  cells.push(cell);
  return cells;
};

const tableSeparator = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?\s*$/;

/** A cell of a Markdown table, as the person meant it: not **bold**, not `code`, and a <br> is a new line. */
function untidy(cell: string): string {
  let text = cell.trim().replace(/<br\s*\/?>/gi, "\n");
  for (let pass = 0; pass < 2; pass += 1) {
    const wrapped = /^(\*\*|__|\*|_|`)(.+)\1$/s.exec(text);
    if (wrapped && !/^[_*]\d/.test(text)) text = wrapped[2].trim();
  }
  return text;
}

/** Sheets from Markdown tables: each table is a sheet, named by the heading above it when there is one. */
function sheetsFromTables(text: string): { name: string | null; rows: string[][] }[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const found: { name: string | null; rows: string[][] }[] = [];
  let heading: string | null = null;
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at];
    const title = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line) ?? /^\s*(?:sheet|tab)\s*[:-]\s*(.+?)\s*$/i.exec(line);
    if (title) { heading = untidy(title[1]); continue; }
    if (line.includes("|") && at + 1 < lines.length && tableSeparator.test(lines[at + 1]) && lines[at + 1].includes("-")) {
      const rows = [cellsOfTableRow(line).map(untidy)];
      at += 2;
      while (at < lines.length && lines[at].trim() !== "" && lines[at].includes("|")) { rows.push(cellsOfTableRow(lines[at]).map(untidy)); at += 1; }
      at -= 1;
      found.push({ name: heading, rows });
    }
  }
  return found;
}

/**
 * CSV under headings: a line that is only a heading (## Costs) names the sheet that
 * follows it, as a model writes several sheets as CSV. A heading is alone on its
 * line, with no separator in it, and starts the text or follows a blank line, so a
 * row such as "# of items,5" is still a row.
 */
function sectionsOfCsv(text: string): { name: string | null; text: string }[] | null {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const sections: { name: string | null; lines: string[] }[] = [{ name: null, lines: [] }];
  let found = false;
  lines.forEach((line, at) => {
    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading && !/[,;\t|]/.test(heading[1]) && (at === 0 || lines[at - 1].trim() === "")) {
      found = true;
      sections.push({ name: untidy(heading[1]), lines: [] });
    } else sections[sections.length - 1].lines.push(line);
  });
  if (!found) return null;
  return sections.map((section) => ({ name: section.name, text: section.lines.join("\n") })).filter((section) => section.text.trim() !== "");
}

/** JSON rows: an array of arrays, an array of objects (the keys are the header), or an object of sheets. */
function sheetsFromJson(value: unknown): { name: string | null; rows: unknown[][] }[] | null {
  const asRows = (rows: unknown): unknown[][] | null => {
    if (!Array.isArray(rows) || rows.length === 0) return null;
    if (rows.every((row) => Array.isArray(row))) return rows as unknown[][];
    if (rows.every((row) => row && typeof row === "object" && !Array.isArray(row))) {
      const keys: string[] = [];
      for (const row of rows as Record<string, unknown>[]) for (const key of Object.keys(row)) if (!keys.includes(key)) keys.push(key);
      return [keys, ...(rows as Record<string, unknown>[]).map((row) => keys.map((key) => row[key] ?? null))];
    }
    return null;
  };
  const single = asRows(value);
  if (single) return [{ name: null, rows: single }];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const sheets = Object.entries(value as Record<string, unknown>).map(([name, rows]) => ({ name, rows: asRows(rows) }));
    if (sheets.length > 0 && sheets.every((sheet) => sheet.rows)) return sheets.map((sheet) => ({ name: sheet.name, rows: sheet.rows! }));
  }
  return null;
}

const jsonCell = (value: unknown, options: { usDates?: boolean }): Cell => {
  if (value === null || value === undefined) return { kind: "empty" };
  if (typeof value === "number") return Number.isFinite(value) ? { kind: "number", value, format: null } : { kind: "text", text: String(value) };
  if (typeof value === "boolean") return { kind: "boolean", value };
  if (typeof value === "string") return inferCell(value, options);
  return { kind: "text", text: JSON.stringify(value) };
};

/** Every row as long as the longest, and nothing after the last cell that holds anything. */
function squared(rows: Cell[][]): Cell[][] {
  let last = rows.length;
  while (last > 0 && rows[last - 1].every((cell) => cell.kind === "empty")) last -= 1;
  const kept = rows.slice(0, last);
  const width = kept.reduce((most, row) => {
    let end = row.length;
    while (end > 0 && row[end - 1].kind === "empty") end -= 1;
    return Math.max(most, end);
  }, 0);
  return kept.map((row) => Array.from({ length: width }, (_, column) => row[column] ?? { kind: "empty" as const }));
}

/** Read what a model wrote for a spreadsheet into sheets of cells, or say why it cannot be. */
export function parseSheetContent(content: string, options: { usDates?: boolean } = {}): SheetsRead {
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  if (!text.trim()) return { ok: false, reason: "There was no data to make a spreadsheet from." };

  let named: Array<{ name: string | null; cells: Cell[][] }> = [];
  const trimmed = text.trim();
  let fromJson: ReturnType<typeof sheetsFromJson> = null;
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try { fromJson = sheetsFromJson(JSON.parse(trimmed)); } catch { fromJson = null; }
  }
  if (fromJson) {
    named = fromJson.map((sheet) => ({ name: sheet.name, cells: sheet.rows.map((row) => row.map((value) => jsonCell(value, options))) }));
  } else {
    const tables = sheetsFromTables(text);
    if (tables.length > 0) {
      named = tables.map((table) => ({ name: table.name, cells: table.rows.map((row) => row.map((cell) => inferCell(cell, options))) }));
    } else {
      const sections = sectionsOfCsv(text) ?? [{ name: null, text }];
      named = sections.map((section) => ({
        name: section.name,
        cells: parseDelimited(section.text.replace(/\n+$/, ""), detectDelimiter(section.text)).map((row) => row.map((cell) => inferCell(cell, options)))
      }));
    }
  }

  const sheets: SheetData[] = [];
  let cellCount = 0;
  for (const [index, sheet] of named.entries()) {
    const rows = squared(sheet.cells);
    if (rows.length === 0) continue;
    if (rows.length > mostRows) return { ok: false, reason: `A sheet has ${rows.length.toLocaleString("en-US")} rows; up to ${mostRows.toLocaleString("en-US")} can be made.` };
    if (rows[0].length > mostColumns) return { ok: false, reason: `A sheet has ${rows[0].length} columns; up to ${mostColumns} can be made.` };
    cellCount += rows.length * rows[0].length;
    for (const row of rows) for (const cell of row) {
      if (cell.kind === "text" && cell.text.length > longestCellText) return { ok: false, reason: `A cell holds ${cell.text.length.toLocaleString("en-US")} letters; a spreadsheet cell holds up to ${longestCellText.toLocaleString("en-US")}.` };
    }
    sheets.push({ name: sheet.name ?? (named.length === 1 ? "Sheet1" : `Sheet${index + 1}`), rows });
  }
  if (sheets.length === 0) return { ok: false, reason: "There were no cells with anything in them." };
  if (cellCount > mostCells) return { ok: false, reason: `That is ${cellCount.toLocaleString("en-US")} cells; up to ${mostCells.toLocaleString("en-US")} can be made.` };
  return { ok: true, sheets };
}
