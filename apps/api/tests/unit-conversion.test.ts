import test from "node:test";
import assert from "node:assert/strict";
import { convertUnits } from "../src/services/unitConversion.js";

// Conversions are worked out here rather than by the model. Live, the model
// answered "convert 5 miles to kilometers" with "The result of 12.5 * 3 + 7 is
// 44.5", and "convert 70 fahrenheit to celsius" with "20°C".

function says(message: string): string | null {
  return convertUnits(message)?.text ?? null;
}

test("the conversions the model got wrong are exact", () => {
  assert.equal(says("convert 5 miles to kilometers"), "5 miles is 8.047 kilometers.");
  assert.equal(says("convert 70 fahrenheit to celsius"), "70°F is 21.11°C.");
  assert.equal(says("convert 10 kg to pounds"), "10 kilograms is 22.05 pounds.");
  assert.equal(says("convert 100 km to miles"), "100 kilometers is 62.14 miles.");
});

test("the usual ways of asking are understood", () => {
  assert.equal(says("70°F in °C"), "70°F is 21.11°C.");
  assert.equal(says("convert 70f to c"), "70°F is 21.11°C.");
  assert.equal(says("how many feet in a mile"), "1 mile is 5,280 feet.");
  assert.equal(says("How many kilometers is 5 miles?"), "5 miles is 8.047 kilometers.");
  assert.equal(says("how many grams are in 3 pounds"), "3 pounds is 1,360.78 grams.");
  assert.equal(says("what is 1,000 meters in feet"), "1,000 meters is 3,280.84 feet.");
  assert.equal(says("5 ft in cm"), "5 feet is 152.4 centimeters.");
});

test("every kind of unit converts, temperature through its offsets", () => {
  assert.equal(says("convert 90 minutes to hours"), "90 minutes is 1.5 hours.");
  assert.equal(says("how many seconds in a day"), "1 day is 86,400 seconds.");
  assert.equal(says("convert 2 cups to ml"), "2 cups is 473.18 milliliters.");
  assert.equal(says("60 mph in km/h"), "60 miles per hour is 96.56 kilometers per hour.");
  assert.equal(says("convert 0 celsius to kelvin"), "0°C is 273.15 K.");
  assert.equal(says("convert -40 c to f"), "-40°C is -40°F.");
});

test("anything that is not purely a conversion is left to the model", () => {
  for (const message of [
    "convert 5 miles to kilograms",
    "convert 5 miles to km and tell me a joke",
    "convert this file to markdown",
    "what is 5 plus 3",
    "how many apps do I have",
    ""
  ]) {
    assert.equal(says(message), null, JSON.stringify(message));
  }
});
