// What happened to tools during one turn.
//
// This was four hand-written assignments in the agent loop, two of them
// carrying their own `if (state === "none")` guard that a later edit had to
// remember to repeat. That is the shape of thing that decays: the loop's
// terminal message claims "No tool was executed during this attempt", and a
// future branch that forgot the guard, or assigned "none" by hand, would make
// the app say it about a turn where something ran.
//
// So there is no setter. The only ways out of "none" are the three named
// transitions below, and none of them can return to it. Resetting is not
// discouraged here, it is unavailable.

export type ToolActivity =
  /** Nothing was ever requested. Only here may the terminal message be used. */
  | "none"
  /** A tool ran, whether it succeeded, failed, or threw. */
  | "executed"
  /** A call is held open for the user to approve. */
  | "awaiting-confirmation"
  /** A valid call was produced and refused before it could run. */
  | "blocked";

export type ToolActivityState = {
  /** The current value, for the audit and for the enforcement branch. */
  readonly value: ToolActivity;
  /** True only when nothing has been requested at all. */
  readonly untouched: boolean;
  /**
   * Call immediately BEFORE dispatch, never after.
   *
   * A tool that throws has still run - it may have written half a file before
   * it failed - and marking afterwards would leave the turn looking untouched
   * because the marking line was never reached. The whole point of the state is
   * to be true in exactly that case.
   */
  markExecuted(): void;
  /** A call held for approval. Nothing ran. */
  markAwaitingConfirmation(): void;
  /**
   * A valid call refused before it could run: a repeat, or one dropped after an
   * earlier failure in the same turn.
   *
   * Only from "none". A call blocked after another already executed must not
   * mask the execution - what matters is that something ran, not that a later
   * one did not.
   */
  markBlocked(): void;
};

export function createToolActivity(): ToolActivityState {
  let state: ToolActivity = "none";

  return {
    get value() { return state; },
    get untouched() { return state === "none"; },
    markExecuted() { state = "executed"; },
    markAwaitingConfirmation() { state = "awaiting-confirmation"; },
    markBlocked() { if (state === "none") state = "blocked"; }
  };
}
