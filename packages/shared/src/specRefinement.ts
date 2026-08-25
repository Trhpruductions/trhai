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
  if (typeof lastAssistantMessage !== "string") return false;
  // Either shape pairs with the next turn: the old blocking question, and the
  // build that went ahead on assumptions. Refinement is worth keeping now
  // that nothing stops to ask — "add email and phone" after a built app has
  // to reach the builder, or not asking would just mean not listening.
  return lastAssistantMessage.startsWith(clarifyBuildPrefix)
    || lastAssistantMessage.includes(assumedSpecMarker);
}

/**
 * Closing sentence on a build that filled in a gap.
 *
 * Doubles as the marker that lets the next turn refine this build. Written as
 * an ordinary sentence rather than a hidden token, so the thing that makes
 * refinement work is also the thing that tells you refinement is available.
 */
export const assumedSpecMarker = "and I'll rebuild it";

/**
 * What was assumed, when a request left something unsaid.
 *
 * Replaces asking. Being asked "what should each one store?" after saying
 * "build a todo list app" is the assistant handing the work back — and the
 * answer is nearly always the obvious one, so the question buys a round trip
 * and very little else.
 *
 * Stating the assumption is the honest version of not asking. It is not the
 * same as guessing quietly: the reply says which fields were chosen and that
 * they can be changed, so a wrong guess costs one sentence instead of leaving
 * someone to discover it in the built app.
 */
export function describeAssumptions(spec: ProjectSpec, gaps: SpecGap[]): string {
  if (gaps.length === 0) return "";

  const primary = spec.entities[0];
  const fields = primary.fields.map((field) => field.name).join(", ");
  const lines: string[] = [];

  if (gaps.includes("entity")) {
    // Nothing in the request named what it keeps track of, so the generic
    // record is what got built. Worth saying outright — this is the assumption
    // most likely to be wrong.
    lines.push(`You didn't say what this should keep track of, so I've built it around a generic `
      + `"${primary.name}" record.`);
  }

  if (gaps.includes("fields")) {
    lines.push(`Each ${primary.name} has ${fields}.`);
  }

  // Always closed with the marker, whichever gap was filled: it is both the
  // offer to change the guess and what lets the next turn actually do it.
  lines.push(`Name the fields you want — "add email, phone and amount" — ${assumedSpecMarker}.`);

  return lines.join(" ");
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
