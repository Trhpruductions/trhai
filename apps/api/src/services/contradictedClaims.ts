// Replies that contradict what actually happened.
//
// The mirror of fabricated success, and just as damaging. Asked to read a file
// and edit it, the model called read_file twice, both calls succeeded, and it
// then answered:
//
//   "the tool refused to read the file because it is located on the local
//    machine, and I do not have permission to access it"
//
// Nothing had refused anything. The execution trace showed two ticks. The user
// was told the app could not do something it had just done, which sends them
// off to fix a permission problem that does not exist.
//
// Action enforcement cannot catch this: a tool did run, so the loop is right
// not to force a retry. This is a different question - not "did anything
// happen" but "does the reply agree with what happened".
//
// Only claims about the tools are checked. The app knows exactly whether its
// own calls succeeded, so a reply saying they did not is checkable against
// something better than another model's opinion.

/**
 * Phrasings that assert a tool was refused or could not run.
 *
 * Deliberately about the tool, not about permissions in general. "run_command
 * needs your confirmation" is a true statement about the permission ladder and
 * must not be caught; "I could not read the file" after a successful read is
 * the failure this exists for.
 */
const claimsToolFailed = new RegExp(
  [
    "the tool (?:refused|failed|could ?n[o']t|was unable)",
    "(?:i|it) (?:do|does|did) ?n[o']t have (?:permission|access)",
    "(?:i|we) (?:could ?n[o']t|can ?n[o']t|was unable to|am unable to) (?:read|open|access|list|edit|write)",
    "(?:access|permission) (?:was )?denied",
    "(?:i )?(?:do ?n[o']t|does ?n[o']t) have the (?:necessary )?(?:permission|access|rights)",
    "no permission to (?:read|open|access|list|edit|write)"
  ].join("|"),
  "i"
);

export type ToolOutcomeLike = { name: string; ok: boolean };

/**
 * Whether the reply denies work that the record says succeeded.
 *
 * True only when tools ran, every one of them succeeded, and the reply still
 * says one was refused. If anything genuinely failed the claim may be accurate,
 * and this stays out of the way.
 */
export function contradictsToolRecord(text: string, toolsUsed: ToolOutcomeLike[]): boolean {
  if (toolsUsed.length === 0) return false;
  if (!toolsUsed.every((used) => used.ok)) return false;
  return claimsToolFailed.test(text);
}

/**
 * What to tell the model when its reply disagrees with the record.
 *
 * States the fact and asks for the answer again. Addressed to the model, since
 * that is who reads it, and specific about which calls succeeded so there is
 * nothing left to infer.
 */
export function correctionFor(toolsUsed: ToolOutcomeLike[]): string {
  const names = [...new Set(toolsUsed.map((used) => used.name))].join(", ");
  return `That is not what happened. ${names} ran successfully and returned the results above. `
    + "Nothing was refused and no permission was missing. Answer the user using those results, "
    + "and do not say a tool failed when it did not.";
}

/**
 * Past-tense claims that a file was changed.
 *
 * The other half of the same problem, and the more dangerous half. Asked to
 * read a file and edit it, the model called read_file, never called edit_file,
 * and answered "The edited code is saved as greet.js". The file was untouched.
 *
 * withMutationResults already covers the opposite case - a real change the
 * model forgot to mention gets appended - but nothing checked a change that was
 * mentioned and never made.
 *
 * Only past-tense completion counts. "I can edit that for you" is an offer and
 * must stay sayable; "the file saves your settings" is describing what a
 * program does, not claiming to have done something.
 */
/** Verbs that mean a file changed however they are phrased. */
const plainlyMutating = "edited|saved|written|wrote|created|updated|changed|modified|deleted|removed|renamed|overwrote|overwritten";

/**
 * Verbs that mean a change only when the object is a file or code.
 *
 * "I added a guard to the function" is a claim about a file. "I added two and
 * two" is arithmetic. Splitting these out keeps the second from being called a
 * lie, which matters because the penalty for a false positive here is replacing
 * a true answer with a false denial.
 */
const conditionallyMutating = "added|appended|inserted|applied|patched|implemented|replaced|fixed";

/** What those verbs have to be acting on before the claim counts. */
const codeObject =
  "file|files|code|script|module|function|method|class|clause|guard|check|line|lines|version|content|contents|[\\w.-]+\\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|txt|css|html|py|ps1|bat|sh|yml|yaml)";

const claimsMutationDone = new RegExp(
  [
    // "I've saved it", "we have created the file"
    `\\b(?:i(?:'ve| have)?|we(?:'ve| have)?) (?:just )?(?:now )?(?:${plainlyMutating})\\b`,
    // Same, but only when it is a file being acted on.
    `\\b(?:i(?:'ve| have)?|we(?:'ve| have)?) (?:just )?(?:now )?(?:${conditionallyMutating})\\b[^.!?]{0,60}\\b(?:${codeObject})\\b`,
    // "the file has been updated"
    `\\bhas been (?:${plainlyMutating})\\b`,
    `\\bhave been (?:${plainlyMutating})\\b`,
    // "it is now saved"
    `\\b(?:is|was|are|were) (?:now )?(?:${plainlyMutating})\\b`,
    // "the updated file is now available in the workspace" - seen live, and
    // missed by every pattern above because nothing in it is a mutation verb
    // in the past tense.
    `\\b(?:is|are) now (?:available|in place|live|ready)\\b`,
    `\\bsuccessfully (?:${plainlyMutating}|${conditionallyMutating})\\b`,
    `\\bthe (?:edited|updated|new|modified) (?:code|file|version|content) is\\b`
  ].join("|"),
  "i"
);

/**
 * Whether the reply says a file was changed when nothing changed one.
 *
 * `didMutate` is decided by the caller from the tools that actually ran, so
 * this stays a pure question about the text.
 */
export function claimsUnperformedMutation(text: string, didMutate: boolean): boolean {
  if (didMutate) return false;
  return claimsMutationDone.test(text);
}

/**
 * A change the model says it is about to make, at the end of its turn.
 *
 * The same failure in the future tense, and it survives the check above for
 * exactly that reason. Seen live: read_file succeeded, edit_file failed because
 * the model had misremembered the file's contents, and the reply ended
 *
 *   "I will now write the file with the changes."
 *
 * Then the turn ended. Nothing was written, nothing said so, and the last thing
 * the user read was a promise. Waiting does not help - there is no later.
 *
 * An offer is not a promise and must stay sayable, so anything conditional is
 * excluded: "I can edit that if you want" and "shall I update it?" are the
 * assistant behaving correctly when it needs a decision first.
 */
/**
 * The same verbs in the infinitive, which is what a promise uses.
 *
 * Kept separate rather than derived: the lists above are past-tense by design
 * ("I have updated"), and reusing them here silently failed on "I'll update" -
 * the single most common way of phrasing exactly what this is for.
 */
const aboutToMutate =
  "edit|save|write|create|update|change|modify|delete|remove|rename|overwrite"
  + "|add|append|insert|apply|patch|implement|replace|fix|make";

const promisesMutation = new RegExp(
  "\\b(?:i(?: will|'ll| am going to|'m going to)|let me|now i(?: will|'ll))"
  + " (?:now |go ahead and |just |quickly )?"
  + `(?:${aboutToMutate})\\b`,
  "i"
);

/** Wording that makes it an offer awaiting an answer rather than a commitment. */
const conditional = /\bif you(?:'d| would)?\b|\bwould you like\b|\bshall i\b|\blet me know\b|\bwant me to\b|\bjust say\b|\?\s*$/i;

/**
 * Whether the reply ends by promising a change that never came.
 *
 * Only meaningful at the end of a turn, which is where the caller applies it:
 * mid-turn the model saying "I'll edit it now" and then doing so is the normal,
 * correct sequence.
 */
export function promisesUnperformedMutation(text: string, didMutate: boolean): boolean {
  if (didMutate) return false;
  if (!promisesMutation.test(text)) return false;

  // Judged on the sentence that makes the promise, not the whole reply - a long
  // answer that ends "I'll update it now" is a promise even if it asked a
  // question three paragraphs earlier.
  const sentences = text.split(/(?<=[.!?])\s+/);
  const promising = sentences.filter((sentence) => promisesMutation.test(sentence));
  return promising.some((sentence) => !conditional.test(sentence));
}

/**
 * The model saying it used a tool when it used none.
 *
 * The simplest question in the app produced this. Asked "what is 2+2",
 * llama3.1:8b answered, in full:
 *
 *   "I used the `calculate` tool to evaluate the expression `2+2`."
 *
 * There is no calculate tool. No tool ran at all. And there is no answer in
 * there either - the user asked what two plus two is and was told about a tool
 * instead, one that does not exist.
 *
 * Checkable for the same reason the others are: whether this process dispatched
 * a tool is a fact it owns, not an opinion to weigh.
 */
/** This app's tool names, for recognising a claim that names one. */
const ownToolNames =
  "run_command|run_script|read_file|write_file|edit_file|list_files|build_app"
  + "|search_memory|search_documents|list_documents|read_document|remember|forget"
  + "|pin_memory|fetch_url|write_document|update_document|delete_document|current_datetime";

const claimsToolWasUsed = new RegExp(
  [
    // "I used the `calculate` tool", "I called read_file"
    "\\b(?:i|we) (?:just )?(?:used|called|invoked|ran|executed|queried)\\b[^.!?]{0,30}\\btool\\b",
    "\\b(?:i|we) (?:just )?(?:used|called|invoked|ran|executed) (?:the )?`?[a-z_]+`?(?:\\(\\))? tool\\b",
    // "using the search_memory tool, I found"
    "\\busing the `?[a-z_]+`? tool\\b",
    // "the calculate tool returned"
    "\\bthe `?[a-z_]+`? tool (?:returned|gave|reported|says?|found)\\b",
    // Bare tool names in the past tense, which is the same claim without the
    // word "tool" - anchored to this app's real names so ordinary prose about
    // remembering or finding something is untouched.
    `\\b(?:i|we) (?:just )?(?:used|called|invoked|ran) \`?(?:${ownToolNames})\`?\\b`
  ].join("|"),
  "i"
);

/**
 * Whether the reply claims a tool ran when none did.
 *
 * Only when nothing ran at all. If any tool ran, the model describing its work
 * is ordinary and possibly imprecise, and imprecision is not what this is for.
 */
export function claimsUnusedTool(text: string, toolsUsed: ToolOutcomeLike[]): boolean {
  if (toolsUsed.length > 0) return false;
  return claimsToolWasUsed.test(text);
}

/** What to tell the model when it credits a tool it never called. */
export const answerDirectly =
  "You did not call any tool, and there is no tool by that name. Do not say you used one. "
  + "Answer the user's question directly, in your own words, using what you already know.";

/** What to say when the model insists on a change it never made. */
export function noChangeWasMade(toolsUsed: ToolOutcomeLike[]): string {
  const ran = [...new Set(toolsUsed.map((used) => used.name))];
  const did = ran.length > 0 ? `I ran ${ran.join(" and ")}, but ` : "";
  return `${did}nothing was written. No file was created, edited, or deleted during this `
    + "attempt. Ask me again and I will make the change.";
}

/**
 * What to say when the claim is premature rather than false.
 *
 * A call held for confirmation leaves nothing written, so it looks identical to
 * "claimed a change and made none" from the mutation record alone. It is not the
 * same thing: the offer is still open and one "yes" completes it. Telling this
 * user "nothing was written, ask me again" would throw away a confirmation they
 * were one word from giving.
 */
export function pendingConfirmationNotice(tool: string): string {
  return `Nothing has been changed yet. ${tool} needs your confirmation before it runs - `
    + "say yes and I will go ahead.";
}
