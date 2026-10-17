import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The signing key is the test's own, so these never depend on the owner's
// real one, and the license file goes to a temp folder. Both are read at
// module load, so they are set before the import.
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
process.env.TRHAI_LICENSE_PUBLIC_KEY = publicKey.export({ type: "spki", format: "der" }).toString("base64");
const licenseDir = mkdtempSync(path.join(tmpdir(), "trhai-license-"));
process.env.TRHAI_LICENSE_FILE = path.join(licenseDir, "license.json");
process.env.TRHAI_TRIAL_MARKER = path.join(licenseDir, "elsewhere", "trial-started");
delete process.env.TRHAI_PAYWALL;

const {
  activateLicense, formatLicenseKey, licenseStatus, newLicenseId, parseLicenseKey, paywallGate, removeLicense,
  resetLicensingForTests, trialDays
} = await import("../src/services/licensing.js");
const { writeProtectedJsonFile } = await import("../src/services/protectedJson.js");
type LicensePayload = import("../src/services/licensing.js").LicensePayload;

const day = 24 * 60 * 60 * 1000;

function issue(overrides: Partial<LicensePayload> = {}): string {
  const payload: LicensePayload = {
    v: 1, id: newLicenseId(), plan: "pro", email: "owner@example.com", issuedAt: new Date().toISOString(), ...overrides
  };
  return formatLicenseKey(payload, sign(null, Buffer.from(JSON.stringify(payload), "utf8"), privateKey));
}

function fakeResponse() {
  const sent: { code?: number; body?: unknown } = {};
  return { sent, res: { status: (code: number) => ({ json: (body: unknown) => { sent.code = code; sent.body = body; } }) } };
}

test("a fresh PC is on trial for the full period, and is locked the moment it ends", () => {
  resetLicensingForTests();
  const status = licenseStatus();
  assert.equal(status.state, "trial");
  assert.equal(status.locked, false);
  assert.equal(status.trialDaysLeft, trialDays);
  const later = new Date(Date.parse(status.trialEndsAt) + 1);
  const ended = licenseStatus(later);
  assert.equal(ended.state, "trial_expired");
  assert.equal(ended.locked, true);
  assert.equal(ended.trialDaysLeft, 0);
});

test("a signed key activates, is remembered across a reload, and reads back without its signature", () => {
  resetLicensingForTests();
  const key = issue({ plan: "team", seats: 5 });
  const result = activateLicense(key);
  assert.ok(result.ok);
  assert.equal(result.status.state, "licensed");
  assert.equal(result.status.plan, "team");
  assert.equal(result.status.license?.email, "owner@example.com");
  assert.equal(result.status.license?.seats, 5);
  assert.equal("v" in (result.status.license ?? {}), false);

  resetLicensingForTests();
  const reloaded = licenseStatus(new Date(Date.now() + 400 * day));
  assert.equal(reloaded.state, "licensed", "a license without an expiry outlasts the trial");
  assert.equal(reloaded.locked, false);
});

test("one changed character in the payload or the signature is refused", () => {
  const key = issue();
  const [prefixAndPayload, signature] = key.split(".");
  const tamperedPayload = `${prefixAndPayload.slice(0, -2)}${prefixAndPayload.endsWith("A") ? "BB" : "AA"}.${signature}`;
  assert.equal(parseLicenseKey(tamperedPayload).ok, false);
  // Every position, including the last character, whose spare bits once let
  // a different character decode to the same signature.
  for (const at of [0, Math.floor(signature.length / 2), signature.length - 1]) {
    const swapped = signature[at] === "A" ? "B" : "A";
    const tamperedSignature = `${prefixAndPayload}.${signature.slice(0, at)}${swapped}${signature.slice(at + 1)}`;
    assert.equal(parseLicenseKey(tamperedSignature).ok, false, `changed at ${at}`);
  }
  assert.equal(parseLicenseKey("TRHAI-nope").ok, false);
  assert.equal(parseLicenseKey("not a key").ok, false);
  assert.equal(parseLicenseKey(42).ok, false);
});

test("a key signed by someone else's key is not one TRH AI issued", () => {
  const other = generateKeyPairSync("ed25519").privateKey;
  const payload: LicensePayload = { v: 1, id: newLicenseId(), plan: "pro", email: "x@example.com", issuedAt: new Date().toISOString() };
  const forged = formatLicenseKey(payload, sign(null, Buffer.from(JSON.stringify(payload), "utf8"), other));
  const parsed = parseLicenseKey(forged);
  assert.equal(parsed.ok, false);
  assert.match((parsed as { error: string }).error, /signature/);
});

test("whitespace pasted around or inside a key does not matter", () => {
  const key = issue();
  const messy = `  ${key.slice(0, 30)}\n${key.slice(30)}  `;
  assert.ok(parseLicenseKey(messy).ok);
});

test("an expired key is refused at activation, and an activated key that expires locks the app", () => {
  resetLicensingForTests();
  const past = new Date(Date.now() - day).toISOString();
  const refused = activateLicense(issue({ expiresAt: past }));
  assert.equal(refused.ok, false);
  assert.match((refused as { error: string }).error, /expired/);

  const soon = new Date(Date.now() + 2 * day).toISOString();
  const accepted = activateLicense(issue({ expiresAt: soon }));
  assert.ok(accepted.ok);
  const afterwards = licenseStatus(new Date(Date.now() + 3 * day));
  assert.equal(afterwards.state, "license_expired");
  assert.equal(afterwards.locked, true);
});

test("removing the key goes back to the trial, with the same clock", () => {
  resetLicensingForTests();
  const before = licenseStatus();
  activateLicense(issue());
  const after = removeLicense();
  assert.equal(after.state, "trial");
  assert.equal(after.trialStartedAt, before.trialStartedAt);
});

test("the gate lets reads through, lets a trial or license work, and answers 402 once locked", () => {
  resetLicensingForTests();
  removeLicense();
  let passed = 0;
  const next = () => { passed += 1; };

  const open = fakeResponse();
  paywallGate({ method: "POST" }, open.res, next);
  assert.equal(passed, 1, "on trial, work goes through");

  // Lock it by pretending the trial began long ago.
  resetLicensingForTests();
  writeProtectedJsonFile(process.env.TRHAI_LICENSE_FILE as string, { trialStartedAt: new Date(Date.now() - (trialDays + 1) * day).toISOString() });
  resetLicensingForTests();

  const read = fakeResponse();
  paywallGate({ method: "GET" }, read.res, next);
  assert.equal(passed, 2, "reads stay open when locked");

  const locked = fakeResponse();
  paywallGate({ method: "POST" }, locked.res, next);
  assert.equal(passed, 2);
  assert.equal(locked.sent.code, 402);
  assert.equal((locked.sent.body as { code: string }).code, "PAYMENT_REQUIRED");
  assert.match((locked.sent.body as { message: string }).message, /trial/);

  process.env.TRHAI_PAYWALL = "off";
  const disabled = fakeResponse();
  paywallGate({ method: "POST" }, disabled.res, next);
  assert.equal(passed, 3, "TRHAI_PAYWALL=off never locks");
  delete process.env.TRHAI_PAYWALL;

  activateLicense(issue());
  const licensed = fakeResponse();
  paywallGate({ method: "POST" }, licensed.res, next);
  assert.equal(passed, 4, "a key unlocks it again");
});

test("the Buy button only ever points at an https page", () => {
  resetLicensingForTests();
  process.env.TRHAI_CHECKOUT_URL = "https://buy.example.com/trhai";
  process.env.TRHAI_PRICE_TEXT = "$29 once";
  assert.equal(licenseStatus().checkoutUrl, "https://buy.example.com/trhai");
  assert.equal(licenseStatus().priceText, "$29 once");
  for (const bad of ["javascript:alert(1)", "file:///C:/x", "http://plain.example.com", "https://has space.example.com"]) {
    process.env.TRHAI_CHECKOUT_URL = bad;
    assert.equal(licenseStatus().checkoutUrl, null, bad);
  }
  delete process.env.TRHAI_CHECKOUT_URL;
  delete process.env.TRHAI_PRICE_TEXT;
});


// --------------------------------------------- a trial record changed by hand

const licenseFile = process.env.TRHAI_LICENSE_FILE as string;
const markerFile = process.env.TRHAI_TRIAL_MARKER as string;
const fresh = () => {
  rmSync(licenseFile, { force: true });
  rmSync(markerFile, { force: true });
  resetLicensingForTests();
};

test("a plain, hand-written license file ends the trial, however far ahead it says the trial began", () => {
  fresh();
  writeFileSync(licenseFile, JSON.stringify({ trialStartedAt: "2099-01-01T00:00:00.000Z" }));
  const status = licenseStatus();
  assert.equal(status.state, "trial_expired");
  assert.equal(status.locked, true);
  assert.equal(status.trialTampered, true);
  assert.match(readFileSync(licenseFile, "utf8"), /"protected": true/, "written back encrypted");
  resetLicensingForTests();
  assert.equal(licenseStatus().locked, true, "and it stays ended after a restart");
});

test("an encrypted file whose trial begins in the future, or that cannot be read, ends the trial too", () => {
  fresh();
  writeProtectedJsonFile(licenseFile, { trialStartedAt: new Date(Date.now() + 30 * day).toISOString() });
  assert.equal(licenseStatus().state, "trial_expired");
  fresh();
  writeFileSync(licenseFile, '{"version":1,"protected":true,"algorithm":"aes-256-gcm","kdf":"scrypt-sha256","salt":"AA==","iv":"AA==","tag":"AA==","ciphertext":"AA=="}');
  const unreadable = licenseStatus();
  assert.equal(unreadable.locked, true);
  assert.equal(unreadable.trialTampered, true);
});

test("a real key in a hand-edited file still unlocks: its signature is checked on its own", () => {
  fresh();
  writeFileSync(licenseFile, JSON.stringify({ trialStartedAt: "2099-01-01T00:00:00.000Z", key: issue() }));
  const status = licenseStatus();
  assert.equal(status.state, "licensed");
  assert.equal(status.locked, false);
});

test("deleting the license file does not start a new trial: the other record keeps the first start", () => {
  fresh();
  const first = licenseStatus().trialStartedAt;
  assert.ok(existsSync(markerFile), "the second record is written");
  rmSync(licenseFile, { force: true });
  resetLicensingForTests();
  assert.equal(licenseStatus().trialStartedAt, first);

  // A trial that began long ago stays over after the file goes.
  fresh();
  writeProtectedJsonFile(licenseFile, { trialStartedAt: new Date(Date.now() - 20 * day).toISOString() });
  assert.equal(licenseStatus().locked, true);
  rmSync(licenseFile, { force: true });
  resetLicensingForTests();
  const after = licenseStatus();
  assert.equal(after.locked, true);
  assert.equal(after.trialTampered, false, "nothing was edited; the file was only deleted");
});

test("the earlier of the two records wins, and a second record dated in the future is ignored", () => {
  fresh();
  writeProtectedJsonFile(licenseFile, { trialStartedAt: new Date(Date.now() - 1 * day).toISOString() });
  mkdirSync(path.dirname(markerFile), { recursive: true });
  writeFileSync(markerFile, new Date(Date.now() - 20 * day).toISOString());
  resetLicensingForTests();
  assert.equal(licenseStatus().locked, true, "the older record ends the trial");

  fresh();
  mkdirSync(path.dirname(markerFile), { recursive: true });
  writeFileSync(markerFile, "2099-01-01T00:00:00.000Z");
  const status = licenseStatus();
  assert.equal(status.state, "trial");
  assert.ok(Date.parse(status.trialStartedAt) <= Date.now());
});
