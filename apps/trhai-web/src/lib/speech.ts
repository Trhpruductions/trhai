// Turning a reply into something worth hearing.
//
// Pure text transforms, kept out of the hook that plays them so the rule is
// testable on its own: code, links and markup read badly aloud, and this is
// what keeps a spoken reply from reading them character by character.

/** Longer than this is a document being read at someone, not an answer. */
export const maxSpokenCharacters = 700;

export function speakableFrom(text: string): string {
  if (typeof text !== "string") return "";

  let spoken = text
    .replace(/```[\s\S]*?```/g, " (code is on screen) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|\s)\*([^*]+)\*/g, "$1$2")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/https?:\/\/\S+/g, " a link on screen ")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();

  if (spoken.length > maxSpokenCharacters) {
    const cut = spoken.slice(0, maxSpokenCharacters);
    const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
    spoken = (lastStop > maxSpokenCharacters / 2 ? cut.slice(0, lastStop + 1) : cut).trim();
    spoken += " The rest is on screen.";
  }

  return spoken;
}
