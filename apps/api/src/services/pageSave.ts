// Saving a page keeps the page.
//
// Found live on 4 October, on the 7B: "fetch https://example.com and save it
// to example.html". The page was fetched and a file was written - holding
// "<html></html>", thirteen characters - and the reply said "example.html has
// been created in the workspace with the content from "Example Domain"". The
// model is shown a page's text, cut to a few thousand characters. To save the
// page it would have to type it out again, and it typed a stub and called it
// done.
//
// Nothing about the request needs a model. It names an address and a file, and
// what goes in the file is what the address serves. So a request that says
// only that - fetch this, keep it there - is carried out exactly (see
// resolveSavePage in orchestrator.ts), and the reply says what was written.
//
// Only that. A request that asks for anything more ("save a summary of ...",
// "save the title to ...", "the first paragraph") has a word in it that is not
// about fetching or keeping, and goes to the model as before.

import { extractReadableText, type RawFetchOutcome } from "./webFetch.js";

export type PageToKeep = {
  url: string;
  file: string;
  /** The page as it is served, or the text a reader would read on it. */
  as: "page" | "text";
};

const webAddress = /\bhttps?:\/\/[^\s"'<>]+/i;

/** Where it is to be kept: "to example.html", "as notes.txt", "into D:/pages/a.html", "in a file called page.html". */
const keptIn =
  /\b(?:to|as|in|into)\s+(?:(?:a|the)\s+file\s+(?:called|named)\s+)?["'`]?((?:[a-z]:)?[\w.\\/~-]+\.[a-z0-9]{1,6})["'`]?(?=[\s.,!?;:]|$)/i;

/** Words that keep something. One of them has to be there: "read https://... in notes.txt" keeps nothing. */
const keeps = new Set(["save", "store", "write", "put", "keep", "export", "copy", "download"]);

/** Every word a request to fetch a page and keep it is made of. Any other word means it asks for more than that. */
const plainWords = new Set([
  ...keeps,
  "fetch", "get", "grab", "open", "read", "load", "pull", "down", "visit",
  "please", "can", "could", "would", "will", "you", "now", "then", "also", "and", "just", "me", "go", "ahead", "i", "i'd", "want", "need", "like", "to", "for",
  "it", "that", "this", "the", "a", "an", "its", "of", "at", "from", "there",
  "page", "webpage", "web", "site", "website", "file", "result", "copy", "html", "source", "text", "contents", "content", "whole", "entire", "full", "raw", "body",
  // Said when the file is already there; see replaceWholeFile in fileEdit.ts.
  "overwrite"
]);

/**
 * The address and the file of a request that asks only for a page to be
 * fetched and kept, or null for any request that is not exactly that.
 */
export function pageToKeep(message: string): PageToKeep | null {
  // The first address. A second one stays among the words below, and "https" is not one of them.
  const address = webAddress.exec(message)?.[0];
  if (!address) return null;
  // What ends the sentence is not part of the address.
  const url = address.replace(/[.,!?;:)]+$/, "");
  const apartFromTheAddress = message.replace(address, " ");

  const kept = keptIn.exec(apartFromTheAddress);
  if (!kept) return null;
  const file = kept[1];

  const words: string[] = apartFromTheAddress.replace(kept[0], " ").toLowerCase().replace(/’/g, "'").match(/[a-z][a-z']*/g) ?? [];
  if (!words.every((word) => plainWords.has(word))) return null;
  if (!words.some((word) => keeps.has(word))) return null;

  const text = words.includes("text") || /\.(?:txt|md|text)$/i.test(file);
  return { url, file, as: text ? "text" : "page" };
}

/** What goes in the file, and how the reply describes it. Null when a page was asked for as text and has none. */
export function contentToKeep(
  fetched: Extract<RawFetchOutcome, { ok: true }>,
  as: PageToKeep["as"]
): { content: string; holds: string } | null {
  // Only a page of HTML has text to take out of it. JSON, CSV and plain text are their own text.
  if (as === "text" && /html/i.test(fetched.contentType)) {
    const { title, text } = extractReadableText(fetched.body);
    if (!text) return null;
    return { content: `${title ? `${title}\n\n` : ""}${text}\n`, holds: `the text of the page at ${fetched.url}` };
  }
  return { content: fetched.body, holds: `the page at ${fetched.url} as it was served` };
}
