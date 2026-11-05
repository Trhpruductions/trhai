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
//   - until one of the tools has run, only that family is offered, and the engine is told a call is
//     required (tool_choice), which it enforces with a grammar: the model cannot answer in words instead;
//   - for the whole turn the general file writers and the shell are out of reach, unless the request
//     names a file of its own, so a request for one thing cannot write over another;
//   - a reply with none of the family having run does not get to say it was done.
//
// What counts is decided by the same intent checks that offer each family, so nothing new is matched here.

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

/** What to offer this round. `forced` is whether the engine should be told a call is required. */
export function narrowForAction<T extends { function: { name: string } }>(
  offered: T[],
  family: ActionFamily,
  acted: boolean,
  /** The request names a file of its own: once the action is done, writing that file is still part of what was asked. */
  namesAFile = false
): { tools: T[]; forced: boolean } {
  if (!acted) {
    const fromTheFamily = offered.filter((definition) => family.tools.includes(definition.function.name) || family.lookups.includes(definition.function.name));
    // None of them on offer, as in a turn that may not write: nothing to require.
    if (fromTheFamily.some((definition) => family.tools.includes(definition.function.name))) return { tools: fromTheFamily, forced: true };
  }
  return { tools: namesAFile ? offered : offered.filter((definition) => !generalWriters.has(definition.function.name)), forced: false };
}

/** Said instead of a claim, when the model would not act. Short, true, and something to do next. */
export const notDoneReply = "That did not get done: nothing was added, saved or changed. Please try asking again.";
