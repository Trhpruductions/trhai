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
    return {
      ok: false,
      reason: "That exact text is not in the file. Read it again and copy the lines verbatim, "
        + "including indentation."
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
