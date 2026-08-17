import { useEffect, useRef, useState } from "react";
import { useAssistant, type ChatMessage } from "../state/useAssistant";
import { personalityById, resolvePersonality, type PersonalityId } from "../personalities";
import { readEvents } from "../localCalendar";
import { webEnv } from "../env";
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
  const { messages, status, restored, send, clear, sessionId } = useAssistant();
  const [draft, setDraft] = useState("");
  const [stats, setStats] = useState<Array<{ label: string; value: string }>>([]);
  const endRef = useRef<HTMLDivElement>(null);
  const profile = personalityById(resolvePersonality(personality));

  // Real counts for the opening screen, read once when there is nothing to show.
  // They are what this app is holding, so an empty conversation still says
  // something true about the state of the system.
  useEffect(() => {
    if (messages.length > 0) return;
    let cancelled = false;

    (async () => {
      const ask = async (path: string, key: string) => {
        try {
          const response = await fetch(`${webEnv.apiBaseUrl}${path}?sessionId=${encodeURIComponent(sessionId)}`);
          if (!response.ok) return 0;
          const payload = await response.json();
          return (payload?.data?.[key] ?? []).length as number;
        } catch {
          return 0;
        }
      };

      const [memories, documents] = await Promise.all([
        ask("/v1/assist/memory", "memories"),
        ask("/v1/knowledge", "documents")
      ]);

      const events = readEvents(window.localStorage, "ascend.calendar.events.v1").length;
      if (cancelled) return;

      // Singular when there is one of something: "1 documents" is the kind of
      // detail that makes an interface feel unattended.
      const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

      setStats([
        { label: plural(memories, "remembered", "remembered"), value: String(memories) },
        { label: plural(documents, "document", "documents"), value: String(documents) },
        { label: plural(events, "event", "events"), value: String(events) }
      ]);
    })();

    return () => { cancelled = true; };
  }, [messages.length, sessionId]);

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
          <div className="conversation-empty">
            <div className="ready">
              <span className="ready-mark" aria-hidden="true">◉</span>
              <div>
                <h3>Ready</h3>
                <p className="muted">
                  Answers come from a local model, from what you have asked it to remember, and
                  from your documents — and it says plainly when it has none of those.
                </p>
              </div>
            </div>

            {/* What the app is actually holding right now. An opening screen
                that lists live counts reads as a running system; one that only
                offers suggestions reads as a form waiting to be filled in. */}
            <div className="ready-stats">
              {stats.map((stat) => (
                <div key={stat.label} className="ready-stat">
                  <span className="ready-stat-value">{stat.value}</span>
                  <span className="label">{stat.label}</span>
                </div>
              ))}
            </div>

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
