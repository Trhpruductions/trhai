import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// A workspace of its own: a turn that reaches the model is offered tools.
process.env.ASCEND_WORKSPACE = mkdtempSync(path.join(tmpdir(), "trhai-there-"));

const { resolvePlaceReference } = await import("../src/services/placeReference.js");
const { runAgent } = await import("../src/services/agentLoop.js");
const { fakeEngine } = await import("./helpers/fakeEngine.js");

// "there" is the place the answer before it gave.
//
// Found on the evaluation of 2 October, with both models. "What's the capital
// of Australia?" was answered "The capital of Australia is Canberra." The next
// message, "And roughly how many people live there?", got "Australia has a
// population of approximately 26 million people." from qwen2.5-coder and "The
// population of Australia is approximately 26 million people." from Qwen3.
// Each had both turns in front of it.
//
// Measured on 3 and 4 October with the real models. The app's own request,
// put to qwen2.5-coder three times each way: as typed, three answers for
// Australia; with the place said, three for Canberra. Then through the whole
// app, three conversations on each model: all six answered for Canberra.
// (The 3B answers for Canberra either way.)

type Turn = { role: "user" | "assistant"; content: string };
const exchange = (question: string, answer: string): Turn[] => [{ role: "user", content: question }, { role: "assistant", content: answer }];
const capital = "What's the capital of Australia?";
const there = (question: string, answer: string, followUp: string) => resolvePlaceReference(followUp, exchange(question, answer))?.place ?? null;

test("the place the last answer gave is what \"there\" means", () => {
  // The conversation the evaluation ran.
  assert.deepEqual(resolvePlaceReference("And roughly how many people live there?", exchange(capital, "The capital of Australia is Canberra.")), {
    place: "Canberra",
    note: "(\"there\" is Canberra, the place the previous answer gave.)"
  });

  for (const [question, answer, followUp, place] of [
    // However the answer is put.
    ["What is the capital of France?", "Paris.", "What's the weather like there?", "Paris"],
    ["what's the capital of france", "The capital of France is Paris.", "how many people live there", "Paris"],
    [capital, "**Canberra** is the capital of Australia.", "What's the population there?", "Canberra"],
    [capital, "Sure! The capital of Australia is Canberra.", "How far is it from there to the coast?", "Canberra"],
    [capital, "Australia's capital is Canberra.", "Who lives there?", "Canberra"],
    [capital, "Yes, Canberra.", "is it nice there?", "Canberra"],
    // The country again in another form is not a second place.
    [capital, "The capital of Australia is Canberra, the Australian seat of government.", "How many people live there?", "Canberra"],
    // Names of more than one word, and letters outside English.
    ["What is the capital of the United States?", "The capital of the United States is Washington, D.C.", "What time is it there?", "Washington, D.C."],
    ["What's the biggest city in Missouri?", "That would be Kansas City.", "How many people live there?", "Kansas City"],
    ["What is the capital of Brazil?", "The capital of Brazil is Brasília.", "How many people live there?", "Brasília"],
    // Other questions that ask for a place.
    ["What's the largest city in Texas?", "Houston is the largest city in Texas.", "How hot does it get there in July?", "Houston"],
    ["Which country has the longest coastline?", "Canada.", "What languages do people speak there?", "Canada"],
    ["Which city hosted the 2012 Olympics?", "London hosted them.", "Is it expensive to stay there?", "London"],
    ["Where should I go on holiday in Europe?", "I'd suggest Lisbon.", "What's the food like there?", "Lisbon"],
    ["Where can I buy stamps near me?", "Try Walmart.", "How late are they open there?", "Walmart"]
  ]) {
    assert.equal(there(question, answer, followUp), place, `${answer} | ${followUp}`);
  }
});

test("nothing is said when the turn before does not settle it", () => {
  const people = "How many people live there?";
  for (const [question, answer, followUp] of [
    // Two places in the answer: which one is not for this to say.
    [capital, "Canberra is the capital; Sydney is the largest city.", people],
    [capital, "The capital of Australia is Canberra. It is located in the Australian Capital Territory.", people],
    [capital, "Many people think it's Sydney. It's actually Canberra.", people],
    ["What is the capital of Missouri?", "The capital of Missouri is Jefferson City, not St. Louis.", people],
    ["Which city hosted the 2012 Olympics?", "London hosted the 2012 Summer Olympics.", "Is it expensive to stay there?"],
    // The question was not asking for a place, so the name in its answer is not one.
    ["Who is the president of France?", "Emmanuel Macron.", people],
    ["Tell me about Australia.", "Australia is a country in the Southern Hemisphere. Its capital is Canberra.", people],
    // A question about where a named thing is: the thing may still be what "there" means.
    ["Where is the Eiffel Tower?", "It's in Paris.", "How do I get there by train?"],
    ["Where is Canberra?", "Canberra is in the Australian Capital Territory.", people],
    ["Which state is Chicago in?", "Chicago is in Illinois.", "What's the sales tax there?"],
    ["Which country is Canberra the capital of?", "Australia.", people],
    // The answer named no place, or named something on the way to one.
    [capital, "I'm not sure.", people],
    ["Which city is the oldest in Australia?", "The oldest was founded by Arthur Phillip.", people],
    // The message has a place of its own.
    [capital, "Canberra.", "I went to Perth last year. How many people live there?"],
    [capital, "Canberra.", "What about Tasmania, how many live there?"],
    // Files and code are not places.
    ["Where should I put the import?", "It goes in App.tsx.", "what else goes there?"],
    ["Where can I find the option?", "It is in Settings/advanced.", "what else is kept there?"]
  ]) {
    assert.equal(there(question, answer, followUp), null, `${answer} | ${followUp}`);
  }

  // Only the turn before counts, and only when it is an answer.
  assert.equal(resolvePlaceReference(people, []), null);
  assert.equal(resolvePlaceReference(people, undefined), null);
  assert.equal(resolvePlaceReference(people, [...exchange(capital, "Canberra."), ...exchange("thanks", "You're welcome.")]), null);
  assert.equal(resolvePlaceReference(people, [{ role: "user", content: capital }, { role: "user", content: "hello?" }]), null);
});

test("a \"there\" that is no place is left alone", () => {
  for (const followUp of [
    "Is there a zoo?",
    "How many planets are there?",
    "And how many people are there?",
    "there's a typo in that",
    "There will be rain tomorrow, won't there?",
    "Has there been an election lately?",
    "Hi there",
    "Are you there?",
    "there you go, thanks",
    "Is anyone out there?"
  ]) {
    assert.equal(there(capital, "Canberra.", followUp), null, followUp);
  }
  // The control: the same turn before, and a "there" that is somewhere.
  assert.equal(there(capital, "Canberra.", "Is there a zoo there?"), "Canberra");
  assert.equal(there(capital, "Canberra.", "have you been there?"), "Canberra");
});

const config = (baseUrl: string) => ({ baseUrl, model: "llama3.2", modelFromEnv: true, timeoutMs: 4000 });
const followUp = "And roughly how many people live there?";
const note = "(\"there\" is Canberra, the place the previous answer gave.)";

test("the model is told which place, and everything else reads the request as typed", async () => {
  const engine = await fakeEngine({ reply: { message: { content: "Canberra has about 450,000 people." } } });
  /** Runs one turn and gives back the first request it made of the model. */
  const firstRequest = async (conversation: Turn[]) => {
    const from = engine.chats.length;
    const result = await runAgent(config(engine.baseUrl), followUp, { memories: [], knowledge: [], conversation, request: followUp });
    assert.equal(result.ok, true, result.ok ? "" : result.reason);
    return engine.chats[from];
  };
  const words = (request: (typeof engine.chats)[number]) => (request.messages ?? []).map((message) => `${message.role}: ${message.content}`);
  const offered = (request: (typeof engine.chats)[number]) => (request.tools ?? []).map((tool) => tool.function.name);

  try {
    const told = await firstRequest(exchange(capital, "The capital of Australia is Canberra."));
    assert.deepEqual(words(told).slice(1), [
      `user: ${capital}`,
      "assistant: The capital of Australia is Canberra.",
      `user: ${followUp}\n\n${note}`
    ], "the two turns before as they were said, then the message with the place");

    // The control: the same message with nothing before it goes as typed.
    const alone = await firstRequest([]);
    assert.deepEqual(words(alone).slice(1), [`user: ${followUp}`]);
    assert.ok(offered(alone).length > 0);
    assert.deepEqual(offered(told), offered(alone), "the note changes nothing about which tools are on offer");

    // A client that sends the message being answered as the last turn of its history: said once, with the note.
    const sentTwice = await firstRequest([...exchange(capital, "The capital of Australia is Canberra."), { role: "user", content: followUp }]);
    assert.deepEqual(words(sentTwice).slice(1), [
      `user: ${capital}`,
      "assistant: The capital of Australia is Canberra.",
      `user: ${followUp}\n\n${note}`
    ]);

    // And an answer that names two places leaves the message alone.
    const unsettled = await firstRequest(exchange(capital, "Canberra is the capital; Sydney is the largest city."));
    assert.equal(words(unsettled).at(-1), `user: ${followUp}`);
  } finally {
    await engine.close();
  }
});
