import test from "node:test";
import assert from "node:assert/strict";
import { classifyRequest } from "../src/projectArchetype.js";

// The question this answers: is the request actually asking for the thing the
// template builds? Every case below was a real output of the old behaviour,
// where the answer was always "records" and the app was always wrong.

test("a request to keep things is a records app", () => {
  assert.equal(classifyRequest("build me an app to track my books", false), "records");
  assert.equal(classifyRequest("I want to keep a list of my tools", false), "records");
  assert.equal(classifyRequest("something to manage client invoices", false), "records");
});

test("naming the fields of a record is enough on its own", () => {
  assert.equal(
    classifyRequest("an app for my plants with a name, species and last watered date", true),
    "records"
  );
});

test("naming fields without a record shape does not force the template", () => {
  // hasNamedFields false: nothing described the columns of anything.
  assert.equal(classifyRequest("a snake game with a scoreboard", false), "authored");
});

test("a calculator is still a calculator", () => {
  assert.equal(classifyRequest("build me a tip calculator", false), "calculator");
  assert.equal(classifyRequest("something to calculate compound interest", false), "calculator");
});

test("the things that used to become nonsense CRUD apps are authored instead", () => {
  // Each of these produced a REST API storing the noun in it. A snake game is
  // not a collection of `game` records, and a password generator is certainly
  // not a collection of `generator` records.
  for (const request of [
    "build me a snake game",
    "build me a pomodoro timer",
    "build me a password generator",
    "build me a markdown to HTML converter",
    "build me a drum machine",
    "build me a typing speed test"
  ]) {
    assert.equal(classifyRequest(request, false), "authored", `misrouted: ${request}`);
  }
});

test("a unit converter is not a records app", () => {
  // This one produced entities for `converter`, `mile` and `kilometre`.
  assert.equal(classifyRequest("build me a unit converter for miles and kilometres", false), "authored");
});

test("classification does not depend on capitalisation", () => {
  assert.equal(classifyRequest("TRACK MY BOOKS", false), "records");
  assert.equal(classifyRequest("A Tip Calculator", false), "calculator");
});

test("a calculator wins over record language when both appear", () => {
  // "track" plus "calculator" - the calculator has nothing to store, and
  // running it through entity extraction is the bug the archetype exists for.
  assert.equal(classifyRequest("a calculator to track my tips", false), "calculator");
});

test("a support desk whose tickets have fields is a records app", () => {
  // Caught by the existing suite: the first field list checked only for
  // "with a", so a request phrased with "have" was sent to be written from
  // scratch when the records template was exactly right for it.
  assert.equal(
    classifyRequest("Build a support desk where tickets have a title, status and priority", true),
    "records"
  );
});

test("what is being built beats field evidence", () => {
  // Field extraction fires on these anyway and gets it wrong, so the pass with
  // hasNamedFields true is the one that matters.
  assert.equal(classifyRequest("a snake game with a scoreboard", true), "authored");
  assert.equal(classifyRequest("a unit converter for miles and kilometres", true), "authored");
  assert.equal(classifyRequest("a markdown to HTML converter", true), "authored");
});

test("a request to convert something is not a record store", () => {
  // Live: "an app that converts celsius to fahrenheit" matched none of the
  // artifact nouns - matching is substring, and "converter" is not inside
  // "converts" - so it fell through to records. It extracted "celsius" as an
  // entity and built a CRUD store for celsius records: a page titled "Celsius
  // to Fahrenheit", twenty-five checks passed, and nothing that converts.
  for (const request of [
    "an app that converts celsius to fahrenheit",
    "build me something that converts miles to kilometres",
    "an app for converting currencies",
    "a tool that translates morse code"
  ]) {
    assert.notEqual(classifyRequest(request, false), "records", `still records: ${request}`);
  }
});

test("the noun forms still classify as before", () => {
  assert.equal(classifyRequest("a unit converter for miles to kilometres", false), "authored");
  assert.equal(classifyRequest("build me a calculator", false), "calculator");
});

test("keeping things is still a record store", () => {
  // The other side of the line: these must not be dragged into "authored" by
  // the new verbs.
  // Records needs positive evidence - a record verb or a field list - and
  // "store" is deliberately not one of them: a request that only says "store
  // my recipes" goes to the model to write something fitted to recipes, which
  // is better than a generic CRUD table. These all carry the evidence.
  for (const request of [
    "an app to track invoices",
    "keep a list of my recipes",
    "a support desk where tickets have a title and status"
  ]) {
    assert.equal(classifyRequest(request, true), "records", `should be records: ${request}`);
  }
});
