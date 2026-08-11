import test from "node:test";
import assert from "node:assert/strict";
import {
  allPersonalities,
  applyResponseStyle,
  defaultPersonality,
  orderWidgets,
  personalityById,
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

test("regulated personalities carry a disclaimer that cannot be switched off", () => {
  for (const id of ["medical", "legal", "cyber-security"] as const) {
    const style = personalityById(id).responseStyle;
    assert.ok(
      style.mandatoryDisclaimer && style.mandatoryDisclaimer.length > 40,
      `${id} must carry a substantive disclaimer`
    );
  }

  // Medical and legal must disclaim advice specifically, not just hedge.
  assert.match(personalityById("medical").responseStyle.mandatoryDisclaimer!, /not medical advice/i);
  assert.match(personalityById("legal").responseStyle.mandatoryDisclaimer!, /not legal advice/i);
});

test("the disclaimer is appended to a reply", () => {
  const reply = applyResponseStyle("Take two of these and rest.", "medical");

  assert.match(reply, /Take two of these and rest\./);
  assert.match(reply, /not medical advice/i);
});

test("the disclaimer is never duplicated", () => {
  const once = applyResponseStyle("Some guidance.", "legal");
  const twice = applyResponseStyle(once, "legal");

  assert.equal(once, twice);
});

test("an unregulated personality adds nothing to the reply", () => {
  assert.equal(applyResponseStyle("  Done.  ", "developer"), "Done.");
});

test("an empty reply still carries the disclaimer rather than dangling whitespace", () => {
  const reply = applyResponseStyle("   ", "medical");

  assert.equal(reply, personalityById("medical").responseStyle.mandatoryDisclaimer);
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
