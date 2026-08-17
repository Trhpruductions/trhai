import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

// Conversation storage, keyed the same way as memory: `user:<id>` when signed in,
// the anonymous session id otherwise. That is what makes a conversation follow an
// account to another browser instead of living only in localStorage.
//
// Standard library only, and the same atomic temp-file + rename discipline used
// for memory and accounts.

export type StoredTurn = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  /**
   * How the reply was produced, and by what.
   *
   * Stored because the interface labels every assistant turn with its
   * provenance, and a reloaded transcript that has lost it shows a quote from
   * the user's own notes and a sentence a model invented as the same thing.
   * Absent on user turns, and on transcripts written before this was recorded.
   */
  strategy?: string;
  model?: string;
};

/** Enough to be useful, bounded so an anonymous caller cannot grow it forever. */
export const maxTurnsPerKey = 200;
export const maxTrackedConversations = 500;
const maxContentLength = 8000;

const conversationFilePath = process.env.ASSIST_CONVERSATION_FILE
  ?? path.join(process.cwd(), "data", "conversations.json");

let persistenceEnabled = process.env.ASSIST_CONVERSATION_PERSIST !== "off";
let loaded = false;

const turnsByKey = new Map<string, StoredTurn[]>();

function isStoredTurn(value: unknown): value is StoredTurn {
  if (!value || typeof value !== "object") return false;
  const turn = value as Partial<StoredTurn>;
  return typeof turn.id === "string"
    && (turn.role === "user" || turn.role === "assistant")
    && typeof turn.content === "string"
    && typeof turn.createdAt === "string"
    // Optional, so a file written before provenance was recorded still loads.
    && (turn.strategy === undefined || typeof turn.strategy === "string")
    && (turn.model === undefined || typeof turn.model === "string");
}

function loadFromDisk(): void {
  if (loaded) return;
  loaded = true;
  if (!persistenceEnabled || !existsSync(conversationFilePath)) return;

  try {
    const parsed = JSON.parse(readFileSync(conversationFilePath, "utf8")) as {
      conversations?: Array<{ key?: unknown; turns?: unknown }>;
    };

    for (const entry of parsed.conversations ?? []) {
      if (!entry || typeof entry.key !== "string" || !Array.isArray(entry.turns)) continue;
      const turns = entry.turns.filter(isStoredTurn);
      if (turns.length) turnsByKey.set(entry.key, turns);
    }
  } catch {
    // A corrupt file must not take the API down.
  }
}

function saveToDisk(): void {
  if (!persistenceEnabled) return;
  try {
    const payload = {
      version: 1,
      conversations: [...turnsByKey.entries()].map(([key, turns]) => ({ key, turns }))
    };
    mkdirSync(path.dirname(conversationFilePath), { recursive: true });
    const tempPath = `${conversationFilePath}.tmp`;
    writeFileSync(tempPath, JSON.stringify(payload, null, 2), "utf8");
    renameSync(tempPath, conversationFilePath);
  } catch {
    // Durability loss must not fail the request.
  }
}

function evictOldestIfNeeded(): void {
  while (turnsByKey.size > maxTrackedConversations) {
    const oldest = turnsByKey.keys().next().value;
    if (oldest === undefined) return;
    turnsByKey.delete(oldest);
  }
}

export function appendTurn(
  key: string,
  role: StoredTurn["role"],
  content: string,
  provenance?: { strategy?: string; model?: string }
): StoredTurn | null {
  loadFromDisk();

  const trimmed = typeof content === "string" ? content.trim() : "";
  if (!trimmed) return null;

  const turn: StoredTurn = {
    id: globalThis.crypto.randomUUID(),
    role,
    content: trimmed.length > maxContentLength ? trimmed.slice(0, maxContentLength) : trimmed,
    createdAt: new Date().toISOString(),
    ...(provenance?.strategy ? { strategy: provenance.strategy } : {}),
    ...(provenance?.model ? { model: provenance.model } : {})
  };

  const existing = turnsByKey.get(key) ?? [];
  // Oldest turns fall off first once the cap is reached.
  turnsByKey.set(key, [...existing, turn].slice(-maxTurnsPerKey));
  evictOldestIfNeeded();
  saveToDisk();

  return turn;
}

/** Oldest first, which is the order a transcript is read in. */
export function listTurns(key: string, limit = maxTurnsPerKey): StoredTurn[] {
  loadFromDisk();
  return (turnsByKey.get(key) ?? []).slice(-limit);
}

export function clearConversation(key: string): number {
  loadFromDisk();
  const count = turnsByKey.get(key)?.length ?? 0;
  if (count === 0) return 0;

  turnsByKey.delete(key);
  saveToDisk();
  return count;
}

/** Test seam. */
export function resetConversations(): void {
  loaded = true;
  turnsByKey.clear();
  saveToDisk();
}

/** Test seam: drop in-process state and re-read the file, simulating a restart. */
export function reloadConversationsFromDisk(): void {
  turnsByKey.clear();
  loaded = false;
  loadFromDisk();
}

/** Test seam. */
export function setConversationPersistence(enabled: boolean): void {
  persistenceEnabled = enabled;
}
