// How the Files and Code workspaces describe what is on disk: sizes in words,
// where a path sits, what kind of file a name is, and the order a folder is
// shown in. Pure, so it is testable without a screen.

export type FileEntry = { name: string; path: string; directory: boolean; bytes: number; modifiedAt: number; items?: number };
export type FileSort = "name" | "newest" | "size";
export type FileKind = "image" | "video" | "audio" | "markdown" | "code" | "text" | "document" | "other";

/** "512 B", "14.2 KB", "3.1 MB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** The folders above a workspace path, each one a place to go: "app2/src" -> app2, app2/src. */
export function crumbs(path: string): Array<{ name: string; path: string }> {
  const parts = path.split("/").filter((part) => part && part !== ".");
  return parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join("/") }));
}

/** The folder a path is in; "." at the top of the workspace. */
export function parentOf(path: string): string {
  const parts = path.split("/").filter((part) => part && part !== ".");
  return parts.length <= 1 ? "." : parts.slice(0, -1).join("/");
}

const kinds: Array<[FileKind, string[]]> = [
  // The same three lists the API serves previews for - see workspaceMedia.
  ["image", ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"]],
  ["video", ["mp4", "webm", "mov"]],
  ["audio", ["mp3", "wav", "ogg", "m4a"]],
  ["markdown", ["md", "markdown"]],
  // SVG is text: it can carry script, so it is never shown as a picture.
  ["code", ["js", "mjs", "cjs", "ts", "tsx", "jsx", "json", "html", "htm", "css", "scss", "py", "rb", "go", "rs", "java", "c", "cpp", "h", "cs", "php", "sh", "ps1", "bat", "yml", "yaml", "toml", "xml", "svg", "sql"]],
  ["text", ["txt", "log", "csv", "ini", "cfg", "conf", "env"]],
  ["document", ["pdf", "docx", "doc", "pptx", "ppt", "xlsx", "xls"]]
];

function extensionOf(name: string): string {
  const base = name.split("/").pop() ?? name;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** What kind of file a name is, for how to show it. A name with no extension (README, Dockerfile) is text. */
/**
 * Whether TRH AI can read this document (the API's documentText.ts reads PDF,
 * Word .docx and PowerPoint .pptx). Older Office files and spreadsheets are
 * documents to the file list, but there is nothing in them TRH AI can read.
 */
export function readableDocument(name: string): boolean {
  return ["pdf", "docx", "pptx"].includes(extensionOf(name));
}

/**
 * What the API opens with the program it belongs to (openableExtensions in the
 * API's openInSystem.ts): documents, pictures, sound and video, and nothing a
 * person could run. The API is the one that decides; this is so a button is
 * only offered where it can work.
 */
const openableInProgram = new Set([
  "docx", "pdf", "xlsx", "pptx", "csv", "txt", "md", "srt", "vtt",
  "png", "jpg", "jpeg", "gif", "webp", "bmp",
  "mp3", "wav", "m4a", "flac", "ogg", "mp4", "mkv", "mov", "webm"
]);

export function canOpenInProgram(name: string): boolean {
  return openableInProgram.has(extensionOf(name));
}

/**
 * The files a reply says it made, as the API sent them: paths in the
 * workspace, a few at most. Anything else in the field is ignored rather than
 * trusted - a button that opens whatever a reply names is only as good as
 * what the reply was allowed to name.
 */
export function madeFilesFrom(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0 && entry.length <= 1000
      && !entry.includes("\0") && !entry.startsWith("/") && !/^[A-Za-z]:/.test(entry) && !entry.split(/[\\/]/).includes(".."))
    .slice(0, 20);
}

/** A line of a reply as the assistant's file tools write it: "- documents/Report.docx (Word document)", "- documents/Report.pdf (PDF, 2 pages)". */
const madeFileLine = /^\s*[-*]\s+(\S.*?) \((?:Word document|PDF|web page|Markdown file|text file)(?:, \d+ pages?)?\)\s*$/;

/**
 * The files an earlier reply made, read from its text: a conversation opened
 * again has no list from the API, but the tools' own result lines are in the
 * reply word for word. Held to the same rules as any file a reply names.
 */
export function madeFilesInText(text: string): string[] {
  return madeFilesFrom(text.split(/\r?\n/).map((line) => madeFileLine.exec(line)?.[1] ?? ""));
}

export function fileKind(name: string): FileKind {
  const extension = extensionOf(name);
  if (!extension) return "text";
  return kinds.find(([, extensions]) => extensions.includes(extension))?.[0] ?? "other";
}

const languages: Record<string, string> = {
  js: "JavaScript", mjs: "JavaScript", cjs: "JavaScript", jsx: "JavaScript", ts: "TypeScript", tsx: "TypeScript",
  json: "JSON", html: "HTML", htm: "HTML", css: "CSS", scss: "SCSS", py: "Python", rb: "Ruby", go: "Go", rs: "Rust",
  java: "Java", c: "C", cpp: "C++", h: "C header", cs: "C#", php: "PHP", sh: "Shell", ps1: "PowerShell", bat: "Batch",
  yml: "YAML", yaml: "YAML", toml: "TOML", xml: "XML", svg: "SVG", sql: "SQL", md: "Markdown", markdown: "Markdown"
};

/** The language a file is written in, when its name says. */
export function languageOf(name: string): string | null {
  return languages[extensionOf(name)] ?? null;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Folders always first; then by name as a person sorts it, by newest, or by size. */
export function sortEntries(list: FileEntry[], by: FileSort): FileEntry[] {
  return [...list].sort((a, b) => {
    if (a.directory !== b.directory) return a.directory ? -1 : 1;
    if (by === "newest") return b.modifiedAt - a.modifiedAt || collator.compare(a.name, b.name);
    if (by === "size") return b.bytes - a.bytes || collator.compare(a.name, b.name);
    return collator.compare(a.name, b.name);
  });
}

/** The path as this PC writes it: the workspace root joined with a workspace path. */
export function absolutePath(root: string, path: string): string {
  const separator = root.includes("\\") ? "\\" : "/";
  const trimmed = root.replace(/[\\/]+$/, "");
  if (!path || path === ".") return trimmed;
  return `${trimmed}${separator}${path.split("/").join(separator)}`;
}
