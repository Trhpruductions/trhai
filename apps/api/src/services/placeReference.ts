// "there", said outright.
//
// Found on the evaluation of 2 October, with both models: "What's the capital
// of Australia?" was answered "The capital of Australia is Canberra.", and the
// next message, "And roughly how many people live there?", got "Australia has
// a population of approximately 26 million people." The model had both turns
// in front of it (see recentTurns in agentLoop.ts) and took the place the
// question had named over the one its own answer had just given.
//
// A person reads "there" as the place last arrived at. So when the turn before
// asked for a place and its answer named exactly one, the model is told which
// place "there" is, the way resolveFilePronoun tells it which file "it" is.
//
// Only then. A wrong place stated as fact is worse than none, so everything
// here leans towards saying nothing: an answer that names two places, a
// question that was not asking for a place, a message that names a place of
// its own, an answer about files or code - each leaves the message as typed,
// and the model reads the conversation as it did before.

type Turn = { role: "user" | "assistant"; content: string };

/**
 * "there" that is no place: "there is", "is there a zoo", "hi there". These
 * are taken out before looking, so a "there" still left is somewhere.
 */
const thereOfNoPlace = new RegExp([
  // It only opens the clause: "there is", "there's", "there will be".
  String.raw`\bthere(?:['’](?:s|re|ll|d|ve)\b|\s+(?:is|are|was|were|will|would|can|could|should|might|may|must|seems?|appears?|exists?|remains?|isn['’]t|aren['’]t|wasn['’]t|weren['’]t|won['’]t)\b|\s+(?:has|have|had)\s+(?:been|to)\b)`,
  // The same, asked: "is there a zoo", "how many planets are there".
  String.raw`\b(?:is|are|was|were|will|would|can|could|should|might|may|must|isn['’]t|aren['’]t|wasn['’]t|weren['’]t|won['’]t)\s+there\b`,
  String.raw`\b(?:has|have|had)\s+there\s+been\b`,
  // Greetings and set phrases.
  String.raw`\b(?:hi|hello|hey|hiya|howdy|you)\s+there\b`,
  String.raw`\bthere\s+(?:you|we|it|they)\s+(?:go|are|is|were|was)\b`,
  String.raw`\bthere,?\s+there\b`,
  String.raw`\b(?:out|in|right|here\s+and|then\s+and|here\s+or)\s+there\b`
].join("|"), "gi");

function usesThereAsAPlace(message: string): boolean {
  return /\bthere\b/i.test(message.replace(thereOfNoPlace, " "));
}

/** The kinds of place a question can ask for by name: "which city", "what country". */
const placeKinds = "city|town|village|country|nation|state|province|county|island|continent|region|territory|place|planet|suburb|neighbou?rhood|borough|district";

const capitalOf = /\bcapital(?:\s+city)?\s+of\s+\S*\p{L}/iu;
const whichPlace = new RegExp(String.raw`\b(?:which|what)\b[^.?!\n]{0,60}?\b(?:${placeKinds})\b`, "i");
const whereToGo = /\bwhere\s+(?:should|can|could|would|do|did|will|shall|might)\s+(?:i|we|you|one|they|people)\b/i;
/** A question that ends on its preposition: "which state is Chicago in?", "which country is Canberra the capital of?". */
const endsOnAPreposition = /\b(?:in|on|at|of|from)\s*\??\s*$/i;

/**
 * A question that asks for a place, so that the place its answer names is
 * where the conversation now is: "the capital of ...", "which city hosted
 * ...", "where should I go ...".
 *
 * Not a question about where a named thing is - "where is the Eiffel Tower?",
 * "which state is Chicago in?". There the thing asked about is still the
 * subject, and a "there" that follows may as well mean it as the place the
 * answer gave. Which of the two is not something to state as fact.
 */
function asksForAPlace(question: string): boolean {
  const text = question.trim();
  if (capitalOf.test(text) || whereToGo.test(text)) return true;
  return whichPlace.test(text) && !endsOnAPreposition.test(text);
}

/** Files, code and addresses: a conversation about those is not about places. */
const technical = /`|[\\/]|\b[\w-]+\.[a-z]{1,5}\b/;

/**
 * Words that open a sentence with a capital and name nothing. A capital at the
 * head of a sentence says only that a sentence began. A word outside this list
 * is taken for a name there, which at worst means one name too many, and so
 * nothing said.
 */
const openers = new Set((
  "a an the this that these those it its it's i i'm i'd i've i'll we we're you you're your they they're their he she his her my our there here "
  + "and but or so if when while although though because since after before as at by for from in into of on to with within without about around over under "
  + "what what's which who who's whom whose where where's when why how how's is are was were am be been do does did has have had can could should would will may might must shall "
  + "yes no not sure certainly absolutely ok okay well right great good fine thanks thank sorry hello hi hey please "
  + "wow oh ah hmm huh cool nice neat interesting awesome amazing alright yeah yep nope really got gotcha "
  + "currently actually basically generally typically usually officially technically historically today now then also additionally however therefore thus hence meanwhile overall "
  + "approximately roughly nearly almost just only still already maybe perhaps probably unfortunately "
  + "according based located known note fun many most some all both each every few several one two three "
  + "tell give show list name explain describe find get let make say try check visit use open see go look ask search consider call contact head take read click select choose run"
).split(/\s+/));

/** Capitalised words that name nothing a "there" could be. */
const notNames = new Set((
  "january february march april may june july august september october november december "
  + "monday tuesday wednesday thursday friday saturday sunday ok ai i'm i'd i've i'll"
).split(/\s+/));

const nameWord = String.raw`\p{Lu}[\p{L}\p{M}'’-]*`;
/** A name: capitalised words and the small words names are joined by - "Rio de Janeiro", "St. Louis", "Washington, D.C.". */
const namePattern = new RegExp(
  String.raw`(?:(?:St|Mt|Ft)\.\s+)?${nameWord}(?:\s+(?:(?:of|the|de|del|la|le|los|las|di|da|du|van|von|der|el|al|do|dos|upon)\s+)*${nameWord})*(?:,\s+(?:\p{Lu}\.){2,})?`,
  "gu"
);

const plain = (word: string) => word.toLowerCase().replace(/’/g, "'");

type Name = {
  name: string;
  /** Where it starts and ends in the text. */
  at: number;
  end: number;
  /** Nothing but opening words stands between the head of its sentence and it. */
  opensItsSentence: boolean;
};

/** Whether the words from the head of the sentence up to `at` are all openers ("Yes, ", "Well, the "). */
function nothingButOpenersBefore(text: string, at: number): boolean {
  const lead = text.slice(0, at).split(/[.!?:;]\s+|\n/).pop() ?? "";
  return (lead.match(/[\p{L}\p{N}'’-]+/gu) ?? []).every((word) => openers.has(plain(word)));
}

/** The names in `text`, in order, with any words that only open a sentence taken off the front. */
function namesIn(text: string): Name[] {
  const found: Name[] = [];
  for (const match of text.matchAll(namePattern)) {
    const opensItsSentence = nothingButOpenersBefore(text, match.index);
    const words = [...match[0].matchAll(/\S+/g)];
    let first = 0;
    if (opensItsSentence) {
      // "The United States", "In Paris", "It's Canberra": the capital on the first word is the sentence's, not a name's.
      while (first < words.length && openers.has(plain(words[first][0]))) first += 1;
      // A joining word that leaves in front ("the", "of") goes with it.
      while (first < words.length && !/^\p{Lu}/u.test(words[first][0])) first += 1;
    }
    if (first >= words.length) continue;
    const at = match.index + words[first].index;
    const end = match.index + match[0].length;
    const name = text.slice(at, end).replace(/\s+/g, " ").replace(/['’]s$/u, "");
    if (notNames.has(plain(name)) || /^\p{Lu}$/u.test(name)) continue;
    found.push({ name, at, end, opensItsSentence });
  }
  return found;
}

/** Just before the thing asked for: "is Canberra", "in Paris", "it's the Hague", "I'd suggest Lisbon". */
const leadsToTheAnswer =
  /(?:\b(?:is|was|are|were|be|in|at|to|near|called|named|suggest|recommend|choose|pick|try|visit|consider)|['’]s)\s+(?:the\s+)?["'“‘*_]*$/i;

/**
 * Whether a name stands where an answer puts the thing asked for - after "is"
 * or "in", or at the head of its sentence ("Canberra is the capital",
 * "Canberra.") - rather than being a name the answer mentions on the way:
 * "founded by Arthur Phillip", "under Prime Minister Bruce".
 */
function standsAsTheAnswer(answer: string, found: Name): boolean {
  return found.opensItsSentence || leadsToTheAnswer.test(answer.slice(0, found.at));
}

/** Whether the question already had this name, in this or another form ("Australia" for "Australian"). */
function wasInTheQuestion(asking: string, name: string): boolean {
  const wanted = plain(name);
  if (asking.includes(wanted)) return true;
  if (/\s/.test(wanted)) return false;
  return (asking.match(/[\p{L}]{4,}/gu) ?? []).some((word) => wanted.startsWith(word) || (wanted.length >= 4 && word.startsWith(wanted)));
}

/**
 * Which place "there" is in `request`, when the turn before settles it, with
 * the note that tells the model so. Null when nothing is certain enough to say.
 *
 * `conversation` is the turns so far. It may end with the message being
 * answered (in any of the wordings in `asked`), which is not the turn before.
 */
export function resolvePlaceReference(
  request: string,
  conversation: Turn[] | undefined,
  asked: string[] = []
): { place: string; note: string } | null {
  if (!usesThereAsAPlace(request)) return null;
  // A place named in the message itself is the likelier "there": "I went to Perth last year. How many people live there?"
  if (technical.test(request) || namesIn(request).length > 0) return null;

  const turns = (conversation ?? []).filter((turn) => turn.content.trim().length > 0);
  const current = new Set([request, ...asked].map((entry) => entry.trim()).filter(Boolean));
  while (turns.length > 0 && turns[turns.length - 1].role === "user" && current.has(turns[turns.length - 1].content.trim())) {
    turns.pop();
  }
  const answer = turns[turns.length - 1];
  const question = turns[turns.length - 2];
  if (answer?.role !== "assistant" || question?.role !== "user") return null;
  if (!asksForAPlace(question.content)) return null;
  if (technical.test(question.content) || technical.test(answer.content)) return null;

  // What the answer names that the question had not: the place it arrived at.
  const asking = plain(question.content);
  const given = namesIn(answer.content).filter((found) => !wasInTheQuestion(asking, found.name));
  if (new Set(given.map((found) => plain(found.name))).size !== 1) return null;
  if (!given.some((found) => standsAsTheAnswer(answer.content, found))) return null;

  const place = given[0].name;
  return { place, note: `("there" is ${place}, the place the previous answer gave.)` };
}
