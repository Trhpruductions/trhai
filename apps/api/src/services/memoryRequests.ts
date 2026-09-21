// Requests about saved memories, read from the user's words: forget one,
// forget everything, mark one as important.
//
// These are decided here rather than left to the model, and the reason is a
// live turn. "forget that my printer is on the second floor" went to the
// model, which called forget with an empty fact, was told to fill it in, and
// answered with a call to every one of the twenty tools on offer, in the
// order they were listed. The loop ran them: it built an app called "Forget",
// rendered a video and installed a global npm package through run_command -
// on a request to delete one sentence. Nothing about that request needs a
// model. The memories are a list, the request names one, and the only
// decision is the user's.
//
// Pinning had the opposite failure: "mark the server room code as important"
// never reached the model at all. It reads as a statement, so the composer
// answered "Got it." and nothing was marked.

import { normalizeSpelling } from "./spelling.js";
import { normalizeFact } from "./factWording.js";

export type ForgetRequest =
  | { kind: "one"; target: string }
  | { kind: "all" };

export type PinRequest = {
  target: string;
  pinned: boolean;
  /**
   * Whether the request names the act. "pin my api port" is a request and
   * nothing else; "my family is important to me" is a sentence that only
   * becomes one if a saved memory matches it. The caller lets the second
   * kind fall through when nothing matches, rather than answering a
   * statement with "nothing saved matches".
   */
  explicit: boolean;
};

/** Openers that carry no meaning of their own. */
const politeLead = /^(?:please |can you |could you |would you |kindly |just |now |go ahead and |i want you to |i need you to )+/;

/** Requests to clear the whole memory. */
const allPatterns = [
  /^forget (?:everything|all of it|it all|all|everything you (?:know|remember|have saved)(?: about me)?|what you know about me|all (?:of )?(?:my |your |the )?(?:saved )?(?:memories|facts|notes))$/,
  /^(?:clear|wipe|erase|delete|reset|empty|purge) (?:your |all |all of your |my |the |every |all my )?(?:saved )?(?:memory|memories)(?: about me)?$/,
  /^(?:delete|remove|drop) (?:all|every|each) (?:of )?(?:my |your |the )?(?:saved )?(?:memories|facts|notes)(?: about me)?$/
];

/** Requests to forget one thing, with the thing captured. */
const onePatterns = [
  /^forget (?:that |about |the fact that |what i (?:said|told you) about |anything about |everything about |the one about |the memory about )?(.+)$/,
  /^(?:delete|remove|erase|drop|clear) (?:the |that |my |your )?(?:saved |stored )?(?:memory|fact|note|entry|thing|one) (?:that says |which says |that |about |of |saying |where )?(.+)$/,
  /^(?:delete|remove|erase|drop) (.+?) from (?:your |the |my )?(?:saved )?(?:memory|memories)$/,
  /^stop remembering (?:that |about )?(.+)$/,
  /^(?:un-?remember|unsave) (?:that |about )?(.+)$/
];

/** Targets that name nothing: "forget it" answers an offer, it makes none. */
const nothing = /^(?:it|that|this|them|those|about it|about that)$/;

/** The message lower-cased, spelling-corrected, and stripped of politeness and end punctuation. */
function plain(message: unknown): string | null {
  if (typeof message !== "string") return null;
  const text = normalizeSpelling(message.trim().toLowerCase())
    .replace(politeLead, "")
    .replace(/[.!?\s]+$/, "")
    .trim();
  return text.length > 0 ? text : null;
}

export function parseForgetRequest(message: unknown): ForgetRequest | null {
  const text = plain(message);
  if (!text) return null;

  if (allPatterns.some((pattern) => pattern.test(text))) return { kind: "all" };

  for (const pattern of onePatterns) {
    const found = text.match(pattern);
    if (!found) continue;
    const target = normalizeFact(found[1]);
    if (!target || nothing.test(target)) return null;
    return { kind: "one", target };
  }

  return null;
}

type PinPattern = { pattern: RegExp; pinned: boolean; explicit: boolean };

/**
 * Unpinning first: "mark X as not important" would otherwise be caught by
 * the "mark X as ..." pin pattern with "not important" in the tail.
 */
const pinPatterns: PinPattern[] = [
  // "unpin X", "unmark X", "mark X as not important", "stop marking X as important"
  { pinned: false, explicit: true, pattern: /^(?:unpin|unstar|unflag|unmark) (?:the |that |my |your )?(?:saved |stored )?(?:memory |fact |note )?(?:that |about )?(.+?)(?: as important)?$/ },
  { pinned: false, explicit: true, pattern: /^mark (?:the |that |my |your )?(?:saved |stored )?(?:memory |fact |note )?(?:that |about )?(.+?) as (?:not important|unimportant|no longer important)$/ },
  { pinned: false, explicit: true, pattern: /^(?:stop|don't|do not) (?:marking|mark|pinning|pin|flagging|flag) (?:the |that |my )?(.+?)(?: as important)?$/ },
  // "X is no longer important"
  { pinned: false, explicit: false, pattern: /^(?:the |that |my )?(.+?) is (?:no longer|not) (?:that )?important(?: any ?more)?$/ },
  // "pin X", "mark X as important", "keep X pinned"
  { pinned: true, explicit: true, pattern: /^(?:pin|star|flag) (?:the |that |my |your )?(?:saved |stored )?(?:memory |fact |note )?(?:that |about )?(.+?)(?: as (?:important|key|pinned))?$/ },
  { pinned: true, explicit: true, pattern: /^mark (?:the |that |my |your )?(?:saved |stored )?(?:memory |fact |note )?(?:that |about )?(.+?) as (?:important|key|pinned)$/ },
  { pinned: true, explicit: true, pattern: /^keep (?:the |that |my )?(.+?) (?:pinned|marked(?: as important)?)$/ },
  // "X is important"
  { pinned: true, explicit: false, pattern: /^(?:the |that |my )?(.+?) is (?:very |really )?important(?: to me)?$/ }
];

export function parsePinRequest(message: unknown): PinRequest | null {
  const text = plain(message);
  if (!text) return null;

  for (const { pattern, pinned, explicit } of pinPatterns) {
    const found = text.match(pattern);
    if (!found) continue;
    const target = normalizeFact(found[1]);
    if (!target || nothing.test(target)) return null;
    return { target, pinned, explicit };
  }

  return null;
}

/** "what do you know about me", "list everything you have saved", "show me my memories". */
const listPatterns = [
  /^(?:list|show(?: me)?|tell me|give me|print|display|read (?:me )?back) (?:me )?(?:everything|all|all of|what|the things|the stuff|anything) (?:that )?(?:you(?:'ve| have)? )?(?:saved|remembered|remember|know|stored|got|learned|have)(?: so far)?(?: about me)?$/,
  /^(?:list|show(?: me)?|display) (?:my |your |the |all (?:of )?(?:my |your |the )?)?(?:saved )?(?:memories|memory|facts|notes about me|things you know)$/,
  /^what (?:do you|have you|did you) (?:know|remember|save|saved|stored|learn|learned|got)(?: so far)?(?: about me)?$/,
  /^what (?:have|did) i (?:told|tell|taught) you(?: so far| about me(?:self)?)?$/,
  /^what(?:'s| is) (?:in|saved in|stored in) (?:your|my) memory$/,
  /^do you remember (?:anything )?about me$/
];

export function isListMemoriesRequest(message: unknown): boolean {
  const text = plain(message);
  return text !== null && listPatterns.some((pattern) => pattern.test(text));
}

/**
 * "what did I just ask you?" - a question about the transcript, not about
 * memory. Kept narrow: "what did I say my port was" is a recall question and
 * belongs to the memory path.
 */
const lastAskPatterns = [
  /^what did i (?:just )?(?:ask|say|tell you|type|request|send)(?: you)?(?: to do| for)?(?: just now| a moment ago| before(?: this)?)?$/,
  /^what was my (?:last|previous) (?:message|question|request|ask)$/,
  /^what (?:was|is) the last thing i (?:asked|said|typed|sent)(?: you)?$/,
  /^repeat (?:my|the) last (?:message|question|request)$/
];

export function isLastAskRequest(message: unknown): boolean {
  const text = plain(message);
  return text !== null && lastAskPatterns.some((pattern) => pattern.test(text));
}

/** "what schedules do I have", "list my schedules", "show my reminders". */
const listSchedulesPatterns = [
  /^(?:what|which) (?:schedules|reminders|scheduled (?:tasks|jobs|runs)|recurring (?:tasks|jobs)) (?:do i have|are (?:set|there|active|scheduled|running)|have i (?:set|got|made))$/,
  /^(?:list|show(?: me)?|display) (?:my |the |all (?:of )?(?:my |the )?)?(?:active |current )?(?:schedules|reminders|scheduled (?:tasks|jobs|runs)|recurring (?:tasks|jobs))$/,
  /^(?:do i have|are there|is there) any (?:schedules|reminders|scheduled (?:tasks|jobs))$/
];

export function isListSchedulesRequest(message: unknown): boolean {
  const text = plain(message);
  return text !== null && listSchedulesPatterns.some((pattern) => pattern.test(text));
}

// Cancelling and pausing schedules, decided here for the same reason as forget
// and pin: the model cannot be trusted with it. "cancel my daily reminder"
// answered "Got it." and cancelled nothing; "turn off the 9am reminder" called
// add_schedule and created a second one - the exact opposite of the request.
// The store can already remove and disable by id; all that was missing was a
// path from the user's words to that call.

export type ScheduleTargetRequest =
  | { kind: "one"; target: string }
  | { kind: "all" };

export type ScheduleToggleRequest =
  | { kind: "one"; target: string; enabled: boolean }
  | { kind: "all"; enabled: boolean };

/** The words for a schedule, so a target can be told apart from the noun. */
const scheduleNoun = /\b(?:schedules?|reminders?|scheduled (?:tasks?|jobs?|runs?)|recurring (?:tasks?|jobs?)|automations?|alerts?)\b/;

/** Removal verbs. Kept apart from the toggle verbs so the two never collide. */
const removeScheduleVerb = /^(?:cancel|delete|remove|clear|get rid of|call off|kill|wipe|erase|drop) /;
/** Pause verbs (disable) and resume verbs (enable). */
const disableScheduleVerb = /^(?:turn off|pause|disable|suspend|mute|deactivate|silence|snooze|halt) /;
const enableScheduleVerb = /^(?:turn on|resume|enable|unpause|unmute|reactivate|re-?enable|restart|unsnooze) /;

/** "stop reminding me to water the plants" - a removal in different clothes. */
const stopRemindingPattern = /^stop (?:reminding|alerting|notifying|telling|nagging|pinging) me (?:to |about |that |when )?(.+)$/;

/** all/every/each at the head of what follows the verb: the whole-list case. */
const allLead = /^(?:all|every|each)\b/;
/** "the reminder to check the logs": the noun leads, then a connector, then the name. */
const scheduleNounThenName = /^(?:schedules?|reminders?|scheduled (?:tasks?|jobs?|runs?)|recurring (?:tasks?|jobs?)|automations?|alerts?) (?:to |for |about |that |which |where |called |named |titled |saying |on )(.+)$/;
/**
 * A single trailing schedule noun ("... backup schedule"), stripped once. The
 * leading anchor is (start-or-space) so a bare "reminder" - all that is left of
 * "cancel my reminder" - reduces to nothing, which the resolver reads as "the
 * one schedule, if there is only one".
 */
const trailingScheduleNoun = /(?:^|\s+)(?:schedules?|reminders?|scheduled (?:tasks?|jobs?|runs?)|recurring (?:tasks?|jobs?)|automations?|alerts?)$/;

/**
 * The schedule's name, teased out of what follows the verb.
 *
 * Only a leading article and one trailing noun are dropped, plus the whole
 * "reminder to X" lead-in. A noun in the middle is left alone on purpose: a
 * schedule can be named "Server Logs Reminder", and stripping every noun
 * turned that into "server logs", which then matched two schedules instead of
 * the one the user named exactly.
 */
function scheduleTarget(afterVerb: string): string {
  const bare = afterVerb.trim().replace(/^(?:my |the |that |this |a |an )+/, "").trim();
  const leadIn = bare.match(scheduleNounThenName);
  if (leadIn) return leadIn[1].trim();
  return bare.replace(trailingScheduleNoun, "").trim();
}

export function parseRemoveScheduleRequest(message: unknown): ScheduleTargetRequest | null {
  const text = plain(message);
  if (!text) return null;

  const stopMatch = text.match(stopRemindingPattern);
  if (stopMatch) return { kind: "one", target: stopMatch[1].trim() };

  if (!removeScheduleVerb.test(text) || !scheduleNoun.test(text)) return null;
  const afterVerb = text.replace(removeScheduleVerb, "").trim();
  if (allLead.test(afterVerb)) return { kind: "all" };
  return { kind: "one", target: scheduleTarget(afterVerb) };
}

export function parseToggleScheduleRequest(message: unknown): ScheduleToggleRequest | null {
  const text = plain(message);
  if (!text || !scheduleNoun.test(text)) return null;

  let enabled: boolean;
  let afterVerb: string;
  if (enableScheduleVerb.test(text)) {
    enabled = true;
    afterVerb = text.replace(enableScheduleVerb, "").trim();
  } else if (disableScheduleVerb.test(text)) {
    enabled = false;
    afterVerb = text.replace(disableScheduleVerb, "").trim();
  } else {
    return null;
  }

  if (allLead.test(afterVerb)) return { kind: "all", enabled };
  return { kind: "one", target: scheduleTarget(afterVerb), enabled };
}

const ordinals: Record<string, number> = {
  first: 1, "1st": 1, second: 2, "2nd": 2, third: 3, "3rd": 3, fourth: 4, "4th": 4, fifth: 5, "5th": 5,
  sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10
};

/**
 * "what was the second thing I told you?" - which earlier turn is meant.
 *
 * Returns the 1-based position from the start of the conversation, or -1 for
 * the last one. Null when the message is not this question.
 */
export function parseNthThingRequest(message: unknown): number | null {
  const text = plain(message);
  if (!text) return null;
  const found = text.match(
    /^what (?:was|is|were) the (first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|1st|2nd|3rd|4th|5th|last|latest|previous) (?:thing|message|question|request|fact) (?:i|that i) (?:told|asked|said|sent|typed|gave)(?: you| to you)?(?: about)?$/
  );
  if (!found) return null;
  const word = found[1];
  if (word === "last" || word === "latest" || word === "previous") return -1;
  return ordinals[word] ?? null;
}
