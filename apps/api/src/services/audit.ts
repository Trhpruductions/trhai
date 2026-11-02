import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { dataFile } from "./dataDirectory.js";
import { assertProtectedJsonWritable, readProtectedJsonFile, writeProtectedJsonFile } from "./protectedJson.js";

// A record of the things that change who can do what.
//
// Appended to, never edited: each entry carries the hash of the one before it,
// so taking an entry out or changing one breaks every hash after it, and
// verifyAuditChain says where. That does not stop someone with the data key from
// rewriting the whole file - nothing on a machine can - but it makes a quiet
// edit show.
//
// What goes in is who did it, to whom, and what - never a password, a token, a
// recovery code, a reset link or a license key. `detail` is a short sentence
// written by the caller, and callers pass facts ("role admin"), not secrets.

export type AuditActor =
  | { kind: "account"; id: string; email: string; role: string }
  /** Something that ran with no signed-in person: a setup script on the host, a payment event. */
  | { kind: "system"; name: string };

export type AuditAction =
  | "account.suspended"
  | "account.reactivated"
  | "account.sessions_revoked"
  | "account.password_reset_issued"
  | "account.erased"
  | "role.admin_granted"
  | "role.admin_revoked"
  | "role.owner_assigned"
  | "role.owner_transferred"
  | "invitation.created"
  | "invitation.revoked"
  | "invitation.redeemed"
  | "access.granted"
  | "access.revoked"
  | "registration.policy_changed"
  | "plans.changed"
  | "billing.event"
  | "billing.configured";

export type AuditEntry = {
  seq: number;
  at: string;
  actor: AuditActor;
  action: AuditAction;
  target: { id: string; email: string } | null;
  detail: string;
  prevHash: string;
  hash: string;
};

export type AuditInput = {
  actor: AuditActor;
  action: AuditAction;
  target?: { id: string; email: string } | null;
  detail?: string;
};

const auditFilePath = process.env.ASSIST_AUDIT_FILE ?? dataFile("audit.json");
const persistenceEnabled = process.env.ASSIST_AUDIT_PERSIST !== "off";

/** Enough to cover years of the changes an administrator makes; older entries are folded into `anchorHash`. */
const maxEntries = Number(process.env.ASSIST_AUDIT_MAX_ENTRIES) > 0 ? Number(process.env.ASSIST_AUDIT_MAX_ENTRIES) : 10_000;
const maxDetail = 200;
const genesis = "0".repeat(64);

let entries: AuditEntry[] = [];
/** The hash of the entry just before the first one kept; the genesis value until anything has been trimmed. */
let anchorHash = genesis;
let nextSeq = 1;
let loaded = false;

function hashOf(entry: Omit<AuditEntry, "hash">): string {
  return createHash("sha256")
    .update(JSON.stringify([entry.seq, entry.at, entry.actor, entry.action, entry.target, entry.detail, entry.prevHash]))
    .digest("hex");
}

function load(): void {
  if (loaded) return;
  loaded = true;
  if (!persistenceEnabled || !existsSync(auditFilePath)) return;
  try {
    const parsed = readProtectedJsonFile(auditFilePath) as { entries?: AuditEntry[]; anchorHash?: string };
    entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    anchorHash = typeof parsed.anchorHash === "string" ? parsed.anchorHash : genesis;
    nextSeq = entries.length ? entries[entries.length - 1].seq + 1 : 1;
  } catch {
    // An unreadable record is not the same as an empty one: keep going without
    // it, but say so, because the next write replaces the file.
    console.warn(`[audit] could not read ${auditFilePath}; starting a new record`);
  }
}

function save(): void {
  if (!persistenceEnabled) return;
  try {
    mkdirSync(path.dirname(auditFilePath), { recursive: true });
    const tempPath = `${auditFilePath}.tmp`;
    assertProtectedJsonWritable(auditFilePath);
    writeProtectedJsonFile(tempPath, { version: 1, anchorHash, entries });
    renameSync(tempPath, auditFilePath);
  } catch (error) {
    console.warn(`[audit] could not write ${auditFilePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Adds one entry and returns it. */
export function recordAudit(input: AuditInput, at: Date = new Date()): AuditEntry {
  load();
  const prevHash = entries.length ? entries[entries.length - 1].hash : anchorHash;
  const body: Omit<AuditEntry, "hash"> = {
    seq: nextSeq,
    at: at.toISOString(),
    actor: input.actor,
    action: input.action,
    target: input.target ?? null,
    detail: (input.detail ?? "").slice(0, maxDetail),
    prevHash
  };
  const entry: AuditEntry = { ...body, hash: hashOf(body) };
  nextSeq += 1;
  entries.push(entry);
  while (entries.length > maxEntries) {
    anchorHash = (entries.shift() as AuditEntry).hash;
  }
  save();
  return entry;
}

/** Newest first. `before` is a sequence number: the entries older than it. */
export function listAudit(options: { limit?: unknown; before?: unknown } = {}): { entries: AuditEntry[]; total: number } {
  load();
  const limit = typeof options.limit === "number" && Number.isFinite(options.limit) ? Math.min(500, Math.max(1, Math.trunc(options.limit))) : 100;
  const before = typeof options.before === "number" && Number.isFinite(options.before) ? options.before : Infinity;
  const older = entries.filter((entry) => entry.seq < before);
  return { entries: older.slice(-limit).reverse(), total: entries.length };
}

export type ChainCheck = { ok: true; count: number } | { ok: false; brokenAtSeq: number };

/** Walks the record from its start. Fails at the first entry that does not follow from the one before it. */
export function verifyAuditChain(): ChainCheck {
  load();
  let previous = anchorHash;
  for (const entry of entries) {
    const { hash, ...body } = entry;
    if (entry.prevHash !== previous || hashOf(body) !== hash) return { ok: false, brokenAtSeq: entry.seq };
    previous = hash;
  }
  return { ok: true, count: entries.length };
}

/** What stands where an erased person's email address was. */
export const erasedAddress = "(erased)";

export type RedactResult = { ok: true; redacted: number } | { ok: false; reason: string };

/**
 * Takes a person's email address out of the record, for erasing their account.
 *
 * The record is append-only and each entry is bound to the one before it, so this
 * is the one edit it allows, and it is allowed only on a record that is whole: a
 * chain that already fails is left alone, because re-binding it would hide the
 * failure. Entries keep who did what, to which account id, and when; only the
 * address goes. The chain is then bound again from the first entry, and the
 * redaction is written into the record as an entry of its own, so an edit made
 * for a reason shows as that edit and not as a quiet one.
 */
export function redactAuditSubject(accountId: string, at: Date = new Date()): RedactResult {
  load();
  const check = verifyAuditChain();
  if (!check.ok) return { ok: false, reason: `the record fails its own check at entry ${check.brokenAtSeq}, so it was not edited` };
  let redacted = 0;
  for (const entry of entries) {
    let touched = false;
    if (entry.actor.kind === "account" && entry.actor.id === accountId && entry.actor.email !== erasedAddress) {
      entry.actor = { ...entry.actor, email: erasedAddress };
      touched = true;
    }
    if (entry.target && entry.target.id === accountId && entry.target.email !== erasedAddress) {
      entry.target = { ...entry.target, email: erasedAddress };
      touched = true;
    }
    if (touched) redacted += 1;
  }
  // Bound again from the start even when nothing changed: the result is then the same chain.
  let previous = anchorHash;
  for (const entry of entries) {
    entry.prevHash = previous;
    const { hash: _previousHash, ...body } = entry;
    entry.hash = hashOf(body);
    previous = entry.hash;
  }
  save();
  recordAudit({
    actor: { kind: "system", name: "account erasure" },
    action: "account.erased",
    target: { id: accountId, email: erasedAddress },
    detail: redacted === 0 ? "erased at the person's request; no earlier entry named the address"
      : `erased at the person's request; the email address was taken out of ${redacted} earlier entr${redacted === 1 ? "y" : "ies"}`
  }, at);
  return { ok: true, redacted };
}

/** Test seam. */
export function resetAuditForTests(): void {
  entries = [];
  anchorHash = genesis;
  nextSeq = 1;
  loaded = true;
  save();
}

/** Test seam: forget what is in memory and read the file again, as a restart would. */
export function reloadAuditFromDisk(): void {
  entries = [];
  anchorHash = genesis;
  nextSeq = 1;
  loaded = false;
  load();
}

/** Test seam: the entries as held, for a test that edits one to show the chain notices. */
export function auditEntriesForTests(): AuditEntry[] {
  load();
  return entries;
}
