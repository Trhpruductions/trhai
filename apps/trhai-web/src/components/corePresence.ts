import type { CoreState } from "./Core";
import type { AssistantStatus } from "../hooks/useAssistant";

// What the whole screen is showing, decided in one place.
//
// This is the single function that turns real state — the API being
// reachable, a tool genuinely running, the microphone genuinely open, the
// voice genuinely speaking — into the core's appearance and the words under
// it. It lives in its own module because it is the most consequential piece
// of logic in the interface: get the ordering wrong and the app confidently
// shows the user something that is not happening.

export type Presence = { core: CoreState; label: string };

/**
 * The core state and status line, from real state alone.
 *
 * The ordering is the design:
 *
 * 1. Unreachable outranks everything. If the local API is gone, nothing the
 *    assistant reports can be current, so a core still breathing in full
 *    colour would be the most prominent lie on the screen. This was genuinely
 *    missing — "offline" was defined, styled, and unreachable, so the top bar
 *    read OFFLINE while the core carried on as though fine.
 * 2. Listening next, because it describes the device rather than the request:
 *    if the microphone is really open, that is the most important true thing.
 * 3. Then the request states, in the order they actually occur.
 *
 * `online` is null while the first check is still in flight, which must not
 * drain the core on every page load — only a definite false counts.
 */
export function presence(
  status: AssistantStatus,
  listening: boolean,
  speaking: boolean,
  online: boolean | null
): Presence {
  if (online === false) return { core: "offline", label: "NO CONNECTION" };
  if (listening) return { core: "listening", label: "LISTENING" };

  if (status.state === "executing") {
    // The stage says which part of the pipeline this is; the tool says what is
    // doing it. Both are real readings, and neither stands in for the other.
    const stage = status.stage ? `${status.stage.toUpperCase()} · ` : "";
    // The core shows the *kind* of work from the tool genuinely mid-call, so
    // searching does not look identical to writing. It cannot drift from the
    // truth: the state ends when the tool call returns.
    return {
      core: coreStateForTool(status.tool),
      label: `${stage}${status.tool.replace(/_/g, " ").toUpperCase()}`
    };
  }

  if (status.state === "thinking") {
    // "THINKING" for thirty seconds is true and says almost nothing.
    return { core: "thinking", label: (status.stage ?? "Thinking").toUpperCase() };
  }

  if (status.state === "success") return { core: "success", label: "COMPLETE" };
  if (status.state === "error") return { core: "error", label: "ERROR" };
  if (speaking) return { core: "speaking", label: "SPEAKING" };
  return { core: "idle", label: "STANDING BY" };
}

/**
 * The core state for a tool that is actually running.
 *
 * Mapped from the tool name the API reports mid-turn. An unrecognised tool
 * falls back to "executing", which is true of every tool call — better a
 * correct general answer than a specific wrong one, and it means a tool added
 * later still shows something honest without touching this.
 *
 * Every name below is a tool this app actually has. An earlier version also
 * matched "web_search", "install", "test" and "analyse_*", none of which
 * exist: the middle two are execution *kinds* derived from the text of a
 * run_command, not tools, so anyone reading this would have concluded there
 * was an install tool. Mapping names that cannot occur is not free — it is a
 * claim about coverage that quietly is not true.
 */
export function coreStateForTool(tool: string): CoreState {
  // fetch_url, search_memory, search_documents, search_conversation.
  if (tool === "fetch_url" || tool.startsWith("search_")) return "searching";
  // read_file, read_document, list_files, list_documents, list_memories.
  if (tool.startsWith("read_") || tool.startsWith("list_")) return "reading";
  // write_file, write_document, update_document, build_app.
  if (tool.startsWith("write_") || tool === "update_document" || tool === "build_app") return "writing";
  if (tool === "plan_app") return "analysing";
  return "executing";
}

/** The bottom rail. At most one is lit, and it is lit by real state. */
export const stages = ["ENGAGED", "LISTENING", "THINKING", "EXECUTING", "COMPLETE"] as const;

/** Every core state that means a tool is genuinely mid-call. */
export const workingStates: CoreState[] = ["searching", "reading", "writing", "analysing", "executing"];

export function activeStage(core: CoreState, hasConversation: boolean): string | null {
  // Nothing on the rail is true when the machine cannot be reached, including
  // "engaged" — a conversation that existed a minute ago is not one now.
  if (core === "offline") return null;
  if (core === "listening") return "LISTENING";
  if (core === "thinking" || core === "speaking") return "THINKING";
  if (workingStates.includes(core)) return "EXECUTING";
  if (core === "success") return "COMPLETE";
  // "Engaged" means a conversation is genuinely under way, not merely that
  // the page is open — otherwise the rail would light before anything had
  // happened and would mean nothing at all.
  return hasConversation ? "ENGAGED" : null;
}

/**
 * Whether the current answer is drawn on the stage itself.
 *
 * The transcript lives in the console rail, and that rail starts closed. Asking
 * a question on a freshly opened app therefore played the whole core animation
 * and then put the answer somewhere the user could not see - the one thing on
 * this screen that is not optional was the one thing hidden by default.
 *
 * So the stage shows the latest reply, under three conditions.
 *
 * It stops as soon as the rail is open, because the rail lists the same turn.
 * Exactly one of the two renders it: an answer that appears twice on a single
 * screen is the duplication this layout exists to avoid.
 *
 * And it shows only a reply from this run of the app. Conversations are
 * restored on load, so the newest stored reply can be days old - putting it
 * where the answer to a question just asked goes would have the screen state
 * something untrue the moment it opened. Old turns are history, and history is
 * what the rail is for.
 */
export function stageReplyVisible(
  consoleRailOpen: boolean,
  hasReply: boolean,
  replyIsFromThisRun: boolean
): boolean {
  return hasReply && replyIsFromThisRun && !consoleRailOpen;
}
