import test from "node:test";
import assert from "node:assert/strict";
import { answeringSentence, sentencesOf } from "../src/services/passageFocus.js";
import { composeReply } from "../src/services/replyComposer.js";

// An answer from the knowledge base leads with the sentence the question is
// about. In the evaluation, "According to my documents, how many vacation
// days do new employees get?" was answered with the whole passage - the
// handbook's title, the vacation rule, the office's closing day and when
// expenses are due - and marked down for it: the right figure, left for the
// reader to find.

const handbook = "Team Handbook. New employees receive 18 vacation days in their first year, rising to 22 after three years. "
  + "The office is closed on the last Friday of every month for team planning. Expense reports are due by the 5th of the following month.";
const vacation = "New employees receive 18 vacation days in their first year, rising to 22 after three years.";

test("a passage is cut into its sentences, each exactly as written", () => {
  assert.deepEqual(sentencesOf(handbook), [
    "Team Handbook.",
    vacation,
    "The office is closed on the last Friday of every month for team planning.",
    "Expense reports are due by the 5th of the following month."
  ]);
  // A full stop inside a number, a version or an abbreviation is not the end of a sentence.
  assert.deepEqual(sentencesOf("Version 1.2 costs 3.5 dollars, e.g. per seat. It ships in May."),
    ["Version 1.2 costs 3.5 dollars, e.g. per seat.", "It ships in May."]);
  assert.deepEqual(sentencesOf("Is it open? Yes! Until six."), ["Is it open?", "Yes!", "Until six."]);
});

test("the sentence a question is about is picked out, word for word", () => {
  assert.equal(answeringSentence("According to my documents, how many vacation days do new employees get?", handbook), vacation);
  assert.equal(answeringSentence("When are expense reports due?", handbook), "Expense reports are due by the 5th of the following month.");
  assert.equal(answeringSentence("Which day is the office closed for team planning?", handbook),
    "The office is closed on the last Friday of every month for team planning.");

  // A sentence that only continues the one picked comes with it.
  const warranty = "Orders ship from the Leeds depot. The Model X warranty covers parts and labour. It lasts two years from delivery. "
    + "Returns are accepted within thirty days. Refunds take a week.";
  assert.equal(answeringSentence("What does the Model X warranty cover?", warranty),
    "The Model X warranty covers parts and labour. It lasts two years from delivery.");
});

test("nothing is picked when no one sentence stands out", () => {
  // Too short to pick from: it is read whole.
  assert.equal(answeringSentence("Which database does production use?", "The production database is Postgres 16 hosted on Fly.io."), null);
  assert.equal(answeringSentence("When do backups run?", "Backups run nightly at 02:00 UTC. They are kept for thirty days."), null);
  // One shared word is not enough to say a sentence is the answer.
  assert.equal(answeringSentence("What is the office policy on pets?", handbook), null);
  // Two sentences that share as much with the question: neither is "the" answer.
  const twice = "The ferry leaves at seven. The ferry leaves again at eleven. The last ferry back is at five. Tickets are sold on board.";
  assert.equal(answeringSentence("When does the ferry leave?", twice), null);
  // Picking most of the passage is not picking.
  const mostly = "Go. New employees receive 18 vacation days in their first year, rising to 22 after three years, and may carry over five. Ok.";
  assert.equal(answeringSentence("how many vacation days do new employees get?", mostly), null);
});

const passage = (id: string, body: string, documentTitle = "Team Handbook") =>
  ({ id, title: documentTitle, documentId: `doc-${id}`, documentTitle, body, pinned: false, createdAt: new Date(0).toISOString() });

test("the reply leads with that sentence, and still quotes the whole passage under it", () => {
  const reply = composeReply({
    mode: "general",
    message: "According to my documents, how many vacation days do new employees get?",
    memories: [],
    history: [],
    knowledge: [passage("p1", handbook)]
  });

  assert.equal(reply.strategy, "answer");
  assert.equal(reply.text, [
    "From your knowledge base:",
    "",
    `"${vacation}"`,
    "  — Team Handbook",
    "",
    "In full:",
    "",
    `- "${handbook}"`,
    "  — Team Handbook",
    "",
    "That is quoted from the document, not interpreted. If it doesn't answer the question, the wording may just not match."
  ].join("\n"));
  assert.deepEqual(reply.groundedOn, ["p1"], "what it quoted is recorded as before");
});

test("a short passage is quoted as it always was", () => {
  // The control: nothing to pick from, so nothing is added.
  const short = "The production database is Postgres 16 hosted on Fly.io.";
  const reply = composeReply({
    mode: "general",
    message: "Which database does production use?",
    memories: [],
    history: [],
    knowledge: [passage("p2", short, "Ops Runbook")]
  });
  assert.equal(reply.text,
    `From your knowledge base:\n\n- "${short}"\n  — Ops Runbook\n\nThat is quoted from the document, not interpreted. If it doesn't answer the question, the wording may just not match.`);
});
