"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiBaseUrl, sessionId as resolveSessionId } from "../lib/api";

// Conversation state, talking to the real local orchestrator — the same
// service the rest of this monorepo already built, tested, and runs against
// a local model. Nothing here is a mock; a reply that arrives is a reply the
// model actually produced, and a tool result is one that actually ran.

export type ChatRole = "user" | "assistant";

export type ChatMessage = {
  id: string;
  role: ChatRole;
  text: string;
  at: number;
  strategy?: string;
  model?: string;
  toolsUsed?: Array<{ name: string; ok: boolean }>;
};

export type AssistantStatus =
  | { state: "idle" }
  | { state: "thinking" }
  | { state: "executing"; tool: string }
  | { state: "success" }
  | { state: "error"; detail: string };

const historyTurns = 8;
/** How often to check which tool is running — see /v1/assist/activity. */
const activityPollMs = 500;
/** How long the core shows a finished reply as "success" before settling to idle. */
const successHoldMs = 1200;

export function useAssistant() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<AssistantStatus>({ state: "idle" });
  const [restored, setRestored] = useState(false);
  const session = useRef(resolveSessionId());
  const busy = useRef(false);
  // Bumped once per send() call. A poll tick or a success-hold timeout only
  // acts while its own call is still the most recent one — this is what
  // stops a stale callback from a superseded call clobbering the status a
  // newer call is actively setting.
  const generation = useRef(0);

  useEffect(() => {
    let cancelled = false;
    fetch(`${apiBaseUrl}/v1/assist/conversation?sessionId=${encodeURIComponent(session.current)}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        const turns: Array<{ role: ChatRole; content: string; strategy?: string; model?: string }> =
          payload?.data?.turns ?? [];
        if (!cancelled && turns.length > 0) {
          setMessages(turns.map((turn, index) => ({
            id: `restored-${index}`,
            role: turn.role,
            text: turn.content,
            at: Date.now(),
            strategy: turn.strategy,
            model: turn.model
          })));
        }
      })
      .catch(() => { /* a fresh session has no transcript to restore, and that is fine */ })
      .finally(() => { if (!cancelled) setRestored(true); });
    return () => { cancelled = true; };
  }, []);

  const send = useCallback(async (input: string) => {
    const text = input.trim();
    if (!text || busy.current) return;
    busy.current = true;
    const myGeneration = ++generation.current;
    const stillCurrent = () => generation.current === myGeneration;

    const userTurn: ChatMessage = { id: crypto.randomUUID(), role: "user", text, at: Date.now() };
    setMessages((prior) => [...prior, userTurn]);
    setStatus({ state: "thinking" });

    const history = messages.slice(-historyTurns).map((entry) => ({ role: entry.role, content: entry.text }));

    // Which tool is actually running right now, if any — real activity from
    // the orchestrator (see /v1/assist/activity), not a guess dressed up as
    // one. Absent is the ordinary case for most turns, which stay "thinking"
    // the whole way through.
    const activityPoll = window.setInterval(() => {
      fetch(`${apiBaseUrl}/v1/assist/activity?sessionId=${encodeURIComponent(session.current)}`)
        .then((response) => (response.ok ? response.json() : null))
        .then((payload) => {
          if (!stillCurrent()) return;
          const tool = payload?.data?.tool;
          setStatus((existing) => {
            // Only ever steers a turn already in progress — a poll response
            // that lands after the request itself resolved must not drag a
            // finished turn's status back toward "thinking".
            if (existing.state !== "thinking" && existing.state !== "executing") return existing;
            return typeof tool === "string" ? { state: "executing", tool } : { state: "thinking" };
          });
        })
        .catch(() => { /* a missed poll just leaves the last known status showing */ });
    }, activityPollMs);

    try {
      const response = await fetch(`${apiBaseUrl}/v1/assist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, sessionId: session.current, history, mode: "general" })
      });

      if (!response.ok) throw new Error(`The assistant service answered ${response.status}.`);

      const payload = await response.json();
      const data = payload?.data ?? {};

      setMessages((prior) => [...prior, {
        id: crypto.randomUUID(),
        role: "assistant",
        text: data.assistantMessage ?? "",
        at: Date.now(),
        strategy: data.strategy,
        model: data.model,
        toolsUsed: data.toolsUsed
      }]);
      if (stillCurrent()) {
        setStatus({ state: "success" });
        // A brief confirmation, not a resting state — see core.css's
        // core-confirm animation, built to finish well within this window.
        // Deliberately not guarded by busy/generation cleanup in `finally`
        // below: this timeout has to outlive that block to ever fire.
        window.setTimeout(() => { if (stillCurrent()) setStatus({ state: "idle" }); }, successHoldMs);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : "The assistant could not be reached.";
      if (stillCurrent()) setStatus({ state: "error", detail });
      setMessages((prior) => [...prior, {
        id: crypto.randomUUID(),
        role: "assistant",
        text: `${detail}\n\nThe local API runs on this machine; if this persists, it may not be running.`,
        at: Date.now(),
        strategy: "error"
      }]);
    } finally {
      // Stops polling and frees the next send() to start — deliberately
      // does not touch `generation`, which stays valid through the success
      // hold above until a genuinely newer call moves it forward.
      window.clearInterval(activityPoll);
      busy.current = false;
    }
  }, [messages]);

  const clear = useCallback(async () => {
    setMessages([]);
    setStatus({ state: "idle" });
    try {
      await fetch(`${apiBaseUrl}/v1/assist/conversation`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: session.current })
      });
    } catch {
      // The visible transcript is already gone; a failed server-side clear is
      // not worth interrupting the user for.
    }
  }, []);

  return { messages, status, restored, sessionId: session.current, send, clear };
}
