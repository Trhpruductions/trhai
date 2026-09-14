// The user's own spelling, before it reaches a classifier.
//
// "buld me a smal app that trakcs my gym visits" was answered "Got it." - the
// verb "buld" matched nothing, so the request was read as a statement and
// absorbed as a fact. Every message in this project's history is typed this
// way, and a classifier that only recognises dictionary spellings is one that
// fails the person it is built for.
//
// An alias table rather than edit distance: distance-1 against a verb list
// would turn "bold" into "build" and "creak" into "create". These are the
// misspellings actually seen, plus the obvious neighbours of each. Add to it
// when a real one turns up; do not generalise it.
//
// Applied only to the two classifiers. The user's words are not rewritten in
// the transcript, and the model sees what was typed.

const aliases: Record<string, string> = {
  buld: "build", bulid: "build", biuld: "build", bild: "build", buidl: "build",
  creat: "create", craete: "create", craet: "create", cerate: "create",
  mkae: "make", maek: "make",
  edti: "edit", edt: "edit",
  delet: "delete", delte: "delete", dleete: "delete",
  updte: "update", updaet: "update", udpate: "update",
  fxi: "fix", fiz: "fix",
  wrtie: "write", wirte: "write", wriet: "write",
  rmeove: "remove", remvoe: "remove",
  remeber: "remember", rember: "remember", rmember: "remember", remmber: "remember",
  forgte: "forget", foget: "forget", forgett: "forget", fogret: "forget", forgert: "forget",
  trakcs: "tracks", trakc: "track", tracsk: "tracks", trak: "track",
  smal: "small", waht: "what", teh: "the", adn: "and", thta: "that", taht: "that",
  wiht: "with", jsut: "just", plese: "please", pleas: "please", aswell: "as well",
  shwo: "show", sohw: "show", raed: "read", opne: "open", lsit: "list", serach: "search"
};

/** Correct known misspellings, word by word, keeping punctuation in place. */
export function normalizeSpelling(text: string): string {
  return text.split(" ").map((word) => {
    let end = word.length;
    while (end > 0 && !/[a-z']/i.test(word[end - 1])) end -= 1;
    const core = word.slice(0, end);
    const tail = word.slice(end);
    const fixed = aliases[core.toLowerCase()];
    return fixed === undefined ? word : fixed + tail;
  }).join(" ");
}
