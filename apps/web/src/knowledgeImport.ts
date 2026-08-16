// Importing files into the knowledge base.
//
// Pasting a runbook by hand is enough friction that the knowledge base would
// mostly sit empty. Import uses the browser's own file picker and FileReader,
// so it works in the browser exactly as it does in the desktop shell — no
// bridge, no permissions, no credentials.
//
// The rules here exist because the store keeps whatever it is given: a PDF read
// as text becomes a page of mojibake that pollutes every future search, and a
// silently truncated file is worse than a refused one.

/** Text formats worth indexing. Anything else is refused by name. */
const textExtensions = new Set([
  "txt", "md", "markdown", "rst", "org",
  "json", "yaml", "yml", "toml", "ini", "env",
  "csv", "tsv", "log",
  "html", "htm", "xml",
  "js", "jsx", "ts", "tsx", "py", "rb", "go", "rs", "java", "kt", "swift",
  "c", "h", "cpp", "hpp", "cs", "php", "sh", "bash", "sql", "css", "scss"
]);

/** Matches the server's per-document cap, so truncation is predictable. */
export const maxImportChars = 20000;
/** Refused outright well before the cap, so a huge file cannot lock the tab. */
export const maxImportBytes = 2 * 1024 * 1024;

export function extensionOf(fileName: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(fileName.trim());
  return match ? match[1].toLowerCase() : "";
}

export function isTextFileName(fileName: string): boolean {
  return textExtensions.has(extensionOf(fileName));
}

/**
 * Binary content that slipped past the extension check.
 *
 * A NUL byte does not occur in real text but is everywhere in compiled and
 * compressed formats, so it is the cheapest reliable signal. The replacement
 * character catches a file that was decoded with the wrong encoding.
 */
export function looksBinary(sample: string): boolean {
  let replacements = 0;

  for (let index = 0; index < sample.length; index += 1) {
    const code = sample.charCodeAt(index);
    // NUL, or a C0 control that is not tab / newline / carriage return.
    if (code === 0) return true;
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) return true;
    // U+FFFD, the replacement character: decoded with the wrong encoding.
    if (code === 0xfffd) replacements += 1;
  }

  return replacements > Math.max(4, sample.length * 0.01);
}

/**
 * A readable title from a file name: "ops-runbook_v2.md" -> "Ops Runbook v2".
 * The file name is the only title information an import has, so it is worth
 * making presentable rather than storing "ops-runbook_v2.md".
 */
export function titleFromFileName(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, "").replace(/\.[a-z0-9]+$/i, "");
  const words = base
    .replace(/[_-]+/g, " ")
    // "opsRunbook" -> "ops Runbook"
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0) return fileName.trim() || "Untitled";

  return words
    .map((word) => (/^[A-Z0-9]+$/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
}

export type ImportRejection = { ok: false; reason: string };
export type ImportAccepted = {
  ok: true;
  title: string;
  body: string;
  /** True when the file was longer than the store accepts. */
  truncated: boolean;
};
export type ImportResult = ImportAccepted | ImportRejection;

/**
 * Decide what to do with one file's contents. Pure, so the rules are testable
 * without a DOM: the caller does the reading, this does the judging.
 */
export function prepareImport(fileName: string, contents: string, byteSize: number): ImportResult {
  if (byteSize > maxImportBytes) {
    return { ok: false, reason: `${fileName} is too large to import (limit 2 MB).` };
  }

  if (!isTextFileName(fileName)) {
    const extension = extensionOf(fileName);
    return {
      ok: false,
      reason: extension
        ? `${fileName} is a .${extension} file, which cannot be read as text.`
        : `${fileName} has no file extension, so it cannot be read as text.`
    };
  }

  if (looksBinary(contents.slice(0, 4000))) {
    return { ok: false, reason: `${fileName} does not appear to be text.` };
  }

  const body = contents.trim();
  if (!body) {
    return { ok: false, reason: `${fileName} is empty.` };
  }

  return {
    ok: true,
    title: titleFromFileName(fileName),
    body: body.slice(0, maxImportChars),
    truncated: body.length > maxImportChars
  };
}

/** One line summarising a batch, so a partial import is never reported as clean. */
export function summarizeImport(results: ImportResult[]): string {
  const added = results.filter((entry): entry is ImportAccepted => entry.ok);
  const rejected = results.filter((entry): entry is ImportRejection => !entry.ok);
  const truncated = added.filter((entry) => entry.truncated).length;

  if (added.length === 0) {
    return rejected[0]?.reason ?? "Nothing to import.";
  }

  const parts = [`Imported ${added.length} file${added.length === 1 ? "" : "s"}`];
  if (truncated > 0) parts.push(`${truncated} trimmed to fit`);
  if (rejected.length > 0) parts.push(`${rejected.length} skipped`);

  return parts.join(" · ");
}
