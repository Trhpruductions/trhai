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

/** Lines in a piece of text, not counting the newline that ends the last one. */
function lineCount(text: string): number {
  return text.length === 0 ? 0 : text.replace(/\n$/, "").split("\n").length;
}

/** Words that ask for a whole file to be replaced rather than added to. */
const replaceWholeFile =
  /\b(?:overwrite|rewrite|re-write|start (?:it )?over|from scratch|replace (?:the |its |all (?:of )?(?:the |its )?)?(?:whole |entire )?(?:file|contents?|everything|text|code)|clear|empty|wipe|reset|truncate|trim|shorten|cut down|strip|simplify|only (?:say|says|contain|contains|have|has|keep)|just (?:say|says|contain|contains|have|has)|contains? only|nothing but|(?:delete|remove) (?:everything|all|most))\b/i;

/**
 * Whether writing `next` over `current` would throw most of a file away when
 * the request never asked for that.
 *
 * Watched live: asked to append one line to an app's 233-line server.js, the
 * model made the append with edit_file - then called write_file with
 * "\n// Additional line added\n" as the entire content, and the server was
 * gone. write_file is right for a new file, or for a rewrite someone asked
 * for; for anything else edit_file changes only what it names and cannot drop
 * the rest. So a write that keeps less than half of a file of ten lines or
 * more is refused, unless the request says in so many words to replace it.
 */
export function replacesMostOf(
  current: string,
  next: string,
  request: string | undefined
): { before: number; after: number } | null {
  const before = lineCount(current);
  const after = lineCount(next);
  if (before < 10 || after * 2 >= before) return null;
  if (replaceWholeFile.test(request ?? "")) return null;
  return { before, after };
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
