import test from "node:test";
import assert from "node:assert/strict";
import {
  addDocument,
  chunkDocument,
  listDocuments,
  maxDocumentsPerSession,
  removeDocument,
  resetKnowledge,
  retrieveKnowledgePassages,
  setKnowledgePersistence
} from "../src/services/knowledgeStore.js";
import { composeReply } from "../src/services/replyComposer.js";

setKnowledgePersistence(false);

function freshSession(name: string): string {
  const key = `${name}-${Math.random().toString(36).slice(2)}`;
  resetKnowledge(key);
  return key;
}

test("a document is stored and listed", () => {
  const session = freshSession("store");
  const document = addDocument(session, { id: "d1", title: "Runbook", body: "Restart the worker." });

  assert.ok(document);
  assert.equal(document.title, "Runbook");
  assert.deepEqual(listDocuments(session).map((entry) => entry.id), ["d1"]);
});

test("a document with no title or no body is refused", () => {
  const session = freshSession("invalid");

  assert.equal(addDocument(session, { id: "a", title: "  ", body: "text" }), null);
  assert.equal(addDocument(session, { id: "b", title: "Title", body: "   " }), null);
  assert.deepEqual(listDocuments(session), []);
});

test("documents are scoped to their session", () => {
  const mine = freshSession("mine");
  const yours = freshSession("yours");

  addDocument(mine, { id: "d1", title: "Mine", body: "secret" });

  assert.equal(listDocuments(yours).length, 0, "another session must not see it");
});

test("a session cannot grow documents without bound", () => {
  const session = freshSession("cap");

  for (let index = 0; index < maxDocumentsPerSession + 5; index += 1) {
    addDocument(session, { id: `d${index}`, title: `Doc ${index}`, body: "text" });
  }

  const documents = listDocuments(session);
  assert.equal(documents.length, maxDocumentsPerSession);
  // The oldest are evicted, so the most recent paste is always still there.
  assert.equal(documents.at(-1)?.id, `d${maxDocumentsPerSession + 4}`);
});

test("removing a document drops only that one", () => {
  const session = freshSession("remove");
  addDocument(session, { id: "d1", title: "One", body: "text" });
  addDocument(session, { id: "d2", title: "Two", body: "text" });

  assert.equal(removeDocument(session, "d1"), true);
  assert.deepEqual(listDocuments(session).map((entry) => entry.id), ["d2"]);
  assert.equal(removeDocument(session, "missing"), false);
});

test("a document is chunked into passages on blank lines", () => {
  const passages = chunkDocument({
    id: "d1",
    title: "Runbook",
    body: "The database is Postgres 16.\n\nThe deploy target is Fly.io.\n\nRollback is a redeploy of the previous image.",
    createdAt: new Date().toISOString()
  });

  assert.equal(passages.length, 3);
  assert.equal(passages[0].body, "The database is Postgres 16.");
  // Every passage names its source so a quote can be attributed.
  assert.equal(passages[1].documentTitle, "Runbook");
  assert.equal(passages[1].documentId, "d1");
});

test("a heading too short to answer anything is merged with the text under it", () => {
  // A lone "## Rollback" matches a rollback question but answers nothing.
  const passages = chunkDocument({
    id: "d1",
    title: "Runbook",
    body: "## Rollback\n\nRedeploy the previous image, then clear the CDN cache.",
    createdAt: new Date().toISOString()
  });

  assert.equal(passages.length, 1);
  assert.match(passages[0].body, /Rollback.*Redeploy the previous image/);
});

test("an answer is quoted from the document and attributed to it", () => {
  const session = freshSession("answer");
  addDocument(session, {
    id: "d1",
    title: "Ops Runbook",
    body: "The production database is Postgres 16 hosted on Fly.io.\n\nBackups run nightly at 02:00 UTC."
  });

  const reply = composeReply({
    mode: "general",
    message: "Which database does production use?",
    memories: [],
    history: [],
    knowledge: retrieveKnowledgePassages(session)
  });

  assert.equal(reply.strategy, "answer");
  assert.match(reply.text, /Postgres 16/);
  // Attribution is what makes the quote checkable.
  assert.match(reply.text, /Ops Runbook/);
  assert.match(reply.text, /quoted from the document, not interpreted/);
  assert.ok(reply.groundedOn.length > 0, "the reply must record what it quoted");
});

test("saved memory outranks a document passage", () => {
  // A fact stated deliberately beats a passage that merely shares vocabulary.
  const session = freshSession("rank");
  addDocument(session, { id: "d1", title: "Old Runbook", body: "The production database is MySQL." });

  const reply = composeReply({
    mode: "general",
    message: "Which database does production use?",
    memories: [{
      id: "m1",
      title: "Database",
      body: "we standardized on Postgres for production",
      pinned: false,
      createdAt: new Date().toISOString()
    }],
    history: [],
    knowledge: retrieveKnowledgePassages(session)
  });

  assert.match(reply.text, /Postgres/);
  assert.doesNotMatch(reply.text, /MySQL/);
});

test("an unmatched question names what was searched instead of claiming emptiness", () => {
  // "I don't have anything saved" is wrong when a document is sitting there
  // that simply uses different words.
  const session = freshSession("miss");
  addDocument(session, { id: "d1", title: "Runbook", body: "Backups run nightly at 02:00 UTC." });

  const reply = composeReply({
    mode: "general",
    message: "What is the office wifi password?",
    memories: [],
    history: [],
    knowledge: retrieveKnowledgePassages(session)
  });

  assert.equal(reply.strategy, "no-answer");
  assert.match(reply.text, /1 document/);
  assert.match(reply.text, /phrased differently/i);
});

test("with nothing stored at all the reply says so plainly", () => {
  const reply = composeReply({
    mode: "general",
    message: "Which database does production use?",
    memories: [],
    history: [],
    knowledge: []
  });

  assert.equal(reply.strategy, "no-answer");
  assert.match(reply.text, /don't have anything saved/i);
});

test("a document never invents an answer for an unrelated question", () => {
  const session = freshSession("nofab");
  addDocument(session, { id: "d1", title: "Runbook", body: "The database is Postgres 16." });

  const reply = composeReply({
    mode: "general",
    message: "How many employees does the company have?",
    memories: [],
    history: [],
    knowledge: retrieveKnowledgePassages(session)
  });

  assert.equal(reply.strategy, "no-answer");
  assert.doesNotMatch(reply.text, /Postgres/);
});

test("a concept written open matches one written closed", () => {
  // "roll back a deploy" must find a runbook headed "Rollback". English writes
  // these both ways and pure term overlap treats them as unrelated words.
  const session = freshSession("compound");
  addDocument(session, {
    id: "d1",
    title: "Ops Runbook",
    body: "## Rollback\n\nRedeploy the previous image, then purge the CDN cache."
  });

  const reply = composeReply({
    mode: "general",
    message: "How do I roll back a deploy?",
    memories: [],
    history: [],
    knowledge: retrieveKnowledgePassages(session)
  });

  assert.equal(reply.strategy, "answer");
  assert.match(reply.text, /Redeploy the previous image/);
});
