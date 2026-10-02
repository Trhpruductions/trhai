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
