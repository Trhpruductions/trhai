import test from "node:test";
import assert from "node:assert/strict";
import { legalDocument, legalFacts, type LegalBlock } from "@ascend/shared";
import { modelCatalog } from "../src/services/modelSetup.js";
import { piperVoices } from "../src/services/toolCatalog.js";

// The "Services and licences" text repeats the install records' licence for every voice
// and model. This keeps the two the same: a voice added, dropped or relicensed in the
// records without the text following is a text that says something the app does not.

function table(caption: string): string[][] {
  const doc = legalDocument("services", legalFacts);
  for (const section of doc.sections) {
    for (const block of section.blocks) {
      if (block.kind === "table" && block.caption === caption) return (block as Extract<LegalBlock, { kind: "table" }>).rows;
    }
  }
  throw new Error(`no table captioned ${caption}`);
}

test("every voice the app can install is in the text with the licence its record states, and no other voice is", () => {
  const rows = table("Voices");
  assert.equal(rows.length, piperVoices.length);
  for (const voice of piperVoices) {
    const row = rows.find((entry) => entry[0] === `${voice.label} (${voice.id})`);
    assert.ok(row, `the text has a row for ${voice.label}`);
    assert.equal(row[1], voice.license.name, `${voice.label}'s licence reads as the record states it`);
    assert.equal(row[2] === "Yes", voice.license.commercialUse, `${voice.label}'s commercial-use column matches the record`);
  }
});

test("every model the app can install is in the text with the licence its record states, and no other model is", () => {
  const rows = table("Models");
  assert.equal(rows.length, modelCatalog.length);
  for (const model of modelCatalog) {
    const row = rows.find((entry) => entry[0] === model.label);
    assert.ok(row, `the text has a row for ${model.label}`);
    assert.equal(row[1], model.license.name, `${model.label}'s licence reads as the record states it`);
    assert.equal(row[2] === "Yes", model.license.commercialUse, `${model.label}'s commercial-use column matches the record`);
  }
});
