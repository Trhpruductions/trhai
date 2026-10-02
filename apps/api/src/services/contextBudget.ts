// Keeping every request inside the model's context window.
//
// Ollama does not refuse a prompt that is longer than the window. It cuts it
// from the front, silently, and the front is the rules: the system prompt,
// the date, the workspace and the active agent (see defaultContextTokens in
// localModel.ts, which is how that was found). A bigger window made the usual
// turn fit; it did not make every turn fit. read_file returned up to 100,000
// bytes - about 28,000 tokens on its own - and a command's output up to
// 20,000 bytes twice over, so one large read was still enough to push the rules
// out, with nothing anywhere saying it had happened.
//
// Three measures, all visible to the model:
//
// - read_file shows a long file as its start and its end, says which lines
//   were left out, and takes start_line and end_line to show exactly those.
// - No other tool result is longer than maxToolResultTokens either. A longer
//   one keeps its start and its end, and says what was left out.
// - Before each request the whole prompt is measured, and the largest tool
//   results are shortened, the same way, until it fits. The system prompt and
//   the question are never touched: they are what the cut used to take.
//
// Measured in tokens, estimated (see estimateTokens), because characters are
// not a stable unit here: the same 12,000 characters were 3,000 tokens of
// prose and 9,000 of base64 when counted by the model's own tokenizer.

/** Tokens kept free for the reply itself. */
export const replyReserveTokens = 1500;

/** The most a single tool result takes from the window, in estimated tokens. */
export const maxToolResultTokens = 4000;

/** What each message costs beyond its content: its role and the template around it. */
const messageOverheadTokens = 6;

/** The shortest an earlier result is cut down to, in characters, however tight the window. */
const minShortenedChars = 600;

/**
 * Words that appear in every note this file writes into a result. A write
 * that carries one is a copy of a shortened view - see elisionIn.
 */
const noteMarker = "left out here to fit the model's working memory";

type ToolCallShape = { function: { name: string; arguments: Record<string, unknown> } };
type Message = { role: string; content: string; tool_calls?: ToolCallShape[] };

/** How many tokens of prompt a window of `contextTokens` can take. */
export function promptBudgetTokens(contextTokens: number): number {
  return Math.max(1000, contextTokens - replyReserveTokens);
}

// Pieces the estimate counts separately: a word or a capitalised part of one,
// a run of capitals, one digit, horizontal space, a line break with the
// indentation after it, a run of punctuation, one character beyond ASCII.
const tokenPieces = /[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d|[^\S\n]+|\n\s*|[^\sA-Za-z\d\u0080-￿]+|[\u0080-￿]/g;
const vowel = /[aeiouy]/i;

/**
 * Roughly how many tokens `text` is for the model, erring a little high.
 *
 * Calibrated against qwen2.5-coder's own count. Its tokenizer gives every
 * digit a token of its own, so a process table or an IP list runs about two
 * characters a token, base64 and hex nearer one, and source code four:
 * dividing the length by any one number was wrong by up to four times for
 * one kind of text or another. Counted by kind instead, it lands within about
 * ten percent either way for code, prose, JSON, command output and listings -
 * an over-count only shortens a result a little early, and the reply's
 * reserve covers an under-count of that size.
 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const [piece] of text.matchAll(tokenPieces)) {
    const code = piece.charCodeAt(0);
    if (code >= 0x80 || (code >= 48 && code <= 57)) {
      tokens += 1;
    } else if (/[a-z]/.test(piece)) {
      // A real word is one token up to about seven letters. A run with no
      // vowel in it is usually not a word - an abbreviation, or random text
      // such as base64 - and the tokenizer spends far more on those.
      tokens += piece.length >= 2 && !vowel.test(piece) ? Math.ceil(piece.length / 1.5) : Math.ceil(piece.length / 7);
    } else if (/[A-Z]/.test(piece)) {
      tokens += Math.ceil(piece.length / 2);
    } else if (piece === " ") {
      // A single space joins the word after it.
    } else if (piece.startsWith("\n")) {
      tokens += 0.7;
    } else if (/^\s+$/.test(piece)) {
      // Column padding in a table: long runs take more than one token.
      tokens += 1 + Math.floor(piece.length / 16);
    } else {
      tokens += piece.length * 0.55;
    }
  }
  return Math.ceil(tokens);
}

function countNewlines(text: string): number {
  let count = 0;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) count += 1;
  return count;
}

/** Lines in a text, where a final newline ends the last line rather than starting another. */
export function lineCount(text: string): number {
  if (!text) return 0;
  return countNewlines(text) + (text.endsWith("\n") ? 0 : 1);
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/** What to do to see the part that was left out, by tool. */
export function hintFor(tool: string): string {
  switch (tool) {
    case "read_file": return "Call read_file again with start_line and end_line to see those lines";
    case "run_command": return "Run a narrower command, or filter its output, to see that part";
    case "list_files": return "List one folder at a time to see inside it";
    case "search_files": return "Search with a more specific pattern or a smaller folder";
    case "fetch_url": return "Fetch a more specific page to see more";
    default: return "Ask for a narrower part if more is needed";
  }
}

/**
 * The text cut to `limit` characters, keeping its start and its end.
 *
 * Start and end, not just the start: the end of a log holds the error, the
 * end of a file the export or the server's listen call, and a reader shown
 * only the top cannot tell what kind of thing they are looking at. The note
 * in the middle says how much went, which lines when the text has lines, and
 * how to get it. `firstLine` is the line number the text starts at, so a part
 * of a file is described in the file's own line numbers.
 */
export function shorten(text: string, limit: number, hint: string, firstLine = 1): string {
  if (text.length <= limit) return text;

  const totalLines = lineCount(text);
  // Sized against a provisional note; the real one is never longer.
  const provisional = 160 + hint.length;
  const room = Math.max(0, limit - provisional);
  let head = text.slice(0, Math.ceil(room * 0.6));
  let tail = text.slice(text.length - Math.floor(room * 0.4));
  // On line boundaries, so no line is shown half-cut - unless the lines are
  // so long that a boundary would throw away most of the room.
  const headBreak = head.lastIndexOf("\n");
  if (headBreak > head.length * 0.5) head = head.slice(0, headBreak + 1);
  const tailBreak = tail.indexOf("\n");
  if (tailBreak !== -1 && tailBreak < tail.length * 0.5) tail = tail.slice(tailBreak + 1);

  const omitted = text.length - head.length - tail.length;
  // The first line the head does not finish, and the last one the tail does
  // not start at its beginning: the lines a reader has not fully seen.
  const firstOmitted = countNewlines(head) + 1;
  const tailStartsALine = tail.length === 0 || text[text.length - tail.length - 1] === "\n";
  const lastOmitted = totalLines - lineCount(tail) + (tailStartsALine ? 0 : 1);
  const offset = firstLine - 1;
  const where = totalLines > 1 && lastOmitted >= firstOmitted
    ? lastOmitted === firstOmitted
      ? ` (line ${formatCount(firstOmitted + offset)})`
      : ` (lines ${formatCount(firstOmitted + offset)}-${formatCount(lastOmitted + offset)} of ${formatCount(totalLines + offset)})`
    : "";
  const note = `\n[... ${formatCount(omitted)} characters${where} ${noteMarker}. ${hint}. ...]\n`;
  return `${head}${head.endsWith("\n") ? note.slice(1) : note}${tail}`;
}

/**
 * The text shortened, the same way, to about `maxTokens` estimated tokens.
 *
 * Sized by the text's own density, so a table of digits keeps fewer
 * characters than the same number of tokens of prose would. The two ends can
 * be denser than the whole, so the size is checked and taken down again
 * until it fits.
 */
export function shortenToTokens(text: string, maxTokens: number, hint: string, firstLine = 1): string {
  const tokens = estimateTokens(text);
  if (tokens <= maxTokens) return text;
  let limit = Math.max(minShortenedChars, Math.floor((text.length * maxTokens) / tokens));
  let shortened = shorten(text, limit, hint, firstLine);
  for (let attempt = 0; attempt < 4 && limit > minShortenedChars; attempt += 1) {
    const now = estimateTokens(shortened);
    if (now <= maxTokens) break;
    limit = Math.max(minShortenedChars, Math.floor((limit * maxTokens * 0.95) / now));
    shortened = shorten(text, limit, hint, firstLine);
  }
  return shortened;
}

/** A tool result, no larger than any one result may be. */
export function fitToolResult(tool: string, content: string): string {
  return shortenToTokens(content, maxToolResultTokens, hintFor(tool));
}

export type LineRange = { start?: number; end?: number };

/**
 * What read_file shows of a file's text.
 *
 * All of it when it fits, unchanged. A longer file: its start and its end,
 * with a note naming the lines in between. A range: those lines, under a
 * heading saying which they are - shortened the same way if even they do not
 * fit. `openedAll` is false when the file is bigger than was opened, so the
 * reader is not told it has seen the end of something it has not.
 */
export function fileView(text: string, range: LineRange, openedAll: boolean): { ok: boolean; content: string } {
  const totalLines = lineCount(text);
  const hint = hintFor("read_file");
  const beyond = openedAll
    ? ""
    : `\n[Only the start of this file was opened - it goes on past line ${formatCount(totalLines)}, which cannot be read this way.]`;

  if (range.start === undefined && range.end === undefined) {
    if (openedAll && estimateTokens(text) <= maxToolResultTokens) return { ok: true, content: text };
    return { ok: true, content: shortenToTokens(text, maxToolResultTokens - estimateTokens(beyond), hint) + beyond };
  }

  if (totalLines === 0) return { ok: false, content: "That file is empty." };
  const start = Math.max(1, Math.floor(range.start ?? 1));
  if (start > totalLines) {
    return {
      ok: false,
      content: `That file has ${formatCount(totalLines)} line${totalLines === 1 ? "" : "s"}, so there is no line ${formatCount(start)}.`
    };
  }
  const end = Math.min(totalLines, Math.max(start, Math.floor(range.end ?? totalLines)));
  const lines = text.split("\n").slice(start - 1, end).join("\n");
  const heading = `[Lines ${formatCount(start)}-${formatCount(end)} of ${formatCount(totalLines)}]\n`;
  const after = end === totalLines ? beyond : "";
  const body = shortenToTokens(lines, maxToolResultTokens - estimateTokens(heading + after), hint, start);
  return { ok: true, content: `${heading}${body}${after}` };
}

/** Whether read_file would show this text whole, with nothing left out. */
export function fitsOneRead(text: string): boolean {
  return estimateTokens(text) <= maxToolResultTokens;
}

/**
 * The note a shortened view carries, when `content` has one in it, or null.
 *
 * A view is for reading. Written back to a file, the note replaces the lines
 * it stands for: asked to fix one line of a long file, a model that writes
 * back what it was shown writes back the start, a sentence about the middle,
 * and the end.
 */
export function elisionIn(content: string): string | null {
  if (content.includes(noteMarker)) return "a note saying part of the file was left out of what was shown";
  if (/^\[Lines [\d,]+-[\d,]+ of [\d,]+\]$/m.test(content)) return "the heading of a partial read";
  if (content.includes("[truncated - this file is longer than shown]")) return "a note saying the file was cut short";
  return null;
}

/** One message's share of the window, the way it is sent. */
function messageTokens(message: Message): number {
  // An assistant turn carries its calls with all their arguments - a
  // write_file call carries the whole file it wrote.
  return estimateTokens(message.content) + messageOverheadTokens
    + (message.tool_calls ? estimateTokens(JSON.stringify(message.tool_calls)) : 0);
}

/** The size of a request in estimated tokens: its messages and its tool schemas. */
export function requestTokens(messages: Message[], toolsTokens: number): number {
  return toolsTokens + messages.reduce((sum, message) => sum + messageTokens(message), 0);
}

/**
 * Shorten what has to give until the request fits `budgetTokens`.
 *
 * Tool results go first, largest first, then the earlier conversation turns,
 * then the long arguments of earlier calls. Never the messages in `keep` - the
 * system prompt and the question, the rules and what was asked, which are the
 * two things the window's own cut took first. Mutates the messages in place,
 * so later rounds of the same turn send the shortened version too. Returns how
 * many tokens were taken out.
 */
export function fitPromptToWindow(
  messages: Message[],
  toolsTokens: number,
  budgetTokens: number,
  keep: readonly number[] = [0]
): number {
  const sizes = messages.map(messageTokens);
  let total = toolsTokens + sizes.reduce((sum, size) => sum + size, 0);
  if (total <= budgetTokens) return 0;
  const before = total;
  const kept = new Set(keep);
  const earlierHint = "An earlier result, shortened to make room - ask again for the part you need";

  // Messages that have given all they can; the next largest is tried instead.
  const spent = new Set<number>();
  for (const pick of [
    (message: Message) => message.role === "tool",
    (message: Message) => message.role === "assistant" || message.role === "user"
  ]) {
    while (total > budgetTokens) {
      let largest = -1;
      for (const [index, message] of messages.entries()) {
        if (kept.has(index) || spent.has(index) || !pick(message) || message.content.length <= minShortenedChars) continue;
        if (largest === -1 || sizes[index] > sizes[largest]) largest = index;
      }
      if (largest === -1) break;
      const message = messages[largest];
      const contentTokens = sizes[largest] - (messageTokens({ ...message, content: "" }));
      const target = Math.max(1, contentTokens - (total - budgetTokens) - 20);
      const shortened = shortenToTokens(message.content, target, earlierHint);
      if (shortened.length >= message.content.length) {
        spent.add(largest);
        continue;
      }
      message.content = shortened;
      const size = messageTokens(message);
      total -= sizes[largest] - size;
      sizes[largest] = size;
      if (shortened.length <= minShortenedChars + 400) spent.add(largest);
    }
  }

  // Last, what earlier calls carried: a file written two rounds ago does not
  // need to be repeated in full for the model to know it wrote it.
  const spentArguments = new Set<string>();
  while (total > budgetTokens) {
    let largest: { index: number; call: ToolCallShape; key: string; value: string; id: string } | null = null;
    for (const [index, message] of messages.entries()) {
      if (kept.has(index) || message.role !== "assistant") continue;
      for (const [callIndex, call] of (message.tool_calls ?? []).entries()) {
        for (const [key, value] of Object.entries(call.function.arguments ?? {})) {
          const id = `${index}:${callIndex}:${key}`;
          if (typeof value !== "string" || value.length <= minShortenedChars || spentArguments.has(id)) continue;
          if (!largest || value.length > largest.value.length) largest = { index, call, key, value, id };
        }
      }
    }
    if (!largest) break;
    const { index, call, key, value, id } = largest;
    const target = Math.max(1, estimateTokens(value) - (total - budgetTokens) - 20);
    const shortened = shortenToTokens(value, target, "Shortened here to make room; the call itself went through in full");
    if (shortened.length >= value.length || shortened.length <= minShortenedChars + 400) spentArguments.add(id);
    if (shortened.length >= value.length) continue;
    // A new object rather than an edit of the old one: the arguments are the
    // same object the call ran with, and a call held for confirmation runs
    // from them again when the user says yes.
    call.function.arguments = { ...call.function.arguments, [key]: shortened };
    const size = messageTokens(messages[index]);
    total -= sizes[index] - size;
    sizes[index] = size;
  }

  return before - total;
}
