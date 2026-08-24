"use client";

import { useEffect, useRef, useState } from "react";
import { useAssistant, type ChatMessage } from "../../hooks/useAssistant";
import { useSpeech } from "../../hooks/useSpeech";
import { Core } from "../../components/Core";
import "./chat.css";

// Chat: TRHAI's conversation surface, talking to the real local orchestrator.
//
// Provenance is shown on every reply rather than assumed — a generated
// sentence, a quote from saved notes, and a tool result are different kinds
// of claim, and the whole point of this rewrite's honesty rule (master spec
// §23, §20) is that the interface never blurs them into one undifferentiated
// "TRHAI said this".

function toolLabel(tool: { name: string; ok: boolean }): string {
  return `${tool.name.replace(/_/g, " ")}${tool.ok ? "" : " — nothing changed"}`;
}

function Turn({ message }: { message: ChatMessage }) {
  return (
    <article className={`turn turn-${message.role}`}>
      <header className="turn-head">
        <span className="hud-label">{message.role === "user" ? "You" : "TRHAI"}</span>
        {message.role === "assistant" && message.model ? (
          <span className="chip chip-live">{message.model.replace(/^ollama\//, "").replace(/:latest$/, "")}</span>
        ) : null}
        {message.role === "assistant" && message.strategy === "error" ? (
          <span className="chip chip-danger">service error</span>
        ) : null}
      </header>
      <p className="turn-text">{message.text}</p>
      {message.toolsUsed && message.toolsUsed.length > 0 ? (
        <div className="turn-tools">
          {message.toolsUsed.map((tool, index) => (
            <span key={`${tool.name}-${index}`} className="chip">{toolLabel(tool)}</span>
          ))}
        </div>
      ) : null}
    </article>
  );
}

export default function ChatPage() {
  const { messages, status, send, clear } = useAssistant();
  const speech = useSpeech();
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const lastSpokenId = useRef<string | null>(null);
  const seeded = useRef(false);

  // A request handed over from the dashboard's quick-ask field. Consumed
  // once, via sessionStorage rather than a query string, so it never ends up
  // in a shared or logged URL.
  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    const seed = window.sessionStorage.getItem("trhai.dashboard.seed");
    if (seed) {
      window.sessionStorage.removeItem("trhai.dashboard.seed");
      void send(seed);
    }
  }, [send]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, status.state]);

  useEffect(() => {
    if (!speech.enabled) return;
    const newest = messages[messages.length - 1];
    if (!newest || newest.role !== "assistant") return;
    if (newest.id.startsWith("restored-")) return;
    if (lastSpokenId.current === newest.id) return;
    lastSpokenId.current = newest.id;
    speech.speak(newest.text);
  }, [messages, speech]);

  const busy = status.state === "thinking";

  function submit() {
    if (!draft.trim() || busy) return;
    void send(draft);
    setDraft("");
  }

  return (
    <section className="chat" aria-label="Conversation">
      <header className="chat-head">
        <div className="row">
          <Core state={busy ? "thinking" : speech.speaking ? "speaking" : "idle"} size={30} />
          <h2 className="chat-title">Chat</h2>
        </div>
        <div className="row">
          {speech.engine !== "none" ? (
            <button type="button" className={`btn btn-ghost btn-sm${speech.enabled ? " btn-on" : ""}`}
              onClick={() => speech.setEnabled(!speech.enabled)}
              title={speech.engine === "neural" ? "Read replies aloud using the local neural voice." : "Read replies aloud using this browser's voices."}>
              {speech.enabled ? "Voice on" : "Voice off"}
            </button>
          ) : (
            <span className="faint" title={speech.neural && !speech.neural.available ? speech.neural.reason : undefined}>
              No voice
            </span>
          )}
          {speech.speaking || speech.preparing ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={speech.stop}>
              {speech.preparing ? "Cancel" : "Stop"}
            </button>
          ) : null}
          {messages.length > 0 ? (
            <button type="button" className="btn btn-ghost btn-sm"
              onClick={() => { if (window.confirm("Clear this conversation? This cannot be undone.")) void clear(); }}>
              Clear
            </button>
          ) : null}
        </div>
      </header>

      <div className="chat-scroll">
        {messages.length === 0 ? (
          <p className="muted chat-empty">Ask anything. Replies come from the local model running on this machine.</p>
        ) : (
          messages.map((message) => <Turn key={message.id} message={message} />)
        )}

        {busy ? (
          <div className="turn turn-assistant chat-thinking" aria-live="polite">
            <Core state="thinking" size={26} />
            <span className="hud-label">Thinking…</span>
          </div>
        ) : null}

        {speech.error ? <p className="faint chat-voice-note">{speech.error}</p> : null}

        <div ref={endRef} />
      </div>

      <div className="chat-composer">
        <textarea
          className="field"
          rows={2}
          value={draft}
          placeholder="Ask anything…"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); }
          }}
        />
        <button type="button" className="btn btn-primary" disabled={!draft.trim() || busy} onClick={submit}>
          Send
        </button>
      </div>
    </section>
  );
}
