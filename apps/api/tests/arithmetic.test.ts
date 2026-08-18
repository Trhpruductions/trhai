import test from "node:test";
import assert from "node:assert/strict";
import { evaluateArithmetic, formatNumber } from "../src/services/arithmetic.js";

const value = (input: string) => {
  const result = evaluateArithmetic(input);
  assert.equal(result.ok, true, `expected "${input}" to evaluate: ${result.ok ? "" : result.reason}`);
  return result.ok ? result.value : NaN;
};

const refuse = (input: string) => {
  const result = evaluateArithmetic(input);
  assert.equal(result.ok, false, `expected "${input}" to be refused`);
};

test("ordinary arithmetic", () => {
  assert.equal(value("2 + 2"), 4);
  assert.equal(value("10 - 4"), 6);
  assert.equal(value("6 * 7"), 42);
  assert.equal(value("10 / 4"), 2.5);
  assert.equal(value("10 % 3"), 1);
});

test("precedence and brackets", () => {
  assert.equal(value("2 + 3 * 4"), 14);
  assert.equal(value("(2 + 3) * 4"), 20);
  assert.equal(value("2 * (3 + (4 - 1))"), 12);
});

test("exponents associate to the right", () => {
  // 2^(3^2) = 512, not (2^3)^2 = 64. This is how it is written on paper.
  assert.equal(value("2 ^ 3 ^ 2"), 512);
});

test("negative numbers", () => {
  assert.equal(value("-5 + 3"), -2);
  assert.equal(value("3 * -2"), -6);
  assert.equal(value("--4"), 4);
});

test("the forms a model actually writes", () => {
  assert.equal(value("1,500 + 500"), 2000);
  assert.equal(value("6 x 7"), 42);
  assert.equal(value("10 ÷ 2"), 5);
});

test("division by zero is refused, not answered with Infinity", () => {
  // JavaScript would hand back Infinity and the model would report it as a
  // result. It is not one.
  refuse("1 / 0");
  refuse("5 % 0");
});

test("code is refused rather than evaluated", () => {
  // The whole reason this is a parser and not eval(): the input is a string a
  // model produced, and eval on model output is arbitrary code execution in
  // the API process.
  refuse("process.exit(1)");
  refuse("require('fs')");
  refuse("2 + fetch('http://x')");
  refuse("globalThis");
  refuse("[].constructor");
  refuse("1;2");
});

test("malformed input is refused rather than half-read", () => {
  refuse("2 +");
  refuse("(2 + 3");
  refuse("2 + 2 4");
  refuse("");
  refuse("   ");
  refuse("hello");
});

test("an over-long expression is refused", () => {
  refuse(`1 ${"+ 1 ".repeat(200)}`.padEnd(600, " ") + "+ 1");
});

test("a result that is not finite is refused", () => {
  refuse("9 ^ 9 ^ 9");
});

test("floating point noise is trimmed for display", () => {
  // 0.1 + 0.2 is 0.30000000000000004 in binary floating point, and showing
  // that reads as a bug rather than as arithmetic.
  assert.equal(formatNumber(value("0.1 + 0.2")), "0.3");
  assert.equal(formatNumber(4), "4");
  assert.equal(formatNumber(2.5), "2.5");
});

test("decimals and precision", () => {
  assert.equal(value("12.5 * 3"), 37.5);
  assert.equal(value("(12.5 * 3) + 7"), 44.5);
});
