import test from "node:test";
import assert from "node:assert/strict";
import {
  allPersonalities,
  defaultPersonality,
  orderWidgets,
  personalityFields,
  resolvePersonality
} from "../src/personalities.js";

test("every personality the vision names exists, and nothing else", () => {
  assert.deepEqual(
    allPersonalities().map((entry) => entry.label),
    [
      "Professional",
      "Developer",
      "Creative",
      "Business",
      "Research",
      "Teacher",
      "Cyber Security",
      "Gaming",
      "Medical",
      "Legal"
    ]
  );
});

test("a personality carries no capability, scope, or permission field", () => {
  // The safety baseline says no personality may bypass a permission gate. The
  // cheapest way to guarantee that is to make it unexpressible: if a profile
  // cannot declare a capability, switching profiles cannot grant one.
  const allowed = new Set<string>(personalityFields);

  for (const entry of allPersonalities()) {
    for (const key of Object.keys(entry)) {
      assert.ok(
        allowed.has(key),
        `${entry.id} declares "${key}", which is outside the cosmetic profile shape`
      );
    }
  }
});

test("a personality adds no words to a reply, and none says it holds back", () => {
  // Until 2026-11-05 the medical, legal and security personalities appended a caveat to every
  // answer ("This is general information, not medical advice..."). The owner decided the
  // assistant answers what it is asked without one. This keeps one from coming back by the side
  // door: a new field on the style, or a summary that says what the personality will not do.
  for (const entry of allPersonalities()) {
    assert.deepEqual(Object.keys(entry.responseStyle).sort(), ["formality", "maxSentences", "requiresCitations"], entry.id);
    assert.doesNotMatch(entry.summary, /substitute|advice|disclaimer|consult|qualified/i, entry.id);
  }
});

test("an unknown stored personality falls back instead of throwing", () => {
  // This value comes from localStorage, so a stale or hand-edited entry must not
  // stop the shell from booting.
  assert.equal(resolvePersonality("wizard"), defaultPersonality);
  assert.equal(resolvePersonality(undefined), defaultPersonality);
  assert.equal(resolvePersonality("gaming"), "gaming");
});

test("widget priority reorders the widgets a personality cares about", () => {
  const available = ["email", "gpu", "calendar", "discord", "cpu"];

  assert.deepEqual(orderWidgets(available, "gaming").slice(0, 3), ["gpu", "cpu", "discord"]);
  assert.deepEqual(orderWidgets(available, "business").slice(0, 2), ["calendar", "email"]);
});

test("a widget no personality ranks is kept, not dropped", () => {
  const available = ["gpu", "brand-new-widget", "cpu"];
  const ordered = orderWidgets(available, "gaming");

  assert.equal(ordered.length, available.length);
  assert.ok(ordered.includes("brand-new-widget"));
  // Unranked widgets sort after ranked ones rather than jumping to the front.
  assert.equal(ordered.at(-1), "brand-new-widget");
});

test("each personality offers real suggestions and a core palette", () => {
  for (const entry of allPersonalities()) {
    assert.ok(entry.suggestions.length >= 3, `${entry.id} needs a suggestion strategy`);
    assert.match(entry.core.accent, /^#[0-9a-f]{6}$/i, `${entry.id} needs a core accent color`);
    assert.ok(
      entry.core.energy >= 0 && entry.core.energy <= 1,
      `${entry.id} energy must be a 0..1 weighting`
    );
    assert.ok(entry.voice.rate > 0.5 && entry.voice.rate < 1.5, `${entry.id} voice rate is unusable`);
  }
});
