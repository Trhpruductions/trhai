import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ScorableMemory } from "./memoryRelevance.js";

// Knowledge base for `/v1/assist`.
//
// Saved memory holds short facts the user dictated one at a time. That is a
// narrow channel: the assistant could only ever answer what someone had thought
// to say with "remember that ...". A knowledge document is the other shape —
// paste a runbook, a spec, a set of notes, and questions can be answered from it.
//
// Retrieval is lexical, reusing the same scorer as memory, because there are no
// embeddings available here. That has a consequence the composer must respect: a
// question phrased in different vocabulary than the document will simply miss.
// The honest failure is "nothing matches", never a guess.
//
// Documents are scoped per session, exactly like assist memory, so an anonymous
// caller cannot read another's material.

export type KnowledgeDocument = {
  id: string;
  title: string;
  body: string;
  createdAt: string;
};

/**
 * One searchable passage of a document.
 *
 * Documents are chunked before scoring because a long document dilutes term
 * overlap — a runbook mentioning "postgres" once scores near zero as a whole,
 * while the paragraph that mentions it scores well. Chunking is also what makes
 * a citation useful: quoting the paragraph is an answer, quoting the document is
 * a shrug.
 */
export type KnowledgePassage = ScorableMemory & {
  documentId: string;
  documentTitle: string;
};

/** Caps so an unauthenticated caller cannot grow storage without bound. */
export const maxDocumentsPerSession = 25;
export const maxDocumentChars = 20000;
export const maxTrackedKnowledgeSessions = 500;
/** How many passages are offered to a single reply. */
export const knowledgeRetrievalLimit = 6;

const documentsBySession = new Map<string, KnowledgeDocument[]>();

const knowledgeFilePath = process.env.ASSIST_KNOWLEDGE_FILE
  ?? path.join(process.cwd(), "data", "assist-knowledge.json");

let loaded = false;
let persistenceEnabled = process.env.ASSIST_KNOWLEDGE_PERSIST !== "off";

type PersistedShape = {
  version: 1;
  sessions: Array<{ key: string; documents: KnowledgeDocument[] }>;
};

function isDocument(value: unknown): value is KnowledgeDocument {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<KnowledgeDocument>;
  return typeof entry.id === "string"
    && typeof entry.title === "string"
    && typeof entry.body === "string"
    && typeof entry.createdAt === "string";
}

function loadFromDisk(): void {
  if (loaded) return;
  loaded = true;
  if (!persistenceEnabled || !existsSync(knowledgeFilePath)) return;

  try {
    const parsed = JSON.parse(readFileSync(knowledgeFilePath, "utf8")) as Partial<PersistedShape>;
    if (!Array.isArray(parsed.sessions)) return;

    for (const session of parsed.sessions) {
      if (!session || typeof session.key !== "string" || !Array.isArray(session.documents)) continue;
      const documents = session.documents.filter(isDocument);
      if (documents.length) documentsBySession.set(session.key, documents);
    }
  } catch {
    // A corrupt file must never take the API down; start clean instead.
  }
}

function saveToDisk(): void {
  if (!persistenceEnabled) return;

  try {
    const payload: PersistedShape = {
      version: 1,
      sessions: [...documentsBySession.entries()].map(([key, documents]) => ({ key, documents }))
    };
    mkdirSync(path.dirname(knowledgeFilePath), { recursive: true });
    // Temp file then rename, so a crash mid-write cannot truncate the store.
    const tempPath = `${knowledgeFilePath}.tmp`;
    writeFileSync(tempPath, JSON.stringify(payload, null, 2), "utf8");
    renameSync(tempPath, knowledgeFilePath);
  } catch {
    // Losing durability is bad; taking the request down with it is worse.
  }
}

/**
 * A heading, not prose: short and with no sentence-ending punctuation.
 *
 * Length alone is not the test. "The database is Postgres 16." is short but is a
 * complete passage and a perfectly good answer, while "## Rollback" is short
 * because it is a label for the text beneath it.
 */
function isHeadingLike(text: string): boolean {
  return text.length < 60 && !/[.!?]$/.test(text);
}

/**
 * Split a document into passages on blank lines, then join a heading to the text
 * beneath it — a lone "## Rollback" matches a query about rollback but answers
 * nothing, so on its own it is a citation that tells the reader nothing.
 */
export function chunkDocument(document: KnowledgeDocument): KnowledgePassage[] {
  const blocks = document.body
    .split(/\n\s*\n/)
    .map((block) => block.trim().replace(/\s+/g, " "))
    .filter(Boolean);

  const merged: string[] = [];
  for (const block of blocks) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && isHeadingLike(previous)) {
      merged[merged.length - 1] = `${previous} ${block}`;
      continue;
    }
    merged.push(block);
  }

  return merged.map((text, index) => ({
    id: `${document.id}#${index}`,
    title: document.title,
    body: text,
    pinned: false,
    createdAt: document.createdAt,
    documentId: document.id,
    documentTitle: document.title
  }));
}

export function listDocuments(sessionKey: string): KnowledgeDocument[] {
  loadFromDisk();
  return [...(documentsBySession.get(sessionKey) ?? [])];
}

export function addDocument(
  sessionKey: string,
  input: { id: string; title: string; body: string; createdAt?: string }
): KnowledgeDocument | null {
  loadFromDisk();

  const title = input.title.trim();
  const body = input.body.trim();
  if (!title || !body) return null;

  const document: KnowledgeDocument = {
    id: input.id,
    title,
    // Truncated rather than refused: losing the tail of a long paste is better
    // than losing the paste.
    body: body.slice(0, maxDocumentChars),
    createdAt: input.createdAt ?? new Date().toISOString()
  };

  const existing = documentsBySession.get(sessionKey) ?? [];
  const next = [...existing, document].slice(-maxDocumentsPerSession);
  documentsBySession.set(sessionKey, next);

  // Insertion-ordered map: dropping the first key evicts the least recent session.
  if (documentsBySession.size > maxTrackedKnowledgeSessions) {
    const oldest = documentsBySession.keys().next().value;
    if (oldest !== undefined) documentsBySession.delete(oldest);
  }

  saveToDisk();
  return document;
}

export function removeDocument(sessionKey: string, documentId: string): boolean {
  loadFromDisk();
  const existing = documentsBySession.get(sessionKey);
  if (!existing) return false;

  const next = existing.filter((entry) => entry.id !== documentId);
  if (next.length === existing.length) return false;

  documentsBySession.set(sessionKey, next);
  saveToDisk();
  return true;
}

/** Every passage of every document in the session, ready for scoring. */
export function retrieveKnowledgePassages(sessionKey: string): KnowledgePassage[] {
  return listDocuments(sessionKey).flatMap(chunkDocument);
}

export function resetKnowledge(sessionKey?: string): void {
  if (sessionKey) {
    documentsBySession.delete(sessionKey);
  } else {
    documentsBySession.clear();
  }
  saveToDisk();
}

export function setKnowledgePersistence(enabled: boolean): void {
  persistenceEnabled = enabled;
}
