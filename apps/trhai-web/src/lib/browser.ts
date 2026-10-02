// The Browser workspace's small decisions: whether what was typed is an
// address or a search, the address made whole, a page's text as paragraphs,
// and a history that Back and Forward walk. Pure, so they are testable.

/** What the address bar was asked for. */
export type Visit = { kind: "search"; query: string } | { kind: "page"; url: string };

/** An address - "https://..." or a bare "example.com/docs" - rather than words to search for. */
export function looksLikeUrl(input: string): boolean {
  const value = input.trim();
  if (/^https?:\/\//i.test(value)) return true;
  if (/\s/.test(value)) return false;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d+)?(\/\S*)?$/i.test(value);
}

/** The address made whole: https:// when no scheme was typed. */
export function normalizeUrl(input: string): string {
  const value = input.trim();
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

/** What a visit is called in the address bar. */
export function visitText(visit: Visit): string {
  return visit.kind === "search" ? visit.query : visit.url;
}

/** The site, as a person names it: "docs.example.com", without "www.". */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** A page's text as paragraphs: split on blank lines, each with its spacing tidied. */
export function paragraphsOf(text: string): string[] {
  return text.split(/\n\s*\n/).map((part) => part.replace(/[ \t]+/g, " ").trim()).filter(Boolean);
}

export type History = { visits: Visit[]; index: number };

export const emptyHistory: History = { visits: [], index: -1 };

/** Going somewhere new drops whatever Forward led to, as a browser does. */
export function visit(history: History, next: Visit): History {
  const current = history.visits[history.index];
  if (current && visitText(current) === visitText(next) && current.kind === next.kind) return history;
  const visits = [...history.visits.slice(0, history.index + 1), next];
  return { visits, index: visits.length - 1 };
}

export function back(history: History): History {
  return history.index > 0 ? { ...history, index: history.index - 1 } : history;
}

export function forward(history: History): History {
  return history.index < history.visits.length - 1 ? { ...history, index: history.index + 1 } : history;
}
