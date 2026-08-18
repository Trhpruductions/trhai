// A calculator for the assistant.
//
// Language models are unreliable at arithmetic — they produce a plausible
// number rather than the right one, and a wrong figure delivered confidently is
// worse than a refusal. This gives the model something it can hand a sum to.
//
// Deliberately not eval(). The input is a string a model produced, and eval on
// model output is arbitrary code execution in the API process; no amount of
// pre-filtering makes that safe enough to be worth it. This is a small
// recursive-descent parser that understands arithmetic and nothing else, so
// there is no code path for anything but numbers to be evaluated.

export type ArithmeticResult =
  | { ok: true; value: number }
  | { ok: false; reason: string };

type Token =
  | { kind: "number"; value: number }
  | { kind: "operator"; value: "+" | "-" | "*" | "/" | "%" | "^" }
  | { kind: "paren"; value: "(" | ")" };

/** Anything not in here is rejected rather than ignored. */
function tokenize(input: string): Token[] | null {
  const tokens: Token[] = [];
  let index = 0;

  while (index < input.length) {
    const character = input[index];

    if (/\s/.test(character)) {
      index += 1;
      continue;
    }

    // Thousands separators are how people write numbers, and dropping them
    // silently would turn 1,500 into two expressions rather than one number.
    if (character === ",") {
      index += 1;
      continue;
    }

    if (/[0-9.]/.test(character)) {
      let literal = "";
      while (index < input.length && /[0-9.,]/.test(input[index])) {
        if (input[index] !== ",") literal += input[index];
        index += 1;
      }

      const value = Number(literal);
      if (!Number.isFinite(value)) return null;
      tokens.push({ kind: "number", value });
      continue;
    }

    if (character === "(" || character === ")") {
      tokens.push({ kind: "paren", value: character });
      index += 1;
      continue;
    }

    // Written forms a model is likely to emit.
    if (character === "x" || character === "×") {
      tokens.push({ kind: "operator", value: "*" });
      index += 1;
      continue;
    }
    if (character === "÷") {
      tokens.push({ kind: "operator", value: "/" });
      index += 1;
      continue;
    }

    if ("+-*/%^".includes(character)) {
      tokens.push({ kind: "operator", value: character as "+" });
      index += 1;
      continue;
    }

    // An unrecognised character means this is not arithmetic. Refusing is the
    // honest outcome; guessing at what was meant produces a confident wrong sum.
    return null;
  }

  return tokens;
}

/**
 * expression := term (("+" | "-") term)*
 * term       := power (("*" | "/" | "%") power)*
 * power      := unary ("^" power)?          -- right associative
 * unary      := "-" unary | primary
 * primary    := number | "(" expression ")"
 */
function parse(tokens: Token[]): ArithmeticResult {
  let position = 0;

  const peek = (): Token | undefined => tokens[position];

  function expression(): number {
    let left = term();

    while (true) {
      const token = peek();
      if (token?.kind !== "operator" || (token.value !== "+" && token.value !== "-")) break;
      position += 1;
      const right = term();
      left = token.value === "+" ? left + right : left - right;
    }

    return left;
  }

  function term(): number {
    let left = power();

    while (true) {
      const token = peek();
      if (token?.kind !== "operator") break;
      if (token.value !== "*" && token.value !== "/" && token.value !== "%") break;
      position += 1;
      const right = power();

      if ((token.value === "/" || token.value === "%") && right === 0) {
        // Thrown rather than returned so it unwinds the whole parse; JavaScript
        // would otherwise hand back Infinity or NaN and call it an answer.
        throw new RangeError("division by zero");
      }

      if (token.value === "*") left *= right;
      else if (token.value === "/") left /= right;
      else left %= right;
    }

    return left;
  }

  function power(): number {
    const base = unary();
    const token = peek();
    if (token?.kind === "operator" && token.value === "^") {
      position += 1;
      // Right associative: 2^3^2 is 2^(3^2), which is how it is written on paper.
      return base ** power();
    }
    return base;
  }

  function unary(): number {
    const token = peek();
    if (token?.kind === "operator" && token.value === "-") {
      position += 1;
      return -unary();
    }
    if (token?.kind === "operator" && token.value === "+") {
      position += 1;
      return unary();
    }
    return primary();
  }

  function primary(): number {
    const token = peek();
    if (!token) throw new SyntaxError("the expression ends early");

    if (token.kind === "number") {
      position += 1;
      return token.value;
    }

    if (token.kind === "paren" && token.value === "(") {
      position += 1;
      const value = expression();
      const closing = peek();
      if (closing?.kind !== "paren" || closing.value !== ")") {
        throw new SyntaxError("a bracket is not closed");
      }
      position += 1;
      return value;
    }

    throw new SyntaxError("that is not a number");
  }

  try {
    const value = expression();

    // Trailing tokens mean the input was not one expression — "2 + 2 4" must
    // not quietly evaluate to 4.
    if (position !== tokens.length) {
      return { ok: false, reason: "That is not a single expression." };
    }

    if (!Number.isFinite(value)) {
      return { ok: false, reason: "That does not have a finite answer." };
    }

    return { ok: true, value };
  } catch (error) {
    const reason = error instanceof RangeError
      ? "That divides by zero."
      : `That is not valid arithmetic: ${error instanceof Error ? error.message : "it could not be read"}.`;
    return { ok: false, reason };
  }
}

export function evaluateArithmetic(input: string): ArithmeticResult {
  const trimmed = typeof input === "string" ? input.trim() : "";
  if (!trimmed) return { ok: false, reason: "There is no expression to work out." };

  // A bound on input length, since this runs on text a model produced and a
  // pathological expression should be refused rather than parsed.
  if (trimmed.length > 500) {
    return { ok: false, reason: "That expression is too long to work out." };
  }

  const tokens = tokenize(trimmed);
  if (!tokens) {
    return { ok: false, reason: "That contains something that is not arithmetic." };
  }
  if (tokens.length === 0) {
    return { ok: false, reason: "There is no expression to work out." };
  }

  return parse(tokens);
}

/** Trims floating-point noise: 0.1 + 0.2 should read as 0.3, not 0.30000000000000004. */
export function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toPrecision(12)));
}
