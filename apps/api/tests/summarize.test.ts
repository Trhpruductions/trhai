import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const workspace = mkdtempSync(path.join(tmpdir(), "trhai-summarize-"));
process.env.ASCEND_WORKSPACE = workspace;

const { maxSections, readableAtOnce, sectionTokens, splitIntoSections, summarizeLongText } = await import("../src/services/summarize.js");
const { estimateTokens } = await import("../src/services/contextBudget.js");
const { availableTools, runTool } = await import("../src/services/agentTools.js");
const { wantsASummary } = await import("../src/services/actionIntent.js");
const { permissionLevelOf } = await import("../src/services/toolPermissions.js");

test.after(() => rmSync(workspace, { recursive: true, force: true }));

/** A long report: numbered paragraphs, each with a figure to keep. */
function report(paragraphs: number): string {
  return Array.from({ length: paragraphs }, (_, i) =>
    `Section ${i + 1}. Revenue in region ${i + 1} reached ${1000 + i * 37} thousand dollars, `
    + `and the team there hired ${3 + (i % 5)} people. Costs were held flat by renegotiating supplier contracts.`).join("\n\n");
}

/** A stand-in model that records every prompt and answers with a short note. */
function recordingModel(answer = (prompt: string) => `- note on ${/part (\d+) of (\d+)/.exec(prompt)?.[0] ?? "combined notes"}`) {
  const prompts: string[] = [];
  return {
    prompts,
    generate: async (prompt: string) => {
      prompts.push(prompt);
      return { ok: true as const, text: answer(prompt) };
    }
  };
}

test("a long text is cut into sections the window can hold, in order, losing nothing", () => {
  const text = report(120);
  const sections = splitIntoSections(text);
  assert.ok(sections.length > 1);
  assert.ok(sections.every((section) => estimateTokens(section) <= sectionTokens + 400), "each section fits");
  assert.equal(sections.join("\n\n").replace(/\s+/g, " "), text.replace(/\s+/g, " "), "every word, in order");
  assert.equal(readableAtOnce(report(3)), true);
  assert.equal(readableAtOnce(text), false);
});

test("every section is read, and the notes keep its figures", async () => {
  const model = recordingModel();
  const summary = await summarizeLongText(report(120), { title: "Annual report", generate: model.generate });
  assert.equal(summary.ok, true);
  if (!summary.ok) return;
  assert.equal(summary.read, summary.sections, "nothing skipped");
  assert.equal(model.prompts.length, summary.sections, "one note per section, and no combining needed for short notes");
  assert.match(model.prompts[0], /part 1 of \d+ of the document "Annual report"/);
  assert.match(model.prompts[0], /Keep names, numbers, amounts and dates exactly as written/);
  assert.match(model.prompts[0], /Section 1\. Revenue in region 1 reached 1000 thousand dollars/, "the section itself is in the prompt");
  assert.match(summary.notes, /note on part 1 of/);
});

test("a focus is passed to every section", async () => {
  const model = recordingModel();
  await summarizeLongText(report(60), { title: "Annual report", focus: "hiring", generate: model.generate });
  assert.ok(model.prompts.every((prompt) => /The reader wants to know about: hiring/.test(prompt)));
});

test("notes too long for one reply are combined in a further round", async () => {
  const wordy = recordingModel((prompt) => /^These are notes/.test(prompt)
    ? "- combined"
    : `- ${"a detailed note about this part of the report that goes on at length ".repeat(40)}`);
  const text = report(400);
  assert.ok(splitIntoSections(text).length >= 5, "enough sections for the notes to overflow one reply");
  const summary = await summarizeLongText(text, { title: "Annual report", generate: wordy.generate });
  assert.equal(summary.ok, true);
  const combines = wordy.prompts.filter((prompt) => prompt.startsWith("These are notes"));
  assert.ok(combines.length >= 1, "a combining round ran");
  assert.match(combines[0], /Combine them into one set of bullet points, in the document's order/);
  if (summary.ok) assert.match(summary.notes, /^- combined/);
});

test("a section the model cannot read stops the summary and says where", async () => {
  let calls = 0;
  const failing = async () => (++calls === 2 ? { ok: false as const, reason: "the model timed out" } : { ok: true as const, text: "- fine" });
  const summary = await summarizeLongText(report(120), { title: "Annual report", generate: failing });
  assert.equal(summary.ok, false);
  if (!summary.ok) assert.match(summary.reason, /stopped at part 2 of \d+: the model timed out/);
});

test("a text longer than the cap reads its first sections and says so", async () => {
  const model = recordingModel();
  const huge = report(maxSections * 70);
  assert.ok(splitIntoSections(huge).length > maxSections, "the text really is past the cap");
  const summary = await summarizeLongText(huge, { title: "Huge", generate: model.generate });
  assert.equal(summary.ok, true);
  if (summary.ok) {
    assert.equal(summary.read, maxSections);
    assert.ok(summary.sections > maxSections);
  }
});

// ------------------------------------------------------------- the tool

const longDocument = { id: "d1", title: "Annual report", body: report(120) };

test("summarize_document reads a whole knowledge document through the model", async () => {
  const model = recordingModel();
  const result = await runTool({ name: "summarize_document", arguments: { title: "annual report" } },
    { memories: [], knowledge: [], documents: [longDocument], generateText: model.generate });
  assert.equal(result.ok, true);
  assert.match(result.content, /^Notes on "Annual report", made by reading all \d+ of its parts/);
  assert.match(result.content, /every name and figure in them comes from the document/);
  assert.ok(model.prompts.length > 1);
});

test("a short document is handed over whole, without a round of notes", async () => {
  const model = recordingModel();
  const result = await runTool({ name: "summarize_document", arguments: { title: "Brief" } },
    { memories: [], knowledge: [], documents: [{ id: "d2", title: "Brief", body: "The launch moved to May 4." }], generateText: model.generate });
  assert.equal(result.ok, true);
  assert.match(result.content, /short enough to read whole/);
  assert.match(result.content, /The launch moved to May 4\./);
  assert.equal(model.prompts.length, 0);
});

test("summarize_document reads a file by path, PDF or text", async () => {
  writeFileSync(path.join(workspace, "minutes.txt"), report(200));
  assert.equal(readableAtOnce(report(200)), false, "long enough to need sections");
  const model = recordingModel();
  const result = await runTool({ name: "summarize_document", arguments: { path: "minutes.txt", focus: "costs" } },
    { memories: [], knowledge: [], generateText: model.generate });
  assert.equal(result.ok, true);
  assert.match(result.content, /^Notes on "minutes\.txt"/);
  assert.match(result.content, /with attention to costs/);
});

test("what cannot be summarized says why", async () => {
  const missing = await runTool({ name: "summarize_document", arguments: { title: "Budget" } },
    { memories: [], knowledge: [], documents: [longDocument] });
  assert.equal(missing.ok, false);
  assert.match(missing.content, /Annual report/, "the titles that do exist are named");

  const noModel = await runTool({ name: "summarize_document", arguments: { title: "Annual report" } },
    { memories: [], knowledge: [], documents: [longDocument] });
  assert.match(noModel.content, /needs the local model/);

  const nothing = await runTool({ name: "summarize_document", arguments: {} }, { memories: [], knowledge: [] });
  assert.match(nothing.content, /needs the title of a document, or the path of a file/);
});

test("it is offered for a summary, and reads nothing it should not change", () => {
  for (const asked of ["summarize the Q3 report", "give me the key points of minutes.pdf", "tl;dr of the contract",
    "what's the gist of the onboarding doc", "sum this up for me"]) {
    assert.equal(wantsASummary(asked), true, asked);
  }
  for (const asked of ["read report.pdf", "what does the report say about costs", "open the minutes"]) {
    assert.equal(wantsASummary(asked), false, asked);
  }
  const names = (summaries: boolean) => availableTools(false, { summaries }).map((tool) => tool.function.name);
  assert.ok(names(true).includes("summarize_document"));
  assert.ok(!names(false).includes("summarize_document"));
  assert.equal(permissionLevelOf("summarize_document"), 1);
});
