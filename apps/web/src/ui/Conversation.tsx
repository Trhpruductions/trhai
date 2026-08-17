import { useEffect, useRef, useState } from "react";
import { useAssistant, type ChatMessage } from "../state/useAssistant";
import { personalityById, resolvePersonality, type PersonalityId } from "../personalities";
import "./conversation.css";

// The home screen: a conversation.
//
// It opens here because this is what the app is for. The previous shell opened
// on a dashboard whose most prominent control was labelled "Ask anything..."
// and wired to the project generator, so the ordinary act of asking a question
// produced a scaffold path instead of an answer.

type Props = {
  personality: PersonalityId;
  onBuildRequest: (request: string) => void;
};

/**
 * How a reply was produced, in the user's words rather than the code's.
 *
 * Shown on every assistant turn. The whole app is built on not implying
 * knowledge it does not have, and this is where that becomes visible: a
 * sentence quoted from a saved note reads very differently from one a model
 * wrote, and the user is entitled to know which they are looking at.
 */
function provenanceOf(message: ChatMessage): { label: string; tone: string } | null {
  switch (message.strategy) {
    case "generated":
      return { label: message.model?.replace(/^ollama\//, "") ?? "local model", tone: "chip-live" };
    case "answer":
      return { label: "from your notes", tone: "chip-ok" };
    case "no-answer":
    case "not-saved":
      return { label: "nothing matched", tone: "chip-warn" };
    case "plan":
      return { label: "plan", tone: "chip" };
    case "error":
      return { label: "service error", tone: "chip-danger" };
    default:
      return null;
  }
}

function Turn({ message, onBuildRequest }: { message: ChatMessage; onBuildRequest: (r: string) => void }) {
  const provenance = message.role === "assistant" ? provenanceOf(message) : null;

  return (
    <article className={`turn turn-${message.role}`}>
      <header className="turn-head">
        <span className="label">{message.role === "user" ? "You" : "Ascend"}</span>
        {provenance ? <span className={`chip ${provenance.tone}`}>{provenance.label}</span> : null}
      </header>

      {/* Preserves the newlines the assistant writes; its answers are often
          lists, and collapsing them made every reply a wall. */}
      <div className="turn-body">{message.text}</div>

      {message.buildRequest ? (
        <button type="button" className="btn btn-primary btn-sm turn-action"
          onClick={() => onBuildRequest(message.buildRequest!)}>
          Build this
        </button>
      ) : null}
    </article>
  );
}

export function Conversation({ personality, onBuildRequest }: Props) {
  const { messages, status, restored, send, clear } = useAssistant();
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const profile = personalityById(resolvePersonality(personality));

  // Follow the conversation as it grows, including while a reply streams in.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, status.state]);

  const busy = status.state === "thinking";

  function submit() {
    if (!draft.trim() || busy) return;
    void send(draft);
    setDraft("");
  }

  return (
    <section className="conversation" aria-label="Conversation">
      <header className="conversation-head">
        <div className="row">
          <h2 className="label">Conversation</h2>
          <span className="chip">{profile.label}</span>
        </div>
        {messages.length > 0 ? (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void clear()}>
            Clear
          </button>
        ) : null}
      </header>

      <div className="conversation-scroll scroll-y">
        {messages.length === 0 ? (
          <div className="empty conversation-empty">
            <strong>Ask it something</strong>
            <p>
              It answers from a local model, from what you have told it to remember, and from
              documents you add under Knowledge — and says plainly when it has nothing.
            </p>
            <div className="row wrap conversation-suggestions">
              {profile.suggestions.map((suggestion) => (
                <button key={suggestion} type="button" className="btn btn-sm"
                  onClick={() => { setDraft(suggestion); }}>
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((message) => (
            <Turn key={message.id} message={message} onBuildRequest={onBuildRequest} />
          ))
        )}

        {busy ? (
          <div className="turn turn-assistant thinking" aria-live="polite">
            <span className="label">Ascend</span>
            <span className="thinking-dots"><i /><i /><i /></span>
          </div>
        ) : null}

        <div ref={endRef} />
      </div>

      <footer className="composer">
        <textarea
          className="field composer-field"
          value={draft}
          rows={1}
          placeholder={restored ? "Ask anything, or describe something to build…" : "Loading conversation…"}
          aria-label="Message"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends, Shift+Enter breaks the line. A multi-line message is
            // rare enough that requiring a modifier to send would cost more.
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <button type="button" className="btn btn-primary composer-send"
          onClick={submit} disabled={busy || !draft.trim()}>
          {busy ? "…" : "Send"}
        </button>
      </footer>
    </section>
  );
}
