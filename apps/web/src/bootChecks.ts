import type { BootCheck } from "./ui/Boot";

// What the wake-up sequence reports.
//
// Kept out of the component so it can be tested without a React tree, and so
// the one rule that matters is stated in one place: a line may only claim a
// check passed when that check actually ran and returned something.

export type BootReadings = {
  /** null while the link has not answered yet. */
  online: boolean | null;
  model: string | null;
  linkMs: number | null;
  /** Whether the store has been asked, as opposed to what it holds. */
  storeChecked: boolean;
  stats: Array<{ label: string; value: string }>;
};

export function bootChecksFor(readings: BootReadings): BootCheck[] {
  return [
    {
      label: "Link",
      state: readings.online === null ? "pending" : readings.online ? "ok" : "failed",
      detail: readings.online === false
        ? "no service"
        : readings.linkMs === null ? "" : `${readings.linkMs}ms`
    },
    {
      label: "Model",
      // Unknown rather than absent until the link answers: reporting "none"
      // before anything has been asked would be a guess.
      state: readings.online === null ? "pending" : readings.model ? "ok" : "absent",
      detail: readings.model
        ? readings.model.replace(/:latest$/, "")
        : readings.online === null ? "" : "none — notes and documents only"
    },
    {
      label: "Store",
      // Keyed on whether it was asked, not on whether it holds anything: an
      // empty store is a finished check.
      state: readings.storeChecked ? "ok" : "pending",
      detail: readings.storeChecked
        ? readings.stats.map((stat) => `${stat.value} ${stat.label}`).join(", ")
        : ""
    }
  ];
}
