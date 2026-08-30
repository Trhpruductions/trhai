// Whether the user asked for something to be done, or asked a question.
//
// The loop had no notion of this. If the model returned prose and called no
// tool, that prose became the answer — so "edit greet.js and add a guard" could
// be answered with "Got it, I'll keep that in mind for this conversation" and
// the app would present it as the reply. Nothing was edited, nothing failed,
// and nothing said so.
//
// Deterministic on purpose. Asking a model to classify the request would put
// the same unreliability that causes the bug in charge of detecting it, and it
// could not be regression-tested. Rules can be.
//
// The bar for "action" is a verb that acts on this machine, plus something to
// act on. Not certainty about what the user wants — only enough to know that
// answering with prose alone would be a failure.

export type ActionKind =
  /** Reading, listing or searching files. */
  | "read"
  /** Creating, writing, editing, renaming or deleting. */
  | "write"
  /** Running a command or program. */
  | "execute"
  /** Project checks: test, lint, typecheck, build, smoke. */
  | "check"
  /** Generating a new application. */
  | "generate";

export type IntentVerdict = {
  /** True when answering with prose alone would be a failure. */
  action: boolean;
  /** Present when action is true. */
  kind?: ActionKind;
  /**
   * Whether the request names what to act on.
   *
   * "edit greet.js" has a target; "edit the file" does not. The difference
   * decides whether a missing tool call should be retried or turned into one
   * specific question - retrying a request that never named a file just spends
   * another generation arriving at the same place.
   */
  hasTarget: boolean;
  /** Why, in a few words. Recorded in the audit and asserted in tests. */
  reason: string;
  /** Tools that would satisfy it, named in the failure message. */
  expects: string[];
};

/**
 * Openings that mean "tell me", whatever verbs follow.
 *
 * Checked first and decisively. "Explain how to build a task app" contains
 * "build", and without this it would be treated as a request to build one.
 */
const explanatoryOpeners = [
  "what", "why", "how", "when", "who", "where", "which",
  "explain", "describe", "summarise", "summarize", "compare",
  "tell me about", "help me understand", "do you know",
  "is it", "are there", "should i", "could you explain"
];

/** Verbs that act on this machine, grouped by what they act as. */
const actionVerbs: Array<{ kind: ActionKind; words: string[]; expects: string[] }> = [
  {
    kind: "check",
    // Before "execute", so "run the tests" is a check rather than raw shell.
    words: ["npm test", "npm run", "run the test", "run tests", "run npm",
      "typecheck", "type check", "lint", "smoke test", "run the build"],
    expects: ["run_script", "run_command"]
  },
  {
    kind: "generate",
    words: ["build me", "build a", "build an", "make me", "create an app",
      "create a app", "generate an app", "write me an app", "scaffold"],
    expects: ["build_app"]
  },
  {
    kind: "write",
    words: ["edit", "change", "modify", "update", "fix", "rename", "move",
      "delete", "remove", "write", "create", "add", "append", "replace",
      "refactor", "patch"],
    expects: ["edit_file", "write_file"]
  },
  {
    kind: "read",
    words: ["read", "open", "show me", "list", "search for", "find",
      "look at", "look in", "grep", "cat "],
    expects: ["read_file", "list_files"]
  },
  {
    kind: "execute",
    words: ["run ", "execute", "install", "start the", "launch", "compile"],
    expects: ["run_command"]
  }
];

/**
 * Uses of "run" that are English rather than instruction.
 *
 * A command names its own target - "run node --version" has nothing to look up
 * on disk - so execute cannot require a file the way edit does. That leaves the
 * ordinary senses of the word to exclude explicitly.
 */
const conversationalRun = /\brun (?:me through|by me|into|through|out of|a bit|late)\b|\bin the long run\b/;

/** A drive path, a POSIX path, or a bare filename with an extension. */
const targetPatterns = [
  /[a-z]:[\\/][^\s]+/i,
  /(?:^|\s)\/[^\s]+\.[a-z0-9]{1,6}\b/i,
  /\b[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|txt|css|html|py|ps1|bat|sh|yml|yaml|toml)\b/i
];

/**
 * Something that looks like a command, rather than a request for one.
 *
 * "run node --version" carries its command; "run a command for me" does not.
 * Execute cannot use the file patterns above - a command names its own target
 * and usually touches no path at all.
 */
const commandPatterns = [
  /\b(?:npm|npx|pnpm|yarn|node|git|python|pip|dotnet|cargo|go|docker|tsc|eslint)\b/i,
  /\b\w+\s+--?\w/,            // any word followed by a flag: `node --version`
  /`[^`]+`/                    // or a command the user quoted
];

/** A named project or folder, for checks that need to know where to run. */
const projectPatterns = [
  /[a-z]:[\\/][^\s]+/i,
  /\bthis (?:project|repo|repository|folder|directory)\b/i,
  /\bin ["'`]?[\w.-]+["'`]? (?:project|repo)\b/i
];

/**
 * What one specific question to ask when the request named no target.
 *
 * Kind-specific because a generic "which file do you mean?" is wrong for half
 * of these - nobody running `npm test` is being asked for a file, and asking
 * them for one reads as the assistant not having understood at all.
 */
export function clarificationFor(kind: ActionKind): string {
  switch (kind) {
    case "read":
      return "Which file or folder do you mean? Give me the path and I will read it.";
    case "write":
      return "Which file do you mean, and what should it say? Give me the path and the change.";
    case "execute":
      return "Which command should I run? Give me the exact command.";
    case "check":
      return "Which project should I run that in? Give me the folder.";
    case "generate":
      return "What should the app do? A sentence describing it is enough.";
  }
}

function startsWithExplanatory(text: string): boolean {
  return explanatoryOpeners.some((opener) => text.startsWith(`${opener} `) || text === opener);
}

/**
 * A request that opens as a question and names nothing to act on.
 *
 * Used to decide what the model is even allowed to reach for, which is a
 * stronger lever than checking the answer afterwards. "Explain how promises
 * work in javascript" called build_app and scaffolded a five-file "Javascript
 * App" into the workspace - the user asked for an explanation and got a
 * directory. Nothing downstream can undo that: by the time the reply is
 * checked, the files exist.
 *
 * Deliberately the narrow case. It is not "the classifier said action: false" -
 * that also covers "I need a task tracker", which names no verb and is a
 * perfectly good thing to build from. It is specifically a question opener with
 * no file, path or command anywhere in it.
 */
export function isExplanatoryQuestion(message: string): boolean {
  const text = (message ?? "").trim().toLowerCase();
  if (!text) return false;
  if (!startsWithExplanatory(text)) return false;
  // A question that names a real path is asking about something concrete, and
  // may well need to read it. Only the wholly abstract case is restrained.
  return !targetPatterns.some((pattern) => pattern.test(message));
}

/**
 * A question that cannot be answered without opening the file it names.
 *
 * "What does D:/app/server.js contain" opens with "what", so the explanatory
 * rule above called it a question and let the model answer from nothing. That is
 * the exact failure this whole classifier exists to prevent: an answer about a
 * real file that was never read.
 *
 * Deliberately narrow. It needs a concrete path AND wording that asks for the
 * contents, so "how do I edit package.json" stays a question about procedure -
 * that one names a file too, and answering it does not require reading one.
 */
const asksForContents =
  /\b(?:what(?:'s|s| is| are)?\s+(?:in|inside)|contains?|contain|says?|written in|inside)\b/i;

export function classifyIntent(message: string): IntentVerdict {
  const text = (message ?? "").trim().toLowerCase();

  if (!text) {
    return { action: false, hasTarget: false, reason: "empty message", expects: [] };
  }

  const hasTarget = targetPatterns.some((pattern) => pattern.test(message));

  // Checked before the opener rule, not inside it.
  //
  // "what's in D:/app/server.js" does not begin with "what " - it begins with
  // "what's" - so nesting this under the opener check missed exactly the
  // phrasing people use most. Asking what is inside a file that has been named
  // cannot be answered without opening it, whatever the sentence starts with.
  if (hasTarget && asksForContents.test(text)) {
    return {
      action: true,
      kind: "read",
      hasTarget: true,
      reason: "asks for the contents of a named file",
      expects: ["read_file"]
    };
  }

  // A question stays a question even when it mentions doing something.
  if (startsWithExplanatory(text)) {
    return { action: false, hasTarget: false, reason: "asks about something", expects: [] };
  }

  for (const group of actionVerbs) {
    const matched = group.words.find((word) =>
      text.startsWith(word) || text.includes(` ${word}`));
    if (!matched) continue;

    if (group.kind === "execute" && conversationalRun.test(text)) continue;

    // What counts as "named its target" differs by kind. A file verb needs a
    // path; a command needs a command; a check needs somewhere to run. Using
    // the file patterns for all of them asked people running `npm test` which
    // file they meant, which reads as not having understood the request.
    const targeted = targetFor(group.kind, message, text, hasTarget);

    // The file verbs additionally need *something* to act on before this is
    // confident enough to override a prose answer. "add a note about that" is
    // conversation; "add a guard to app.ts" is an order.
    const fileVerb = group.kind === "read" || group.kind === "write";
    if (fileVerb && !hasTarget && !mentionsAFileNoun(text)) continue;

    return {
      action: true,
      kind: group.kind,
      hasTarget: targeted,
      reason: `"${matched.trim()}" acts on this machine`,
      expects: group.expects
    };
  }

  return { action: false, hasTarget, reason: "no action verb", expects: [] };
}

/**
 * "the file", "that folder" - an object without a name.
 *
 * Enough to know an action was requested, not enough to perform it. These are
 * exactly the requests that should produce one question rather than a retry.
 */
function mentionsAFileNoun(text: string): boolean {
  // Up to two words of description between the determiner and the noun, so
  // "delete the old log file" is recognised as an order with nothing named -
  // which earns one question rather than being read as conversation.
  return /\b(?:the|that|this|my)\s+(?:[\w-]+\s+){0,2}(?:file|folder|directory|script|project|repo|config)\b/
    .test(text);
}

/**
 * Whether the request named enough to act on, judged per kind.
 *
 * `generate` is the loosest deliberately: "build me a task app" is a complete
 * request even though it names no file and no command. Asking for more detail
 * there would interrogate someone who has already said what they want, which
 * is its own failure.
 */
function targetFor(kind: ActionKind, original: string, text: string, hasFileTarget: boolean): boolean {
  switch (kind) {
    case "read":
    case "write":
      return hasFileTarget;
    case "execute":
      return commandPatterns.some((pattern) => pattern.test(original));
    case "check":
      // A named script is enough on its own - `npm test` says where by saying
      // what. Otherwise it needs a project.
      return commandPatterns.some((pattern) => pattern.test(original))
        || projectPatterns.some((pattern) => pattern.test(original));
    case "generate":
      // Anything beyond the bare verb. "build me an app" alone is too little;
      // "build me a task app" is enough to start.
      return text.replace(/^(?:build|make|create|generate|write)\s+(?:me\s+)?(?:an?\s+)?/, "").trim().length > 3;
  }
}
