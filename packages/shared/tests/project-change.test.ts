import test from "node:test";
import assert from "node:assert/strict";
import { amendProject, changesFrom, originalRequestFrom, titleFrom, withChanges } from "../src/projectChange.js";
import { generateProject } from "../src/projectGenerator.js";

// Changing a built app from a description of the change. Found live: "add
// a 'notes' text field to the plants", said right after building a
// houseplant tracker, built a second app called "Notes Text Field".

const original = "build a small app that tracks my houseplants with a name, species and last watered date";
const fieldsOf = (change: string, earlier: string[] = []) =>
  amendProject(original, earlier, change)?.spec.entities[0].fields.map((field) => `${field.name}:${field.type}`) ?? [];

test("a field is added to the entity the request names", () => {
  const amended = amendProject(original, [], "add a 'notes' text field to the plants", "Tracks My Houseplants");
  assert.ok(amended, "the change must map onto the spec");
  const plant = amended.spec.entities[0];
  const notes = plant.fields.find((field) => field.name === "notes");
  assert.ok(notes, `notes missing from ${plant.fields.map((field) => field.name).join(", ")}`);
  assert.equal(notes.type, "text");
  assert.deepEqual(amended.changes, [`added a text field "notes" to ${plant.name}`]);
  assert.equal(amended.spec.title, "Tracks My Houseplants", "the title is kept, so the folder is");
  assert.equal(amended.spec.summary, original, "the README paragraph stays the request");
});

test("the ways a field gets asked for", () => {
  assert.ok(fieldsOf("add a field called notes").includes("notes:text"), fieldsOf("add a field called notes").join());
  assert.ok(fieldsOf("add a number field called height").includes("height:number"));
  assert.ok(fieldsOf("add a purchase date field").includes("purchaseDate:date"), fieldsOf("add a purchase date field").join());
  assert.ok(fieldsOf("add a light level field to each plant").includes("lightLevel:number"));
  assert.ok(fieldsOf("include a nickname field").includes("nickname:string"));
  assert.ok(fieldsOf("add a contact email field").includes("contactEmail:email"));
});

test("a field is removed, and a field that exists is not added twice", () => {
  const removed = amendProject(original, [], "remove the species field");
  assert.ok(removed);
  const names = removed.spec.entities[0].fields.map((field) => field.name);
  assert.ok(!names.some((name) => /^spec/.test(name)), `species still there: ${names.join(", ")}`);
  assert.match(removed.changes[0], /removed the \w+ field/);

  const again = amendProject(original, [], "add a name field");
  assert.ok(again);
  assert.match(again.changes[0], /already has a name field/);
  assert.equal(again.spec.entities[0].fields.filter((field) => field.name === "name").length, 1);
});

test("a feature is added with the fields it needs", () => {
  const dashboard = amendProject(original, [], "add a dashboard");
  assert.ok(dashboard);
  assert.ok(dashboard.spec.features.includes("dashboard"));

  const board = amendProject(original, [], "add a kanban board");
  assert.ok(board);
  assert.ok(board.spec.features.includes("board"));
  assert.ok(board.spec.entities[0].fields.some((field) => field.name === "status"), "a board needs a status to group by");

  // The amended spec still generates a project.
  const files = generateProject(board.spec);
  assert.ok(files.some((file) => file.path === "server.js"));
  assert.ok(files.find((file) => file.path === "public/index.html")?.content.includes("status"));
});

test("a change that maps onto nothing is refused", () => {
  assert.equal(amendProject(original, [], "make it prettier"), null);
  assert.equal(amendProject(original, [], "rewrite it in python"), null);
  assert.equal(amendProject("build me a calculator", [], "add a notes field"), null, "a calculator has no records");
});

test("the original request, title and changes are read from the README", () => {
  const readme = "# Tracks My Houseplants\n\nbuild a small app that tracks my houseplants with a name\n\n## Run it\n\nnode server.js\n";
  assert.equal(originalRequestFrom(readme), "build a small app that tracks my houseplants with a name");
  assert.equal(titleFrom(readme), "Tracks My Houseplants");
  assert.deepEqual(changesFrom(readme), []);
  assert.equal(originalRequestFrom("# Something\n\n## Run it\n"), null);
  assert.equal(titleFrom("no heading"), null);

  const carried = withChanges(readme, ["add a notes field", "add a dashboard"]);
  assert.deepEqual(changesFrom(carried), ["add a notes field", "add a dashboard"]);
  assert.equal(originalRequestFrom(carried), "build a small app that tracks my houseplants with a name");
  // Carried again, the list is replaced rather than doubled.
  assert.deepEqual(changesFrom(withChanges(carried, ["add a notes field"])), ["add a notes field"]);
});

test("changes accumulate in order", () => {
  const names = fieldsOf("add a height number field", ["add a notes field"]);
  assert.ok(names.includes("notes:text"), `notes lost on the second change: ${names.join(", ")}`);
  assert.ok(names.includes("height:number"));
  // A removal of something an earlier change added.
  const after = fieldsOf("remove the notes field", ["add a notes field"]);
  assert.ok(!after.includes("notes:text"));
});
