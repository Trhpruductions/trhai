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

export type AssistantStatus = { state: "idle" } | { state: "thinking" } | { state: "error"; detail: string };

const historyTurns = 8;

export function useAssistant() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<AssistantStatus>({ state: "idle" });
  const [restored, setRestored] = useState(false);
  const session = useRef(resolveSessionId());
  const busy = useRef(false);

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

    const userTurn: ChatMessage = { id: crypto.randomUUID(), role: "user", text, at: Date.now() };
    setMessages((current) => [...current, userTurn]);
    setStatus({ state: "thinking" });

    const history = messages.slice(-historyTurns).map((entry) => ({ role: entry.role, content: entry.text }));

    try {
      const response = await fetch(`${apiBaseUrl}/v1/assist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, sessionId: session.current, history, mode: "general" })
      });

      if (!response.ok) throw new Error(`The assistant service answered ${response.status}.`);

      const payload = await response.json();
      const data = payload?.data ?? {};

      setMessages((current) => [...current, {
        id: crypto.randomUUID(),
        role: "assistant",
        text: data.assistantMessage ?? "",
        at: Date.now(),
        strategy: data.strategy,
        model: data.model,
        toolsUsed: data.toolsUsed
      }]);
      setStatus({ state: "idle" });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "The assistant could not be reached.";
      setStatus({ state: "error", detail });
      setMessages((current) => [...current, {
        id: crypto.randomUUID(),
        role: "assistant",
        text: `${detail}\n\nThe local API runs on this machine; if this persists, it may not be running.`,
        at: Date.now(),
        strategy: "error"
      }]);
    } finally {
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
