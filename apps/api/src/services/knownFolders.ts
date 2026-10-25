import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";

// Where "my Desktop" is. People say where they want a file the way they say it
// to each other - "put it on my desktop", "save it in Downloads" - and the
// folder behind those words is not always under the home folder: on a Windows
// PC that backs its folders up to OneDrive, the Desktop is
// C:\Users\Sam\OneDrive\Desktop, and C:\Users\Sam\Desktop is an empty stub or
// is not there at all. Windows keeps the real place in the registry, so that
// is asked first; the plain folder under home is the answer only when it says
// nothing.

export type KnownFolder = "desktop" | "documents" | "downloads" | "pictures" | "music" | "videos";

/** The registry value that holds each folder's place, under User Shell Folders. */
const registryNames: Record<KnownFolder, string> = {
  desktop: "Desktop",
  documents: "Personal",
  downloads: "{374DE290-123F-4565-9164-39C4925E467B}",
  pictures: "My Pictures",
  music: "My Music",
  videos: "My Video"
};

const folderNames: Record<KnownFolder, string> = {
  desktop: "Desktop",
  documents: "Documents",
  downloads: "Downloads",
  pictures: "Pictures",
  music: "Music",
  videos: "Videos"
};

export type FolderLookup = {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
  /** The registry value's text, or null when it has none. Windows only. */
  registry: (valueName: string) => string | null;
};

const shellFolders = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders";

function readRegistry(valueName: string): string | null {
  try {
    const output = execFileSync("reg", ["query", shellFolders, "/v", valueName], { encoding: "utf8", windowsHide: true, timeout: 4000, stdio: ["ignore", "pipe", "ignore"] });
    return /REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m.exec(output)?.[1] ?? null;
  } catch {
    return null;
  }
}

const system = (): FolderLookup => ({ platform: process.platform, home: homedir(), env: process.env, registry: readRegistry });

const remembered = new Map<KnownFolder, string>();

/** Where one of the usual folders is on this computer. */
export function knownFolderPath(folder: KnownFolder, lookup: FolderLookup = system()): string {
  const useCache = lookup.registry === readRegistry && lookup.home === homedir();
  const cached = useCache ? remembered.get(folder) : undefined;
  if (cached) return cached;
  let found: string | null = null;
  if (lookup.platform === "win32") {
    const value = lookup.registry(registryNames[folder]);
    // The value is written with variables in it: %USERPROFILE%\OneDrive\Desktop.
    const expanded = value?.replace(/%([^%]+)%/g, (whole, name: string) => lookup.env[name] ?? lookup.env[name.toUpperCase()] ?? whole);
    if (expanded && !expanded.includes("%") && path.win32.isAbsolute(expanded)) found = path.win32.normalize(expanded);
  }
  const place = found ?? path.join(lookup.home, folderNames[folder]);
  if (useCache) remembered.set(folder, place);
  return place;
}

const aliases: Array<[RegExp, KnownFolder]> = [
  [/^desktop$/i, "desktop"],
  [/^documents?$/i, "documents"],
  [/^downloads?$/i, "downloads"],
  [/^pictures?$/i, "pictures"],
  [/^music$/i, "music"],
  [/^videos?$/i, "videos"]
];

/**
 * The real folder a request names the way a person would: "Desktop", "my
 * desktop", "~/Downloads", "Desktop/Invoices", "%USERPROFILE%\Documents\Taxes".
 * Null when it is not one of those - a workspace path, or a full path, is
 * left for the caller to deal with as it always was.
 */
export function expandKnownFolder(request: string, lookup: FolderLookup = system()): string | null {
  const cleaned = request.trim().replace(/^["']+|["']+$/g, "").replace(/\\/g, "/").replace(/^(?:the|my|your)\s+/i, "").replace(/\s+folder$/i, "");
  if (/^(?:~|%userprofile%|\$home)\/*$/i.test(cleaned)) return lookup.home;
  const withoutHome = cleaned.replace(/^(?:~|%userprofile%|\$home)(?:\/|$)/i, "");
  const segments = withoutHome.split("/").filter(Boolean);
  if (segments.length === 0 || segments.includes("..")) return null;
  const match = aliases.find(([pattern]) => pattern.test(segments[0]));
  if (!match) return null;
  return path.join(knownFolderPath(match[1], lookup), ...segments.slice(1));
}
