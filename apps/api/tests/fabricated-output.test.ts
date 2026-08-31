import test from "node:test";
import assert from "node:assert/strict";
import { hasFabricatedToolOutput, stripFabricatedToolOutput } from "../src/services/fabricatedOutput.js";

// The reply that made this necessary, verbatim in shape:
//
//   <toolresponse> function greet(name) { ... } </toolresponse>
//   <toolresponse> greet.js edited successfully. </toolresponse>
//
// The edit had failed. Nothing was changed. The model wrote a success message
// in the shape of a tool result and the app handed it to the user as fact.

test("a fabricated success claim does not reach the user", () => {
  const reply = "Here you go.\n<toolresponse> greet.js edited successfully. </toolresponse>";
  const cleaned = stripFabricatedToolOutput(reply);
  assert.doesNotMatch(cleaned, /edited successfully/);
  assert.match(cleaned, /Here you go\./);
});

test("the contents go with the tags, not just the tags", () => {
  // Stripping only the markup would leave the false claim as plain prose -
  // the same lie with the marking that reveals it removed.
  const reply = "<toolresponse>the file was updated</toolresponse>";
  assert.equal(stripFabricatedToolOutput(reply), "");
});

test("real prose either side of a block survives", () => {
  const reply = "I read the file.\n<tool_response>contents</tool_response>\nIt defines one function.";
  const cleaned = stripFabricatedToolOutput(reply);
  assert.match(cleaned, /I read the file\./);
  assert.match(cleaned, /It defines one function\./);
  assert.doesNotMatch(cleaned, /contents/);
});

test("several blocks are all removed", () => {
  const reply = [
    "<toolresponse> function greet(name) {} </toolresponse>",
    "<toolresponse> greet.js edited successfully. </toolresponse>"
  ].join("\n");
  assert.equal(stripFabricatedToolOutput(reply), "");
});

test("an unclosed block takes the rest with it", () => {
  // A model that opened one and kept going was writing the same fiction.
  // Keeping the tail because it forgot to close would preserve exactly the
  // claims this exists to remove.
  const reply = "Done.\n<toolresponse> everything worked perfectly and the file is saved";
  const cleaned = stripFabricatedToolOutput(reply);
  assert.match(cleaned, /^Done\.$/);
});

test("the spellings models actually use are all recognised", () => {
  for (const tag of ["toolresponse", "tool_response", "tool-response", "tool_result", "tool_output", "tool_call"]) {
    const reply = `<${tag}>invented</${tag}>`;
    assert.equal(hasFabricatedToolOutput(reply), true, `should recognise ${tag}`);
    assert.equal(stripFabricatedToolOutput(reply), "", `should strip ${tag}`);
  }
});

test("an ordinary reply is returned untouched", () => {
  // This runs on every reply, so it must not disturb the normal case.
  const reply = "The version is 0.1.3, read from apps/api/package.json.";
  assert.equal(hasFabricatedToolOutput(reply), false);
  assert.equal(stripFabricatedToolOutput(reply), reply);
});

test("prose mentioning a tool by name is not mistaken for markup", () => {
  const reply = "I used edit_file to make that change, and the tool response confirmed it.";
  assert.equal(stripFabricatedToolOutput(reply), reply);
});

test("a stray closing tag drops the tag and keeps the text", () => {
  const reply = "The file has one function.</toolresponse>";
  assert.equal(stripFabricatedToolOutput(reply), "The file has one function.");
});

test("repeated calls give the same answer", () => {
  // The pattern is a module-level regex with the global flag, whose lastIndex
  // persists between calls - a classic way for the second call to disagree
  // with the first.
  const reply = "Fine.\n<toolresponse>invented</toolresponse>";
  const first = stripFabricatedToolOutput(reply);
  const second = stripFabricatedToolOutput(reply);
  assert.equal(first, second);
  assert.equal(hasFabricatedToolOutput(reply), hasFabricatedToolOutput(reply));
});

// The same invention written as prose rather than as tags.

test("a narrated tool run and its invented result are both removed", () => {
  // Verbatim from a live reply. run_command was never called and the "Result"
  // is code that appears nowhere in the real file.
  const reply = [
    "Running command: `run_command: cd /tmp/src/greet.js`",
    "",
    "Result:",
    "```",
    "let name = req.query.name;",
    "if (!name) { throw new Error('Name is required'); }",
    "```",
    "",
    "To edit the file, I will update the code."
  ].join("\n");

  const cleaned = stripFabricatedToolOutput(reply);
  assert.doesNotMatch(cleaned, /Running command/);
  assert.doesNotMatch(cleaned, /req\.query\.name/, "the invented result must not survive");
  assert.doesNotMatch(cleaned, /Result:/);
  assert.match(cleaned, /To edit the file/, "the model's own prose is kept");
});

test("an ordinary explanation of a shell command is left alone", () => {
  // The false positive the tool-name anchor prevents. This is helpful writing,
  // and stripping it would make the assistant worse at explaining things.
  const reply = [
    "Running the suite is straightforward:",
    "",
    "```bash",
    "npm test",
    "```",
    "",
    "Output looks like `120 passing`."
  ].join("\n");

  assert.equal(stripFabricatedToolOutput(reply), reply);
});

test("a reply that is only a narrated run comes back empty", () => {
  // Nothing but the fiction means there was no answer underneath it, and the
  // loop treats an empty result as an unusable reply rather than an answer.
  const reply = "Using read_file: /tmp/a.txt\n\nResult:\n```\nmade up\n```\n";
  assert.equal(stripFabricatedToolOutput(reply).trim(), "");
});

test("prose mentioning a tool by name is not a narrated run", () => {
  const reply = "I can use read_file to open that for you if you give me the path.";
  assert.equal(stripFabricatedToolOutput(reply), reply);
});

test("the narrated-run check is not stateful across calls", () => {
  // narratedToolRun carries the global flag, and .test() on a /g/ regex
  // advances lastIndex - so a second call on identical input can silently miss.
  // Cheap to prove, and the failure mode would be invisible: fabrication caught
  // on one reply and waved through on the next.
  const reply = "Using read_file: /tmp/a.txt\n\nResult:\n```\nmade up\n```\n\nReal answer here.";

  const first = stripFabricatedToolOutput(reply);
  const second = stripFabricatedToolOutput(reply);
  const third = stripFabricatedToolOutput(reply);

  assert.equal(first, second, "a repeated call must give the same answer");
  assert.equal(second, third);
  assert.doesNotMatch(first, /made up/);
  assert.match(first, /Real answer here/);
});

test("an unclosed tool_request takes its payload with it", () => {
  // Verbatim shape from a live reply. An edit had failed and the model
  // answered: "Understood. I will read the file again and copy the lines
  // verbatim." followed by a literal <tool_request> block. The tag list had
  // response, result, output and call - a request sailed straight through and
  // internal plumbing was shown to the user as the answer.
  const reply = 'Understood. I will read the file again.\n\n'
    + '<tool_request> read_file {"path":"C:/work/greet.js"}';

  const cleaned = stripFabricatedToolOutput(reply);
  assert.doesNotMatch(cleaned, /tool_request/);
  assert.doesNotMatch(cleaned, /read_file/, "the payload goes with the tag");
  assert.match(cleaned, /Understood/, "the model's own sentence survives");
});

test("the other spellings are caught too", () => {
  for (const tag of ["tool_request", "toolrequest", "tool-use", "tool_invocation"]) {
    const cleaned = stripFabricatedToolOutput(`Answer.\n\n<${tag}> secret payload </${tag}>`);
    assert.doesNotMatch(cleaned, /secret payload/, `${tag} leaked`);
    assert.match(cleaned, /Answer/);
  }
});
