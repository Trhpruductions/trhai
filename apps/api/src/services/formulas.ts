// A reader and calculator for spreadsheet formulas: what people put in a budget, a
// grade book, a tally. A spreadsheet file keeps the last answer of each formula
// beside it, so that a viewer which does not calculate (a phone's preview, a
// file explorer) still shows numbers; this works those answers out, and says
// when a formula cannot be read at all, so that a cell is never written that
// would make a spreadsheet program complain about the whole file.
//
// Written for the plain English form a spreadsheet file stores: commas between
// arguments, a dot for the decimal, no leading "=". What is not worked out here
// (a lookup, today's date) is still a good formula: it is kept as it is and the
// spreadsheet program works it out when the file is opened.

export type ErrorName = "#DIV/0!" | "#VALUE!" | "#REF!" | "#NAME?" | "#N/A" | "#NUM!";
export type FormulaError = { error: ErrorName };
export type Value = number | string | boolean | null | FormulaError;

export const isError = (value: unknown): value is FormulaError => typeof value === "object" && value !== null && "error" in value;
const fail = (error: ErrorName): FormulaError => ({ error });

export type Point = { column: number; row: number };
export type Node =
  | { kind: "number"; value: number }
  | { kind: "text"; value: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "ref"; sheet?: string; at: Point }
  | { kind: "range"; sheet?: string; from: Point; to: Point }
  | { kind: "unary"; op: "-" | "+"; operand: Node }
  | { kind: "percent"; operand: Node }
  | { kind: "binary"; op: string; left: Node; right: Node }
  | { kind: "call"; name: string; args: Node[] };

// ---------------------------------------------------------------- functions known

/** Worked out here. */
const calculated = new Set([
  "SUM", "AVERAGE", "MIN", "MAX", "COUNT", "COUNTA", "COUNTBLANK", "PRODUCT", "MEDIAN", "ROUND", "ROUNDUP", "ROUNDDOWN", "INT", "ABS", "SQRT",
  "POWER", "MOD", "IF", "IFERROR", "AND", "OR", "NOT", "CONCAT", "CONCATENATE", "LEN", "UPPER", "LOWER", "TRIM", "LEFT", "RIGHT",
  "SUMIF", "COUNTIF", "AVERAGEIF", "SUMPRODUCT", "ISNUMBER", "ISBLANK", "TRUE", "FALSE"
]);

/** Good formulas that the spreadsheet program works out when the file is opened. */
const leftToTheProgram = new Set([
  "TODAY", "NOW", "DATE", "YEAR", "MONTH", "DAY", "WEEKDAY", "EDATE", "EOMONTH", "DATEDIF", "NETWORKDAYS",
  "VLOOKUP", "HLOOKUP", "XLOOKUP", "INDEX", "MATCH", "TEXT", "VALUE", "STDEV", "STDEV.S", "STDEV.P", "VAR", "VAR.S", "VAR.P",
  "LARGE", "SMALL", "RANK", "CEILING", "FLOOR", "MAXIFS", "MINIFS", "SUMIFS", "COUNTIFS", "AVERAGEIFS", "IFS", "SWITCH", "IFNA",
  "PMT", "FV", "PV", "NPV", "IRR", "RATE", "NPER", "SUBSTITUTE", "FIND", "SEARCH", "REPLACE", "TEXTJOIN", "MID", "PROPER", "EXACT",
  "ROW", "COLUMN", "ROWS", "COLUMNS", "CHOOSE", "ISTEXT", "ISERROR", "ISNA", "N", "MAX", "SIGN", "LN", "LOG", "LOG10", "EXP", "PI", "RAND", "RANDBETWEEN",
  "TRUNC", "EVEN", "ODD", "GCD", "LCM", "FACT", "COMBIN", "AVERAGEA", "MINA", "MAXA", "MODE", "CORREL", "SLOPE", "INTERCEPT", "FORECAST"
]);

/** Never written: they reach out of the file, run something, or send what is in it somewhere. */
const refused = new Set(["WEBSERVICE", "FILTERXML", "HYPERLINK", "CALL", "REGISTER", "REGISTER.ID", "EXEC", "SHELL", "DDE", "RTD", "ENCODEURL", "IMPORTXML", "IMPORTDATA", "IMPORTHTML", "IMPORTRANGE"]);

export const knownFunction = (name: string): boolean => calculated.has(name) || leftToTheProgram.has(name);
export const refusedFunction = (name: string): boolean => refused.has(name);

// ---------------------------------------------------------------- columns and cells

/** "A" is 0, "Z" 25, "AA" 26. */
export function columnNumber(letters: string): number {
  let number = 0;
  for (const letter of letters.toUpperCase()) number = number * 26 + (letter.charCodeAt(0) - 64);
  return number - 1;
}

/** 0 is "A", 26 is "AA". */
export function columnLetters(column: number): string {
  let letters = "";
  for (let rest = column + 1; rest > 0; rest = Math.floor((rest - 1) / 26)) letters = String.fromCharCode(65 + ((rest - 1) % 26)) + letters;
  return letters;
}

export const cellName = (column: number, row: number): string => `${columnLetters(column)}${row + 1}`;

const refPattern = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/;

// ---------------------------------------------------------------- reading

type Token = { kind: "number" | "text" | "name" | "quoted" | "op"; text: string; at: number };

const operators = ["<>", "<=", ">=", "+", "-", "*", "/", "^", "&", "=", "<", ">", "%", "(", ")", ",", ":", "!"];

function tokenize(source: string): Token[] | string {
  const tokens: Token[] = [];
  let at = 0;
  while (at < source.length) {
    const char = source[at];
    if (/\s/.test(char)) { at += 1; continue; }
    if (/[0-9]/.test(char) || (char === "." && /[0-9]/.test(source[at + 1] ?? ""))) {
      const match = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(source.slice(at))!;
      tokens.push({ kind: "number", text: match[0], at });
      at += match[0].length;
      continue;
    }
    if (char === '"') {
      let text = "";
      let end = at + 1;
      for (;;) {
        if (end >= source.length) return "a piece of text in quotation marks is never closed";
        if (source[end] === '"') {
          if (source[end + 1] === '"') { text += '"'; end += 2; continue; }
          break;
        }
        text += source[end];
        end += 1;
      }
      tokens.push({ kind: "text", text, at });
      at = end + 1;
      continue;
    }
    if (char === "'") {
      const end = source.indexOf("'", at + 1);
      if (end < 0) return "a sheet name in quotes is never closed";
      tokens.push({ kind: "quoted", text: source.slice(at + 1, end).replace(/''/g, "'"), at });
      at = end + 1;
      continue;
    }
    const name = /^[A-Za-z_$][A-Za-z0-9_.$]*/.exec(source.slice(at));
    if (name) {
      tokens.push({ kind: "name", text: name[0], at });
      at += name[0].length;
      continue;
    }
    const operator = operators.find((candidate) => source.startsWith(candidate, at));
    if (operator) {
      tokens.push({ kind: "op", text: operator, at });
      at += operator.length;
      continue;
    }
    if (char === ";") return "arguments are separated by commas, not semicolons";
    return `"${char}" is not something a formula can hold`;
  }
  return tokens;
}

class Reader {
  position = 0;
  readonly functions = new Set<string>();
  constructor(readonly tokens: Token[]) {}

  peek(): Token | undefined { return this.tokens[this.position]; }
  next(): Token | undefined { const token = this.tokens[this.position]; this.position += 1; return token; }
  isOp(text: string): boolean { const token = this.peek(); return token?.kind === "op" && token.text === text; }
  accept(text: string): boolean { if (this.isOp(text)) { this.position += 1; return true; } return false; }
  expect(text: string): void { if (!this.accept(text)) throw new Error(`a "${text}" is missing`); }

  expression(): Node { return this.comparison(); }

  comparison(): Node {
    let left = this.concatenation();
    for (;;) {
      const token = this.peek();
      if (token?.kind === "op" && ["=", "<>", "<", ">", "<=", ">="].includes(token.text)) {
        this.position += 1;
        left = { kind: "binary", op: token.text, left, right: this.concatenation() };
      } else return left;
    }
  }

  concatenation(): Node {
    let left = this.sum();
    while (this.accept("&")) left = { kind: "binary", op: "&", left, right: this.sum() };
    return left;
  }

  sum(): Node {
    let left = this.product();
    for (;;) {
      if (this.accept("+")) left = { kind: "binary", op: "+", left, right: this.product() };
      else if (this.accept("-")) left = { kind: "binary", op: "-", left, right: this.product() };
      else return left;
    }
  }

  product(): Node {
    let left = this.power();
    for (;;) {
      if (this.accept("*")) left = { kind: "binary", op: "*", left, right: this.power() };
      else if (this.accept("/")) left = { kind: "binary", op: "/", left, right: this.power() };
      else return left;
    }
  }

  power(): Node {
    let left = this.unary();
    while (this.accept("^")) left = { kind: "binary", op: "^", left, right: this.unary() };
    return left;
  }

  // As in a spreadsheet program, a minus sign binds tighter than a power: -2^2 is 4.
  unary(): Node {
    if (this.accept("-")) return { kind: "unary", op: "-", operand: this.unary() };
    if (this.accept("+")) return { kind: "unary", op: "+", operand: this.unary() };
    return this.postfix();
  }

  postfix(): Node {
    let node = this.primary();
    while (this.accept("%")) node = { kind: "percent", operand: node };
    return node;
  }

  /** A cell, optionally after a sheet name and "!", and optionally the start of a range. */
  reference(sheet: string | undefined, text: string): Node | null {
    const cell = refPattern.exec(text);
    if (!cell) return null;
    const at: Point = { column: columnNumber(cell[1]), row: Number(cell[2]) - 1 };
    if (at.row < 0 || at.column > 16383) throw new Error(`${text} is not a cell`);
    if (this.isOp(":")) {
      const save = this.position;
      this.position += 1;
      const token = this.next();
      const end = token?.kind === "name" ? refPattern.exec(token.text) : null;
      if (!end) { this.position = save; throw new Error("a range needs a cell at each end"); }
      const to: Point = { column: columnNumber(end[1]), row: Number(end[2]) - 1 };
      return { kind: "range", sheet, from: { column: Math.min(at.column, to.column), row: Math.min(at.row, to.row) }, to: { column: Math.max(at.column, to.column), row: Math.max(at.row, to.row) } };
    }
    return { kind: "ref", sheet, at };
  }

  primary(): Node {
    const token = this.next();
    if (!token) throw new Error("the formula ends where something was expected");
    if (token.kind === "number") return { kind: "number", value: Number(token.text) };
    if (token.kind === "text") return { kind: "text", value: token.text };
    if (token.kind === "op") {
      if (token.text === "(") { const inner = this.expression(); this.expect(")"); return inner; }
      throw new Error(`a "${token.text}" is not expected here`);
    }
    // A sheet name, then "!" and a cell.
    if (token.kind === "quoted" || (token.kind === "name" && this.isOp("!"))) {
      if (!this.accept("!")) throw new Error("a sheet name must be followed by !");
      const cell = this.next();
      const node = cell?.kind === "name" ? this.reference(token.text, cell.text) : null;
      if (!node) throw new Error(`${token.text}! must be followed by a cell`);
      return node;
    }
    const upper = token.text.toUpperCase();
    if (this.isOp("(")) {
      this.position += 1;
      const args: Node[] = [];
      if (!this.accept(")")) {
        do {
          // An empty argument, as in IF(A1,,2), is a blank.
          if (this.isOp(",") || this.isOp(")")) args.push({ kind: "text", value: "" });
          else args.push(this.expression());
        } while (this.accept(","));
        this.expect(")");
      }
      this.functions.add(upper);
      return { kind: "call", name: upper, args };
    }
    if (upper === "TRUE" || upper === "FALSE") return { kind: "boolean", value: upper === "TRUE" };
    const reference = this.reference(undefined, token.text);
    if (reference) return reference;
    // A whole column: A:A.
    if (/^\$?[A-Za-z]{1,3}$/.test(token.text) && this.isOp(":")) {
      this.position += 1;
      const end = this.next();
      if (end?.kind === "name" && /^\$?[A-Za-z]{1,3}$/.test(end.text)) {
        const a = columnNumber(token.text.replace("$", "")), b = columnNumber(end.text.replace("$", ""));
        return { kind: "range", from: { column: Math.min(a, b), row: 0 }, to: { column: Math.max(a, b), row: Number.POSITIVE_INFINITY } };
      }
    }
    throw new Error(`"${token.text}" is not a cell, a number or a function`);
  }
}

export type Parsed = { ok: true; ast: Node; functions: string[] } | { ok: false; reason: string };

/** Read a formula as a file stores it (no leading "="), or say what is wrong with it. */
export function parseFormula(source: string): Parsed {
  const text = source.startsWith("=") ? source.slice(1) : source;
  if (!text.trim()) return { ok: false, reason: "there is nothing after the = sign" };
  if (text.length > 8000) return { ok: false, reason: "it is longer than a spreadsheet program takes" };
  const tokens = tokenize(text);
  if (typeof tokens === "string") return { ok: false, reason: tokens };
  const reader = new Reader(tokens);
  try {
    const ast = reader.expression();
    if (reader.peek()) throw new Error(`"${reader.peek()!.text}" is not expected there`);
    const unknown = [...reader.functions].filter((name) => !knownFunction(name));
    const dangerous = [...reader.functions].find((name) => refusedFunction(name));
    if (dangerous) return { ok: false, reason: `${dangerous} reaches outside the file, so it is not written` };
    if (unknown.length > 0) return { ok: false, reason: `${unknown[0]} is not a function I know` };
    return { ok: true, ast, functions: [...reader.functions] };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------- calculating

/** Where the cells' values come from. A cell that holds a formula answers with the formula's own answer. */
export type Resolver = {
  value(sheet: string | undefined, column: number, row: number): Value;
  /** How many columns and rows hold anything, for a whole-column range. */
  extent(sheet: string | undefined): { columns: number; rows: number };
  hasSheet(name: string): boolean;
};

/** A function the spreadsheet program works out and this does not. */
export class NotCalculated extends Error {}

type Argument = Value | Value[][];

const textOf = (value: Value): string => {
  if (value === null) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return String(value);
};

function numberOf(value: Value): number | FormulaError {
  if (isError(value)) return value;
  if (value === null) return 0;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value;
  const trimmed = value.trim();
  if (/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(trimmed)) return Number(trimmed);
  if (/^[-+]?(?:\d+\.?\d*|\.\d+)%$/.test(trimmed)) return Number(trimmed.slice(0, -1)) / 100;
  return fail("#VALUE!");
}

function booleanOf(value: Value): boolean | FormulaError {
  if (isError(value)) return value;
  if (typeof value === "boolean") return value;
  if (value === null) return false;
  if (typeof value === "number") return value !== 0;
  if (/^true$/i.test(value)) return true;
  if (/^false$/i.test(value)) return false;
  return fail("#VALUE!");
}

const isRange = (argument: Argument): argument is Value[][] => Array.isArray(argument);

/** The numbers in the arguments: in a range only numbers count; typed straight in, text that is a number counts too. */
function numbersIn(args: Argument[]): number[] | FormulaError {
  const out: number[] = [];
  for (const argument of args) {
    if (isRange(argument)) {
      for (const row of argument) for (const value of row) {
        if (isError(value)) return value;
        if (typeof value === "number") out.push(value);
      }
    } else {
      if (isError(argument)) return argument;
      if (argument === null) continue;
      const number = numberOf(argument);
      if (isError(number)) return number;
      out.push(number);
    }
  }
  return out;
}

const cellsIn = (argument: Argument): Value[] => (isRange(argument) ? argument.flat() : [argument]);

/** A criterion as COUNTIF reads it: ">5", "<=10", "<>x", "=x", or a bare value to be equal to. */
function criterionTest(criterion: Value): (value: Value) => boolean {
  const asText = textOf(criterion);
  const match = /^(<=|>=|<>|<|>|=)?(.*)$/s.exec(asText)!;
  const operator = typeof criterion === "number" ? "=" : match[1] ?? "=";
  const target = typeof criterion === "number" ? criterion : match[2];
  const targetNumber = typeof target === "number" ? target : target.trim() !== "" && !Number.isNaN(Number(target)) ? Number(target) : null;
  return (value) => {
    if (isError(value)) return false;
    if (targetNumber !== null) {
      const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value)) ? Number(value) : null;
      if (number === null) return operator === "<>";
      return operator === "=" ? number === targetNumber : operator === "<>" ? number !== targetNumber : operator === "<" ? number < targetNumber : operator === ">" ? number > targetNumber : operator === "<=" ? number <= targetNumber : number >= targetNumber;
    }
    const left = textOf(value).toLowerCase();
    const right = String(target).toLowerCase();
    if (operator === "=") return wildcard(right).test(left);
    if (operator === "<>") return !wildcard(right).test(left);
    return operator === "<" ? left < right : operator === ">" ? left > right : operator === "<=" ? left <= right : left >= right;
  };
}

const wildcard = (pattern: string): RegExp => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");

function compare(left: Value, right: Value): number {
  const rank = (value: Value) => (typeof value === "number" || value === null ? 0 : typeof value === "string" ? 1 : 2);
  const a = left === null ? (typeof right === "string" ? "" : 0) : left;
  const b = right === null ? (typeof left === "string" ? "" : 0) : right;
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return String(a).toLowerCase() < String(b).toLowerCase() ? -1 : String(a).toLowerCase() > String(b).toLowerCase() ? 1 : 0;
}

const roundTo = (value: number, digits: number, how: "round" | "up" | "down"): number => {
  const factor = 10 ** digits;
  const scaled = value * factor;
  const done = how === "round" ? Math.sign(scaled) * Math.round(Math.abs(scaled) + 1e-9) : how === "up" ? Math.sign(scaled) * Math.ceil(Math.abs(scaled) - 1e-9) : Math.sign(scaled) * Math.floor(Math.abs(scaled) + 1e-9);
  return done / factor;
};

function call(name: string, args: Argument[], lazy: Array<() => Argument>): Value {
  const scalar = (index: number): Value => {
    const argument = args[index];
    return isRange(argument) ? fail("#VALUE!") : argument;
  };
  const number = (index: number): number | FormulaError => numberOf(scalar(index));
  switch (name) {
    case "SUM": { const numbers = numbersIn(args); return isError(numbers) ? numbers : numbers.reduce((a, b) => a + b, 0); }
    case "PRODUCT": { const numbers = numbersIn(args); return isError(numbers) ? numbers : numbers.reduce((a, b) => a * b, 1); }
    case "AVERAGE": { const numbers = numbersIn(args); return isError(numbers) ? numbers : numbers.length === 0 ? fail("#DIV/0!") : numbers.reduce((a, b) => a + b, 0) / numbers.length; }
    case "MIN": { const numbers = numbersIn(args); return isError(numbers) ? numbers : numbers.length === 0 ? 0 : Math.min(...numbers); }
    case "MAX": { const numbers = numbersIn(args); return isError(numbers) ? numbers : numbers.length === 0 ? 0 : Math.max(...numbers); }
    case "MEDIAN": {
      const numbers = numbersIn(args);
      if (isError(numbers)) return numbers;
      if (numbers.length === 0) return fail("#NUM!");
      const sorted = [...numbers].sort((a, b) => a - b);
      const middle = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    }
    case "COUNT": { let count = 0; for (const argument of args) for (const value of cellsIn(argument)) if (typeof value === "number" || (!isRange(argument) && typeof value === "string" && !isError(numberOf(value)))) count += 1; return count; }
    case "COUNTA": { let count = 0; for (const argument of args) for (const value of cellsIn(argument)) if (value !== null && value !== "") count += 1; return count; }
    case "COUNTBLANK": { let count = 0; for (const argument of args) for (const value of cellsIn(argument)) if (value === null || value === "") count += 1; return count; }
    case "ROUND": case "ROUNDUP": case "ROUNDDOWN": {
      const value = number(0);
      const digits = args.length > 1 ? number(1) : 0;
      if (isError(value)) return value;
      if (isError(digits)) return digits;
      return roundTo(value, Math.trunc(digits), name === "ROUND" ? "round" : name === "ROUNDUP" ? "up" : "down");
    }
    case "INT": { const value = number(0); return isError(value) ? value : Math.floor(value); }
    case "ABS": { const value = number(0); return isError(value) ? value : Math.abs(value); }
    case "SQRT": { const value = number(0); return isError(value) ? value : value < 0 ? fail("#NUM!") : Math.sqrt(value); }
    case "POWER": { const base = number(0), exponent = number(1); if (isError(base)) return base; if (isError(exponent)) return exponent; const result = base ** exponent; return Number.isFinite(result) ? result : fail("#NUM!"); }
    case "MOD": {
      const value = number(0), divisor = number(1);
      if (isError(value)) return value;
      if (isError(divisor)) return divisor;
      return divisor === 0 ? fail("#DIV/0!") : value - divisor * Math.floor(value / divisor);
    }
    case "IF": {
      const test = booleanOf(lazy[0]() as Value);
      if (isError(test)) return test;
      if (test) return lazy.length > 1 ? (lazy[1]() as Value) : true;
      return lazy.length > 2 ? (lazy[2]() as Value) : false;
    }
    case "IFERROR": { const value = lazy[0]() as Value; return isError(value) ? (lazy[1]() as Value) : value; }
    case "AND": case "OR": {
      const flags: boolean[] = [];
      for (const argument of args) for (const value of cellsIn(argument)) {
        if (value === null || (isRange(argument) && typeof value === "string")) continue;
        const flag = booleanOf(value);
        if (isError(flag)) return flag;
        flags.push(flag);
      }
      if (flags.length === 0) return fail("#VALUE!");
      return name === "AND" ? flags.every(Boolean) : flags.some(Boolean);
    }
    case "NOT": { const flag = booleanOf(scalar(0)); return isError(flag) ? flag : !flag; }
    case "TRUE": return true;
    case "FALSE": return false;
    case "CONCAT": case "CONCATENATE": { let out = ""; for (const argument of args) for (const value of cellsIn(argument)) { if (isError(value)) return value; out += textOf(value); } return out; }
    case "LEN": { const value = scalar(0); return isError(value) ? value : textOf(value).length; }
    case "UPPER": { const value = scalar(0); return isError(value) ? value : textOf(value).toUpperCase(); }
    case "LOWER": { const value = scalar(0); return isError(value) ? value : textOf(value).toLowerCase(); }
    case "TRIM": { const value = scalar(0); return isError(value) ? value : textOf(value).trim().replace(/ +/g, " "); }
    case "LEFT": case "RIGHT": {
      const value = scalar(0);
      const count = args.length > 1 ? number(1) : 1;
      if (isError(value)) return value;
      if (isError(count)) return count;
      if (count < 0) return fail("#VALUE!");
      const text = textOf(value);
      return name === "LEFT" ? text.slice(0, Math.trunc(count)) : Math.trunc(count) === 0 ? "" : text.slice(-Math.trunc(count));
    }
    case "ISNUMBER": return typeof scalar(0) === "number";
    case "ISBLANK": return scalar(0) === null;
    case "SUMIF": case "COUNTIF": case "AVERAGEIF": {
      const range = args[0];
      const criterion = scalar(1);
      if (!isRange(range)) return fail("#VALUE!");
      const test = criterionTest(criterion);
      const summed = name === "COUNTIF" ? range : args.length > 2 ? args[2] : range;
      if (!isRange(summed)) return fail("#VALUE!");
      const matches = range.flat();
      const sums = summed.flat();
      let total = 0;
      let count = 0;
      matches.forEach((value, index) => {
        if (!test(value)) return;
        count += 1;
        const picked = sums[index];
        if (typeof picked === "number") total += picked;
      });
      return name === "COUNTIF" ? count : name === "SUMIF" ? total : count === 0 ? fail("#DIV/0!") : total / count;
    }
    case "SUMPRODUCT": {
      const lists = args.map((argument) => cellsIn(argument));
      if (lists.length === 0 || lists.some((list) => list.length !== lists[0].length)) return fail("#VALUE!");
      let total = 0;
      for (let index = 0; index < lists[0].length; index += 1) {
        let product = 1;
        for (const list of lists) { const value = list[index]; if (isError(value)) return value; product *= typeof value === "number" ? value : 0; }
        total += product;
      }
      return total;
    }
    default: throw new NotCalculated(name);
  }
}

/** Work out a formula. Throws NotCalculated when it uses a function this does not work out. */
export function evaluate(node: Node, resolver: Resolver, sheet: string | undefined): Value {
  const resolve = (candidate: Node): Argument => {
    switch (candidate.kind) {
      case "number": case "text": case "boolean": return candidate.value;
      case "ref": {
        const where = candidate.sheet ?? sheet;
        if (candidate.sheet !== undefined && !resolver.hasSheet(candidate.sheet)) return fail("#REF!");
        return resolver.value(where, candidate.at.column, candidate.at.row);
      }
      case "range": {
        const where = candidate.sheet ?? sheet;
        if (candidate.sheet !== undefined && !resolver.hasSheet(candidate.sheet)) return fail("#REF!");
        const extent = resolver.extent(where);
        const lastRow = Math.min(candidate.to.row, Math.max(0, extent.rows - 1));
        const rows: Value[][] = [];
        for (let row = candidate.from.row; row <= lastRow; row += 1) {
          const cells: Value[] = [];
          for (let column = candidate.from.column; column <= candidate.to.column; column += 1) cells.push(resolver.value(where, column, row));
          rows.push(cells);
        }
        return rows;
      }
      case "unary": {
        const operand = scalarOf(resolve(candidate.operand));
        const value = numberOf(operand);
        return isError(value) ? value : candidate.op === "-" ? -value : value;
      }
      case "percent": {
        const value = numberOf(scalarOf(resolve(candidate.operand)));
        return isError(value) ? value : value / 100;
      }
      case "binary": {
        const left = scalarOf(resolve(candidate.left));
        const right = scalarOf(resolve(candidate.right));
        if (isError(left)) return left;
        if (isError(right)) return right;
        if (candidate.op === "&") return textOf(left) + textOf(right);
        if (["=", "<>", "<", ">", "<=", ">="].includes(candidate.op)) {
          const order = compare(left, right);
          return candidate.op === "=" ? order === 0 : candidate.op === "<>" ? order !== 0 : candidate.op === "<" ? order < 0 : candidate.op === ">" ? order > 0 : candidate.op === "<=" ? order <= 0 : order >= 0;
        }
        const a = numberOf(left), b = numberOf(right);
        if (isError(a)) return a;
        if (isError(b)) return b;
        switch (candidate.op) {
          case "+": return a + b;
          case "-": return a - b;
          case "*": return a * b;
          case "/": return b === 0 ? fail("#DIV/0!") : a / b;
          default: { const result = a ** b; return Number.isFinite(result) ? result : fail("#NUM!"); }
        }
      }
      case "call": {
        // IF and IFERROR work out only the argument they use.
        const lazy = candidate.args.map((argument) => () => resolve(argument));
        const args = candidate.name === "IF" || candidate.name === "IFERROR" ? [] : candidate.args.map(resolve);
        return call(candidate.name, args, lazy);
      }
    }
  };
  const scalarOf = (argument: Argument): Value => (isRange(argument) ? (argument.length === 1 && argument[0].length === 1 ? argument[0][0] : fail("#VALUE!")) : argument);
  const answer = resolve(node);
  return isRange(answer) ? scalarOf(answer) : answer;
}
