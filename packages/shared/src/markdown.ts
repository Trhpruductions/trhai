// A small Markdown reader for assistant replies.
//
// This parses to a structure. It never produces HTML, and there is no
// dangerouslySetInnerHTML anywhere downstream — the renderer walks these
// nodes and builds elements. That is the whole reason for the shape: a model
// writes this text, a model can be talked into writing anything, and the
// difference between "renders a link" and "runs a script" should not depend
// on my escaping being airtight. There is nothing to escape if no string is
// ever interpreted as markup.
//
// It is deliberately not a full CommonMark implementation. It covers what a
// local model actually emits when answering a question — fenced code, inline
// code, headings, lists, quotes, emphasis and links — and anything it does
// not recognise falls through as literal text rather than being dropped.
// Silently swallowing input would be worse than rendering it plainly.

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "bold"; children: Inline[] }
  | { kind: "italic"; children: Inline[] }
  | { kind: "link"; href: string; children: Inline[] };

export type Block =
  | { kind: "paragraph"; children: Inline[] }
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: Inline[] }
  | { kind: "code"; language: string | null; text: string }
  | { kind: "list"; ordered: boolean; items: Inline[][] }
  | { kind: "quote"; children: Inline[] }
  | { kind: "rule" };

/**
 * Schemes a link may use.
 *
 * An allowlist rather than a blocklist of "javascript:" and friends: the set
 * of dangerous schemes is open-ended (data:, vbscript:, and whatever a
 * browser adds next), while the set of ones worth supporting here is three
 * long. A link with any other scheme keeps its text and loses its href, so
 * the reply still reads correctly and nothing becomes clickable that should
 * not be.
 */
const safeSchemes = ["http://", "https://", "mailto:"];

export function isSafeHref(href: string): boolean {
  const trimmed = href.trim().toLowerCase();
  // A relative link cannot carry a scheme, so it is safe by construction —
  // but "//evil.com" is protocol-relative and is not relative at all.
  if (trimmed.startsWith("//")) return false;
  if (trimmed.startsWith("/") || trimmed.startsWith("#")) return true;
  return safeSchemes.some((scheme) => trimmed.startsWith(scheme));
}

/** Finds the matching closing run of `marker`, or -1. */
function findClosing(text: string, marker: string, from: number): number {
  let index = from;
  for (;;) {
    const found = text.indexOf(marker, index);
    if (found === -1) return -1;
    // An empty span ("**" immediately followed by "**") is not emphasis; it
    // is four literal asterisks, and treating it as emphasis would delete
    // them from the output.
    if (found > from) return found;
    index = found + marker.length;
  }
}

/**
 * Parse the inline span markers inside one line of text.
 *
 * Code is handled before emphasis, deliberately: `**` inside a backtick span
 * is two literal asterisks, and a parser that ran emphasis first would eat
 * them out of the middle of someone's code.
 */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let buffer = "";

  const flush = () => {
    if (buffer) {
      out.push({ kind: "text", text: buffer });
      buffer = "";
    }
  };

  let index = 0;
  while (index < text.length) {
    const rest = text.slice(index);

    // Inline code first — its contents are literal.
    if (rest.startsWith("`")) {
      const close = findClosing(text, "`", index + 1);
      if (close !== -1) {
        flush();
        out.push({ kind: "code", text: text.slice(index + 1, close) });
        index = close + 1;
        continue;
      }
    }

    // A link: [label](href). The href is checked before it is kept.
    if (rest.startsWith("[")) {
      const closeLabel = text.indexOf("]", index + 1);
      if (closeLabel !== -1 && text[closeLabel + 1] === "(") {
        const closeHref = text.indexOf(")", closeLabel + 2);
        if (closeHref !== -1) {
          const label = text.slice(index + 1, closeLabel);
          const href = text.slice(closeLabel + 2, closeHref);
          flush();
          if (isSafeHref(href)) {
            out.push({ kind: "link", href: href.trim(), children: parseInline(label) });
          } else {
            // The text survives; only the link does. A reply that mentions a
            // javascript: URL should still be readable.
            out.push(...parseInline(label));
          }
          index = closeHref + 1;
          continue;
        }
      }
    }

    for (const [marker, kind] of [["**", "bold"], ["__", "bold"], ["*", "italic"], ["_", "italic"]] as const) {
      if (!rest.startsWith(marker)) continue;
      const close = findClosing(text, marker, index + marker.length);
      if (close === -1) continue;

      flush();
      out.push({ kind, children: parseInline(text.slice(index + marker.length, close)) });
      index = close + marker.length;
      break;
    }
    // The loop above may have advanced index; re-check before consuming a
    // character, or a matched marker would also be emitted as literal text.
    if (index < text.length && text.slice(index) === rest) {
      buffer += text[index];
      index += 1;
    }
  }

  flush();
  return out;
}

const orderedItem = /^(\d+)[.)]\s+(.*)$/;
const unorderedItem = /^[-*+]\s+(.*)$/;
const headingLine = /^(#{1,6})\s+(.*)$/;
const ruleLine = /^\s*([-*_])\s*(\1\s*){2,}$/;

/**
 * Parse a reply into blocks.
 *
 * Written as an explicit line walk rather than a set of regexes over the
 * whole string, because fenced code has to suspend every other rule: a "#"
 * inside a code block is a comment, not a heading, and a parser that finds
 * headings globally will corrupt exactly the content people paste most.
 */
export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];

  let paragraph: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: "paragraph", children: parseInline(paragraph.join(" ").trim()) });
    paragraph = [];
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      flushParagraph();
      const language = trimmed.slice(3).trim();
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        body.push(lines[index]);
        index += 1;
      }
      // An unclosed fence still produces a code block. A model that stops
      // mid-answer should not turn the rest of the reply into prose.
      index += 1;
      blocks.push({ kind: "code", language: language || null, text: body.join("\n") });
      continue;
    }

    if (trimmed === "") {
      flushParagraph();
      index += 1;
      continue;
    }

    if (ruleLine.test(line)) {
      flushParagraph();
      blocks.push({ kind: "rule" });
      index += 1;
      continue;
    }

    const heading = headingLine.exec(trimmed);
    if (heading) {
      flushParagraph();
      blocks.push({
        kind: "heading",
        level: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6,
        children: parseInline(heading[2])
      });
      index += 1;
      continue;
    }

    if (trimmed.startsWith("> ") || trimmed === ">") {
      flushParagraph();
      const quoted: string[] = [];
      while (index < lines.length) {
        const current = lines[index].trim();
        if (!current.startsWith(">")) break;
        quoted.push(current.replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push({ kind: "quote", children: parseInline(quoted.join(" ").trim()) });
      continue;
    }

    const ordered = orderedItem.exec(trimmed);
    const unordered = unorderedItem.exec(trimmed);
    if (ordered || unordered) {
      flushParagraph();
      const isOrdered = Boolean(ordered);
      const items: Inline[][] = [];

      while (index < lines.length) {
        const current = lines[index].trim();
        const nextOrdered = orderedItem.exec(current);
        const nextUnordered = unorderedItem.exec(current);
        // A list ends when the marker style changes, so "1. a" followed by
        // "- b" is two lists rather than one with a wrong number on it.
        if (isOrdered && nextOrdered) items.push(parseInline(nextOrdered[2]));
        else if (!isOrdered && nextUnordered) items.push(parseInline(nextUnordered[1]));
        else break;
        index += 1;
      }

      blocks.push({ kind: "list", ordered: isOrdered, items });
      continue;
    }

    paragraph.push(trimmed);
    index += 1;
  }

  flushParagraph();
  return blocks;
}

/** The plain text of a parsed reply, for speech and for search. */
export function inlineText(nodes: Inline[]): string {
  return nodes
    .map((node) => {
      if (node.kind === "text" || node.kind === "code") return node.text;
      return inlineText(node.children);
    })
    .join("");
}

/**
 * A reply as it should be read aloud.
 *
 * Without this the voice reads the markup: "asterisk asterisk all asterisk
 * asterisk". Once replies are rendered as formatted text, hearing the raw
 * characters is a plain mismatch between what is on screen and what is said.
 *
 * Code blocks are announced rather than recited. Reading thirty lines of
 * punctuation aloud is useless to a listener, but silently dropping them
 * would be worse — you would not know the answer contained code at all. The
 * line count is said instead, so the listener knows what is on screen.
 *
 * A link is read as its label, not its URL, for the same reason: nobody wants
 * "h t t p s colon slash slash" read out.
 */
export function speakableText(source: string): string {
  const spoken = parseMarkdown(source).map((block) => {
    if (block.kind === "code") {
      const lines = block.text.split("\n").filter((line) => line.trim().length > 0).length;
      const language = block.language ? `${block.language} ` : "";
      if (lines === 0) return "";
      return `(${lines} ${lines === 1 ? "line" : "lines"} of ${language}code)`;
    }
    if (block.kind === "rule") return "";
    if (block.kind === "list") {
      // Ends each item with a full stop so the voice pauses between them
      // rather than running the whole list into one sentence.
      return block.items
        .map((item) => {
          const text = inlineText(item).trim();
          return /[.!?]$/.test(text) ? text : `${text}.`;
        })
        .join(" ");
    }

    const text = inlineText(block.children).trim();
    // A heading is a sentence of its own; without a stop the voice runs it
    // straight into the paragraph beneath.
    if (block.kind === "heading" && text && !/[.!?:]$/.test(text)) return `${text}.`;
    return text;
  });

  return spoken.filter((part) => part.length > 0).join(" ").replace(/\s+/g, " ").trim();
}
