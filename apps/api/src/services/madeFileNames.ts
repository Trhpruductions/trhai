import { closeSync, openSync, rmSync } from "node:fs";
import path from "node:path";

// Names for the files TRH AI makes: taken from the title, acceptable to Windows,
// macOS and Linux alike, and never one that is already there. Shared by every
// tool that makes a file (documents, spreadsheets, ...).

const reservedNames = /^(?:con|prn|aux|nul|com\d|lpt\d)$/i;
const notInAFileName = new RegExp(`[<>:"/\\\\|?*${String.fromCharCode(0)}-${String.fromCharCode(31)}]+`, "g");

/** A file name for a title that Windows, macOS and Linux all accept, and that still looks like the title. */
export function fileStem(title: string, fallback = "Document"): string {
  let stem = title.normalize("NFC").replace(notInAFileName, " ").replace(/\s+/g, " ").trim();
  if (stem.length > 80) {
    const cut = stem.slice(0, 80);
    const space = cut.lastIndexOf(" ");
    stem = space >= 40 ? cut.slice(0, space) : cut;
  }
  stem = stem.replace(/[. ]+$/g, "").replace(/^\.+/, "");
  if (!stem) return fallback;
  return reservedNames.test(stem) ? `${stem} ${fallback.toLowerCase()}` : stem;
}

/**
 * Names for the files of one thing that are not taken: "Report.docx", then
 * "Report (2).docx". The names are claimed - created empty, exclusively - as
 * they are chosen, so two made at once cannot be given the same one. Each
 * format is its own file ending: "docx", "pdf", "xlsx".
 */
export function claimNames<Format extends string>(
  directory: string,
  stem: string,
  formats: readonly Format[]
): { number: number; files: Map<Format, string> } | null {
  const release = (claimed: Map<Format, string>) => {
    for (const file of claimed.values()) { try { rmSync(file, { force: true }); } catch { /* it was created empty a moment ago */ } }
  };
  for (let number = 1; number < 1000; number += 1) {
    const base = number === 1 ? stem : `${stem} (${number})`;
    const claimed = new Map<Format, string>();
    let free = true;
    for (const format of formats) {
      const file = path.join(directory, `${base}.${format}`);
      try {
        closeSync(openSync(file, "wx"));
        claimed.set(format, file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          // Not a name that is taken but a folder that cannot be written in: the names claimed so far go too.
          release(claimed);
          throw error;
        }
        free = false;
        break;
      }
    }
    if (free) return { number, files: claimed };
    release(claimed);
  }
  return null;
}
