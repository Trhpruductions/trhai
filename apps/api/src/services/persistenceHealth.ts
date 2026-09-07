// Whether what the app was asked to keep is actually reaching the disk.
//
// Every store here follows the same rule, and the rule is right: losing
// durability is bad, taking the request down with it is worse. So a failed
// write is caught and the request carries on.
//
// The problem was never the catch. It was that five of them caught and said
// nothing at all — taskStore, conversationStore, knowledgeStore, preferences
// and taskListStore each ended in a bare `catch {}` with a comment explaining
// why it must not throw, and no record that anything had gone wrong. A disk
// that fills up, a file held open by a backup process, a permission change on
// the data directory: any of those and the app keeps answering normally while
// nothing it is told survives a restart. The user finds out later, from the
// absence of something they were sure they had saved.
//
// assistMemoryStore already solved this for itself with a private
// `lastPersistError`, after exactly that bug. This is that idea in one place,
// so a store reports a failure by naming itself rather than by growing its own
// copy of the machinery — and so there is a single thing to ask when the
// question is "is anything failing to save right now".
//
// Deliberately in-memory and per-process. A persistence problem that itself
// needed persisting would be the one report guaranteed to be lost.

/** A store that could not write, and what went wrong the last time it tried. */
export type PersistenceFailure = {
  /** The store's own name, as it calls itself: "tasks", "conversations". */
  store: string;
  /** The error text, unmodified. It is the only clue to a cause. */
  error: string;
  /** When it last failed, so a stale report is recognisable as stale. */
  at: string;
};

const failures = new Map<string, PersistenceFailure>();

/**
 * Record that a store could not write.
 *
 * Called from the catch that already exists, so nothing about the failure
 * handling changes: the request still succeeds, the API still stays up. The
 * only difference is that afterwards something can say so.
 */
export function recordPersistFailure(store: string, error: unknown): void {
  failures.set(store, {
    store,
    error: error instanceof Error ? error.message : String(error),
    at: new Date().toISOString()
  });
}

/**
 * Record that a store wrote successfully.
 *
 * Clearing on success is what keeps this honest in the other direction. A
 * transient failure — a file locked for a moment by something else — would
 * otherwise be reported forever, and a report that never goes away is one
 * people learn to ignore.
 */
export function recordPersistSuccess(store: string): void {
  failures.delete(store);
}

/** Every store currently failing to write, oldest failure first. */
export function persistenceFailures(): PersistenceFailure[] {
  return [...failures.values()].sort((left, right) => left.at.localeCompare(right.at));
}

/** True when anything is currently failing to write. */
export function anyPersistenceFailing(): boolean {
  return failures.size > 0;
}

/** Test helper. Nothing in src should need to forget a real failure. */
export function resetPersistenceHealth(): void {
  failures.clear();
}
