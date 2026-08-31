// Building the things the templates cannot.
//
// planProject + generateProject cover two shapes well: a records app and a
// calculator. Everything else went through entity extraction anyway, which is
// how "build me a snake game" produced a REST API storing `game` records and
// "build me a password generator" produced one storing `generator` records.
// They ran, they passed their own smoke checks, and they were not what anyone
// asked for - the worst kind of wrong, because nothing reported a failure.
//
// So anything outside those shapes is written by the local model instead. That
// is less predictable than a template, and this module exists to make it safe
// rather than to make it certain: everything the model returns is parsed
// strictly, every path is checked before a single byte is written, and the
// result is only called a success once the app has actually been run.
//
// Nothing here trusts the model. It is generating text that will be written to
// disk, which is exactly the position where "it probably meant well" is not
// good enough.

export type AuthoredFile = { path: string; content: string };

export type AuthorParse =
  | { ok: true; files: AuthoredFile[] }
  | { ok: false; reason: string };

/** Extensions a generated app may contain. Anything else is refused. */
export const allowedExtensions = [".js", ".mjs", ".json", ".html", ".css", ".md", ".txt"];

/**
 * How files are delimited in the model's reply.
 *
 * Not JSON. Asking a model for a JSON array of files means asking it to escape
 * every quote and newline in a program, and it gets that wrong: the first
 * attempt here came back as `},"{"path":` - one stray quote, whole reply
 * unusable, thirty seconds wasted. Between two markers the content is written
 * exactly as it appears, so there is nothing to escape and nothing to get
 * wrong. A JSON reply is still accepted, because some models produce it
 * correctly and there is no reason to refuse one that did.
 */
export const fileMarker = "=== FILE:";

/** Caps, so a runaway generation cannot fill the workspace. */
export const maxFiles = 12;
export const maxFileBytes = 64 * 1024;
export const maxTotalBytes = 256 * 1024;

/**
 * The instruction the model is given.
 *
 * Explicit about the runtime because the workspace runs plain Node with no
 * install step: a generated app that opens by asking for `npm install express`
 * is one the user cannot run, however good its code is.
 */
export function authorPrompt(description: string): string {
  return [
    "You are writing a small, self-contained application that will be saved to disk and run immediately.",
    "",
    `The user asked for: ${description}`,
    "",
    "Rules:",
    "- Node.js only, using built-in modules. No npm packages, no install step.",
    "- Serve a browser UI from a plain http server in server.js, listening on process.env.PORT || 3000.",
    "- server.js must ONLY start the server and then keep running. It must never",
    "  call process.exit, and must not check itself - a server that verifies itself",
    "  and exits is a server that quits the moment it starts.",
    "- Put the interface in public/index.html, with any CSS and JS inline in that file.",
    "- Resolve public/index.html relative to __dirname, not the working directory,",
    "  so it is found whatever folder the app is started from.",
    "- Put the check in smoke.js and nowhere else: it starts the server as a child",
    "  process, requests the page, and exits non-zero if that fails.",
    "- smoke.js must WAIT for the server before requesting. Retry the request every",
    "  200ms for up to 10 seconds and only fail after that. A check that requests",
    "  immediately gets ECONNREFUSED and reports a working app as broken - this is",
    "  the single most common way a correct app gets marked failed.",
    "- smoke.js must kill the server it started and exit 0 on success, or it hangs",
    "  forever and the build is reported as timed out.",
    "- Read the port from process.env.SMOKE_PORT || process.env.PORT || 3000 in",
    "  smoke.js, so it uses the port it is given rather than a fixed one.",
    "- Include a package.json with a start script and a smoke script.",
    "- Include a README.md saying what it is and how to run it.",
    "- The app must actually do what was asked. Do not produce a generic CRUD API.",
    "",
    "Output format - follow it exactly:",
    "",
    `${fileMarker} path/of/file`,
    "the entire contents of that file, verbatim",
    `${fileMarker} path/of/next/file`,
    "the entire contents of that file, verbatim",
    "",
    "Write nothing before the first marker and nothing after the last file.",
    "Do not wrap files in code fences. Do not escape quotes or newlines - the",
    "content between two markers is written to disk exactly as it appears.",
    "Paths must be relative, with no leading slash and no '..'."
  ].join("\n");
}

/**
 * Pull the JSON array out of whatever the model actually said.
 *
 * Models add prose and code fences however firmly they are told not to, and a
 * generation that is correct apart from a "Here you go:" prefix is worth
 * recovering rather than discarding. This only ever *finds* the array - it does
 * not repair malformed JSON, because a file list that needed guessing to parse
 * is not one to write to disk.
 */
function extractJsonArray(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;

  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;
  return body.slice(start, end + 1);
}

/** Whether a path is safe to write under the workspace. */
export function isSafePath(candidate: string): boolean {
  if (typeof candidate !== "string" || candidate.trim().length === 0) return false;
  // Backslashes are normalised first so a Windows-style path cannot smuggle a
  // traversal past a check that only looks for forward slashes.
  const normalised = candidate.replace(/\\/g, "/").trim();

  if (normalised.startsWith("/")) return false;
  if (/^[a-zA-Z]:/.test(normalised)) return false;
  if (normalised.split("/").some((segment) => segment === ".." || segment === "")) return false;
  // A leading "./" is harmless but means two spellings of one path; refuse it
  // so a generation cannot write the same file twice under different names.
  if (normalised.startsWith("./")) return false;
  if (normalised.includes("\0")) return false;

  const dot = normalised.lastIndexOf(".");
  if (dot === -1) return false;
  return allowedExtensions.includes(normalised.slice(dot).toLowerCase());
}

/**
 * The checks every candidate file must pass, whichever format it arrived in.
 *
 * Shared deliberately: two parsers with two copies of the path rules is two
 * places for one of them to fall behind, and the path rules are the part that
 * decides whether model output can be written outside the folder it belongs in.
 */
function validateFiles(candidates: Array<{ path: unknown; content: unknown }>): AuthorParse {
  if (candidates.length === 0) return { ok: false, reason: "The model returned no files." };
  if (candidates.length > maxFiles) {
    return { ok: false, reason: `The model returned ${candidates.length} files; the limit is ${maxFiles}.` };
  }

  const files: AuthoredFile[] = [];
  const seen = new Set<string>();
  let total = 0;

  for (const { path, content } of candidates) {
    if (typeof path !== "string" || typeof content !== "string") {
      return { ok: false, reason: "A file was missing its path or its contents." };
    }
    if (!isSafePath(path)) {
      return { ok: false, reason: `Refused an unsafe or unsupported path: ${path}` };
    }

    const normalised = path.replace(/\\/g, "/").trim();
    if (seen.has(normalised)) {
      return { ok: false, reason: `The model listed ${normalised} twice.` };
    }
    seen.add(normalised);

    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > maxFileBytes) {
      return { ok: false, reason: `${normalised} is larger than the ${maxFileBytes / 1024}KB limit.` };
    }
    total += bytes;
    if (total > maxTotalBytes) {
      return { ok: false, reason: `The generated app exceeds the ${maxTotalBytes / 1024}KB total limit.` };
    }

    files.push({ path: normalised, content });
  }

  // An app with no way to start it is not an app. Refusing costs the user a
  // retry; writing it costs them a folder that cannot run.
  if (!files.some((file) => file.path === "server.js" || file.path === "index.js")) {
    return { ok: false, reason: "The generated app had no server.js to run." };
  }

  return { ok: true, files };
}

function parseJsonFiles(text: string): AuthorParse {
  const json = extractJsonArray(text);
  if (!json) return { ok: false, reason: "The model did not return a file list." };

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, reason: "The model's file list was not valid JSON." };
  }

  if (!Array.isArray(parsed)) return { ok: false, reason: "The model returned no files." };

  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") {
      return { ok: false, reason: "One of the entries was not a file." };
    }
  }

  return validateFiles(parsed.map((entry) => ({
    path: (entry as { path?: unknown }).path,
    content: (entry as { content?: unknown }).content
  })));
}

/**
 * Read the delimited format: a marker line naming a path, then that file's
 * contents verbatim until the next marker.
 *
 * Nothing is unescaped, because nothing was escaped. Code fences are stripped
 * if the model added them anyway - that is cosmetic damage to an otherwise
 * correct reply, and refusing over it would throw away a good generation.
 */
function parseDelimitedFiles(text: string): AuthorParse {
  const lines = text.split(/\r?\n/);
  const collected: Array<{ path: string; lines: string[] }> = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith(fileMarker)) {
      // "=== FILE: server.js ===" and "=== FILE: server.js" both appear.
      const path = trimmed.slice(fileMarker.length).replace(/=+$/, "").trim();
      collected.push({ path, lines: [] });
      continue;
    }
    if (collected.length === 0) continue; // preamble before the first marker
    collected[collected.length - 1].lines.push(line);
  }

  if (collected.length === 0) return { ok: false, reason: "The model did not return a file list." };

  const candidates = collected.map((entry) => {
    let body = entry.lines.join("\n").trim();
    // A whole file wrapped in one fence, which some models add despite being
    // told not to. Only stripped when it encloses the entire body.
    const fenced = body.match(/^```[a-zA-Z0-9]*\n([\s\S]*)\n```$/);
    if (fenced) body = fenced[1];
    return { path: entry.path, content: body };
  });

  return validateFiles(candidates);
}

/**
 * Whichever format the model used.
 *
 * Delimited first, because that is what the prompt asks for and what survives
 * a program full of quotes and newlines. JSON is still accepted: some models
 * produce it correctly, and refusing a correct reply for being in the other
 * shape would be pedantry at the user's expense.
 */
export function parseAuthoredFiles(text: string): AuthorParse {
  if (text.includes(fileMarker)) return parseDelimitedFiles(text);
  return parseJsonFiles(text);
}

/**
 * Does this file even parse?
 *
 * Compiled, never run. `new Function` hands the source to the same parser that
 * would run it and throws on a syntax error without executing a line, which is
 * the only safe check available here: generated code has not earned the right
 * to run, and the machine-access switch that governs running things is off by
 * default for exactly that reason.
 */
export function compiles(code: string): boolean {
  try {
    // Wrapped so a top-level `return` - which Node allows in a CommonJS module
    // but a bare Function body does not - is not mistaken for a syntax error.
    new Function(`(function(){${code}\n})`);
    return true;
  } catch {
    return false;
  }
}

/**
 * A server that shuts itself down the moment it starts.
 *
 * Observed, not imagined: asked for a smoke check, the model put one at the
 * bottom of server.js as well, so the server booted, requested its own page and
 * called process.exit(0). It printed "Server running at http://localhost:4321/"
 * and was gone before anything could connect - the most confusing possible
 * failure, because the log says it worked.
 *
 * The prompt now says not to, and this is what catches it when the model does
 * it anyway.
 */
export function selfTerminates(code: string): boolean {
  return /process\s*\.\s*exit\s*\(/.test(code);
}

/** What is wrong with a generated app, or null when nothing is. */
/** Node's own modules, which need no install. */
const nodeBuiltins = new Set([
  "assert", "buffer", "child_process", "cluster", "console", "crypto", "dgram",
  "dns", "events", "fs", "http", "http2", "https", "net", "os", "path",
  "perf_hooks", "process", "querystring", "readline", "repl", "stream",
  "string_decoder", "timers", "tls", "tty", "url", "util", "v8", "vm",
  "worker_threads", "zlib"
]);

/**
 * An import of something that is not on this machine.
 *
 * Generated apps run on the standard library alone, so `node server.js` works
 * with no install step - that is the whole reason they are useful immediately
 * rather than after an npm install that may not even succeed offline. Nothing
 * was enforcing it.
 *
 * Caught live, and it is exactly the failure that rule exists to prevent: asked
 * for a celsius-to-fahrenheit converter, the model wrote `require('wait-port')`
 * into smoke.js. The app was written to disk, its own smoke test then died with
 * "Cannot find module 'wait-port'", and the model's next move was to run
 * `npm install wait-port` - which is how a zero-dependency project quietly
 * acquires a node_modules and stops being runnable anywhere else.
 *
 * Returns the offending specifier so the retry can tell the model precisely
 * what to remove, rather than asking it to guess what was wrong.
 */
export function findForeignImport(content: string): string | null {
  // Both spellings, quotes either way. Deliberately syntactic: this runs on
  // code that has already been proven to parse, so there is no cleverness to
  // buy by walking an AST here.
  const patterns = [
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s+["']([^"']+)["']/g
  ];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const specifier = match[1];
      if (specifier.startsWith(".") || specifier.startsWith("/")) continue;
      if (specifier.startsWith("node:")) continue;
      // "fs/promises" is a builtin subpath; "wait-port" is not.
      if (nodeBuiltins.has(specifier.split("/")[0])) continue;
      return specifier;
    }
  }

  return null;
}

/**
 * Find the index of the parenthesis closing the one at `open`.
 *
 * String-aware only as far as it needs to be: a bracket inside a quoted string
 * must not be counted, or a perfectly good executor containing "(" in a message
 * would be mis-parsed and reported as a fault.
 */
function matchingParen(text: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;

  for (let index = open; index < text.length; index += 1) {
    const character = text[index];

    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
      continue;
    }

    if (character === '"' || character === "'" || character === "`") quote = character;
    else if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

/**
 * A promise that can never settle successfully.
 *
 * Caught live, and it is why a generated app that was otherwise correct could
 * not prove itself. The model wrote:
 *
 *   function startServer() {
 *     const child = spawn('node', ['server.js']);
 *     return new Promise((resolve, reject) => {
 *       child.stdout.on('data', ...);
 *       child.stderr.on('data', ... reject(...));
 *       return child;              // does nothing
 *     });
 *   }
 *
 * `resolve` is never called, so `await startServer()` waits forever. The server
 * itself was fine; the smoke test simply never got past starting it, and the
 * build reported "could not verify within 20s" - the app looking broken when it
 * was not.
 *
 * The test is whether the resolve parameter is *mentioned* in the body, not
 * whether it is called. `new Promise(resolve => setTimeout(resolve, ms))` never
 * writes `resolve(` and is perfectly correct, so anything stricter would reject
 * the commonest delay helper there is.
 */
export function findHangingPromise(content: string): boolean {
  const marker = /\bnew\s+Promise\s*\(/g;
  let match: RegExpExecArray | null;

  while ((match = marker.exec(content)) !== null) {
    const open = content.indexOf("(", match.index + match[0].length - 1);
    const close = matchingParen(content, open);
    if (close === -1) continue;

    const executor = content.slice(open + 1, close);

    // The first parameter, whether or not it is parenthesised, and whatever it
    // is named - "resolve" is a convention, not a rule.
    const parameters = /^\s*(?:async\s+)?(?:\(\s*([A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*)\s*=>)/.exec(executor);
    const resolveName = parameters?.[1] ?? parameters?.[2];
    if (!resolveName) continue;

    const mentions = executor.match(new RegExp(`\\b${resolveName}\\b`, "g"))?.length ?? 0;
    // Once is the parameter declaring itself. Only that means it is never used.
    if (mentions <= 1) return true;
  }

  return false;
}

export function findAppFault(files: AuthoredFile[]): string | null {
  const entry = files.find((file) => file.path === "server.js" || file.path === "index.js");
  if (!entry) return "there was no server.js to run";
  if (!compiles(entry.content)) return `${entry.path} does not parse as JavaScript`;
  if (selfTerminates(entry.content)) {
    return `${entry.path} exits on its own, so the server would quit the moment it started`;
  }

  for (const file of files) {
    if (file.path.endsWith(".js") && file.path !== entry.path && !compiles(file.content)) {
      return `${file.path} does not parse as JavaScript`;
    }
    if (file.path.endsWith(".json")) {
      try {
        JSON.parse(file.content);
      } catch {
        return `${file.path} is not valid JSON`;
      }
    }
    // Checked on every file, smoke.js included - that is where it actually
    // happened, and a broken smoke test means the app reports itself as failing
    // even when the server is fine.
    if (file.path.endsWith(".js")) {
      const foreign = findForeignImport(file.content);
      if (foreign) {
        return `${file.path} imports "${foreign}", which is not installed and never will be. `
          + "Use only Node's built-in modules - no npm packages at all";
      }

      if (findHangingPromise(file.content)) {
        return `${file.path} builds a Promise whose resolve is never called, so anything `
          + "awaiting it waits forever. Call resolve() on the success path";
      }
    }
  }

  return null;
}

/**
 * Which installed model should write the app.
 *
 * A coding model if one is there, whatever the chat default is. Measured on
 * this machine: the 1.9GB general model did not finish writing a snake game in
 * five minutes, and qwen2.5-coder:7b wrote one in thirty seconds. That is not a
 * close call, and it is not a judgement about which model is better in general
 * - writing a whole application is a different job from answering a question,
 * and the model trained for it does it enormously faster.
 *
 * Falls back to the configured model when nothing coding-specific is installed,
 * because a slow attempt still beats refusing to try.
 */
export function pickAuthorModel(installed: string[], configured: string): string {
  const preferred = ["qwen2.5-coder", "deepseek-coder", "codellama", "codestral", "starcoder", "granite-code"];

  for (const name of preferred) {
    const match = installed.find((candidate) => candidate.split(":")[0] === name || candidate.startsWith(name));
    if (match) return match;
  }

  return configured;
}
