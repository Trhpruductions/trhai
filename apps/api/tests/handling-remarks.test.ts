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
    // Qwen3, through the whole app, once the wordings above were being taken out.
    [austen, "The novel *Pride and Prejudice* was written by **Jane Austen**. Your memory or files do not contain this information, as it is widely known.",
      "The novel *Pride and Prejudice* was written by **Jane Austen**."],
    ["Who painted The Night Watch?", "This painting is one of his most famous works, created in 1642. It is not related to the user's personal data, documents, or systems, so no tools were needed to answer this question.",
      "This painting is one of his most famous works, created in 1642."],
    // And again, with those taken out too: said to the user's face, and as the tail of a sentence worth keeping.
    ["Who painted The Night Watch?", "It was painted by Rembrandt in 1642. You have not recorded any specific details about this painting in your documents or memories.",
      "It was painted by Rembrandt in 1642."],
    ["What is a semaphore in programming?", "A semaphore controls access to shared resources. This concept is fundamental in operating systems and concurrent programming, though the user’s documents or memory do not contain specific details about semaphores.",
      "A semaphore controls access to shared resources. This concept is fundamental in operating systems and concurrent programming."],
    // And a third time. What all of them share is the user's documents and memory named together.
    ["Which element has the atomic number 26?", "The element with atomic number 26 is Iron (Fe). This information is based on the periodic table and does not require access to the user's documents or memory.",
      "The element with atomic number 26 is Iron (Fe)."],
    ["Which element has the atomic number 26?", "The element with atomic number 26 is Iron (Fe). This is a general chemistry fact and does not require checking the user's documents or memory.",
      "The element with atomic number 26 is Iron (Fe)."],
    // The same of their personal data, where no memory is named.
    ["Which element has the atomic number 26?", "The element with atomic number 26 is Iron (Fe). This is a fact of chemistry and does not require checking the user's personal data.",
      "The element with atomic number 26 is Iron (Fe)."],
    ["Who directed the film Jaws?", "Steven Spielberg directed it. There is nothing about it in your notes or memory.", "Steven Spielberg directed it."],
    // Qwen3, with the remark first and the answer after it.
    ["Who painted The Night Watch?", "The user has not recorded any information about \"The Night Watch\" in their memory or documents. Based on general knowledge, *The Night Watch* was painted by Rembrandt van Rijn in 1642.",
      "Based on general knowledge, *The Night Watch* was painted by Rembrandt van Rijn in 1642."],
    // Without the pair: "the user" who has recorded nothing, and what is widely known beside their notes.
    ["What is the capital of Australia?", "The capital of Australia is Canberra. The user has not recorded this.", "The capital of Australia is Canberra."],
    [austen, "Jane Austen wrote it. That is widely known, and not something your notes would hold.", "Jane Austen wrote it."],
    // "Tell me" is who the answer is for, not what the question is about.
    ["Tell me who painted The Night Watch.", "Rembrandt painted it. You have not recorded anything about it in your documents.", "Rembrandt painted it."],
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
    // Widely known, and nothing said of the user's records; their records, and nothing said of what is widely known.
    ["Is that well known?", "It is widely known that Canberra is the capital, though many people guess Sydney."],
    ["What's my dog's name?", "I looked for it. Your memory or files do not contain your dog's name. Tell me and I will remember it."],
    // Asked about themselves, what they have not recorded is the answer - as a sentence, and as the tail of one.
    ["What's my dog's name?", "I checked. You have not recorded your dog's name in your documents or memories."],
    ["Which printer did I say I use?", "You mentioned a printer on the second floor, though your notes do not contain its model."],
    // Not recorded, with nothing said of their documents: a question back, in effect.
    ["What is the best way to install Node?", "It depends on the system. You have not mentioned which one you use."],
    // Qwen3, having invented a plot for a film that does not exist: the one sentence that says so stays.
    ["Summarize the plot of the 2029 film The Last Lighthouse, directed by Mara Quill.",
      "A keeper guards the last working lighthouse. (Note: This summary is based on general knowledge and speculative fiction tropes, as the film has not been released as of October 2026.)"],
    // Documents and memory in one sentence, and not the pair: this is how a computer works.
    ["How does a computer start a program?", "It reads the program from disk. The system then loads your files and documents into memory as you open them."],
    // Something else that needs no access to their files.
    ["How does the web version of the editor work?", "It runs in the browser. This app does not require access to your files."],
    // Qwen3, declining: the first sentence is the answer, whatever it says of their records.
    ["Summarize the plot of the 2029 film The Last Lighthouse, directed by Mara Quill.",
      "I don't have access to information about films that are not in the user's documents or memory. A film database would have it."],
    // "The user" of something else is not the person asking.
    ["How does Dropbox work?", "Dropbox keeps the user's files on its servers and copies changes to each of their devices."],
    // Needing nothing is not always about tools.
    ["Do I need a visa?", "No. I don't need to check: citizens of the EU travel there freely."],
    // What was looked for and not found is the answer to a question about the user.
    ["What's my dog's name?", "I looked through what you have told me and found nothing about a dog. You haven't told me your dog's name."],
    ["What's the capital of Australia?", "The capital of Australia is Canberra."],
    // Code is never touched, whatever its comments say.
    ["Write a function that greets someone.", "Here it is.\n```js\n// This is general knowledge and does not require the user's documents.\nfunction greet(name) { return `Hello, ${name}`; }\n```"]
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

test("a reply that is nothing but such sentences is left as it is", () => {
  // Qwen3. Poor as it is, an empty reply would be worse.
  const only = "The user has not recorded any information about this topic in their memory or documents.";
  assert.equal(withoutHandlingRemarks(only, austen), only);
  assert.equal(withoutHandlingRemarks(`${only} No tools were needed.`, austen), `${only} No tools were needed.`);
});

test("a reply that opens by saying what it does not have keeps that sentence", () => {
  // The opening is the answer. What follows it is read as usual.
  const declines = "I don't have access to information about films that are not in the user's documents or memory.";
  assert.equal(withoutHandlingRemarks(`${declines} A film database would have it.`, "Summarize the plot of the 2029 film The Last Lighthouse."),
    `${declines} A film database would have it.`);
  assert.equal(withoutHandlingRemarks(`${declines} No tools were needed.`, "Summarize the plot of the 2029 film The Last Lighthouse."), declines);
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
