// The offline reply path.
//
// When the assistant API cannot be reached, the client still has to say
// something. What it must not do is sound like it understood and is working:
// the previous version classified every unmatched request as a build and
// answered "Build track active. I will convert <your question> into
// architecture, stack, milestones, and scaffold outputs." Asked "how much
// ibuprofen should I take", that is confident, irrelevant, and wrong — and
// nothing in it tells the user the service is down.
//
// So intent detection here has an explicit "question" outcome, and a question
// gets an honest offline reply instead of a fabricated work plan.

import { looksLikeQuestion } from "./autoDevelop";

export type LocalIntent =
  | "build"
  | "code"
  | "debug"
  | "research"
  | "plan"
  | "business"
  | "creator"
  | "question";

const buildVerbs = "build|create|make|generate|scaffold|set up|spin up";

/** An imperative at the start of the request: "build me an expense tracker". */
const imperativeBuild = new RegExp(`^\\s*(please\\s+)?(${buildVerbs})\\b`, "i");

/**
 * A polite request, which is question-shaped but plainly commissions work:
 * "can you build me an expense tracker?".
 *
 * Both patterns anchor to the start deliberately. A loose \b(build)\b anywhere
 * matches "why did the build fail?", turning a question about a failure into an
 * order to build something.
 */
const politeBuild = new RegExp(`^\\s*(can|could|would|will)\\s+you\\s+(please\\s+)?(${buildVerbs})\\b`, "i");

export function inferLocalIntent(request: string): LocalIntent {
  const value = request.toLowerCase();

  // An explicit build instruction wins over question shape.
  if (imperativeBuild.test(value) || politeBuild.test(value)) return "build";

  // Question shape is checked before the keyword ladder so that "why did the
  // build fail?" is treated as a question rather than a request to build.
  if (looksLikeQuestion(request)) return "question";

  if (/bug|fix|error|issue|broken|stack trace|exception/.test(value)) return "debug";
  if (/research|compare|investigate|analyze options|benchmark/.test(value)) return "research";
  if (/roadmap|plan|milestone|architecture|scope/.test(value)) return "plan";
  if (/revenue|pricing|go[- ]to[- ]market|kpi|sales|cost/.test(value)) return "business";
  if (/design|branding|creative|content|campaign|story/.test(value)) return "creator";
  if (/code|function|class|api|refactor|typescript|react|node/.test(value)) return "code";

  // A bare noun phrase typed into the build box ("expense tracker with amount
  // and date") is still a build request. Only question-shaped input escapes it.
  return "build";
}

/**
 * The reply shown when the API is unreachable.
 *
 * For work-shaped requests it states the track it would take, which is honest —
 * that is what the client would do once connected. For a question it says
 * plainly that it cannot answer offline, because inventing a track would be a
 * confident non-answer.
 */
export function buildLocalCapabilityReply(intent: LocalIntent, request: string): string {
  if (intent === "question") {
    return [
      "I can't reach the assistant service right now, so I can't answer that yet.",
      "Your message is kept in this conversation — ask again once the connection is back, or tell me something to remember with \"remember that ...\"."
    ].join("\n\n");
  }

  if (intent === "code") {
    return `Coding track active. I will produce implementation-ready code strategy for: ${request}. Next: define modules, APIs, tests, and rollout checks.`;
  }

  if (intent === "debug") {
    return `Debug track active. I will isolate root cause and provide corrective actions for: ${request}. Next: reproduce issue, trace failing path, patch safely, and verify.`;
  }

  if (intent === "research") {
    return `Research track active. I will break down ${request} into options, tradeoffs, risks, and recommended path with execution steps.`;
  }

  if (intent === "plan") {
    return `Planning track active. I will convert ${request} into milestones, owners, dependencies, and delivery checkpoints.`;
  }

  if (intent === "business") {
    return `Business track active. I will map ${request} into KPIs, operating model, cost/revenue assumptions, and launch strategy.`;
  }

  if (intent === "creator") {
    return `Creator track active. I will shape ${request} into creative direction, assets, messaging, and production execution.`;
  }

  return `Build track active. I will convert ${request} into architecture, stack, milestones, and scaffold outputs.`;
}
