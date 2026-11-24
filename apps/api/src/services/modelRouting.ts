import { isExplanatoryQuestion, mentionsAnImage, mentionsWeb, wantsSomethingBuilt, wantsWebSearch } from "./actionIntent.js";
import { isCodeWork } from "./machinePaths.js";
import { isModelOrSize } from "./modelEngine.js";
import { hasRoomForSevenB, readHardware, type Hardware } from "./modelSetup.js";
import { actionAskedFor } from "./requiredAction.js";

// The right model for the task, out of the models this PC has.
//
// The owner's brief of 2026-11-23: do not put every request to the same model. A quick question
// goes to a fast model, a hard one to a model that reasons, code and tools to the coder, pictures
// to the model that sees, writing to the one that writes best; switch by itself, keep the
// conversation (it lives in the API, not in the model, so a switch costs a load and nothing else),
// never spend a big model on a small question, never save a small one by giving a worse answer,
// fall back when a model will not load, and leave a model a person chose alone.
//
// Everything here runs on this PC through one engine, which holds one model at a time on an 8 GB
// card, so a switch is a load of some seconds. That shapes two rules below: a model already loaded
// is kept for a task any model does well, and a model the PC has no room for is not tried first.
//
// What each model is good for is what was measured, not what its name promises: the coder calls
// tools best of the chat models (84% of 54 tasks; docs/23), the 4B picture model calls every tool
// and reads pictures (20 of 21 on the card, docs/21), the Qwen3 4B instruct is the small fast one,
// and Qwen3 8B is the one of these that thinks before it answers (its reasoning goes to
// reasoning_content; modelEngine.ts). None of them is trained for research or writing in
// particular: research is tool work (fetching, reading), and writing goes to the model that talks
// best in general rather than the one tuned on code.

export type TaskKind = "pictures" | "code" | "actions" | "research" | "creative" | "reasoning" | "quick" | "general";

export type Routing = {
  kind: TaskKind;
  /** Why, in a few words a person can read under the reply. */
  reason: string;
};

const creativeWords = /\b(?:write|draft|compose|come up with|brainstorm|invent|make up|suggest|pitch)\b[^.?!\n]{0,40}\b(?:story|stories|poem|poems|song|lyrics|verse|essay|blog|article|post|caption|captions|script|speech|toast|joke|jokes|tagline|slogan|slogans|names?|titles?|ideas?|headline|bio|letter|email|message|intro|outline|description|copy)\b|\b(?:brainstorm|rewrite|reword|rephrase|paraphrase|proofread|edit this|make (?:it|this) (?:sound|read|shorter|longer|funnier|more))\b/i;
const reasoningWords = /\b(?:analy[sz]e|analysis|compare|comparison|pros and cons|trade-?offs?|weigh|evaluate|assess|critique|review this|should (?:i|we) (?:choose|pick|use|go with)|which (?:is|would be) (?:better|best)|why (?:does|do|is|are|did|would)|what would happen if|step by step|work (?:it|this) out|prove|derive|reason(?:ing)? (?:about|through)|think (?:it |this )?through|strategy|strategi[sz]e|plan (?:for|out)|root cause|diagnos[ei]|troubleshoot|explain in (?:depth|detail)|in detail|thoroughly|implications?|consequences)\b/i;
const researchWords = /\b(?:research|look (?:it |this |that )?up|find out|find (?:me )?(?:sources?|references?|papers?|studies|articles?)|cite|citations?|sources?|what (?:is|are) the latest|latest (?:news|version|release)|news (?:on|about)|documentation|docs? (?:for|on)|read the docs|according to|check (?:online|the web|the internet)|search (?:for|the web)|gather (?:information|info)|background on)\b/i;
/** Code work isCodeWork does not catch: a file named by its extension, or the words of programming. */
const codeWords = /\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|cs|cpp|cc|c|h|hpp|css|scss|html|json|ya?ml|toml|sql|sh|ps1|bat)\b|\b(?:bug|debug|debugging|refactor|compile|compiler|stack ?trace|exception|null pointer|segfault|regex|sql|query|endpoint|typescript|javascript|python|rust|golang|c\+\+|c#|html|css|react|node\.?js|npm|docker|kubernetes|git|commit|merge conflict|pull request|unit tests?|tests? (?:fail|failing|pass)|lint|linter|dependency|package\.json|source code|codebase|function|class|variable|array|loop|algorithm)\b/i;
const quickLength = 80;
const longRequest = 600;

/** Which kind of task a request is, from its words alone, so the model that suits it answers. */
export function taskKindFor(request: string, context: { mode?: string; hasImage?: boolean } = {}): Routing {
  const text = (request ?? "").trim();
  if (context.hasImage || mentionsAnImage(text)) return { kind: "pictures", reason: "a picture to look at" };
  if (isCodeWork(context.mode ?? "general", text) || wantsSomethingBuilt(text) || codeWords.test(text)) return { kind: "code", reason: "code" };
  if (actionAskedFor(text)) return { kind: "actions", reason: "something to do with a tool" };
  if (wantsWebSearch(text) || mentionsWeb(text) || researchWords.test(text)) return { kind: "research", reason: "looking things up" };
  if (creativeWords.test(text)) return { kind: "creative", reason: "writing" };
  if (reasoningWords.test(text) || text.length >= longRequest) return { kind: "reasoning", reason: text.length >= longRequest ? "a long request" : "reasoning" };
  // Short, and none of the above: a greeting, a fact, a sum, a small ask. "Why" and "compare" were caught above.
  if (text.length <= quickLength) return { kind: "quick", reason: "a quick one" };
  return { kind: "general", reason: isExplanatoryQuestion(text) ? "an explanation" : "a general question" };
}

// The models that suit each kind, best first, by the ids in modelSetup.ts's catalogue. A size or a
// spelling of each is matched the way the rest of the app matches models (isModelOrSize).
const fast = ["qwen3-4b-instruct-2507-abliterated", "qwen3-4b-instruct-2507", "qwen3-vl-4b-abliterated", "qwen2.5-3b"];
const coders = ["qwen2.5-coder-7b-abliterated", "qwen2.5-coder-7b", "qwen3-vl-4b-abliterated", "qwen3-vl-8b-abliterated"];
const thinkers = ["qwen3-8b", "qwen2.5-coder-7b-abliterated", "qwen3-vl-8b-abliterated", "qwen2.5-coder-7b"];
const writers = ["qwen3-8b", "qwen3-4b-instruct-2507-abliterated", "qwen3-vl-8b-abliterated", "qwen3-vl-4b-abliterated", "qwen3-4b-instruct-2507"];
const seers = ["qwen3-vl-8b-abliterated", "qwen3-vl-4b-abliterated", "qwen2.5-vl-7b", "qwen2.5-vl-3b"];
/** The models that want a card with 8 GB or 16 GB of memory (the catalogue's "needs"): tried first only where there is room. */
const big = /^(?:qwen2\.5-coder-7b|qwen3-8b|qwen3-vl-8b|qwen2\.5-vl-7b)/i;

let hardwareRead: Hardware | null = null;

/** This PC, read once: the reading runs nvidia-smi, and a card does not come or go between questions. */
export function knownHardware(read: () => Hardware = readHardware): Hardware {
  hardwareRead ??= read();
  return hardwareRead;
}

export function forgetHardwareForTests(): void {
  hardwareRead = null;
}

/** Whether a task is one any talking model does well, so a model already loaded is kept rather than swapped. */
export function anyModelWillDo(kind: TaskKind): boolean {
  return kind === "quick" || kind === "general";
}

function preferencesFor(kind: TaskKind): string[] {
  switch (kind) {
    case "pictures": return [...seers, ...coders];
    case "code": case "actions": case "research": return [...coders, ...fast];
    case "reasoning": return [...thinkers, ...fast];
    case "creative": return [...writers, ...coders];
    case "quick": return [...fast, ...coders];
    case "general": return [...coders, ...fast];
  }
}

/**
 * The installed models to try for a task, best first, then every other installed model as a fallback.
 *
 * - `hardware`: a model the PC has no room for is not tried first; it stays at the end, for a PC whose
 *   reading of itself is wrong.
 * - `loaded`: for a task any model does well, a loaded model that is at all suitable goes first, because
 *   a swap is seconds of loading for no better answer. A specialist task swaps.
 * - `pinned`: a model the person chose (TRHAI_MODEL, or the conversation's own pick) goes first, always.
 */
export function modelOrderFor(
  kind: TaskKind,
  installed: string[],
  options: { hardware?: Hardware | null; loaded?: string[]; pinned?: string } = {}
): string[] {
  const room = options.hardware ? hasRoomForSevenB(options.hardware) : true;
  const ordered: string[] = [];
  const take = (name: string | undefined) => { if (name && !ordered.includes(name)) ordered.push(name); };
  const find = (preference: string) => installed.find((name) => isModelOrSize(preference, name));

  take(options.pinned && installed.includes(options.pinned) ? options.pinned : undefined);
  const preferences = preferencesFor(kind);
  const fitting = preferences.filter((preference) => room || !big.test(preference));
  if (anyModelWillDo(kind)) {
    const suitable = new Set(fitting.map(find).filter((name): name is string => Boolean(name)));
    for (const name of options.loaded ?? []) if (suitable.has(name)) take(name);
  }
  for (const preference of fitting) take(find(preference));
  for (const preference of preferences) take(find(preference));
  for (const name of installed) take(name);
  return ordered;
}
