// A sum, worked out here and not by the model.
//
// "What is 487 times 263?" went to the model, which had to call the calculate
// tool and then say what came back. On a PC with no graphics card that took
// 377 seconds the first time it was timed and 531 the next. On any PC, a model
// that skips the tool does the sum itself and gets it wrong. The evaluator the
// tool uses (arithmetic.ts) is exact and instant; all that was missing was
// something to read the sum out of the message, so that the model is not
// needed to hand it over.
//
// Only a message that is a sum and nothing else is answered here, the way
// unitConversion.ts does it. "what is 5 plus 3 and tell me a joke" goes to the
// model whole, and so does anything with a unit, a date, a variable or a word
// the sum does not use ("what is 2 + 2 in binary"). A comma that is not a
// thousands separator is refused rather than dropped, so a list of numbers
// ("2, 6, 12, 20") is never read as one number.

import { evaluateArithmetic } from "./arithmetic.js";

type Sum = { shown: string; value: number };

/** One number as written: optional sign, commas only as thousands separators, optional decimals. */
const num = String.raw`(?:-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|-?\.\d+)`;

/** Dates and the like, which look like a sum to anything that only counts operators. */
const dateLike = /\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b\d{1,2}-\d{1,2}-\d{2,4}\b/;

/**
 * What can come before the sum. Group 1 holds the asking words ("what is",
 * "calculate", "tell me"), which are what make a bare "10-3" worth answering.
 */
const lead = /^(?:(?:please|pls|hey|hi|ok|okay|so|and|just)[ ,]+)*(?:(?:can|could|would|will) you (?:please )?)?((?:(?:tell me|work out|figure out|solve|calculate|compute|evaluate|find|give me)(?: for me)?[: ]+|(?:what(?:'s| is| are)|whats|how much (?:is|are))[: ]+)*)/;

export const dividesByZero = "That divides by zero, so it has no answer.";

function parseNumber(raw: string): number {
  return Number(raw.replace(/,/g, ""));
}

/** A number as it is read back: grouped, and without the noise a division leaves. */
function showNumber(value: number): string {
  if (Object.is(value, -0)) return "0";
  if (Number.isInteger(value)) return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
  return Number(value.toPrecision(12)).toLocaleString("en-US", { maximumFractionDigits: 12 });
}

/** The answer. Exact for whole numbers below 1e15, ten significant figures beyond that, and plainly approximate past it. */
function resultText(value: number): string {
  if (Object.is(value, -0)) return "0";
  const magnitude = Math.abs(value);
  if (magnitude >= 1e15 || (magnitude > 0 && magnitude < 1e-6)) return String(Number(value.toPrecision(12)));
  if (Number.isInteger(value)) return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
  return Number(value.toPrecision(10)).toLocaleString("en-US", { maximumFractionDigits: 10 });
}

/** The sum as it is shown back: spaced, with the signs people read ("×", "÷"). */
function pretty(expression: string): string {
  const tokens = expression.match(/\d[\d,]*(?:\.\d+)?|\.\d+|[-+*/^()]/g) ?? [];
  let out = "";
  let before: "start" | "number" | "operator" | "open" | "close" = "start";
  for (const token of tokens) {
    if (/^[\d.]/.test(token)) {
      out += showNumber(parseNumber(token));
      before = "number";
    } else if (token === "(") {
      out += "(";
      before = "open";
    } else if (token === ")") {
      out += ")";
      before = "close";
    } else if ((token === "-" || token === "+") && (before === "start" || before === "operator" || before === "open")) {
      // A sign, not an operation: -5, or the second minus in 5 - -3.
      if (token === "-") out += "-";
      before = "operator";
    } else if (token === "^") {
      out += "^";
      before = "operator";
    } else {
      out += ` ${token === "*" ? "×" : token === "/" ? "÷" : token} `;
      before = "operator";
    }
  }
  return out.replace(/\s+/g, " ").trim();
}

type Form = { pattern: RegExp; make: (captured: string[]) => Sum | "zero" | null };

const both = (captured: string[]): [number, number] => [parseNumber(captured[0] ?? ""), parseNumber(captured[1] ?? "")];
const added = (captured: string[]): Sum => {
  const [a, b] = both(captured);
  return { shown: `${showNumber(a)} + ${showNumber(b)}`, value: a + b };
};
const multiplied = (captured: string[]): Sum => {
  const [a, b] = both(captured);
  return { shown: `${showNumber(a)} × ${showNumber(b)}`, value: a * b };
};
const rooted = (captured: string[]): Sum | null => {
  const a = parseNumber(captured[0] ?? "");
  return a >= 0 ? { shown: `√${showNumber(a)}`, value: Math.sqrt(a) } : null;
};

/** The sums people write in words, which are not one expression to hand to the evaluator. */
const forms: Form[] = [
  { pattern: new RegExp(String.raw`^(?:the )?sum of (${num}) and (${num})$`), make: added },
  { pattern: new RegExp(String.raw`^add (${num}) (?:and|to|plus) (${num})$`), make: added },
  { pattern: new RegExp(String.raw`^(?:the )?product of (${num}) and (${num})$`), make: multiplied },
  { pattern: new RegExp(String.raw`^multiply (${num}) (?:by|and|with|times) (${num})$`), make: multiplied },
  {
    pattern: new RegExp(String.raw`^subtract (${num}) from (${num})$`),
    make: (captured) => {
      const [a, b] = both(captured);
      return { shown: `${showNumber(b)} - ${showNumber(a)}`, value: b - a };
    }
  },
  {
    pattern: new RegExp(String.raw`^divide (${num}) by (${num})$`),
    make: (captured) => {
      const [a, b] = both(captured);
      return b === 0 ? "zero" : { shown: `${showNumber(a)} ÷ ${showNumber(b)}`, value: a / b };
    }
  },
  {
    pattern: new RegExp(String.raw`^(${num}) ?(?:%|percent|per cent) of (${num})$`),
    make: (captured) => {
      const [a, b] = both(captured);
      return { shown: `${showNumber(a)}% of ${showNumber(b)}`, value: (a * b) / 100 };
    }
  },
  { pattern: new RegExp(String.raw`^(?:the )?square root of (${num})$`), make: rooted },
  { pattern: new RegExp(String.raw`^sqrt ?\(? ?(${num}) ?\)?$`), make: rooted },
  { pattern: new RegExp(String.raw`^√ ?(${num})$`), make: rooted },
  {
    pattern: new RegExp(String.raw`^(${num}) (squared|cubed)$`),
    make: (captured) => {
      const a = parseNumber(captured[0] ?? "");
      const cubed = captured[1] === "cubed";
      return { shown: `${showNumber(a)}${cubed ? "³" : "²"}`, value: cubed ? a ** 3 : a ** 2 };
    }
  },
  {
    pattern: new RegExp(String.raw`^(?:the )?(square|cube) of (${num})$`),
    make: (captured) => {
      const a = parseNumber(captured[1] ?? "");
      const cubed = captured[0] === "cube";
      return { shown: `${showNumber(a)}${cubed ? "³" : "²"}`, value: cubed ? a ** 3 : a ** 2 };
    }
  }
];

function readWords(body: string): Sum | "zero" | null {
  for (const form of forms) {
    const match = form.pattern.exec(body);
    if (match) return form.make(match.slice(1));
  }
  return null;
}

/** "487 times 263", "12.5 * 3 + 7", "(2 + 3) x 4", "2 to the power of 10": one expression of numbers and operators. */
function readInfix(body: string, asked: boolean): Sum | "zero" | null {
  const infix = body
    .replace(/\bmultiplied by\b|\btimes\b/g, "*")
    .replace(/\bdivided by\b/g, "/")
    .replace(/\bto the power of\b/g, "^")
    .replace(/\bplus\b/g, "+")
    .replace(/\bminus\b/g, "-")
    .replace(/÷/g, "/")
    // "3 x 4" and "3 × 4" are a product. "3x4" alone is as likely a size, so it only is one when a calculation was asked for.
    .replace(/(?<=[\d)]) [x×] (?=[\d(.])/g, " * ")
    .replace(asked ? /(?<=[\d)])[x×](?=[\d(.])/g : /(?<=[\d)])×(?=[\d(.])/g, " * ")
    .replace(/\s+/g, " ")
    .trim();
  if (!/^[\d\s.,+\-*/^()]+$/.test(infix)) return null;

  // A comma that does not separate thousands is a list, or a decimal comma. Neither is a number to add up.
  for (const run of infix.match(/\d[\d,]*/g) ?? []) {
    if (run.includes(",") && !/^\d{1,3}(?:,\d{3})+$/.test(run)) return null;
  }

  // Something has to be done to two things.
  if (!/[\d)]\s*[-+*/^]\s*[-+(\d.]/.test(infix)) return null;
  // With no asking words, only what is plainly a sum: a "10-3" or "4/5" alone is as likely a range, a score or a date.
  if (!asked && !/[+*^]/.test(infix) && !/\d\s+[-/]\s+[-(\d.]/.test(infix)) return null;

  const result = evaluateArithmetic(infix);
  if (!result.ok) return /divides by zero/i.test(result.reason) ? "zero" : null;
  return { shown: pretty(infix), value: result.value };
}

/**
 * The answer to a message that is a sum and nothing else, or null when it is
 * anything more or less than that. "487 × 263 = 128,081", "15% of 80 = 12",
 * "√144 = 12"; a division by zero is said so.
 */
export function answerArithmeticQuestion(message: string): string | null {
  const raw = (message ?? "").replace(/\u2019/g, "'").trim();
  if (!raw || raw.length > 200 || /[\r\n]/.test(raw)) return null;

  const text = raw.toLowerCase()
    .replace(/[\u2212\u2013]/g, "-")
    .replace(/\*\*/g, "^")
    .replace(/\s+/g, " ")
    .replace(/[?!.\s]+$/, "")
    .replace(/\s*=$/, "")
    .trim();

  const head = lead.exec(text);
  const asked = Boolean(head && head[1]);
  const body = text.slice(head ? head[0].length : 0).trim();
  if (!body || !/\d/.test(body) || dateLike.test(body)) return null;

  const sum = readWords(body) ?? readInfix(body, asked);
  if (sum === null) return null;
  if (sum === "zero") return dividesByZero;
  return `${sum.shown} = ${resultText(sum.value)}`;
}
