import { useCallback, useEffect, useRef, useState } from "react";
import { webEnv } from "../env";
import { createSubmissionLatch } from "../submissionLatch";
import { applyResponseStyle, defaultPersonality, type PersonalityId } from "@ascend/shared";

// Conversation state.
//
// In the old shell this lived inside a 5,600-line component alongside widgets,
// telemetry and the build engine, which is how the main prompt box ended up
// wired to the blueprint generator instead of the assistant. Here the chat owns
// its own state and nothing else can reach in and redirect it.

export type ChatRole = "user" | "assistant";

export type ChatMessage = {
  id: string;
  role: ChatRole;
  text: string;
  at: number;
  /** How the reply was produced. Absent on user turns. */
  strategy?: string;
  /** Which engine answered, e.g. "ollama/llama3.2:latest". */
  model?: string;
  /** Set when the assistant decided this was a request to build software. */
  buildRequest?: string;
  /**
   * Tools the assistant called, in order, each with whether it achieved
   * anything. `ok: false` is a real result — a search that matched nothing, a
   * deletion that found nothing to delete — not an error to hide.
   */
  toolsUsed?: Array<{ name: string; ok: boolean }>;
};

/** A destructive action the assistant is waiting to be allowed to take. */
export type PendingConfirmation = {
  tool: string;
  /** "Forget this saved memory" — what will happen, in plain words. */
  verb: string;
  /** The thing it happens to. Empty when the tool takes no meaningful subject. */
  target: string;
};

export type AssistantStatus =
  | { state: "idle" }
  | { state: "thinking" }
  | { state: "error"; detail: string };

const sessionStorageKey = "ascend.assist.session.v1";

/** A stable id per browser, so a conversation survives a reload. */
function resolveSessionId(): string {
  const existing = window.localStorage.getItem(sessionStorageKey);
  if (existing) return existing;

  const created = crypto.randomUUID();
  window.localStorage.setItem(sessionStorageKey, created);
  return created;
}

/** Only the last few turns are sent; the server keeps the full transcript. */
const historyTurns = 8;

export function useAssistant(personality: PersonalityId = defaultPersonality) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<AssistantStatus>({ state: "idle" });
  const [restored, setRestored] = useState(false);
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation | null>(null);
  // Guards a same-tick double submit, which `status` cannot: it is stale inside
  // a second call made before React has re-rendered.
  const latch = useRef(createSubmissionLatch());

  const sessionId = useRef(resolveSessionId());

  // Pull the stored transcript so a reload continues the conversation rather
  // than opening on an empty screen that implies nothing was said.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const response = await fetch(
          `${webEnv.apiBaseUrl}/v1/assist/conversation?sessionId=${encodeURIComponent(sessionId.current)}`
        );
        if (!response.ok) return;

        const payload = await response.json();
        const turns: Array<{ role: ChatRole; content: string; strategy?: string; model?: string }> =
          payload?.data?.turns ?? [];
        if (cancelled || turns.length === 0) return;

        // Provenance is carried back through, so a reload does not turn a
        // quote from the user's notes and a model's sentence into the same
        // unlabelled block of text.
        setMessages(turns.map((turn, index) => ({
          id: `restored-${index}`,
          role: turn.role,
          text: turn.content,
          at: Date.now(),
          strategy: turn.strategy,
          model: turn.model
        })));
      } catch {
        // A missing transcript is not an error worth showing; the user can talk.
      } finally {
        if (!cancelled) setRestored(true);
      }
    })();

    return () => { cancelled = true; };
  }, []);

  // A destructive action may still be awaiting approval from before a reload.
  //
  // Its own effect rather than part of the transcript restore: that one
  // returns early when there are no turns, and a standing offer has nothing
  // to do with whether the conversation happens to be empty. Without this the
  // dialog silently disappears while the offer stands on the server, and a
  // "yes" typed later would still run it.
  useEffect(() => {
    let cancelled = false;

    fetch(`${webEnv.apiBaseUrl}/v1/assist/confirmation?sessionId=${encodeURIComponent(sessionId.current)}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (!cancelled) setPendingConfirmation(payload?.data?.pendingConfirmation ?? null);
      })
      .catch(() => {
        // Nothing to restore is indistinguishable from being unable to ask,
        // and both mean the same thing here: show no dialog.
      });

    return () => { cancelled = true; };
  }, []);

  const send = useCallback(async (input: string) => {
    const text = input.trim();
    if (!text) return;
    if (!latch.current.tryAcquire(text)) return;

    const userTurn: ChatMessage = { id: crypto.randomUUID(), role: "user", text, at: Date.now() };
    setMessages((current) => [...current, userTurn]);
    setStatus({ state: "thinking" });

    // Captured before the new turn so the server is not sent this message twice.
    const history = messages.slice(-historyTurns).map((entry) => ({
      role: entry.role,
      content: entry.text
    }));

    try {
      const response = await fetch(`${webEnv.apiBaseUrl}/v1/assist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, sessionId: sessionId.current, history })
      });

      if (!response.ok) {
        throw new Error(`The assistant service answered ${response.status}.`);
      }

      const payload = await response.json();
      const data = payload?.data ?? {};

      // The mandatory disclaimer for a regulated personality (medical, legal,
      // cyber-security) is applied here, once, at the moment the reply is
      // actually received — not at render time. The active personality can
      // change later, and a disclaimer stamped on at render would drift with
      // it, silently attaching today's personality to an answer generated
      // under a different one, or dropping it if the user switched away.
      setMessages((current) => [...current, {
        id: crypto.randomUUID(),
        role: "assistant",
        text: applyResponseStyle(data.assistantMessage ?? "", personality),
        at: Date.now(),
        strategy: data.strategy,
        model: data.model,
        buildRequest: data.buildRequest,
        toolsUsed: data.toolsUsed
      }]);
      // Replaced wholesale, never merged: an absent field means the gate
      // refused nothing this turn, so any earlier offer is finished.
      setPendingConfirmation(data.pendingConfirmation ?? null);
      setStatus({ state: "idle" });
    } catch (error) {
      // Reported in the transcript rather than swallowed, so a failure never
      // looks like the assistant choosing to say nothing.
      const detail = error instanceof Error ? error.message : "The assistant could not be reached.";
      setStatus({ state: "error", detail });
      setMessages((current) => [...current, {
        id: crypto.randomUUID(),
        role: "assistant",
        text: `${detail}\n\nThe app runs its own services; if this persists, reopening it will restart them.`,
        at: Date.now(),
        strategy: "error"
      }]);
    } finally {
      // Without this, the latch that exists to block a same-tick double
      // submit instead blocks every submit after the first: tryAcquire sets
      // busy permanently on success, and nothing else ever clears it. Caught
      // live — a second, unrelated message typed after the first reply had
      // already finished did nothing at all, with no error shown, because the
      // draft still cleared on click even though send() returned immediately.
      latch.current.release();
    }
  }, [messages, personality]);

  /**
   * Decline the pending action.
   *
   * Clears it on the server as well as here. Closing the dialog alone would
   * leave the offer standing, and an unrelated "yes" later in the session
   * could then land on the deletion the user had just refused.
   */
  const declineConfirmation = useCallback(async () => {
    setPendingConfirmation(null);
    try {
      await fetch(
        `${webEnv.apiBaseUrl}/v1/assist/confirmation?sessionId=${encodeURIComponent(sessionId.current)}`,
        { method: "DELETE" }
      );
    } catch {
      // The dialog is already closed. A failed clear is worth no interruption:
      // the offer expires on its own, and nothing runs without another yes.
    }
  }, []);

  const clear = useCallback(async () => {
    setMessages([]);
    setStatus({ state: "idle" });
    try {
      await fetch(`${webEnv.apiBaseUrl}/v1/assist/conversation`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: sessionId.current })
      });
    } catch {
      // The visible transcript is already gone; a failed clear on the server
      // is not worth interrupting the user for.
    }
  }, []);

  return {
    messages,
    status,
    restored,
    pendingConfirmation,
    declineConfirmation,
    sessionId: sessionId.current,
    send,
    clear
  };
}
