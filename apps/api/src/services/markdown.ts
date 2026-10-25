// A small Markdown reader: the kind of Markdown a language model writes when it
// is asked for a document - headings, paragraphs, bold and italic, lists (nested
// ones too), tables, code, quotes, rules, links. It turns the text into blocks
// that documentHtml.ts and docxWriter.ts each draw their own way, so that a
// Word file, a PDF and a web page made from one text agree.
//
// Two choices that differ from strict Markdown, on purpose: a single newline
// inside a paragraph is a line break, not a space, because a letter or an
// address written one line to a line is meant that way; and nothing is passed
// through as raw HTML - what looks like a tag is shown as the text it is.

export type Inline =
  | { kind: "text"; text: string; bold?: boolean; italic?: boolean; strike?: boolean; code?: boolean; href?: string }
  | { kind: "break" };

export type Align = "left" | "center" | "right" | null;

export type ListItem = { inlines: Inline[]; children: Block[] };

export type Block =
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; inlines: Inline[] }
  | { kind: "paragraph"; inlines: Inline[] }
  | { kind: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { kind: "code"; language: string; text: string }
  | { kind: "table"; align: Align[]; header: Inline[][]; rows: Inline[][][] }
  | { kind: "quote"; blocks: Block[] }
  | { kind: "rule" }
  | { kind: "pagebreak" };

// ---------------------------------------------------------------- inline

type Style = { bold?: boolean; italic?: boolean; strike?: boolean; code?: boolean; href?: string };

const punctuation = /[!-/:-@[-`{-~]/;

const isWord = (character: string | undefined) => character !== undefined && /[\p{L}\p{N}]/u.test(character);

/** Marks that stand inside a word - a single star or an underscore - are not emphasis: snake_case_names and 2*3*4 stay as written. */
const insideWordsAreLiteral = (char: string, length: number) => char === "_" || (char === "*" && length === 1);

/** Whether the run of `length` marks at `at` can open emphasis: something that is not a space follows it. */
function canOpen(text: string, at: number, length: number, char: string): boolean {
  const next = text[at + length];
  if (next === undefined || /\s/.test(next)) return false;
  return !(insideWordsAreLiteral(char, length) && isWord(text[at - 1]));
}

function canClose(text: string, at: number, length: number, char: string): boolean {
  const before = text[at - 1];
  if (before === undefined || /\s/.test(before)) return false;
  return !(insideWordsAreLiteral(char, length) && isWord(text[at + length]));
}

function runLength(text: string, at: number, char: string): number {
  let length = 1;
  while (text[at + length] === char) length += 1;
  return length;
}

/** How far on to look for the end of emphasis: a span longer than this is not one. Keeps a page of stray stars from being slow. */
const spanLimit = 2000;

/**
 * Where the run of marks that closes the emphasis opened by `wanted` marks begins,
 * looking from `from`, or -1. Emphasis that opens and closes inside is stepped over,
 * so the star that ends "**bold**" in "*italic **bold** more*" does not end the italic.
 */
function findCloser(text: string, from: number, char: string, wanted: number): number {
  for (let scan = from; scan < Math.min(text.length, from + spanLimit); scan += 1) {
    if (text[scan] === "\\") { scan += 1; continue; }
    if (text[scan] === "`") { const end = text.indexOf("`", scan + 1); if (end > 0) { scan = end; continue; } }
    if (text[scan] !== char) continue;
    const length = runLength(text, scan, char);
    if (length >= wanted && canClose(text, scan, length, char)) return scan;
    if (canOpen(text, scan, length, char)) {
      const inner = findCloser(text, scan + length, char, char === "~" ? 2 : Math.min(length, 3));
      if (inner > 0) { scan = inner + runLength(text, inner, char) - 1; continue; }
    }
    scan += length - 1;
  }
  return -1;
}

function push(out: Inline[], text: string, style: Style): void {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.kind === "text" && !last.code === !style.code && !last.bold === !style.bold && !last.italic === !style.italic
    && !last.strike === !style.strike && last.href === style.href) {
    last.text += text;
    return;
  }
  out.push({ kind: "text", text, ...(style.bold ? { bold: true } : {}), ...(style.italic ? { italic: true } : {}), ...(style.strike ? { strike: true } : {}), ...(style.code ? { code: true } : {}), ...(style.href ? { href: style.href } : {}) });
}

/** The text of a paragraph, line or table cell as runs of text with their styles. */
export function parseInlines(text: string, inherited: Style = {}): Inline[] {
  const out: Inline[] = [];
  let buffer = "";
  const flush = () => { push(out, buffer, inherited); buffer = ""; };

  for (let at = 0; at < text.length;) {
    const char = text[at];

    if (char === "\\" && at + 1 < text.length) {
      if (text[at + 1] === "\n") { flush(); out.push({ kind: "break" }); at += 2; continue; }
      if (punctuation.test(text[at + 1])) { buffer += text[at + 1]; at += 2; continue; }
    }

    if (char === "\n") {
      flush();
      out.push({ kind: "break" });
      at += 1;
      continue;
    }

    // Two spaces at the end of a line are a line break too: the spaces go.
    if (char === " " && text[at + 1] === " ") {
      let end = at;
      while (text[end] === " ") end += 1;
      if (text[end] === "\n" || end === text.length) { at = end; continue; }
    }

    if (char === "`") {
      let run = 1;
      while (text[at + run] === "`") run += 1;
      const marker = "`".repeat(run);
      const close = text.indexOf(marker, at + run);
      if (close > at + run) {
        flush();
        const raw = text.slice(at + run, close).replace(/\n/g, " ");
        push(out, raw.length > 2 && raw.startsWith(" ") && raw.endsWith(" ") ? raw.slice(1, -1) : raw, { ...inherited, code: true });
        at = close + run;
        continue;
      }
      buffer += marker;
      at += run;
      continue;
    }

    if (char === "[") {
      // The address may have one level of brackets in it (a Wikipedia page, javascript:alert(1)), so the ")" that ends the link is the unmatched one.
      const link = /^\[((?:[^\[\]\\]|\\.)*)\]\(\s*<?((?:[^\s()<>]|\([^\s()<>]*\))+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/.exec(text.slice(at));
      if (link) {
        flush();
        out.push(...parseInlines(link[1], { ...inherited, href: link[2] }));
        at += link[0].length;
        continue;
      }
    }

    if (char === "<") {
      // A model writing a table cell with two lines in it says <br>.
      const lineBreak = /^<br\s*\/?>/i.exec(text.slice(at, at + 10));
      if (lineBreak) { flush(); out.push({ kind: "break" }); at += lineBreak[0].length; continue; }
      const auto = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(text.slice(at));
      if (auto) {
        flush();
        push(out, auto[1].replace(/^mailto:/i, ""), { ...inherited, href: auto[1] });
        at += auto[0].length;
        continue;
      }
    }

    if (char === "*" || char === "_" || char === "~") {
      let run = 1;
      while (text[at + run] === char) run += 1;
      const wanted = char === "~" ? (run >= 2 ? 2 : 0) : Math.min(run, 3);
      if (wanted > 0 && canOpen(text, at, run, char)) {
        const found = findCloser(text, at + run, char, wanted);
        if (found > 0) {
          const closeRun = runLength(text, found, char);
          const used = Math.min(wanted, closeRun);
          const inner = text.slice(at + used, found + closeRun - used);
          flush();
          const style: Style = { ...inherited };
          if (char === "~") style.strike = true;
          else if (used === 3) { style.bold = true; style.italic = true; }
          else if (used === 2) style.bold = true;
          else style.italic = true;
          out.push(...parseInlines(inner, style));
          at = found + closeRun;
          continue;
        }
      }
      buffer += char.repeat(run);
      at += run;
      continue;
    }

    buffer += char;
    at += 1;
  }
  flush();
  // No break at the very start or end of a block.
  while (out.length && out[0].kind === "break") out.shift();
  while (out.length && out[out.length - 1].kind === "break") out.pop();
  return out;
}

/** The plain text of some runs, with breaks as spaces: for an outline, a title, a file name. */
export function plainText(inlines: Inline[]): string {
  return inlines.map((run) => (run.kind === "break" ? " " : run.text)).join("").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------- blocks

const fence = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)[^`]*$/;
const heading = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const rule = /^\s{0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;
const quote = /^\s{0,3}>\s?(.*)$/;
const item = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const pageBreak = /^\s*(?:\\(?:newpage|pagebreak|page)|<!--\s*page\s*-?\s*break\s*-->|-{2,}\s*page\s*break\s*-{2,}|\[(?:page\s*break|new\s*page)\])\s*$/i;
const tableSeparator = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  for (let at = 0; at < text.length; at += 1) {
    if (text[at] === "\\" && text[at + 1] === "|") { cell += "|"; at += 1; continue; }
    if (text[at] === "`") { // a pipe inside code is not a column
      const end = text.indexOf("`", at + 1);
      if (end > 0) { cell += text.slice(at, end + 1); at = end; continue; }
    }
    if (text[at] === "|") { cells.push(cell.trim()); cell = ""; continue; }
    cell += text[at];
  }
  cells.push(cell.trim());
  return cells;
}

const startsBlock = (line: string, next: string | undefined): boolean =>
  fence.test(line) || heading.test(line) || rule.test(line) || quote.test(line) || item.test(line) || pageBreak.test(line)
  || (line.includes("|") && next !== undefined && line.trim() !== "" && tableSeparator.test(next) && next.includes("-") && next.includes("|"));

const indentOf = (line: string) => line.length - line.trimStart().length;

function parseList(lines: string[], from: number): { block: Block; next: number } {
  const first = item.exec(lines[from])!;
  const baseIndent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const start = ordered ? Number.parseInt(first[2], 10) : 1;
  const items: ListItem[] = [];
  let i = from;

  while (i < lines.length) {
    const match = item.exec(lines[i]);
    if (!match || match[1].length > baseIndent + 1 || match[1].length < baseIndent - 1 || /\d/.test(match[2]) !== ordered) break;
    const text: string[] = [match[3]];
    const child: string[] = [];
    i += 1;
    // What belongs to this item: lines indented under it. Those that carry on its sentence join its text; a nested list, a code
    // block or a paragraph after a blank line are items of its own. A line that is not indented ends the item - and the list.
    let carrying = true;
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === "") {
        let ahead = i + 1;
        while (ahead < lines.length && lines[ahead].trim() === "") ahead += 1;
        if (ahead < lines.length && indentOf(lines[ahead]) > baseIndent + 1) { child.push(""); carrying = false; i += 1; continue; }
        break;
      }
      const indent = indentOf(line);
      if (item.test(line) && indent <= baseIndent + 1) break;
      if (indent <= baseIndent) break;
      if (carrying && !startsBlock(line.trim(), lines[i + 1])) { text.push(line.trim()); i += 1; continue; }
      carrying = false;
      child.push(line);
      i += 1;
    }
    const strip = child.reduce((least, line) => (line.trim() === "" ? least : Math.min(least, indentOf(line))), Number.POSITIVE_INFINITY);
    const inner = child.map((line) => (line.trim() === "" ? "" : line.slice(Number.isFinite(strip) ? strip : 0)));
    // A checklist item - "[ ] pack the charger", "[x] book the flights" - shows its box.
    text[0] = text[0].replace(/^\[([ xX])\]\s+/, (_, mark: string) => (mark === " " ? "☐ " : "☑ "));
    items.push({ inlines: parseInlines(text.join("\n")), children: inner.some((line) => line.trim() !== "") ? parseBlocks(inner) : [] });
    // Blank lines between items do not end the list.
    let ahead = i;
    while (ahead < lines.length && lines[ahead].trim() === "") ahead += 1;
    if (ahead > i && ahead < lines.length) {
      const following = item.exec(lines[ahead]);
      if (following && following[1].length <= baseIndent + 1 && following[1].length >= baseIndent - 1 && /\d/.test(following[2]) === ordered) i = ahead;
    }
  }
  return { block: { kind: "list", ordered, start, items }, next: i };
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") { i += 1; continue; }

    const fenced = fence.exec(line);
    if (fenced) {
      const marker = fenced[1];
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i].trim().startsWith(marker[0].repeat(marker.length)) && /^\s*[`~]+\s*$/.test(lines[i]))) { body.push(lines[i]); i += 1; }
      i += 1; // the closing fence, or the end
      blocks.push({ kind: "code", language: fenced[2] ?? "", text: body.join("\n") });
      continue;
    }

    if (pageBreak.test(line)) { blocks.push({ kind: "pagebreak" }); i += 1; continue; }

    const atx = heading.exec(line);
    if (atx) { blocks.push({ kind: "heading", level: atx[1].length as 1 | 2 | 3 | 4 | 5 | 6, inlines: parseInlines(atx[2]) }); i += 1; continue; }

    if (rule.test(line)) { blocks.push({ kind: "rule" }); i += 1; continue; }

    if (quote.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && quote.test(lines[i])) { inner.push(quote.exec(lines[i])![1]); i += 1; }
      blocks.push({ kind: "quote", blocks: parseBlocks(inner) });
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && tableSeparator.test(lines[i + 1]) && lines[i + 1].includes("-") && lines[i + 1].includes("|")) {
      const header = splitRow(line);
      const align = splitRow(lines[i + 1]).map((cell): Align => {
        const left = cell.startsWith(":");
        const right = cell.endsWith(":");
        return left && right ? "center" : right ? "right" : left ? "left" : null;
      });
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i].trim() !== "" && lines[i].includes("|")) {
        const cells = splitRow(lines[i]);
        // A row has as many cells as the header: short rows are filled, long ones cut.
        rows.push(Array.from({ length: header.length }, (_, column) => parseInlines(cells[column] ?? "")));
        i += 1;
      }
      blocks.push({ kind: "table", align: header.map((_, column) => align[column] ?? null), header: header.map((cell) => parseInlines(cell)), rows });
      continue;
    }

    if (item.test(line)) {
      const list = parseList(lines, i);
      blocks.push(list.block);
      i = list.next;
      continue;
    }

    // A paragraph: lines up to a blank line or the start of another kind of block.
    const text: string[] = [line.trim()];
    i += 1;
    while (i < lines.length && lines[i].trim() !== "" && !startsBlock(lines[i], lines[i + 1])) { text.push(lines[i].trim()); i += 1; }
    blocks.push({ kind: "paragraph", inlines: parseInlines(text.join("\n")) });
  }
  return blocks;
}

/** A Markdown text as blocks. Never throws: whatever is not Markdown is a paragraph. */
export function parseMarkdown(source: string): Block[] {
  const withoutMark = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const lines = withoutMark.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
  return parseBlocks(lines);
}

/** The text of a title, for a file name and a heading: the first heading, else the first line. */
export function firstHeading(blocks: Block[]): string | null {
  for (const block of blocks) {
    if (block.kind === "heading") return plainText(block.inlines) || null;
  }
  return null;
}
