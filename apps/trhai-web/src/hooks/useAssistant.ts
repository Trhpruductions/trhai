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
  /**
   * True while this reply is still being written.
   *
   * The text is real — it is what the model has produced so far — but it is
   * not finished, and some things have to wait for that. The voice above all:
   * reading a sentence aloud while it is still being written would speak a
   * fragment and then have nothing to follow it.
   */
  streaming?: boolean;
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
/** How often a streaming reply repaints. Fast enough to read as live, slow
 * enough that a long answer costs tens of renders rather than hundreds. */
const streamPaintMs = 60;
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

    // Made before the request so streamed text has a message to land in, and
    // the finished reply replaces that same message rather than appending a
    // second copy of itself.
    const replyId = crypto.randomUUID();
    let streamed = "";

    try {
      const response = await fetch(`${apiBaseUrl}/v1/assist/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, sessionId: session.current, history, mode: "general" })
      });

      if (!response.ok) throw new Error(`The assistant service answered ${response.status}.`);
      if (!response.body) throw new Error("The assistant service sent no reply.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let data: Record<string, unknown> | null = null;
      let failure: string | null = null;

      // Paints whatever has arrived, on a timer. An interval callback is a
      // macrotask, so each flush is its own render — which is the whole point.
      // It also means a fast reply costs ~20 renders instead of ~550.
      let painted = "";
      const flush = window.setInterval(() => {
        if (streamed === painted) return;
        painted = streamed;
        setMessages((prior) => (prior.some((message) => message.id === replyId)
          ? prior.map((message) =>
            (message.id === replyId ? { ...message, text: painted } : message))
          : [...prior, {
            id: replyId, role: "assistant" as const, text: painted,
            at: Date.now(), streaming: true
          }]));
      }, streamPaintMs);

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        // Events are separated by a blank line; a partial one waits in the
        // buffer for the rest of it.
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          const event = /^event: (.+)$/m.exec(frame)?.[1];
          const body = /^data: (.+)$/m.exec(frame)?.[1];
          if (!event || !body) continue;

          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(body) as Record<string, unknown>;
          } catch {
            continue;
          }

          // Accumulated here and painted by the flush timer below, never
          // straight from this loop.
          //
          // reader.read() resolves in a microtask whenever the next chunk is
          // already buffered, so a fast reply runs hundreds of updates with no
          // macrotask boundary between them — and React batches the lot into a
          // single render at the end. The first token lands in a real network
          // task and paints; every one after it was being coalesced away, so
          // the reply appeared to arrive whole despite arriving in pieces.
          if (event === "token" && typeof parsed.text === "string") streamed += parsed.text;
          if (event === "done") data = parsed;
          if (event === "failed") failure = String(parsed.message ?? "The assistant could not answer.");
        }
      }

      window.clearInterval(flush);

      if (failure) throw new Error(failure);
      if (!data) throw new Error("The assistant stopped before finishing its reply.");

      // The finished result replaces whatever was streamed. That is what makes
      // it safe for tokens to be withheld mid-stream when the model turns out
      // to have been writing a tool call: what is on screen is provisional
      // until this lands.
      const finished: ChatMessage = {
        id: replyId,
        role: "assistant",
        text: typeof data.assistantMessage === "string" ? data.assistantMessage : streamed,
        at: Date.now(),
        strategy: data.strategy as string | undefined,
        model: data.model as string | undefined,
        toolsUsed: data.toolsUsed as ChatMessage["toolsUsed"]
      };

      setMessages((prior) => (prior.some((message) => message.id === replyId)
        ? prior.map((message) => (message.id === replyId ? finished : message))
        : [...prior, finished]));
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
