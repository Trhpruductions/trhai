// Cross-turn build refinement.
//
// `planProject` reads a single sentence. "Build a CRM" contains no record type
// and no fields, so it would silently produce a generic "item" tracker — an app
// that technically runs and is useless. Rather than guess, the assistant asks one
// targeted question and plans from the original request plus the answer.
//
// Only genuinely under-specified requests are questioned. Interrogating someone
// who already told you what they want is its own failure.

import type { ProjectSpec } from "./projectPlan.js";

export type SpecGap = "entity" | "fields";

/**
 * Marks a reply as a build clarification so the next turn can pair with it.
 *
 * Deliberately ASCII: the marker survives a round trip through any client, and
 * an em dash here silently breaks refinement for anything that mishandles
 * encoding — a failure that looks like the assistant simply ignoring the answer.
 */
export const clarifyBuildPrefix = "Before I build that:";

const defaultFieldNames = ["title", "description"];

/**
 * What the plan is missing. A spec with a real entity and at least one field or
 * feature beyond the defaults is considered actionable.
 */
export function findSpecGaps(spec: ProjectSpec): SpecGap[] {
  const gaps: SpecGap[] = [];

  // "item" is the fallback used when no record type could be identified.
  if (spec.entities.length === 1 && spec.entities[0].name === "item") {
    gaps.push("entity");
  }

  const primary = spec.entities[0];
  const hasOwnFields = primary.fields.some((field) => !defaultFieldNames.includes(field.name));
  if (!hasOwnFields && spec.features.length === 0) {
    gaps.push("fields");
  }

  return gaps;
}

export function buildClarifyingQuestion(spec: ProjectSpec, gaps: SpecGap[]): string {
  const lines = [clarifyBuildPrefix];

  if (gaps.includes("entity")) {
    lines.push("");
    lines.push("I couldn't tell what this should keep track of. What are the records — "
      + "customers, tickets, invoices, something else?");
  } else {
    lines.push("");
    lines.push(`I can build a ${spec.entities[0].name} tracker, but I only have a title and `
      + "description to go on. What should each one store?");
  }

  if (gaps.includes("fields")) {
    lines.push("");
    lines.push("Useful things to name: the fields you need (email, phone, amount, due date), "
      + "and whether you want status tracking, a dashboard, a board or a calendar.");
  }

  lines.push("");
  lines.push("Answer in one line and I'll build it — for example: "
     + "\"customers with email, phone and company, plus a dashboard\".");

  return lines.join("\n");
}

/**
 * True when the previous assistant turn asked a build clarification, meaning the
 * incoming message is the answer to it.
 */
export function isAwaitingRefinement(lastAssistantMessage: string | undefined): boolean {
  return typeof lastAssistantMessage === "string" && lastAssistantMessage.startsWith(clarifyBuildPrefix);
}

/**
 * Combine the original request with the clarifying answer.
 *
 * The answer is appended rather than replacing the request, so detail already
 * given ("a tracker with a dashboard") is not lost when the user only names the
 * records in their reply.
 */
export function mergeRefinement(originalRequest: string, answer: string): string {
  const original = originalRequest.trim().replace(/[.!?]+$/, "");
  const addition = answer.trim();
  if (!addition) return original;
  if (!original) return addition;

  // Joined as separate sentences, not with a space. A field list runs to the end
  // of its sentence, so "…with a dashboard customers with email" would swallow
  // "customers" into the first list and lose the entity entirely.
  return `${original}. ${addition}`;
}
