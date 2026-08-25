// Reading Ollama's streamed reply, safely.
//
// Ollama streams NDJSON: one JSON object per line, each carrying a fragment
// of message.content, until a final object with done: true. Turning that into
// tokens on a screen is easy. Turning it into tokens on a screen *without
// showing the user things they should never see* is the actual problem, and
// it is the reason this is a separate, tested unit rather than a few lines
// inside the agent loop.
//
// The hazard is that this model encodes some tool calls as text. agentLoop's
// parseTextToolCalls exists because a reply came back as "Sure, I'll write
// that:" followed by a JSON tool call followed by more prose — so a call can
// begin anywhere in a message, not just at the start. Streaming naively would
// print that JSON to the user a character at a time before anything had a
// chance to recognise it.
//
// So tokens are held back while a JSON object might be forming, and released
// once it is clear the text is prose. What is withheld is never lost: the
// caller always gets the complete accumulated text at the end, and the held
// buffer is flushed if the object turns out to be ordinary content.

export type StreamChunk = {
  message?: { content?: unknown; tool_calls?: unknown };
  done?: unknown;
  model?: unknown;
};

/**
 * Depth of unclosed `{` or `[` in `text`, ignoring braces inside strings.
 *
 * A quoted brace is not structure — a reply containing "use {} for an empty
 * object" would otherwise look like it had opened an object and never closed
 * it, and every token after that point would be held forever.
 */
export function openDepth(text: string): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (const character of text) {
    if (escaped) { escaped = false; continue; }
    if (character === "\\") { escaped = true; continue; }
    if (character === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (character === "{" || character === "[") depth += 1;
    if (character === "}" || character === "]") depth -= 1;
  }

  return Math.max(0, depth);
}

/**
 * How much of `accumulated` is safe to show now.
 *
 * Everything up to the first brace that is still open. Once that object
 * closes, the caller re-checks: if it parsed as a tool call the whole message
 * is suppressed, and if it did not, this releases it like any other text.
 *
 * Returns the whole string when nothing is open, which is the ordinary case —
 * prose streams with no delay at all.
 */
export function safePrefix(accumulated: string): string {
  if (openDepth(accumulated) === 0) return accumulated;

  // Hold from the first structural brace onward. Scanning from the start
  // rather than tracking incrementally keeps this a pure function of the
  // accumulated text, so it cannot drift out of step with what was emitted.
  let depth = 0;
  let inString = false;
  let escaped = false;
  let firstOpen = -1;

  for (let index = 0; index < accumulated.length; index += 1) {
    const character = accumulated[index];
    if (escaped) { escaped = false; continue; }
    if (character === "\\") { escaped = true; continue; }
    if (character === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (character === "{" || character === "[") {
      if (depth === 0) firstOpen = index;
      depth += 1;
    } else if (character === "}" || character === "]") {
      depth -= 1;
      if (depth <= 0) { depth = 0; firstOpen = -1; }
    }
  }

  return firstOpen === -1 ? accumulated : accumulated.slice(0, firstOpen);
}

export type StreamResult = {
  /** Everything the model produced, complete and unmodified. */
  content: string;
  /** Tool calls it asked for through the interface, if any. */
  toolCalls: unknown;
  model: string | null;
};

/**
 * Consume an NDJSON stream, emitting only text that is safe to show.
 *
 * `onToken` receives text in order, and never receives anything twice — it is
 * given the newly-safe slice, not the whole accumulated string. A caller can
 * therefore append blindly.
 *
 * It is called with prose only. If the reply turns out to be a text-encoded
 * tool call, the JSON is never emitted, and the caller decides what to do
 * with the complete content it gets back at the end.
 */
export async function readStream(
  lines: AsyncIterable<string>,
  onToken?: (text: string) => void,
  /** Whether the accumulated text is a tool call rather than an answer. */
  looksLikeToolCall: (text: string) => boolean = () => false
): Promise<StreamResult> {
  let content = "";
  let emitted = 0;
  let toolCalls: unknown = undefined;
  let model: string | null = null;

  for await (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let chunk: StreamChunk;
    try {
      chunk = JSON.parse(trimmed) as StreamChunk;
    } catch {
      // A partial or malformed line is skipped rather than throwing. The
      // stream is still running, and one unreadable frame is not a reason to
      // lose the reply that is still arriving.
      continue;
    }

    if (typeof chunk.model === "string") model = chunk.model;
    if (chunk.message?.tool_calls) toolCalls = chunk.message.tool_calls;

    const piece = chunk.message?.content;
    if (typeof piece === "string" && piece.length > 0) {
      content += piece;

      if (onToken) {
        // Nothing is emitted once the message is recognisable as a tool call:
        // the user asked a question, and watching the machinery of the answer
        // scroll past is not the answer.
        const safe = looksLikeToolCall(content) ? "" : safePrefix(content);
        if (safe.length > emitted) {
          onToken(safe.slice(emitted));
          emitted = safe.length;
        }
      }
    }
  }

  // Anything held back that turned out to be ordinary text is released now,
  // so a reply that legitimately ends mid-object is never silently truncated
  // on screen.
  if (onToken && !looksLikeToolCall(content) && content.length > emitted) {
    onToken(content.slice(emitted));
  }

  return { content, toolCalls, model };
}

/** Split a byte stream into lines, keeping any partial line for the next read. */
export async function* toLines(body: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const bytes of body) {
    // stream: true so a multi-byte character split across two chunks is
    // decoded correctly rather than becoming a replacement character.
    buffer += decoder.decode(bytes, { stream: true });
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) yield part;
  }

  buffer += decoder.decode();
  if (buffer.trim()) yield buffer;
}
