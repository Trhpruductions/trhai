import test from "node:test";
import assert from "node:assert/strict";
import { documentKind, extractDocumentText, isDocumentPath, readZip } from "../src/services/documentText.js";
import { readWorkbook, workbookText } from "../src/services/xlsxReader.js";
import { sheetNames, xlsxFile, type WriteSheet } from "../src/services/xlsxWriter.js";
import { writeZip } from "../src/services/zipWriter.js";
import { assertWellFormed } from "./helpers/xml.js";

// An Excel workbook, written and read: the parts it must have, the cells in the way a spreadsheet program holds them, and a
// workbook of the kind a spreadsheet program itself saves - shared strings, styles that make a number a date, shared formulas.

const when = new Date(Date.UTC(2026, 9, 25, 12, 0, 0));
const part = (archive: Buffer, name: string) => readZip(archive).get(name)!().toString("utf8");

const budget: WriteSheet = {
  name: "Budget",
  header: true,
  rows: [
    [{ kind: "text", text: "Item" }, { kind: "text", text: "Qty" }, { kind: "text", text: "Price" }, { kind: "text", text: "Due" }, { kind: "text", text: "Note" }],
    [{ kind: "text", text: "Tea" }, { kind: "number", value: 2, format: null }, { kind: "number", value: 3.5, format: '"$"#,##0.00' }, { kind: "date", serial: 46085, format: "yyyy-mm-dd" }, { kind: "text", text: "a long note that goes on and on for more than sixty characters so that it wraps" }],
    [{ kind: "text", text: "Milk" }, { kind: "number", value: 1, format: "0.00" }, { kind: "number", value: 0.125, format: "0.0%" }, { kind: "boolean", value: true }, { kind: "text", text: "two\nlines" }],
    [{ kind: "text", text: "Total" }, { kind: "formula", formula: "SUM(B2:B3)", cached: 3 }, { kind: "formula", formula: 'IF(C2>3,"high","low")', cached: "high" }, { kind: "formula", formula: "1/0", cached: { error: "#DIV/0!" } }, { kind: "formula", formula: "TODAY()", cached: undefined }]
  ]
};

test("sheet names are ones a workbook takes, and different from each other however they are written", () => {
  assert.deepEqual(sheetNames(["Budget", "budget", "BUDGET"]), ["Budget", "budget (2)", "BUDGET (3)"]);
  assert.deepEqual(sheetNames(["Q1: Sales/Costs?", "[x]*y"]), ["Q1 Sales Costs", "x y"]);
  assert.deepEqual(sheetNames(["", "   ", "'quoted'"]), ["Sheet1", "Sheet2", "quoted"]);
  const long = "a".repeat(40);
  const [first, second] = sheetNames([long, long]);
  assert.equal(first.length, 31);
  assert.ok(second.length <= 31 && second.endsWith(" (2)"), second);
  assert.notEqual(first.toLowerCase(), second.toLowerCase());
});

test("a workbook holds the parts a spreadsheet program needs, each one well-formed XML", () => {
  const archive = xlsxFile([budget, { name: "Second", header: false, rows: [[{ kind: "text", text: "x" }]] }], { title: 'A "title" & <more>', date: when });
  const entries = [...readZip(archive).keys()];
  assert.deepEqual(entries, ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml", "docProps/core.xml", "docProps/app.xml"]);
  for (const name of entries) assertWellFormed(part(archive, name), name);
  const types = part(archive, "[Content_Types].xml");
  for (const name of ["/xl/workbook.xml", "/xl/styles.xml", "/xl/worksheets/sheet1.xml", "/xl/worksheets/sheet2.xml", "/docProps/core.xml"]) assert.match(types, new RegExp(`PartName="${name}"`), name);
  const workbook = part(archive, "xl/workbook.xml");
  assert.match(workbook, /<sheet name="Budget" sheetId="1" r:id="rId1"\/><sheet name="Second" sheetId="2" r:id="rId2"\/>/);
  assert.match(workbook, /<calcPr calcId="191029" fullCalcOnLoad="1"\/>/, "worked out again when it is opened");
  const rels = part(archive, "xl/_rels/workbook.xml.rels");
  const ids = [...rels.matchAll(/Id="(rId\d+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, "relationship ids are unique");
  assert.match(rels, /Id="rId3"[^>]*\/styles"/);
  assert.match(part(archive, "docProps/core.xml"), /<dc:title>A &quot;title&quot; &amp; &lt;more&gt;<\/dc:title>/);
  assert.match(part(archive, "docProps/core.xml"), /<dcterms:created xsi:type="dcterms:W3CDTF">2026-10-25T12:00:00Z/);
});

test("the styles are counted, the custom formats numbered from 164, and only what is not built in is written", () => {
  const styles = part(xlsxFile([budget], { title: "x", date: when }), "xl/styles.xml");
  const count = Number(/<cellXfs count="(\d+)"/.exec(styles)![1]);
  assert.equal((styles.match(/<xf numFmtId=/g) ?? []).length, count + 1, "every xf, and the one cell style xf");
  const custom = [...styles.matchAll(/<numFmt numFmtId="(\d+)" formatCode="([^"]*)"\/>/g)].map((match) => [Number(match[1]), match[2]] as const);
  assert.deepEqual(custom.map(([, code]) => code), ["&quot;$&quot;#,##0.00", "yyyy-mm-dd", "0.0%"]);
  assert.deepEqual(custom.map(([id]) => id), [164, 165, 166]);
  assert.match(styles, /<fonts count="2">/);
  assert.match(styles, /<fills count="3">/);
  assert.doesNotMatch(styles, /formatCode="0\.00"/, "0.00 is built in");
});

test("a sheet has its header frozen and filtered, its columns sized, and its cells written as what they are", () => {
  const sheet = part(xlsxFile([budget], { title: "x", date: when }), "xl/worksheets/sheet1.xml");
  assert.match(sheet, /<dimension ref="A1:E4"\/>/);
  assert.match(sheet, /tabSelected="1"/);
  assert.match(sheet, /<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"\/>/);
  assert.match(sheet, /<autoFilter ref="A1:E4"\/>/);
  const widths = [...sheet.matchAll(/<col min="(\d+)" max="\d+" width="([\d.]+)"/g)].map((match) => Number(match[2]));
  assert.equal(widths.length, 5);
  assert.ok(widths.every((width) => width >= 8 && width <= 60), widths.join(", "));
  assert.equal(widths[4], 60, "a long note is as wide as a column goes, and wraps");
  assert.match(sheet, /<c r="A2" t="inlineStr"><is><t xml:space="preserve">Tea<\/t><\/is><\/c>/);
  assert.match(sheet, /<c r="B2"><v>2<\/v><\/c>/);
  assert.match(sheet, /<c r="D2" s="\d+"><v>46085<\/v><\/c>/);
  assert.match(sheet, /<c r="D3" t="b"><v>1<\/v><\/c>|<c r="D3" s="\d+" t="b"><v>1<\/v><\/c>/);
  assert.match(sheet, /<c r="B4"><f>SUM\(B2:B3\)<\/f><v>3<\/v><\/c>/);
  assert.match(sheet, /<c r="C4" t="str"><f>IF\(C2&gt;3,&quot;high&quot;,&quot;low&quot;\)<\/f><v>high<\/v><\/c>/);
  assert.match(sheet, /<c r="D4" t="e"><f>1\/0<\/f><v>#DIV\/0!<\/v><\/c>/);
  assert.match(sheet, /<c r="E4"><f>TODAY\(\)<\/f><\/c>/, "no answer is written for a formula that is not worked out here");
  assert.match(sheet, /two\nlines/, "a line break in a cell is a line break");
  // The long note and the two-line cell wrap; the header row is bold and shaded.
  const styles = part(xlsxFile([budget], { title: "x", date: when }), "xl/styles.xml");
  assert.match(styles, /wrapText="1"/);
  assert.match(styles, /fontId="1" fillId="2" borderId="1"/);
  assert.match(sheet, /<c r="A1" s="\d+" t="inlineStr">/, "the header cells are styled");
});

test("a sheet with no header has none of the header's furniture, and a one-row sheet has none either", () => {
  const plain = part(xlsxFile([{ ...budget, header: false }], { title: "x", date: when }), "xl/worksheets/sheet1.xml");
  assert.doesNotMatch(plain, /pane|autoFilter/);
  const single = part(xlsxFile([{ name: "One", header: true, rows: [[{ kind: "text", text: "only" }]] }], { title: "x", date: when }), "xl/worksheets/sheet1.xml");
  assert.doesNotMatch(single, /pane|autoFilter/, "there is nothing under a header to freeze it over");
});

test("what is written in a cell cannot be taken for the file's own markup", () => {
  const hostile = "<script>alert(1)</script> & ]]> \u0001\u0008 \"quoted\" '</t></is></c>";
  const archive = xlsxFile([{ name: "A <b> & \"c\"", header: false, rows: [[{ kind: "text", text: hostile }, { kind: "formula", formula: 'A1&"<x>"', cached: hostile }]] }], { title: hostile, date: when });
  for (const name of readZip(archive).keys()) assertWellFormed(part(archive, name), name);
  const book = readWorkbook(archive);
  assert.equal(book.sheets[0].name, "A <b> & \"c\"");
  assert.equal(book.sheets[0].rows[0][0].text, hostile.replace(/[\u0001\u0008]/g, ""), "the control characters XML cannot hold are the only thing gone");
  assert.equal(book.sheets[0].rows[0][1].formula, 'A1&"<x>"');
});

test("what is written is read back as it was: text, numbers, dates, truth, formulas and their answers", () => {
  const book = readWorkbook(xlsxFile([budget], { title: "x", date: when }));
  assert.equal(book.sheets.length, 1);
  const [header, tea, milk, total] = book.sheets[0].rows;
  assert.deepEqual(header.map((cell) => cell.text), ["Item", "Qty", "Price", "Due", "Note"]);
  assert.deepEqual([tea[1].kind, tea[1].value, tea[1].text], ["number", 2, "2"]);
  assert.deepEqual([tea[3].kind, tea[3].value, tea[3].text], ["date", 46085, "2026-03-04"]);
  assert.deepEqual([milk[2].kind, milk[2].value, milk[2].text], ["number", 0.125, "12.5%"]);
  assert.deepEqual([milk[3].kind, milk[3].text], ["boolean", "TRUE"]);
  assert.equal(milk[4].text, "two\nlines");
  assert.deepEqual([total[1].formula, total[1].value], ["SUM(B2:B3)", 3]);
  assert.deepEqual([total[2].formula, total[2].text], ['IF(C2>3,"high","low")', "high"]);
  assert.deepEqual([total[3].kind, total[3].text], ["error", "#DIV/0!"]);
  assert.deepEqual([total[4].formula, total[4].kind], ["TODAY()", "empty"]);
});

test("a workbook of the kind a spreadsheet program saves is read too", () => {
  const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const archive = writeZip([
    { name: "[Content_Types].xml", data: "<Types/>" },
    { name: "xl/workbook.xml", data: `<workbook ${ns}><sheets><sheet name="Data" sheetId="1" r:id="rId1"/><sheet name="Hidden &amp; More" sheetId="2" state="hidden" r:id="rId2"/></sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: '<Relationships><Relationship Id="rId1" Type="x/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="x/worksheet" Target="/xl/worksheets/sheet2.xml"/></Relationships>' },
    { name: "xl/sharedStrings.xml", data: `<sst ${ns}><si><t>Name</t></si><si><r><t xml:space="preserve">Rich </t></r><r><rPr><b/></rPr><t>text</t></r></si><si><t>with phonetic</t><rPh sb="0" eb="2"><t>ふり</t></rPh></si><si><t>Tom &amp; Jerry</t></si></sst>` },
    {
      name: "xl/styles.xml",
      data: `<styleSheet ${ns}><numFmts count="2"><numFmt numFmtId="164" formatCode="[$-409]d\\-mmm\\-yy;@"/><numFmt numFmtId="165" formatCode="0.0 &quot;days&quot;"/></numFmts>`
        + '<cellXfs count="5"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="9"/><xf numFmtId="164"/><xf numFmtId="165"/></cellXfs></styleSheet>'
    },
    {
      name: "xl/worksheets/sheet1.xml",
      data: `<worksheet ${ns}><sheetData>`
        + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row>'
        + '<row r="2"><c r="A2" s="1"><v>45000</v></c><c r="B2" s="2"><v>0.256</v></c><c r="C2" s="3"><v>46085</v></c><c r="D2" s="4"><v>12.5</v></c></row>'
        + '<row r="3"><c r="A3"><f>SUM(A2:B2)</f><v>0.30000000000000004</v></c><c r="B3" t="str"><f>"a"&amp;"b"</f><v>ab</v></c><c r="C3" t="e"><f>1/0</f><v>#DIV/0!</v></c><c r="D3" t="b"><v>1</v></c></row>'
        + '<row r="4"><c r="A4"><f t="shared" ref="A4:A5" si="0">A2*2</f><v>10</v></c><c r="C4" t="inlineStr"><is><t>inline</t></is></c></row>'
        + '<row r="5"><c r="A5"><f t="shared" si="0"/><v>20</v></c><c r="E5"/></row>'
        + "</sheetData></worksheet>"
    },
    { name: "xl/worksheets/sheet2.xml", data: `<worksheet ${ns}><sheetData><row r="2"><c r="C2" t="s"><v>3</v></c></row></sheetData></worksheet>` }
  ]);
  const book = readWorkbook(archive);
  assert.deepEqual(book.sheets.map((sheet) => [sheet.name, sheet.hidden]), [["Data", false], ["Hidden & More", true]]);
  const rows = book.sheets[0].rows.map((row) => row.map((cell) => cell.text));
  assert.deepEqual(rows[0], ["Name", "Rich text", "with phonetic", "Tom & Jerry"], "rich text is joined and a phonetic guide is not text");
  assert.deepEqual(rows[1], ["2023-03-15", "25.6%", "2026-03-04", "12.5"], "a number in a date style is a date, and 0.0 \"days\" is not");
  assert.deepEqual(rows[2], ["0.3", "ab", "#DIV/0!", "TRUE"], "the dust the arithmetic leaves is not shown");
  assert.deepEqual(rows[3].slice(0, 3), ["10", "", "inline"]);
  assert.equal(book.sheets[0].rows[3][0].formula, "A2*2");
  assert.equal(rows[4][0], "20");
  assert.equal(book.sheets[0].rows[4][0].formula, undefined, "a cell that shares another's formula has only its value");
  assert.equal(book.sheets[1].rows[1][2].text, "Tom & Jerry", "a target written with a leading slash is found");
});

test("a workbook as text: a heading for each sheet, tab-separated rows, a formula after its answer, and a cut that is said", () => {
  const text = workbookText(readWorkbook(xlsxFile([budget, { name: "Empty", header: false, rows: [] }], { title: "x", date: when })));
  assert.match(text, /^Sheet: Budget\nItem\tQty\tPrice\tDue\tNote\n/);
  assert.match(text, /Tea\t2\t\$?3\.5\t2026-03-04\ta long note/);
  assert.match(text, /Total\t3 \[=SUM\(B2:B3\)\]\thigh \[=IF\(C2>3,"high","low"\)\]\t#DIV\/0! \[=1\/0\]/);
  assert.match(text, /two lines/, "a line break in a cell does not break the row");
  assert.match(text, /Sheet: Empty\n\(empty\)$/);
  const many = xlsxFile([{ name: "Long", header: false, rows: Array.from({ length: 30 }, (_, index) => [{ kind: "number" as const, value: index, format: null }]) }], { title: "x", date: when });
  const cut = workbookText(readWorkbook(many), { rows: 10 });
  assert.equal(cut.split("\n").length, 12, "the heading, ten rows and the note");
  assert.match(cut, /\[\.\.\. 20 more rows not shown\]$/);
});

test("a spreadsheet is a document the assistant can read: its kind is told from its bytes, and its words are its cells", async () => {
  const archive = xlsxFile([budget], { title: "x", date: when });
  assert.equal(documentKind(archive, "Budget.xlsx"), "xlsx");
  assert.equal(documentKind(archive, "Budget.docx"), "docx", "the name decides between the zip kinds");
  assert.equal(isDocumentPath("documents/Budget.XLSX"), true);
  const read = await extractDocumentText(archive, "Budget.xlsx");
  assert.ok(read.ok);
  if (read.ok) {
    assert.equal(read.kind, "xlsx");
    assert.equal(read.pages, 1);
    assert.match(read.text, /Sheet: Budget/);
    assert.match(read.text, /Milk\t1\t12\.5%/);
  }
  const nothing = await extractDocumentText(xlsxFile([{ name: "Blank", header: false, rows: [[{ kind: "empty" }]] }], { title: "x", date: when }), "Blank.xlsx");
  assert.deepEqual(nothing, { ok: false, reason: "This spreadsheet has nothing in its cells." });
  const damaged = await extractDocumentText(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("not a real archive at all")]), "Broken.xlsx");
  assert.equal(damaged.ok, false);
  if (!damaged.ok) assert.match(damaged.reason, /could not be read/);
  const noBook = await extractDocumentText(writeZip([{ name: "hello.txt", data: "hello" }]), "NotABook.xlsx");
  assert.equal(noBook.ok, false);
  if (!noBook.ok) assert.match(noBook.reason, /no workbook in it/);
});
