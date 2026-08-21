import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

// Accounts for the assistant.
//
// Standard library only — scrypt is in node:crypto, so password hashing needs no
// dependency. Passwords are never stored or logged; only a per-user salt and the
// derived key are persisted, and verification is timing-safe.
//
// Tokens are opaque random strings kept server-side rather than self-describing
// claims, so revoking a session is just deleting a row.

export type Account = {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
};

type StoredAccount = Account & {
  salt: string;
  hash: string;
  /**
   * Hashes of unused recovery codes. Only hashes are kept, exactly as for
   * passwords — a stolen accounts file must not hand over working codes.
   */
  recoveryCodeHashes?: string[];
  /** Separate salt so a code hash can never be compared against the password. */
  recoverySalt?: string;
};

type StoredToken = {
  token: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
};

export type AuthResult =
  | { ok: true; account: Account; token: string; expiresAt: string }
  | { ok: false; error: string };

/** Registration additionally returns the plaintext codes — the only time they exist. */
export type RegisterResult =
  | { ok: true; account: Account; token: string; expiresAt: string; recoveryCodes: string[] }
  | { ok: false; error: string };

export const recoveryCodeCount = 8;

const scryptKeyLength = 64;
export const minPasswordLength = 10;
export const tokenLifetimeMs = 30 * 24 * 60 * 60 * 1000;

const accountsFilePath = process.env.ASSIST_ACCOUNTS_FILE
  ?? path.join(process.cwd(), "data", "accounts.json");

let persistenceEnabled = process.env.ASSIST_ACCOUNTS_PERSIST !== "off";
let loaded = false;

const accountsById = new Map<string, StoredAccount>();
const accountIdByEmail = new Map<string, string>();
const tokens = new Map<string, StoredToken>();

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  // Deliberately permissive: the only thing that matters here is that it is a
  // single plausible address, not full RFC compliance.
  if (email.length < 3 || email.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, scryptKeyLength).toString("hex");
}

function verifyPassword(password: string, salt: string, expected: string): boolean {
  const derived = scryptSync(password, salt, scryptKeyLength);
  const stored = Buffer.from(expected, "hex");
  // Length check first: timingSafeEqual throws on a mismatch.
  if (derived.length !== stored.length) return false;
  return timingSafeEqual(derived, stored);
}

// Crockford-ish alphabet: no I, L, O or U, so codes cannot be misread or
// accidentally spell something. 12 chars from a 32-symbol set is ~60 bits.
const recoveryAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const recoveryCodeChars = 12;

function generateRecoveryCode(): string {
  const bytes = randomBytes(recoveryCodeChars);
  let raw = "";
  for (const byte of bytes) {
    raw += recoveryAlphabet[byte % recoveryAlphabet.length];
  }
  // Grouped for legibility when a user writes them down.
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

/** Codes are compared case-insensitively and ignoring the grouping dashes. */
export function normalizeRecoveryCode(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

function hashRecoveryCode(code: string, salt: string): string {
  // Codes carry ~60 bits of entropy, so a single scrypt pass is ample and keeps
  // verification to one derivation rather than one per stored code.
  return scryptSync(normalizeRecoveryCode(code), salt, 32).toString("hex");
}

function issueRecoveryCodes(account: StoredAccount): string[] {
  const salt = randomBytes(16).toString("hex");
  const codes = Array.from({ length: recoveryCodeCount }, generateRecoveryCode);
  account.recoverySalt = salt;
  account.recoveryCodeHashes = codes.map((code) => hashRecoveryCode(code, salt));
  return codes;
}

function publicView(account: StoredAccount): Account {
  return {
    id: account.id,
    email: account.email,
    displayName: account.displayName,
    createdAt: account.createdAt
  };
}

function loadFromDisk(): void {
  if (loaded) return;
  loaded = true;
  if (!persistenceEnabled || !existsSync(accountsFilePath)) return;

  try {
    const parsed = JSON.parse(readFileSync(accountsFilePath, "utf8")) as {
      accounts?: StoredAccount[];
      tokens?: StoredToken[];
    };

    for (const account of parsed.accounts ?? []) {
      if (!account || typeof account.id !== "string" || typeof account.email !== "string") continue;
      if (typeof account.salt !== "string" || typeof account.hash !== "string") continue;
      accountsById.set(account.id, account);
      accountIdByEmail.set(account.email, account.id);
    }

    const now = Date.now();
    for (const token of parsed.tokens ?? []) {
      if (!token || typeof token.token !== "string" || typeof token.userId !== "string") continue;
      // Expired tokens are simply not restored.
      if (Date.parse(token.expiresAt) <= now) continue;
      tokens.set(token.token, token);
    }
  } catch {
    // A corrupt file must not take the API down; start with no accounts.
  }
}

function saveToDisk(): void {
  if (!persistenceEnabled) return;
  try {
    const payload = {
      version: 1,
      accounts: [...accountsById.values()],
      tokens: [...tokens.values()]
    };
    mkdirSync(path.dirname(accountsFilePath), { recursive: true });
    const tempPath = `${accountsFilePath}.tmp`;
    writeFileSync(tempPath, JSON.stringify(payload, null, 2), "utf8");
    renameSync(tempPath, accountsFilePath);
  } catch {
    // Durability loss must not fail the request.
  }
}

function issueToken(userId: string): StoredToken {
  const record: StoredToken = {
    token: randomBytes(32).toString("hex"),
    userId,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + tokenLifetimeMs).toISOString()
  };
  tokens.set(record.token, record);
  return record;
}

export function registerAccount(input: {
  email?: unknown;
  password?: unknown;
  displayName?: unknown;
}): RegisterResult {
  loadFromDisk();

  const email = normalizeEmail(input.email);
  if (!email) return { ok: false, error: "A valid email address is required" };

  const password = typeof input.password === "string" ? input.password : "";
  if (password.length < minPasswordLength) {
    return { ok: false, error: `Password must be at least ${minPasswordLength} characters` };
  }

  if (accountIdByEmail.has(email)) {
    return { ok: false, error: "An account with that email already exists" };
  }

  const salt = randomBytes(16).toString("hex");
  const account: StoredAccount = {
    id: randomUUID(),
    email,
    displayName: typeof input.displayName === "string" && input.displayName.trim()
      ? input.displayName.trim().slice(0, 80)
      : email.split("@")[0],
    createdAt: new Date().toISOString(),
    salt,
    hash: hashPassword(password, salt)
  };

  // Generated before persisting so the hashes are written with the account.
  const recoveryCodes = issueRecoveryCodes(account);

  accountsById.set(account.id, account);
  accountIdByEmail.set(email, account.id);
  const token = issueToken(account.id);
  saveToDisk();

  return {
    ok: true,
    account: publicView(account),
    token: token.token,
    expiresAt: token.expiresAt,
    // The only moment these exist in plaintext.
    recoveryCodes
  };
}

/** How many unused codes remain, for showing the user when they run low. */
export function remainingRecoveryCodes(accountId: string): number {
  loadFromDisk();
  return accountsById.get(accountId)?.recoveryCodeHashes?.length ?? 0;
}

/**
 * Regain access with a recovery code. Consumes the code, sets a new password and
 * revokes every session — a code is used precisely when you fear you have lost
 * control of the account, so leaving old sessions alive would defeat it.
 */
export function recoverWithCode(input: {
  email?: unknown;
  code?: unknown;
  newPassword?: unknown;
}): AuthResult {
  loadFromDisk();

  const email = normalizeEmail(input.email);
  const code = normalizeRecoveryCode(input.code);
  const newPassword = typeof input.newPassword === "string" ? input.newPassword : "";

  // One message throughout: which of email or code was wrong is not the
  // caller's business, and saying so would enumerate accounts.
  const rejection: AuthResult = { ok: false, error: "That email and recovery code do not match" };

  if (newPassword.length < minPasswordLength) {
    return { ok: false, error: `Password must be at least ${minPasswordLength} characters` };
  }
  if (!email || !code) return rejection;

  const accountId = accountIdByEmail.get(email);
  const account = accountId ? accountsById.get(accountId) : undefined;
  if (!account?.recoverySalt || !account.recoveryCodeHashes?.length) {
    // Spend comparable time so a missing account is not detectably faster.
    scryptSync(code, "absent-account-placeholder-salt", 32);
    return rejection;
  }

  const candidate = hashRecoveryCode(code, account.recoverySalt);
  const index = account.recoveryCodeHashes.findIndex((stored) => {
    const a = Buffer.from(stored, "hex");
    const b = Buffer.from(candidate, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  });
  if (index === -1) return rejection;

  // Single use.
  account.recoveryCodeHashes.splice(index, 1);

  account.salt = randomBytes(16).toString("hex");
  account.hash = hashPassword(newPassword, account.salt);
  accountsById.set(account.id, account);

  for (const [existing, stored] of [...tokens.entries()]) {
    if (stored.userId === account.id) tokens.delete(existing);
  }

  const replacement = issueToken(account.id);
  saveToDisk();

  return {
    ok: true,
    account: publicView(account),
    token: replacement.token,
    expiresAt: replacement.expiresAt
  };
}

export function login(input: { email?: unknown; password?: unknown }): AuthResult {
  loadFromDisk();

  const email = normalizeEmail(input.email);
  const password = typeof input.password === "string" ? input.password : "";

  // One message for both cases: distinguishing them tells an attacker which
  // emails are registered.
  const rejection: AuthResult = { ok: false, error: "Email or password is incorrect" };
  if (!email || !password) return rejection;

  const accountId = accountIdByEmail.get(email);
  const account = accountId ? accountsById.get(accountId) : undefined;
  if (!account) {
    // Spend comparable time so a missing account is not detectably faster.
    hashPassword(password, "absent-account-placeholder-salt");
    return rejection;
  }

  if (!verifyPassword(password, account.salt, account.hash)) return rejection;

  const token = issueToken(account.id);
  saveToDisk();
  return { ok: true, account: publicView(account), token: token.token, expiresAt: token.expiresAt };
}

/** Resolve a bearer token to an account, or null when absent/expired/unknown. */
export function accountForToken(token: unknown): Account | null {
  loadFromDisk();
  if (typeof token !== "string" || !token) return null;

  const record = tokens.get(token);
  if (!record) return null;

  if (Date.parse(record.expiresAt) <= Date.now()) {
    tokens.delete(token);
    saveToDisk();
    return null;
  }

  const account = accountsById.get(record.userId);
  return account ? publicView(account) : null;
}

/**
 * Change the password of the account behind `token`.
 *
 * Every other session is revoked. That is the entire point of changing a
 * password you think is compromised: leaving the attacker's session alive would
 * make the change cosmetic. The caller gets a fresh token so they stay signed in.
 */
export function changePassword(input: {
  token: unknown;
  currentPassword?: unknown;
  newPassword?: unknown;
}): AuthResult {
  loadFromDisk();

  const token = typeof input.token === "string" ? input.token : "";
  const record = tokens.get(token);
  const account = record ? accountsById.get(record.userId) : undefined;
  if (!record || !account) return { ok: false, error: "Not signed in" };

  const currentPassword = typeof input.currentPassword === "string" ? input.currentPassword : "";
  if (!verifyPassword(currentPassword, account.salt, account.hash)) {
    return { ok: false, error: "Current password is incorrect" };
  }

  const newPassword = typeof input.newPassword === "string" ? input.newPassword : "";
  if (newPassword.length < minPasswordLength) {
    return { ok: false, error: `Password must be at least ${minPasswordLength} characters` };
  }
  if (newPassword === currentPassword) {
    return { ok: false, error: "New password must be different from the current one" };
  }

  // A fresh salt, so the stored hash cannot be compared against the old one.
  account.salt = randomBytes(16).toString("hex");
  account.hash = hashPassword(newPassword, account.salt);
  accountsById.set(account.id, account);

  for (const [existing, stored] of [...tokens.entries()]) {
    if (stored.userId === account.id) tokens.delete(existing);
  }

  const replacement = issueToken(account.id);
  saveToDisk();

  return {
    ok: true,
    account: publicView(account),
    token: replacement.token,
    expiresAt: replacement.expiresAt
  };
}

export function logout(token: unknown): boolean {
  loadFromDisk();
  if (typeof token !== "string" || !tokens.has(token)) return false;
  tokens.delete(token);
  saveToDisk();
  return true;
}

/** Bearer token from an Authorization header, if present. */
export function bearerToken(headerValue: unknown): string | null {
  if (typeof headerValue !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  return match ? match[1].trim() : null;
}

export function accountCount(): number {
  loadFromDisk();
  return accountsById.size;
}

/** Test seam. */
export function resetAccounts(): void {
  loaded = true;
  accountsById.clear();
  accountIdByEmail.clear();
  tokens.clear();
  saveToDisk();
}

/** Test seam: drop in-process state and re-read the file, simulating a restart. */
export function reloadAccountsFromDisk(): void {
  accountsById.clear();
  accountIdByEmail.clear();
  tokens.clear();
  loaded = false;
  loadFromDisk();
}
