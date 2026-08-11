// E14-S2: duplicate submission suppression.
//
// React state cannot guard a submit handler against itself. `setChatBusy(true)`
// does not apply synchronously, and a second handler invocation in the same tick
// reads the stale `false` from its own closure, so both submissions proceed. A
// ref-backed latch is the only thing that closes the same-tick window.
//
// The latch also swallows rapid identical resubmits (burst clicking "Develop It"),
// which produce duplicate API calls and duplicate scaffold writes.

export type SubmissionLatch = {
  /** Returns true when the caller owns the submission and must later release it. */
  tryAcquire(key: string, now?: number): boolean;
  release(): void;
  /** Exposed for tests and diagnostics. */
  isBusy(): boolean;
};

export const defaultSubmissionCooldownMs = 1200;

export function createSubmissionLatch(cooldownMs: number = defaultSubmissionCooldownMs): SubmissionLatch {
  let busy = false;
  let lastKey: string | null = null;
  let lastAcceptedAt = 0;

  return {
    tryAcquire(key: string, now: number = Date.now()): boolean {
      // A submission is already running; anything else is a duplicate.
      if (busy) {
        return false;
      }

      // The same request repeated inside the cooldown is burst-click spam.
      if (lastKey !== null && lastKey === key && now - lastAcceptedAt < cooldownMs) {
        return false;
      }

      busy = true;
      lastKey = key;
      lastAcceptedAt = now;
      return true;
    },

    release() {
      busy = false;
    },

    isBusy() {
      return busy;
    }
  };
}
