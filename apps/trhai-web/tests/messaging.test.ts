import test from "node:test";
import assert from "node:assert/strict";
import { describeTexting, needsServer, providerHint, type ProviderHint } from "../src/lib/messaging.js";

const providers: ProviderHint[] = [
  { name: "Gmail", domains: ["gmail.com", "googlemail.com"], passwordHelp: "Use an app password." },
  { name: "Outlook.com", domains: ["outlook.com", "hotmail.com"], passwordHelp: "May refuse other programs." }
];

test("a known address brings its provider's password help with it", () => {
  assert.equal(providerHint("ada@gmail.com", providers)?.name, "Gmail");
  assert.equal(providerHint("  Ada@GoogleMail.com ", providers)?.name, "Gmail");
  assert.equal(providerHint("ada@hotmail.com", providers)?.name, "Outlook.com");
  assert.equal(providerHint("ada@", providers), null);
  assert.equal(providerHint("ada@mycompany.com", providers), null);
});

test("texting reads as ready only with a phone linked, and says what to do otherwise", () => {
  assert.equal(describeTexting("linked").ready, true);
  assert.equal(describeTexting("not-linked").ready, false);
  assert.match(describeTexting("not-linked").text, /no phone is linked/);
  assert.match(describeTexting("missing").text, /Microsoft Store/);
});

test("the steps follow the phone: an iPhone pastes into a new message, an Android gets the text written", () => {
  const iphone = describeTexting("linked", "iphone");
  assert.equal(iphone.ready, true);
  assert.match(iphone.text, /can't start a text that's already written/);
  assert.match(iphone.text, /paste it into a new message/);
  assert.match(describeTexting("linked", "android").text, /written and ready/);
  // Not said yet: what happens either way, and a prompt to say.
  assert.match(describeTexting("linked", null).text, /Say which phone is linked/);
  // No phone linked: the phone does not matter yet.
  assert.match(describeTexting("not-linked", "iphone").text, /no phone is linked/);
});

test("the server is asked for only for a complete address no provider covers", () => {
  assert.equal(needsServer("ada@gmail.com", providers), false);
  assert.equal(needsServer("ada@mycompany.com", providers), true);
  assert.equal(needsServer("ada@myco", providers), false, "not until the address is complete");
  assert.equal(needsServer("", providers), false);
});
