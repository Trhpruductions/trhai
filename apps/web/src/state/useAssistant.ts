import { useCallback, useEffect, useRef, useState } from "react";
import { webEnv } from "../env";
import { createSubmissionLatch } from "../submissionLatch";

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

export function useAssistant() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<AssistantStatus>({ state: "idle" });
  const [restored, setRestored] = useState(false);
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
        const turns: Array<{ role: ChatRole; content: string }> = payload?.data?.turns ?? [];
        if (cancelled || turns.length === 0) return;

        setMessages(turns.map((turn, index) => ({
          id: `restored-${index}`,
          role: turn.role,
          text: turn.content,
          at: Date.now()
        })));
      } catch {
        // A missing transcript is not an error worth showing; the user can talk.
      } finally {
        if (!cancelled) setRestored(true);
      }
    })();

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

      setMessages((current) => [...current, {
        id: crypto.randomUUID(),
        role: "assistant",
        text: data.assistantMessage ?? "",
        at: Date.now(),
        strategy: data.strategy,
        model: data.model,
        buildRequest: data.buildRequest
      }]);
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
    }
  }, [messages]);

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
    sessionId: sessionId.current,
    send,
    clear
  };
}
