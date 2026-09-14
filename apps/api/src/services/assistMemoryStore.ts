import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { extractMemoryCandidates, suppressDuplicateMemories, type MemoryCandidate } from "./memoryExtraction.js";
import { statesFact, subjectOf } from "./factWording.js";
import { dataFile } from "./dataDirectory.js";
import { assertProtectedJsonWritable, readProtectedJsonFile, writeProtectedJsonFile } from "./protectedJson.js";

// Memory for the `/v1/assist` endpoint.
//
// `/v1/assist` is the only endpoint the web client calls and it has no workspace
// concept, so memories are held per session key rather than per workspace. This is
// intentionally a separate store from the workspace-scoped one in v1Memory.ts: that
// store is reachable only through authenticated workspace routes, and quietly
// writing anonymous memories into it would cross a permission boundary.

export type StoredMemory = {
  id: string;
  title: string;
  body: string;
  kind: MemoryCandidate["kind"];
  confidence: number;
  rule: string;
  createdAt: string;
  /** Pinned entries rank first in retrieval and are never evicted. */
  pinned: boolean;
  /** Set when the user renames the entry, so extraction never overwrites intent. */
  editedAt?: string;
};

export type MemoryAuditAction = "recorded" | "pinned" | "unpinned" | "relabeled" | "forgotten" | "cleared";

export type MemoryAuditEntry = {
  id: string;
  sessionKey: string;
  memoryId: string | null;
  action: MemoryAuditAction;
  detail: string;
  createdAt: string;
};

/** Cap per session so an anonymous caller cannot grow memory without bound. */
export const maxMemoriesPerSession = 50;
/** How many memories are fed back into a single reply. */
export const memoryRetrievalLimit = 5;
/** The endpoint is unauthenticated, so session count is capped too. */
export const maxTrackedSessions = 500;

/** E4-S2: control actions are auditable. Capped so it cannot grow without bound. */
export const maxAuditEntries = 500;

// Insertion-ordered, so evicting the first key drops the least recently created.
const memoriesBySession = new Map<string, StoredMemory[]>();
const auditLog: MemoryAuditEntry[] = [];

// ---------------------------------------------------------------------------
// Persistence
//
// Memory that vanishes on restart is not memory. State is mirrored to a JSON
// file using only the standard library — no database and no new dependency.
// Writes go through a temp file and a rename so a crash mid-write cannot leave
// a truncated file behind.
// ---------------------------------------------------------------------------

const memoryFilePath = process.env.ASSIST_MEMORY_FILE
  ?? dataFile("assist-memory.json");

let loaded = false;
/** Disabled in tests that assert in-memory behaviour without touching disk. */
let persistenceEnabled = process.env.ASSIST_MEMORY_PERSIST !== "off";

type PersistedShape = {
  version: 1;
  sessions: Array<{ key: string; memories: StoredMemory[] }>;
  audit: MemoryAuditEntry[];
  /** What each session has asked to forget; see forgottenBySession. Absent in older files. */
  forgotten?: Array<{ key: string; facts: string[] }>;
};

function isStoredMemory(value: unknown): value is StoredMemory {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<StoredMemory>;
  return typeof entry.id === "string"
    && typeof entry.title === "string"
    && typeof entry.body === "string"
    && typeof entry.createdAt === "string";
}

function loadFromDisk(): void {
  if (loaded) return;
  loaded = true;
  if (!persistenceEnabled || !existsSync(memoryFilePath)) return;

  try {
    const parsed = readProtectedJsonFile(memoryFilePath) as Partial<PersistedShape>;
    if (!Array.isArray(parsed.sessions)) return;

    for (const session of parsed.sessions) {
      if (!session || typeof session.key !== "string" || !Array.isArray(session.memories)) continue;
      // Stored data is only as trustworthy as the file; drop anything malformed
      // rather than letting a hand-edited file crash retrieval later.
      const memories = session.memories.filter(isStoredMemory).map((entry) => ({
        ...entry,
        pinned: Boolean(entry.pinned)
      }));
      if (memories.length) memoriesBySession.set(session.key, memories);
    }

    if (Array.isArray(parsed.forgotten)) {
      for (const entry of parsed.forgotten) {
        if (!entry || typeof entry.key !== "string" || !Array.isArray(entry.facts)) continue;
        const facts = entry.facts.filter((fact): fact is string => typeof fact === "string" && fact.trim().length > 0);
        if (facts.length) forgottenBySession.set(entry.key, facts.slice(-maxForgottenPerSession));
      }
    }

    if (Array.isArray(parsed.audit)) {
      auditLog.push(...parsed.audit.filter((entry): entry is MemoryAuditEntry =>
        Boolean(entry) && typeof entry === "object" && typeof (entry as MemoryAuditEntry).id === "string"));
    }
  } catch {
    // A corrupt file must never take the API down; start clean instead.
  }
}

/**
 * The last time persisting failed, and why. Null when the last write worked.
 *
 * Exists because the alternative was worse: this used to swallow every error
 * with no trace at all, so a machine that had silently stopped saving looked
 * exactly like one that was working. A save that fails must still not take
 * the request down — but it must be knowable.
 */
let lastPersistError: string | null = null;

export function memoryPersistenceError(): string | null {
  return lastPersistError;
}

/**
 * How many times to attempt the atomic rename.
 *
 * On Windows a rename over an existing file fails with EPERM or EBUSY while
 * anything else holds a handle on the target — a virus scanner, the indexer,
 * or another process reading it. It is transient and clears in milliseconds.
 * Caught as a genuinely intermittent test failure under the parallel load of
 * the full workspace suite: memory held a pinned flag that disk did not,
 * because the write had quietly failed and nothing said so.
 */
const persistAttempts = 3;

function saveToDisk(): void {
  if (!persistenceEnabled) return;

  const payload: PersistedShape = {
    version: 1,
    sessions: [...memoriesBySession.entries()].map(([key, memories]) => ({ key, memories })),
    audit: auditLog,
    forgotten: [...forgottenBySession.entries()].map(([key, facts]) => ({ key, facts }))
  };
  const tempPath = `${memoryFilePath}.tmp`;

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= persistAttempts; attempt += 1) {
    try {
      mkdirSync(path.dirname(memoryFilePath), { recursive: true });
      assertProtectedJsonWritable(memoryFilePath);
      writeProtectedJsonFile(tempPath, payload);
      renameSync(tempPath, memoryFilePath);
      lastPersistError = null;
      return;
    } catch (error) {
      lastError = error;
      // Deliberately a spin rather than a timer: this function is synchronous
      // and every caller depends on the write having happened by the time it
      // returns. A few milliseconds is enough for a transient lock to clear,
      // and this path is rare.
      const until = Date.now() + attempt * 5;
      while (Date.now() < until) { /* brief backoff */ }
    }
  }

  // Still not the place to throw — losing durability is bad, taking the
  // request down with it is worse. But it is recorded and said out loud,
  // rather than vanishing.
  lastPersistError = lastError instanceof Error ? lastError.message : String(lastError);
  console.error(`assist memory could not be saved after ${persistAttempts} attempts: ${lastPersistError}`);

  // A half-written temp file left behind would be the next reader's problem.
  try { rmSync(tempPath, { force: true }); } catch { /* nothing more to do */ }
}

function recordAudit(
  sessionKey: string,
  memoryId: string | null,
  action: MemoryAuditAction,
  detail: string
): void {
  auditLog.push({
    id: globalThis.crypto.randomUUID(),
    sessionKey,
    memoryId,
    action,
    detail,
    createdAt: new Date().toISOString()
  });

  if (auditLog.length > maxAuditEntries) {
    auditLog.splice(0, auditLog.length - maxAuditEntries);
  }
}

/** Newest first. Scoped to a session when a key is given. */
export function getMemoryAudit(sessionKey?: string, limit = 50): MemoryAuditEntry[] {
  loadFromDisk();
  const scoped = sessionKey ? auditLog.filter((entry) => entry.sessionKey === sessionKey) : auditLog;
  return scoped.slice(-limit).reverse();
}

function evictOldestSessionIfNeeded(): void {
  while (memoriesBySession.size > maxTrackedSessions) {
    const oldestKey = memoriesBySession.keys().next().value;
    if (oldestKey === undefined) {
      return;
    }
    memoriesBySession.delete(oldestKey);
    forgottenBySession.delete(oldestKey);
  }
}

/**
 * Extract memories from a message and persist the ones that are actually new.
 * Returns only what was written, so callers can report real counts.
 */
export function recordMemoriesFromMessage(sessionKey: string, message: string): StoredMemory[] {
  loadFromDisk();

  // A correction is a fact with a lead-in, and it replaces what it corrects.
  //
  // "remember that my api port is 8080", then "actually correction: my api
  // port is 9090", then "what is my api port?" answered 8080. The correction
  // matched no extraction rule - it does not open with "remember" and is not
  // a preference or a convention - so it was absorbed with "Got it." and
  // never written. The user had corrected the assistant in plain words and
  // been ignored for it. With the lead-in stripped it is read as an explicit
  // fact, and any stored memory sharing its subject ("my api port") is
  // superseded rather than kept alongside as a contradiction.
  const corrected = correctionRemainder(message);
  const candidates = extractMemoryCandidates(corrected === null ? message : `remember that ${corrected}`);
  if (candidates.length === 0) {
    return [];
  }

  if (corrected !== null) {
    const subjects = candidates
      .map((candidate) => subjectOf(candidate.body))
      .filter((subject): subject is string => subject !== null);
    const current = memoriesBySession.get(sessionKey) ?? [];
    const superseded = current.filter((entry) => subjects.includes(subjectOf(entry.body) ?? ""));
    if (superseded.length > 0) {
      memoriesBySession.set(sessionKey, current.filter((entry) => !superseded.includes(entry)));
      for (const old of superseded) {
        recordAudit(sessionKey, old.id, "forgotten", `Replaced by a correction: ${old.body}`);
      }
    }
  }

  const existing = memoriesBySession.get(sessionKey) ?? [];
  const fresh = suppressDuplicateMemories(candidates, existing.map((entry) => entry.body));
  if (fresh.length === 0) {
    return [];
  }

  const now = new Date().toISOString();
  const stored: StoredMemory[] = fresh.map((candidate) => ({
    id: globalThis.crypto.randomUUID(),
    title: candidate.title,
    body: candidate.body,
    kind: candidate.kind,
    confidence: candidate.confidence,
    rule: candidate.rule,
    createdAt: now,
    pinned: false
  }));

  memoriesBySession.set(sessionKey, applyCap([...existing, ...stored]));
  unforget(sessionKey, stored.map((entry) => entry.body));
  evictOldestSessionIfNeeded();

  for (const entry of stored) {
    recordAudit(sessionKey, entry.id, "recorded", `Recorded via ${entry.rule}: ${entry.title}`);
  }

  saveToDisk();
  return stored;
}

const correctionLeads = [
  "actually correction:", "actually correction,", "correction:", "correction,", "correction -",
  "actually,", "actually:", "actually ", "no,", "no -", "no:", "that's wrong,", "that's wrong:",
  "thats wrong,", "that is wrong,", "update:", "update -", "scratch that,", "scratch that:",
  "scratch that -", "i meant "
];

/** The fact after a correction lead-in, or null when the message is not one. */
function correctionRemainder(message: string): string | null {
  const lower = message.trim().toLowerCase();
  for (const lead of correctionLeads) {
    if (lower.startsWith(lead)) {
      const rest = message.trim().slice(lead.length).trim().replace(/^[:,\-]+\s*/, "").trim();
      // Only a remainder that states something is a correction. "no, keep
      // it" - the answer to an offer to delete a memory - opens with the
      // same "no," and was saved as the memory "keep it". A fact gives a
      // subject a value; an answer does not.
      return rest.length > 0 && subjectOf(rest) !== null ? rest : null;
    }
  }
  return null;
}

/** Why a single explicit save wrote nothing, or that it wrote something. */
export type SaveOutcome =
  | { status: "saved"; memory: StoredMemory }
  | { status: "duplicate" }
  | { status: "empty" };

/**
 * Save one fact stated directly (the "remember" tool), distinguishing why a
 * zero-write outcome happened.
 *
 * recordMemoriesFromMessage collapses both zero-write cases to `[]`, which is
 * the right contract for its own caller — nothing there depends on knowing
 * why. It is the wrong contract for a tool reporting back to a model: a
 * remember call on a fact that is already saved is not a failure, and telling
 * the model "the save did not go through" for it is untrue. That happened
 * live — told a fact was already saved and told explicitly not to save it
 * again, the model called remember on it anyway, and the honest-sounding
 * failure message was in fact wrong.
 */
export function recordSingleMemory(sessionKey: string, fact: string): SaveOutcome {
  loadFromDisk();
  const candidates = extractMemoryCandidates(`remember that ${fact}`);
  // A defensive fallback rather than a path exercised today: the
  // explicit-remember rule matches almost anything once it is framed as
  // "remember that X", and the only real caller (the remember tool) already
  // rejects a blank fact before this is reached. Kept in case that changes.
  if (candidates.length === 0) return { status: "empty" };

  const existing = memoriesBySession.get(sessionKey) ?? [];
  const fresh = suppressDuplicateMemories(candidates, existing.map((entry) => entry.body));
  if (fresh.length === 0) return { status: "duplicate" };

  const now = new Date().toISOString();
  const stored: StoredMemory = {
    id: globalThis.crypto.randomUUID(),
    title: fresh[0].title,
    body: fresh[0].body,
    kind: fresh[0].kind,
    confidence: fresh[0].confidence,
    rule: fresh[0].rule,
    createdAt: now,
    pinned: false
  };

  memoriesBySession.set(sessionKey, applyCap([...existing, stored]));
  unforget(sessionKey, [stored.body]);
  evictOldestSessionIfNeeded();
  recordAudit(sessionKey, stored.id, "recorded", `Recorded via ${stored.rule}: ${stored.title}`);
  saveToDisk();

  return { status: "saved", memory: stored };
}

/**
 * Trim to the cap by dropping the oldest *unpinned* entries. Pinning is an explicit
 * user instruction to keep something, so eviction must never override it.
 */
function applyCap(entries: StoredMemory[]): StoredMemory[] {
  if (entries.length <= maxMemoriesPerSession) {
    return entries;
  }

  const result = [...entries];
  let overflow = result.length - maxMemoriesPerSession;

  for (let index = 0; index < result.length && overflow > 0; ) {
    if (result[index].pinned) {
      index += 1;
      continue;
    }
    result.splice(index, 1);
    overflow -= 1;
  }

  // If everything is pinned the cap yields to the user's explicit intent.
  return result;
}

/**
 * Pinned entries first, then most recent. Recency is the only other signal
 * available — there is no embedding model here to rank by relevance.
 */
export function retrieveSessionMemories(
  sessionKey: string,
  limit: number = memoryRetrievalLimit
): StoredMemory[] {
  loadFromDisk();
  const entries = memoriesBySession.get(sessionKey) ?? [];
  const newestFirst = [...entries].reverse();
  const pinned = newestFirst.filter((entry) => entry.pinned);
  const unpinned = newestFirst.filter((entry) => !entry.pinned);
  return [...pinned, ...unpinned].slice(0, limit);
}

/** Newest first, for the memory controls UI. */
export function listSessionMemories(sessionKey: string): StoredMemory[] {
  loadFromDisk();
  const entries = memoriesBySession.get(sessionKey) ?? [];
  const newestFirst = [...entries].reverse();
  const pinned = newestFirst.filter((entry) => entry.pinned);
  const unpinned = newestFirst.filter((entry) => !entry.pinned);
  return [...pinned, ...unpinned];
}

export function setMemoryPinned(sessionKey: string, memoryId: string, pinned: boolean): StoredMemory | null {
  loadFromDisk();
  const entries = memoriesBySession.get(sessionKey);
  const target = entries?.find((entry) => entry.id === memoryId);
  if (!entries || !target) {
    return null;
  }

  target.pinned = pinned;
  recordAudit(sessionKey, memoryId, pinned ? "pinned" : "unpinned", target.title);
  saveToDisk();
  return target;
}

export const maxMemoryTitleLength = 120;

export function relabelMemory(sessionKey: string, memoryId: string, title: string): StoredMemory | null {
  loadFromDisk();
  const entries = memoriesBySession.get(sessionKey);
  const target = entries?.find((entry) => entry.id === memoryId);
  if (!entries || !target) {
    return null;
  }

  const trimmed = title.trim();
  if (!trimmed) {
    return null;
  }

  const previous = target.title;
  target.title = trimmed.slice(0, maxMemoryTitleLength);
  target.editedAt = new Date().toISOString();
  recordAudit(sessionKey, memoryId, "relabeled", `"${previous}" -> "${target.title}"`);
  saveToDisk();
  return target;
}

/**
 * What each session has asked to forget, oldest first.
 *
 * Kept because deleting the memory was not the whole of forgetting it. The
 * composer answers from the transcript when nothing saved matches, and the
 * transcript still holds the sentence the memory was made from - so "forget
 * my api port" deleted the memory, and "what is my api port?" quoted "my api
 * port is 9090" straight back out of the conversation. A fact the user has
 * asked to forget is not quoted from anywhere until they state it again.
 */
const forgottenBySession = new Map<string, string[]>();
const maxForgottenPerSession = 50;

function recordForgotten(sessionKey: string, bodies: string[]): void {
  const current = forgottenBySession.get(sessionKey) ?? [];
  const next = [...current, ...bodies.map((body) => body.trim()).filter((body) => body.length > 0)];
  forgottenBySession.set(sessionKey, next.slice(-maxForgottenPerSession));
}

/** Stating a fact again is the end of having asked to forget it. */
function unforget(sessionKey: string, bodies: string[]): void {
  const current = forgottenBySession.get(sessionKey);
  if (!current || current.length === 0) return;

  const restated = (forgotten: string): boolean => bodies.some((body) => {
    if (statesFact(body, forgotten)) return true;
    const subject = subjectOf(body);
    return subject !== null && subject === subjectOf(forgotten);
  });
  const remaining = current.filter((forgotten) => !restated(forgotten));

  if (remaining.length === 0) forgottenBySession.delete(sessionKey);
  else forgottenBySession.set(sessionKey, remaining);
}

/** The facts this session has asked to forget and not stated since. */
export function listForgottenFacts(sessionKey: string): string[] {
  loadFromDisk();
  return [...(forgottenBySession.get(sessionKey) ?? [])];
}

/** Deletion takes effect immediately, so the next retrieval cannot return it. */
export function forgetMemory(sessionKey: string, memoryId: string): boolean {
  loadFromDisk();
  const entries = memoriesBySession.get(sessionKey);
  if (!entries) {
    return false;
  }

  const index = entries.findIndex((entry) => entry.id === memoryId);
  if (index === -1) {
    return false;
  }

  const [removed] = entries.splice(index, 1);
  recordForgotten(sessionKey, [removed.body]);
  recordAudit(sessionKey, memoryId, "forgotten", removed.title);
  saveToDisk();
  return true;
}

export function forgetAllMemories(sessionKey: string): number {
  loadFromDisk();
  const entries = memoriesBySession.get(sessionKey);
  const count = entries?.length ?? 0;
  if (count === 0) {
    return 0;
  }

  recordForgotten(sessionKey, (entries ?? []).map((entry) => entry.body));
  memoriesBySession.set(sessionKey, []);
  recordAudit(sessionKey, null, "cleared", `Cleared ${count} memories`);
  saveToDisk();
  return count;
}

/**
 * Test seam. Marks state as loaded so a reset is not immediately undone by a
 * lazy read of the file it was meant to clear.
 */
export function resetAssistMemory(sessionKey?: string): void {
  loaded = true;
  auditLog.length = 0;
  if (sessionKey) {
    memoriesBySession.delete(sessionKey);
    forgottenBySession.delete(sessionKey);
  } else {
    memoriesBySession.clear();
    forgottenBySession.clear();
  }
  saveToDisk();
}

/** Test seam: drop in-process state and re-read the file, simulating a restart. */
export function reloadAssistMemoryFromDisk(): void {
  memoriesBySession.clear();
  forgottenBySession.clear();
  auditLog.length = 0;
  loaded = false;
  loadFromDisk();
}
