import {
  mentionsScheduling, wantsAFileMade, wantsAPresentationMade, wantsASpreadsheetMade, wantsCalendar, wantsMediaConverted,
  wantsSpeechFile, wantsTodo, wantsTranscript
} from "./actionIntent.js";

// When a request plainly asks for one kind of thing to be done, that thing gets done.
//
// Measured on the graphics card on 2026-11-05, in 0.1.10: the coder model answered "add buy milk to my
// to-do list" with "Task added", "remind me tomorrow at 3 pm to call the bank" with "Reminder added" and
// a calendar request with "Event added", and called no tool for any of them, so nothing happened. Asked
// for an audio file, it overwrote notes.txt instead. Telling the model what to do does not reach that far.
//
// So the request decides, in three steps the agent loop takes:
//   - until one of the tools has run, only that family is offered, which on the card is enough for the
//     model to call one;
//   - for the whole turn the general file writers and the shell are out of reach, unless the request
//     names a file of its own, so a request for one thing cannot write over another;
//   - a reply with none of the family having run does not get to say it was done.
//
// What counts is decided by the same intent checks that offer each family, so nothing new is matched here.
//
// Not tool_choice: "required". Tried on the card on 2026-11-05: this model writes its call as text in a
// ```json fence, which that setting's grammar does not take as a call, and the grammar will not let the
// reply end without one. It wrote 22,000 tokens of "let me know" before the run was stopped. With the same
// narrowed tools and no such setting, it wrote the call and stopped in a second.

export type ActionFamily = {
  /** Any of these having run, well or not, means the request was acted on: what it said is the answer. */
  tools: readonly string[];
  /** What it may need first, and which do not count as having acted. */
  lookups: readonly string[];
};

const moment = ["current_datetime"];

export function actionAskedFor(question: string): ActionFamily | null {
  const text = question ?? "";
  // A reminder that is not for the to-do list is a schedule (see wantsTodo).
  if (/\bremind\s+me\b/i.test(text) && !wantsTodo(text) && mentionsScheduling(text)) return { tools: ["add_schedule"], lookups: moment };
  if (wantsCalendar(text)) return { tools: ["list_events", "add_event", "remove_event"], lookups: moment };
  if (wantsTodo(text)) return { tools: ["list_tasks", "add_task", "complete_task", "remove_task"], lookups: [] };
  if (wantsTranscript(text)) return { tools: ["transcribe_file"], lookups: [] };
  if (wantsSpeechFile(text)) return { tools: ["speak_to_file"], lookups: [] };
  if (wantsMediaConverted(text)) return { tools: ["convert_media"], lookups: [] };
  // Which kind of file is the model's to judge when the words fit more than one: "a Word document of the
  // budget meeting" also reads as a spreadsheet. A file is what was asked for either way.
  const makers = [
    ...(wantsAPresentationMade(text) ? ["make_presentation"] : []),
    ...(wantsASpreadsheetMade(text) ? ["make_spreadsheet"] : []),
    ...(wantsAFileMade(text) ? ["make_document"] : [])
  ];
  return makers.length > 0 ? { tools: makers, lookups: [] } : null;
}

/** The tools that could write over something the request did not name, or run anything at all. */
const generalWriters = new Set(["write_file", "edit_file", "build_app", "change_app", "plan_app", "run_command", "write_document", "update_document", "delete_document"]);

/** Whether the turn has acted on the request: one of the family ran, well or not. */
export function actedOn(family: ActionFamily, toolsUsed: ReadonlyArray<{ name: string }>): boolean {
  return toolsUsed.some((used) => family.tools.includes(used.name));
}

/** What to offer this round. `onlyTheFamily` is whether the offer was cut down to the family, so a reply with none of it run is not done. */
export function narrowForAction<T extends { function: { name: string } }>(
  offered: T[],
  family: ActionFamily,
  acted: boolean,
  /** The request names a file of its own: once the action is done, writing that file is still part of what was asked. */
  namesAFile = false
): { tools: T[]; onlyTheFamily: boolean } {
  if (!acted) {
    const fromTheFamily = offered.filter((definition) => family.tools.includes(definition.function.name) || family.lookups.includes(definition.function.name));
    // None of them on offer, as in a turn that may not write: nothing to require.
    if (fromTheFamily.some((definition) => family.tools.includes(definition.function.name))) return { tools: fromTheFamily, onlyTheFamily: true };
  }
  return { tools: namesAFile ? offered : offered.filter((definition) => !generalWriters.has(definition.function.name)), onlyTheFamily: false };
}

/**
 * A plain question about the list or the calendar that the model would not act on is read for it: the
 * read takes no arguments, so the app can run it as well as the model can. On the card the 4B model
 * answered one "what's on my to-do list?" in twenty with no call; the list is the answer either way.
 * Null for anything that changes something, which stays the model's to do or to be told it did not.
 */
export function readInstead(family: ActionFamily, question: string): string | null {
  const text = question ?? "";
  if (/\b(?:add|put|remind|remove|delete|cancel|tick|complete|done|mark|finish|clear|move|change|rename)\b/i.test(text)) return null;
  if (!/\b(?:what|which|show|list|read|tell|anything|something|have i|do i|is there|are there|how many|when)\b/i.test(text)) return null;
  for (const reader of ["list_tasks", "list_events"]) if (family.tools.includes(reader)) return reader;
  return null;
}

/**
 * The assistant's own name in its reply. The coder model, told in its prompt that it is TRH AI, still
 * opened "hello, how are you?" with "I'm Claude" on the card (2026-11-16); the words in which a model
 * names itself are the one claim here that is always false, so they are put right.
 */
export function inOwnName(text: string): string {
  return text.replace(/\b(I(?:'m| am)|this is|my name is)\s+(?:Claude|ChatGPT|GPT-?4o?|Gemini|Copilot|Llama|Qwen)\b(?:,?\s+an? AI (?:assistant|model)(?: (?:made|developed|created|trained) by [A-Z]\w*)?)?/gi, "$1 TRH AI");
}

/** Said instead of a claim, when the model would not act. Short, true, and something to do next. */
export const notDoneReply = "That did not get done: nothing was read, added, saved or changed. Please try asking again.";
