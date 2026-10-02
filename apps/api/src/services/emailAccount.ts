import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { dataFile } from "./dataDirectory.js";
import { assertProtectedJsonWritable, readProtectedJsonFile, writeProtectedJsonFile } from "./protectedJson.js";

// The user's own email account, for sending email from this machine.
//
// No email service sits in between and nothing needs an API key: mail goes
// out through the account's own SMTP server, signed in with the account's own
// app password, the same way a desktop mail program sends it. The password is
// kept in the protected store (encrypted with this machine's key, like memory
// and conversations) and is never returned by the API - the settings screen is
// told only that one is saved.
//
// One account per machine. TRH AI is a personal app on one PC, and a second
// account would need a way to choose between them that nothing here has yet.

export type EmailAccount = {
  address: string;
  /** Sign-in name for the server, when it is not the address itself. */
  username?: string;
  password: string;
  host: string;
  port: number;
  /** True for TLS from the first byte (465); false upgrades with STARTTLS (587). */
  secure: boolean;
  /** The name shown beside the address in the recipient's inbox. */
  fromName?: string;
  savedAt: string;
};

/** What the settings screen may see: everything but the password. */
export type EmailAccountView =
  | { configured: false }
  | {
    configured: true;
    address: string;
    username?: string;
    host: string;
    port: number;
    secure: boolean;
    fromName?: string;
    provider?: string;
    savedAt: string;
  };

export type EmailProvider = {
  name: string;
  domains: string[];
  host: string;
  port: number;
  secure: boolean;
  /** How to get the password this server accepts, in one sentence. */
  passwordHelp: string;
};

/**
 * Servers for the common providers, so an address is usually all it takes.
 *
 * Each of these refuses the account's ordinary password from another program
 * and wants an app password instead - the help line says where to make one,
 * because "the password was refused" with no next step is a dead end.
 */
export const knownProviders: EmailProvider[] = [
  {
    name: "Gmail", domains: ["gmail.com", "googlemail.com"], host: "smtp.gmail.com", port: 465, secure: true,
    passwordHelp: "Use an app password, not your Google password: Google Account > Security > 2-Step Verification > App passwords."
  },
  {
    name: "Yahoo Mail", domains: ["yahoo.com", "ymail.com", "rocketmail.com"], host: "smtp.mail.yahoo.com", port: 465, secure: true,
    passwordHelp: "Use an app password: Yahoo Account Security > Generate app password."
  },
  {
    name: "iCloud Mail", domains: ["icloud.com", "me.com", "mac.com"], host: "smtp.mail.me.com", port: 587, secure: false,
    passwordHelp: "Use an app-specific password from appleid.apple.com > Sign-In and Security."
  },
  {
    name: "AOL Mail", domains: ["aol.com"], host: "smtp.aol.com", port: 465, secure: true,
    passwordHelp: "Use an app password: AOL Account Security > Generate app password."
  },
  {
    name: "Outlook.com", domains: ["outlook.com", "hotmail.com", "live.com", "msn.com"], host: "smtp-mail.outlook.com", port: 587, secure: false,
    passwordHelp: "Microsoft may refuse passwords from other programs for Outlook.com; if the test fails, emails can still open in your mail app instead."
  },
  {
    name: "Zoho Mail", domains: ["zoho.com", "zohomail.com"], host: "smtp.zoho.com", port: 465, secure: true,
    passwordHelp: "Use an app-specific password from Zoho Accounts > Security."
  },
  {
    name: "GMX", domains: ["gmx.com", "gmx.net", "gmx.de"], host: "mail.gmx.com", port: 587, secure: false,
    passwordHelp: "Turn on POP3/IMAP access in GMX's settings first, then use your GMX password."
  }
];

const emailPattern = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;
const hostPattern = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

export function looksLikeEmailAddress(value: unknown): value is string {
  return typeof value === "string" && emailPattern.test(value.trim());
}

/** The provider an address belongs to, by its domain, or null for any other. */
export function providerFor(address: string): EmailProvider | null {
  const domain = address.trim().toLowerCase().split("@")[1] ?? "";
  return knownProviders.find((provider) => provider.domains.includes(domain)) ?? null;
}

const accountFilePath = process.env.ASSIST_EMAIL_ACCOUNT_FILE ?? dataFile("email-account.json");
const persistenceEnabled = process.env.ASSIST_EMAIL_ACCOUNT_PERSIST !== "off";

let account: EmailAccount | null = null;
let loaded = false;

function isAccount(value: unknown): value is EmailAccount {
  const candidate = value as Partial<EmailAccount> | null;
  return Boolean(candidate) && looksLikeEmailAddress(candidate?.address) && typeof candidate?.password === "string"
    && typeof candidate?.host === "string" && typeof candidate?.port === "number" && typeof candidate?.secure === "boolean";
}

function loadFromDisk(): void {
  if (loaded) return;
  loaded = true;
  if (!persistenceEnabled || !existsSync(accountFilePath)) return;
  try {
    const stored = readProtectedJsonFile(accountFilePath);
    account = isAccount(stored) ? stored : null;
  } catch {
    // An unreadable file must never take the API down; the account reads as
    // not set up, and the settings screen offers to add it again.
  }
}

function saveToDisk(): void {
  if (!persistenceEnabled) return;
  const tempPath = `${accountFilePath}.tmp`;
  try {
    mkdirSync(path.dirname(accountFilePath), { recursive: true });
    if (account) {
      assertProtectedJsonWritable(accountFilePath);
      writeProtectedJsonFile(tempPath, account);
      renameSync(tempPath, accountFilePath);
    } else {
      rmSync(accountFilePath, { force: true });
    }
  } catch (error) {
    console.error(`email account could not be saved: ${error instanceof Error ? error.message : String(error)}`);
    try { rmSync(tempPath, { force: true }); } catch { /* nothing more to do */ }
  }
}

/** The saved account, password included. For sending only - never for a reply. */
export function readEmailAccount(): EmailAccount | null {
  loadFromDisk();
  return account ? { ...account } : null;
}

export function describeEmailAccount(): EmailAccountView {
  loadFromDisk();
  if (!account) return { configured: false };
  const provider = providerFor(account.address);
  return {
    configured: true,
    address: account.address,
    ...(account.username ? { username: account.username } : {}),
    host: account.host,
    port: account.port,
    secure: account.secure,
    ...(account.fromName ? { fromName: account.fromName } : {}),
    ...(provider ? { provider: provider.name } : {}),
    savedAt: account.savedAt
  };
}

/**
 * Saves the account from what the settings form sent.
 *
 * The password may be left out when the address is unchanged, which keeps the
 * one already saved - so changing the display name does not mean typing the
 * app password again. The server comes from the provider list when the form
 * names none, and must be given for any other provider.
 */
export function saveEmailAccount(input: unknown, now = new Date()): { ok: true; account: EmailAccountView } | { ok: false; message: string } {
  loadFromDisk();
  const body = (input ?? {}) as Record<string, unknown>;
  const address = typeof body.address === "string" ? body.address.trim() : "";
  if (!looksLikeEmailAddress(address)) return { ok: false, message: "Enter the email address to send from." };

  const typedPassword = typeof body.password === "string" ? body.password : "";
  const keepsPassword = !typedPassword && account?.address.toLowerCase() === address.toLowerCase();
  const password = keepsPassword ? account!.password : typedPassword;
  if (!password) return { ok: false, message: "Enter the app password for this account." };
  if (password.length > 512) return { ok: false, message: "That password is too long." };

  const provider = providerFor(address);
  const host = typeof body.host === "string" && body.host.trim() ? body.host.trim().toLowerCase() : provider?.host ?? "";
  if (!host) return { ok: false, message: "This provider is not one TRH AI knows. Enter its SMTP server (for example smtp.example.com) and port." };
  if (!hostPattern.test(host)) return { ok: false, message: `"${host}" is not a server name.` };

  const port = body.port === undefined || body.port === null || body.port === ""
    ? provider?.port ?? 587
    : Number(body.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, message: "The port must be a number from 1 to 65535." };

  const secure = typeof body.secure === "boolean" ? body.secure : provider && host === provider.host ? provider.secure : port === 465;
  const username = typeof body.username === "string" && body.username.trim() ? body.username.trim().slice(0, 254) : undefined;
  const fromName = typeof body.fromName === "string" && body.fromName.trim()
    ? body.fromName.trim().replace(/[\r\n"<>]/g, "").slice(0, 80)
    : undefined;

  account = {
    address,
    ...(username && username.toLowerCase() !== address.toLowerCase() ? { username } : {}),
    password,
    host,
    port,
    secure,
    ...(fromName ? { fromName } : {}),
    savedAt: now.toISOString()
  };
  saveToDisk();
  return { ok: true, account: describeEmailAccount() };
}

/** Forgets the account and its password. Returns false when none was saved. */
export function removeEmailAccount(): boolean {
  loadFromDisk();
  if (!account) return false;
  account = null;
  saveToDisk();
  return true;
}

/** Test seam: no account, in memory or on disk (a test's own data directory). */
export function resetEmailAccountForTests(): void {
  account = null;
  loaded = true;
  if (persistenceEnabled) rmSync(accountFilePath, { force: true });
}
