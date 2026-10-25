import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { resolveInWorkspace } from "./workspace.js";

// Opening a file TRH AI made in the program it belongs to - a Word document in
// Word, a PDF in the reader - and showing where it is on the disk.
//
// Only what is in the workspace, and only what cannot run: documents,
// pictures, sound and video. A script or a program in the workspace is not
// made safe by being asked for politely, so those are shown in their folder
// and nothing more.

export type FileAction = "open" | "reveal";

/** What is opened with the program it belongs to. Nothing that a person could run, and no web page: a page opened from disk can run script. */
export const openableExtensions: ReadonlySet<string> = new Set([
  ".docx", ".pdf", ".xlsx", ".pptx", ".csv", ".txt", ".md", ".srt", ".vtt",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp",
  ".mp3", ".wav", ".m4a", ".flac", ".ogg", ".mp4", ".mkv", ".mov", ".webm"
]);

/** Starts a program and says whether it started. A test stands in for it; nothing here waits for the program to finish. */
export type Launch = (program: string, args: string[], options: { verbatim?: boolean }) => Promise<boolean>;

const startProgram: Launch = (program, args, options) =>
  new Promise((resolve) => {
    try {
      const child = spawn(program, args, { detached: true, stdio: "ignore", windowsVerbatimArguments: options.verbatim === true });
      child.once("error", () => resolve(false));
      child.once("spawn", () => { child.unref(); resolve(true); });
    } catch {
      resolve(false);
    }
  });

let launch: Launch = startProgram;

/** Hand in a stand-in for starting programs (a test), or nothing to go back to the real one. */
export function useLauncher(next?: Launch): void {
  launch = next ?? startProgram;
}

/**
 * The command that does it on this system. A file is opened by naming it to the
 * system's own opener, which picks the program it belongs to; a file is shown
 * by asking the file manager to select it in its folder.
 */
export function commandFor(
  action: FileAction,
  absolute: string,
  isFolder: boolean,
  platform: NodeJS.Platform = process.platform
): { program: string; args: string[]; verbatim?: boolean } {
  const selecting = action === "reveal" && !isFolder;
  if (platform === "win32") {
    // Explorer wants the quotes around the path alone: /select,"C:\a b\c.docx".
    return selecting ? { program: "explorer.exe", args: [`/select,"${absolute}"`], verbatim: true } : { program: "explorer.exe", args: [absolute] };
  }
  if (platform === "darwin") return { program: "open", args: selecting ? ["-R", absolute] : [absolute] };
  return { program: "xdg-open", args: [selecting ? path.dirname(absolute) : absolute] };
}

export type OpenOutcome = { ok: true } | { ok: false; status: 400 | 404 | 415 | 500; reason: string };

/** Open a file or folder in the workspace, or show it where it is. */
export async function openWorkspacePath(relative: unknown, action: FileAction, platform: NodeJS.Platform = process.platform): Promise<OpenOutcome> {
  const absolute = typeof relative === "string" ? resolveInWorkspace(relative) : null;
  if (!absolute) return { ok: false, status: 400, reason: "That is not a place in the workspace." };
  let isFolder: boolean;
  try {
    isFolder = statSync(absolute).isDirectory();
  } catch {
    return { ok: false, status: 404, reason: "There is no file there." };
  }
  if (action === "open" && !isFolder) {
    const extension = path.extname(absolute).toLowerCase();
    if (!openableExtensions.has(extension)) {
      return {
        ok: false,
        status: 415,
        reason: `${extension ? `A ${extension} file` : "A file with no type"} is not opened from here: this opens documents, pictures, sound and video. It can be shown in its folder instead.`
      };
    }
  }
  const command = commandFor(action, absolute, isFolder, platform);
  const started = await launch(command.program, command.args, { verbatim: command.verbatim });
  return started ? { ok: true } : { ok: false, status: 500, reason: "The program that opens files could not be started." };
}
