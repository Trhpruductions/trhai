import test from "node:test";
import assert from "node:assert/strict";
import {
  claimsUnperformedMutation, claimsUnusedTool, contradictsToolRecord, correctionFor,
  noChangeWasMade, promisesUnperformedMutation
} from "../src/services/contradictedClaims.js";

// The mirror of fabricated success, seen live: two read_file calls returned ok,
// and the model then said "the tool refused to read the file because it is
// located on the local machine, and I do not have permission to access it."
// The trace showed two ticks. The user was told the app could not do a thing it
// had just done.

const ok = [{ name: "read_file", ok: true }];
const failed = [{ name: "read_file", ok: false }];

test("denying a read that succeeded is a contradiction", () => {
  assert.equal(
    contradictsToolRecord(
      "The tool refused to read the file because I do not have permission to access it.",
      ok
    ),
    true
  );
});

test("the phrasings a model actually reaches for are caught", () => {
  for (const claim of [
    "I could not read the file.",
    "I was unable to access that file.",
    "Access denied.",
    "I don't have permission to read it.",
    "The tool failed to open the file."
  ]) {
    assert.equal(contradictsToolRecord(claim, ok), true, `should catch: ${claim}`);
  }
});

test("a claim of failure is left alone when something really failed", () => {
  // If a tool genuinely failed, the model saying so is correct, and this must
  // stay out of the way.
  assert.equal(
    contradictsToolRecord("I could not read the file.", failed),
    false
  );
});

test("a turn with no tools is not checked", () => {
  // Nothing to contradict. Explaining that a tool would be refused is a fair
  // thing to say when none ran.
  assert.equal(contradictsToolRecord("I do not have permission to do that.", []), false);
});

test("true statements about the permission ladder are not caught", () => {
  // The app really does gate destructive tools. Saying so must remain possible.
  for (const claim of [
    "run_command needs your confirmation before it can run.",
    "Deleting a document is a destructive action and asks first.",
    "Machine access is switched off, so I stayed in the workspace."
  ]) {
    assert.equal(contradictsToolRecord(claim, ok), false, `should allow: ${claim}`);
  }
});

test("an ordinary successful answer is not caught", () => {
  assert.equal(
    contradictsToolRecord("The file exports a greeting helper and nothing else.", ok),
    false
  );
});

test("the correction names the tools that actually ran", () => {
  const message = correctionFor([
    { name: "read_file", ok: true },
    { name: "read_file", ok: true },
    { name: "list_files", ok: true }
  ]);
  assert.match(message, /read_file, list_files/);
  assert.match(message, /ran successfully/i);
  assert.match(message, /do not say a tool failed when it did not/i);
});

// A change the model says it made, and did not.
//
// Seen live: asked to read a file and edit it, the model called read_file,
// never called edit_file, and answered "The edited code is saved as greet.js".
// The file was untouched.

test("claiming a save when nothing was written is caught", () => {
  for (const claim of [
    "The edited code is saved as greet.js.",
    "I have updated the file for you.",
    "I've edited greet.js.",
    "The file has been created.",
    "Successfully saved your changes.",
    "The updated version is saved."
  ]) {
    assert.equal(claimsUnperformedMutation(claim, false), true, `should catch: ${claim}`);
  }
});

test("the same claim is fine when something really was written", () => {
  assert.equal(claimsUnperformedMutation("I have updated the file for you.", true), false);
});

test("offers and descriptions are not claims of completion", () => {
  // "I can edit that" must stay sayable, and describing what a program does is
  // not describing what the assistant did.
  for (const fine of [
    "I can edit that file if you want me to.",
    "Shall I save that for you?",
    "The file saves your settings between runs.",
    "Editing it would mean changing the export as well.",
    "To create a file, tell me the path."
  ]) {
    assert.equal(claimsUnperformedMutation(fine, false), false, `should allow: ${fine}`);
  }
});

test("the truthful replacement names what ran and what did not", () => {
  const message = noChangeWasMade([{ name: "read_file", ok: true }]);
  assert.match(message, /I ran read_file/);
  assert.match(message, /nothing was written/i);
  assert.doesNotMatch(message, /\bsaved\b|\bdone\b/i);
});

test("the replacement still works when no tool ran at all", () => {
  const message = noChangeWasMade([]);
  assert.match(message, /nothing was written/i);
  assert.doesNotMatch(message, /I ran/);
});

// The phrasings the first version of this check missed, taken verbatim from a
// live reply. llama3.2 was asked to read a file and edit it; it invented the
// file's contents, called edit_file with text that was not in the real file so
// the call failed, and then said all of this.

test("the live phrasings that slipped through are caught", () => {
  for (const claim of [
    "I've added an `else` clause to log the greeting only when name is not empty.",
    "The updated JavaScript file is now available in the workspace.",
    "I've applied the fix to greet.js.",
    "I have appended the guard to the function.",
    "The change has been written.",
    "I've replaced the body of the method."
  ]) {
    assert.equal(claimsUnperformedMutation(claim, false), true, `should catch: ${claim}`);
  }
});

test("an ambiguous verb with no file in sight is left alone", () => {
  // The false positive the split exists to prevent. "added" is a mutation verb
  // in "I added a guard to the file" and arithmetic in "I added two and two",
  // and calling the second one a lie would replace a true answer with a false
  // denial - the worst outcome this check can produce.
  for (const fine of [
    "I added two and two to get four.",
    "I've applied that reasoning to the numbers.",
    "I have added up the totals for you.",
    "I fixed my earlier mistake in the explanation above."
  ]) {
    assert.equal(claimsUnperformedMutation(fine, false), false, `should allow: ${fine}`);
  }
});

test("the same ambiguous verb does count when it names code", () => {
  assert.equal(claimsUnperformedMutation("I added a guard to the function.", false), true);
  assert.equal(claimsUnperformedMutation("I added a null check to app.ts.", false), true);
});

// The same failure in the future tense.

test("a promise to write, at the end of a turn, counts as an unmade change", () => {
  // Verbatim from a live reply. read_file succeeded, edit_file failed because
  // the model had misremembered the file, and the turn ended on this sentence.
  // There is no later for it to happen in.
  for (const promise of [
    "I will now write the file with the changes.",
    "I'll update greet.js for you.",
    "Let me edit that file now.",
    "Now I'll save the corrected version.",
    "I am going to create the file."
  ]) {
    assert.equal(promisesUnperformedMutation(promise, false), true, `should catch: ${promise}`);
  }
});

test("an offer waiting on an answer is not a promise", () => {
  // These are the assistant behaving correctly when it needs a decision first,
  // and treating them as broken promises would punish exactly the right move.
  for (const offer of [
    "I can edit that file if you want me to.",
    "Shall I update it?",
    "Would you like me to write the file?",
    "Let me know and I'll make the change.",
    "If you'd like, I'll create it for you."
  ]) {
    assert.equal(promisesUnperformedMutation(offer, false), false, `should allow: ${offer}`);
  }
});

test("a promise kept is not a promise broken", () => {
  assert.equal(promisesUnperformedMutation("I'll update it now.", true), false);
});

test("a question early on does not excuse a promise at the end", () => {
  // Judged per sentence. A long answer that asks something in passing and then
  // ends on a commitment has still made the commitment.
  const reply = "Do you want the guard at the top? Either way, I will now write the file.";
  assert.equal(promisesUnperformedMutation(reply, false), true);
});

// Credit given to a tool that never ran.

test("claiming a tool ran when none did is caught", () => {
  // The first one is verbatim, and it was the entire reply to "what is 2+2".
  // There is no calculate tool in this app.
  for (const claim of [
    "I used the `calculate` tool to evaluate the expression `2+2`.",
    "I called read_file to get the contents.",
    "Using the search_memory tool, I found nothing relevant.",
    "The calculate tool returned 4.",
    "I ran run_command to check the version."
  ]) {
    assert.equal(claimsUnusedTool(claim, []), true, `should catch: ${claim}`);
  }
});

test("describing real work is left alone", () => {
  // Once anything ran, the model narrating it is ordinary. Imprecise narration
  // is not what this check is for, and policing it would punish normal writing.
  const ran = [{ name: "read_file", ok: true }];
  assert.equal(claimsUnusedTool("I used the read_file tool to open it.", ran), false);
  assert.equal(claimsUnusedTool("I called search_memory and found nothing.", ran), false);
});

test("offering or explaining a tool is not claiming to have used one", () => {
  for (const fine of [
    "I can use read_file to open that if you give me the path.",
    "You could use the edit_file tool for a targeted change.",
    "read_file opens a file; write_file replaces one.",
    "Tell me the path and I will read it."
  ]) {
    assert.equal(claimsUnusedTool(fine, []), false, `should allow: ${fine}`);
  }
});

test("ordinary past-tense prose is not a tool claim", () => {
  // "I found", "I remembered" and similar are normal English. Only a named tool
  // or the word "tool" itself makes it a claim about this app's machinery.
  for (const fine of [
    "I found that two plus two is four.",
    "I remembered you mentioned Postgres earlier.",
    "I used a different approach to explain it."
  ]) {
    assert.equal(claimsUnusedTool(fine, []), false, `should allow: ${fine}`);
  }
});
