import path from "node:path";

// Where the assistant may read and write once it has been given the machine.
//
// The workspace sandbox is right for the default state: with nothing granted,
// TRHAI can only touch a folder of its own, and a wrong path is a wrong path
// inside a folder nobody minds. But it made the two halves of the app
// disagree. run_command has always run in the user's home directory - it can
// `type` any file on the disk - while read_file could not open one three
// folders up. The same permission produced full shell access and a sandboxed
// editor, which is not a security boundary, just an inconvenience with a shell
// shaped hole in it.
//
// So the machine-access switch governs both. Off: the workspace, as before.
// On: the disk, because that is what was asked for and what "work on my
// project" requires.

/**
 * Places that are refused a write even with access granted.
 *
 * Not a limit on the user - it is their machine and their switch. It is a
 * limit on a small local model's typos. The model driving this wrote a server
 * that killed itself on startup twice in three attempts; the same class of
 * mistake aimed at System32 is not a bug report, it is a reinstall. Nothing a
 * coding task legitimately needs lives in these, so refusing them costs
 * nothing real.
 *
 * Reads are not restricted. Reading a system file cannot break anything, and
 * being unable to read one is exactly the kind of pointless obstruction that
 * made the sandbox worth removing.
 */
const windowsProtected = [
  "c:\\windows",
  "c:\\program files",
  "c:\\program files (x86)",
  "c:\\programdata\\microsoft"
];

const posixProtected = [
  "/etc", "/bin", "/sbin", "/usr/bin", "/usr/sbin",
  "/boot", "/sys", "/proc", "/system", "/library"
];

/**
 * Only the running platform's own list applies.
 *
 * A POSIX path on Windows is not a system location: path.resolve("/etc/passwd")
 * there produces D:\etc\passwd, an ordinary folder on whichever drive happens
 * to be current. Refusing it would block a perfectly normal write while
 * protecting nothing, and treating it as sensitive would be theatre.
 */
const protectedWritePrefixes = process.platform === "win32" ? windowsProtected : posixProtected;

export type PathVerdict =
  | { ok: true; path: string }
  | { ok: false; reason: string };

/**
 * Whether `candidate` is `parent` or sits underneath it. Purely lexical.
 *
 * `startsWith(parent)` alone is wrong, and wrong in the direction that matters:
 * "/workspace-evil" starts with "/workspace" and is not inside it. The
 * separator is what makes a path a child, and path.relative is what encodes
 * that - a result climbing out begins with "..", and one on another root comes
 * back absolute.
 *
 * This was written twice. workspace.ts had its own copy, identical down to the
 * reasoning above, and the two were only ever going to drift - which for a
 * containment check is the kind of drift that ends with one of them letting
 * something through. One implementation now, used by both.
 */
export function isInsidePath(parent: string, candidate: string): boolean {
  const from = path.resolve(parent);
  const to = path.resolve(candidate);
  if (from === to) return true;
  const rel = path.relative(from, to);
  return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function isProtectedWriteTarget(candidate: string): boolean {
  const normalised = path.resolve(candidate).toLowerCase().replace(/\//g, path.sep === "\\" ? "\\" : "/");
  return protectedWritePrefixes.some((prefix) => {
    const normalisedPrefix = prefix.replace(/\//g, path.sep === "\\" ? "\\" : "/");
    return normalised === normalisedPrefix || normalised.startsWith(normalisedPrefix + path.sep);
  });
}

/**
 * Resolve a path the assistant asked for.
 *
 * `insideWorkspace` is the existing sandbox resolver, passed in rather than
 * imported so this stays a pure decision about which rule applies. It returns
 * null when the path escapes, exactly as it does today.
 */
export function resolveForAccess(
  candidate: string,
  options: {
    granted: boolean;
    intent: "read" | "write";
    insideWorkspace: (candidate: string) => string | null;
  }
): PathVerdict {
  if (typeof candidate !== "string" || !candidate.trim()) {
    return { ok: false, reason: "No path was given." };
  }
  if (candidate.includes("\0")) {
    // A NUL truncates the path at the system call, so what is checked and what
    // is opened can differ.
    return { ok: false, reason: "That path is not valid." };
  }

  // A workspace-relative path keeps working exactly as before, granted or not.
  // Only reaching outside needs the switch.
  const inside = options.insideWorkspace(candidate);
  if (inside) return { ok: true, path: inside };

  if (!options.granted) {
    return {
      ok: false,
      reason: "That path is outside my workspace. Turn on machine access and I can reach it."
    };
  }

  const resolved = path.resolve(candidate);

  if (options.intent === "write" && isProtectedWriteTarget(resolved)) {
    return {
      ok: false,
      reason: `${resolved} is a system location. I will not write there even with access granted - `
        + "nothing a coding task needs lives in it, and a mistake there is not recoverable."
    };
  }

  return { ok: true, path: resolved };
}

/**
 * Whether this turn is code work, and so should be given the coding model.
 *
 * The chat model runs everything by default, and for a conversation that is
 * right. For editing a file it is not: asked to use edit_file on a real path,
 * the 1.9GB chat model replied "Got it - I'll keep that in mind for this
 * conversation" and called nothing at all. The tools were fine; the model
 * simply did not act. The coding model is trained for exactly this and picks
 * the tool without being coaxed.
 *
 * Decided from the mode the router already assigns plus the plain evidence in
 * the message - a full path, or a request naming a file - because someone
 * asking to fix a file rarely announces that they are in "code mode".
 */
export function isCodeWork(mode: string, message: string): boolean {
  if (["build", "code", "debug", "coding", "plan"].includes(mode)) return true;

  const text = message.toLowerCase();
  // A drive letter or a POSIX-looking path with a file extension on the end.
  if (/[a-z]:[\\/][^\s]+\.[a-z0-9]{1,5}\b/.test(text)) return true;
  if (/(?:^|\s)\/[^\s]+\.[a-z0-9]{1,5}\b/.test(text)) return true;

  return /\b(edit_file|write_file|read_file|refactor|the function|this file|the file)\b/.test(text);
}
