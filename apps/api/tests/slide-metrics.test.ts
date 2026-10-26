import test from "node:test";
import assert from "node:assert/strict";
import type { Bullet, SlideContent } from "../src/services/deckData.js";
import type { Inline } from "../src/services/markdown.js";
import { bodyRoom, bodySize, columnWeights, fits, heightOf, rowHeights, subtitleSize, tableFont, titleSize, type Table } from "../src/services/slideMetrics.js";

// How much fits on a slide, measured from how many letters of Calibri go on a line at a size. The numbers here are the ones
// the printed slides were measured against; a change to any of them changes where a slide splits and how big its text is set.

const text = (value: string): Inline[] => [{ kind: "text", text: value }];
const bullet = (value: string, extra: Partial<Bullet> = {}): Bullet => ({ inlines: text(value), level: 0, number: null, task: false, ...extra });
const list = (...items: Bullet[]): SlideContent => ({ kind: "bullets", items });
const short = (count: number): SlideContent => list(...Array.from({ length: count }, (_, index) => bullet(`Point ${index + 1} of the list`)));
const table = (header: string[], rows: string[][]): Table => ({ kind: "table", header: header.map(text), rows: rows.map((row) => row.map(text)), align: header.map(() => null) });
const letters = (count: number) => "x".repeat(count);
const near = (actual: number, expected: number, message = "") => assert.ok(Math.abs(actual - expected) < 0.01, `${message ? `${message}: ` : ""}${actual} is not ${expected}`);

test("a title is set smaller the longer it is, at exactly these lengths", () => {
  // A title slide's title is the largest text there is.
  for (const [length, size] of [[1, 54], [24, 54], [25, 44], [40, 44], [41, 36], [70, 36], [71, 30], [110, 30], [111, 24], [400, 24]]) {
    assert.equal(titleSize(letters(length), true), size, `${length} letters on a title slide`);
  }
  for (const [length, size] of [[1, 36], [100, 36], [101, 32], [150, 32], [151, 28], [200, 28], [201, 24], [400, 24]]) {
    assert.equal(titleSize(letters(length), false), size, `${length} letters on a slide`);
  }
});

test("a subtitle is set smaller the more there is of it", () => {
  for (const [length, size] of [[0, 24], [120, 24], [121, 20], [200, 20], [201, 16]]) assert.equal(subtitleSize(letters(length)), size, `${length} letters`);
});

test("body text is set at the largest of 28, 24 and 20 points that leaves it all in the box", () => {
  assert.equal(bodySize([]), 28);
  for (const [bullets, size] of [[1, 28], [7, 28], [8, 24], [9, 20]]) assert.equal(bodySize([short(bullets)]), size, `${bullets} short bullets`);
  // More than fits at the smallest size is still set at the smallest.
  assert.equal(bodySize([short(14)]), 20);
});

test("a body fits if it fits at the smallest size: nine short bullets do, ten do not", () => {
  assert.equal(fits([short(9)]), true);
  assert.equal(fits([short(10)]), false);
  assert.equal(fits([]), true);
  assert.equal(fits([short(5), short(4)]), true, "all the pieces of a slide are counted together");
  assert.equal(fits([short(5), short(5)]), false);
  assert.equal(bodyRoom, 330);
});

test("a bullet takes a line for as many letters as go on one at its size, less its indent", () => {
  // At 24 points a first-level bullet holds 76 letters, a checklist item (no bullet to hang) 78, a numbered one 75.
  const at = (item: Bullet) => heightOf([list(item)], 24);
  near(at(bullet(letters(76))), 24 * 1.22 + 10);
  near(at(bullet(letters(77))), 2 * 24 * 1.22 + 10);
  near(at(bullet(letters(78), { task: true })), 24 * 1.22 + 10);
  near(at(bullet(letters(79), { task: true })), 2 * 24 * 1.22 + 10);
  near(at(bullet(letters(75), { number: 1 })), 24 * 1.22 + 10);
  near(at(bullet(letters(76), { number: 1 })), 2 * 24 * 1.22 + 10);
});

test("a bullet with nothing in it still takes a line, and so does an empty paragraph", () => {
  near(heightOf([list(bullet(""))], 24), 24 * 1.22 + 10);
  near(heightOf([{ kind: "text", inlines: [] }], 24), 24 * 1.22 + 6);
});

test("a nested bullet is set two points smaller for each level, takes less space before it, and has less width", () => {
  // Second level: 22 points, 5 points before it; 750 points across at 9.46 points a letter is 79 letters.
  near(heightOf([list(bullet(letters(79), { level: 1 }))], 24), 22 * 1.22 + 5);
  near(heightOf([list(bullet(letters(80), { level: 1 }))], 24), 2 * 22 * 1.22 + 5);
  // Third level: 20 points, 99 points of indent: 714 points across at 8.6 points a letter is 83 letters.
  near(heightOf([list(bullet(letters(83), { level: 2 }))], 24), 20 * 1.22 + 5);
  near(heightOf([list(bullet(letters(84), { level: 2 }))], 24), 2 * 20 * 1.22 + 5);
  // A checklist item nested one level is indented by less than a bullet is.
  near(heightOf([list(bullet(letters(75), { level: 1, task: true }))], 24), 22 * 1.22 + 5);
  // Two levels down it is indented 63 points, which leaves room for 87 letters at 20 points; at a bullet's 72 it would be 86.
  near(heightOf([list(bullet(letters(87), { level: 2, task: true }))], 24), 20 * 1.22 + 5);
  near(heightOf([list(bullet(letters(88), { level: 2, task: true }))], 24), 2 * 20 * 1.22 + 5);
});

test("text and quotes take the lines they wrap to, a quote with an indent of its own", () => {
  const paragraph = (value: string): SlideContent => ({ kind: "text", inlines: text(value) });
  const quote = (value: string): SlideContent => ({ kind: "quote", inlines: text(value) });
  near(heightOf([paragraph(letters(78))], 24), 24 * 1.22 + 6);
  near(heightOf([paragraph(letters(79))], 24), 2 * 24 * 1.22 + 6);
  near(heightOf([quote(letters(76))], 24), 24 * 1.22 + 6);
  near(heightOf([quote(letters(77))], 24), 2 * 24 * 1.22 + 6);
});

test("code is set six points smaller, in a letter that is wider, and a long line wraps", () => {
  const code = (...lines: string[]): SlideContent => ({ kind: "code", lines });
  // At 24 points it is 18, which holds 82 letters of Consolas across.
  near(heightOf([code("a", "b", "c")], 24), 3 * 18 * 1.22 + 6);
  near(heightOf([code(letters(82))], 24), 18 * 1.22 + 6);
  near(heightOf([code(letters(83))], 24), 2 * 18 * 1.22 + 6);
  // Never below 14 points, whatever the size.
  near(heightOf([code("a")], 20), 14 * 1.22 + 6);
  near(heightOf([code("a")], 28), 22 * 1.22 + 6);
  near(heightOf([code("", "")], 24), 2 * 18 * 1.22 + 6, "an empty line is still a line");
});

test("a table's rows are at least 33 points, taller where a cell's words wrap, and its height is its rows and a gap", () => {
  const plain = table(["Name", "Value"], [["Ann", "10"], ["Bob", "20"]]);
  assert.deepEqual(rowHeights(plain), [33, 33, 33]);
  near(heightOf([plain], 24), 3 * 33 + 12);
  // A column's room is its share of 828 points less 14.4 for its margins, at 16 points: two columns of equal weight have 399.6 points, 58 letters.
  const wide = table(["A", "B"], [[letters(58), letters(58)], [letters(59), letters(58)]]);
  const heights = rowHeights(wide);
  assert.deepEqual(heights.slice(0, 2), [33, 33]);
  near(heights[2], 2 * 16 * 1.22 + 8);
  // Unequal columns: the long one is 40 of 46 shares, 705.6 points, 102 letters a line, so 300 letters are three lines.
  const lopsided = table(["A", "B"], [[letters(300), "x"]]);
  near(rowHeights(lopsided)[1], 3 * 16 * 1.22 + 8);
});

test("a table is set smaller with many rows or many columns", () => {
  const rows = (count: number) => Array.from({ length: count }, () => ["a", "b"]);
  assert.equal(tableFont(table(["A", "B"], rows(6))), 16);
  assert.equal(tableFont(table(["A", "B"], rows(7))), 14);
  assert.equal(tableFont(table(["A", "B", "C", "D"], [["1", "2", "3", "4"]])), 16);
  assert.equal(tableFont(table(["A", "B", "C", "D", "E"], [["1", "2", "3", "4", "5"]])), 14);
  // The size is what the wrapping is measured at: the same long cell is more lines at 16 points than 14.
  const cell = letters(130);
  const sixRows = table(["A", "B"], [[cell, "x"], ...rows(5)]);
  const sevenRows = table(["A", "B"], [[cell, "x"], ...rows(6)]);
  assert.ok(rowHeights(sixRows)[1] > rowHeights(sevenRows)[1] - 0.001);
});

test("a column is as wide as the longest thing in it, between six letters and forty", () => {
  assert.deepEqual(columnWeights(table(["A", "BBBBBBBBBB", "C"], [["x", "y", letters(300)]])), [6, 10, 40]);
  assert.deepEqual(columnWeights(table(["Name"], [[letters(12)], [letters(8)]])), [12]);
  assert.deepEqual(columnWeights(table(["Name", "Very long header over a short column"], [["a", "b"]])), [6, 36]);
  assert.deepEqual(columnWeights(table(["a", "b"], [["only one cell"]] as never)), [13, 6], "a row with a cell missing is as wide as its other cells");
});
