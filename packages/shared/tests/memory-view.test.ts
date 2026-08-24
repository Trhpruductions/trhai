import test from "node:test";
import assert from "node:assert/strict";
import { memoryBodyAddsInfo } from "../src/memoryView.js";

test("an unrenamed memory does not print its sentence twice", () => {
  // Extraction derives the title from the body, so every freshly stored memory
  // had the same line rendered as both title and body.
  assert.equal(
    memoryBodyAddsInfo({ title: "we use Postgres", body: "we use Postgres" }),
    false
  );
  // Casing and surrounding space are not a difference worth a second line.
  assert.equal(
    memoryBodyAddsInfo({ title: "We Use Postgres", body: "  we use postgres  " }),
    false
  );
});

test("a title that is a prefix of the body still reads as a stutter", () => {
  assert.equal(
    memoryBodyAddsInfo({
      title: "we standardized on Postgres",
      body: "we standardized on Postgres for all services"
    }),
    false
  );
});

test("a renamed memory shows the detail underneath", () => {
  assert.equal(
    memoryBodyAddsInfo({ title: "Database standard", body: "we standardized on Postgres" }),
    true
  );
});

test("an empty body is never shown, an empty title never hides one", () => {
  assert.equal(memoryBodyAddsInfo({ title: "Database", body: "   " }), false);
  assert.equal(memoryBodyAddsInfo({ title: "  ", body: "we use Postgres" }), true);
});
