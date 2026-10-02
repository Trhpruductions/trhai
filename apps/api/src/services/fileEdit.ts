// Changing part of a file without rewriting all of it.
//
// write_file replaces the whole thing, which means editing an existing file
// requires the model to reproduce every line it is not changing. A small local
// model does not reliably manage that. Asked to add an exclamation mark to a
// greeting, it returned:
//
//   const greet = (name) => `Hello, ${name}!`;
//
// for a file that had also contained `module.exports = { greet }`. The
// exclamation mark was correct. The module was destroyed. Nothing reported a
// problem, because the write succeeded.
//
// A targeted replacement removes the opportunity: the model sends only the text
// it wants changed, so there is nothing else for it to lose.

export type EditOutcome =
  | { ok: true; content: string; occurrences: 1 }
  | { ok: false; reason: string };

/**
 * Replace one exact occurrence of `oldText` with `newText`.
 *
 * Exactly one. Not the first of several, which would edit an arbitrary one of
 * them and report success; and not all of them, because a model that sent an
 * ambiguous snippet did not decide to change every match, it just did not look
 * closely enough. Both cases are the caller's to resolve with more context, and
 * saying so is more useful than picking for them.
 */

/**
 * Where `wanted` sits in `source` when whitespace is allowed to differ.
 *
 * Written as a scan rather than a built regex on purpose: turning arbitrary
 * file text into a pattern means escaping it, and an escaping mistake here
 * would either throw or silently match the wrong span.
 *
 * Every run of whitespace in the sought text matches any run of whitespace in
 * the file, so re-indented quoting still finds its target. Null unless exactly
 * one place matches - relaxing the search must not relax the guarantee that an
 * edit changes one known span.
 */
function looseMatch(source: string, wanted: string): { start: number; end: number } | null {
  const tokens = wanted.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  const isSpace = (character: string) => character.trim() === "";

  /** Match the token run starting exactly at `from`, or null. */
  const matchAt = (from: number): number | null => {
    let at = from;
    for (let index = 0; index < tokens.length; index += 1) {
      if (index > 0) {
        // At least one space between tokens, any amount of it.
        let skipped = 0;
        while (at < source.length && isSpace(source[at])) { at += 1; skipped += 1; }
        if (skipped === 0) return null;
      }
      if (!source.startsWith(tokens[index], at)) return null;
      at += tokens[index].length;
    }
    return at;
  };

  let found: { start: number; end: number } | null = null;
  for (let at = 0; at <= source.length - tokens[0].length; at += 1) {
    if (!source.startsWith(tokens[0], at)) continue;
    const end = matchAt(at);
    if (end === null) continue;
    if (found) return null;          // ambiguous, same refusal as a duplicate
    found = { start: at, end };
  }

  return found;
}

export function applyEdit(source: string, oldText: string, newText: string): EditOutcome {
  if (typeof oldText !== "string" || oldText.length === 0) {
    return { ok: false, reason: "The text to replace was empty." };
  }
  if (typeof newText !== "string") {
    return { ok: false, reason: "There was no replacement text." };
  }
  if (oldText === newText) {
    // Reporting success for a no-op teaches that the edit worked when the file
    // is unchanged, which is how a bug survives a fix that never happened.
    return { ok: false, reason: "The replacement is identical to the original, so nothing would change." };
  }

  const first = source.indexOf(oldText);
  if (first === -1) {
    // Exact match failed. Before giving up, try again allowing whitespace to
    // differ.
    //
    // Seen live: asked to edit a file, the model read it, called edit_file,
    // was told the text was not there, read it again and gave up - the file
    // unchanged. The file was pure LF, so this was not a line-ending problem;
    // the model had simply re-indented what it quoted back. That is a
    // difference it cannot reliably avoid and one that changes nothing about
    // which text is meant.
    //
    // The span replaced is still the real one from the file. Only the search
    // is relaxed, and only when it identifies exactly one place - two
    // candidates is the same ambiguity the duplicate check below refuses, and
    // it is refused here for the same reason.
    const loose = looseMatch(source, oldText);
    if (loose) {
      return {
        ok: true,
        content: source.slice(0, loose.start) + newText + source.slice(loose.end),
        occurrences: 1
      };
    }

    return {
      ok: false,
      reason: "That exact text is not in the file, even allowing for different indentation. "
        + "Read it again and copy the lines verbatim."
    };
  }

  const second = source.indexOf(oldText, first + oldText.length);
  if (second !== -1) {
    const count = source.split(oldText).length - 1;
    return {
      ok: false,
      reason: `That text appears ${count} times, so it is not clear which one to change. `
        + "Include a few surrounding lines to make it unique."
    };
  }

  return {
    ok: true,
    content: source.slice(0, first) + newText + source.slice(first + oldText.length),
    occurrences: 1
  };
}

/**
 * A path or content the model left as a template instead of filling in.
 *
 * Seen live: write_file called with "<new_content>" as the whole of an app's
 * server.js, and a file created at workspace/path/to/file. Neither is anything
 * a user asked for, and the first destroyed the file it replaced.
 *
 * Narrow on purpose: angle brackets around words that name a slot ("content",
 * "code", "your ...", "... here"), so a file that really is one HTML tag is
 * left alone.
 */
export function placeholderIn(target: string, content: string): string | null {
  if (/(?:^|[\\/])path[\\/]to(?:[\\/]|$)/i.test(target) || /[<>]/.test(target)) {
    return `"${target}" is a placeholder, not a real path.`;
  }
  const trimmed = content.trim();
  if (/^<[a-z][\w -]*>$/i.test(trimmed) && /content|text|code|here|placeholder|your|insert|value|updated|new/i.test(trimmed)) {
    return `"${trimmed}" is a placeholder, not what the file should say.`;
  }
  return null;
}

/** A text's non-blank lines, trimmed, so re-indenting a line is not losing it. */
function contentLines(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

/** Words that ask for a whole file to be replaced or transformed, not added to. */
const replaceWholeFile =
  /\b(?:overwrite|rewrite|re-write|redo|regenerate|start (?:it )?over|from scratch|replace (?:the |its |all (?:of )?(?:the |its )?)?(?:whole |entire )?(?:file|contents?|everything|text|code)|clear|empty|wipe|reset|truncate|trim|shorten|cut down|strip|simplify|convert|translate|transform|reformat|format|prettify|beautify|minify|uppercase|lowercase|capitali[sz]e|sort|reorder|only (?:say|says|contain|contains|have|has|keep)|just (?:say|says|contain|contains|have|has)|contains? only|nothing but|(?:delete|remove) (?:everything|all|most))\b/i;

/**
 * A request that only adds to a file - a line, a comment, an entry - rather
 * than changing what is there.
 *
 * Nothing already in the file may go, whatever its size. Live: "add a line
 * saying second note to the end of notes.txt" went to write_file with
 * "\nsecond note", and the file's one line, "first note", was gone; the
 * one-line exemption below let it through.
 */
const onlyAdds =
  /\b(?:add|append|insert|prepend)\b[^.?!]{0,80}\b(?:line|lines|text|sentence|comment|comments|entry|entries|row|rows|item|items|note|paragraph)\b|\bto the (?:end|bottom|top|start|beginning) of\b/i;

/**
 * Whether writing `next` over `current` would throw away most of what the
 * file says, when the request never asked for that.
 *
 * Watched live, twice. Asked to append one line to an app's 233-line
 * server.js, the model made the append with edit_file - then called
 * write_file with "\n// Additional line added\n" as the entire content, and
 * the server was gone. Asked to replace one phrase in a two-line notes file,
 * it made the replacement and then wrote "Notes for the battery project." over
 * both lines. write_file is right for a new file, or for a rewrite or a
 * transformation someone asked for; for anything else edit_file changes only
 * what it names and cannot drop the rest.
 *
 * Measured by what survives, not by size: a write that reproduces the file
 * with a change in it keeps nearly every line and goes through however long
 * the file is, while one that keeps fewer than half of its lines is refused
 * unless the request says in so many words to replace or transform it. Each
 * line of the new text vouches for one line of the old, so a single "}" does
 * not keep every closing brace in a source file. A one-line file is left
 * alone: replacing a single line is an ordinary write.
 *
 * `seenWhole` is false for a file too long to have been shown in one read
 * (see contextBudget). Its middle was a note, so a write of everything the
 * model saw still drops lines - up to two fifths of them for a file just over
 * the limit, which is under the half that otherwise counts as gutting. For
 * such a file nearly every line has to survive.
 */
export function replacesMostOf(
  current: string,
  next: string,
  request: string | undefined,
  seenWhole = true
): { before: number; kept: number } | null {
  const before = contentLines(current);
  const adding = onlyAdds.test(request ?? "") && !replaceWholeFile.test(request ?? "");
  if (before.length < (adding ? 1 : 2)) return null;

  const available = new Map<string, number>();
  for (const line of contentLines(next)) available.set(line, (available.get(line) ?? 0) + 1);
  let kept = 0;
  for (const line of before) {
    const left = available.get(line) ?? 0;
    if (left > 0) {
      kept += 1;
      available.set(line, left - 1);
    }
  }

  const enough = adding
    ? kept === before.length
    : seenWhole ? kept * 2 >= before.length : kept * 10 >= before.length * 9;
  if (enough) return null;
  if (replaceWholeFile.test(request ?? "")) return null;
  return { before: before.length, kept };
}

/**
 * A short description of what an edit did, for the activity trace.
 *
 * Line counts rather than the text itself: a diff belongs in the file, and a
 * trace row that carried one would be unreadable at the size it is drawn.
 */
export function describeEdit(oldText: string, newText: string): string {
  const removed = oldText.split("\n").length;
  const added = newText.split("\n").length;
  if (removed === added) return `${added} line${added === 1 ? "" : "s"} changed`;
  return `${removed} line${removed === 1 ? "" : "s"} replaced with ${added}`;
}
