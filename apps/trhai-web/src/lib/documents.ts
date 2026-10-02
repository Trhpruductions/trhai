// Documents in the knowledge base, as the Memory view shows them. A file is
// sent as itself to /v1/knowledge/import, read on this machine (PDF, Word,
// PowerPoint, plain text), and kept as text the assistant can search and quote.

export type StoredDocument = { id: string; title: string; body: string; createdAt: string };

export type ImportResult = {
  document: { id: string; title: string; createdAt: string; characters: number };
  kind: "pdf" | "docx" | "pptx" | "text";
  pages?: number;
  truncated: boolean;
};

/** What the file picker offers: the kinds the API can read. */
export const acceptedDocumentTypes = ".pdf,.docx,.pptx,.txt,.md,.markdown,.csv,.tsv,.json,.html,.htm,.log,.xml,.yml,.yaml";

/** The largest file worth sending; the API refuses anything bigger. */
export const maxImportBytes = 40 * 1024 * 1024;

/** A size a person reads: about how many words, which is what a document's length means to them. */
export function describeLength(characters: number): string {
  const words = Math.max(1, Math.round(characters / 6));
  if (words < 1000) return `about ${words} words`;
  return `about ${(words / 1000).toFixed(words < 10_000 ? 1 : 0).replace(/\.0$/, "")}k words`;
}

/** The line shown once a file has been added. */
export function describeImport(result: ImportResult): string {
  const kind = { pdf: "PDF", docx: "Word document", pptx: "presentation", text: "text file" }[result.kind];
  const pages = result.pages ? `, ${result.pages} ${result.kind === "pptx" ? "slide" : "page"}${result.pages === 1 ? "" : "s"}` : "";
  const cut = result.truncated ? " It was long, so only the first part was kept." : "";
  return `Added "${result.document.title}" (${kind}${pages}, ${describeLength(result.document.characters)}).${cut}`;
}

/** Why a file is not sent at all, before it leaves the browser, or null when it can be. */
export function refuseBeforeSending(file: { name: string; size: number }): string | null {
  if (file.size === 0) return `"${file.name}" is empty.`;
  if (file.size > maxImportBytes) {
    return `"${file.name}" is ${Math.round(file.size / 1024 / 1024)} MB; documents up to ${maxImportBytes / 1024 / 1024} MB can be added.`;
  }
  const extension = /\.[^.]+$/.exec(file.name.toLowerCase())?.[0] ?? "";
  if (!acceptedDocumentTypes.split(",").includes(extension)) {
    return `"${file.name}" is not a kind of document TRH AI can read. It reads PDF, Word (.docx), PowerPoint (.pptx) and plain-text files.`;
  }
  return null;
}
