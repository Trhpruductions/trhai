import test from "node:test";
import assert from "node:assert/strict";
import { answerArithmeticQuestion, dividesByZero } from "../src/services/arithmeticQuestion.js";

// A sum is worked out here and not by the model. Asked of the model on a PC
// with no graphics card, "What is 487 times 263?" took 377 seconds, then 531;
// the calculator it was meant to call is exact and instant.

const says = (message: string) => answerArithmeticQuestion(message);

test("the sum that took the model six minutes is answered at once", () => {
  assert.equal(says("What is 487 times 263?"), "487 × 263 = 128,081");
  assert.equal(says("what is 12 times 12"), "12 × 12 = 144");
});

test("the usual ways of writing a sum are understood", () => {
  assert.equal(says("12.5 * 3 + 7"), "12.5 × 3 + 7 = 44.5");
  assert.equal(says("what is 0.1 + 0.2"), "0.1 + 0.2 = 0.3", "floating-point noise is not an answer");
  assert.equal(says("1,000 + 250"), "1,000 + 250 = 1,250");
  assert.equal(says("what is 9 plus 10"), "9 + 10 = 19");
  assert.equal(says("what is 100 minus 37"), "100 - 37 = 63");
  assert.equal(says("what is 84 divided by 7"), "84 ÷ 7 = 12");
  assert.equal(says("what is 6 multiplied by 7"), "6 × 7 = 42");
  assert.equal(says("2+2=?"), "2 + 2 = 4");
  assert.equal(says("5 + 5 ="), "5 + 5 = 10");
  assert.equal(says("calculate 3 x 4"), "3 × 4 = 12");
  assert.equal(says("3 × 4"), "3 × 4 = 12");
  assert.equal(says("what is 8 ÷ 2"), "8 ÷ 2 = 4");
});

test("order of operations, brackets, signs and powers come out as on paper", () => {
  assert.equal(says("2 + 3 * 4"), "2 + 3 × 4 = 14");
  assert.equal(says("(2 + 3) * 4"), "(2 + 3) × 4 = 20");
  assert.equal(says("-5 + 3"), "-5 + 3 = -2");
  assert.equal(says("what is 5 - -3"), "5 - -3 = 8");
  assert.equal(says("2^10"), "2^10 = 1,024");
  assert.equal(says("what's 2^10"), "2^10 = 1,024");
  assert.equal(says("2 ** 10"), "2^10 = 1,024");
  assert.equal(says("2 to the power of 10"), "2^10 = 1,024");
  assert.equal(says("2^3^2"), "2^3^2 = 512", "a power tower is read from the top, as written on paper");
});

test("division that does not come out even is shown to ten figures", () => {
  assert.equal(says("what is 10 / 4"), "10 ÷ 4 = 2.5");
  assert.equal(says("10 / 4"), "10 ÷ 4 = 2.5");
  assert.equal(says("what is 1/3"), "1 ÷ 3 = 0.3333333333");
  assert.equal(says("what is 2/3"), "2 ÷ 3 = 0.6666666667");
});

test("percentages, roots and squares", () => {
  assert.equal(says("what's 15% of 80"), "15% of 80 = 12");
  assert.equal(says("what is 15 percent of 80"), "15% of 80 = 12");
  assert.equal(says("20 per cent of 150"), "20% of 150 = 30");
  assert.equal(says("15% of 240"), "15% of 240 = 36");
  assert.equal(says("5 squared"), "5² = 25");
  assert.equal(says("what is 3 cubed"), "3³ = 27");
  assert.equal(says("the square of 9"), "9² = 81");
  assert.equal(says("the cube of 3"), "3³ = 27");
  assert.equal(says("square root of 144"), "√144 = 12");
  assert.equal(says("sqrt(2)"), "√2 = 1.414213562");
  assert.equal(says("√81"), "√81 = 9");
});

test("sums written as a command are understood", () => {
  assert.equal(says("add 12 and 30"), "12 + 30 = 42");
  assert.equal(says("add 5 to 10"), "5 + 10 = 15");
  assert.equal(says("the sum of 4 and 9"), "4 + 9 = 13");
  assert.equal(says("multiply 6 by 7"), "6 × 7 = 42");
  assert.equal(says("what is the product of 6 and 7"), "6 × 7 = 42");
  assert.equal(says("subtract 5 from 12"), "12 - 5 = 7", "the second number is the one taken from");
  assert.equal(says("divide 20 by 4"), "20 ÷ 4 = 5");
});

test("politeness around the sum does not matter", () => {
  assert.equal(says("Can you please work out 6 times 7?"), "6 × 7 = 42");
  assert.equal(says("hey, what is 9 plus 10"), "9 + 10 = 19");
  assert.equal(says("tell me what is 5 + 5"), "5 + 5 = 10");
  assert.equal(says("  WHAT IS 6 TIMES 7  "), "6 × 7 = 42");
  assert.equal(says("what’s 2^10"), "2^10 = 1,024", "a curly apostrophe is an apostrophe");
});

test("a division by zero is said so, not left to a model to improvise", () => {
  assert.equal(says("what is 5 / 0"), dividesByZero);
  assert.equal(says("divide 5 by 0"), dividesByZero);
});

test("a very large or very small answer is shown as approximate, not as digits it cannot hold", () => {
  assert.equal(says("what is 999999999999 * 999999999999"), "999,999,999,999 × 999,999,999,999 = 9.99999999998e+23");
  assert.equal(says("what is 123456789 * 1000"), "123,456,789 × 1,000 = 123,456,789,000");
  assert.equal(says("what is 1 / 10000000"), "1 ÷ 10,000,000 = 1e-7");
});

test("anything that is not purely a sum is left to the model", () => {
  for (const message of [
    "what is 5 plus 3 and tell me a joke",
    "write a function that adds 2 and 3",
    "what is 2 + 2 in binary",
    "I have 3 apples and 4 oranges, how many fruits do I have",
    "what comes next: 2, 6, 12, 20, 30, ?",
    "what is 5 miles in km",
    "what is 3:30 + 2:15",
    "remind me in 5 + 5 minutes",
    "text 555-010-0123 that I'm running 10 minutes late",
    "Solve for x: 3x + 7 = 31",
    "d/dx sin(x)",
    "what is the capital of France",
    "what is 12 +",
    "5 + 3 = 9",
    "what is 9 ^ 9 ^ 9",
    "what is 2x + 3",
    "2 3",
    "5 + 5\nand then something else"
  ]) {
    assert.equal(says(message), null, message);
  }
});

test("a sum needs something to do to two numbers, even when it is asked for", () => {
  // The evaluator would happily say 5 = 5.
  for (const message of ["what is 5", "calculate 5", "what is (5)", "what is -5", "work out 1,000"]) {
    assert.equal(says(message), null, message);
  }
});

test("only the signs the app can show back are accepted", () => {
  // The evaluator reads % as a remainder and any x as a times; shown back, a % would vanish and a stray x would be a guess.
  for (const message of ["what is 10 % 3", "what is 3x + 2x4", "what is 7 x"]) {
    assert.equal(says(message), null, message);
  }
});

test("a square root has to be of a number that has one", () => {
  assert.equal(says("square root of -4"), null);
  assert.equal(says("sqrt(-9)"), null);
  assert.equal(says("√0"), "√0 = 0");
});

test("a message over several lines is not read as one sum", () => {
  assert.equal(says("1 + 1\n+ 2 + 2"), null);
  assert.equal(says("what is 2 +\n2"), null);
});

test("a lone number, a list, a date, a score or a size is not a sum", () => {
  for (const message of [
    "5", "(5)", "-5", "2, 6, 12, 20, 30", "1,5 + 2", "what is 1,5 + 2",
    "2026-10-15", "what is 2026-10-15", "10/15/2026", "12-25-2026",
    "3-5", "4/5", "3x4", "555-010-0123", "1.2.3 + 4"
  ]) {
    assert.equal(says(message), null, message);
  }
});

test("asking for a calculation is what makes a bare minus, a slash or an x a sum", () => {
  assert.equal(says("what is 3-5"), "3 - 5 = -2");
  assert.equal(says("what is 12/25"), "12 ÷ 25 = 0.48");
  assert.equal(says("what is 3x4"), "3 × 4 = 12");
  assert.equal(says("10 - 3"), "10 - 3 = 7", "a spaced minus is plainly a subtraction");
});

test("an empty message, an over-long one, and no message at all", () => {
  assert.equal(says(""), null);
  assert.equal(says("   "), null);
  assert.equal(says(`what is ${"1 + ".repeat(100)}1`), null);
  assert.equal(answerArithmeticQuestion(undefined as unknown as string), null);
});
