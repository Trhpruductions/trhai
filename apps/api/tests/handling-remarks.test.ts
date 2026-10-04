import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// A workspace of its own: a turn that reaches the model is offered tools.
process.env.ASCEND_WORKSPACE = mkdtempSync(path.join(tmpdir(), "trhai-remarks-"));

const { withoutHandlingRemarks } = await import("../src/services/handlingRemarks.js");
const { runAgent } = await import("../src/services/agentLoop.js");
const { fakeEngine } = await import("./helpers/fakeEngine.js");

// An answer, without the account of how the question was handled.
//
// Found on the evaluation of 4 October. Qwen3 answers a plain question and
// then says how it dealt with it: eleven of twenty-four replies to eight
// questions. A line added to the system prompt telling it not to made no
// difference (ten of twenty-four). Every reply below marked "Qwen3" is one it
// gave, word for word.

const austen = "Who wrote the novel Pride and Prejudice?";

test("the sentence about how the question was handled is taken out, and the answer left", () => {
  for (const [request, reply, answer] of [
    // Qwen3, each of these:
    [austen, "The novel *Pride and Prejudice* was written by **Jane Austen**. This is general knowledge and does not require checking the user's documents or memory.",
      "The novel *Pride and Prejudice* was written by **Jane Austen**."],
    [austen, "The novel *Pride and Prejudice* was written by Jane Austen. The user has not recorded any information about this topic in their memory or documents.",
      "The novel *Pride and Prejudice* was written by Jane Austen."],
    ["What is the capital of Australia?", "The capital of Australia is Canberra. This is a general knowledge fact, and I don't need to consult any tools to provide this answer.",
      "The capital of Australia is Canberra."],
    ["What is the capital of Australia?", "The capital of Australia is Canberra. This information is based on general knowledge, as there is no recorded data about this in your documents or memory.",
      "The capital of Australia is Canberra."],
    ["Which element has the atomic number 26?", "The element with atomic number 26 is iron (Fe). This information is based on general knowledge of the periodic table. The user has not saved any specific details about atomic numbers in their memory or documents.",
      "The element with atomic number 26 is iron (Fe)."],
    ["Which element has the atomic number 26?", "The element with atomic number 26 is Iron (Fe). This information is based on general knowledge of the periodic table and does not require accessing the user's personal data or documents.",
      "The element with atomic number 26 is Iron (Fe)."],
    ["Who painted The Night Watch?", "\"The Night Watch\" was painted by Rembrandt van Rijn. This is general knowledge, and I don't have access to tools that would retrieve this information from the user's private data.",
      "\"The Night Watch\" was painted by Rembrandt van Rijn."],
    // Qwen3 again: the tools first and the knowledge after, and one wrapped in a tag of its own making.
    ["What is the song Bohemian Rhapsody about?", "Its surreal lyrics and unique style have made it a cultural icon. No tools were needed, as this is general knowledge.",
      "Its surreal lyrics and unique style have made it a cultural icon."],
    ["What is the song Bohemian Rhapsody about?", "Its core themes revolve around justice, redemption, and the human condition. <note> I don’t have access to documents or memories about this topic, so this answer is based on general knowledge. </note>",
      "Its core themes revolve around justice, redemption, and the human condition."],
    ["Who painted The Night Watch?", "It was painted by Rembrandt. This answer is based on general knowledge, as there is no record of the user having saved specific information about this artwork in their memory or documents.",
      "It was painted by Rembrandt."],
    // The same thing said without the words "general knowledge".
    ["What is the capital of Australia?", "The capital of Australia is Canberra. No tools were needed.", "The capital of Australia is Canberra."],
    // With the other apostrophe, which the model also writes.
    ["What is the capital of Australia?", "The capital of Australia is Canberra. I don’t need to consult any tools for that.", "The capital of Australia is Canberra."],
    ["What is the capital of Australia?", "The capital of Australia is Canberra. I didn't need to use any tools for this.", "The capital of Australia is Canberra."],
    // On a line of its own, and in the middle.
    [austen, "Jane Austen wrote it.\n\nThis is general knowledge and does not require checking the user's documents or memory.\n\nIt was published in 1813.",
      "Jane Austen wrote it.\n\nIt was published in 1813."],
    [austen, "Jane Austen wrote it. It does not require accessing the user's personal data or files. It was published in 1813.",
      "Jane Austen wrote it. It was published in 1813."]
  ]) {
    assert.equal(withoutHandlingRemarks(reply, request), answer, reply);
  }
});

test("a sentence that says something about the answer stays", () => {
  for (const [request, reply] of [
    // Qwen3: a caution about the figure, which is worth having.
    ["And roughly how many people live there?", "The population of Canberra is approximately 410,000 people. This is an estimate based on general knowledge and may not reflect the most recent census data."],
    // General knowledge spoken of, and nothing about the user's records or the tools.
    ["Is that widely known?", "Yes, that is general knowledge in chemistry."],
    ["Where does the word come from?", "Based on general knowledge, the earliest recorded use of the word was in 1611."],
    ["Is that well known?", "Yes, that is general knowledge; many documents of the period mention it."],
    // Needing nothing is not always about tools.
    ["Do I need a visa?", "No. I don't need to check: citizens of the EU travel there freely."],
    // What was looked for and not found is the answer to a question about the user.
    ["What's my dog's name?", "I looked through what you have told me and found nothing about a dog. You haven't told me your dog's name."],
    ["What's the capital of Australia?", "The capital of Australia is Canberra."],
    // Code is never touched, whatever its comments say.
    ["Write a function that greets someone. Reply with just the code.", "```js\n// This is general knowledge and does not require the user's documents.\nfunction greet(name) { return `Hello, ${name}`; }\n```"]
  ]) {
    assert.equal(withoutHandlingRemarks(reply, request), reply, reply);
  }
});

test("where the answer came from is not taken out when that is what was asked", () => {
  const remark = "This is general knowledge and does not require checking your documents or memory.";
  for (const request of [
    "Is that from my notes or from general knowledge?",
    "Did you check my documents for that?",
    "How do you know that?",
    "What's your source for that?",
    "Which tools did you use?"
  ]) {
    assert.equal(withoutHandlingRemarks(`Jane Austen wrote it. ${remark}`, request), `Jane Austen wrote it. ${remark}`, request);
  }
  // The control: the same reply to a plain question loses the sentence.
  assert.equal(withoutHandlingRemarks(`Jane Austen wrote it. ${remark}`, austen), "Jane Austen wrote it.");
});

test("a reply that is nothing but such a sentence is left as it is", () => {
  // Qwen3. Poor as it is, an empty reply would be worse.
  const only = "The user has not recorded any information about this topic in their memory or documents.";
  assert.equal(withoutHandlingRemarks(only, austen), only);
});

const config = (baseUrl: string) => ({ baseUrl, model: "llama3.2", modelFromEnv: true, timeoutMs: 4000 });

test("the user reads the answer alone", async () => {
  const engine = await fakeEngine({
    reply: { message: { content: "The novel *Pride and Prejudice* was written by Jane Austen. This is general knowledge and does not require consulting the user's documents or memory." } }
  });
  try {
    const result = await runAgent(config(engine.baseUrl), austen, { memories: [], knowledge: [], request: austen });
    assert.equal(result.ok && result.text, "The novel *Pride and Prejudice* was written by Jane Austen.");
    assert.equal(engine.chats.length, 1, "taken out here, not asked of the model again");

    // The control: asked where the answer came from, the same reply is passed on whole.
    const asked = "Who wrote Pride and Prejudice, and is that from my notes?";
    const whole = await runAgent(config(engine.baseUrl), asked, { memories: [], knowledge: [], request: asked });
    assert.equal(whole.ok && whole.text,
      "The novel *Pride and Prejudice* was written by Jane Austen. This is general knowledge and does not require consulting the user's documents or memory.");
  } finally {
    await engine.close();
  }
});
