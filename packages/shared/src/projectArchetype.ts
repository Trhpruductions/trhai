// Which of the two templates a request is actually asking for, if either.
//
// planProject always produced a records app, because entity extraction always
// finds a noun. "Build me a snake game" yielded an entity called `game` and a
// REST API to store them in; "a password generator" yielded `generator`. Both
// ran. Both passed their own smoke checks. Neither was remotely what was asked
// for, and nothing anywhere reported a problem - the failure was invisible
// precisely because the template always succeeds at being a template.
//
// So the question is asked the other way round now. A records app has to look
// like one before it gets the records template; anything that does not is
// handed to the model to write, which is slower and less predictable but has
// some chance of producing the thing requested.

export type Archetype = "calculator" | "records" | "authored";

/**
 * Verbs and phrases that mean "keep a list of things".
 *
 * Positive evidence, not the absence of something else: this is the whole
 * point of the change, so a request qualifies for the records template by
 * saying it wants records, never by failing to look like anything else.
 */
const recordVerbs = [
  "track", "tracker", "tracking",
  "keep a list", "keep track", "list of", "catalogue", "catalog",
  "manage", "manager", "inventory", "log ", "logger", "logbook",
  "database", "records", "record of", "crud", "directory of",
  "collection of", "library of", "register of", "roster"
];

/** Shapes with no records at all, whatever nouns the sentence contains. */
const calculatorPhrases = ["calculator", "calculate ", "work out the", "tip calc"];

/**
 * Things that *do* something, rather than hold a collection.
 *
 * These override field evidence, because field extraction fires on them
 * anyway and gets it wrong: "a snake game with a scoreboard" yields a field
 * called `scoreboard`, and "a unit converter for miles and kilometres" invents
 * relations called `mileId` and `kilometreId`. Read as data those look exactly
 * like a real record; read as English, nobody asking for a converter wants a
 * REST API storing converters.
 *
 * The list only has to cover words that appear alongside that false field
 * evidence. Anything unrecognised already falls through to authored.
 */
const artifactNouns = [
  "game", "timer", "stopwatch", "clock", "alarm",
  "generator", "converter", "machine", "simulator", "emulator",
  "editor", "player", "visualiser", "visualizer", "animation",
  "quiz", "puzzle", "maze", "typing test", "speed test",
  "paint", "drawing", "canvas", "synth", "sequencer", "metronome",

  // The verb forms of the same things.
  //
  // Matching is plain substring, so "converter" above never matched "converts"
  // - and "an app that converts celsius to fahrenheit" therefore fell through
  // to records. It extracted "celsius" as an entity and built a CRUD store for
  // celsius records: six files, twenty-five checks passed, a page titled
  // "Celsius to Fahrenheit" and nothing anywhere that converts anything.
  //
  // Deliberately the computing verbs rather than every verb. Converting and
  // translating are transformations of a value the user supplies; "track",
  // "store" and "manage" are about keeping things, and those belong to records.
  "converts", "convert ", "converting",
  "translates", "translate ", "translating"
];

/**
 * A request naming fields - "tickets have a title, status and priority" - is
 * describing the columns of a record.
 *
 * Both "with" and "have/has" count: the first version of this list checked only
 * for "with a", and a support desk whose tickets *have* a title, status and
 * priority was sent to be written from scratch when the records template was
 * exactly right for it.
 */
const fieldPhrases = [
  "with fields", "fields:", "columns",
  "with a ", "with the ", "with title", "with name",
  "have a ", "has a ", "have the ", "has the ",
  "each with", "containing"
];

function saysAnyOf(request: string, phrases: string[]): boolean {
  const text = ` ${request.toLowerCase()} `;
  return phrases.some((phrase) => text.includes(phrase));
}

export function classifyRequest(request: string, hasNamedFields: boolean): Archetype {
  if (saysAnyOf(request, calculatorPhrases)) return "calculator";

  // Checked before any record evidence: what is being built decides this, and
  // a game with a scoreboard is still a game.
  if (saysAnyOf(request, artifactNouns)) return "authored";

  // Either the request says it wants to keep things, or it describes the shape
  // of the thing being kept. Both are direct evidence of a records app.
  if (saysAnyOf(request, recordVerbs)) return "records";
  if (hasNamedFields && saysAnyOf(request, fieldPhrases)) return "records";

  return "authored";
}
