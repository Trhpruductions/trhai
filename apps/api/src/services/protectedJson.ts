import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dataFile } from "./dataDirectory.js";

const algorithm = "aes-256-gcm";
const kdf = "scrypt-sha256";
const keyLength = 32;
const ivLength = 12;
const authTagLength = 16;
const lockedFiles = new Set<string>();

export class ProtectedJsonAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtectedJsonAccessError";
  }
}

export type ProtectedJsonEnvelope = {
  version: 1;
  protected: true;
  algorithm: typeof algorithm;
  kdf: typeof kdf;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
};

function isEnvelope(value: unknown): value is ProtectedJsonEnvelope {
  if (!value || typeof value !== "object") return false;
  const envelope = value as Partial<ProtectedJsonEnvelope>;
  return envelope.version === 1
    && envelope.protected === true
    && envelope.algorithm === algorithm
    && envelope.kdf === kdf
    && typeof envelope.salt === "string"
    && typeof envelope.iv === "string"
    && typeof envelope.tag === "string"
    && typeof envelope.ciphertext === "string";
}

function defaultKeyFile(): string {
  if (process.env.NODE_TEST_CONTEXT) return dataFile(".trhai-data-key");

  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) return path.join(localAppData, "TRHAI", "trhai-data.key");

  return path.join(os.homedir(), ".trhai", "trhai-data.key");
}

function readOrCreateMachineKey(): string {
  const keyFile = process.env.TRHAI_DATA_KEY_FILE ?? defaultKeyFile();
  if (existsSync(keyFile)) return readFileSync(keyFile, "utf8").trim();

  const secret = randomBytes(32).toString("base64url");
  mkdirSync(path.dirname(keyFile), { recursive: true });
  writeFileSync(keyFile, `${secret}\n`, { encoding: "utf8", mode: 0o600 });
  return secret;
}

function dataSecret(): string {
  const fromEnv = process.env.TRHAI_DATA_KEY ?? process.env.ASSIST_DATA_KEY;
  if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv.trim();
  return readOrCreateMachineKey();
}

function deriveKey(salt: Buffer): Buffer {
  return scryptSync(dataSecret(), salt, keyLength);
}

function lockPath(filePath: string): void {
  lockedFiles.add(path.resolve(filePath).toLowerCase());
}

/**
 * Which files could not be authenticated with the current key.
 *
 * Locking a file protects the data, and on its own it protects it silently.
 * Every store that reads through this helper catches the error and carries on
 * with empty state - correctly, because an unreadable file must not stop the
 * API from starting - so a key that no longer matches turns into an assistant
 * that has forgotten your memories, conversations, schedules and tasks, refuses
 * to remember anything new, and says nothing about either.
 *
 * That is the failure this codebase already learned once and wrote down: "a
 * silently swallowed write was losing memory and hiding it". The lock is the
 * right behaviour; being quiet about it is not. This is what lets the app say
 * so.
 *
 * Paths are returned as stored - resolved and lower-cased - because that is
 * what identifies the file, and the caller is reporting rather than reopening.
 */
export function lockedProtectedFiles(): string[] {
  return [...lockedFiles].sort();
}

/** True when anything at all failed to authenticate this session. */
export function hasLockedProtectedFiles(): boolean {
  return lockedFiles.size > 0;
}

export function assertProtectedJsonWritable(filePath: string): void {
  if (lockedFiles.has(path.resolve(filePath).toLowerCase())) {
    throw new ProtectedJsonAccessError(
      "Refusing to overwrite encrypted data that could not be authenticated with the current key."
    );
  }
}

export function encryptJson(value: unknown): ProtectedJsonEnvelope {
  const salt = randomBytes(16);
  const iv = randomBytes(ivLength);
  const key = deriveKey(salt);
  const cipher = createCipheriv(algorithm, key, iv, { authTagLength });
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    version: 1,
    protected: true,
    algorithm,
    kdf,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64")
  };
}

export function decryptJson(envelope: ProtectedJsonEnvelope): unknown {
  const salt = Buffer.from(envelope.salt, "base64");
  const iv = Buffer.from(envelope.iv, "base64");
  const tag = Buffer.from(envelope.tag, "base64");
  const ciphertext = Buffer.from(envelope.ciphertext, "base64");

  if (iv.length !== ivLength || tag.length !== authTagLength) {
    throw new Error("The protected JSON envelope is malformed.");
  }

  try {
    const decipher = createDecipheriv(algorithm, deriveKey(salt), iv, { authTagLength });
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ProtectedJsonAccessError(`Encrypted JSON could not be authenticated: ${reason}`);
  }
}

export function parseProtectedJson(text: string): unknown {
  const parsed = JSON.parse(text) as unknown;
  return isEnvelope(parsed) ? decryptJson(parsed) : parsed;
}

export function readProtectedJsonFile(filePath: string): unknown {
  try {
    return parseProtectedJson(readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error instanceof ProtectedJsonAccessError) lockPath(filePath);
    throw error;
  }
}

export function writeProtectedJsonFile(filePath: string, value: unknown): void {
  assertProtectedJsonWritable(filePath);
  writeFileSync(filePath, JSON.stringify(encryptJson(value), null, 2), "utf8");
}

export function protectedJsonLooksEncrypted(text: string): boolean {
  try {
    return isEnvelope(JSON.parse(text) as unknown);
  } catch {
    return false;
  }
}

export function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
