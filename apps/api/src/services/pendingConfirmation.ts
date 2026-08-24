// A destructive action the assistant offered to take, waiting on a yes.
//
// The permission gate refuses a level 3 tool and tells the model to ask. That
// is only half a permission system: without somewhere to record what was
// being asked about, the user's "yes" arrives with nothing to attach it to,
// and the assistant either does nothing or guesses.
//
// Deliberately in memory rather than on disk, which is the opposite of the
// task store. An authorisation is about the exchange it happens in — "yes"
// three days and one restart later does not mean yes to the deletion that was
// pending when the app was last closed. Losing these on restart is the
// correct behaviour, not a limitation.

export type PendingConfirmation = {
  /** The tool the model tried to run. */
  tool: string;
  /** The arguments it tried to run it with, replayed verbatim on approval. */
  arguments: Record<string, unknown>;
  /** The request that led here, so an approval can resume the whole ask. */
  request: string;
  askedAt: number;
};

/**
 * How long an offer stands.
 *
 * Long enough to read a sentence and answer it; short enough that a "yes"
 * meant for something else cannot land on a deletion proposed much earlier.
 */
export const confirmationWindowMs = 10 * 60 * 1000;

const pendingBySession = new Map<string, PendingConfirmation>();

export function recordPendingConfirmation(
  sessionId: string,
  pending: Omit<PendingConfirmation, "askedAt">,
  now: number = Date.now()
): void {
  pendingBySession.set(sessionId, { ...pending, askedAt: now });
}

/**
 * The offer a "yes" would be answering, or null.
 *
 * Null is a real answer the caller must respect: an affirmative with nothing
 * pending has to be treated as ordinary conversation, never as blanket
 * permission.
 */
export function getPendingConfirmation(
  sessionId: string,
  now: number = Date.now()
): PendingConfirmation | null {
  const pending = pendingBySession.get(sessionId);
  if (!pending) return null;

  if (now - pending.askedAt > confirmationWindowMs) {
    // Expired offers are dropped rather than left to be answered later.
    pendingBySession.delete(sessionId);
    return null;
  }

  return pending;
}

/** Taken once. An approval must not be replayable against a second action. */
export function consumePendingConfirmation(
  sessionId: string,
  now: number = Date.now()
): PendingConfirmation | null {
  const pending = getPendingConfirmation(sessionId, now);
  if (pending) pendingBySession.delete(sessionId);
  return pending;
}

export function clearPendingConfirmation(sessionId: string): void {
  pendingBySession.delete(sessionId);
}

/**
 * Whether a message is the user agreeing to what was just offered.
 *
 * Anchored to the start and kept narrow. This grants permission to delete
 * something, so the cost of reading agreement into a sentence that merely
 * contains "yes" is far higher than the cost of asking again.
 */
const affirmativePattern =
  /^(yes|yep|yeah|yup|ok|okay|sure|confirm(ed)?|go ahead|do it|please do|delete it|forget it)\b/i;

export function isAffirmative(message: unknown): boolean {
  return typeof message === "string" && affirmativePattern.test(message.trim());
}

/**
 * The action, in the words a person would use to describe it.
 *
 * A dialog that says "Run forget" is asking someone to approve a function
 * call. A dialog that says "Forget: the billing database is Postgres 16" is
 * asking them about the thing that will actually be destroyed, which is the
 * only version of the question they can answer meaningfully.
 *
 * Falls back to the tool name rather than inventing a description for a tool
 * it does not know — a confirmation prompt is the last place to guess.
 */
export function describePendingAction(pending: PendingConfirmation): {
  verb: string;
  target: string;
} {
  const argument = (name: string): string => {
    const value = pending.arguments?.[name];
    return typeof value === "string" && value.trim() ? value.trim() : "";
  };

  switch (pending.tool) {
    case "forget":
      return { verb: "Forget this saved memory", target: argument("fact") };
    case "delete_document":
      return { verb: "Delete this document", target: argument("title") };
    default:
      return { verb: `Run ${pending.tool}`, target: "" };
  }
}

/** Test seam. */
export function resetPendingConfirmations(): void {
  pendingBySession.clear();
}
