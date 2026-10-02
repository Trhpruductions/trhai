// Unit conversions, worked out exactly and off the model.
//
// "convert 5 miles to kilometers" went to qwen2.5-coder:7b, and over a handful
// of live runs came back right with working, as a bare "8.0467", as "20°C" for
// 70°F (it is 21.11), as the formula with no result, and once as "The result
// of 12.5 * 3 + 7 is 44.5" - the example expression from the calculator's own
// description. A conversion is a table lookup and one multiplication. Nothing
// about it needs a model, and every wrong answer came from asking one.
//
// Only a message that is a conversion and nothing else is answered here, so
// "convert 5 miles to km and tell me a joke" still goes to the model whole.

type Kind = "length" | "mass" | "volume" | "speed" | "time" | "temperature";

type Unit = {
  kind: Kind;
  singular: string;
  plural: string;
  /** How many of the kind's base unit one of these is. Unused for temperature. */
  factor: number;
  names: string[];
};

const units: Unit[] = [
  // Length, in metres.
  { kind: "length", singular: "millimeter", plural: "millimeters", factor: 0.001, names: ["mm", "millimeter", "millimeters", "millimetre", "millimetres"] },
  { kind: "length", singular: "centimeter", plural: "centimeters", factor: 0.01, names: ["cm", "centimeter", "centimeters", "centimetre", "centimetres"] },
  { kind: "length", singular: "meter", plural: "meters", factor: 1, names: ["m", "meter", "meters", "metre", "metres"] },
  { kind: "length", singular: "kilometer", plural: "kilometers", factor: 1000, names: ["km", "kms", "kilometer", "kilometers", "kilometre", "kilometres"] },
  { kind: "length", singular: "inch", plural: "inches", factor: 0.0254, names: ["in", "inch", "inches", "\""] },
  { kind: "length", singular: "foot", plural: "feet", factor: 0.3048, names: ["ft", "foot", "feet", "'"] },
  { kind: "length", singular: "yard", plural: "yards", factor: 0.9144, names: ["yd", "yds", "yard", "yards"] },
  { kind: "length", singular: "mile", plural: "miles", factor: 1609.344, names: ["mi", "mile", "miles"] },
  { kind: "length", singular: "nautical mile", plural: "nautical miles", factor: 1852, names: ["nmi", "nautical mile", "nautical miles"] },
  // Mass, in kilograms.
  { kind: "mass", singular: "milligram", plural: "milligrams", factor: 1e-6, names: ["mg", "milligram", "milligrams"] },
  { kind: "mass", singular: "gram", plural: "grams", factor: 0.001, names: ["g", "gram", "grams", "gramme", "grammes"] },
  { kind: "mass", singular: "kilogram", plural: "kilograms", factor: 1, names: ["kg", "kgs", "kilo", "kilos", "kilogram", "kilograms"] },
  { kind: "mass", singular: "tonne", plural: "tonnes", factor: 1000, names: ["tonne", "tonnes", "metric ton", "metric tons"] },
  { kind: "mass", singular: "ounce", plural: "ounces", factor: 0.028349523125, names: ["oz", "ounce", "ounces"] },
  { kind: "mass", singular: "pound", plural: "pounds", factor: 0.45359237, names: ["lb", "lbs", "pound", "pounds"] },
  { kind: "mass", singular: "stone", plural: "stone", factor: 6.35029318, names: ["st", "stone", "stones"] },
  // Volume, in litres. US customary measures.
  { kind: "volume", singular: "milliliter", plural: "milliliters", factor: 0.001, names: ["ml", "milliliter", "milliliters", "millilitre", "millilitres"] },
  { kind: "volume", singular: "liter", plural: "liters", factor: 1, names: ["l", "liter", "liters", "litre", "litres"] },
  { kind: "volume", singular: "teaspoon", plural: "teaspoons", factor: 0.00492892159375, names: ["tsp", "teaspoon", "teaspoons"] },
  { kind: "volume", singular: "tablespoon", plural: "tablespoons", factor: 0.01478676478125, names: ["tbsp", "tablespoon", "tablespoons"] },
  { kind: "volume", singular: "fluid ounce", plural: "fluid ounces", factor: 0.0295735295625, names: ["fl oz", "floz", "fluid ounce", "fluid ounces"] },
  { kind: "volume", singular: "cup", plural: "cups", factor: 0.2365882365, names: ["cup", "cups"] },
  { kind: "volume", singular: "pint", plural: "pints", factor: 0.473176473, names: ["pt", "pint", "pints"] },
  { kind: "volume", singular: "quart", plural: "quarts", factor: 0.946352946, names: ["qt", "quart", "quarts"] },
  { kind: "volume", singular: "gallon", plural: "gallons", factor: 3.785411784, names: ["gal", "gallon", "gallons"] },
  // Speed, in metres per second.
  { kind: "speed", singular: "meter per second", plural: "meters per second", factor: 1, names: ["m/s", "mps", "meter per second", "meters per second", "metres per second"] },
  { kind: "speed", singular: "kilometer per hour", plural: "kilometers per hour", factor: 1 / 3.6, names: ["km/h", "kmh", "kph", "kilometer per hour", "kilometers per hour", "kilometres per hour"] },
  { kind: "speed", singular: "mile per hour", plural: "miles per hour", factor: 0.44704, names: ["mph", "mile per hour", "miles per hour"] },
  { kind: "speed", singular: "knot", plural: "knots", factor: 1852 / 3600, names: ["knot", "knots", "kn", "kt"] },
  // Time, in seconds.
  { kind: "time", singular: "millisecond", plural: "milliseconds", factor: 0.001, names: ["ms", "millisecond", "milliseconds"] },
  { kind: "time", singular: "second", plural: "seconds", factor: 1, names: ["s", "sec", "secs", "second", "seconds"] },
  { kind: "time", singular: "minute", plural: "minutes", factor: 60, names: ["min", "mins", "minute", "minutes"] },
  { kind: "time", singular: "hour", plural: "hours", factor: 3600, names: ["h", "hr", "hrs", "hour", "hours"] },
  { kind: "time", singular: "day", plural: "days", factor: 86400, names: ["day", "days"] },
  { kind: "time", singular: "week", plural: "weeks", factor: 604800, names: ["week", "weeks"] },
  // Temperature: converted through Celsius, not by a factor.
  { kind: "temperature", singular: "°C", plural: "°C", factor: 0, names: ["c", "°c", "celsius", "centigrade", "degrees celsius", "degrees c", "degree celsius"] },
  { kind: "temperature", singular: "°F", plural: "°F", factor: 0, names: ["f", "°f", "fahrenheit", "degrees fahrenheit", "degrees f", "degree fahrenheit"] },
  { kind: "temperature", singular: "K", plural: "K", factor: 0, names: ["k", "kelvin", "kelvins"] }
];

const byName = new Map<string, Unit>();
for (const unit of units) for (const name of unit.names) byName.set(name, unit);

function unitNamed(raw: string): Unit | null {
  const name = raw.trim().replace(/\s+/g, " ").replace(/^(?:a|an|one)\s+/, "");
  return byName.get(name) ?? null;
}

function parseAmount(raw: string): number | null {
  const text = raw.trim();
  if (/^(?:a|an|one)$/.test(text)) return 1;
  if (!/^-?\d[\d,]*(?:\.\d+)?$|^-?\.\d+$/.test(text)) return null;
  const value = Number(text.replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

function toCelsius(value: number, from: Unit): number {
  if (from.singular === "°F") return (value - 32) * 5 / 9;
  if (from.singular === "K") return value - 273.15;
  return value;
}

function fromCelsius(value: number, to: Unit): number {
  if (to.singular === "°F") return value * 9 / 5 + 32;
  if (to.singular === "K") return value + 273.15;
  return value;
}

/** Four significant figures for small values, two decimals for large ones, thousands separated. */
function formatAmount(value: number): string {
  const rounded = Math.abs(value) >= 100 ? Math.round(value * 100) / 100 : Number(value.toPrecision(4));
  return rounded.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

function describe(value: string, unit: Unit): string {
  if (unit.kind === "temperature") return `${value}${unit.singular === "K" ? " K" : unit.singular}`;
  return `${value} ${value === "1" ? unit.singular : unit.plural}`;
}

export type Conversion = { amount: number; from: Unit; to: Unit; result: number; text: string };

/**
 * The conversion a message asks for, worked out, or null when the message is
 * not purely a conversion between two known units of the same kind.
 */
export function convertUnits(message: string): Conversion | null {
  const text = (message ?? "").trim().toLowerCase()
    .replace(/[?.!]+$/, "").replace(/\s+/g, " ").trim();
  if (!text) return null;

  const unit = "([a-z°\"'/ ]+?)";
  const amount = "(-?[\\d,]*\\.?\\d+|an?|one)";
  const patterns: Array<{ pattern: RegExp; order: "amount-from-to" | "to-amount-from" }> = [
    // "convert 5 miles to km", "change 70f into c", "5 miles in km", "what is 5 miles in km"
    {
      pattern: new RegExp(`^(?:please )?(?:(?:convert|change|turn)|what(?:'s| is)|whats|how much is)? ?${amount} ?${unit} (?:to|into|in|as) ${unit}$`),
      order: "amount-from-to"
    },
    // "how many feet in a mile", "how many kilometers is 5 miles", "how many grams are in 3 pounds"
    {
      pattern: new RegExp(`^how many ${unit} (?:is|are|in|are in|is in|make|makes) ${amount} ?${unit}$`),
      order: "to-amount-from"
    }
  ];

  for (const { pattern, order } of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const [rawAmount, rawFrom, rawTo] = order === "amount-from-to"
      ? [match[1], match[2], match[3]]
      : [match[2], match[3], match[1]];
    const value = parseAmount(rawAmount);
    const from = unitNamed(rawFrom);
    const to = unitNamed(rawTo);
    if (value === null || !from || !to || from.kind !== to.kind || from === to) continue;

    const result = from.kind === "temperature"
      ? fromCelsius(toCelsius(value, from), to)
      : value * from.factor / to.factor;
    const shownAmount = formatAmount(value);
    return {
      amount: value,
      from,
      to,
      result,
      text: `${describe(shownAmount, from)} is ${describe(formatAmount(result), to)}.`
    };
  }
  return null;
}
