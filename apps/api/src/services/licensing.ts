// The paywall: a free trial, then a license key.
//
// How it fits this app's rules (docs/21-handoff.md: no cloud APIs, no keys in
// the app): the app never talks to a payment provider. Paying happens on a
// hosted checkout page the owner configures (TRHAI_CHECKOUT_URL), opened in
// the browser; what comes back to the user is a license key, which the app
// checks here against the owner's public key - offline, with node:crypto, no
// dependency. The private key that issues keys never leaves the owner's PC
// (scripts/licensing/issue.mjs).
//
// A key is `TRHAI-<payload>.<signature>`, both base64url: the payload is the
// JSON below, the signature is Ed25519 over the payload bytes. Changing one
// character of either breaks it.
//
// State kept here, protected at rest like every other data file: when the
// trial began on this PC and the key that was activated, if any.

import { createPublicKey, randomUUID, verify as verifySignature, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataFile } from "./dataDirectory.js";
import { checkoutUrl as configuredCheckoutUrl, licensePublicKeyBase64, priceText as configuredPriceText } from "./licenseConfig.js";
import { assertProtectedJsonWritable, protectedJsonLooksEncrypted, readProtectedJsonFile, writeProtectedJsonFile } from "./protectedJson.js";
import { runtimeDir } from "./modelEngine.js";

export type Plan = "personal" | "pro" | "team";
export const plans: Plan[] = ["personal", "pro", "team"];

export type LicensePayload = {
  v: 1;
  /** Unique per issued key, so one can be named in support or revoked by a later version. */
  id: string;
  plan: Plan;
  /** Who it was issued to; shown in the app, matched loosely (case does not matter). */
  email: string;
  issuedAt: string;
  /** ISO date; absent or null means it does not expire. */
  expiresAt?: string | null;
  /** How many PCs it is meant for. Informational: enforcement would need a server, which this app does not have. */
  seats?: number;
};

export type LicenseState = "trial" | "licensed" | "trial_expired" | "license_expired";

export type LicenseStatus = {
  state: LicenseState;
  /** False while the app may be used; true when the trial or the license has run out. */
  locked: boolean;
  plan: Plan | "trial";
  trialStartedAt: string;
  trialEndsAt: string;
  /** Whole days of trial left, 0 once it has ended. */
  trialDaysLeft: number;
  /** The activated license, with its signature left out. */
  license: Omit<LicensePayload, "v"> | null;
  /** Where to buy, when the owner has set one. */
  checkoutUrl: string | null;
  /** What it costs, in the owner's words, for the paywall screen. */
  priceText: string | null;
  /** When set, nothing is ever locked: for the owner's own PCs and for tests. */
  paywallDisabled: boolean;
  /** True when the trial record on this PC had been changed by hand, which ends the trial. */
  trialTampered: boolean;
};

export const trialDays = 14;
const keyPrefix = "TRHAI-";
const dayMs = 24 * 60 * 60 * 1000;

type Stored = { trialStartedAt?: string; key?: string | null };

const licenseFilePath = process.env.TRHAI_LICENSE_FILE ?? dataFile("license.json");

/**
 * A second record of when the trial began, outside the data folder: beside
 * the model engine's runtime (%LOCALAPPDATA%\TRHAI), which uninstalling the app
 * leaves alone. The earlier of the two wins, so deleting the license file - or
 * the whole data folder, or reinstalling - no longer starts a new trial on its
 * own. Both can still be deleted; stopping that needs a server, which this app
 * does not have (docs/24-paywall-and-updates.md).
 */
function trialMarkerPath(): string {
  return process.env.TRHAI_TRIAL_MARKER ?? path.join(path.dirname(runtimeDir()), "trial-started");
}

/** A clock a few minutes fast on one start and right on the next is not tampering. */
const clockSlackMs = 10 * 60 * 1000;
let tampered = false;

function readTrialMarker(nowMs: number): number | null {
  try {
    const when = Date.parse(readFileSync(trialMarkerPath(), "utf8").trim());
    // A date in the future helps nobody honest: it is ignored, not trusted.
    return Number.isFinite(when) && when <= nowMs + clockSlackMs ? when : null;
  } catch {
    return null;
  }
}

/** Written once; an earlier record is never replaced by a later one. */
function writeTrialMarker(iso: string): void {
  const file = trialMarkerPath();
  try {
    const existing = Date.parse(readFileSync(file, "utf8").trim());
    if (Number.isFinite(existing) && existing <= Date.parse(iso)) return;
  } catch { /* none yet */ }
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${iso}\n`, "utf8");
  } catch (error) {
    console.warn(`[license] could not record the trial start at ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

let loaded: Stored | null = null;

function now(): Date {
  return new Date();
}

function paywallDisabled(): boolean {
  return process.env.TRHAI_PAYWALL === "off";
}

function publicKey(): KeyObject {
  const base64 = process.env.TRHAI_LICENSE_PUBLIC_KEY?.trim() || licensePublicKeyBase64;
  return createPublicKey({ key: Buffer.from(base64, "base64"), type: "spki", format: "der" });
}

/** Builds the key string from a payload and its signature. The issuing script and the tests do the same. */
export function formatLicenseKey(payload: LicensePayload, signature: Buffer): string {
  return `${keyPrefix}${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}.${signature.toString("base64url")}`;
}

export type ParsedKey = { ok: true; payload: LicensePayload } | { ok: false; error: string };

function isPayload(value: unknown): value is LicensePayload {
  const p = value as Partial<LicensePayload> | null;
  return Boolean(p) && p?.v === 1 && typeof p.id === "string" && typeof p.email === "string"
    && typeof p.issuedAt === "string" && plans.includes(p.plan as Plan)
    && (p.expiresAt === undefined || p.expiresAt === null || typeof p.expiresAt === "string")
    && (p.seats === undefined || (typeof p.seats === "number" && p.seats > 0));
}

/** Checks a key's shape and signature. Expiry is not judged here; licenseStatus does that against the clock. */
export function parseLicenseKey(raw: unknown): ParsedKey {
  if (typeof raw !== "string") return { ok: false, error: "Paste the license key as text." };
  const key = raw.trim().replace(/\s+/g, "");
  if (!key.startsWith(keyPrefix)) return { ok: false, error: `A TRH AI license key starts with ${keyPrefix}.` };
  const body = key.slice(keyPrefix.length);
  const dot = body.indexOf(".");
  if (dot <= 0 || dot === body.length - 1) return { ok: false, error: "That is not a complete license key." };
  const payloadText = body.slice(0, dot);
  const signatureText = body.slice(dot + 1);
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadText, "base64url").toString("utf8"));
  } catch {
    return { ok: false, error: "That is not a complete license key." };
  }
  if (!isPayload(payload)) return { ok: false, error: "This key is not one TRH AI issued." };
  const signed = Buffer.from(JSON.stringify(payload), "utf8");
  const signature = Buffer.from(signatureText, "base64url");
  // Only the exact text that was issued. Base64's last character carries a
  // few unused bits, so a different last character can decode to the same
  // bytes; and JSON can be spaced differently and parse the same. Neither
  // would forge anything, but a key is one exact string, and this keeps it so.
  if (signed.toString("base64url") !== payloadText || signature.toString("base64url") !== signatureText) {
    return { ok: false, error: "This key's signature does not check out. Copy it again, exactly as it was sent." };
  }
  let valid = false;
  try {
    valid = verifySignature(null, signed, publicKey(), signature);
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, error: "This key's signature does not check out. Copy it again, exactly as it was sent." };
  return { ok: true, payload };
}

/**
 * The trial and the key, as this PC has them.
 *
 * The app only ever writes the license file encrypted. One that is not - or
 * that cannot be read, or whose trial begins in the future - was changed by
 * hand, and the store under it used to accept a plain JSON file as readily as
 * an encrypted one: a trial start typed in for 2099 meant a trial that never
 * ended. Now such a file ends the trial. A license key in it still counts,
 * because its signature is checked on its own.
 */
function load(): Stored {
  if (loaded) return loaded;
  loaded = {};
  tampered = false;
  const nowMs = now().getTime();
  if (existsSync(licenseFilePath)) {
    let text = "";
    try { text = readFileSync(licenseFilePath, "utf8"); } catch { /* unreadable: handled below */ }
    let parsed: Stored | null = null;
    try {
      parsed = (protectedJsonLooksEncrypted(text) ? readProtectedJsonFile(licenseFilePath) : JSON.parse(text)) as Stored;
    } catch (error) {
      console.warn(`[license] could not read ${licenseFilePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!protectedJsonLooksEncrypted(text) || !parsed || typeof parsed !== "object") tampered = true;
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.key === "string") loaded.key = parsed.key;
      const started = typeof parsed.trialStartedAt === "string" ? Date.parse(parsed.trialStartedAt) : NaN;
      if (Number.isFinite(started) && started <= nowMs + clockSlackMs) loaded.trialStartedAt = new Date(started).toISOString();
      else tampered = true;
    }
  }
  const marker = readTrialMarker(nowMs);
  if (tampered) {
    // The trial has ended: as of the earliest start this PC knows of, or now.
    console.warn(`[license] the trial record in ${licenseFilePath} was changed by hand; the trial has ended`);
    loaded.trialStartedAt = new Date(Math.min(marker ?? Infinity, nowMs - trialDays * dayMs)).toISOString();
    save();
  } else if (!loaded.trialStartedAt) {
    // First run on this PC - unless the other record says otherwise.
    loaded.trialStartedAt = new Date(marker ?? nowMs).toISOString();
    save();
  } else if (marker !== null && marker < Date.parse(loaded.trialStartedAt)) {
    loaded.trialStartedAt = new Date(marker).toISOString();
    save();
  }
  writeTrialMarker(loaded.trialStartedAt as string);
  return loaded;
}

function save(): void {
  if (!loaded) return;
  try {
    assertProtectedJsonWritable(licenseFilePath);
    writeProtectedJsonFile(licenseFilePath, loaded);
  } catch (error) {
    console.warn(`[license] could not write ${licenseFilePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Only a web page may be offered as the place to pay; anything else is dropped. */
function safeCheckoutUrl(value: string | null): string | null {
  return value && /^https:\/\/[^\s]+$/i.test(value) ? value : null;
}

function expired(iso: string | null | undefined, at: Date): boolean {
  if (!iso) return false;
  const when = Date.parse(iso);
  return Number.isFinite(when) && when <= at.getTime();
}

/** Where things stand right now. */
export function licenseStatus(when?: Date): LicenseStatus {
  const stored = load();
  // After load(): a first run stamps the trial start in there, and "now" must
  // not fall a millisecond before it.
  const at = when ?? now();
  const trialStartedAt = stored.trialStartedAt as string;
  const trialEnds = new Date(Date.parse(trialStartedAt) + trialDays * dayMs);
  const trialDaysLeft = Math.max(0, Math.ceil((trialEnds.getTime() - at.getTime()) / dayMs));
  const disabled = paywallDisabled();
  const base = {
    trialStartedAt,
    trialEndsAt: trialEnds.toISOString(),
    trialDaysLeft,
    checkoutUrl: safeCheckoutUrl(process.env.TRHAI_CHECKOUT_URL?.trim() || configuredCheckoutUrl),
    priceText: process.env.TRHAI_PRICE_TEXT?.trim() || configuredPriceText,
    paywallDisabled: disabled,
    trialTampered: tampered
  };

  const parsed = stored.key ? parseLicenseKey(stored.key) : null;
  if (parsed?.ok) {
    const { v: _version, ...license } = parsed.payload;
    const licenseExpired = expired(license.expiresAt, at);
    return {
      ...base,
      state: licenseExpired ? "license_expired" : "licensed",
      locked: licenseExpired && !disabled,
      plan: license.plan,
      license
    };
  }

  const trialOver = at.getTime() >= trialEnds.getTime();
  return {
    ...base,
    state: trialOver ? "trial_expired" : "trial",
    locked: trialOver && !disabled,
    plan: "trial",
    license: null
  };
}

export type ActivateResult = { ok: true; status: LicenseStatus } | { ok: false; error: string };

/** Puts a key to use on this PC. An expired key is refused up front rather than activated and then locked. */
export function activateLicense(raw: unknown, at: Date = now()): ActivateResult {
  const parsed = parseLicenseKey(raw);
  if (!parsed.ok) return parsed;
  if (expired(parsed.payload.expiresAt, at)) {
    return { ok: false, error: `This license expired on ${parsed.payload.expiresAt?.slice(0, 10)}.` };
  }
  const stored = load();
  stored.key = (raw as string).trim().replace(/\s+/g, "");
  save();
  return { ok: true, status: licenseStatus(at) };
}

/** Takes the key off this PC. The trial clock is not reset by it. */
export function removeLicense(): LicenseStatus {
  const stored = load();
  stored.key = null;
  save();
  return licenseStatus();
}

/** A fresh id for a key being issued. */
export function newLicenseId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 16);
}

/** Forget what was loaded, so a test can point at another file. */
export function resetLicensingForTests(): void {
  loaded = null;
}

type GateRequest = { method: string };
type GateResponse = { status: (code: number) => { json: (body: unknown) => unknown } };

/**
 * Express middleware for the routes that do the work (and so are what is
 * paid for). Reads stay open so a locked app still shows what it holds; what
 * is refused is making it do more. 402 is the status made for this.
 */
export function paywallGate(req: GateRequest, res: GateResponse, next: () => void): void {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    next();
    return;
  }
  const status = licenseStatus();
  if (!status.locked) {
    next();
    return;
  }
  res.status(402).json({
    code: "PAYMENT_REQUIRED",
    message: status.state === "license_expired"
      ? "Your TRH AI license has expired. Renew it, or enter a new key, in Settings."
      : `Your ${trialDays}-day trial of TRH AI has ended. Enter a license key in Settings to keep going.`,
    license: status,
    traceId: "trace-local"
  });
}
