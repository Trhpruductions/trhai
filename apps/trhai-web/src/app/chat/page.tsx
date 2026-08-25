"use client";

import { useEffect, useRef, useState } from "react";
import { useAssistant, type AssistantStatus, type ChatMessage } from "../../hooks/useAssistant";
import { useSpeech } from "../../hooks/useSpeech";
import { useMicrophone } from "../../hooks/useMicrophone";
import { Core, type CoreState } from "../../components/Core";
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

/**
 * What the core shows, and the words under it — one place mapping the real
 * request status (plus the real device states, layered on top since neither
 * belongs to the request) to what a person sees. Every branch here traces to
 * something that actually happened; there is no state on this list that
 * plays for its own sake.
 *
 * Listening outranks the request states for the same reason it does on the
 * dashboard: it describes the microphone rather than the conversation, and
 * an open microphone is the most important true thing on a screen.
 */
function presence(
  status: AssistantStatus,
  { listening, transcribing, speaking }: { listening: boolean; transcribing: boolean; speaking: boolean }
): { core: CoreState; label: string } {
  if (listening) return { core: "listening", label: "Listening…" };
  if (transcribing) return { core: "thinking", label: "Transcribing on this machine…" };
  if (status.state === "executing") return { core: "executing", label: `Working: ${status.tool.replace(/_/g, " ")}…` };
  if (status.state === "thinking") return { core: "thinking", label: "Thinking…" };
  if (status.state === "success") return { core: "success", label: "Complete." };
  if (status.state === "error") return { core: "error", label: status.detail };
  if (speaking) return { core: "speaking", label: "Speaking…" };
  return { core: "idle", label: "Standing by." };
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
  const mic = useMicrophone();
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

    // Marked spoken either way, deliberately. With the microphone open,
    // reading the reply aloud would record it and transcribe TRHAI back to
    // itself — and merely deferring would be worse, since the reply would
    // then blurt out later, once the user had moved on.
    lastSpokenId.current = newest.id;
    if (mic.listening) return;

    speech.speak(newest.text);
  }, [messages, speech, mic.listening]);

  const busy = status.state === "thinking" || status.state === "executing";
  const { core, label } = presence(status, {
    listening: mic.listening,
    transcribing: mic.transcribing,
    speaking: speech.speaking
  });

  function submit() {
    if (!draft.trim() || busy) return;
    void send(draft);
    setDraft("");
  }

  /**
   * The microphone. Starting listens; stopping transcribes and appends what
   * was said to the draft, for the user to read before sending.
   *
   * Deliberately not auto-sent, same as the dashboard: a transcript is a
   * guess at speech, and sending on a guess the user has not seen is how a
   * voice feature says something they did not.
   */
  async function handleMic() {
    if (!mic.listening) {
      // Stop any reply already being read aloud. Without this the microphone
      // opens into TRHAI's own voice and transcribes it back as though the
      // user had said it.
      speech.stop();
      await mic.start();
      return;
    }

    const said = await mic.stop();
    if (said) setDraft((existing) => (existing.trim() ? `${existing.trim()} ${said}` : said));
  }

  return (
    <section className="chat" aria-label="Conversation">
      <header className="chat-head">
        <div className="row">
          {/* One amplitude input, two real sources: the microphone while
              listening, the neural voice while speaking. Undefined in every
              other state, and for the browser fallback voice, which exposes
              no audio to read — Core treats that as "breathe on your own"
              rather than as silence. */}
          <Core
            state={core}
            size={30}
            amplitude={mic.listening ? mic.amplitude : speech.speaking ? speech.amplitude : undefined}
          />
          <div className="col">
            <h2 className="chat-title">Chat</h2>
            <span className="faint chat-presence">{label}</span>
          </div>
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
            <Core state={core} size={26} />
            <span className="hud-label">{label}</span>
          </div>
        ) : null}

        {speech.error ? <p className="faint chat-voice-note">{speech.error}</p> : null}
        {mic.error ? <p className="faint chat-voice-note">{mic.error}</p> : null}

        <div ref={endRef} />
      </div>

      <div className="chat-composer">
        <textarea
          className="field"
          rows={2}
          value={draft}
          placeholder={mic.listening ? "Listening — press the dot again to stop…" : "Ask anything…"}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); }
          }}
        />
        {mic.supported ? (
          <button
            type="button"
            className={`btn btn-ghost chat-mic${mic.listening ? " chat-mic-live" : ""}`}
            aria-pressed={mic.listening}
            disabled={mic.transcribing}
            aria-label={mic.listening ? "Stop listening and transcribe" : "Speak your message"}
            title={mic.listening
              ? "Stop and transcribe"
              : mic.transcriptionAvailable === false
                ? `${mic.transcriptionReason} The microphone still works as a level meter.`
                : "Speak your message. It is transcribed on this machine and never uploaded."}
            onClick={() => void handleMic()}
          >
            {mic.transcribing ? "…" : "●"}
          </button>
        ) : null}
        <button type="button" className="btn btn-primary" disabled={!draft.trim() || busy} onClick={submit}>
          Send
        </button>
      </div>
    </section>
  );
}
