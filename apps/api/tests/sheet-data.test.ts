import test from "node:test";
import assert from "node:assert/strict";
import {
  dateOfSerial, detectDelimiter, inferCell, longestCellText, mostCells, mostColumns, mostRows, parseDelimited, parseSheetContent, serialOf, type Cell
} from "../src/services/sheetData.js";

// What a model writes for a spreadsheet, read cell by cell: a number is a number, an order number is not.

const number = (value: number, format: string | null = null): Cell => ({ kind: "number", value, format });
const text = (value: string): Cell => ({ kind: "text", text: value });

test("a spreadsheet counts dates from 30 December 1899, and a date before its calendar is right stays text", () => {
  assert.equal(serialOf(2026, 1, 1), 46023);
  assert.equal(serialOf(2026, 3, 4), 46085);
  assert.equal(serialOf(1900, 3, 1), 61);
  assert.equal(serialOf(1900, 2, 28), null);
  assert.equal(serialOf(2024, 2, 29), serialOf(2024, 3, 1)! - 1);
  assert.equal(serialOf(2025, 2, 29), null, "no such day");
  assert.equal(serialOf(2026, 13, 1), null);
  assert.equal(serialOf(2026, 4, 31), null);
  assert.equal(serialOf(2026, 3, 4, 12), 46085.5);
  assert.equal(serialOf(2026, 3, 4, 24), null);
  assert.equal(dateOfSerial(46085), "2026-03-04");
  assert.equal(dateOfSerial(46085.5), "2026-03-04 12:00");
  assert.equal(dateOfSerial(46085 + 9.5 / 24 + 7 / 86_400), "2026-03-04 09:30:07");
  for (const serial of [61, 45_000, 46_085, 2_958_465]) assert.equal(serialOf(...(dateOfSerial(serial).split("-").map(Number) as [number, number, number])), serial);
});

test("a cell is read for what it is", () => {
  assert.deepEqual(inferCell(""), { kind: "empty" });
  assert.deepEqual(inferCell("   "), { kind: "empty" });
  assert.deepEqual(inferCell("hello there"), text("hello there"));
  assert.deepEqual(inferCell("  padded  "), text("padded"));
  assert.deepEqual(inferCell("'007"), text("007"), "an apostrophe says it is text");
  assert.deepEqual(inferCell("'=1+1"), text("=1+1"));
  assert.deepEqual(inferCell("=SUM(A1:A2)"), { kind: "formula", formula: "SUM(A1:A2)" });
  assert.deepEqual(inferCell("= B2 * C2"), { kind: "formula", formula: "B2 * C2" });
  assert.deepEqual(inferCell("="), text("="), "an equals sign alone is not a formula");
  assert.deepEqual(inferCell("TRUE"), { kind: "boolean", value: true });
  assert.deepEqual(inferCell("false"), { kind: "boolean", value: false });
  assert.deepEqual(inferCell("yes"), text("yes"));
});

test("numbers, with the commas a person writes, and what only looks like a number", () => {
  assert.deepEqual(inferCell("42"), number(42));
  assert.deepEqual(inferCell("-3.5"), number(-3.5));
  assert.deepEqual(inferCell(".5"), number(0.5));
  assert.deepEqual(inferCell("3.50"), number(3.5, "0.00"), "a trailing zero is kept on show");
  assert.deepEqual(inferCell("1,200"), number(1200, "#,##0"));
  assert.deepEqual(inferCell("-1,200.5"), number(-1200.5, "#,##0.0"));
  assert.deepEqual(inferCell("1,234,567.89"), number(1_234_567.89, "#,##0.00"));
  assert.deepEqual(inferCell("0"), number(0));
  assert.deepEqual(inferCell("0.5"), number(0.5));
  assert.deepEqual(inferCell("1e5"), number(100_000));
  assert.deepEqual(inferCell("1.5E-3"), number(0.0015));
  assert.deepEqual(inferCell("12345678901"), number(12_345_678_901));
  assert.deepEqual(inferCell("123456789012"), number(123_456_789_012, "0"), "twelve digits would show as 1.2E+11");
  // These are names, not amounts: a zip code, an order number, a card number, a phone number.
  for (const word of ["007", "0123", "00", "1234567890123456", "+15551234567", "1,2", "12,34", "1,2345", "5-3", "1 000"]) assert.deepEqual(inferCell(word), text(word), word);
  assert.deepEqual(inferCell("+5"), number(5));
});

test("percentages and amounts of money keep how they were written", () => {
  assert.deepEqual(inferCell("12%"), number(0.12, "0%"));
  assert.deepEqual(inferCell("12.5%"), number(0.125, "0.0%"));
  assert.deepEqual(inferCell("-5%"), number(-0.05, "0%"));
  assert.deepEqual(inferCell("$1,200.50"), number(1200.5, '"$"#,##0.00'));
  assert.deepEqual(inferCell("-$5"), number(-5, '"$"#,##0'));
  assert.deepEqual(inferCell("$-5"), number(-5, '"$"#,##0'));
  assert.deepEqual(inferCell("($5.00)"), number(-5, '"$"#,##0.00'));
  assert.deepEqual(inferCell("£1,000"), number(1000, '"£"#,##0'));
  assert.deepEqual(inferCell("€ 3.5"), number(3.5, '"€"#,##0.0'));
  assert.deepEqual(inferCell("(5)"), text("(5)"));
  assert.deepEqual(inferCell("($5"), text("($5"), "an unbalanced bracket is not an amount");
  assert.deepEqual(inferCell("$"), text("$"));
});

test("dates are dates, in the ways they are written, and a day that does not exist is not one", () => {
  assert.deepEqual(inferCell("2026-03-04"), { kind: "date", serial: 46085, format: "yyyy-mm-dd" });
  assert.deepEqual(inferCell("2026-03-04 12:00"), { kind: "date", serial: 46085.5, format: "yyyy-mm-dd hh:mm" });
  assert.deepEqual(inferCell("2026-03-04T12:00:30"), { kind: "date", serial: 46085 + 43_230 / 86_400, format: "yyyy-mm-dd hh:mm:ss" });
  assert.deepEqual(inferCell("4 March 2026"), { kind: "date", serial: 46085, format: "d mmmm yyyy" });
  assert.deepEqual(inferCell("4 Mar. 2026"), { kind: "date", serial: 46085, format: "d mmmm yyyy" });
  assert.deepEqual(inferCell("March 4, 2026"), { kind: "date", serial: 46085, format: "mmmm d, yyyy" });
  assert.deepEqual(inferCell("Mar 4th, 2026"), { kind: "date", serial: 46085, format: "mmmm d, yyyy" });
  for (const word of ["2026-02-30", "1899-12-31", "4 Foo 2026", "2026-13-01", "12:30", "March 2026"]) assert.equal(inferCell(word).kind, "text", word);
  // 3/4/2026 is the fourth of March in the United States and the third of April elsewhere; when one number cannot be a month, it is not a question.
  assert.deepEqual(inferCell("3/4/2026", { usDates: true }), { kind: "date", serial: 46085, format: "m/d/yyyy" });
  assert.deepEqual(inferCell("3/4/2026", { usDates: false }), { kind: "date", serial: 46115, format: "dd/mm/yyyy" });
  assert.deepEqual(inferCell("3/4/2026"), { kind: "date", serial: 46115, format: "dd/mm/yyyy" });
  assert.deepEqual(inferCell("13/4/2026", { usDates: true }), { kind: "date", serial: serialOf(2026, 4, 13)!, format: "dd/mm/yyyy" });
  assert.deepEqual(inferCell("4/13/2026", { usDates: false }), { kind: "date", serial: serialOf(2026, 4, 13)!, format: "m/d/yyyy" });
  assert.equal(inferCell("31/31/2026").kind, "text");
});

test("a CSV text is read the way RFC 4180 writes it", () => {
  assert.deepEqual(parseDelimited('a,"b,c","d ""e"" f"\n1,2,3', ","), [["a", "b,c", 'd "e" f'], ["1", "2", "3"]]);
  assert.deepEqual(parseDelimited('"line one\nline two",x\r\ny,z\r\n', ","), [["line one\nline two", "x"], ["y", "z"]]);
  assert.deepEqual(parseDelimited("a,,c\n,,\n", ","), [["a", "", "c"], ["", "", ""]]);
  assert.deepEqual(parseDelimited("a;b\n1;2", ";"), [["a", "b"], ["1", "2"]]);
  assert.deepEqual(parseDelimited('say "hi",x', ","), [['say "hi"', "x"]], "a quote in the middle of a field is just a quote");
  assert.deepEqual(parseDelimited("", ","), []);
  assert.deepEqual(parseDelimited('"unclosed,field', ","), [["unclosed,field"]]);
});

test("a formula written into a CSV without quotes keeps its own commas and quotes, and ends where its cell does", () => {
  assert.deepEqual(parseDelimited('1,=IF(A2>0,"x","y"),3\n2,=SUM(A2,A3),4', ","), [["1", '=IF(A2>0,"x","y")', "3"], ["2", "=SUM(A2,A3)", "4"]]);
  assert.deepEqual(parseDelimited("=A1+1,=B1*2\r\nx,y", ","), [["=A1+1", "=B1*2"], ["x", "y"]]);
  assert.deepEqual(parseDelimited('=IF(A1="a,b",1,2),z', ","), [['=IF(A1="a,b",1,2)', "z"]], "a comma inside the formula's own text");
  assert.deepEqual(parseDelimited("=SUM(A2;A3);x", ";"), [["=SUM(A2;A3)", "x"]], "whatever the separator is");
  assert.deepEqual(parseDelimited('"=SUM(A2,A3)",x', ","), [["=SUM(A2,A3)", "x"]], "a formula quoted the proper way is read the proper way");
  assert.deepEqual(parseDelimited("=,b\n=== not a formula ===,x", ","), [["=", "b"], ["=== not a formula ===", "x"]]);
  assert.deepEqual(parseDelimited('="unclosed,b\nnext,row', ","), [['="unclosed,b'], ["next", "row"]], "a text never closed does not swallow the lines after it");
  assert.deepEqual(parseDelimited("a=b,c", ","), [["a=b", "c"]], "an equals sign that does not start a cell is just a letter");
  const read = parseSheetContent('a,b\n1,=IF(A2>0,"x","y")');
  assert.ok(read.ok);
  if (read.ok) assert.deepEqual(read.sheets[0].rows[1], [number(1), { kind: "formula", formula: 'IF(A2>0,"x","y")' }]);
});

test("the separator is the one that cuts every line into the same number of fields", () => {
  assert.equal(detectDelimiter("a,b,c\n1,2,3\n4,5,6"), ",");
  assert.equal(detectDelimiter("a;b;c\n1;2;3"), ";");
  assert.equal(detectDelimiter("a\tb\tc\n1\t2\t3"), "\t");
  assert.equal(detectDelimiter("a|b\n1|2"), "|");
  assert.equal(detectDelimiter("Name, with a comma;Qty;Price\nTea, black;2;3,50\nMilk;1;0,80"), ";", "a decimal comma is not a separator when every line has three semicolons");
  assert.equal(detectDelimiter("just one column\nof words"), ",");
  assert.equal(detectDelimiter('"a, b",c\n"d, e",f'), ",");
});

test("a CSV becomes one sheet of cells, trimmed to what is in it", () => {
  const read = parseSheetContent("Item,Qty,Price\nTea,2,3.50\nMilk,1,0.80\n\n,,\n");
  assert.ok(read.ok);
  if (!read.ok) return;
  assert.equal(read.sheets.length, 1);
  assert.equal(read.sheets[0].name, "Sheet1");
  assert.deepEqual(read.sheets[0].rows, [
    [text("Item"), text("Qty"), text("Price")],
    [text("Tea"), number(2), number(3.5, "0.00")],
    [text("Milk"), number(1), number(0.8, "0.00")]
  ]);
});

test("CSV under headings is a sheet for each heading, and a row that starts with a hash is still a row", () => {
  const sections = parseSheetContent("## Costs\nItem,Cost\nRent,1200\n\n## Income\nSource;Amount\nSalary;3000");
  assert.ok(sections.ok);
  if (sections.ok) {
    assert.deepEqual(sections.sheets.map((sheet) => sheet.name), ["Costs", "Income"]);
    assert.deepEqual(sections.sheets[0].rows[1], [text("Rent"), number(1200)]);
    assert.deepEqual(sections.sheets[1].rows[1], [text("Salary"), number(3000)], "each section has its own separator");
  }
  const before = parseSheetContent("a,b\n1,2\n\n## Second\nc,d\n3,4");
  assert.ok(before.ok);
  if (before.ok) assert.deepEqual(before.sheets.map((sheet) => sheet.name), ["Sheet1", "Second"], "what comes before the first heading is a sheet too");
  const rows = parseSheetContent("name,count\n# of items,5\nx,1");
  assert.ok(rows.ok);
  if (rows.ok) {
    assert.equal(rows.sheets.length, 1);
    assert.deepEqual(rows.sheets[0].rows[1], [text("# of items"), number(5)]);
  }
  const middle = parseSheetContent("a,b\n## Not a heading\n1,2");
  assert.ok(middle.ok);
  if (middle.ok) assert.deepEqual(middle.sheets[0].rows.map((row) => row[0]), [text("a"), text("## Not a heading"), number(1)], "a heading follows a blank line");
  // A line with a separator in it is a row even where a heading could be: at the start, or after a blank line.
  for (const content of ["# of items,5\nx,1", "a,b\n1,2\n\n# total,3\n4,5"]) {
    const kept = parseSheetContent(content);
    assert.ok(kept.ok, content);
    if (kept.ok) {
      assert.equal(kept.sheets.length, 1, content);
      assert.ok(kept.sheets[0].rows.some((row) => row[1]?.kind === "number" && row[0]?.kind === "text" && /^# (?:of items|total)$/.test((row[0] as { text: string }).text)), content);
    }
  }
  const only = parseSheetContent("# Budget 2026\nItem,Cost\nRent,1200");
  assert.ok(only.ok);
  if (only.ok) assert.equal(only.sheets[0].name, "Budget 2026");
});

test("a ragged text is squared off, and a byte-order mark is not a cell", () => {
  const read = parseSheetContent(`${String.fromCharCode(0xfeff)}a,b,c\n1\n2,3`);
  assert.ok(read.ok);
  if (!read.ok) return;
  assert.deepEqual(read.sheets[0].rows.map((row) => row.length), [3, 3, 3]);
  assert.deepEqual(read.sheets[0].rows[0][0], text("a"));
  assert.deepEqual(read.sheets[0].rows[1], [number(1), { kind: "empty" }, { kind: "empty" }]);
});

test("Markdown tables become sheets, named by the heading above each, with the marks a model puts in them taken off", () => {
  const read = parseSheetContent([
    "# Household budget", "",
    "## Income", "",
    "| Source | Amount |", "|:--|--:|", "| **Salary** | $3,000 |", "| Side job | $450.50 |", "| Total | `=SUM(B2:B3)` |", "",
    "Some words between the tables.", "",
    "## Spending", "",
    "| Item | Cost |", "|---|---|", "| Rent<br>and bills | 1,200 |", "| _Food_ | 400 |", "",
    "## Spending", "",
    "| Item | Cost |", "|---|---|", "| Fun | 100 |"
  ].join("\n"));
  assert.ok(read.ok);
  if (!read.ok) return;
  assert.deepEqual(read.sheets.map((sheet) => sheet.name), ["Income", "Spending", "Spending"], "the names are made unique later, where the file is written");
  assert.deepEqual(read.sheets[0].rows[1], [text("Salary"), number(3000, '"$"#,##0')]);
  assert.deepEqual(read.sheets[0].rows[3], [text("Total"), { kind: "formula", formula: "SUM(B2:B3)" }]);
  assert.deepEqual(read.sheets[1].rows[1], [text("Rent\nand bills"), number(1200, "#,##0")]);
  assert.deepEqual(read.sheets[1].rows[2][0], text("Food"));
});

test("a Markdown table with no heading is Sheet1, and tables keep their formulas and their stars", () => {
  const read = parseSheetContent("| a | b | c |\n|---|---|---|\n| 2 | 3 | =A2*B2*A2 |");
  assert.ok(read.ok);
  if (!read.ok) return;
  assert.equal(read.sheets[0].name, "Sheet1");
  assert.deepEqual(read.sheets[0].rows[1][2], { kind: "formula", formula: "A2*B2*A2" }, "the stars are multiplication, not italics");
});

test("JSON rows: arrays, objects with a header, and an object of sheets", () => {
  const arrays = parseSheetContent('[["Name","Score"],["Ann",10],["Bob",null]]');
  assert.ok(arrays.ok);
  if (arrays.ok) assert.deepEqual(arrays.sheets[0].rows, [[text("Name"), text("Score")], [text("Ann"), number(10)], [text("Bob"), { kind: "empty" }]]);
  const objects = parseSheetContent('[{"name":"Ann","score":10,"passed":true},{"name":"Bob","score":"7.50","extra":"x"}]');
  assert.ok(objects.ok);
  if (objects.ok) {
    assert.deepEqual(objects.sheets[0].rows[0], [text("name"), text("score"), text("passed"), text("extra")]);
    assert.deepEqual(objects.sheets[0].rows[1], [text("Ann"), number(10), { kind: "boolean", value: true }, { kind: "empty" }]);
    assert.deepEqual(objects.sheets[0].rows[2][1], number(7.5, "0.00"), "a string in JSON is read like a cell");
  }
  const sheets = parseSheetContent('{"Q1":[["a","b"],[1,2]],"Q2":[{"a":3,"b":4}]}');
  assert.ok(sheets.ok);
  if (sheets.ok) assert.deepEqual(sheets.sheets.map((sheet) => sheet.name), ["Q1", "Q2"]);
  const text_ = parseSheetContent('[1,2,3]');
  assert.ok(text_.ok, "JSON that is not rows is read as the text it is");
});

test("nothing, too much, and a cell too long are refused with the reason", () => {
  for (const nothing of ["", "   \n  ", ",,\n,,\n"]) {
    const read = parseSheetContent(nothing);
    assert.equal(read.ok, false, JSON.stringify(nothing));
  }
  const rows = parseSheetContent(Array.from({ length: mostRows + 1 }, (_, index) => `${index},x`).join("\n"));
  assert.equal(rows.ok, false);
  if (!rows.ok) assert.match(rows.reason, /50,001 rows; up to 50,000 can be made/);
  const columns = parseSheetContent(Array.from({ length: mostColumns + 1 }, (_, index) => `c${index}`).join(","));
  assert.equal(columns.ok, false);
  if (!columns.ok) assert.match(columns.reason, /201 columns; up to 200 can be made/);
  const long = parseSheetContent(`a,b\n${"x".repeat(longestCellText + 1)},1`);
  assert.equal(long.ok, false);
  if (!long.ok) assert.match(long.reason, /32,768 letters; a spreadsheet cell holds up to 32,767/);
  const many = parseSheetContent(Array.from({ length: 1500 }, () => Array.from({ length: 150 }, (_, column) => String(column)).join(",")).join("\n"));
  assert.equal(many.ok, false);
  if (!many.ok) assert.match(many.reason, new RegExp(`up to ${mostCells.toLocaleString("en-US")} can be made`));
});
