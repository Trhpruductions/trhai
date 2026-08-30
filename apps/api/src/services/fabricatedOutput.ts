// Tool results the model made up.
//
// Some models narrate their working in tags borrowed from their training
// format, and a reply came back looking like this:
//
//   <toolresponse> function greet(name) { ... } </toolresponse>
//   <toolresponse> greet.js edited successfully. </toolresponse>
//
// The second block is the problem. The edit had failed. Nothing was changed.
// The model wrote a success message in the shape of a tool result and the app
// handed it to the user as the answer - the exact failure this whole codebase
// is built against, arriving through a door nobody had thought to close.
//
// Stripping only the tags would be worse than useless: it would leave
// "greet.js edited successfully" as plain prose, which is the false claim
// without the marking that reveals it. The blocks go entirely.
//
// A real tool result never reaches the user this way. It is fed back to the
// model as a tool message, and what the user sees is the model's own summary
// plus the execution trace, which is written by the code that did the work.
// So anything wearing this shape in a final reply is invention by definition.

/** Tag names models use for this, opening or closing, with or without an underscore. */
const fabricatedBlock =
  /<\s*\/?\s*tool[_-]?(?:response|result|output|call)s?\s*>/gi;

/**
 * The same invention written as prose instead of as tags.
 *
 * Caught live, and it walked straight past the tag stripper because there were
 * no tags in it. Asked to read a file and edit it, llama3.2 replied:
 *
 *   Running command: `run_command: cd .../src/greet.js`
 *
 *   Result:
 *   ```
 *   let name = req.query.name;
 *   ...
 *   ```
 *
 * None of that happened. run_command was never called, and the "Result" was
 * code that appears nowhere in the real file - the model invented the file's
 * contents and then answered questions about them. Presenting that block to the
 * user is worse than presenting nothing: it looks like evidence.
 *
 * Anchored on this app's own tool names, which is what makes it safe. A reply
 * explaining how to run tests may well say "Running: `npm test`" followed by an
 * example of the output, and that is ordinary helpful writing; no such reply
 * says `run_command:` or `edit_file:`, because those names exist only inside
 * this process.
 */
const ownToolNames =
  "run_command|run_script|read_file|write_file|edit_file|list_files|build_app"
  + "|search_memory|remember|forget|pin_memory|fetch_url"
  + "|write_document|update_document|delete_document";

const narratedToolRun = new RegExp(
  // "Running command: `run_command: ...`" - the announcement line
  `^[ \\t]*(?:running|executing|calling|invoking|used|using)\\b[^\\n]*\\b(?:${ownToolNames})\\b[^\\n]*\\n`
  // then an optional "Result:" label and the fenced block it introduces
  + `(?:[ \\t]*\\n)*`
  + `(?:[ \\t]*(?:result|results|output)s?[ \\t]*:?[ \\t]*\\n(?:[ \\t]*\\n)*`
  + "(?:```[^\\n]*\\n[\\s\\S]*?```[ \\t]*\\n?)?)?",
  "gim"
);

/**
 * Remove invented tool transcripts written as prose.
 *
 * The announcement line goes, and so does the "Result:" block it introduces -
 * for the same reason the tagged version is removed whole rather than unwrapped.
 * Leaving the invented output behind while removing the line that labels it as
 * output is the worst of both: the fiction stays and the marking that would let
 * anyone spot it is gone.
 */
export function stripNarratedToolRuns(text: string): string {
  narratedToolRun.lastIndex = 0;
  if (!narratedToolRun.test(text)) return text;
  narratedToolRun.lastIndex = 0;
  return text.replace(narratedToolRun, "");
}

/**
 * Whether a reply contains fabricated tool markup at all.
 *
 * Cheap enough to run on every reply, and the answer is nearly always no.
 */
export function hasFabricatedToolOutput(text: string): boolean {
  fabricatedBlock.lastIndex = 0;
  return fabricatedBlock.test(text);
}

/**
 * Remove fabricated tool blocks and whatever they contain.
 *
 * Everything between an opening tag and its closing tag goes, because that
 * span is the invented result. An unclosed tag takes the rest of the text with
 * it: a model that opened one and kept going was writing the same fiction, and
 * keeping the tail because it forgot to close would preserve exactly the claims
 * this exists to remove.
 */
export function stripFabricatedToolOutput(text: string): string {
  const withoutNarration = stripNarratedToolRuns(text);
  if (!hasFabricatedToolOutput(withoutNarration)) {
    return withoutNarration === text ? text : withoutNarration.replace(/\n{3,}/g, "\n\n").trim();
  }
  text = withoutNarration;

  const segments: string[] = [];
  let cursor = 0;
  let depth = 0;

  fabricatedBlock.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = fabricatedBlock.exec(text)) !== null) {
    const isClosing = /\/\s*tool/i.test(match[0]);

    if (!isClosing) {
      if (depth === 0) segments.push(text.slice(cursor, match.index));
      depth += 1;
    } else if (depth > 0) {
      depth -= 1;
      if (depth === 0) cursor = match.index + match[0].length;
    } else {
      // A closing tag with nothing open: drop the tag, keep the text.
      segments.push(text.slice(cursor, match.index));
      cursor = match.index + match[0].length;
    }
  }

  // depth > 0 means a block was opened and never closed, so the remainder is
  // part of it and is discarded with the rest.
  if (depth === 0) segments.push(text.slice(cursor));

  return segments
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
