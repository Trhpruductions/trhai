import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { dataFile } from "./dataDirectory.js";
import type { AccountStatus, Role } from "./entitlements.js";
import { assertProtectedJsonWritable, readProtectedJsonFile, writeProtectedJsonFile } from "./protectedJson.js";

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
  status: AccountStatus;
  /** When the address was confirmed by a link sent to it; null until then. */
  emailVerifiedAt: string | null;
  lastLoginAt: string | null;
};

type StoredAccount = Pick<Account, "id" | "email" | "displayName" | "createdAt"> & {
  /** Accounts written before these existed have none of them: each reads as its default. */
  status?: AccountStatus;
  emailVerifiedAt?: string | null;
  lastLoginAt?: string | null;
  /**
   * The role this service has recorded for the account. Whether it counts at all
   * depends on where the service runs (access.ts): on someone's own PC a role
   * comes from a signed key, because anyone who can edit this file could write
   * "owner" into it.
   */
  role?: Role;
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
  /**
   * A hash of the session token, never the token itself.
   *
   * This file already refuses to store passwords or recovery codes in the
   * clear — "a stolen accounts file must not hand over working codes" — and
   * tokens were the one credential it did hand over. A session token is a
   * bearer credential: anyone who could read data/accounts.json could
   * authenticate as that user for the rest of the token's month-long life,
   * without ever knowing the password.
   *
   * SHA-256 rather than scrypt, deliberately. Passwords need a slow hash
   * because people choose guessable ones; a token is 32 random bytes, so
   * there is no dictionary to run and nothing to gain from making every
   * request pay for a key derivation.
   */
  tokenHash: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
};

/** The lookup key for a presented token. */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type AuthResult =
  | { ok: true; account: Account; token: string; expiresAt: string }
  | { ok: false; error: string; suspended?: true };

/** Registration additionally returns the plaintext codes — the only time they exist. */
export type RegisterResult =
  | { ok: true; account: Account; token: string; expiresAt: string; recoveryCodes: string[] }
  | { ok: false; error: string };

export const recoveryCodeCount = 8;

const scryptKeyLength = 64;
export const minPasswordLength = 10;
export const tokenLifetimeMs = 30 * 24 * 60 * 60 * 1000;

const accountsFilePath = process.env.ASSIST_ACCOUNTS_FILE
  ?? dataFile("accounts.json");

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
    createdAt: account.createdAt,
    status: account.status === "suspended" ? "suspended" : "active",
    emailVerifiedAt: account.emailVerifiedAt ?? null,
    lastLoginAt: account.lastLoginAt ?? null
  };
}

/** The version of the accounts file's layout. 2 added status, verification, last sign-in and a stored role. */
const accountsSchema = 2;
let loadedSchema = 0;

/**
 * Before the first write that follows an upgrade, keep the file as the previous
 * version left it. Nothing is converted - an old account simply reads as active,
 * unverified, role "user" - but a copy costs nothing, and putting one file back
 * undoes a bad upgrade.
 */
function keepPreUpgradeCopy(): void {
  if (loadedSchema >= accountsSchema) return;
  const copy = `${accountsFilePath}.before-roles`;
  if (!existsSync(accountsFilePath) || existsSync(copy)) return;
  try {
    copyFileSync(accountsFilePath, copy);
  } catch {
    // A missing copy must not stop anyone signing in.
  }
}

function loadFromDisk(): void {
  if (loaded) return;
  loaded = true;
  if (!persistenceEnabled || !existsSync(accountsFilePath)) return;

  try {
    const parsed = readProtectedJsonFile(accountsFilePath) as {
      schema?: number;
      accounts?: StoredAccount[];
      tokens?: StoredToken[];
    };
    loadedSchema = typeof parsed.schema === "number" ? parsed.schema : 1;

    for (const account of parsed.accounts ?? []) {
      if (!account || typeof account.id !== "string" || typeof account.email !== "string") continue;
      if (typeof account.salt !== "string" || typeof account.hash !== "string") continue;
      accountsById.set(account.id, account);
      accountIdByEmail.set(account.email, account.id);
    }

    const now = Date.now();
    for (const token of parsed.tokens ?? []) {
      if (!token || typeof token.userId !== "string") continue;
      // Expired tokens are simply not restored.
      if (Date.parse(token.expiresAt) <= now) continue;

      // Only hashed sessions are restored. A file written before tokens were
      // hashed holds them in the clear, and those are dropped rather than
      // migrated: hashing one on load would keep a credential alive that has
      // already been sitting readable on disk, which is the thing this change
      // exists to stop. The cost is that everyone signed in at the time of the
      // upgrade signs in again once.
      if (typeof token.tokenHash !== "string") continue;
      tokens.set(token.tokenHash, token);
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
      schema: accountsSchema,
      accounts: [...accountsById.values()],
      tokens: [...tokens.values()]
    };
    mkdirSync(path.dirname(accountsFilePath), { recursive: true });
    const tempPath = `${accountsFilePath}.tmp`;
    assertProtectedJsonWritable(accountsFilePath);
    keepPreUpgradeCopy();
    writeProtectedJsonFile(tempPath, payload);
    renameSync(tempPath, accountsFilePath);
    loadedSchema = accountsSchema;
  } catch {
    // Durability loss must not fail the request.
  }
}

/**
 * A new session.
 *
 * Returns the token to hand to the caller alongside the record that is kept.
 * The plain token exists only in this return value and in the response — it is
 * never stored, so it cannot be read back out of the file later.
 */
function issueToken(userId: string): { token: string; record: StoredToken } {
  const token = randomBytes(32).toString("hex");
  const record: StoredToken = {
    tokenHash: hashToken(token),
    userId,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + tokenLifetimeMs).toISOString()
  };
  tokens.set(record.tokenHash, record);
  return { token, record };
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
    status: "active",
    emailVerifiedAt: null,
    // Registering signs the person in, so this is their first sign-in too.
    lastLoginAt: new Date().toISOString(),
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
    expiresAt: token.record.expiresAt,
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

  // After the code has been checked, so a suspended account answers in the same
  // time and the same words as a wrong code, and the code is not spent.
  if (account.status === "suspended") return rejection;

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
    expiresAt: replacement.record.expiresAt
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

  // Said only to someone who knew the password, so it tells nobody else which
  // addresses have accounts.
  if (account.status === "suspended") {
    return { ok: false, suspended: true, error: "This account is suspended. Ask whoever runs this copy of TRH AI." };
  }

  account.lastLoginAt = new Date().toISOString();
  const token = issueToken(account.id);
  saveToDisk();
  return { ok: true, account: publicView(account), token: token.token, expiresAt: token.record.expiresAt };
}

/** Resolve a bearer token to an account, or null when absent/expired/unknown. */
export function accountForToken(token: unknown): Account | null {
  loadFromDisk();
  if (typeof token !== "string" || !token) return null;

  const record = tokens.get(hashToken(token));
  if (!record) return null;

  if (Date.parse(record.expiresAt) <= Date.now()) {
    tokens.delete(hashToken(token));
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
  const record = token ? tokens.get(hashToken(token)) : undefined;
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
    expiresAt: replacement.record.expiresAt
  };
}

export function logout(token: unknown): boolean {
  loadFromDisk();
  if (typeof token !== "string") return false;
  const key = hashToken(token);
  if (!tokens.has(key)) return false;
  tokens.delete(key);
  saveToDisk();
  return true;
}

// ------------------------------------------------------- looking after accounts
//
// What an administrator does with the accounts a service holds. None of it
// decides WHO may do it - that is access.ts - and none of it can reach a
// password: a listing carries no hash, no token and no recovery code.

/** One account as an administrator sees it. */
export type AccountListing = Account & { storedRole: Role; sessionCount: number };

export type ChangeResult = { ok: true; account: Account } | { ok: false; error: string };

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.trunc(number))) : fallback;
}

function listingOf(account: StoredAccount, now: number): AccountListing {
  let sessionCount = 0;
  for (const token of tokens.values()) {
    if (token.userId === account.id && Date.parse(token.expiresAt) > now) sessionCount += 1;
  }
  return { ...publicView(account), storedRole: account.role ?? "user", sessionCount };
}

/** Accounts by email, name-sorted, a page at a time. `query` matches part of an email or a display name. */
export function listAccounts(options: { query?: unknown; limit?: unknown; offset?: unknown } = {}): { total: number; accounts: AccountListing[] } {
  loadFromDisk();
  const query = typeof options.query === "string" ? options.query.trim().toLowerCase() : "";
  const limit = clampInt(options.limit, 50, 1, 200);
  const offset = clampInt(options.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const matching = [...accountsById.values()]
    .filter((account) => !query || account.email.includes(query) || account.displayName.toLowerCase().includes(query))
    .sort((a, b) => a.email.localeCompare(b.email));
  const now = Date.now();
  return { total: matching.length, accounts: matching.slice(offset, offset + limit).map((account) => listingOf(account, now)) };
}

export function findAccount(id: unknown): Account | null {
  loadFromDisk();
  const account = typeof id === "string" ? accountsById.get(id) : undefined;
  return account ? publicView(account) : null;
}

/** The role the service has recorded for an account. Whether it counts is access.ts's call. */
export function storedRoleOf(accountId: string): Role {
  loadFromDisk();
  return accountsById.get(accountId)?.role ?? "user";
}

function dropSessions(accountId: string): number {
  let dropped = 0;
  for (const [key, stored] of [...tokens.entries()]) {
    if (stored.userId === accountId) {
      tokens.delete(key);
      dropped += 1;
    }
  }
  return dropped;
}

/** Ends every session an account has, so each device must sign in again. Null when there is no such account. */
export function revokeSessions(id: unknown): number | null {
  loadFromDisk();
  const account = typeof id === "string" ? accountsById.get(id) : undefined;
  if (!account) return null;
  const dropped = dropSessions(account.id);
  if (dropped > 0) saveToDisk();
  return dropped;
}

/** Suspending also ends the sessions: a suspended account that stays signed in is not suspended. */
export function setAccountStatus(id: unknown, status: AccountStatus): ChangeResult {
  loadFromDisk();
  const account = typeof id === "string" ? accountsById.get(id) : undefined;
  if (!account) return { ok: false, error: "No such account" };
  account.status = status;
  if (status === "suspended") dropSessions(account.id);
  saveToDisk();
  return { ok: true, account: publicView(account) };
}

/** Administrator or ordinary user. The owner is never set here: ownership moves by assignOwner. */
export function setStoredRole(id: unknown, role: "admin" | "user"): ChangeResult {
  loadFromDisk();
  const account = typeof id === "string" ? accountsById.get(id) : undefined;
  if (!account) return { ok: false, error: "No such account" };
  if (account.role === "owner") return { ok: false, error: "The owner's role changes only by handing ownership to someone else" };
  account.role = role;
  saveToDisk();
  return { ok: true, account: publicView(account) };
}

/** The account the service has recorded as its owner, if any. */
export function ownerAccount(): Account | null {
  loadFromDisk();
  for (const account of accountsById.values()) {
    if (account.role === "owner") return publicView(account);
  }
  return null;
}

/**
 * Makes one account the owner. There is one owner: a second needs `transfer`,
 * which makes the old owner an administrator in the same step, so the service is
 * never without an owner and never has two. The only callers are the ones that
 * run on the host itself (a setup script with shell access to the server) -
 * nothing a signed-in person can reach over the network ends here.
 */
export function assignOwner(id: unknown, options: { transfer?: boolean } = {}): ChangeResult {
  loadFromDisk();
  const account = typeof id === "string" ? accountsById.get(id) : undefined;
  if (!account) return { ok: false, error: "No such account" };
  if (account.status === "suspended") return { ok: false, error: "A suspended account cannot become the owner" };
  const current = [...accountsById.values()].find((candidate) => candidate.role === "owner");
  if (current && current.id !== account.id) {
    if (!options.transfer) return { ok: false, error: "There is already an owner. Hand ownership over explicitly to change it" };
    current.role = "admin";
  }
  account.role = "owner";
  saveToDisk();
  return { ok: true, account: publicView(account) };
}

/** Bearer token from an Authorization header, if present. */
export function bearerToken(headerValue: unknown): string | null {
  if (typeof headerValue !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  return match ? match[1].trim() : null;
}

/** Test seam. */
export function resetAccounts(): void {
  loaded = true;
  // Nothing on disk is being kept, so there is nothing to make a copy of.
  loadedSchema = accountsSchema;
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
  loadedSchema = 0;
  loadFromDisk();
}
