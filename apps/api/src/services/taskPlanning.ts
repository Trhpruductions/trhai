// Task-specific planning.
//
// Plans used to be one template per mode with stemmed topic words injected, which
// produced lines like "Define the interface and data shape for revenue, report,
// dashboard". Two things were wrong: the subject was a bag of stemmed tokens
// rather than the phrase the user actually wrote, and every kind of work got the
// same three steps whether it was a new feature or a production incident.

export type TaskType =
  | "create"
  | "fix"
  | "integrate"
  | "migrate"
  | "test"
  | "deploy"
  | "design"
  | "document"
  | "analyze"
  | "generic";

export type PlanMode =
  | "general" | "build" | "code" | "debug" | "research" | "plan" | "coding" | "business" | "creator";

/** Leading phrases that frame a request but are not part of its subject. */
const requestPrefixes = [
  /^(?:please\s+)?(?:can|could|would)\s+you\s+(?:please\s+)?/i,
  /^(?:i|we)\s+(?:need|want|would\s+like)\s+(?:you\s+to\s+)?/i,
  /^help\s+(?:me|us)\s+(?:to\s+)?/i,
  /^let'?s\s+/i,
  /^(?:we|you)\s+should\s+/i,
  /^please\s+/i
];

/** Verbs that open a request; stripped so the subject is the thing, not the verb. */
const leadingVerbs = new Set([
  "build", "create", "make", "generate", "add", "write", "implement", "fix", "debug",
  "refactor", "design", "plan", "draft", "review", "test", "deploy", "set", "setup",
  "configure", "update", "remove", "delete", "explain", "summarize", "analyze",
  "compare", "list", "show", "find", "optimize", "migrate", "install", "run", "scaffold"
]);

const taskPatterns: Array<{ type: TaskType; pattern: RegExp }> = [
  { type: "fix", pattern: /\b(fix|bug|broken|failing|flaky|error|crash|regression|debug|incident|outage)\b/i },
  { type: "migrate", pattern: /\b(migrate|migration|port|upgrade|move\s+(?:to|off)|replace)\b/i },
  { type: "integrate", pattern: /\b(integrate|integration|connect|webhook|api\s+client|third[- ]party|sync\s+with)\b/i },
  { type: "test", pattern: /\b(test|tests|testing|coverage|spec|e2e)\b/i },
  { type: "deploy", pattern: /\b(deploy|deployment|release|ship|rollout|pipeline|ci\/cd)\b/i },
  { type: "document", pattern: /\b(document|documentation|docs|readme|runbook|guide)\b/i },
  { type: "analyze", pattern: /\b(analy[sz]e|investigate|research|compare|evaluate|benchmark|audit)\b/i },
  { type: "design", pattern: /\b(design|mockup|wireframe|branding|layout|visual|ux|ui)\b/i },
  { type: "create", pattern: /\b(build|create|add|implement|new|scaffold|generate|set\s+up)\b/i }
];

export function detectTaskType(message: string): TaskType {
  for (const candidate of taskPatterns) {
    if (candidate.pattern.test(message)) {
      return candidate.type;
    }
  }
  return "generic";
}

const maxSubjectWords = 12;
/** Below this a clause is too short to stand in for the request. */
const minSubjectWords = 2;

/**
 * Pronouns naming who the work is for, not what it is about: "build me a task
 * tracker" is about the tracker. Left in, they produced "for me a task tracker".
 */
const beneficiaryPronouns = new Set(["me", "us"]);

/**
 * Words that cannot end a subject without leaving it hanging. The subject is
 * dropped into the middle of a sentence, so a trailing "a" or "have" reads as a
 * truncation — which is exactly what it was.
 */
const danglingTailWords = new Set([
  "a", "an", "the", "and", "or", "but", "with", "without", "for", "to", "of",
  "in", "on", "at", "by", "from", "into", "that", "which", "where", "when",
  "have", "has", "had", "is", "are", "was", "were", "be", "being", "been",
  "so", "as", "than", "then", "plus", "per", "its", "their"
]);

function bareWord(word: string): string {
  return word.toLowerCase().replace(/[^a-z]/g, "");
}

function trimDanglingTail(words: string[]): string[] {
  const kept = [...words];
  while (kept.length > 1 && danglingTailWords.has(bareWord(kept[kept.length - 1]))) {
    kept.pop();
  }
  return kept;
}

/**
 * Keep the subject inside the word budget without cutting mid-phrase.
 *
 * A hard slice turned "...where projects have many tasks, tasks have a title,
 * status and due date" into "...tasks have a", which then read as
 * "what done looks like for ... tasks have a, and the smallest version".
 * Ending at a clause boundary keeps the phrase whole and usually shorter.
 */
function clampToClause(words: string[]): string[] {
  if (words.length <= maxSubjectWords) {
    return trimDanglingTail(words);
  }

  const limit = Math.min(maxSubjectWords, words.length);
  for (let i = minSubjectWords - 1; i < limit; i += 1) {
    if (words[i].endsWith(",")) {
      return trimDanglingTail(words.slice(0, i + 1));
    }
  }

  return trimDanglingTail(words.slice(0, maxSubjectWords));
}

/**
 * The phrase the user actually wrote, minus framing and the leading verb. Keeps
 * original wording so a plan reads back naturally instead of as stemmed tokens.
 */
export function extractSubject(message: string): string {
  let text = message.trim().replace(/[.!?]+$/, "");

  for (const prefix of requestPrefixes) {
    text = text.replace(prefix, "");
  }
  text = text.trim();

  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return "";
  }

  // Drop a leading imperative verb ("Build a dashboard" -> "a dashboard").
  const first = words[0].toLowerCase().replace(/[^a-z]/g, "");
  if (leadingVerbs.has(first) && words.length > 1) {
    words.shift();
    // "set up the pipeline" / "sign in flow" leave a dangling particle.
    if (words.length > 1 && /^(up|out|on|off)$/i.test(words[0])) {
      words.shift();
    }
    // "build me a task tracker" -> "a task tracker".
    if (words.length > 1 && beneficiaryPronouns.has(bareWord(words[0]))) {
      words.shift();
    }
  }

  const subject = clampToClause(words).join(" ").trim().replace(/,+$/, "");
  if (!subject) {
    return "";
  }

  // "a revenue dashboard" reads better as "the revenue dashboard" inside a step.
  return subject.replace(/^(a|an)\s+/i, "the ");
}

function stepsFor(taskType: TaskType, subject: string, mode: PlanMode): string[] {
  const it = subject || "this";

  switch (taskType) {
    case "fix":
      return [
        `Reproduce ${it} reliably — capture the exact error, the inputs, and the environment it happens in.`,
        "Narrow it to the smallest failing case before changing any code.",
        "Fix the root cause rather than the symptom, and note what the real cause turned out to be.",
        "Add a regression test that fails without the fix, so it cannot come back silently."
      ];

    case "migrate":
      return [
        `Inventory everything that depends on ${it}, including the paths you'd forget under pressure.`,
        "Get the old and new paths running side by side so you can compare real output.",
        "Move one slice, verify it, then repeat — never cut over everything at once.",
        "Keep a rollback that you have actually tested, not just written down."
      ];

    case "integrate":
      return [
        `Pin down the contract for ${it}: payloads, auth, rate limits, and error shapes.`,
        "Build against a recorded or stubbed response first so you are not debugging two systems at once.",
        "Handle the failure modes explicitly — timeouts, partial data, and retries that are safe to repeat.",
        "Log enough on both sides to reconstruct a failed exchange after the fact."
      ];

    case "test":
      return [
        `Decide what behaviour of ${it} actually matters, and write that down before writing assertions.`,
        "Cover the failure cases first; the happy path rarely breaks in production.",
        "Make each test fail for exactly one reason so a red run points somewhere specific.",
        "Confirm the test fails without the code under test — a test that cannot fail proves nothing."
      ];

    case "deploy":
      return [
        `Define what "working" means for ${it} and how you will observe it after release.`,
        "Rehearse the deploy end to end somewhere that is safe to break.",
        "Ship behind a flag or to a small slice first, and watch the signal before widening.",
        "Have the rollback ready and know who decides to use it."
      ];

    case "document":
      return [
        `Identify who reads ${it} and the one question they arrive with.`,
        "Lead with the working example; explain the reasoning underneath it.",
        "Document the failure modes and gotchas — that is what people search for.",
        "Verify every command and snippet by running it exactly as written."
      ];

    case "analyze":
      return [
        `State the decision ${it} needs to inform — analysis without a decision attached goes stale.`,
        "List the options honestly, including doing nothing.",
        "Compare them on the few criteria that actually matter here, not everything measurable.",
        "Write the recommendation and the evidence that would change it."
      ];

    case "design":
      return [
        `Define the audience for ${it} and the single outcome it should drive.`,
        "Establish the structure and hierarchy before any visual polish.",
        "Produce the asset list with review gates so feedback lands early.",
        "Check it against the constraints that bite: accessibility, responsive behaviour, and real content lengths."
      ];

    case "create":
      if (mode === "business") {
        return [
          `Define the outcome for ${it} and the single metric that proves it worked.`,
          "Break it into lanes with an owner and a decision checkpoint each.",
          "Name the biggest risk and the control that contains it.",
          "Sequence the first week so something ships before the plan drifts."
        ];
      }
      if (mode === "creator") {
        return [
          `Set the creative direction and audience for ${it}.`,
          "Produce the asset list with review gates.",
          "Draft the narrative hook before the polish.",
          "Package launch-ready deliverables with the formats you actually need."
        ];
      }
      return [
        `Write down what done looks like for ${it}, and the smallest version that delivers it.`,
        "Settle the data shape and interface before writing implementation code.",
        "Build one slice end to end so integration problems surface early.",
        "Add tests for the failure cases, then extend to the rest."
      ];

    default:
      return [
        `Clarify the end state for ${it} and how you will know you got there.`,
        "Identify the highest-impact next move and what currently blocks it.",
        "Do the smallest useful piece today rather than planning the whole thing.",
        "Note what you learned so the next step is better informed."
      ];
  }
}

export type TaskPlan = {
  taskType: TaskType;
  subject: string;
  steps: string[];
};

export function buildTaskPlan(message: string, mode: PlanMode): TaskPlan {
  const subject = extractSubject(message);
  const taskType = detectTaskType(message);
  return { taskType, subject, steps: stepsFor(taskType, subject, mode) };
}
