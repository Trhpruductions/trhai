import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { dataFile } from "./dataDirectory.js";
import { assertProtectedJsonWritable, readProtectedJsonFile, writeProtectedJsonFile } from "./protectedJson.js";
import { recordPersistFailure, recordPersistSuccess } from "./persistenceHealth.js";

// Conversation storage, keyed the same way as memory: `user:<id>` when signed in,
// the anonymous session id otherwise. That is what makes a conversation follow an
// account to another browser instead of living only in localStorage.
//
// Each key holds a list of conversations - its own title, pin, archive flag and
// turns - so a chat about the build server and one about dinner are kept
// apart and can be found again. A request that names no conversation means the
// one used most recently, which is all the single-transcript store ever had:
// callers written for it keep working unchanged.
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

export type StoredConversation = {
  id: string;
  title: string;
  /** "user" once someone named it: an automatic title never replaces theirs. */
  titledBy: "auto" | "user";
  createdAt: string;
  /** When it was last added to - what "recent" means in the list. */
  updatedAt: string;
  pinned: boolean;
  archived: boolean;
  /** The model picked for this conversation; absent means the usual choice. */
  model?: string;
  turns: StoredTurn[];
};

/** A conversation as the list shows it: everything but the turns. */
export type ConversationSummary = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  pinned: boolean;
  archived: boolean;
  model?: string;
  turnCount: number;
  /** The newest turn, shortened - what the list shows under the title. */
  preview: string;
  /** Where a search matched inside the conversation, when it was not the title. */
  match?: string;
};

/** Turns kept per conversation (the name predates there being more than one). */
export const maxTurnsPerKey = 200;
/** Conversations kept per key; past it the least recently used unpinned one goes. */
export const maxConversationsPerKey = 300;
/** Keys kept at all, so anonymous callers cannot grow the file forever. */
export const maxTrackedConversations = 500;
export const maxTitleLength = 80;
const maxContentLength = 8000;
const untitled = "New conversation";

const conversationFilePath = process.env.ASSIST_CONVERSATION_FILE
  ?? dataFile("conversations.json");

let persistenceEnabled = process.env.ASSIST_CONVERSATION_PERSIST !== "off";
let loaded = false;

const conversationsByKey = new Map<string, StoredConversation[]>();

/**
 * Ids come from the client (a new chat is named before its first message is
 * sent), so they are checked rather than trusted: a fixed character set and
 * length, nothing that could reach a path or a property name.
 */
export function isConversationId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9-]{8,64}$/.test(value);
}

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

/**
 * A title from the first thing said: its first line, without markup, cut at a
 * word. No model is asked - a title has to exist the moment the conversation
 * does, and a sentence the user wrote is a better name than one invented.
 */
export function titleFrom(text: string): string {
  const words = text.replace(/\[\d+ images? attached\]/g, " ").split(/\r?\n/).find((line) => line.trim()) ?? "";
  const plain = words.replace(/[`*_#>[\]]/g, "").replace(/\s+/g, " ").trim();
  if (!plain) return untitled;
  if (plain.length <= 60) return plain;
  const cut = plain.slice(0, 60);
  const space = cut.lastIndexOf(" ");
  return `${(space > 30 ? cut.slice(0, space) : cut).replace(/[\s,.;:!?-]+$/, "")}…`;
}

/** A user-given title, tidied; null when there is nothing left to use. */
export function cleanTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const title = value.replace(/\s+/g, " ").trim().slice(0, maxTitleLength).trim();
  return title || null;
}

function toConversation(value: unknown): StoredConversation | null {
  const entry = value as Partial<StoredConversation> | null;
  if (!entry || typeof entry !== "object" || !isConversationId(entry.id)) return null;
  const turns = Array.isArray(entry.turns) ? entry.turns.filter(isStoredTurn) : [];
  const createdAt = typeof entry.createdAt === "string" ? entry.createdAt : turns[0]?.createdAt ?? new Date(0).toISOString();
  return {
    id: entry.id,
    title: cleanTitle(entry.title) ?? untitled,
    titledBy: entry.titledBy === "user" ? "user" : "auto",
    createdAt,
    updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : turns[turns.length - 1]?.createdAt ?? createdAt,
    pinned: entry.pinned === true,
    archived: entry.archived === true,
    ...(typeof entry.model === "string" && /^[A-Za-z0-9._:/-]{1,100}$/.test(entry.model) ? { model: entry.model } : {}),
    turns
  };
}

/**
 * The one transcript a key had before conversations existed, as that key's
 * first conversation. The id is derived from the key, so it is the same on
 * every load until the file is next written in the new shape.
 */
function legacyConversation(key: string, turns: StoredTurn[]): StoredConversation {
  const firstAsked = turns.find((turn) => turn.role === "user")?.content;
  return {
    id: `legacy-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`,
    title: firstAsked ? titleFrom(firstAsked) : "Earlier conversation",
    titledBy: "auto",
    createdAt: turns[0].createdAt,
    updatedAt: turns[turns.length - 1].createdAt,
    pinned: false,
    archived: false,
    turns
  };
}

function loadFromDisk(): void {
  if (loaded) return;
  loaded = true;
  if (!persistenceEnabled || !existsSync(conversationFilePath)) return;

  try {
    const parsed = readProtectedJsonFile(conversationFilePath) as {
      owners?: Array<{ key?: unknown; conversations?: unknown }>;
      conversations?: Array<{ key?: unknown; turns?: unknown }>;
    };

    if (Array.isArray(parsed.owners)) {
      for (const owner of parsed.owners) {
        if (!owner || typeof owner.key !== "string" || !Array.isArray(owner.conversations)) continue;
        const list = owner.conversations.map(toConversation).filter((entry): entry is StoredConversation => entry !== null);
        if (list.length) conversationsByKey.set(owner.key, list);
      }
      return;
    }

    // Version 1: one transcript per key.
    for (const entry of parsed.conversations ?? []) {
      if (!entry || typeof entry.key !== "string" || !Array.isArray(entry.turns)) continue;
      const turns = entry.turns.filter(isStoredTurn);
      if (turns.length) conversationsByKey.set(entry.key, [legacyConversation(entry.key, turns)]);
    }
  } catch {
    // A corrupt file must not take the API down.
  }
}

function saveToDisk(): void {
  if (!persistenceEnabled) return;
  try {
    const payload = {
      version: 2,
      owners: [...conversationsByKey.entries()].map(([key, conversations]) => ({ key, conversations }))
    };
    mkdirSync(path.dirname(conversationFilePath), { recursive: true });
    const tempPath = `${conversationFilePath}.tmp`;
    assertProtectedJsonWritable(conversationFilePath);
    writeProtectedJsonFile(tempPath, payload);
    renameSync(tempPath, conversationFilePath);
    recordPersistSuccess("conversations");
  } catch (error) {
    // Reported rather than swallowed. The catch itself is right - losing
    // durability must not fail the request - but a bare one meant nothing
    // it was told survived a restart and nothing anywhere said so.
    recordPersistFailure("conversations", error);
    // Durability loss must not fail the request.
  }
}

function listFor(key: string): StoredConversation[] {
  loadFromDisk();
  return conversationsByKey.get(key) ?? [];
}

const newestFirst = (a: StoredConversation, b: StoredConversation) => b.updatedAt.localeCompare(a.updatedAt);

/** The conversation a request without an id means: the most recently used one still in view. */
function currentOf(list: StoredConversation[]): StoredConversation | undefined {
  return list.filter((conversation) => !conversation.archived).sort(newestFirst)[0];
}

/** Keeps the key's list, most recently used key last, and the store within its bounds. */
function keep(key: string, list: StoredConversation[]): void {
  while (list.length > maxConversationsPerKey) {
    const stale = list.filter((conversation) => !conversation.pinned).sort(newestFirst).pop();
    if (!stale) break;
    list.splice(list.indexOf(stale), 1);
  }
  conversationsByKey.delete(key);
  if (list.length) conversationsByKey.set(key, list);
  while (conversationsByKey.size > maxTrackedConversations) {
    const oldest = conversationsByKey.keys().next().value;
    if (oldest === undefined) return;
    conversationsByKey.delete(oldest);
  }
}

function created(id: string | undefined): StoredConversation {
  const now = new Date().toISOString();
  return {
    id: isConversationId(id) ? id : globalThis.crypto.randomUUID(),
    title: untitled,
    titledBy: "auto",
    createdAt: now,
    updatedAt: now,
    pinned: false,
    archived: false,
    turns: []
  };
}

/** A line of a reply as plain words for the list: no code fences, no markup characters. */
function plainText(text: string): string {
  return text
    .replace(/```[\w+-]*/g, " ")
    .replace(/\[\d+ images? attached\]/g, " ")
    .replace(/[`*_#>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function summarize(conversation: StoredConversation, match?: string): ConversationSummary {
  const newest = conversation.turns[conversation.turns.length - 1]?.content ?? "";
  const preview = plainText(newest);
  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    pinned: conversation.pinned,
    archived: conversation.archived,
    ...(conversation.model ? { model: conversation.model } : {}),
    turnCount: conversation.turns.length,
    preview: preview.length > 140 ? `${preview.slice(0, 139)}…` : preview,
    ...(match ? { match } : {})
  };
}

/** The conversation a request means, if it exists: the one named, or the current one. */
function existing(key: string, conversationId?: string): StoredConversation | undefined {
  const list = listFor(key);
  return conversationId === undefined ? currentOf(list) : list.find((entry) => entry.id === conversationId);
}

/**
 * Which conversation a request means: the one it names, created under that
 * id if it does not exist yet (a new chat's first message), or the most
 * recently used one when it names none. Adds a created one to the store
 * without saving; the caller saves once for everything it changed.
 */
function resolveIn(key: string, conversationId?: string): StoredConversation {
  const named = isConversationId(conversationId) ? conversationId : undefined;
  const found = existing(key, named);
  if (found) return found;
  const conversation = created(named);
  keep(key, [...listFor(key), conversation]);
  return conversation;
}

/** resolveIn, saved: for a caller that wants the id before anything is said. */
export function resolveConversation(key: string, conversationId?: string): ConversationSummary {
  const found = existing(key, isConversationId(conversationId) ? conversationId : undefined);
  if (found) return summarize(found);
  const conversation = resolveIn(key, conversationId);
  saveToDisk();
  return summarize(conversation);
}

export function appendTurn(
  key: string,
  role: StoredTurn["role"],
  content: string,
  provenance?: { strategy?: string; model?: string },
  conversationId?: string
): StoredTurn | null {
  const trimmed = typeof content === "string" ? content.trim() : "";
  if (!trimmed) return null;

  const conversation = resolveIn(key, conversationId);

  const turn: StoredTurn = {
    id: globalThis.crypto.randomUUID(),
    role,
    content: trimmed.length > maxContentLength ? trimmed.slice(0, maxContentLength) : trimmed,
    createdAt: new Date().toISOString(),
    ...(provenance?.strategy ? { strategy: provenance.strategy } : {}),
    ...(provenance?.model ? { model: provenance.model } : {})
  };

  // Oldest turns fall off first once the cap is reached.
  conversation.turns = [...conversation.turns, turn].slice(-maxTurnsPerKey);
  conversation.updatedAt = turn.createdAt;
  if (role === "user") {
    if (conversation.titledBy === "auto" && conversation.title === untitled) conversation.title = titleFrom(trimmed);
    // Carrying on with an archived conversation brings it back into the list,
    // rather than leaving a live conversation hidden.
    conversation.archived = false;
  }
  keep(key, [...(conversationsByKey.get(key) ?? [])]);
  saveToDisk();

  return turn;
}

/**
 * Takes back the newest exchange - the question and the reply to it - so a
 * regenerated answer replaces the old one instead of following it. Only when
 * the newest turns really are that question and a reply: anything else is
 * left exactly as it is.
 */
export function dropLastExchange(key: string, conversationId: string | undefined, asked: string): boolean {
  const conversation = existing(key, isConversationId(conversationId) ? conversationId : undefined);
  const turns = conversation?.turns ?? [];
  const reply = turns[turns.length - 1];
  const question = turns[turns.length - 2];
  if (!conversation || reply?.role !== "assistant" || question?.role !== "user") return false;
  if (question.content.split("\n[")[0].trim() !== asked.trim()) return false;
  conversation.turns = turns.slice(0, -2);
  saveToDisk();
  return true;
}

/** Oldest first, which is the order a transcript is read in. */
export function listTurns(key: string, limit = maxTurnsPerKey, conversationId?: string): StoredTurn[] {
  return (existing(key, conversationId)?.turns ?? []).slice(-limit);
}

/** The id a request without one would continue, if there is any conversation yet. */
export function currentConversationId(key: string): string | null {
  return currentOf(listFor(key))?.id ?? null;
}

/**
 * The key's conversations, pinned first and then the most recently used.
 * Archived ones only when asked for. A search matches the title or anything
 * said, and says where it matched when it was not the title.
 */
export function listConversations(
  key: string,
  options: { query?: string; archived?: boolean } = {}
): ConversationSummary[] {
  const wanted = options.archived === true;
  const query = (options.query ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  const results: ConversationSummary[] = [];

  for (const conversation of listFor(key)) {
    if (conversation.archived !== wanted) continue;
    if (!query) {
      results.push(summarize(conversation));
      continue;
    }
    if (conversation.title.toLowerCase().includes(query)) {
      results.push(summarize(conversation));
      continue;
    }
    const hit = conversation.turns.find((turn) => turn.content.toLowerCase().includes(query));
    if (!hit) continue;
    const text = hit.content.replace(/\s+/g, " ");
    const at = text.toLowerCase().indexOf(query);
    const start = Math.max(0, at - 50);
    const end = Math.min(text.length, at + query.length + 70);
    results.push(summarize(conversation, `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`));
  }

  return results.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
}

export function getConversation(key: string, conversationId: string): (ConversationSummary & { turns: StoredTurn[] }) | null {
  const conversation = listFor(key).find((entry) => entry.id === conversationId);
  return conversation ? { ...summarize(conversation), turns: [...conversation.turns] } : null;
}

/**
 * Renames, pins or archives one conversation. None of these is activity, so
 * the conversation keeps its place among the recent ones.
 */
export function updateConversation(
  key: string,
  conversationId: string,
  change: { title?: string; pinned?: boolean; archived?: boolean; model?: string | null }
): ConversationSummary | null {
  const conversation = listFor(key).find((entry) => entry.id === conversationId);
  if (!conversation) return null;
  if (change.title !== undefined) {
    const title = cleanTitle(change.title);
    if (title) {
      conversation.title = title;
      conversation.titledBy = "user";
    }
  }
  if (typeof change.pinned === "boolean") conversation.pinned = change.pinned;
  if (typeof change.archived === "boolean") conversation.archived = change.archived;
  // null goes back to the usual model; the route has already checked the name.
  if (change.model === null) delete conversation.model;
  else if (typeof change.model === "string") conversation.model = change.model;
  saveToDisk();
  return summarize(conversation);
}

export function deleteConversation(key: string, conversationId: string): boolean {
  const list = [...listFor(key)];
  const index = list.findIndex((entry) => entry.id === conversationId);
  if (index === -1) return false;
  list.splice(index, 1);
  keep(key, list);
  saveToDisk();
  return true;
}

/**
 * Removes a conversation and says how many turns went with it: the named one,
 * or the current one when none is named - what clearing meant when there was
 * only ever one.
 */
export function clearConversation(key: string, conversationId?: string): number {
  const conversation = existing(key, conversationId);
  if (!conversation) return 0;
  const count = conversation.turns.length;
  deleteConversation(key, conversation.id);
  return count;
}

/** Test seam. */
export function resetConversations(): void {
  loaded = true;
  conversationsByKey.clear();
  saveToDisk();
}

/** Test seam: drop in-process state and re-read the file, simulating a restart. */
export function reloadConversationsFromDisk(): void {
  conversationsByKey.clear();
  loaded = false;
  loadFromDisk();
}
