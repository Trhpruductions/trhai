import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fakeEngine, type ScriptedReply } from "./helpers/fakeEngine.js";

// The assistant can make an Excel file. What is tested here is when it is offered the tool, what the tool does with what it
// passes, where the files go and where they may not, and that what it reports is what is on disk - and that a file it made
// can be read again by the same assistant.

const workspace = mkdtempSync(path.join(tmpdir(), "trhai-make-spreadsheet-"));
process.env.ASCEND_WORKSPACE = workspace;
const outside = mkdtempSync(path.join(tmpdir(), "trhai-make-spreadsheet-outside-"));

const { availableTools, runTool, toolDefinitions } = await import("../src/services/agentTools.js");
const { wantsAFileMade, wantsASpreadsheetMade } = await import("../src/services/actionIntent.js");
const { runAgent } = await import("../src/services/agentLoop.js");
const { armCommandsFor, disarmCommands } = await import("../src/services/commandRunner.js");
const { describeTools } = await import("../src/services/toolCenter.js");
const { permissionLevelOf } = await import("../src/services/toolPermissions.js");
const { takeMadeFiles } = await import("../src/services/madeFiles.js");
const { readWorkbook } = await import("../src/services/xlsxReader.js");

test.after(() => {
  disarmCommands();
  rmSync(workspace, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});
test.beforeEach(() => { disarmCommands(); });

const names = (tools: Array<{ function: { name: string } }>) => tools.map((tool) => tool.function.name);
const context = (request = "make me an excel spreadsheet", extra: Record<string, unknown> = {}) => ({ memories: [], knowledge: [], request, ...extra }) as never;
const tool = (args: Record<string, unknown>, request?: string, extra?: Record<string, unknown>) => runTool({ name: "make_spreadsheet", arguments: args }, context(request, extra));
const inWorkspace = (...parts: string[]) => path.join(workspace, ...parts);

const budget = ["Item,Qty,Price,Total", "Tea,2,$3.50,=B2*C2", "Milk,1,$0.80,=B3*C3", "Total,=SUM(B2:B3),,=SUM(D2:D3)"].join("\n");

// ---------------------------------------------------------------- when it is offered

test("a request for a spreadsheet is told from a request for a table to read, and from one for a document", () => {
  for (const asked of [
    "make me an Excel spreadsheet of my expenses",
    "create a spreadsheet with these numbers",
    "put this in an xlsx",
    "export that as an Excel file",
    "I need a budget",
    "build me a timesheet",
    "make a gradebook for my class",
    "save the data as a spreadsheet",
    "generate a workbook with two sheets",
    "draft a payroll for March"
  ]) assert.equal(wantsASpreadsheetMade(asked), true, asked);
  for (const asked of [
    "read my spreadsheet",
    "what is a spreadsheet?",
    "summarize budget.xlsx",
    "save these rows to data.csv",
    "export that as a csv",
    "give me a table of the planets",
    "what should go in a budget?",
    "make a Word document",
    "write a report on the quarter",
    "open the excel file"
  ]) assert.equal(wantsASpreadsheetMade(asked), false, asked);
  // A Word or PDF request does not offer it, and a spreadsheet request does not offer Word.
  assert.equal(wantsAFileMade("make me an Excel spreadsheet of my expenses"), false);
  assert.equal(wantsASpreadsheetMade("make me a Word document of my notes"), false);
});

test("the tool is offered when a spreadsheet is asked for, and not to a question, a read, or any other request", () => {
  assert.ok(names(availableTools(true, { spreadsheets: true })).includes("make_spreadsheet"));
  assert.ok(!names(availableTools(true, { spreadsheets: false })).includes("make_spreadsheet"), "not asked for");
  assert.ok(!names(availableTools(true, { spreadsheets: true, writes: false })).includes("make_spreadsheet"), "a question writes nothing");
  assert.ok(!names(availableTools(true, { spreadsheets: true, changes: false })).includes("make_spreadsheet"), "a request to look changes nothing");
  assert.ok(names(availableTools(true, { fileMaking: true, spreadsheets: false })).includes("make_document"), "the two are asked for apart");
  assert.ok(!names(availableTools(true, { fileMaking: false, spreadsheets: true })).includes("make_document"));
});

test("what the model is told says what to write, how formulas go, and what to say afterwards", () => {
  const definition = toolDefinitions.find((entry) => entry.function.name === "make_spreadsheet");
  assert.ok(definition);
  const description = definition.function.description;
  assert.match(description, /Excel workbook \(\.xlsx\) or a CSV file/);
  assert.match(description, /ALL of the data/);
  assert.match(description, /a cell that starts with = is a formula/);
  assert.match(description, /add totals as formulas/);
  assert.match(description, /never replaces one/);
  assert.deepEqual(definition.function.parameters.required, ["content"]);
  assert.deepEqual(Object.keys(definition.function.parameters.properties).sort(), ["content", "folder", "format", "header", "title"]);
  assert.equal(permissionLevelOf("make_spreadsheet"), 2);
  const probe = { machineAccess: { armed: false, until: null }, model: { available: true, name: "m", reason: null }, visionModel: null, ffmpeg: true, piper: true, phoneLink: "linked" as const, emailAccount: null };
  const entry = describeTools(probe).find((found) => found.name === "make_spreadsheet")!;
  assert.equal(entry.readiness.state, "ready");
  assert.equal(entry.asksFirst, false);
});

// ---------------------------------------------------------------- making files

test("an Excel file is made in the documents folder, and the reply says where it is and that every cell was checked", async () => {
  const result = await tool({ content: budget, title: "Shopping" });
  assert.equal(result.ok, true, result.content);
  assert.equal(result.path, "documents/Shopping.xlsx");
  assert.match(result.content, /^Made "Shopping", 15 cells, 4 formulas, and read each file back to check every cell:\n- documents\/Shopping\.xlsx \(Excel workbook, 1 sheet\)$/);
  const sheet = readWorkbook(readFileSync(inWorkspace("documents", "Shopping.xlsx"))).sheets[0];
  assert.deepEqual(sheet.rows[1].map((cell) => cell.text), ["Tea", "2", "3.5", "7"]);
  assert.deepEqual(sheet.rows[3].map((cell) => cell.text), ["Total", "3", "", "7.8"]);
});

test("Excel and CSV are made together from the same data, and the same name is never given twice", async () => {
  const first = await tool({ content: budget, title: "Both", format: "Excel and CSV" });
  assert.equal(first.ok, true, first.content);
  assert.match(first.content, /- documents\/Both\.xlsx \(Excel workbook, 1 sheet\)\n- documents\/Both\.csv \(CSV file\)/);
  const second = await tool({ content: budget, title: "Both", format: ["xlsx", "csv"] });
  assert.equal(second.path, "documents/Both (2).xlsx");
  assert.equal(readFileSync(inWorkspace("documents", "Both.csv"), "utf8").charCodeAt(0), 0xfeff);
});

test("a file's whole path is understood as folder, title and format, as for documents", async () => {
  const asFile = await tool({ content: budget, folder: "reports/Expenses 2026.csv" });
  assert.equal(asFile.ok, true, asFile.content);
  assert.equal(asFile.path, "reports/Expenses 2026.csv");
  assert.equal(existsSync(inWorkspace("reports", "Expenses 2026.xlsx")), false, "the ending chose the format");
  const wins = await tool({ content: budget, folder: "reports/Plan.csv", format: "xlsx" });
  assert.equal(wins.path, "reports/Plan.xlsx", "a format that was asked for is not overruled by a file name");
});

test("outside the workspace is refused without machine access, and with it a full path is written to", async () => {
  for (const folder of [path.join(outside, "elsewhere"), "Desktop", "~/Documents/Taxes"]) {
    const result = await tool({ content: budget, folder });
    assert.equal(result.ok, false, folder);
    assert.match(result.content, /outside my workspace\. Turn on machine access/, folder);
    assert.match(result.content, /Nothing was made\.$/);
  }
  assert.deepEqual(readdirSync(outside), []);
  armCommandsFor(60_000);
  const target = path.join(outside, "Sheets");
  const result = await tool({ content: budget, title: "Out There", folder: target });
  assert.equal(result.ok, true, result.content);
  assert.equal(result.path, path.join(target, "Out There.xlsx"));
  const unattended = await tool({ content: budget, folder: path.join(outside, "Unattended") }, undefined, { unattended: true });
  assert.equal(unattended.ok, false);
  assert.equal(existsSync(path.join(outside, "Unattended")), false);
});

test("the screen is offered the files made in the workspace to open, and not those made anywhere else", async () => {
  takeMadeFiles("offered-sheets");
  const inside = await tool({ content: budget, title: "Inside", format: "xlsx, csv" }, undefined, { sessionId: "offered-sheets" });
  assert.equal(inside.ok, true, inside.content);
  assert.deepEqual(takeMadeFiles("offered-sheets"), ["documents/Inside.xlsx", "documents/Inside.csv"]);
  armCommandsFor(60_000);
  await tool({ content: budget, title: "Away", folder: path.join(outside, "Away") }, undefined, { sessionId: "offered-sheets" });
  assert.deepEqual(takeMadeFiles("offered-sheets"), []);
});

test("what is not data, or not all of it, or in a format that does not exist, is refused before anything is written", async () => {
  const before = readdirSync(inWorkspace("documents")).length;
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{}, /needs all of the data/],
    [{ content: "  \n " }, /needs all of the data/],
    [{ content: "<content>" }, /placeholder/],
    [{ content: "a,b\n[Lines 1-40 of 400]\n1,2" }, /heading of a partial read.*not all of the data/],
    [{ content: budget, format: "ods" }, /"ods" is not a format I can make a spreadsheet in/],
    [{ content: ",,\n,," }, /There were no cells with anything in them/]
  ];
  for (const [args, pattern] of cases) {
    const result = await tool(args);
    assert.equal(result.ok, false, JSON.stringify(args).slice(0, 50));
    assert.match(result.content, pattern);
    assert.match(result.content, /Nothing was made\.$/);
  }
  assert.equal(readdirSync(inWorkspace("documents")).length, before, "nothing new was written");
});

test("a formula that cannot be used is told in the reply, so the user is not left with a cell that does nothing", async () => {
  const result = await tool({ content: "a,b\n1,=SUM(A2;A3)\n2,=1/0", title: "Odd" });
  assert.equal(result.ok, true, result.content);
  assert.match(result.content, /Note: Sheet1!B2: the formula =SUM\(A2;A3\) could not be used \(arguments are separated by commas, not semicolons\), so it is kept as text\./);
  assert.match(result.content, /Note: Sheet1!B3 comes to #DIV\/0!\./);
});

test("the file tools do not write an Excel file that nothing can open, and say what to use instead", async () => {
  for (const [name, args] of [
    ["write_file", { path: "sheet.xlsx", content: "a,b\n1,2" }],
    ["edit_file", { path: "sheet.xlsx", append: "3,4" }]
  ] as const) {
    const result = await runTool({ name, arguments: args }, context("write sheet.xlsx"));
    assert.equal(result.ok, false, name);
    assert.match(result.content, /use make_spreadsheet with the data; or write the rows to a \.csv file instead/, name);
  }
  assert.equal(existsSync(inWorkspace("sheet.xlsx")), false);
});

test("a spreadsheet the assistant made can be read again by the assistant, cell by cell, formulas included", async () => {
  await tool({ content: "## Costs\nItem,Cost\nRent,1200\nFood,400\nTotal,=SUM(B2:B3)", title: "Readable" });
  const read = await runTool({ name: "read_file", arguments: { path: "documents/Readable.xlsx" } }, context("read documents/Readable.xlsx"));
  assert.equal(read.ok, true, read.content);
  assert.match(read.content, /Sheet: Costs/);
  assert.match(read.content, /Rent\t1200/);
  assert.match(read.content, /Total\t1600 \[=SUM\(B2:B3\)\]/);
});

// ---------------------------------------------------------------- through the loop

async function run(question: string, replies: ScriptedReply[]) {
  const engine = await fakeEngine({ models: ["llama3.1-8b"], reply: replies });
  const config = { baseUrl: engine.baseUrl, model: "llama3.1:8b", modelFromEnv: true, timeoutMs: 5000 };
  try {
    return await runAgent(config, question, { memories: [], knowledge: [] });
  } finally {
    engine.server.close();
  }
}

test("asked for an Excel budget, the assistant makes it and the user is told where it is, whatever the model goes on to say", async () => {
  const result = await run("Make me an Excel spreadsheet for my monthly budget: rent 1200, food 400.", [
    { message: { content: "", tool_calls: [{ function: { name: "make_spreadsheet", arguments: { title: "Monthly Budget", content: "Item,Cost\nRent,1200\nFood,400\nTotal,=SUM(B2:B3)" } } }] } },
    { message: { content: "All set! I saved it as budget.xlsx on your Desktop." } }
  ]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.toolsUsed.map((used) => used.name), ["make_spreadsheet"]);
  assert.match(result.text, /documents\/Monthly Budget\.xlsx \(Excel workbook, 1 sheet\)/, "the real place is in the answer");
  assert.equal(existsSync(inWorkspace("documents", "Monthly Budget.xlsx")), true);
});

test("asked only for a table in the reply, the tool is out of reach: no file is made", async () => {
  const result = await run("give me a table of the first three planets with their diameters", [
    { message: { content: "", tool_calls: [{ function: { name: "make_spreadsheet", arguments: { title: "Planets", content: "Planet,Diameter\nMercury,4879\nVenus,12104\nEarth,12742" } } }] } },
    { message: { content: "| Planet | Diameter (km) |\n|---|---|\n| Mercury | 4,879 |\n| Venus | 12,104 |\n| Earth | 12,742 |" } }
  ]);
  assert.equal(existsSync(inWorkspace("documents", "Planets.xlsx")), false);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.toolsUsed.filter((used) => used.name === "make_spreadsheet"), []);
    assert.match(result.text, /Mercury/);
  }
});
